// Publishes the tarballs listed in <directory>/manifest.json.
//
// manifest.json is an array of { name, version, file, sha256, access, tag }.
// Every entry is verified (fields well-formed, file inside the directory,
// SHA-256 matches, the tarball's own name and version match the entry, build
// provenance attestation checked with `gh attestation verify`) and the npm
// client version is checked before the first publish, so a bad manifest or an
// unattested tarball publishes nothing. A version already on the registry is
// skipped. A package
// whose publish or registry lookup fails is recorded and the rest continue;
// the run then exits non-zero listing the failures.
//
// npm authenticates with the runner's OIDC identity and never sees a token.
// GH_TOKEN, when set, is passed only to the `gh` child process. Logs name
// packages and versions only and never print the environment.

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

const NAME_PATTERN = /^(@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const TAG_PATTERN = /^[a-z][a-z0-9._-]*$/;

const ENTRY_FIELDS = ['name', 'version', 'file', 'sha256', 'access', 'tag'];

/** Runs a command and returns { status, stdout, stderr }. */
export function defaultRun(command, args) {
  // GH_TOKEN is for `gh attestation verify` alone; npm must not inherit it.
  const { GH_TOKEN, ...rest } = process.env;
  const env = command === 'gh' ? process.env : rest;
  const result = spawnSync(command, args, { encoding: 'utf8', env });
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
 * Throws unless `gh attestation verify` accepts the tarball: an attestation
 * from `repository`, for the commit `sourceDigest` on `sourceRef`, signed by
 * the `signerWorkflow` workflow at exactly `signerDigest`. Binding all of
 * these ties the tarball to this release: an attestation made for another
 * commit or ref, or by another version of the shared workflow, is rejected.
 * A missing `gh` fails the same way.
 */
export function verifyAttestation({
  path,
  entry,
  repository,
  signerWorkflow,
  signerDigest,
  sourceDigest,
  sourceRef,
  run = defaultRun
}) {
  const result = run('gh', [
    'attestation',
    'verify',
    path,
    '--repo',
    repository,
    '--signer-workflow',
    signerWorkflow,
    '--signer-digest',
    signerDigest,
    '--source-digest',
    sourceDigest,
    '--source-ref',
    sourceRef
  ]);
  if (result.status !== 0) {
    throw new Error(
      `${entry.name}@${entry.version}: attestation verification failed\n${result.stderr.trim()}`
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

/** Verifies and publishes every entry. Returns { published, skipped, failures }. */
export function publishAll({
  directory,
  repository,
  signerWorkflow,
  signerDigest,
  sourceDigest,
  sourceRef,
  run = defaultRun,
  log = console.log
}) {
  checkNpmVersion({ run });
  const manifest = readManifest(directory);

  const paths = manifest.map((entry) => verifyEntry({ directory, entry }));
  manifest.forEach((entry, index) => {
    verifyTarballIdentity({ path: paths[index], entry, run });
    verifyAttestation({
      path: paths[index],
      entry,
      repository,
      signerWorkflow,
      signerDigest,
      sourceDigest,
      sourceRef,
      run
    });
  });

  const published = [];
  const skipped = [];
  const failures = [];
  manifest.forEach((entry, index) => {
    const id = `${entry.name}@${entry.version}`;
    try {
      if (isPublished({ name: entry.name, version: entry.version, run })) {
        log(`::notice::${id} is already on the registry; skipping`);
        skipped.push(id);
        return;
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
      if (result.status !== 0) {
        throw new Error(`npm publish exited with code ${result.status}\n${result.stderr.trim()}`);
      }
      log(`Published ${id} with tag ${entry.tag}`);
      published.push(id);
    } catch (err) {
      log(`::error::${id}: ${err.message}`);
      failures.push(id);
    }
  });
  return { published, skipped, failures };
}

export function main({ env = process.env, run = defaultRun, log = console.log } = {}) {
  const directory = env.TARBALL_DIRECTORY;
  if (!directory) {
    log('::error::TARBALL_DIRECTORY is not set');
    return 1;
  }
  const repository = env.GITHUB_REPOSITORY;
  const signerWorkflow = env.SIGNER_WORKFLOW;
  const signerDigest = env.SIGNER_DIGEST;
  const sourceDigest = env.SOURCE_DIGEST;
  const sourceRef = env.SOURCE_REF;
  if (!repository || !signerWorkflow || !signerDigest || !sourceDigest || !sourceRef) {
    log(
      '::error::GITHUB_REPOSITORY, SIGNER_WORKFLOW, SIGNER_DIGEST, SOURCE_DIGEST and SOURCE_REF must be set'
    );
    return 1;
  }
  let result;
  try {
    result = publishAll({
      directory,
      repository,
      signerWorkflow,
      signerDigest,
      sourceDigest,
      sourceRef,
      run,
      log
    });
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
  process.exit(main());
}
