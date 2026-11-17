// Publishes the tarballs listed in <directory>/manifest.json.
//
// manifest.json is an array of { name, version, file, sha256, access, tag },
// each optionally with `preTag` (the pre-mode tag).
// Every entry is verified (fields well-formed, file inside the directory,
// SHA-256 matches, the tarball's own name and version match the entry) and the
// npm client version is checked before the first publish, so a bad manifest
// publishes nothing. A version already on the registry is skipped when its
// integrity matches this run's tarball and fails when it does not. A package
// whose publish or registry lookup fails is recorded and the rest continue;
// the run then exits non-zero listing the failures.
//
// `npm publish` exiting 0 does not prove the version is installable: a
// publish can be held for approval, or the registry can lag. So once every
// package is published, each version document is read back from the public
// registry, unauthenticated, against one shared deadline, and must show the
// sha512 integrity of the tarball this run published. A version that never
// appears, or appears with different bytes, fails the step, which keeps the
// release's tag and GitHub Release from being created for a version consumers
// cannot install. Output showing a staged publish also fails: staged
// publishing is not supported.
//
// Each publish picks its dist-tag at publish time from the registry's current
// `latest` (resolvePublishTag), so releases approved out of order never move
// `latest` backwards in the normal case: a stable version above `latest` takes
// `latest`, an older or equal stable takes `previous`, and a prerelease never
// takes `latest`. The registry's package document can lag a fresh publish, so
// a publish that starts right after another may still read a stale `latest`
// and choose wrongly; that is a narrow window, not a guarantee. The read is
// tried three times; a registry answer that still cannot be read fails that
// package closed, before `npm publish`.
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
// can take minutes. Wait 15 s first, then 30 s between rounds, until the
// elapsed time would pass the window (shared by all packages). The publish
// job's timeout-minutes must stay comfortably above this window.
export const READ_BACK_WINDOW_MS = 10 * 60 * 1000;
export const READ_BACK_INITIAL_DELAY_MS = 15 * 1000;
export const READ_BACK_MAX_DELAY_MS = 30 * 1000;
// Per-request cap so a stalled connection counts as "not visible yet" instead
// of eating the window.
export const READ_BACK_REQUEST_TIMEOUT_MS = 30 * 1000;

// npm refuses to publish a version the registry already holds, in the client
// (lib/commands/publish.js) and, with the same text, from the registry.
const ALREADY_PUBLISHED_PATTERN = /cannot publish over the previously published versions/i;

// What npm prints for a staged publish: "+ <id> (staged)" or
// "+ <id> (staged with id <id>)", and "package <id> has been staged with tag
// <tag>" (npm/cli lib/commands/publish.js).
const STAGED_OUTPUT_PATTERN = /\(staged(?: with id [^)]*)?\)|has been staged with tag/;

export const isStagedOutput = (text) => STAGED_OUTPUT_PATTERN.test(String(text));

export const defaultSleep = (ms) => new Promise((done) => setTimeout(done, ms));

const NAME_PATTERN = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
// No build metadata (`+...`): npm drops it on publish, so the read-back would
// look for a version the registry never lists.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
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
      entry.preTag !== undefined &&
        !(typeof entry.preTag === 'string' && TAG_PATTERN.test(entry.preTag)) &&
        'preTag must match ^[a-z][a-z0-9._-]*$',
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

// The one fixed dist-tag for a stable version older than the registry's
// `latest`. It does not collide with the tags changesets, snapshots or
// canaries use (`next`, `pre`, `canary`, `snapshot` names).
export const PREVIOUS_TAG = 'previous';

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Splits a semver 2.0 version into numbers and prerelease identifiers; null when malformed. */
export function parseSemver(text) {
  const match = SEMVER_PATTERN.exec(String(text).trim());
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]].map(Number),
    pre: match[4] === undefined ? [] : match[4].split('.')
  };
}

/** Semver 2.0 precedence: negative when a < b, 0 when equal (build metadata ignored), positive when a > b. */
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) throw new Error(`cannot compare "${a}" and "${b}" as semver versions`);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  // A version without a prerelease outranks the same core with one.
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    // A shorter identifier list is lower when everything before it is equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The dist-tag to publish `version` under, decided from the registry's
 * current `latest` (null when the package has none or was never published).
 * `recordedTag` is what npm-pack recorded.
 *
 * - A tag other than `latest` is kept: it is either an explicit override or
 *   changesets' pre tag, and neither is ours to change.
 * - A prerelease never gets `latest`, with or without a registry `latest`:
 *   it uses the recorded tag when that is not `latest`, else `preTag` (the
 *   pre-mode tag npm-pack recorded; a package with only prereleases so far is
 *   recorded for `latest`). With neither, it fails closed.
 * - A stable version above `latest`, or with no `latest` or a prerelease
 *   `latest` to compare with, takes `latest`; an older or equal one takes `previous`.
 *
 * Throws when a version cannot be parsed, so the caller fails closed.
 */
export function resolvePublishTag({ version, recordedTag, preTag, latest }) {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`"${version}" is not a semver version`);
  const latestParsed = latest === null || latest === undefined ? null : parseSemver(latest);
  if (latest !== null && latest !== undefined && latestParsed === null) {
    throw new Error(`registry latest "${latest}" is not a semver version`);
  }
  if (parsed.pre.length > 0) {
    const tag = recordedTag !== 'latest' ? recordedTag : preTag;
    if (tag === undefined || tag === 'latest') {
      throw new Error(
        `prerelease ${version} has no tag other than "latest" to publish under; ` +
          'a prerelease never takes "latest" (the manifest has no pre-mode tag for it)'
      );
    }
    return tag;
  }
  if (recordedTag !== 'latest') return recordedTag;
  // A prerelease should never hold `latest`, so a stable version replaces one
  // even when it is semver-lower.
  if (latestParsed === null || latestParsed.pre.length > 0) return 'latest';
  return compareSemver(version, latest) > 0 ? 'latest' : PREVIOUS_TAG;
}

// Waits before the second and third attempt to read a package's `latest`.
export const FETCH_LATEST_RETRY_DELAYS_MS = [2 * 1000, 4 * 1000];

/** URL of the public registry's package document; scoped names keep `%2F` encoded. */
export const packageDocumentUrl = (name) => `${NPM_REGISTRY}${encodeURIComponent(name)}`;

/**
 * The registry's current `latest` for a package, read unauthenticated:
 * the version string, or null when the package is unknown (404) or has no
 * `latest`. Any other failure (network, timeout, other status, malformed
 * document) throws, so it is never read as "no latest".
 */
export async function fetchLatest({
  name,
  fetchFn = fetch,
  sleep = defaultSleep,
  timeoutMs = READ_BACK_REQUEST_TIMEOUT_MS,
  retryDelaysMs = FETCH_LATEST_RETRY_DELAYS_MS
}) {
  // A failed read costs a re-run and a second approval, so transient
  // failures (network error, timeout, 5xx) get a few attempts. Anything
  // else (404, other statuses, a bad document) is an answer, not retried.
  let response;
  for (let attempt = 0; ; attempt++) {
    let failure;
    try {
      response = await fetchFn(packageDocumentUrl(name), {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.status < 500) break;
      failure = `registry lookup of ${name} answered ${response.status}`;
    } catch (err) {
      failure = `registry lookup of ${name} failed: ${err?.message ?? err}`;
    }
    if (attempt >= retryDelaysMs.length) throw new Error(failure);
    await sleep(retryDelaysMs[attempt]);
  }
  if (response.status === 404) return null;
  if (response.status !== 200) {
    throw new Error(`registry lookup of ${name} answered ${response.status}`);
  }
  let document;
  try {
    document = await response.json();
  } catch {
    throw new Error(`registry document for ${name} is not valid JSON`);
  }
  const tags = document?.['dist-tags'];
  if (tags === null || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error(`registry document for ${name} has no dist-tags`);
  }
  const latest = tags.latest;
  if (latest === undefined) return null;
  if (typeof latest !== 'string' || !parseSemver(latest)) {
    throw new Error(`registry document for ${name} has a malformed latest tag`);
  }
  return latest;
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
 * One look at the public registry (no credentials). Returns
 * { state: 'ok' }, { state: 'mismatch', seen }, or { state: 'pending', detail }.
 * A network error, timeout, non-200, unparseable body or a document without
 * dist.integrity is "pending": never a pass, retried while the window lasts.
 */
export async function checkVersion({ entry, integrity, fetchFn, timeoutMs }) {
  try {
    const response = await fetchFn(versionDocumentUrl(entry), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (response.status !== 200) {
      return { state: 'pending', detail: `registry answered ${response.status}` };
    }
    const seen = (await response.json())?.dist?.integrity;
    if (typeof seen !== 'string' || seen === '') {
      return { state: 'pending', detail: 'registry document has no dist.integrity' };
    }
    return seen === integrity ? { state: 'ok' } : { state: 'mismatch', seen };
  } catch (err) {
    return { state: 'pending', detail: `registry lookup failed: ${err?.message ?? err}` };
  }
}

/**
 * Reads every pending { entry, integrity } back from the public registry
 * against ONE shared deadline, polling the not-yet-confirmed set each round.
 * A different integrity fails that package at once. Returns { confirmed, failed }
 * where failed maps id -> message; the total wait never exceeds the window.
 */
export async function readBackAll({
  pending,
  fetchFn = fetch,
  sleep = defaultSleep,
  now = Date.now,
  windowMs = READ_BACK_WINDOW_MS,
  initialDelayMs = READ_BACK_INITIAL_DELAY_MS,
  maxDelayMs = READ_BACK_MAX_DELAY_MS,
  timeoutMs = READ_BACK_REQUEST_TIMEOUT_MS,
  log = console.log
}) {
  const start = now();
  const confirmed = [];
  const failed = new Map();
  const last = new Map();
  let open = pending;
  let delay = initialDelayMs;
  for (let round = 1; open.length > 0; round++) {
    // Requests in one round run together so a stalled one costs one timeout,
    // not one per package.
    const results = await Promise.all(
      open.map((item) => checkVersion({ ...item, fetchFn, timeoutMs }))
    );
    const next = [];
    open.forEach((item, i) => {
      const id = `${item.entry.name}@${item.entry.version}`;
      const result = results[i];
      if (result.state === 'ok') confirmed.push(id);
      else if (result.state === 'mismatch') {
        failed.set(
          id,
          `${id} is on the registry but its integrity (${result.seen}) does not match ` +
            `the tarball this run built (${item.integrity}): the published bytes differ from this run's tarball`
        );
      } else {
        last.set(id, result.detail);
        next.push(item);
      }
    });
    open = next;
    if (open.length === 0) break;
    const elapsed = now() - start;
    if (elapsed + delay > windowMs) break;
    log(
      `${open.length} version(s) not visible yet: round ${round}, ${Math.round(elapsed / 1000)}s elapsed; ` +
        `retrying in ${delay / 1000}s`
    );
    await sleep(delay);
    delay = Math.min(delay * 2, maxDelayMs);
  }
  const waited = Math.round((now() - start) / 1000);
  for (const { entry } of open) {
    const id = `${entry.name}@${entry.version}`;
    failed.set(
      id,
      `${id} was not visible on the registry within ${waited}s of waiting ` +
        `(${last.get(id)}); it may be held rather than published`
    );
  }
  return { confirmed, failed };
}

/** Publishes every entry, then reads them all back. Returns { published, skipped, failures }. */
export async function publishAll({
  directory,
  run = defaultRun,
  log = console.log,
  fetchFn,
  sleep,
  now,
  windowMs,
  initialDelayMs,
  maxDelayMs,
  timeoutMs,
  readBack = readBackAll
}) {
  checkNpmVersion({ run });
  const manifest = readManifest(directory);

  const paths = manifest.map((entry) => verifyEntry({ directory, entry }));
  manifest.forEach((entry, index) => verifyTarballIdentity({ path: paths[index], entry, run }));

  // Phase 1: publish everything. Phase 2: verify everything against one
  // shared deadline, so total waiting is one window however many packages.
  const pending = [];
  const failures = [];
  const tags = new Map();
  for (const [index, entry] of manifest.entries()) {
    const id = `${entry.name}@${entry.version}`;
    try {
      const integrity = sha512Integrity(readFileSync(paths[index]));
      if (isPublished({ name: entry.name, version: entry.version, run })) {
        // A re-run after a read-back timed out may find the publish landed
        // later: skip only when the registry holds this run's exact bytes.
        pending.push({ entry, integrity, kind: 'skipped' });
        continue;
      }
      // Decided now, from the registry as it is now, so the order releases
      // were approved in does not move `latest` backwards unless the registry's
      // document lags (see the header). Always passed with
      // --tag; no dist-tag is added or removed afterwards.
      const tag = resolvePublishTag({
        version: entry.version,
        recordedTag: entry.tag,
        preTag: entry.preTag,
        latest: await fetchLatest({ name: entry.name, fetchFn, sleep })
      });
      const result = run('npm', [
        'publish',
        paths[index],
        '--access',
        entry.access,
        '--tag',
        tag,
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
        // Inside the registry's validation window a re-run does not see the
        // version yet and publishes again; npm refuses that. Let the
        // read-back's integrity comparison decide instead of failing outright.
        if (ALREADY_PUBLISHED_PATTERN.test(`${result.stdout}\n${result.stderr}`)) {
          log(`::notice::${id} was already published; checking the registry's copy`);
          pending.push({ entry, integrity, kind: 'skipped' });
          continue;
        }
        throw new Error(`npm publish exited with code ${result.status}\n${result.stderr.trim()}`);
      }
      if (isStagedOutput(`${result.stdout}\n${result.stderr}`)) {
        throw new Error(
          'npm reports a staged publish; the shared workflow does not support staged publishing yet'
        );
      }
      tags.set(id, tag);
      pending.push({ entry, integrity, kind: 'published' });
    } catch (err) {
      log(`::error::${id}: ${err.message}`);
      failures.push(id);
    }
  }

  const { confirmed, failed } = await readBack({
    pending,
    fetchFn,
    sleep,
    now,
    windowMs,
    initialDelayMs,
    maxDelayMs,
    timeoutMs,
    log
  });
  const published = [];
  const skipped = [];
  for (const { entry, kind } of pending) {
    const id = `${entry.name}@${entry.version}`;
    if (failed.has(id)) {
      log(`::error::${failed.get(id)}`);
      failures.push(id);
    } else if (confirmed.includes(id)) {
      if (kind === 'skipped') {
        log(`::notice::${id} is already on the registry with the same contents; skipping`);
        skipped.push(id);
      } else {
        log(`Published ${id} with tag ${tags.get(id)}; read back from the registry`);
        published.push(id);
      }
    } else {
      // Neither confirmed nor failed should be unreachable; failing here makes
      // an unaccounted package fail the step instead of passing unverified.
      log(`::error::${id} was neither confirmed nor failed by the registry read-back`);
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
