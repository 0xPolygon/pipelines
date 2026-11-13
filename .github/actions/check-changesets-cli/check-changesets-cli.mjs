// Fails unless the repository's resolved @changesets/cli is 2.x. The version
// comes from the installed binary (`pnpm exec changeset --version`), so it is
// the one the lockfile resolved and the one that will run `changeset tag`.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : '')
  };
}

/** Returns the resolved version string, or throws a public, actionable error. */
export function checkChangesetsCli({ run = defaultRun } = {}) {
  const result = run('pnpm', ['exec', 'changeset', '--version']);
  const version = result.stdout.trim().split('\n').pop()?.trim() ?? '';
  const match = /^(\d+)\.\d+\.\d+/.exec(version);
  if (result.status !== 0 || !match) {
    throw new Error(
      'Could not determine the version of @changesets/cli. Add @changesets/cli 2.x ' +
        "to the repository's devDependencies and install it from the lockfile."
    );
  }
  if (match[1] !== '2') {
    throw new Error(
      `This workflow requires @changesets/cli 2.x; the repository resolves ${version}. ` +
        'Tags and GitHub Releases are created from the `New tag:` lines that `changeset tag` ' +
        'prints in 2.x. Pin @changesets/cli to a 2.x release.'
    );
  }
  return version;
}

export function main({ run = defaultRun, log = console.log } = {}) {
  try {
    log(`@changesets/cli ${checkChangesetsCli({ run })}`);
    return 0;
  } catch (err) {
    log(`::error title=Unsupported @changesets/cli::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
