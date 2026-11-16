#!/usr/bin/env bash
# Asserts the structure of the release conformance workflow, so CI fails when
# a change widens what it can do: a privileged pull request trigger, token
# scope beyond reading contents, secrets, persisted checkout credentials,
# caches, installs, or an unpinned third-party action. The workflow reads
# files and runs no code from the repository under review; these checks keep
# that true. Text checks strip comment lines before matching; structural
# checks parse the workflow with the `yaml` devDependency.
#
# Usage: bash scripts/test-release-conformance-workflow.sh [workflow-file]
# Requires: bash, grep, node, and the repo's devDependencies installed
# (`pnpm install`), for the `yaml` parser.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="${1:-$REPO_ROOT/.github/workflows/apps-release-conformance.yml}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
check() { # check DESCRIPTION CONDITION_EXIT_CODE [DETAIL]
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1${3:+ ($3)}"; fi
}

if [ ! -f "$CHECK" ]; then
  fail "conformance workflow exists ($CHECK)"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi
pass "conformance workflow exists"

# Comment-only lines removed; text checks work on this copy.
grep -vE '^[[:space:]]*#' "$CHECK" >"$WORK/check.yml"

# Runs a JS expression over the parsed workflow `w`; prints its result.
query() {
  CHECK_FILE="$CHECK" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse } from "yaml";
    const w = parse(readFileSync(process.env.CHECK_FILE, "utf8"));
    const jobs = Object.values(w.jobs ?? {});
    const steps = jobs.flatMap((j) => j.steps ?? []);
    const out = (value) => console.log(JSON.stringify(value));
    '"$1"
}

# --- Triggers ---
events="$(query 'out(Object.keys(w.on ?? {}).sort())')"
[ "$events" = '["merge_group","pull_request","workflow_call"]' ]
check "triggers are exactly pull_request, merge_group, workflow_call" $? "got: $events"

! grep -n 'pull_request_target' "$WORK/check.yml" >"$WORK/out"
check "no privileged pull request trigger" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

# --- Permissions ---
top="$(query 'out(w.permissions)')"
[ "$top" = '{}' ]
check "top-level permissions is {}" $? "got: $top"

job_perms="$(query 'out(jobs.map((j) => j.permissions))')"
[ "$job_perms" = '[{"contents":"read"}]' ]
check "every job grants exactly contents: read" $? "got: $job_perms"

# --- Secrets ---
! grep -nE 'secrets[.:]|secrets:|\bGITHUB_TOKEN\b|\btoken:' "$WORK/check.yml" >"$WORK/out"
check "no secrets or token inputs are used" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

# --- Checkouts ---
checkouts="$(query 'const c = steps.filter((s) => /^actions\/checkout@/.test(s.uses ?? "")); out(c.length > 0 && c.every((s) => s.with?.["persist-credentials"] === false))')"
[ "$checkouts" = 'true' ]
check "every checkout sets persist-credentials: false" $? "got: $checkouts"

# --- No caches, no installs ---
! grep -nE '^[[:space:]]*(-[[:space:]]*)?cache:|actions/cache|actions/setup-node' "$WORK/check.yml" >"$WORK/out"
check "no setup-node, no cache: input, no actions/cache" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

! grep -nE '(npm|pnpm|yarn|bun)[[:space:]]+(install|i|ci|add|exec|dlx|run)\b|npx[[:space:]]' "$WORK/check.yml" >"$WORK/out"
check "no install, exec or run commands" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

# --- Pins ---
! grep -nE '^[[:space:]]*-?[[:space:]]*uses:' "$CHECK" \
  | grep -v 'uses: \./' \
  | grep -vE 'uses: [^[:space:]@]+@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+' >"$WORK/out"
check "every third-party uses: is pinned to a 40-hex SHA with a version comment" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

# --- Timeout ---
timeouts="$(query 'out(jobs.map((j) => typeof j["timeout-minutes"]))')"
[ "$timeouts" = '["number"]' ]
check "every job sets timeout-minutes" $? "got: $timeouts"

echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
