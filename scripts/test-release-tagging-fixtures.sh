#!/usr/bin/env bash
# Runs the release tagging scripts against the real @changesets/cli 2.30.0 and
# 3.0.3 in scratch workspaces, so the assumptions the unit tests stub out
# (what `changeset tag` / `changeset git-tag` create, what the config reader
# returns for `ignore`, how the detector reacts to `privatePackages`) are
# checked against the actual CLIs.
#
# 3.x path: detector -> collect-tags.mjs -> validate-tags.mjs -> a stand-in for
# the push step -> check-release-tags. 2.x path: detector -> `changeset tag` ->
# check-release-tags (local derivation). The GitHub REST calls the end-state
# check makes are answered from a local bare repository acting as `origin`, so
# nothing here reaches GitHub.
#
# Network: only the two `pnpm add` installs may reach the registry. Every other
# command runs with an unreachable registry, empty user/global npmrc files and
# no npm token in the environment. No publish-capable subcommand is ever run.
#
# Usage: bash scripts/test-release-tagging-fixtures.sh
# Requires: bash, git, jq, node, pnpm, and registry access for the install step.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ACTIONS="$REPO_ROOT/.github/actions"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Credential isolation: empty npmrc files, no token variables.
: >"$WORK/npmrc-user"
: >"$WORK/npmrc-global"
unset NODE_AUTH_TOKEN NPM_TOKEN
export NPM_CONFIG_USERCONFIG="$WORK/npmrc-user" NPM_CONFIG_GLOBALCONFIG="$WORK/npmrc-global"
# Git: no user/system config (no signing, no hooks from the host), fixed identity.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.invalid
export GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.invalid

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  echo "PASS: $1"
}
fail() {
  FAIL=$((FAIL + 1))
  echo "FAIL: $1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /'
}

# expect_rc LABEL WANTED_RC -- uses $RC and $OUT from the last `run`.
expect_rc() {
  if [ "$RC" -eq "$2" ]; then pass "$1"; else fail "$1 (exit $RC, wanted $2)" "$OUT"; fi
}
# expect_out LABEL FIXED_STRING -- $OUT must contain the string.
expect_out() {
  if printf '%s' "$OUT" | grep -qF -- "$2"; then pass "$1"; else fail "$1 (output lacks: $2)" "$OUT"; fi
}
expect_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', wanted '$3')"; fi
}

# run DIR CMD... -- runs in DIR, captures combined output in $OUT and status in $RC.
run() {
  local dir="$1"
  shift
  OUT="$(cd "$dir" && "$@" 2>&1)"
  RC=$?
}

# --- the only step that may reach the registry --------------------------------
install_cli() {
  local version="$1" dir="$WORK/cli-${1%%.*}"
  mkdir -p "$dir"
  printf '{"name":"cli-host","private":true,"version":"0.0.0"}\n' >"$dir/package.json"
  # Only the registry variables are cleared here; everything else stays isolated.
  if ! (cd "$dir" && env -u npm_config_registry -u NPM_CONFIG_REGISTRY \
    pnpm add --save-exact --ignore-scripts "@changesets/cli@$version" >"$dir/install.log" 2>&1); then
    echo "Could not install @changesets/cli@$version:" >&2
    cat "$dir/install.log" >&2
    exit 1
  fi
}

install_cli 2.30.0
install_cli 3.0.3
# From here on nothing may reach the registry.
export npm_config_registry=http://127.0.0.1:9

# --- the end-state check driver ----------------------------------------------
# Imports the real check and answers its GitHub REST reads from the bare
# repository named by FIXTURE_REMOTE. Only GET requests exist in the check, and
# the stub throws on anything that is not a ref, tag object or release read.
cat >"$WORK/check-driver.mjs" <<'DRIVER'
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const { main } = await import(pathToFileURL(process.env.CHECK_MODULE).href);
const remote = process.env.FIXTURE_REMOTE;
const git = (args) => spawnSync('git', ['--git-dir', remote, ...args], { encoding: 'utf8' });
const reply = (status, body) => ({ status, json: async () => body });

const fetchImpl = async (url, init) => {
  if (init?.method !== undefined && init.method !== 'GET') throw new Error(`non-GET call: ${init.method}`);
  const { pathname } = new URL(url);
  let match = /\/git\/ref\/tags\/(.+)$/.exec(pathname);
  if (match) {
    const ref = `refs/tags/${decodeURIComponent(match[1])}`;
    const sha = git(['rev-parse', '--verify', '--quiet', ref]);
    if (sha.status !== 0) return reply(404, {});
    const type = git(['cat-file', '-t', sha.stdout.trim()]).stdout.trim();
    return reply(200, { object: { type, sha: sha.stdout.trim() } });
  }
  match = /\/git\/tags\/([0-9a-f]{40})$/.exec(pathname);
  if (match) {
    const body = git(['cat-file', '-p', match[1]]).stdout;
    const target = /^object ([0-9a-f]{40})$/m.exec(body)?.[1];
    const type = /^type (\w+)$/m.exec(body)?.[1];
    return reply(200, { object: { type, sha: target } });
  }
  if (/\/releases\/tags\//.test(pathname)) return reply(404, {});
  throw new Error(`unexpected request: ${pathname}`);
};

process.exitCode = await main({
  env: {
    GITHUB_REPOSITORY: 'example/fixture',
    GITHUB_TOKEN: 'fixture-token-not-used',
    GITHUB_API_URL: 'http://fixture.invalid',
    GITHUB_WORKSPACE: process.cwd(),
    GITHUB_SHA: process.env.FIXTURE_SHA,
    CLI_MAJOR: process.env.FIXTURE_MAJOR,
    TAGS_FILE: process.env.FIXTURE_TAGS_FILE ?? '',
    TARBALL_DIRECTORY: ''
  },
  fetchImpl
});
DRIVER

# --- fixture builders ---------------------------------------------------------
CASE_N=0

# write_pkg DIR NAME VERSION PRIVATE(true|false)
write_pkg() {
  mkdir -p "$1"
  jq -n --arg n "$2" --arg v "$3" --argjson p "$4" \
    '{name: $n, version: $v, private: $p} | if .private then . else del(.private) end' >"$1/package.json"
}

# new_workspace MAJOR LAYOUT CONFIG_JSON [NAME VERSION PRIVATE]...
# LAYOUT: multi (members under packages/) or single (one root package).
# Sets WS, REMOTE. Commits the tree, pushes `main` to a bare `origin`.
new_workspace() {
  local major="$1" layout="$2" config="$3"
  shift 3
  CASE_N=$((CASE_N + 1))
  WS="$WORK/ws-$CASE_N"
  REMOTE="$WORK/remote-$CASE_N.git"
  mkdir -p "$WS/.changeset"
  if [ "$layout" = multi ]; then
    printf '{"name":"fixture-root","private":true}\n' >"$WS/package.json"
    printf "packages:\n  - 'packages/*'\n" >"$WS/pnpm-workspace.yaml"
    while [ "$#" -ge 3 ]; do
      write_pkg "$WS/packages/$(basename "$1")" "$1" "$2" "$3"
      shift 3
    done
  else
    write_pkg "$WS" "$1" "$2" "$3"
  fi
  # The CLI is resolved from the repository's own node_modules, as in a release run.
  jq --arg v "$(jq -r .version "$WORK/cli-$major/node_modules/@changesets/cli/package.json")" \
    '.devDependencies = {"@changesets/cli": $v}' "$WS/package.json" >"$WS/package.json.tmp"
  mv "$WS/package.json.tmp" "$WS/package.json"
  ln -s "$WORK/cli-$major/node_modules" "$WS/node_modules"
  printf '%s\n' "$config" >"$WS/.changeset/config.json"
  printf 'node_modules\n' >"$WS/.gitignore"
  git init -q -b main "$WS"
  git init -q --bare -b main "$REMOTE"
  git -C "$WS" remote add origin "$REMOTE"
  git -C "$WS" add -A
  git -C "$WS" commit -q -m "initial"
  git -C "$WS" push -q origin main
}

# A second commit, so a tag can sit at an earlier commit than HEAD.
add_commit() {
  printf '%s\n' "$1" >"$WS/note.txt"
  git -C "$WS" add note.txt
  git -C "$WS" commit -q -m "$1"
}

head_sha() { git -C "$WS" rev-parse HEAD; }

config_json() {
  # config_json IGNORE_JSON PRIVATE_PACKAGES_JSON(or "")
  local ignore="$1" priv="$2"
  jq -n --argjson ignore "$ignore" --arg priv "$priv" \
    '{changelog: false, commit: false, access: "public", baseBranch: "main", ignore: $ignore}
     | if $priv == "" then . else . + {privatePackages: ($priv | fromjson)} end'
}

DETECTOR="$ACTIONS/check-changesets-cli/check-changesets-cli.mjs"
COLLECT="$ACTIONS/tag-and-release/collect-tags.mjs"
VALIDATE="$ACTIONS/tag-and-release/validate-tags.mjs"

detect() { run "$WS" node "$DETECTOR"; }

# collect3: collect-tags.mjs then validate-tags.mjs. Leaves collect's result in
# C_RC/C_OUT, and validate's in $RC/$OUT.
collect3() {
  TAGS_FILE="$WORK/tags-$CASE_N.json"
  export TAGS_FILE
  run "$WS" node "$COLLECT"
  C_RC=$RC C_OUT=$OUT
  if [ "$C_RC" -eq 0 ]; then
    GITHUB_WORKSPACE="$WS" GITHUB_SHA="$(head_sha)" run "$WS" node "$VALIDATE"
  fi
}

# push_created TAGS...: stands in for the step that pushes the validated tags.
push_tags() {
  local tag
  for tag in "$@"; do git -C "$WS" push -q origin "refs/tags/$tag"; done
}

# check MAJOR: the end-state check against the local bare remote.
check() {
  FIXTURE_REMOTE="$REMOTE" FIXTURE_SHA="$(head_sha)" FIXTURE_MAJOR="$1" \
    FIXTURE_TAGS_FILE="${2:-}" CHECK_MODULE="$ACTIONS/check-release-tags/check-release-tags.mjs" \
    run "$WS" node "$WORK/check-driver.mjs"
}

tag_names() { jq -r '[.tags[].tag] | sort | join(",")' "$TAGS_FILE"; }
expected_names() { jq -r '[.expected[].tag] | sort | join(",")' "$TAGS_FILE"; }
local_tags() { git -C "$WS" tag --points-at HEAD | sort | paste -sd, -; }
remote_tags() { git --git-dir "$REMOTE" tag | sort | paste -sd, -; }

PRIV_ON='{"version":true,"tag":true}'

# =============================================================================
echo "== @changesets/cli 3.0.3 =="
# =============================================================================

echo "-- 3.x: public + private"
new_workspace 3 multi "$(config_json '[]' "$PRIV_ON")" \
  @fx/pub 1.0.0 false @fx/priv 1.0.0 true
detect
expect_rc "3.x pub+priv: detector accepts" 0
expect_out "3.x pub+priv: detector reports major 3" "@changesets/cli 3.0.3"
collect3
expect_rc "3.x pub+priv: tags artifact validates" 0
expect_eq "3.x pub+priv: created tags" "$(tag_names)" "@fx/priv@1.0.0,@fx/pub@1.0.0"
expect_eq "3.x pub+priv: expected tags" "$(expected_names)" "@fx/priv@1.0.0,@fx/pub@1.0.0"
expect_eq "3.x pub+priv: tags exist locally at HEAD" "$(local_tags)" "@fx/priv@1.0.0,@fx/pub@1.0.0"
push_tags @fx/pub@1.0.0 @fx/priv@1.0.0
check 3 "$TAGS_FILE"
expect_rc "3.x pub+priv: end-state check passes" 0
# Re-run: the tags are now at HEAD, so nothing is created but all are expected.
collect3
expect_rc "3.x re-run: tags artifact validates" 0
expect_eq "3.x re-run: creates no tag" "$(tag_names)" ""
expect_eq "3.x re-run: expected tags unchanged" "$(expected_names)" "@fx/priv@1.0.0,@fx/pub@1.0.0"
check 3 "$TAGS_FILE"
expect_rc "3.x re-run: end-state check passes" 0

echo "-- 3.x: private only"
new_workspace 3 multi "$(config_json '[]' "$PRIV_ON")" @fx/priv 2.0.0 true
detect
expect_rc "3.x private-only: detector accepts" 0
collect3
expect_rc "3.x private-only: tags artifact validates" 0
expect_eq "3.x private-only: created tags" "$(tag_names)" "@fx/priv@2.0.0"
push_tags @fx/priv@2.0.0
check 3 "$TAGS_FILE"
expect_rc "3.x private-only: end-state check passes" 0

echo "-- 3.x: private package, tag disabled"
new_workspace 3 multi "$(config_json '[]' '{"version":true,"tag":false}')" \
  @fx/pub 1.0.0 false @fx/priv 1.0.0 true
detect
expect_rc "3.x tag:false: detector accepts an explicit setting" 0
collect3
expect_eq "3.x tag:false: only the public package is tagged" "$(tag_names)" "@fx/pub@1.0.0"
expect_eq "3.x tag:false: only the public package is expected" "$(expected_names)" "@fx/pub@1.0.0"

echo "-- 3.x: single-package repository"
new_workspace 3 single "$(config_json '[]' '')" solo 1.2.3 false
detect
expect_rc "3.x single: detector accepts" 0
collect3
expect_rc "3.x single: tags artifact validates" 0
expect_eq "3.x single: created tag is v<version>" "$(tag_names)" "v1.2.3"
expect_eq "3.x single: expected tag is v<version>" "$(expected_names)" "v1.2.3"
push_tags v1.2.3
check 3 "$TAGS_FILE"
expect_rc "3.x single: end-state check passes" 0

echo "-- 3.x: ignore with an exact name"
new_workspace 3 multi "$(config_json '["@fx/skip"]' "$PRIV_ON")" \
  @fx/keep 1.0.0 false @fx/skip 1.0.0 false
detect
expect_rc "3.x ignore exact: detector accepts" 0
collect3
expect_rc "3.x ignore exact: tags artifact validates" 0
expect_eq "3.x ignore exact: created tags" "$(tag_names)" "@fx/keep@1.0.0"
expect_eq "3.x ignore exact: expected tags" "$(expected_names)" "@fx/keep@1.0.0"
push_tags @fx/keep@1.0.0
check 3 "$TAGS_FILE"
expect_rc "3.x ignore exact: end-state check passes" 0

echo "-- 3.x: ignore with a scope glob"
new_workspace 3 multi "$(config_json '["@fx/*"]' "$PRIV_ON")" \
  @fx/one 1.0.0 false @fx/two 1.0.0 false plain 1.0.0 false
detect
expect_rc "3.x ignore glob: detector accepts" 0
collect3
expect_rc "3.x ignore glob: tags artifact validates" 0
expect_eq "3.x ignore glob: created tags" "$(tag_names)" "plain@1.0.0"
expect_eq "3.x ignore glob: expected tags" "$(expected_names)" "plain@1.0.0"

echo "-- 3.x: ignore with ! negation"
new_workspace 3 multi "$(config_json '["@fx/*","!@fx/one"]' "$PRIV_ON")" \
  @fx/one 1.0.0 false @fx/two 1.0.0 false plain 1.0.0 false
detect
expect_rc "3.x ignore negation: detector accepts" 0
collect3
expect_rc "3.x ignore negation: tags artifact validates" 0
expect_eq "3.x ignore negation: created tags" "$(tag_names)" "@fx/one@1.0.0,plain@1.0.0"
expect_eq "3.x ignore negation: expected tags" "$(expected_names)" "@fx/one@1.0.0,plain@1.0.0"

echo "-- 3.x: privatePackages absent with a private package"
new_workspace 3 multi "$(config_json '[]' '')" @fx/pub 1.0.0 false @fx/priv 1.0.0 true
detect
expect_rc "3.x absent privatePackages: detector fails" 1
expect_out "3.x absent privatePackages: message names the setting" '"privatePackages"'

echo "-- 3.x: privatePackages absent, no private package"
new_workspace 3 multi "$(config_json '[]' '')" @fx/pub 1.0.0 false
detect
expect_rc "3.x absent privatePackages, all public: detector accepts" 0

echo "-- 3.x: tag already on the remote at another commit"
new_workspace 3 multi "$(config_json '[]' "$PRIV_ON")" @fx/pub 1.0.0 false
git -C "$WS" tag -a "@fx/pub@1.0.0" -m old
git -C "$WS" push -q origin "refs/tags/@fx/pub@1.0.0"
git -C "$WS" tag -d "@fx/pub@1.0.0" >/dev/null
add_commit "second"
# The CLI sees the remote tag and creates nothing; the package keeps its earlier tag.
collect3
expect_rc "3.x earlier tag: tags artifact validates" 0
expect_eq "3.x earlier tag: the CLI creates no tag" "$(tag_names)" ""
expect_eq "3.x earlier tag: the tag is still expected" "$(expected_names)" "@fx/pub@1.0.0"
check 3 "$TAGS_FILE"
expect_rc "3.x earlier tag: end-state check passes (expected tags may sit at any commit)" 0
# A tag the run created, that appears on the remote at another commit before the
# check, is reported: created tags must point at the run's commit.
new_workspace 3 multi "$(config_json '[]' "$PRIV_ON")" @fx/pub 1.0.0 false
add_commit "second"
collect3
expect_eq "3.x conflict: the CLI creates the tag" "$(tag_names)" "@fx/pub@1.0.0"
git -C "$WS" push -q origin "$(git -C "$WS" rev-parse HEAD~1):refs/tags/@fx/pub@1.0.0"
check 3 "$TAGS_FILE"
expect_rc "3.x conflict: end-state check fails" 1
expect_out "3.x conflict: names the conflicting tag" "@fx/pub@1.0.0 (points at another commit)"
expect_eq "3.x conflict: the remote tag is untouched" "$(git --git-dir "$REMOTE" rev-parse '@fx/pub@1.0.0^{commit}')" "$(git -C "$WS" rev-parse HEAD~1)"

echo "-- 3.x: an artifact entry that disagrees with the checkout"
new_workspace 3 multi "$(config_json '[]' "$PRIV_ON")" @fx/pub 1.0.0 false
collect3
jq '.tags[0].tag = "@fx/pub@9.9.9"' "$TAGS_FILE" >"$TAGS_FILE.bad"
TAGS_FILE="$TAGS_FILE.bad" GITHUB_WORKSPACE="$WS" GITHUB_SHA="$(head_sha)" run "$WS" node "$VALIDATE"
expect_rc "3.x forged tag: validation fails closed" 1
expect_out "3.x forged tag: names the problem" "not the package.json name and version"

# =============================================================================
echo "== @changesets/cli 2.30.0 =="
# =============================================================================

# tag2: the real `changeset tag`, then the local-tag derivation of the check.
tag2() { run "$WS" pnpm exec changeset tag; }

echo "-- 2.x: public + private"
new_workspace 2 multi "$(config_json '[]' "$PRIV_ON")" \
  @fx/pub 1.0.0 false @fx/priv 1.0.0 true
detect
expect_rc "2.x pub+priv: detector accepts" 0
expect_out "2.x pub+priv: detector reports major 2" "@changesets/cli 2.30.0"
tag2
expect_rc "2.x pub+priv: changeset tag succeeds" 0
expect_eq "2.x pub+priv: tags at HEAD" "$(local_tags)" "@fx/priv@1.0.0,@fx/pub@1.0.0"
check 2
expect_rc "2.x pub+priv: end-state check fails before the push" 1
push_tags @fx/pub@1.0.0 @fx/priv@1.0.0
check 2
expect_rc "2.x pub+priv: end-state check passes after the push" 0

echo "-- 2.x: private only"
new_workspace 2 multi "$(config_json '[]' "$PRIV_ON")" @fx/priv 2.0.0 true
detect
expect_rc "2.x private-only: detector accepts" 0
tag2
expect_rc "2.x private-only: changeset tag succeeds" 0
expect_eq "2.x private-only: tags at HEAD" "$(local_tags)" "@fx/priv@2.0.0"
push_tags @fx/priv@2.0.0
check 2
expect_rc "2.x private-only: end-state check passes" 0

echo "-- 2.x: single-package repository"
new_workspace 2 single "$(config_json '[]' '')" solo 1.2.3 false
detect
expect_rc "2.x single: detector accepts" 0
tag2
expect_rc "2.x single: changeset tag succeeds" 0
expect_eq "2.x single: tag is v<version>" "$(local_tags)" "v1.2.3"
push_tags v1.2.3
check 2
expect_rc "2.x single: end-state check passes" 0

echo "-- 2.x: privatePackages absent with a private package"
new_workspace 2 multi "$(config_json '[]' '')" @fx/pub 1.0.0 false @fx/priv 1.0.0 true
detect
expect_rc "2.x absent privatePackages: detector accepts (2.x has no such requirement)" 0

echo "-- 2.x: tag already on the remote at another commit"
new_workspace 2 multi "$(config_json '[]' "$PRIV_ON")" @fx/pub 1.0.0 false
git -C "$WS" tag -a "@fx/pub@1.0.0" -m old
git -C "$WS" push -q origin "refs/tags/@fx/pub@1.0.0"
git -C "$WS" tag -d "@fx/pub@1.0.0" >/dev/null
add_commit "second"
tag2
expect_rc "2.x earlier tag: changeset tag succeeds" 0
expect_eq "2.x earlier tag: the CLI creates no tag" "$(local_tags)" ""
check 2
expect_rc "2.x earlier tag: end-state check passes (nothing created)" 0
# A tag the run created, that appears on the remote at another commit before the
# check, is reported.
new_workspace 2 multi "$(config_json '[]' "$PRIV_ON")" @fx/pub 1.0.0 false
add_commit "second"
tag2
expect_eq "2.x conflict: the CLI creates the tag" "$(local_tags)" "@fx/pub@1.0.0"
git -C "$WS" push -q origin "$(git -C "$WS" rev-parse HEAD~1):refs/tags/@fx/pub@1.0.0"
check 2
expect_rc "2.x conflict: end-state check fails" 1
expect_out "2.x conflict: names the conflicting tag" "@fx/pub@1.0.0 (points at another commit)"

echo
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
