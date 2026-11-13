// Publishes the tarballs listed in <directory>/manifest.json.
//
// manifest.json is an array of { name, version, file, sha256, access, tag }.
// Every entry is verified (file inside the directory, SHA-256 matches) and the
// npm client version is checked before the first publish, so a bad manifest
// publishes nothing. A version already on the registry is skipped. A package
// whose publish or registry lookup fails is recorded and the rest continue;
// the run then exits non-zero listing the failures.
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

/**
 * True when name@version is on the registry, false when the registry answers
 * 404. Any other lookup failure throws, so it is never read as "not published".
 */
export function isPublished({ name, version, run = defaultRun }) {
  const result = run('npm', ['view', `${name}@${version}`, 'version', '--json']);
  if (result.status === 0) return result.stdout.trim() !== '';
  if (/\bE404\b|\b404\b/.test(`${result.stderr}\n${result.stdout}`)) return false;
  throw new Error(`registry lookup failed with exit code ${result.status}`);
}

/** Verifies and publishes every entry. Returns { published, skipped, failures }. */
export function publishAll({ directory, run = defaultRun, log = console.log }) {
  checkNpmVersion({ run });
  const manifest = readManifest(directory);

  const paths = manifest.map((entry) => verifyEntry({ directory, entry }));

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
        entry.tag
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
  let result;
  try {
    result = publishAll({ directory, run, log });
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
