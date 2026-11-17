import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { main } from './check-cli-major.mjs';

const run = (env) => {
  const lines = [];
  const code = main({ env, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
};

describe('check-cli-major', () => {
  it('accepts 2 and 3', () => {
    assert.equal(run({ CLI_MAJOR: '2' }).code, 0);
    assert.equal(run({ CLI_MAJOR: '3' }).code, 0);
  });

  it('fails closed on an empty, missing or unexpected major', () => {
    for (const env of [
      {},
      { CLI_MAJOR: '' },
      { CLI_MAJOR: '4' },
      { CLI_MAJOR: '1' },
      { CLI_MAJOR: '2.30.0' },
      { CLI_MAJOR: ' 3' },
      { CLI_MAJOR: '03' }
    ]) {
      const { code, out } = run(env);
      assert.equal(code, 1, JSON.stringify(env));
      assert.match(out, /only 2 and 3 are supported/);
    }
  });
});
