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
check('id-token permission only in: publish snapshot', idTokenJobs === 'publish snapshot', idTokenJobs);
check('no job requests id-token other than write', Object.values(jobs).every((j) => !isMap(j.permissions) || !('id-token' in j.permissions) || j.permissions['id-token'] === 'write'));

// Exact job conditions and needs.
const expectedIf = {
  version: "inputs.snapshot_tag == ''",
  build: "inputs.snapshot_tag == '' && needs.version.outputs.has_changesets == 'false'",
  publish: "inputs.snapshot_tag == '' && needs.build.outputs.has_tarballs == 'true'",
  finalize:
    "always() && inputs.snapshot_tag == '' && needs.version.outputs.has_changesets == 'false' && needs.build.result == 'success' && (needs.publish.result == 'success' || (needs.publish.result == 'skipped' && needs.build.outputs.has_tarballs == 'false'))",
  snapshot: "inputs.snapshot_tag != ''"
};
for (const [name, want] of Object.entries(expectedIf)) {
  check(`${name} if: is exactly the expected condition`, norm(jobs[name]?.if) === want, norm(jobs[name]?.if));
}
const expectedNeeds = { version: [], build: ['version'], publish: ['version', 'build'], finalize: ['version', 'build', 'publish'], snapshot: [] };
for (const [name, want] of Object.entries(expectedNeeds)) {
  const have = [].concat(jobs[name]?.needs ?? []);
  check(`${name} needs: [${want.join(', ')}]`, json(have) === json(want), json(have));
}

// finalize (tag + GitHub Release) must be unreachable once publish failed,
// including a failed registry read-back. The only publish outcomes its
// condition may accept are success, or skipped when the build packed nothing.
const finalIf = norm(jobs.finalize?.if);
const publishTests = [...finalIf.matchAll(/needs\.publish\.result\s*(==|!=)\s*'([a-z]+)'/g)].map((m) => `${m[1]} ${m[2]}`).sort();
check('finalize if: tests publish only for == success and == skipped', json(publishTests) === json(['== skipped', '== success']), publishTests.join(', '));
check('finalize if: publish skipped is accepted only with has_tarballs == false', /needs\.publish\.result == 'skipped' && needs\.build\.outputs\.has_tarballs == 'false'/.test(finalIf));
check('publish timeout-minutes covers the registry read-back window (>= 20)', Number(jobs.publish?.['timeout-minutes']) >= 20, String(jobs.publish?.['timeout-minutes']));
check('finalize needs publish', [].concat(jobs.finalize?.needs ?? []).includes('publish'));

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
const jobKeys = Object.keys(jobs.publish ?? {}).filter((k) => !['needs', 'if', 'runs-on', 'timeout-minutes', 'environment', 'concurrency', 'permissions', 'steps'].includes(k));
check('publish job carries only the expected keys', jobKeys.length === 0, jobKeys.join(' '));
check('publish environment is npm-publish', jobs.publish?.environment === 'npm-publish');
const dl = pubSteps.findIndex((st) => stepUses(st) === 'actions/download-artifact');
const pb = pubSteps.findIndex((st) => stepUses(st)?.endsWith('/npm-publish-tarballs'));
check('publish downloads before it publishes', dl >= 0 && pb > dl);
const sn = pubSteps[0]?.with ?? {};
check('publish setup-node: exact node-version, check-latest false, no cache, package-manager-cache absent or false', /^\d+\.\d+\.\d+$/.test(String(sn['node-version'])) && sn['check-latest'] === false && !('cache' in sn) && (!('package-manager-cache' in sn) || sn['package-manager-cache'] === false));

// No dependency cache anywhere (including setup-node's package-manager-cache).
const cacheHits = [];
for (const [name, j] of Object.entries(jobs)) {
  for (const [i, st] of (j.steps ?? []).entries()) {
    const w = st.with ?? {};
    if (stepUses(st) === 'actions/cache' || 'cache' in w || ('package-manager-cache' in w && w['package-manager-cache'] !== false)) cacheHits.push(`${name}[${i}]`);
  }
}
check('no cache restore: no actions/cache, cache:, or package-manager-cache other than false', cacheHits.length === 0, cacheHits.join(' '));

// setup-node v5 and later caches on its own when package.json names a package
// manager, so every setup-node step needs either a pre-v5 pin or an explicit
// opt-out, and never a cache: input. The version is the trailing `# vX.Y.Z`
// comment of the `uses:` line, so this reads the raw text.
const rawLines = fs.readFileSync(relPath, 'utf8').split('\n');
const nodeSteps = Object.entries(jobs).flatMap(([name, j]) => (j.steps ?? []).filter((st) => stepUses(st) === 'actions/setup-node').map((st) => ({ name, st })));
const rawNodeLines = rawLines.filter((l) => /^\s*-?\s*uses:\s*actions\/setup-node@/.test(l));
check('every setup-node step is found in the raw text and the parsed jobs', nodeSteps.length > 0 && nodeSteps.length === rawNodeLines.length, `parsed ${nodeSteps.length}, raw ${rawNodeLines.length}`);
const nodeBad = rawNodeLines.flatMap((line, i) => {
  const major = Number((/#\s*v(\d+)\.\d+\.\d+\s*(?:#.*)?$/.exec(line) ?? [])[1]);
  const w = nodeSteps[i]?.st.with ?? {};
  const why = [];
  if (!Number.isInteger(major)) why.push('no version comment');
  if ('cache' in w) why.push('cache input');
  if (!(major < 5) && w['package-manager-cache'] !== false) why.push('v5+ without package-manager-cache: false');
  return why.length ? [`${nodeSteps[i]?.name}: ${why.join(', ')}`] : [];
});
check('every setup-node step has no cache: input and is pre-v5 or sets package-manager-cache: false', nodeBad.length === 0, nodeBad.join('; '));

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
// Ordered publishes: the lock is on the publish job only.
const conc = jobs.publish?.concurrency;
check('publish concurrency: group per repository and ref', conc?.group === 'npm-publish-${{ github.repository }}-${{ github.ref }}', json(conc));
check('publish concurrency: cancel-in-progress false and queue max', conc?.['cancel-in-progress'] === false && conc?.queue === 'max', json(conc));
const concElsewhere = ['version', 'build', 'finalize', 'snapshot'].filter((n) => 'concurrency' in (jobs[n] ?? {}));
check('no concurrency on version, build, finalize or snapshot', concElsewhere.length === 0, concElsewhere.join(' '));
check('no workflow-level concurrency', !('concurrency' in wf), json(wf.concurrency));

// Latest Release: recorded before changesets/action, corrected after it.
const isScript = (st, needle) => stepUses(st) === 'actions/github-script' && String(st.with?.script ?? '').includes(needle);
const rec = fin.findIndex((st) => isScript(st, 'recordLatest'));
const fix = fin.findIndex((st) => isScript(st, 'correctLatest'));
check('finalize records Latest before changesets/action', rec >= 0 && rec < act, `record at ${rec}, changesets/action at ${act}`);
check('finalize corrects Latest once, after changesets/action', fix > act && fin.filter((st) => isScript(st, 'correctLatest')).length === 1, `correct at ${fix}, changesets/action at ${act}`);
check('finalize passes the recorded Latest to the correction through env, not the script text', !/steps\./.test(String(fin[fix]?.with?.script ?? '')) && /previous-latest\.outputs\.previous-id/.test(fin[fix]?.env?.PREVIOUS_LATEST_ID ?? ''));
check('both Latest github-script steps retry transient API errors', fin[rec]?.with?.retries === 3 && fin[fix]?.with?.retries === 3, json([fin[rec]?.with?.retries, fin[fix]?.with?.retries]));
check('the Latest record step is unconditional', !('if' in fin[rec]));
check('the Latest correction runs only when changesets/action reports a new tag (published)', fin[fix]?.if === "steps.changesets.outputs.published == 'true'" && fin[act]?.id === 'changesets', json(fin[fix]?.if));
const tagCheck = fin.findIndex((st) => stepUses(st)?.endsWith('/check-release-tags'));
check('finalize checks release tags before the Latest correction', tagCheck > act && tagCheck < fix, `check-release-tags at ${tagCheck}, correction at ${fix}`);
// The checkout the correction loads its script from is unconditional (a
// release with nothing public skips publish, and the correction still runs)
// and must carry both actions' files.
const shared = fin.map((st, i) => ({ st, i })).filter(({ st, i }) => stepUses(st) === 'actions/checkout' && st.with?.path === '.pipelines' && i > act && i < fix).pop();
const sparse = String(shared?.st.with?.['sparse-checkout'] ?? '').split('\n').map((l) => l.trim());
check('finalize: the .pipelines checkout before the correction has no if and lists check-release-tags and correct-latest-release', shared !== undefined && !('if' in shared.st) && sparse.includes('.github/actions/check-release-tags') && sparse.includes('.github/actions/correct-latest-release'), json(shared?.st));
check('finalize permissions stay contents: write only', json(jobs.finalize?.permissions) === json({ contents: 'write' }), json(jobs.finalize?.permissions));

const art = Object.values(jobs.build?.steps ?? []).find((st) => stepUses(st) === 'actions/upload-artifact');
check('artifact retention is 7 days', art?.with?.['retention-days'] === 7, String(art?.with?.['retention-days']));
// Version hook: opt-in input, confined to the version job, after the guard,
// with the job's permissions unchanged and no id-token.
const vin = wf.on?.workflow_call?.inputs?.version_script;
check('version_script input exists, boolean, default false, not required', isMap(vin) && vin.type === 'boolean' && vin.default === false && vin.required === false, json(vin));
const hookJobs = Object.entries(jobs).filter(([, j]) => /ci:version|check-version-script/.test(json(j))).map(([n]) => n).join(' ');
check('ci:version and check-version-script appear only in the version job', hookJobs === 'version', hookJobs);
const vsteps = jobs.version?.steps ?? [];
const vguard = vsteps.findIndex((st) => stepUses(st)?.endsWith('/release-guard'));
const vcheck = vsteps.findIndex((st) => stepUses(st)?.endsWith('/check-version-script'));
const vact = vsteps.findIndex((st) => stepUses(st) === 'changesets/action');
check('version job: hook check comes after release-guard and before changesets/action', vguard >= 0 && vcheck > vguard && vact > vcheck, 'guard ' + vguard + ' check ' + vcheck + ' action ' + vact);
check('version job: hook check runs only when version_script is true', norm(vsteps[vcheck]?.if) === 'inputs.version_script' && vsteps[vcheck]?.with?.enabled === 'true', norm(vsteps[vcheck]?.if));
const vhook = norm(vsteps[vact]?.with?.version);
// The version job's steps are an allowlist, in order, so a step that reaches
// the hook script by any spelling (quoting, a variable, a script indirection)
// is a step that is not on the list. A `run` step is identified by its text.
const vsig = (st) => (typeof st.run === 'string' ? `run:${norm(st.run)}` : stepUses(st));
const vwant = [
  'actions/checkout',
  './.pipelines-guard/.github/actions/release-guard',
  'actions/checkout',
  'pnpm/action-setup',
  'actions/setup-node',
  'actions/checkout',
  './.pipelines/.github/actions/check-workspace-protocol',
  './.pipelines/.github/actions/check-version-script',
  'run:rm -rf .pipelines .pipelines-guard',
  'run:pnpm install --frozen-lockfile --ignore-scripts',
  'actions/create-github-app-token',
  'changesets/action'
];
const vhave = vsteps.map(vsig);
check('version steps are exactly the allowlist, in order', json(vhave) === json(vwant), json(vhave));
// The allowlist does not look at a step's shell, env or with values, or at
// job-level defaults, so the literal hook is also counted over the parsed
// jobs (comments and the input's description are not occurrences).
const hookCount = (json(jobs).match(/ci:version/g) ?? []).length;
check('ci:version appears exactly once in the jobs, as the conditional version input of the version job changesets step', hookCount === 1 && /ci:version/.test(String(vsteps[vact]?.with?.version)), 'occurrences ' + hookCount);
check('version job has no job-level defaults', !('defaults' in (jobs.version ?? {})), json(jobs.version?.defaults));
check('version job: changesets/action version is pnpm run ci:version only under version_script', vhook === "${{ inputs.version_script && 'pnpm run ci:version' || '' }}", vhook);
const vact_keys = Object.keys(vsteps[vact]?.with ?? {}).sort().join(' ');
check('version job: changesets/action inputs are only title commit commitMode version publish', vact_keys === 'commit commitMode publish title version', vact_keys);
check('version job: no id-token permission', isMap(jobs.version?.permissions) && !('id-token' in jobs.version.permissions));
check('version job: permissions are exactly contents: write and pull-requests: write', json(jobs.version?.permissions) === json({ contents: 'write', 'pull-requests': 'write' }), json(jobs.version?.permissions));
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

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
