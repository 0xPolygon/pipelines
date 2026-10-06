#!/bin/bash
# Reacts in Slack when a PR merges: finds recent messages in a channel that link the
# merged PR and updates them. No AI involved, only the Slack and GitHub APIs.
#
#   - Message links exactly one PR (this one): adds the :git-merged: reaction.
#   - Message links several PRs: posts a thread reply with the merge status and adds
#     the reaction only once every linked PR is merged. PRs this token cannot read
#     are shown as "?" and never count as merged.
#   - Messages that already carry the reaction are skipped.
#
# Usage: slack-pr-merged.sh
# Env:   SLACK_BOT_TOKEN   bot token (scopes: channels:history, reactions:write, chat:write);
#                          unset or empty makes the script a no-op
#        SLACK_CHANNEL_ID  channel to scan; unset or empty makes the script a no-op
#        GH_TOKEN          token used by `gh api` to read PR state
#        REPO              owner/repo of the merged PR
#        PR_NUMBER         number of the merged PR
#        LOOKBACK_DAYS     optional, defaults to 14

set -euo pipefail

REACTION="git-merged"

# Reads a conversations.history page on stdin. Prints one JSON object per message that
# links the PR $this (lowercase "owner/repo#N") and does not carry the reaction yet:
# {"ts": "...", "refs": ["owner/repo#N", ...]}, refs deduplicated in order of appearance.
# Slack writes links as <url|label> or <url>; the number must not be followed by another
# digit, so pull/34555 never matches PR 3455, while /changes, %7C, |, > and # all do.
# shellcheck disable=SC2016  # jq program, not a shell expansion
JQ_CANDIDATES='
  def refs:
    [ scan("(?<![a-z0-9-])github\\.com/([a-z0-9_.-]+)/([a-z0-9_.-]+)/pull/([0-9]+)(?![0-9])"; "i")
      | "\(.[0] | ascii_downcase)/\(.[1] | ascii_downcase)#\(.[2] | tonumber)" ]
    | reduce .[] as $r ([]; if index($r) then . else . + [$r] end);
  .messages[]?
  | select(.ts != null)
  | select(any(.reactions[]?; .name == $emoji) | not)
  | {ts, refs: ((.text // "") | refs)}
  | select(.refs | index($this))
'

find_candidates() {
  jq -c --arg this "$1" --arg emoji "$REACTION" "$JQ_CANDIDATES"
}

# Reads a JSON array of {"ref": "owner/repo#N", "state": "merged"|"open"|"unknown"} on
# stdin. Prints {"merged": n, "total": n, "all": bool, "text": "Merged: 1/2 - ..."}.
# $thisrepo (lowercase owner/repo) decides which refs get a short "#N" label.
# shellcheck disable=SC2016
JQ_STATUS='
  def num: split("#")[1];
  def short: if split("#")[0] == $thisrepo then "#\(num)"
             else "\(split("#")[0] | split("/")[1])#\(num)" end;
  def url_link: "<https://github.com/\(split("#")[0])/pull/\(num)|\(short)>";
  def tick: if .state == "merged" then "\u2713" elif .state == "open" then "pending" else "?" end;
  ([.[] | select(.state == "merged")] | length) as $m
  | length as $t
  | {merged: $m, total: $t, all: ($m == $t),
     text: ("Merged: \($m)/\($t) \u2014 " + ([.[] | "\(.ref | url_link) \(tick)"] | join(", ")))}
'

build_status() {
  jq -c --arg thisrepo "$1" "$JQ_STATUS"
}

# slack METHOD [curl args...]: POSTs form-encoded data, retries once on HTTP 429, and
# prints the response body. The token only ever travels in the Authorization header.
slack() {
  local method="$1" body hdr code retry_after
  shift
  body="$(mktemp)"
  hdr="$(mktemp)"
  for attempt in 1 2; do
    code="$(curl -sS -o "$body" -D "$hdr" -w '%{http_code}' -X POST \
      -H "Authorization: Bearer ${SLACK_BOT_TOKEN}" "$@" "https://slack.com/api/${method}")"
    if [ "$code" = "429" ] && [ "$attempt" = "1" ]; then
      retry_after="$(awk 'tolower($1) == "retry-after:" { print $2 + 0 }' "$hdr")"
      echo "Slack ${method}: rate limited, retrying in ${retry_after:-5}s" >&2
      sleep "${retry_after:-5}"
      continue
    fi
    break
  done
  if [ "${code:0:1}" != "2" ]; then
    echo "::error::Slack ${method}: HTTP ${code}" >&2
    rm -f "$body" "$hdr"
    return 1
  fi
  cat "$body"
  rm -f "$body" "$hdr"
}

# Fails (printing Slack's error field) unless the response on stdin has ok:true.
# An error listed in $1 (space separated) counts as success.
slack_ok() {
  local resp err
  resp="$(cat)"
  if [ "$(jq -r '.ok' <<<"$resp")" = "true" ]; then
    return 0
  fi
  err="$(jq -r '.error // "unknown_error"' <<<"$resp")"
  case " ${1:-} " in
    *" ${err} "*) return 0 ;;
  esac
  echo "::error::Slack API error: ${err}$(jq -r 'if .needed then " (needed scope: " + .needed + ")" else "" end' <<<"$resp")" >&2
  return 1
}

add_reaction() {
  slack reactions.add \
    --data-urlencode "channel=${SLACK_CHANNEL_ID}" \
    --data-urlencode "timestamp=$1" \
    --data-urlencode "name=${REACTION}" | slack_ok already_reacted
}

# PR state of "owner/repo#N": merged, open or unknown (unreadable with this token).
pr_state() {
  local ref="$1" this="$2" merged
  if [ "$ref" = "$this" ]; then
    echo merged
    return
  fi
  if merged="$(gh api "repos/${ref%#*}/pulls/${ref#*#}" --jq '.merged' 2>/dev/null)"; then
    if [ "$merged" = "true" ]; then echo merged; else echo open; fi
  else
    echo unknown
  fi
}

# handle_message TS REFS_JSON: applies the rules to one candidate message.
handle_message() {
  local ts="$1" refs="$2" this="$3" count states ref status marker
  count="$(jq 'length' <<<"$refs")"

  if [ "$count" -eq 1 ]; then
    add_reaction "$ts" || return 1
    echo "Message ${ts}: single PR, reacted :${REACTION}:"
    return
  fi

  states="[]"
  while IFS= read -r ref; do
    states="$(jq -c --arg ref "$ref" --arg state "$(pr_state "$ref" "$this")" \
      '. + [{ref: $ref, state: $state}]' <<<"$states")"
  done < <(jq -r '.[]' <<<"$refs")
  status="$(build_status "${this%#*}" <<<"$states")"

  # Best effort against re-runs: skip when the thread already shows this PR as merged.
  marker="$(jq -rn --arg n "$PR_NUMBER" '"|#\($n)> \u2713"')"
  if slack conversations.replies \
    --data-urlencode "channel=${SLACK_CHANNEL_ID}" \
    --data-urlencode "ts=${ts}" \
    --data-urlencode "limit=200" |
    jq -e --arg ts "$ts" --arg marker "$marker" \
      '.ok == true and any(.messages[]?; .ts != $ts and ((.text // "") | contains($marker)))' >/dev/null; then
    echo "Message ${ts}: thread already reports this PR as merged, not replying again"
  else
    slack chat.postMessage \
      --data-urlencode "channel=${SLACK_CHANNEL_ID}" \
      --data-urlencode "thread_ts=${ts}" \
      --data-urlencode "text=$(jq -r '.text' <<<"$status")" \
      --data-urlencode "unfurl_links=false" \
      --data-urlencode "unfurl_media=false" | slack_ok || return 1
    echo "Message ${ts}: replied $(jq -r '.merged' <<<"$status")/$(jq -r '.total' <<<"$status") merged"
  fi

  if [ "$(jq -r '.all' <<<"$status")" = "true" ]; then
    add_reaction "$ts"
    echo "Message ${ts}: all ${count} PRs merged, reacted :${REACTION}:"
  fi
}

main() {
  if [ -z "${SLACK_BOT_TOKEN:-}" ]; then
    echo "::notice::SLACK_BOT_TOKEN is not set, skipping Slack update"
    exit 0
  fi
  if [ -z "${SLACK_CHANNEL_ID:-}" ]; then
    echo "::notice::SLACK_CHANNEL_ID is not set, skipping Slack update"
    exit 0
  fi

  local this oldest cursor cursor_arg page candidates failed=0 seen=0
  this="${REPO,,}#${PR_NUMBER}"
  oldest="$(($(date +%s) - ${LOOKBACK_DAYS:-14} * 86400))"
  echo "Looking for messages linking ${this} in ${SLACK_CHANNEL_ID} (last ${LOOKBACK_DAYS:-14} days)"

  cursor=""
  while :; do
    cursor_arg=()
    [ -z "$cursor" ] || cursor_arg=(--data-urlencode "cursor=${cursor}")
    page="$(slack conversations.history \
      --data-urlencode "channel=${SLACK_CHANNEL_ID}" \
      --data-urlencode "oldest=${oldest}" \
      --data-urlencode "limit=200" \
      "${cursor_arg[@]}")"
    slack_ok <<<"$page"

    candidates="$(find_candidates "$this" <<<"$page")"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      seen=$((seen + 1))
      handle_message "$(jq -r '.ts' <<<"$line")" "$(jq -c '.refs' <<<"$line")" "$this" || failed=1
    done <<<"$candidates"

    cursor="$(jq -r '.response_metadata.next_cursor // ""' <<<"$page")"
    [ -n "$cursor" ] || break
    sleep 1
  done

  echo "Done: ${seen} message(s) linked ${this}"
  exit "$failed"
}

# Allows tests to source the pure functions without running main.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
