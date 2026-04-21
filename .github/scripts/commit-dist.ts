import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env['GITHUB_TOKEN'] });
const [owner, repo] = (process.env['GITHUB_REPOSITORY'] ?? '').split('/');
const path = process.env['DIST_PATH']!;

// Check whether the build produced any changes to this dist file.
// git diff (no args) shows unstaged changes — exactly what we want after a build.
const changed = execSync(`git diff --name-only -- ${path}`, { encoding: 'utf8' }).trim();

if (!changed) {
  console.log(`No changes to ${path} — nothing to commit`);
  process.exit(0);
}

console.log(`${path} changed — creating signed commit via GitHub API`);

const content = Buffer.from(readFileSync(path)).toString('base64');

// Fetch the current blob SHA — required by createOrUpdateFileContents for updates.
const { data: existing } = await octokit.rest.repos.getContent({ owner, repo, path });

if (Array.isArray(existing) || existing.type !== 'file') {
  throw new Error(
    `Expected a file at ${path}, got ${Array.isArray(existing) ? 'directory' : existing.type}`
  );
}

await octokit.rest.repos.createOrUpdateFileContents({
  owner,
  repo,
  path,
  message: `chore: rebuild ${path}`,
  content,
  sha: existing.sha,
  committer: {
    name: 'github-actions[bot]',
    email: 'github-actions[bot]@users.noreply.github.com'
  }
});

console.log('Signed commit created');
