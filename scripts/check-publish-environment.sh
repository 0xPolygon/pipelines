#!/usr/bin/env bash
# Read-only check that a repository's `npm-publish` environment carries the
# protection the release workflow assumes. GitHub creates a missing
# environment with no protection when a job names it, so the workflow alone
# cannot guarantee the approval gate; this script verifies it out of band.
#
# Usage: scripts/check-publish-environment.sh <owner>/<repo>
# Needs: gh (authenticated, read access to the repo's environments), jq.
# GH_BIN overrides the gh executable so tests never touch the network.
set -euo pipefail

ENVIRONMENT_NAME='npm-publish'
GH_BIN="${GH_BIN:-gh}"

if [ "$#" -ne 1 ] || [[ "$1" != */* ]]; then
  echo "usage: $0 <owner>/<repo>" >&2
  exit 2
fi
OWNER_REPO="$1"

err_file="$(mktemp)"
trap 'rm -f "$err_file"' EXIT

if ! env_json="$("$GH_BIN" api -X GET "repos/$OWNER_REPO/environments/$ENVIRONMENT_NAME" 2>"$err_file")"; then
  if grep -q '404' "$err_file"; then
    echo "FAIL environment '$ENVIRONMENT_NAME' does not exist in $OWNER_REPO (404)"
  else
    echo "FAIL could not read environment '$ENVIRONMENT_NAME' in $OWNER_REPO: $(cat "$err_file")"
  fi
  exit 1
fi

failures=0
check() {
  # $1 label, $2 jq boolean expression
  if jq -e "$2" >/dev/null <<<"$env_json"; then
    echo "PASS $1"
  else
    echo "FAIL $1"
    failures=$((failures + 1))
  fi
}

check 'administrators cannot bypass protection (can_admins_bypass == false)' \
  '.can_admins_bypass == false'
check 'required reviewers rule has at least one reviewer' \
  '[.protection_rules[]? | select(.type == "required_reviewers") | select((.reviewers // []) | length > 0)] | length > 0'
check 'self-review prevented (prevent_self_review == true)' \
  '[.protection_rules[]? | select(.type == "required_reviewers") | select(.prevent_self_review == true)] | length > 0'
# Deployment is limited to the default branch only when the environment uses
# custom branch policies and every one of them is a plain branch rule naming
# the default branch. "Protected branches" mode admits any branch that has a
# protection rule, which can include more than the default branch.
read_or_fail() {
  # $1 api path; prints the body on success, reports and exits 1 otherwise.
  "$GH_BIN" api -X GET "$1" 2>"$err_file"
}
fail_read() {
  echo "FAIL could not read $1: $(cat "$err_file")"
  exit 1
}

branch_mode="$(jq -r 'if .deployment_branch_policy == null then "none"
  elif .deployment_branch_policy.protected_branches == true then "protected"
  elif .deployment_branch_policy.custom_branch_policies == true then "custom"
  else "none" end' <<<"$env_json")"

case "$branch_mode" in
  none)
    echo "FAIL deployment is not limited to any branch (no deployment branch policy)"
    failures=$((failures + 1))
    ;;
  protected)
    echo "FAIL deployment limited to protected branches, not the default branch only"
    failures=$((failures + 1))
    ;;
  custom)
    repo_json="$(read_or_fail "repos/$OWNER_REPO")" || fail_read "repos/$OWNER_REPO"
    default_branch="$(jq -r '.default_branch' <<<"$repo_json")"
    policies_path="repos/$OWNER_REPO/environments/$ENVIRONMENT_NAME/deployment-branch-policies?per_page=100"
    policies_json="$(read_or_fail "$policies_path")" || fail_read "$policies_path"
    if jq -e --arg default "$default_branch" '
      (.branch_policies | length) > 0
      and (.total_count == (.branch_policies | length))
      and all(.branch_policies[]; ((.type // "branch") == "branch") and .name == $default)
    ' >/dev/null <<<"$policies_json"; then
      echo "PASS deployment limited to the default branch ($default_branch) only"
    else
      echo "FAIL deployment branch policies are not exactly the default branch ($default_branch): $(jq -c '[.branch_policies[] | {type, name}]' <<<"$policies_json")"
      failures=$((failures + 1))
    fi
    ;;
esac

if [ "$failures" -ne 0 ]; then
  echo "$failures condition(s) failed for $OWNER_REPO"
  exit 1
fi
echo "all conditions passed for $OWNER_REPO"
