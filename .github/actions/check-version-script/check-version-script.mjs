// Fails when a caller opted into the version hook but its root package.json
// has no `ci:version` script. Without this check the release would fail with
// a confusing "Missing script" error inside changesets/action, after the app
// token was minted. The file is parsed, never executed.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function main({ env = process.env, cwd = process.cwd(), log = console.log } = {}) {
  if (env.ENABLED !== 'true') {
    log('Version hook not enabled; skipping the ci:version check.');
    return 0;
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  } catch (err) {
    log(
      `::error::The version hook is enabled but the root package.json cannot be read: ${err.message}`
    );
    return 1;
  }

  const script = pkg?.scripts?.['ci:version'];
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
