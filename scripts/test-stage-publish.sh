#!/usr/bin/env bash
# test-stage-publish.sh
#
# Exercises the bundled npm-stage-publish script (the staged drop-in for
# `changeset publish`) against throwaway repos: a local bare repo stands in
# for origin and a mock `npm` records `npm stage publish` calls instead of
# reaching the registry. Rebuild the dist first
# (`pnpm run build:npm-stage-publish`) — this tests what consumers run.
#
# What this tests:
#   1. Single-package repo in pre mode: stages under the pre tag, emits v<version>
#   2. Re-run once the tag is on the remote: stages nothing, emits nothing
#   3. SNAPSHOT_TAG: stages under the snapshot tag, creates no git tag
#   4. Monorepo: stages only public unpublished packages; private and
#      already-live versions get a tag only; the root is never tagged; the
#      packed manifest has `workspace:` ranges rewritten
#   5. A failed stage emits no `New tag:` line and exits non-zero
#
# Usage: bash scripts/test-stage-publish.sh
# Requires: git, pnpm, node; network access to install @changesets/cli

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$REPO_ROOT/.github/actions/npm-stage-publish/dist/index.js"
ROOT=$(mktemp -d)
MOCK=$ROOT/bin; mkdir -p $MOCK
cat > $MOCK/npm <<'M'
#!/usr/bin/env bash
if [[ "$1" == view ]]; then
  # only "@acme/already@2.0.0" is "live"
  [[ "$2" == "@acme/already@2.0.0" ]] && { echo 2.0.0; exit 0; }
  exit 1
fi
if [[ "$1 $2" == "stage publish" ]]; then
  [[ "$3" == *fail* ]] && { echo "npm error E409 already staged" >&2; exit 1; }
  echo "$(basename "$3") tag=$5" >> "$NPM_LOG"; echo "+ staged (staged with id abc)"; exit 0
fi
echo "unexpected npm call: $*" >&2; exit 2
M
chmod +x $MOCK/npm
PASS=0; FAIL=0
check() { if eval "$2"; then echo "  PASS: $1"; PASS=$((PASS+1)); else echo "  FAIL: $1"; FAIL=$((FAIL+1)); fi; }

mkrepo() { # dir
  local d=$1; git init -q --bare $d/remote.git; git clone -q $d/remote.git $d/repo 2>/dev/null
  cd $d/repo; git config user.email t@t; git config user.name t; git config commit.gpgsign false; git config tag.gpgsign false
}
commit_push() { git add -A; git commit -qm "$1"; git push -q origin HEAD:main 2>/dev/null; }
changesets_cfg() { mkdir -p .changeset; echo '{"changelog":false,"commit":false,"baseBranch":"main","updateInternalDependencies":"patch","privatePackages":{"version":true,"tag":true},"ignore":[],"fixed":[],"linked":[],"access":"restricted"}' > .changeset/config.json; }
install_cli() { pnpm add -D -w @changesets/cli@2.31.1 --silent >/dev/null 2>&1 || pnpm add -D @changesets/cli@2.31.1 --silent >/dev/null 2>&1; }
runit() { NPM_LOG=$ROOT/npm.log PATH="$MOCK:$PATH" node "$DIST" > $ROOT/out.txt 2>$ROOT/err.txt; echo $? > $ROOT/rc; }
reset() { : > $ROOT/npm.log; }

echo "Test 1: single-package root repo in beta pre mode"
mkdir $ROOT/t1; mkrepo $ROOT/t1
echo '{"name":"@acme/sdk","version":"1.0.0-beta.32","publishConfig":{"access":"public"}}' > package.json
printf 'minimumReleaseAge: 0\n' > pnpm-workspace.yaml; changesets_cfg
echo '{"mode":"pre","tag":"beta","initialVersions":{"@acme/sdk":"1.0.0-beta.32"},"changesets":[]}' > .changeset/pre.json
install_cli; echo node_modules > .gitignore; commit_push init; git tag v1.0.0-beta.32; git push -q origin v1.0.0-beta.32
node -e 'const f="package.json",p=require("./"+f);p.version="1.0.0-beta.33";require("fs").writeFileSync(f,JSON.stringify(p))'; commit_push release
git tag -d v1.0.0-beta.32 >/dev/null  # mimic fetch-depth 1 checkout: no local tags
reset; runit
check "exit 0" '[[ $(cat $ROOT/rc) == 0 ]]'
check "staged under beta" 'grep -q "acme-sdk-1.0.0-beta.33.tgz tag=beta" $ROOT/npm.log'
check "exactly one stage" '[[ $(wc -l < $ROOT/npm.log) -eq 1 ]]'
check "New tag: v1.0.0-beta.33 printed once" '[[ $(grep -c "New tag: v1.0.0-beta.33" $ROOT/out.txt) -eq 1 ]]'
check "old version not re-tagged" '! grep -q "beta.32" $ROOT/out.txt'
check "local tag created for action to push" 'git rev-parse -q --verify refs/tags/v1.0.0-beta.33 >/dev/null'

echo "Test 2: re-run after tag reached remote is a no-op"
git push -q origin v1.0.0-beta.33; git tag -d v1.0.0-beta.33 >/dev/null; reset; runit
check "exit 0" '[[ $(cat $ROOT/rc) == 0 ]]'
check "nothing staged" '[[ ! -s $ROOT/npm.log ]]'
check "no New tag" '! grep -q "New tag" $ROOT/out.txt'

echo "Test 3: snapshot mode stages, never tags"
node -e 'const f="package.json",p=require("./"+f);p.version="1.0.0-dev.20261002.abc";require("fs").writeFileSync(f,JSON.stringify(p))'
reset; SNAPSHOT_TAG=dev runit
check "exit 0" '[[ $(cat $ROOT/rc) == 0 ]]'
check "staged under dev" 'grep -q "1.0.0-dev.20261002.abc.tgz tag=dev" $ROOT/npm.log'
check "no New tag" '! grep -q "New tag" $ROOT/out.txt'
check "no tag created" '[[ -z $(git tag -l "*dev*") ]]'
git checkout -q package.json

echo "Test 4: monorepo — public staged, private tagged only, live version tagged only, root skipped"
mkdir $ROOT/t4; mkrepo $ROOT/t4
echo '{"name":"root","version":"0.0.0","private":true}' > package.json
printf 'packages:\n  - "packages/*"\nminimumReleaseAge: 0\n' > pnpm-workspace.yaml; changesets_cfg
mkdir -p packages/lib packages/svc packages/already
echo '{"name":"@acme/lib","version":"1.1.0","dependencies":{"@acme/already":"workspace:*"}}' > packages/lib/package.json
echo '{"name":"@acme/svc","version":"3.0.0","private":true}' > packages/svc/package.json
echo '{"name":"@acme/already","version":"2.0.0"}' > packages/already/package.json
install_cli; pnpm install --silent >/dev/null 2>&1; echo node_modules > .gitignore; commit_push init
reset; runit
check "exit 0" '[[ $(cat $ROOT/rc) == 0 ]]'
check "only lib staged" '[[ $(cat $ROOT/npm.log) == "acme-lib-1.1.0.tgz tag=latest" ]]'
check "three New tag lines" '[[ $(grep -c "New tag:" $ROOT/out.txt) -eq 3 ]]'
check "lib tag" 'grep -q "New tag: @acme/lib@1.1.0" $ROOT/out.txt'
check "private svc tagged" 'grep -q "New tag: @acme/svc@3.0.0" $ROOT/out.txt'
check "root not tagged" '! grep -q "New tag: root" $ROOT/out.txt'
TGZ_DEP=$(cd $ROOT && mkdir -p x && cd x && pnpm --dir $ROOT/t4/repo/packages/lib pack --pack-destination $ROOT/x >/dev/null 2>&1; tar -xOzf $ROOT/x/*.tgz package/package.json)
check "workspace: range rewritten in packed manifest" 'echo "$TGZ_DEP" | grep -q "\"@acme/already\": \"2.0.0\""'

echo "Test 5: failed stage gets no New tag and exits non-zero"
mkdir $ROOT/t5; mkrepo $ROOT/t5
echo '{"name":"@acme/fail","version":"1.0.0"}' > package.json
printf 'minimumReleaseAge: 0\n' > pnpm-workspace.yaml; changesets_cfg; install_cli; echo node_modules > .gitignore; commit_push init
reset; runit
check "exit 1" '[[ $(cat $ROOT/rc) == 1 ]]'
check "no New tag" '! grep -q "New tag" $ROOT/out.txt'

echo; echo "Results: $PASS passed, $FAIL failed"; rm -rf $ROOT; [[ $FAIL -eq 0 ]]
