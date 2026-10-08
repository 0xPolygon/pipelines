#!/usr/bin/env bash
# test-slack-pr-merged.sh
#
# Tests .github/actions/slack-pr-merged/slack-pr-merged.sh with the Slack and
# GitHub APIs stubbed out: `slack`, `gh` and `curl` are replaced by shell
# functions that answer from fixtures and record every call.
#
# Usage: bash scripts/test-slack-pr-merged.sh
# Requires: bash, jq

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { echo "  PASS: $1"; ((PASS++)) || true; }
fail() { echo "  FAIL: $1"; ((FAIL++)) || true; }

# check NAME EXPECTED ACTUAL
check() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (expected: $2, got: $3)"
  fi
}

# shellcheck source=SCRIPTDIR/../.github/actions/slack-pr-merged/slack-pr-merged.sh
source "$REPO_ROOT/.github/actions/slack-pr-merged/slack-pr-merged.sh"
set +e

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CALLS="$WORK/calls"

sleep() { :; }

# Stub fixtures, set per test:
#   HISTORY[channel]  conversations.history response for that channel
#   REPLIES           conversations.replies response
#   SLACK_FAIL        Slack method that answers ok:false
#   GH_STATE[ref]     merged | closed | open | 404 | 403-rate | 500
declare -A HISTORY GH_STATE
REPLIES='{"ok":true,"messages":[]}'
SLACK_FAIL=""

# shellcheck disable=SC2329  # called by the sourced script
slack() {
  local method="$1" ch
  shift
  ch="$(printf '%s\n' "$@" | sed -n 's/^channel=//p' | head -1)"
  echo "$method $ch" >>"$CALLS"
  if [ "$method" = "$SLACK_FAIL" ]; then
    echo '{"ok":false,"error":"missing_scope"}'
    return
  fi
  case "$method" in
    conversations.history)
      if [ -n "${HISTORY[$ch]:-}" ]; then
        echo "${HISTORY[$ch]}"
      else
        echo '{"ok":false,"error":"channel_not_found"}'
      fi
      ;;
    conversations.replies) echo "$REPLIES" ;;
    *) echo '{"ok":true}' ;;
  esac
}

# shellcheck disable=SC2329
gh() {
  local path="$2" ref
  ref="${path#repos/}"
  ref="${ref%/pulls/*}#${ref##*/}"
  echo "gh $ref" >>"$CALLS"
  case "${GH_STATE[$ref]:-404}" in
    merged | closed | open) echo "${GH_STATE[$ref]}" ;;
    404) echo "gh: Not Found (HTTP 404)" >&2 && return 1 ;;
    403-rate) echo "gh: API rate limit exceeded (HTTP 403)" >&2 && return 1 ;;
    500) echo "gh: Server Error (HTTP 500)" >&2 && return 1 ;;
  esac
}

reset() {
  : >"$CALLS"
  HISTORY=()
  GH_STATE=()
  REPLIES='{"ok":true,"messages":[]}'
  SLACK_FAIL=""
  SLACK_BOT_TOKEN=token REPO=Org/Repo PR_NUMBER=7 CHANNEL=C1
}

calls() { grep -c "^$1" "$CALLS" || true; }

history() {
  jq -cn --args '{ok: true, messages: [$ARGS.positional[] | fromjson]}' "$@"
}

msg() {
  jq -cn --arg ts "$1" --arg text "$2" --argjson reactions "${3:-[]}" \
    '{ts: $ts, text: $text, reactions: $reactions}'
}

echo "Running slack-pr-merged.sh tests..."

echo "find_candidates"
page="$(history \
  "$(msg 1 'review <https://github.com/org/repo/pull/7|#7>')" \
  "$(msg 2 'big one https://github.com/org/repo/pull/71')" \
  "$(msg 3 'done <https://github.com/org/repo/pull/7>' '[{"name":"git-merged"}]')" \
  "$(msg 4 'two <https://GitHub.com/Org/Repo/pull/7/changes> and https://github.com/other/x/pull/5 and https://github.com/org/repo/pull/7')")"
out="$(find_candidates 'org/repo#7' <<<"$page")"
check "matches the PR in <url|label> and /changes links" "1 4" "$(jq -rs 'map(.ts) | join(" ")' <<<"$out")"
check "refs are lowercased and deduplicated in order" '["org/repo#7","other/x#5"]' "$(jq -c 'select(.ts == "4") | .refs' <<<"$out")"

echo "build_status"
out="$(build_status org/repo <<<'[{"ref":"org/repo#7","state":"merged"},{"ref":"org/repo#8","state":"closed"},{"ref":"other/x#5","state":"open"},{"ref":"other/y#6","state":"unknown"}]')"
check "renders one emoji or word per state" \
  'Merged: 1/4 — <https://github.com/org/repo/pull/7|#7> :git-merged:, <https://github.com/org/repo/pull/8|#8> :github-closed:, <https://github.com/other/x/pull/5|x#5> :hourglass_flowing_sand:, <https://github.com/other/y/pull/6|y#6> ?' \
  "$(jq -r .text <<<"$out")"
check "all is false until every PR merged" "false" "$(jq -r .all <<<"$out")"
check "all is true when every PR merged" "true" \
  "$(build_status org/repo <<<'[{"ref":"org/repo#7","state":"merged"},{"ref":"x/y#1","state":"merged"}]' | jq -r .all)"

echo "pr_state"
reset
GH_STATE=([x/y#1]=closed [x/y#2]=403-rate [x/y#3]=500)
check "the merged PR itself skips the API" "merged" "$(pr_state 'org/repo#7' 'org/repo#7')"
check "closed unmerged PR is closed" "closed" "$(pr_state 'x/y#1' 'org/repo#7')"
check "unreadable PR is unknown" "unknown" "$(pr_state 'x/y#9' 'org/repo#7')"
pr_state 'x/y#2' 'org/repo#7' >/dev/null 2>&1
check "rate limit fails" "1" "$?"
pr_state 'x/y#3' 'org/repo#7' >/dev/null 2>&1
check "server error fails" "1" "$?"

echo "handle_message"
reset
handle_message 1 '["org/repo#7"]' 'org/repo#7' >/dev/null
check "single PR reacts" "1" "$(calls reactions.add)"

reset
SLACK_FAIL=reactions.add
handle_message 1 '["org/repo#7"]' 'org/repo#7' >/dev/null 2>&1
check "single PR reaction failure propagates" "1" "$?"

reset
GH_STATE=([x/y#1]=open)
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null
check "multi PR with one open replies" "1" "$(calls chat.postMessage)"
check "multi PR with one open does not react" "0" "$(calls reactions.add)"

reset
GH_STATE=([x/y#1]=merged)
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null
check "multi PR all merged replies and reacts" "1 1" "$(calls chat.postMessage) $(calls reactions.add)"

reset
GH_STATE=([x/y#1]=open)
REPLIES='{"ok":true,"messages":[{"ts":"1"},{"ts":"2","text":"Merged: 1/2 — <https://github.com/org/repo/pull/7|#7> :git-merged:, x"}]}'
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null
check "re-run does not reply twice" "0" "$(calls chat.postMessage)"

reset
SLACK_FAIL=conversations.replies
GH_STATE=([x/y#1]=open)
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null 2>&1
check "thread read failure propagates without replying" "1 0" "$? $(calls chat.postMessage)"

reset
SLACK_FAIL=chat.postMessage
GH_STATE=([x/y#1]=open)
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null 2>&1
check "reply failure propagates" "1" "$?"

reset
GH_STATE=([x/y#1]=500)
handle_message 1 '["org/repo#7","x/y#1"]' 'org/repo#7' >/dev/null 2>&1
check "GitHub lookup failure propagates without replying" "1 0" "$? $(calls chat.postMessage)"

echo "main"
reset
# shellcheck disable=SC2016  # expanded only if the script evaluates it
SLACK_CHANNEL_IDS=C1 LOOKBACK_DAYS='BASH_VERSINFO[$(touch "$WORK/pwned")]'
(main >/dev/null 2>&1)
check "non-numeric LOOKBACK_DAYS fails before any call or evaluation" "1 0 no" \
  "$? $(calls conversations.history) $([ -e "$WORK/pwned" ] && echo yes || echo no)"
unset LOOKBACK_DAYS

reset
SLACK_CHANNEL_IDS=" , "
out="$(main 2>&1)"
check "empty channel list is a no-op" "0 0" "$? $(calls conversations.history)"
check "empty channel list logs a notice" "::notice::SLACK_CHANNEL_IDS is not set, skipping Slack update" "$out"

reset
SLACK_BOT_TOKEN="" SLACK_CHANNEL_IDS=C1
(main >/dev/null)
check "missing token is a no-op" "0 0" "$? $(calls conversations.history)"

reset
SLACK_CHANNEL_IDS="C1, BAD
C2"
HISTORY=([C1]="$(history "$(msg 1 'https://github.com/org/repo/pull/7')")" [C2]="$(history "$(msg 2 'https://github.com/org/repo/pull/7')")")
(main >/dev/null 2>&1)
check "a failing channel fails the run" "1" "$?"
check "comma and newline separated channels are all scanned" "C1 BAD C2" "$(sed -n 's/^conversations.history //p' "$CALLS" | paste -sd' ' -)"
check "channels after a failing one are still updated" "reactions.add C1 reactions.add C2" "$(grep '^reactions.add' "$CALLS" | paste -sd' ' -)"

echo "slack"
unset -f slack
source "$REPO_ROOT/.github/actions/slack-pr-merged/slack-pr-merged.sh"
set +e
# HTTP codes to answer with, one per line. A file, not an array, because slack()
# calls curl in a command substitution, where array changes would not persist.
CURL_CODES="$WORK/curl-codes"
# shellcheck disable=SC2329
curl() {
  local body hdr code
  while [ $# -gt 0 ]; do
    case "$1" in
      -o) body="$2" && shift ;;
      -D) hdr="$2" && shift ;;
    esac
    shift
  done
  echo curl >>"$CALLS"
  code="$(head -1 "$CURL_CODES")"
  tail -n +2 "$CURL_CODES" >"$CURL_CODES.next" && mv "$CURL_CODES.next" "$CURL_CODES"
  printf 'HTTP/2 %s\r\nretry-after: 0\r\n' "$code" >"$hdr"
  echo '{"ok":true}' >"$body"
  printf '%s' "$code"
}

reset
printf '429\n200\n' >"$CURL_CODES"
out="$(slack auth.test 2>/dev/null)"
check "retries once on 429" "0 2 {\"ok\":true}" "$? $(calls curl) $out"

reset
printf '429\n429\n' >"$CURL_CODES"
slack auth.test >/dev/null 2>&1
check "fails after a second 429" "1 2" "$? $(calls curl)"

reset
printf '500\n' >"$CURL_CODES"
slack auth.test >/dev/null 2>&1
check "fails on non-2xx" "1 1" "$? $(calls curl)"

echo
echo "Results: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
