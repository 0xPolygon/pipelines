// Checks that each package in <directory>/manifest.json has a tag on the
// remote, using the GitHub REST API (git/ref/tags/<tag>).
//
// changesets names a tag `<name>@<version>` in a multi-package repo and
// `v<version>` for the root package of a single-package repo. The `v` form is
// accepted only when the manifest has one entry and that entry is the root
// package. Each tag must also have a GitHub Release
// (releases/tags/<tag>). A 404 means missing; any other API failure throws and
// is never read as "missing". Only reads, so a re-run after the tags and
// Releases exist succeeds.

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

/** True when the manifest is one package and it is the repository's root package. */
export function isSinglePackageRepo({ manifest, workspace }) {
  if (manifest.length !== 1) return false;
  try {
    const rootJson = JSON.parse(readFileSync(resolve(workspace, 'package.json'), 'utf8'));
    return rootJson.name === manifest[0].name;
  } catch {
    return false;
  }
}

/** The tag forms changesets can create for a package. */
export function candidateTags({ name, version, singlePackage = false }) {
  return singlePackage ? [`${name}@${version}`, `v${version}`] : [`${name}@${version}`];
}

async function githubGet({ url, token, fetchImpl }) {
  return fetchImpl(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
}

/** True when a GitHub Release exists for the tag, false on 404; any other status throws. */
export async function releaseExists({ apiUrl, repository, tag, token, fetchImpl = fetch }) {
  const url = `${apiUrl}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`;
  const response = await githubGet({ url, token, fetchImpl });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`release lookup for ${tag} failed with HTTP ${response.status}`);
}

/** True when the tag exists, false on 404; any other status throws. */
export async function tagExists({ apiUrl, repository, tag, token, fetchImpl = fetch }) {
  const url = `${apiUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  const response = await githubGet({ url, token, fetchImpl });
  if (response.status === 200) return true;
  if (response.status === 404) return false;
  throw new Error(`tag lookup for ${tag} failed with HTTP ${response.status}`);
}

/**
 * Returns descriptions of what is missing: `<name>@<version>` ids with no tag
 * in an accepted form, and `<tag> (Release)` for a tag with no GitHub Release.
 */
export async function findMissing({
  manifest,
  apiUrl,
  repository,
  token,
  fetchImpl,
  singlePackage = false
}) {
  const missing = [];
  for (const entry of manifest) {
    let foundTag;
    for (const tag of candidateTags({ ...entry, singlePackage })) {
      if (await tagExists({ apiUrl, repository, tag, token, fetchImpl })) {
        foundTag = tag;
        break;
      }
    }
    if (foundTag === undefined) {
      missing.push(`${entry.name}@${entry.version}`);
    } else if (!(await releaseExists({ apiUrl, repository, tag: foundTag, token, fetchImpl }))) {
      missing.push(`${foundTag} (GitHub Release)`);
    }
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
    const singlePackage = isSinglePackageRepo({
      manifest,
      workspace: env.GITHUB_WORKSPACE || process.cwd()
    });
    const missing = await findMissing({
      manifest,
      apiUrl,
      repository,
      token,
      fetchImpl,
      singlePackage
    });
    if (missing.length > 0) {
      log(
        `::error title=Release tags missing::No git tag or GitHub Release found for: ${missing.join(', ')}. ` +
          'The repo\'s @changesets/cli must print "New tag:" lines from `changeset tag` ' +
          '(2.x does; 3.x does not), or the tags and Releases must be created by hand.'
      );
      return 1;
    }
    log(`All ${manifest.length} published package(s) have a release tag and a GitHub Release`);
    return 0;
  } catch (err) {
    log(`::error::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
