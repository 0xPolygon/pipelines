// Fails unless the run is a push to the repository's default branch.
//
// A release publishes with credentials, so it must start only from the
// reviewed history of the default branch. This is a step that fails loudly,
// not a job-level `if:`, because a skipped job would leave a green run that
// published nothing. An empty default branch fails closed: the comparison
// would otherwise be against a ref that no real branch has.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function main({ env = process.env, log = console.log } = {}) {
  const eventName = env.EVENT_NAME ?? '';
  const ref = env.REF ?? '';
  const defaultBranch = env.DEFAULT_BRANCH ?? '';

  if (defaultBranch === '') {
    log(
      "::error::The repository's default branch is not available in the workflow context. " +
        "Publishing runs only on a push to the repository's default branch."
    );
    return 1;
  }
  if (eventName !== 'push' || ref !== `refs/heads/${defaultBranch}`) {
    log(
      "::error::Publishing runs only on a push to the repository's default branch " +
        `(refs/heads/${defaultBranch}); got ${eventName || '(no event)'} on ${ref || '(no ref)'}.`
    );
    return 1;
  }
  log(`Release context ok: push to ${ref}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
