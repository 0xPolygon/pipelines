// Fails when a caller opted into the version hook but its root package.json
// has no `ci:version` script. Without this check the release would fail with
// a confusing "Missing script" error inside changesets/action, after the app
// token was minted. The file is parsed, never executed.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// A real package.json is a few KB; the cap stops a huge or endless file from
// stalling the step.
export const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

// Workflow commands are line-based and use % escapes; untrusted text echoed
// into `::error::` must not be able to start a new command.
export const escapeCommandData = (text) =>
  String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// Opens with O_NOFOLLOW and checks the same descriptor it reads, so there is
// no window between the check and the read.
const readPackageJson = (path) => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('package.json is not a regular file');
    if (stat.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(`package.json is larger than ${MAX_PACKAGE_JSON_BYTES} bytes`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
};

const ownValue = (obj, key) =>
  obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined;

export function main({ env = process.env, cwd = process.cwd(), log = console.log } = {}) {
  if (env.ENABLED !== 'true') {
    log('Version hook not enabled; skipping the ci:version check.');
    return 0;
  }

  let pkg;
  try {
    pkg = JSON.parse(readPackageJson(resolve(cwd, 'package.json')));
  } catch (err) {
    log(
      `::error::The version hook is enabled but the root package.json cannot be read: ${escapeCommandData(err.message)}`
    );
    return 1;
  }

  const scripts = ownValue(pkg, 'scripts');
  const script = ownValue(Array.isArray(scripts) ? undefined : scripts, 'ci:version');
  if (typeof script !== 'string' || script.trim() === '') {
    log(
      '::error::The version hook is enabled (version_script: true) but the root package.json ' +
        'defines no "ci:version" script. Add one that runs `changeset version`, or turn the input off.'
    );
    return 1;
  }
  log('Found the ci:version script.');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
