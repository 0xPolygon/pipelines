// Checks the end state of a release run with the GitHub REST API: everything
// the run had to tag has a tag on the remote, and a Release where one is due.
// "Had something to tag" is the union of the publish manifest (when a
// directory with a manifest.json is given) and the tags the run created: on
// @changesets/cli 2.x the tags pointing at the local clone's HEAD, on 3.x the
// `tags` and `expected` lists of the validated tags artifact (the 3.x tagging
// runs in an earlier job, so the finalize clone has no local tags). A created
// tag must point at the run's commit on the remote. A run with nothing to tag
// passes, whether or not anything was published.
//
// changesets names a tag `<name>@<version>` in a multi-package repo and
// `v<version>` for the root package of a single-package repo. The `v` form is
// accepted only when the manifest has one entry and that entry is the root
// package. Each tag must also have a GitHub Release
// (releases/tags/<tag>) when changelogs are enabled and the package has a
// CHANGELOG.md, because changesets/action creates a Release from the
// changelog section and creates none otherwise. A 404 means missing; any other API failure throws and
// is never read as "missing". Only reads, so a re-run after the tags and
// Releases exist succeeds.
//
// On @changesets/cli 3.x the `expected` list is the tags the repository's
// current package versions should have, written by the tagging job from the
// repository's config (see collect-tags.mjs), so a CLI that tagged nothing
// cannot pass as "nothing to tag". The file is read as data and its shape is
// checked again here; the finalize job has already validated it against the
// checkout. Each expected tag must exist on the remote, at any commit: a
// package released in an earlier run keeps its earlier tag. The 2.x arm is
// unchanged.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, isAbsolute, sep } from 'node:path';
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

/** False when `.changeset/config.json` sets `"changelog": false`; true otherwise. */
export function changelogsEnabled(workspace) {
  try {
    const config = JSON.parse(
      readFileSync(resolve(workspace, '.changeset', 'config.json'), 'utf8')
    );
    return config.changelog !== false;
  } catch {
    return true;
  }
}

/**
 * True when changesets/action would create a GitHub Release for the package:
 * changelogs are enabled and CHANGELOG.md exists in the package directory
 * (`entry.directory`, relative to the workspace, as written by the pack
 * action). A directory outside the workspace counts as "no changelog".
 */
export function expectsRelease({ entry, workspace, enabled }) {
  if (!enabled || typeof entry.directory !== 'string') return false;
  const root = resolve(workspace);
  const dir = resolve(root, entry.directory);
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
  return existsSync(resolve(dir, 'CHANGELOG.md'));
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
  singlePackage = false,
  requiresRelease = () => true
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
    } else if (
      requiresRelease(entry) &&
      !(await releaseExists({ apiUrl, repository, tag: foundTag, token, fetchImpl }))
    ) {
      missing.push(`${foundTag} (GitHub Release)`);
    }
  }
  return missing;
}

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const TAG_KEYS = ['commit', 'directory', 'packageName', 'tag'];
const EXPECTED_KEYS = ['directory', 'packageName', 'tag'];
const MAX_ENTRIES = 5000;

function readEntries({ list, keys, name }) {
  if (!Array.isArray(list) || list.length > MAX_ENTRIES) {
    throw new Error(`The tags file has no valid "${name}" list.`);
  }
  const seen = new Set();
  for (const entry of list) {
    const entryKeys =
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.keys(entry).sort()
        : [];
    const valid =
      entryKeys.join() === keys.join() &&
      keys.every((key) => typeof entry[key] === 'string') &&
      entry.packageName.length <= 214 &&
      NPM_NAME.test(entry.packageName) &&
      (!('commit' in entry) || /^[0-9a-f]{40}$/.test(entry.commit)) &&
      /^(?:@[^@\s]+\/)?[^@\s]+@[^@\s]+$|^v[^@\s]+$/.test(entry.tag) &&
      entry.directory !== '' &&
      !seen.has(entry.tag);
    if (!valid) {
      throw new Error(`The tags file has a malformed ${name} entry: ${JSON.stringify(entry)}`);
    }
    seen.add(entry.tag);
  }
  return list;
}

/**
 * Reads the tags file written by the tagging job (and validated against the
 * checkout by the finalize job) and checks the shape of every entry: exactly
 * `tag`, `packageName`, `directory` (and `commit` for created tags), an npm
 * package name and no duplicate tag in a list. Throws on anything else,
 * including a missing file or list.
 */
export function readReleaseArtifact(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolve(file), 'utf8'));
  } catch (err) {
    throw new Error(`Could not read the tags file: ${err.message}`);
  }
  return {
    tags: readEntries({ list: parsed?.tags, keys: TAG_KEYS, name: 'tags' }),
    expected: readEntries({ list: parsed?.expected, keys: EXPECTED_KEYS, name: 'expected' })
  };
}

/** Expected tags with no tag on the remote (at any commit). */
export async function findMissingExpected({ expected, apiUrl, repository, token, fetchImpl }) {
  const missing = [];
  for (const { tag } of expected) {
    if (!(await tagExists({ apiUrl, repository, tag, token, fetchImpl }))) missing.push(tag);
  }
  return missing;
}

function defaultRun(command, args, { cwd } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', cwd, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

/**
 * The tags pointing at the clone's HEAD and the HEAD commit. Empty when the
 * workspace has no git commit to inspect.
 */
export function localTagsAtHead({ workspace, run = defaultRun }) {
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: workspace });
  if (head.status !== 0) return { head: undefined, tags: [] };
  const listed = run('git', ['tag', '--points-at', 'HEAD'], { cwd: workspace });
  if (listed.status !== 0) throw new Error('Could not list the tags at HEAD.');
  return {
    head: head.stdout.trim(),
    tags: listed.stdout.split('\n').filter((line) => line !== '')
  };
}

/** Workspace packages as `{ name, version, directory }`, directory relative to the workspace. */
export function workspacePackages({ workspace, run = defaultRun }) {
  const result = run('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { cwd: workspace });
  if (result.status !== 0) throw new Error('Could not list the workspace packages with pnpm.');
  const root = resolve(workspace);
  return JSON.parse(result.stdout)
    .filter(
      (p) =>
        typeof p?.name === 'string' && typeof p?.version === 'string' && typeof p?.path === 'string'
    )
    .map((p) => ({
      name: p.name,
      version: p.version,
      directory: relative(root, resolve(p.path)) || '.'
    }));
}

/**
 * Maps a tag to the workspace package it names: `<name>@<version>`, or
 * `v<version>` for the root package. Undefined for any other tag.
 */
export function packageForTag({ tag, packages }) {
  return packages.find(
    (p) => tag === `${p.name}@${p.version}` || (p.directory === '.' && tag === `v${p.version}`)
  );
}

/** The commit a remote tag points at (annotated tags dereferenced), or undefined on 404. */
export async function remoteTagCommit({ apiUrl, repository, tag, token, fetchImpl = fetch }) {
  let url = `${apiUrl}/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`;
  for (let depth = 0; depth < 5; depth += 1) {
    const response = await githubGet({ url, token, fetchImpl });
    if (response.status === 404) return undefined;
    if (response.status !== 200) {
      throw new Error(`tag lookup for ${tag} failed with HTTP ${response.status}`);
    }
    const { object } = await response.json();
    if (object?.type !== 'tag') return object?.sha;
    url = `${apiUrl}/repos/${repository}/git/tags/${object.sha}`;
  }
  throw new Error(`tag ${tag} is nested too deeply to resolve to a commit`);
}

/**
 * Returns descriptions of what is missing for the tags in the local clone:
 * the tag, `<tag> (points at another commit)`, or `<tag> (GitHub Release)`.
 */
export async function findMissingLocal({
  tags,
  head,
  apiUrl,
  repository,
  token,
  fetchImpl,
  requiresRelease = () => true
}) {
  const missing = [];
  for (const { tag, entry } of tags) {
    const commit = await remoteTagCommit({ apiUrl, repository, tag, token, fetchImpl });
    if (commit === undefined) {
      missing.push(tag);
    } else if (commit !== head) {
      missing.push(`${tag} (points at another commit)`);
    } else if (
      requiresRelease(entry) &&
      !(await releaseExists({ apiUrl, repository, tag, token, fetchImpl }))
    ) {
      missing.push(`${tag} (GitHub Release)`);
    }
  }
  return missing;
}

export async function main({
  env = process.env,
  fetchImpl = fetch,
  log = console.log,
  run = defaultRun
} = {}) {
  const directory = env.TARBALL_DIRECTORY;
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GITHUB_TOKEN;
  for (const [key, value] of [
    ['GITHUB_REPOSITORY', repository],
    ['GITHUB_TOKEN', token]
  ]) {
    if (!value) {
      log(`::error::${key} is not set`);
      return 1;
    }
  }
  const apiUrl = env.GITHUB_API_URL || 'https://api.github.com';
  const major = env.CLI_MAJOR ?? '';
  if (!['', '2', '3'].includes(major)) {
    log(`::error::CLI_MAJOR must be empty, 2 or 3, got "${major}"`);
    return 1;
  }
  try {
    const artifact = major === '3' ? readReleaseArtifact(env.TAGS_FILE ?? '') : undefined;
    const expected = artifact?.expected ?? [];
    const workspace = env.GITHUB_WORKSPACE || process.cwd();
    const manifest =
      directory && existsSync(resolve(directory, 'manifest.json')) ? readManifest(directory) : [];
    let head;
    let tags;
    if (artifact === undefined) {
      const local = localTagsAtHead({ workspace, run });
      head = local.head;
      const packages = local.tags.length > 0 ? workspacePackages({ workspace, run }) : [];
      // A tag at HEAD that names no workspace package is not ours to check.
      tags = local.tags.flatMap((tag) => {
        const pkg = packageForTag({ tag, packages });
        return pkg === undefined
          ? []
          : [{ tag, entry: { name: pkg.name, directory: pkg.directory } }];
      });
    } else {
      // The tagging job ran in another clone, so the run's commit comes from
      // the environment and no repository code (pnpm) runs here.
      head = env.GITHUB_SHA;
      if (!head) throw new Error('GITHUB_SHA is not set');
      tags = artifact.tags.map(({ tag, packageName, directory }) => ({
        tag,
        entry: { name: packageName, directory }
      }));
    }
    if (manifest.length === 0 && tags.length === 0 && expected.length === 0) {
      log('Nothing to tag: no published packages and no tags created by this run');
      return 0;
    }
    const enabled = changelogsEnabled(workspace);
    const requiresRelease = (entry) => expectsRelease({ entry, workspace, enabled });
    const missing = new Set(
      await findMissing({
        requiresRelease,
        manifest,
        apiUrl,
        repository,
        token,
        fetchImpl,
        singlePackage: isSinglePackageRepo({ manifest, workspace })
      })
    );
    for (const item of await findMissingLocal({
      tags,
      head,
      apiUrl,
      repository,
      token,
      fetchImpl,
      requiresRelease
    })) {
      missing.add(item);
    }
    for (const tag of await findMissingExpected({
      expected,
      apiUrl,
      repository,
      token,
      fetchImpl
    })) {
      missing.add(tag);
    }
    if (missing.size > 0) {
      log(
        `::error title=Release tags missing::No git tag or GitHub Release found for: ${[...missing].join(', ')}. ` +
          "Every package published or tagged by this run needs a tag at the run's commit and, where a " +
          'changelog exists, a GitHub Release; on @changesets/cli 3.x every package that should be tagged needs its tag. Re-running the job is safe: it only reads. ' +
          'A tag marked "points at another commit" already exists at a different commit: check whether that version ' +
          'was released from another commit, and if the existing tag is wrong, delete it in the repository and re-run the failed job. ' +
          'The workflow never moves or deletes a tag itself.'
      );
      return 1;
    }
    log(
      `All ${manifest.length} published package(s), ${tags.length} created tag(s) and ${expected.length} expected tag(s) have a release tag (and a GitHub Release where a changelog exists)`
    );
    return 0;
  } catch (err) {
    log(`::error::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
