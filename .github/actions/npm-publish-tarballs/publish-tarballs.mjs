// Publishes the tarballs listed in <directory>/manifest.json.
//
// manifest.json is an array of { name, version, file, sha256, access, tag }.
// Every entry is verified (fields well-formed, file inside the directory,
// SHA-256 matches, the tarball's own name and version match the entry) and the
// npm client version is checked before the first publish, so a bad manifest
// publishes nothing. A version already on the registry is skipped when its
// integrity matches this run's tarball and fails when it does not. A package
// whose publish or registry lookup fails is recorded and the rest continue;
// the run then exits non-zero listing the failures.
//
// `npm publish` exiting 0 does not prove the version is installable: a
// publish can be held for approval, or the registry can lag. So after each
// publish the version document is read back from the public registry,
// unauthenticated, and must show the sha512 integrity of the tarball this run
// published. A version that never appears, or appears with different bytes,
// fails the step, which keeps the release's tag and GitHub Release from being
// created for a version consumers cannot install. Output showing a staged
// publish also fails: staged publishing is not supported.
//
// No token is read or passed on: npm authenticates with the runner's OIDC
// identity. Logs name packages and versions only and never print the
// environment.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// OIDC trusted publishing needs npm 11.5.1 or later.
export const MIN_NPM_VERSION = '11.5.1';

// Every registry call names the public registry explicitly: a CLI flag beats
// the `publishConfig.registry` stored inside a tarball.
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

const normaliseRegistry = (url) => String(url).trim().replace(/\/+$/, '').toLowerCase();

/** `publishConfig` keys (`registry`, `<scope>:registry`) naming a registry other than npmjs. */
export function foreignRegistryKeys(publishConfig) {
  if (publishConfig === null || typeof publishConfig !== 'object') return [];
  return Object.entries(publishConfig)
    .filter(
      ([key, value]) =>
        (key === 'registry' || key.endsWith(':registry')) &&
        normaliseRegistry(value) !== normaliseRegistry(NPM_REGISTRY)
    )
    .map(([key]) => key);
}

// Read-back schedule: npm validates a new version before listing it, which
// can take minutes. Wait 15 s first, then 30 s between attempts, until the
// total wait would pass the window. The publish job's timeout-minutes must
// stay comfortably above this window.
export const READ_BACK_WINDOW_MS = 10 * 60 * 1000;
export const READ_BACK_INITIAL_DELAY_MS = 15 * 1000;
export const READ_BACK_MAX_DELAY_MS = 30 * 1000;

// What npm prints for a staged publish: "+ <id> (staged)" or
// "+ <id> (staged with id <id>)", and "package <id> has been staged with tag
// <tag>" (npm/cli lib/commands/publish.js).
const STAGED_OUTPUT_PATTERN = /\(staged(?: with id [^)]*)?\)|has been staged with tag/;

export const isStagedOutput = (text) => STAGED_OUTPUT_PATTERN.test(String(text));

export const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

const NAME_PATTERN = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const TAG_PATTERN = /^[a-z][a-z0-9._-]*$/;

const ENTRY_FIELDS = ['name', 'version', 'file', 'sha256', 'access', 'tag'];

/** Runs a command and returns { status, stdout, stderr }. */
export function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : '')
  };
}

export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(text).trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

/** True when `version` is at or above `minimum`; false for an unparseable version. */
export function meetsMinimum(version, minimum) {
  const have = parseVersion(version);
  const need = parseVersion(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

export function checkNpmVersion({ run = defaultRun, minimum = MIN_NPM_VERSION } = {}) {
  const result = run('npm', ['--version']);
  const version = result.stdout.trim();
  if (result.status !== 0 || !meetsMinimum(version, minimum)) {
    throw new Error(
      `npm ${minimum} or later is required for trusted publishing; found ${version || 'no usable npm'}`
    );
  }
  return version;
}

export function readManifest(directory) {
  const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(manifest)) throw new Error('manifest.json must be an array');
  for (const entry of manifest) {
    for (const field of ENTRY_FIELDS) {
      if (typeof entry?.[field] !== 'string' || entry[field] === '') {
        throw new Error(`manifest entry is missing "${field}": ${JSON.stringify(entry)}`);
      }
    }
    // These values reach the npm command line, so each must have the shape
    // of what it names; this also keeps a value from reading as an option.
    const problems = [
      entry.access !== 'public' && 'access must be "public"',
      !TAG_PATTERN.test(entry.tag) && 'tag must match ^[a-z][a-z0-9._-]*$',
      !(NAME_PATTERN.test(entry.name) && entry.name.length <= 214) &&
        'name is not a valid npm package name',
      !VERSION_PATTERN.test(entry.version) && 'version is not a semver version',
      !/^[0-9a-f]{64}$/.test(entry.sha256) && 'sha256 must be 64 hex characters'
    ].filter(Boolean);
    if (problems.length > 0) {
      throw new Error(
        `manifest entry ${JSON.stringify(entry.name)} is invalid: ${problems.join('; ')}`
      );
    }
  }
  return manifest;
}

/** Returns the absolute tarball path, or throws when the entry fails a check. */
export function verifyEntry({ directory, entry, read = readFileSync }) {
  const root = resolve(directory);
  const path = resolve(root, entry.file);
  const rel = relative(root, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${entry.name}@${entry.version}: tarball path escapes the directory`);
  }
  let bytes;
  try {
    bytes = read(path);
  } catch {
    throw new Error(`${entry.name}@${entry.version}: tarball ${entry.file} is missing`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    throw new Error(
      `${entry.name}@${entry.version}: SHA-256 of ${entry.file} does not match the manifest`
    );
  }
  return path;
}

/** Reads `package/package.json` out of a tarball with the system `tar`. */
export function readTarballManifest({ path, run = defaultRun }) {
  const result = run('tar', ['-xzOf', path, 'package/package.json']);
  if (result.status !== 0) throw new Error('could not read package/package.json from the tarball');
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error('package/package.json in the tarball is not valid JSON');
  }
}

/** Throws unless the tarball's own name and version equal the manifest entry's. */
export function verifyTarballIdentity({ path, entry, run = defaultRun }) {
  const inner = readTarballManifest({ path, run });
  if (inner.name !== entry.name || inner.version !== entry.version) {
    throw new Error(
      `${entry.name}@${entry.version}: ${entry.file} holds ${inner.name}@${inner.version}, ` +
        'which does not match the manifest'
    );
  }
  // npm applies the tarball's own publishConfig registry settings (including a
  // scoped `<scope>:registry`, which beats `--registry`), so this job, which
  // does not trust the build job's output, checks the tarball itself.
  const keys = foreignRegistryKeys(inner.publishConfig);
  if (keys.length > 0) {
    throw new Error(
      `${entry.name}@${entry.version}: ${entry.file} sets publishConfig ${keys.join(', ')} to a ` +
        `registry other than ${NPM_REGISTRY}`
    );
  }
}

/**
 * True when name@version is on the registry, false when the registry answers
 * 404. Any other lookup failure throws, so it is never read as "not published".
 */
export function isPublished({ name, version, run = defaultRun }) {
  const result = run('npm', [
    'view',
    `${name}@${version}`,
    'version',
    '--json',
    '--registry',
    NPM_REGISTRY
  ]);
  if (result.status === 0) return result.stdout.trim() !== '';
  // npm reports a missing package as the error code E404, in its text output
  // and as `error.code` in --json output; a bare "404" in a version string or
  // URL is not that.
  if (/\bE404\b/.test(`${result.stderr}\n${result.stdout}`)) return false;
  throw new Error(`registry lookup failed with exit code ${result.status}`);
}

/** The registry's integrity string for tarball bytes: `sha512-<base64>`. */
export const sha512Integrity = (bytes) =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

/** URL of the public registry's version document; scoped names keep `%2F` encoded. */
export const versionDocumentUrl = ({ name, version }) =>
  `${NPM_REGISTRY}${encodeURIComponent(name)}/${encodeURIComponent(version)}`;

/**
 * Reads name@version back from the public registry (no credentials) until it
 * is visible, then compares its integrity with the tarball's. Throws when it
 * is not visible within the window or the integrity differs.
 */
export async function readBack({
  entry,
  integrity,
  fetchFn = fetch,
  sleep = defaultSleep,
  windowMs = READ_BACK_WINDOW_MS,
  initialDelayMs = READ_BACK_INITIAL_DELAY_MS,
  maxDelayMs = READ_BACK_MAX_DELAY_MS,
  log = console.log
}) {
  const id = `${entry.name}@${entry.version}`;
  const url = versionDocumentUrl(entry);
  let waited = 0;
  let delay = initialDelayMs;
  let last = 'no response';
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (response.status === 200) {
        const document = await response.json();
        const seen = document?.dist?.integrity;
        if (seen === integrity) return;
        throw new Error(
          `${id} is on the registry but its integrity (${seen ?? 'none'}) does not match ` +
            `the tarball this run built (${integrity}): the published bytes differ from this run's tarball`
        );
      }
      last = `registry answered ${response.status}`;
    } catch (err) {
      if (/is on the registry but its integrity/.test(err.message)) throw err;
      last = `registry lookup failed: ${err.message}`;
    }
    if (waited + delay > windowMs) break;
    log(
      `${id} not visible yet: attempt ${attempt}, ${Math.round(waited / 1000)}s elapsed, ${last}; ` +
        `retrying in ${delay / 1000}s`
    );
    await sleep(delay);
    waited += delay;
    delay = Math.min(delay * 2, maxDelayMs);
  }
  throw new Error(
    `${id} was not visible on the registry within ${Math.round(waited / 1000)}s of waiting ` +
      `(${last}); it may be held rather than published`
  );
}

/** Verifies and publishes every entry. Returns { published, skipped, failures }. */
export async function publishAll({
  directory,
  run = defaultRun,
  log = console.log,
  fetchFn,
  sleep,
  windowMs,
  initialDelayMs,
  maxDelayMs
}) {
  checkNpmVersion({ run });
  const manifest = readManifest(directory);

  const paths = manifest.map((entry) => verifyEntry({ directory, entry }));
  manifest.forEach((entry, index) => verifyTarballIdentity({ path: paths[index], entry, run }));

  const published = [];
  const skipped = [];
  const failures = [];
  for (const [index, entry] of manifest.entries()) {
    const id = `${entry.name}@${entry.version}`;
    try {
      if (isPublished({ name: entry.name, version: entry.version, run })) {
        // A re-run after a read-back timed out may find the publish landed
        // later: skip only when the registry holds this run's exact bytes.
        await readBack({
          entry,
          integrity: sha512Integrity(readFileSync(paths[index])),
          fetchFn,
          sleep,
          windowMs,
          initialDelayMs,
          maxDelayMs,
          log
        });
        log(`::notice::${id} is already on the registry with the same contents; skipping`);
        skipped.push(id);
        continue;
      }
      const result = run('npm', [
        'publish',
        paths[index],
        '--access',
        entry.access,
        '--tag',
        entry.tag,
        '--registry',
        NPM_REGISTRY,
        '--ignore-scripts'
      ]);
      // npm prints no credential; the output is what explains a held or
      // rejected publish.
      for (const text of [result.stdout, result.stderr]) {
        if (text.trim() !== '') log(text.trimEnd());
      }
      if (result.status !== 0) {
        throw new Error(`npm publish exited with code ${result.status}\n${result.stderr.trim()}`);
      }
      if (isStagedOutput(`${result.stdout}\n${result.stderr}`)) {
        throw new Error(
          'npm reports a staged publish; the shared workflow does not support staged publishing yet'
        );
      }
      await readBack({
        entry,
        integrity: sha512Integrity(readFileSync(paths[index])),
        fetchFn,
        sleep,
        windowMs,
        initialDelayMs,
        maxDelayMs,
        log
      });
      log(`Published ${id} with tag ${entry.tag}; read back from the registry`);
      published.push(id);
    } catch (err) {
      log(`::error::${id}: ${err.message}`);
      failures.push(id);
    }
  }
  return { published, skipped, failures };
}

export async function main({
  env = process.env,
  run = defaultRun,
  log = console.log,
  ...rest
} = {}) {
  const directory = env.TARBALL_DIRECTORY;
  if (!directory) {
    log('::error::TARBALL_DIRECTORY is not set');
    return 1;
  }
  let result;
  try {
    result = await publishAll({ directory, run, log, ...rest });
  } catch (err) {
    log(`::error::${err.message}`);
    return 1;
  }
  if (result.failures.length > 0) {
    log(`::error::Failed to publish: ${result.failures.join(', ')}`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
