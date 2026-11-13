#!/usr/bin/env bash
# test-claude-autofix-guards.sh
#
# Structural checks for .github/workflows/ai-platform-claude-autofix.yml.
# The workflow's logic is inline shell that only runs inside Actions, so this
# test asserts the structure the controls depend on using grep and awk: which
# steps exist, the order they run in, and what each agent step is configured
# with. Comment-only lines are ignored, so a comment cannot satisfy a check.
#
# Usage: bash scripts/test-claude-autofix-guards.sh [path/to/workflow.yml]
# Requires: bash 3.2+, grep, sed, awk, tr (no other dependencies)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
F="${1:-$REPO_ROOT/.github/workflows/ai-platform-claude-autofix.yml}"

if [ ! -f "$F" ]; then
  echo "workflow file not found: $F" >&2
  exit 2
fi

PASS=0
FAIL=0

pass() { echo "  ok: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# check NAME EXPECTED ACTUAL
check() {
  if [ "$2" = "$3" ]; then
    pass "$1"
  else
    fail "$1 (expected: $2, got: $3)"
  fi
}

# Non-comment lines of the workflow.
nc() { grep -vE '^[[:space:]]*#' "$F" || true; }

# Count matching lines on stdin; prints 0 (and succeeds) when none match.
cnt() {
  local n
  n=$(grep -c "$@") || true
  echo "${n:-0}"
}

# First line number of a non-comment line matching REGEX inside job JOB.
lineof() {
  awk -v job="$1" -v pat="$2" '
    /^jobs:/ { injobs = 1 }
    injobs && /^  [a-z][a-z-]*:[[:space:]]*$/ { cur = $1; sub(/:$/, "", cur) }
    cur == job && $0 !~ /^[[:space:]]*#/ && $0 ~ pat { print NR; exit }
  ' "$F"
}

# check_before NAME JOB FIRST_REGEX SECOND_REGEX: FIRST appears above SECOND in JOB.
check_before() {
  local a b
  a=$(lineof "$2" "$3")
  b=$(lineof "$2" "$4")
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then
    pass "$1"
  else
    fail "$1 (first at line '${a:-none}', second at line '${b:-none}')"
  fi
}

# One line per claude_args block: "<blocks> <blocks with exactly one
# '--setting-sources user' line> <blocks with a '--strict-mcp-config' line>".
claude_args_summary() {
  nc | awk '
    function close_block() {
      if (inb) { b++; if (ss == 1) S++; if (sm >= 1) M++; inb = 0 }
    }
    { match($0, /^ */); ind = RLENGTH }
    inb && $0 !~ /^[[:space:]]*$/ && ind <= bind { close_block() }
    /claude_args:[[:space:]]*\|/ { inb = 1; bind = ind; ss = 0; sm = 0; next }
    inb {
      t = $0
      sub(/^[[:space:]]+/, "", t); sub(/[[:space:]]+$/, "", t)
      if (t == "--setting-sources user") ss++
      if (t == "--strict-mcp-config") sm++
    }
    END { close_block(); printf "%d %d %d\n", b + 0, S + 0, M + 0 }'
}

# Every entry of every --allowedTools line, one per output line.
allow_entries() {
  nc | grep -- '--allowedTools' \
    | sed -E 's/^[[:space:]]*--allowedTools[[:space:]]+"//; s/"[[:space:]]*$//' \
    | tr ',' '\n' || true
}

# Every allowed entry must equal one of these full forms; a widened rule
# (a trailing wildcard, an extra verb) matches none of them.
EXPR='\$\{\{ [^}]+ \}\}'
REPO='\$\{\{ github\.repository \}\}'
ALLOW_RE="^(Bash\\(gh pr (view|diff|checks|comment) ${EXPR}:\\*\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(gh pr edit ${EXPR} --add-label \\\$\\{\\{ env\\.STOP_LABEL \\}\\}\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(gh api repos/${REPO}/pulls/\\\$\\{\\{ github\\.event\\.pull_request\\.number \\}\\}/(comments|reviews) --paginate\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(gh api repos/${REPO}/commits/${EXPR}/check-runs:\\*\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(gh api repos/${REPO}/check-runs/\\*\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(gh run (list|view):\\*\\)"
ALLOW_RE="${ALLOW_RE}|Bash\\(git (status|diff|diff --stat|log --oneline -n 50)\\)"
ALLOW_RE="${ALLOW_RE}|Read|Edit\\(\\./\\*\\*\\)|Grep|Glob|mcp__github_file_ops__(commit|delete)_files)\$"

echo "Checking $F"

echo "Credential handling"
check "G1 both checkouts set persist-credentials: false" 2 \
  "$(nc | cnt 'persist-credentials: false')"
check "G2 no remote URL rewritten to embed a token" 0 \
  "$(nc | cnt 'git remote set-url origin "https://x-access-token')"
check "G3 no bare git ls-remote / git fetch" 0 \
  "$(nc | cnt -E '(^|[^_[:alnum:]])git (ls-remote|fetch)( |$)')"
check "G4 git network calls go through git_auth (ls-remote, fetch, definitions)" "4 2 4" \
  "$(nc | cnt 'git_auth ls-remote') $(nc | cnt 'git_auth fetch') $(nc | cnt '^ *git_auth() {')"

echo "Interpreter isolation"
check "G5 every python3 invocation uses -P (invocations, with -P)" "8 8" \
  "$(nc | cnt 'python3 ') $(nc | cnt 'python3 -P ')"

echo "Step order"
check_before "G6 review job: matcher install precedes checkout" fix-review-feedback \
  'name: Install path matcher dependency' 'uses: actions/checkout@'
check_before "G6 fixer job: matcher install precedes checkout" fix-failing-checks \
  'name: Install path matcher dependency' 'uses: actions/checkout@'
check_before "S4 review job: requester gate precedes checkout" fix-review-feedback \
  'id: authz' 'uses: actions/checkout@'
check_before "S4 fixer job: requester gate precedes checkout" fix-failing-checks \
  'id: authz' 'uses: actions/checkout@'
check_before "S4 fixer job: base-branch configuration step precedes path policy parse" fix-failing-checks \
  'name: Use agent configuration from the base branch' 'name: Parse and validate path policy'
check "G10 base-branch configuration step defined once" 1 \
  "$(nc | cnt 'name: Use agent configuration from the base branch')"

echo "Agent command list"
check "S4 workflow has two agent steps" 2 "$(nc | cnt 'claude-code-action@')"
check "G7 command list has no bare Bash entry" 0 \
  "$(allow_entries | cnt -x 'Bash')"
check "G8 command list has no interpreter or package-manager entry" 0 \
  "$(allow_entries | cnt -E 'Bash\((npm|pnpm|yarn|npx|node|python|pip|make|bash|sh|curl|wget)([^[:alnum:]]|$)')"
check "S4 every command-list entry matches a permitted form" 0 \
  "$(allow_entries | grep -cvE "$ALLOW_RE" || true)"
check "B2 no git allow entry uses a ':*' prefix" 0 \
  "$(allow_entries | cnt -E '^Bash\(git .*:\*')"
check "n7 no Write( entry in any command list" 0 \
  "$(nc | grep -- '--allowedTools' | cnt -F 'Write(')"
check "S4 six --allowedTools lines (three per agent step)" 6 \
  "$(nc | cnt -- '--allowedTools')"

echo "Agent configuration sources"
check "G9 claude_args blocks / with '--setting-sources user' / with '--strict-mcp-config'" "2 2 2" \
  "$(claude_args_summary)"
check "S4 every --setting-sources value is exactly 'user'" 0 \
  "$(nc | grep -oE -- '--setting-sources[= ][^ "]*' | grep -cvxF -- '--setting-sources user' || true)"
check "S4 no --setting-sources value names project or local" 0 \
  "$(nc | grep -oE -- '--setting-sources[= ][^ "]*' | cnt -E 'project|local')"
check "G9 subprocess environment scrub set on both agent steps" 2 \
  "$(nc | cnt "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'")"

echo "File tool scope"
check "A1 command list has no bare Edit or Write entry" 0 \
  "$(allow_entries | cnt -E '^(Edit|Write)$')"
check "A1 scoped Edit(./**) allowed on both agent steps" 2 \
  "$(nc | grep -- '--allowedTools' | cnt -F 'Edit(./**)')"
check "A1 two --disallowedTools lines" 2 \
  "$(nc | cnt -- '--disallowedTools')"
check "A1 each --disallowedTools line includes Edit(~/.gitconfig)" 0 \
  "$(nc | grep -- '--disallowedTools' | grep -cvF 'Edit(~/.gitconfig)' || true)"
check "A1 each --disallowedTools line includes Edit(~/.config/**)" 0 \
  "$(nc | grep -- '--disallowedTools' | grep -cvF 'Edit(~/.config/**)' || true)"
check "A1 each --disallowedTools line includes Edit(.git/**)" 0 \
  "$(nc | grep -- '--disallowedTools' | grep -cvF 'Edit(.git/**)' || true)"
for pat in 'Bash(gh pr * --repo*)' 'Bash(gh pr * -R *)' 'Bash(gh run * --repo*)' 'Bash(gh run * -R *)'; do
  check "R1 each --disallowedTools line includes $pat" 0 \
    "$(nc | grep -- '--disallowedTools' | grep -cvF "$pat" || true)"
done
check "R1 no --allowedTools line carries --repo or -R" 0 \
  "$(nc | grep -- '--allowedTools' | grep -cE -- '--repo| -R ' || true)"
for pat in 'Bash(cd *)' 'Bash(pushd *)' 'Bash(git -C *)' 'Bash(git -c *)' 'Bash(git --git-dir*)' 'Bash(git --work-tree*)' 'Bash(git --exec-path*)'; do
  check "N1 each --disallowedTools line includes $pat" 0 \
    "$(nc | grep -- '--disallowedTools' | grep -cvF "$pat" || true)"
done
for pat in 'Edit(**/.git)' 'Edit(**/.git/**)' 'Bash(git *--output*)' 'Bash(gh pr comment *--body-file*)' 'Bash(gh pr comment * -F*)'; do
  check "B2/M1/m4 each --disallowedTools line includes $pat" 0 \
    "$(nc | grep -- '--disallowedTools' | grep -cvF "$pat" || true)"
done
check "m6 both agent steps block writes outside the working directory" 2 \
  "$(nc | cnt -F "settings: '{\"permissions\":{\"blockWritesOutsideWorkingDirectories\":true}}'")"

echo "Requester gate and dependency-bot list"
check "G11 dependency-bot list defined once" 1 \
  "$(nc | cnt 'dependabot\[bot\]')"
check "S4 dependency-bot list variable defined once" 1 \
  "$(nc | cnt '^[[:space:]]*DEPENDENCY_BOT_LOGINS:')"
check "G12 permission lookups / steps gated on the requester check" "2 8" \
  "$(nc | cnt 'getCollaboratorPermissionLevel') $(nc | cnt "steps.authz.outputs.proceed == 'true'")"

echo "Workflow-wide"
check "G13 id-token: write kept on both privileged jobs" 2 \
  "$(nc | cnt 'id-token: write')"
check "G15 every action reference is pinned to a full commit SHA with a version comment" 0 \
  "$(nc | grep -E '^[[:space:]]*(- )?uses:' | grep -cvE '@[0-9a-f]{40} # v[0-9]' || true)"

echo "git_auth output"
# git_auth's stdout is captured by callers ($(git_auth ls-remote ... | cut -f1)),
# so it must print nothing of its own.
GA_FILE="$(mktemp)"
awk '/^ *git_auth\(\) \{/ { p = 1 } p { print } p && /^ *\}/ { exit }' "$F" > "$GA_FILE"
SHA40="0123456789abcdef0123456789abcdef01234567"
git() { printf '%s\trefs/heads/x\n' "$SHA40"; }
GIT_BASIC="ZHVtbXk="
GITHUB_SERVER_URL="https://example.invalid"
# shellcheck disable=SC1090
. "$GA_FILE"
GOT="$(set +u; git_auth ls-remote o r | cut -f1)"
rm -f "$GA_FILE"
if [ "$GOT" = "$SHA40" ] && [ "${#GOT}" -eq 40 ]; then
  pass "B1 captured git_auth output is exactly the 40-hex SHA"
else
  fail "B1 captured git_auth output is exactly the 40-hex SHA (got: $GOT)"
fi
unset -f git

echo
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ]
