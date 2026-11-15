#!/usr/bin/env bash
# Tests scripts/check-publish-environment.sh against fixture JSON. GH_BIN
# points at a stub that prints a fixture (or fails like a 404), so nothing
# touches the network.
#
# Usage: bash scripts/test-check-publish-environment.sh
# Requires: bash, jq
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/check-publish-environment.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# The stub answers by API path from files in $FIXTURE_DIR: environment.json,
# policies.json, repo.json. environment.json = "404" mimics gh's not-found.
cat >"$WORK/gh" <<'STUB'
#!/usr/bin/env bash
path="${@: -1}"
case "$path" in
  */deployment-branch-policies*) f="$FIXTURE_DIR/policies.json" ;;
  */environments/*) f="$FIXTURE_DIR/environment.json" ;;
  *) f="$FIXTURE_DIR/repo.json" ;;
esac
if [ "$(cat "$f")" = "404" ]; then
  echo "gh: Not Found (HTTP 404)" >&2
  exit 1
fi
cat "$f"
STUB
chmod +x "$WORK/gh"
export FIXTURE_DIR="$WORK/fixtures"
mkdir -p "$FIXTURE_DIR"

PASS=0
FAIL=0

# env_json ADMIN_BYPASS PREVENT_SELF REVIEWERS_JSON BRANCH_POLICY_JSON
env_json() {
  jq -n --argjson bypass "$1" --argjson self "$2" --argjson reviewers "$3" --argjson policy "$4" '{
    name: "npm-publish",
    can_admins_bypass: $bypass,
    protection_rules: [
      { type: "required_reviewers", prevent_self_review: $self, reviewers: $reviewers },
      { type: "branch_policy" }
    ],
    deployment_branch_policy: $policy
  }'
}

ONE='[{"type":"User","reviewer":{"login":"someone"}}]'
POLICY='{"protected_branches":false,"custom_branch_policies":true}'

MAIN='[{"name":"main","type":"branch"}]'

# run_case NAME EXPECTED_EXIT EXPECTED_LINE_REGEX ENV_JSON|404 [POLICIES_JSON]
# POLICIES_JSON is a branch_policies array; default is main only.
run_case() {
  local name="$1" want_exit="$2" want_line="$3" envjson="$4" pols="${5:-$MAIN}" out got=0
  printf '%s' "$envjson" >"$FIXTURE_DIR/environment.json"
  jq -n --argjson p "$pols" '{total_count: ($p | length), branch_policies: $p}' >"$FIXTURE_DIR/policies.json"
  echo '{"default_branch":"main"}' >"$FIXTURE_DIR/repo.json"
  out="$(GH_BIN="$WORK/gh" bash "$CHECK" example/repo 2>&1)" || got=$?
  if [ "$got" -eq "$want_exit" ] && { [ -z "$want_line" ] || grep -Eq "$want_line" <<<"$out"; }; then
    echo "  PASS: $name"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $name (exit $got, want $want_exit)"
    echo "$out" | sed 's/^/    /'
    FAIL=$((FAIL + 1))
  fi
}

echo "check-publish-environment"
GOOD="$(env_json false true "$ONE" "$POLICY")"
run_case 'fully protected, default branch only, passes' 0 'PASS deployment limited to the default branch' "$GOOD"
run_case 'admin bypass on fails' 1 'FAIL.*can_admins_bypass' "$(env_json true true "$ONE" "$POLICY")"
run_case 'no reviewers fails' 1 'FAIL.*at least one reviewer' "$(env_json false true '[]' "$POLICY")"
run_case 'self-review allowed fails' 1 'FAIL.*prevent_self_review' "$(env_json false false "$ONE" "$POLICY")"
run_case 'no branch policy fails' 1 'FAIL.*no deployment branch policy' "$(env_json false true "$ONE" null)"
run_case 'missing environment (404) fails' 1 'does not exist' 404
run_case 'extra branch fails' 1 'FAIL.*not exactly the default' "$GOOD" '[{"name":"main","type":"branch"},{"name":"release","type":"branch"}]'
run_case 'wildcard pattern fails' 1 'FAIL.*not exactly the default' "$GOOD" '[{"name":"ma*","type":"branch"}]'
run_case 'tag policy fails' 1 'FAIL.*not exactly the default' "$GOOD" '[{"name":"main","type":"tag"}]'
run_case 'empty policy list fails' 1 'FAIL.*not exactly the default' "$GOOD" '[]'
run_case 'protected-branches mode fails' 1 'FAIL deployment limited to protected branches, not the default branch only' \
  "$(env_json false true "$ONE" '{"protected_branches":true,"custom_branch_policies":false}')"

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
