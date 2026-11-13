#!/usr/bin/env bash
# Asserts the structure of the npm release workflow and its trigger, so CI
# fails when a change weakens the publish boundary (OIDC scope, approval
# environment, caller code in the publishing job, cache restores, unpinned
# actions). Text-based on purpose: no YAML dependency, comment lines are
# stripped before any structural match.
#
# Usage: bash scripts/test-npm-release-workflow.sh [workflow-file] [trigger-file]
# Requires: bash, awk, grep
set -uo pipefail

# --- Expected shape. Change these in one place when jobs are added. ---
EXPECTED_JOBS="version build publish finalize snapshot"
# Jobs that may hold `id-token: write`, sorted, space separated.
EXPECTED_ID_TOKEN_JOBS="publish snapshot"
# Jobs that must run release-guard, and jobs that must not.
GUARDED_JOBS="version publish finalize"
UNGUARDED_JOBS="snapshot"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REL="${1:-$REPO_ROOT/.github/workflows/apps-npm-release.yml}"
TRIG="${2:-$REPO_ROOT/.github/workflows/apps-npm-release-trigger.yml}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
check() { # check DESCRIPTION CONDITION_EXIT_CODE [DETAIL]
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1${3:+ ($3)}"; fi
}

if [ ! -f "$REL" ] || [ ! -f "$TRIG" ]; then
  fail "workflow and trigger files exist ($REL, $TRIG)"
  echo "Results: $PASS passed, $FAIL failed"
  exit 1
fi
pass "workflow and trigger files exist"
[ "$(basename "$REL")" = "apps-npm-release.yml" ] || [ -n "${1:-}" ]
check "workflow file keeps its exact name" $? "$(basename "$REL")"

# Comment-only lines removed; everything below works on these copies.
strip() { grep -vE '^[[:space:]]*#' "$1"; }
strip "$REL" >"$WORK/rel.yml"
strip "$TRIG" >"$WORK/trig.yml"

job_names() { awk '/^jobs:/{j=1;next} j&&/^  [a-z][a-z0-9_-]*:$/{sub(/:$/,"");print $1}' "$WORK/rel.yml"; }
job_block() { awk -v n="$1" '/^jobs:/{j=1;next} j&&/^  [a-z][a-z0-9_-]*:$/{cur=$1;sub(/:$/,"",cur)} j&&cur==n{print}' "$WORK/rel.yml"; }

# --- Job set ---
actual_jobs="$(job_names | tr '\n' ' ' | sed 's/ $//')"
[ "$actual_jobs" = "$EXPECTED_JOBS" ]
check "jobs are: $EXPECTED_JOBS" $? "got: $actual_jobs"

# --- No cache anywhere ---
! grep -nE '^[[:space:]]*(-[[:space:]]*)?cache:|actions/cache' "$WORK/rel.yml" >"$WORK/out"
check "no cache: input and no actions/cache" $? "$(head -3 "$WORK/out" | tr '\n' ';')"

# --- id-token placement ---
actual_idt="$(awk '/^jobs:/{j=1;next} j&&/^  [a-z][a-z0-9_-]*:$/{job=$1;sub(/:$/,"",job)} j&&/^[[:space:]]+id-token: write/{print job}' "$WORK/rel.yml" | sort -u | tr '\n' ' ' | sed 's/ $//')"
[ "$actual_idt" = "$EXPECTED_ID_TOKEN_JOBS" ]
check "id-token: write only in: $EXPECTED_ID_TOKEN_JOBS" $? "got: $actual_idt"

# --- Every job has its own permissions block ---
missing=""
for j in $(job_names); do
  job_block "$j" | grep -qE '^    permissions:' || missing="$missing $j"
done
[ -z "$missing" ]
check "every job declares permissions:" $? "missing:$missing"

# --- Release guard placement ---
bad=""
for j in $GUARDED_JOBS; do
  job_block "$j" | grep -qE 'uses: \./.*release-guard' || bad="$bad $j(missing)"
done
for j in $UNGUARDED_JOBS; do
  ! job_block "$j" | grep -qE 'release-guard' || bad="$bad $j(present)"
done
[ -z "$bad" ]
check "release-guard in [$GUARDED_JOBS], not in [$UNGUARDED_JOBS]" $? "$bad"

# --- publish job: approval gate, no caller code ---
PUB="$WORK/publish.yml"
job_block publish >"$PUB"
grep -qE '^    environment: npm-publish$' "$PUB"
check "publish has environment: npm-publish" $?
! grep -qE 'pnpm/action-setup' "$PUB"
check "publish does not set up pnpm" $?
! grep -qE 'pnpm install' "$PUB"
check "publish does not run pnpm install" $?
# Every checkout in publish must be the workflow's own repository into .pipelines.
awk '
  function flush() { if (inco && !(own && dst)) bad=1; inco=0; own=0; dst=0 }
  /^      - /{ flush(); if ($0 ~ /actions\/checkout@/) inco=1 }
  inco && /job\.workflow_repository/ { own=1 }
  inco && /^[[:space:]]+path: \.pipelines$/ { dst=1 }
  END { flush(); exit bad }' "$PUB"
check "publish checks out only the workflow's own repository into .pipelines" $?
grep -qE "node-version: '?[0-9]+\.[0-9]+\.[0-9]+'?[[:space:]]*$" "$PUB"
check "publish setup-node uses an exact x.y.z node-version" $?
grep -qE '^[[:space:]]+check-latest: false$' "$PUB"
check "publish setup-node has check-latest: false" $?

# --- finalize tags services-only releases without approval (publish skipped) ---
job_block finalize | awk '/^    if:/{f=1;next} f&&/^    [a-z-]+:/{f=0} f' >"$WORK/final-if"
grep -qF "needs.publish.result == 'skipped'" "$WORK/final-if"
check "finalize if: accepts needs.publish.result == 'skipped'" $?

# --- No inherited secrets, no unpinned actions, no fetched tools ---
! grep -nE 'secrets: inherit' "$WORK/rel.yml" "$WORK/trig.yml" >"$WORK/out"
check "no secrets: inherit" $? "$(head -2 "$WORK/out" | tr '\n' ';')"

# Comments are needed for the pin check, so use the raw files.
unpinned=""
while IFS= read -r line; do
  case "$line" in *"uses: ./"*) continue ;; esac
  echo "$line" | grep -qE '@[0-9a-f]{40} # v[0-9]+\.[0-9]+\.[0-9]+' || unpinned="$unpinned [$(echo "$line" | sed 's/^[[:space:]]*//')]"
done < <(grep -hE '^[[:space:]]*-?[[:space:]]*uses:' "$REL" "$TRIG")
[ -z "$unpinned" ]
check "every third-party uses: has a 40-hex SHA and a # vX.Y.Z comment" $? "$unpinned"

! grep -nE 'pnpm dlx|npx |(^|[^p])npm exec' "$WORK/rel.yml" >"$WORK/out"
check "no pnpm dlx, npx or npm exec" $? "$(head -2 "$WORK/out" | tr '\n' ';')"

# --- Trigger permissions cover every job's request (write >= read) ---
rank() { case "$1" in write) echo 2 ;; read) echo 1 ;; *) echo 0 ;; esac; }
awk '/^permissions:/{p=1;next} p&&/^[^ ]/{p=0} p&&/^  [a-z-]+: (read|write)/{sub(/:/,"");print $1, $2}' "$WORK/trig.yml" >"$WORK/trig-perms"
awk '/^jobs:/{j=1;next}
     j&&/^  [a-z][a-z0-9_-]*:$/{inp=0}
     j&&/^    permissions:/{inp=1;next}
     j&&inp&&/^    [a-z]/{inp=0}
     j&&inp&&/^      [a-z-]+: (read|write)/{sub(/:/,"");print $1, $2}' "$WORK/rel.yml" >"$WORK/job-perms"
short=""
while read -r scope level; do
  have="$(awk -v s="$scope" '$1==s{print $2}' "$WORK/trig-perms" | head -1)"
  [ "$(rank "${have:-none}")" -ge "$(rank "$level")" ] || short="$short $scope:$level(has ${have:-none})"
done < <(sort -u "$WORK/job-perms")
[ -z "$short" ]
check "trigger top-level permissions cover every job scope" $? "short:$short"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
