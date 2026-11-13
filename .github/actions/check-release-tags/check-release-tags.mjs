// Checks that each package in <directory>/manifest.json has a tag on the
// remote, using the GitHub REST API (git/ref/tags/<tag>).
//
// changesets names a tag `<name>@<version>` in a multi-package repo and
// `v<version>` in a single-package repo, so either form counts. A 404 means
// the tag is missing; any other API failure throws and is never read as
// "missing". Only reads, so a re-run after the tags exist succeeds.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function readManifest(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('manifest.json must be an array');
  for (const entry of manifest) {
    if (typeof entry?.name !== 'string' || typeof entry?.version !== 'string') {
      throw new Error(`manifest entry is missing "name" or "version": ${JSON.stringify(entry)}`);
    }
  }
  return manifest;
}

/** The tag forms changesets can create for a package. */
export function candidateTags({ name, version }) {
  return [`${name}@${version}`, `v${version}`];
}

/** True when the tag exists, false on 404; any other status throws. */
export async function tagExists({ apiUrl, repository, tag, token, fetchImpl = fetch }) {
  const url = `${apiUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`tag lookup for ${tag} failed with HTTP ${response.status}`);
}

/** Returns the `<name>@<version>` ids that have no tag in either form. */
export async function findMissing({ manifest, apiUrl, repository, token, fetchImpl }) {
  const missing = [];
  for (const entry of manifest) {
    let found = false;
    for (const tag of candidateTags(entry)) {
      if (await tagExists({ apiUrl, repository, tag, token, fetchImpl })) {
        found = true;
        break;
      }
    }
    if (!found) missing.push(`${entry.name}@${entry.version}`);
  }
  return missing;
}

export async function main({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const directory = env.TARBALL_DIRECTORY;
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  for (const [key, value] of [
    ['TARBALL_DIRECTORY', directory],
    ['GITHUB_REPOSITORY', repository],
    ['GITHUB_TOKEN', token]
  ]) {
    if (!value) {
      log(`::error::${key} is not set`);
      return 1;
    }
  }
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  try {
    const manifest = readManifest(directory);
    const missing = await findMissing({ manifest, apiUrl, repository, token, fetchImpl });
    if (missing.length > 0) {
      log(
        `::error title=Release tags missing::No git tag found for: ${missing.join(', ')}. ` +
          'The repo\'s @changesets/cli must print "New tag:" lines from `changeset tag` ' +
          '(2.x does; 3.x does not), or the tags must be created by hand.'
      );
      return 1;
    }
    log(`All ${manifest.length} published package(s) have a release tag`);
    return 0;
  } catch (err) {
    log(`::error::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
