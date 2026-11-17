// Fails unless CLI_MAJOR is exactly "2" or "3".
//
// The release workflow picks its arm from the detector's major, and a skipped
// arm leaves a green run that tagged or versioned nothing. An empty or
// unexpected value (a detector that wrote nothing, or a majors list that grew
// without this workflow) must stop the run instead of selecting no arm.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function main({ env = process.env, log = console.log } = {}) {
  const major = env.CLI_MAJOR ?? '';
  if (major !== '2' && major !== '3') {
    log(
      `::error title=Unsupported @changesets/cli major::The detected @changesets/cli major is '${major}'; only 2 and 3 are supported.`
    );
    return 1;
  }
  log(`@changesets/cli major ${major}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
