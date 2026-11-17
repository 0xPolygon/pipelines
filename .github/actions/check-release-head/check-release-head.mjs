// Reports whether this run should leave the release PR alone because a newer
// push has replaced it.
//
// Every push to the default branch starts a release run, and each run works
// from the commit that started it. When a second push lands while a run is
// still going, the older run would rebuild the release PR from its out-of-date
// checkout. If that second push was the release PR being merged, the older run
// finds no open release PR and opens a duplicate of the one just merged.
//
// A superseded run is only told to stand down when it has changesets pending,
// because that is the only case where it would write the release PR. With no
// changesets pending the run is the one that publishes its commit, and it must
// carry on even if a later push has landed, or that version would never be
// published. In pre mode the changeset files stay in place after versioning,
// so their presence says nothing about which path the run takes: the check is
// not applied and the run carries on as before.

import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Workflow commands are line-based and use % escapes; text echoed into
// `::error::` must not be able to start a new command.
const escapeCommandData = (text) =>
  String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// The same file filter changesets uses to find changesets.
export function hasPendingChangesets(cwd) {
  const dir = resolve(cwd, '.changeset');
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some(
    (file) => !file.startsWith('.') && file.endsWith('.md') && !/^README\.md$/i.test(file)
  );
}

// The git refs endpoint, not the commits one: it reads the ref itself, so it
// reflects a push as soon as the push is accepted.
export async function readBranchHead({ apiUrl, repository, branch, token, fetchImpl = fetch }) {
  const path = branch.split('/').map(encodeURIComponent).join('/');
  const response = await fetchImpl(`${apiUrl}/repos/${repository}/git/ref/heads/${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const sha = (await response.json())?.object?.sha;
  if (typeof sha !== 'string' || sha === '') throw new Error('the response has no commit SHA');
  return sha;
}

export async function main({
  env = process.env,
  cwd = process.cwd(),
  fetchImpl = fetch,
  log = console.log,
  setOutput = (name, value) => appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
} = {}) {
  if (!hasPendingChangesets(cwd)) {
    log('No changesets pending: this run publishes its own commit, so it is never skipped.');
    setOutput('superseded', 'false');
    return 0;
  }
  if (existsSync(resolve(cwd, '.changeset/pre.json'))) {
    log('Pre mode: the superseded-run check is not applied.');
    setOutput('superseded', 'false');
    return 0;
  }

  const ref = env.REF ?? '';
  const sha = env.SHA ?? '';
  if (!ref.startsWith('refs/heads/') || sha === '') {
    log(
      `::error::Cannot tell which branch and commit this run is for (ref '${ref}', sha '${sha}').`
    );
    return 1;
  }
  const branch = ref.slice('refs/heads/'.length);

  let head;
  try {
    head = await readBranchHead({
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      repository: env.REPOSITORY ?? '',
      branch,
      token: env.GITHUB_TOKEN ?? '',
      fetchImpl
    });
  } catch (err) {
    // Fails rather than guessing: carrying on could open a duplicate release
    // PR, and the job is safe to re-run.
    log(
      `::error::Could not read the head of ${escapeCommandData(branch)}: ` +
        `${escapeCommandData(err instanceof Error ? err.message : err)}. Re-run the job.`
    );
    return 1;
  }

  if (head === sha) {
    log(`This run's commit ${sha} is the head of ${branch}.`);
    setOutput('superseded', 'false');
    return 0;
  }
  log(
    `::notice::Release PR left untouched: ${escapeCommandData(branch)} has moved from this ` +
      `run's commit ${sha} to ${head}. The run for the newer commit updates the release PR.`
  );
  setOutput('superseded', 'true');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
