import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkChangesetsCli, main } from './check-changesets-cli.mjs';

const answer =
  (stdout, status = 0) =>
  () => ({ status, stdout, stderr: '' });

describe('check-changesets-cli', () => {
  it('accepts a 2.x version', () => {
    assert.equal(checkChangesetsCli({ run: answer('2.30.0\n') }), '2.30.0');
  });

  it('rejects 3.x with a public explanation', () => {
    assert.throws(
      () => checkChangesetsCli({ run: answer('3.0.1\n') }),
      /requires @changesets\/cli 2\.x.*resolves 3\.0\.1/
    );
  });

  it('rejects 1.x', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('1.9.9\n') }), /2\.x/);
  });

  it('fails when the version cannot be read', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('', 1) }), /Could not determine/);
    assert.throws(() => checkChangesetsCli({ run: answer('garbage\n') }), /Could not determine/);
  });

  it('main returns 0 for 2.x and 1 with an error annotation otherwise', () => {
    const lines = [];
    assert.equal(main({ run: answer('2.1.0'), log: (l) => lines.push(l) }), 0);
    assert.equal(main({ run: answer('3.0.0'), log: (l) => lines.push(l) }), 1);
    assert.match(lines.at(-1), /^::error title=Unsupported @changesets\/cli::/);
  });
});
