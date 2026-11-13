#!/usr/bin/env bash
# Asserts the structure of the npm release workflow and its trigger, so CI
# fails when a change weakens the publish boundary (OIDC scope, approval
# environment, caller code in the publishing job, cache restores, unpinned
# actions). Text checks strip comment lines before matching; structural
# checks parse the workflow with the `yaml` devDependency.
#
# Usage: bash scripts/test-npm-release-workflow.sh [workflow-file] [trigger-file]
# Requires: bash, awk, grep, node, and the repo's devDependencies installed
# (`pnpm install`), for the `yaml` parser.
set -uo pipefail

# --- Expected shape. Change these in one place when jobs are added. ---
EXPECTED_JOBS="version build attest publish finalize snapshot"
# Jobs that may hold `id-token: write`, sorted, space separated.
EXPECTED_ID_TOKEN_JOBS="attest publish snapshot"
# Jobs that must run release-guard, and jobs that must not.
GUARDED_JOBS="version attest publish finalize"
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

# --- attest job: no caller code, no install, publish waits for it ---
ATT="$WORK/attest.yml"
job_block attest >"$ATT"
! grep -qE 'pnpm/action-setup|pnpm install|actions/setup-node' "$ATT"
check "attest does not set up pnpm or node, or install" $?
awk '
  function flush() { if (inco && !(own && dst)) bad=1; inco=0; own=0; dst=0 }
  /^      - /{ flush(); if ($0 ~ /actions\/checkout@/) inco=1 }
  inco && /job\.workflow_repository/ { own=1 }
  inco && /^[[:space:]]+path: \.pipelines$/ { dst=1 }
  END { flush(); exit bad }' "$ATT"
check "attest checks out only the workflow's own repository into .pipelines" $?
grep -qE '^[[:space:]]+subject-path: .*\.tgz$' "$ATT"
check "attest subject-path is the tarballs only" $?
grep -qE '^    needs: \[version, build\]$' "$ATT"
check "attest needs [version, build]" $?
grep -qE '^    needs: \[version, build, attest\]$' "$PUB"
check "publish needs [version, build, attest]" $?
grep -qE '^      attestations: read' "$PUB"
check "publish has attestations: read" $?

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

# --- Parsed checks (YAML parser, so quoting and layout cannot hide a change) ---
YAML_DIR="$REPO_ROOT/node_modules/yaml"
if [ ! -f "$YAML_DIR/package.json" ]; then
  fail "yaml parser available (run pnpm install)"
else
  node - "$YAML_DIR" "$REL" "$REPO_ROOT" >"$WORK/parsed.out" 2>&1 <<'NODE'
const [yamlDir, relPath, repoRoot] = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const YAML = require(yamlDir);
const out = [];
const check = (desc, ok, detail = '') =>
  out.push(`${ok ? 'PASS' : 'FAIL'}: ${desc}${ok || !detail ? '' : ` (${detail})`}`);
const wf = YAML.parse(fs.readFileSync(relPath, 'utf8'));
const jobs = wf.jobs ?? {};
const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const json = (v) => JSON.stringify(v ?? null);
const stepUses = (step) => (typeof step.uses === 'string' ? step.uses.split('@')[0] : undefined);

// Permissions: block mappings only, no write-all, id-token only where expected.
check('workflow-level permissions is an empty mapping', isMap(wf.permissions) && Object.keys(wf.permissions).length === 0);
const badPerm = Object.entries(jobs)
  .filter(([, j]) => !isMap(j.permissions))
  .map(([n]) => n);
check('every job permissions is a block mapping (no write-all / read-all string)', badPerm.length === 0, badPerm.join(' '));
const idTokenJobs = Object.entries(jobs)
  .filter(([, j]) => isMap(j.permissions) && 'id-token' in j.permissions)
  .map(([n]) => n)
  .sort()
  .join(' ');
check('id-token permission only in: attest publish snapshot', idTokenJobs === 'attest publish snapshot', idTokenJobs);
check('no job requests id-token other than write', Object.values(jobs).every((j) => !isMap(j.permissions) || !('id-token' in j.permissions) || j.permissions['id-token'] === 'write'));

// Exact job conditions and needs.
const expectedIf = {
  version: "inputs.snapshot_tag == ''",
  build: "inputs.snapshot_tag == '' && needs.version.outputs.has_changesets == 'false'",
  publish: "inputs.snapshot_tag == '' && needs.build.outputs.has_tarballs == 'true'",
  attest: "inputs.snapshot_tag == '' && needs.build.outputs.has_tarballs == 'true'",
  finalize:
    "always() && inputs.snapshot_tag == '' && needs.version.outputs.has_changesets == 'false' && needs.build.result == 'success' && ((needs.build.outputs.has_tarballs == 'true' && needs.attest.result == 'success' && needs.publish.result == 'success') || (needs.build.outputs.has_tarballs == 'false' && needs.attest.result == 'skipped' && needs.publish.result == 'skipped'))",
  snapshot: "inputs.snapshot_tag != ''"
};
for (const [name, want] of Object.entries(expectedIf)) {
  check(`${name} if: is exactly the expected condition`, norm(jobs[name]?.if) === want, norm(jobs[name]?.if));
}
const expectedNeeds = { version: [], build: ['version'], attest: ['version', 'build'], publish: ['version', 'build', 'attest'], finalize: ['version', 'build', 'attest', 'publish'], snapshot: [] };
for (const [name, want] of Object.entries(expectedNeeds)) {
  const have = [].concat(jobs[name]?.needs ?? []);
  check(`${name} needs: [${want.join(', ')}]`, json(have) === json(want), json(have));
}

// Nothing may continue past a failure.
const coe = [];
for (const [name, j] of Object.entries(jobs)) {
  if ('continue-on-error' in j) coe.push(name);
  for (const [i, step] of (j.steps ?? []).entries()) if ('continue-on-error' in step) coe.push(`${name}[${i}]`);
}
check('no continue-on-error on any job or step', coe.length === 0, coe.join(' '));

// Secrets: the app key and token minting are confined to version and finalize.
const keyJobs = Object.entries(jobs)
  .filter(([, j]) => /CHANGESET_RELEASE_BOT_APP_PRIVATE_KEY|create-github-app-token/.test(json(j)))
  .map(([n]) => n)
  .sort()
  .join(' ');
check('app private key and token minting only in: finalize version', keyJobs === 'finalize version', keyJobs);
const secretJobs = ['build', 'publish', 'snapshot'].filter((n) => /secrets\./.test(json(jobs[n])));
check('build, publish and snapshot reference no secrets.*', secretJobs.length === 0, secretJobs.join(' '));
check('no job-level or step-level env in build and publish', ['build', 'publish'].every((n) => !('env' in (jobs[n] ?? {})) && (jobs[n]?.steps ?? []).every((st) => !('env' in st))));

// Guard: first release-guard step precedes anything that mints a token or publishes.
for (const name of ['version', 'publish', 'finalize']) {
  const steps = jobs[name]?.steps ?? [];
  const g = steps.findIndex((st) => stepUses(st)?.endsWith('/release-guard'));
  const risky = steps.findIndex((st) =>
    ['actions/create-github-app-token', 'actions/download-artifact', './.pipelines/.github/actions/npm-publish-tarballs', 'changesets/action'].includes(stepUses(st))
  );
  check(`${name}: release-guard runs unconditionally before token, download and publish steps`, g >= 0 && !('if' in steps[g]) && (risky === -1 || g < risky), `guard at ${g}, first risky at ${risky}`);
}

// Publish: allowlist of steps, in order, with nothing else.
const pubSteps = jobs.publish?.steps ?? [];
const want = ['actions/setup-node', 'actions/checkout', './.pipelines/.github/actions/release-guard', 'actions/download-artifact', './.pipelines/.github/actions/npm-publish-tarballs'];
const have = pubSteps.map(stepUses);
check('publish steps are exactly the allowlist, in order', json(have) === json(want), json(have));
const stepKeys = pubSteps.flatMap((st, i) => Object.keys(st).filter((k) => !['uses', 'with', 'name', 'id'].includes(k)).map((k) => `step${i}.${k}`));
check('publish steps carry only uses/with/name/id (no run, if, env, shell)', stepKeys.length === 0, stepKeys.join(' '));
const jobKeys = Object.keys(jobs.publish ?? {}).filter((k) => !['needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'permissions', 'steps'].includes(k));
check('publish job carries only the expected keys', jobKeys.length === 0, jobKeys.join(' '));
check('publish environment is npm-publish', jobs.publish?.environment === 'npm-publish');
const dl = pubSteps.findIndex((st) => stepUses(st) === 'actions/download-artifact');
const pb = pubSteps.findIndex((st) => stepUses(st)?.endsWith('/npm-publish-tarballs'));
check('publish downloads before it publishes', dl >= 0 && pb > dl);
const sn = pubSteps[0]?.with ?? {};
check('publish setup-node: exact node-version, check-latest false, no cache keys', /^\d+\.\d+\.\d+$/.test(String(sn['node-version'])) && sn['check-latest'] === false && !('cache' in sn) && !('package-manager-cache' in sn));

// Attest: holds id-token, so it runs no caller code. Allowlist of steps, in order.
const attSteps = jobs.attest?.steps ?? [];
const attWant = ['actions/checkout', './.pipelines/.github/actions/release-guard', 'actions/download-artifact', 'actions/attest-build-provenance'];
const attHave = attSteps.map(stepUses);
check('attest steps are exactly the allowlist, in order', json(attHave) === json(attWant), json(attHave));
const attKeys = attSteps.flatMap((st, i) => Object.keys(st).filter((k) => !['uses', 'with', 'name', 'id'].includes(k)).map((k) => `step${i}.${k}`));
check('attest steps carry only uses/with/name/id (no run, if, env, shell, continue-on-error)', attKeys.length === 0, attKeys.join(' '));
check('attest release-guard step is unconditional and takes no inputs', attSteps[1] !== undefined && !('if' in attSteps[1]) && !('with' in attSteps[1]) && !('env' in attSteps[1]));
const attCheckout = attSteps[0]?.with ?? {};
check('attest checkout is the workflow\'s own repo and commit, sparse, into .pipelines', attCheckout.repository === '${{ job.workflow_repository }}' && attCheckout.ref === '${{ job.workflow_sha }}' && attCheckout.path === '.pipelines' && attCheckout['sparse-checkout'] === '.github/actions/release-guard');
check('attest downloads npm-tarballs into the tarball directory', attSteps[2]?.with?.name === 'npm-tarballs' && attSteps[2]?.with?.path === '${{ runner.temp }}/npm-tarballs');
check('attest subject-path is exactly the tarballs', attSteps[3]?.with?.['subject-path'] === '${{ runner.temp }}/npm-tarballs/*.tgz', String(attSteps[3]?.with?.['subject-path']));
const attJobKeys = Object.keys(jobs.attest ?? {}).filter((k) => !['needs', 'if', 'runs-on', 'timeout-minutes', 'permissions', 'steps'].includes(k));
check('attest job carries only the expected keys', attJobKeys.length === 0, attJobKeys.join(' '));
const verifyWith = pubSteps[pb]?.with ?? {};
check('publish verifies attestations: signer workflow from job.workflow_repository, digest from job.workflow_sha', verifyWith['signer-workflow'] === '${{ job.workflow_repository }}/.github/workflows/apps-npm-release.yml' && verifyWith['signer-digest'] === '${{ job.workflow_sha }}', json(verifyWith));

// No dependency cache anywhere (including setup-node's package-manager-cache).
const cacheHits = [];
for (const [name, j] of Object.entries(jobs)) {
  for (const [i, st] of (j.steps ?? []).entries()) {
    const w = st.with ?? {};
    if (stepUses(st) === 'actions/cache' || 'cache' in w || ('package-manager-cache' in w && w['package-manager-cache'] !== false)) cacheHits.push(`${name}[${i}]`);
  }
}
check('no cache restore: no actions/cache, cache:, or package-manager-cache other than false', cacheHits.length === 0, cacheHits.join(' '));

// Pack: the workflow checkout must be gone before `pnpm pack` runs.
const packAction = fs.readFileSync(path.join(repoRoot, '.github/actions/npm-pack/action.yml'), 'utf8');
const packRun = YAML.parse(packAction).runs.steps.map((st) => st.run ?? '').join('\n');
const rmAt = packRun.search(/rm -rf "\$GITHUB_WORKSPACE\/\.pipelines"/);
const nodeAt = packRun.search(/node "\$script_dir\/pack-packages\.mjs"/);
check('npm-pack removes the .pipelines checkout, then runs a copy of its script', rmAt >= 0 && nodeAt > rmAt && /cp "\$ACTION_PATH\/pack-packages\.mjs"/.test(packRun));
const buildSteps = jobs.build?.steps ?? [];
const pk = buildSteps.findIndex((st) => stepUses(st)?.endsWith('/npm-pack'));
check('build runs npm-pack after the install', pk > buildSteps.findIndex((st) => /pnpm install/.test(st.run ?? '')) && pk >= 0);

// Finalize: the cli check runs before changesets/action, on every run.
const fin = jobs.finalize?.steps ?? [];
const cli = fin.findIndex((st) => stepUses(st)?.endsWith('/check-changesets-cli'));
const act = fin.findIndex((st) => stepUses(st) === 'changesets/action');
check('finalize checks @changesets/cli before changesets/action, unconditionally', cli >= 0 && act > cli && !('if' in fin[cli]));
const art = Object.values(jobs.build?.steps ?? []).find((st) => stepUses(st) === 'actions/upload-artifact');
check('artifact retention is 7 days', art?.with?.['retention-days'] === 7, String(art?.with?.['retention-days']));
console.log(out.join('\n'));
NODE
  if [ $? -ne 0 ]; then
    fail "parsed checks ran: $(head -3 "$WORK/parsed.out" | tr '\n' ';')"
  else
    while IFS= read -r line; do
      case "$line" in PASS:*) pass "${line#PASS: }" ;; FAIL:*) fail "${line#FAIL: }" ;; esac
    done <"$WORK/parsed.out"
  fi
fi

# --- Mutants: each weakening of the workflow must make this test fail. ---
# Skipped inside a mutant run (MUTANT_RUN) so it does not recurse.
if [ -z "${MUTANT_RUN:-}" ] && [ -f "$YAML_DIR/package.json" ]; then
  mutate() { # mutate NAME JOB REGEX REPLACEMENT : rewrites one match inside one job
    node - "$REL" "$WORK/mutant.yml" "$2" "$3" "$4" <<'NODE'
const fs = require('node:fs');
const [src, dst, job, pattern, replacement] = process.argv.slice(2);
const text = fs.readFileSync(src, 'utf8');
const start = text.search(new RegExp(`^  ${job}:$`, 'm'));
if (start < 0) process.exit(2);
const rest = text.slice(start + 1);
const next = rest.search(/^  [a-z][a-z0-9_-]*:$/m);
const end = next < 0 ? text.length : start + 1 + next;
const block = text.slice(start, end);
const re = new RegExp(pattern);
if (!re.test(block)) process.exit(3);
fs.writeFileSync(dst, text.slice(0, start) + block.replace(re, replacement) + text.slice(end));
NODE
  }
  expect_mutant_fails() { # expect_mutant_fails NAME JOB REGEX REPLACEMENT
    if ! mutate "$@"; then fail "mutant applies: $1"; return; fi
    MUTANT_RUN=1 bash "$0" "$WORK/mutant.yml" "$TRIG" >/dev/null 2>&1
    [ $? -ne 0 ]
    check "mutant fails the test: $1" $?
  }
  expect_mutant_fails "finalize drops attest from needs" finalize 'needs: \[version, build, attest, publish\]' 'needs: [version, build, publish]'
  expect_mutant_fails "finalize accepts skipped publish with tarballs" finalize "needs\.build\.outputs\.has_tarballs == 'true'\s+&& needs\.attest\.result == 'success'\s+&& needs\.publish\.result == 'success'\)" "needs.publish.result == 'success')"
  expect_mutant_fails "finalize accepts a failed attest with tarballs" finalize "needs\.attest\.result == 'success'" "needs.attest.result != 'cancelled'"
  expect_mutant_fails "attest gains a run step" attest '      - uses: actions/attest-build-provenance' '      - run: echo hi
      - uses: actions/attest-build-provenance'
  expect_mutant_fails "attest installs with pnpm" attest '      - uses: actions/attest-build-provenance' '      - uses: pnpm/action-setup@41ff72655975bd51cab0327fa583b6e92b6d3061 # v4.2.0
      - uses: actions/attest-build-provenance'
  expect_mutant_fails "attest guard is conditional" attest '(      - uses: \./\.pipelines/\.github/actions/release-guard)' '$1
        if: false'
  expect_mutant_fails "attest step continues on error" attest '(uses: actions/attest-build-provenance@[^\n]*)' '$1
        continue-on-error: true'
  expect_mutant_fails "attest subject-path is widened" attest 'npm-tarballs/\*\.tgz' 'npm-tarballs/*'
  expect_mutant_fails "publish hard-codes the signer workflow" publish 'signer-workflow: [^\n]*' 'signer-workflow: 0xPolygon/pipelines/.github/workflows/apps-npm-release.yml'
  expect_mutant_fails "publish drops the signer digest" publish '\n          signer-digest: [^\n]*' ''
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
