import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { main } from './assert-release-context.mjs';

const run = (env) => {
  const lines = [];
  const code = main({ env, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
};

describe('release context guard', () => {
  it('passes on a push to main', () => {
    assert.equal(
      run({ EVENT_NAME: 'push', REF: 'refs/heads/main', DEFAULT_BRANCH: 'main' }).code,
      0
    );
  });

  it('passes on a push to master when master is the default', () => {
    assert.equal(
      run({ EVENT_NAME: 'push', REF: 'refs/heads/master', DEFAULT_BRANCH: 'master' }).code,
      0
    );
  });

  it('fails on a push to another branch', () => {
    const { code, out } = run({
      EVENT_NAME: 'push',
      REF: 'refs/heads/feature',
      DEFAULT_BRANCH: 'main'
    });
    assert.equal(code, 1);
    assert.match(out, /got push on refs\/heads\/feature/);
  });

  it('fails on workflow_dispatch against the default branch', () => {
    const { code, out } = run({
      EVENT_NAME: 'workflow_dispatch',
      REF: 'refs/heads/main',
      DEFAULT_BRANCH: 'main'
    });
    assert.equal(code, 1);
    assert.match(out, /got workflow_dispatch on refs\/heads\/main/);
  });

  it('fails on pull_request', () => {
    assert.equal(
      run({ EVENT_NAME: 'pull_request', REF: 'refs/pull/1/merge', DEFAULT_BRANCH: 'main' }).code,
      1
    );
  });

  it('fails on a tag ref', () => {
    assert.equal(
      run({ EVENT_NAME: 'push', REF: 'refs/tags/main', DEFAULT_BRANCH: 'main' }).code,
      1
    );
  });

  it('fails closed on an empty default branch', () => {
    const { code, out } = run({ EVENT_NAME: 'push', REF: 'refs/heads/', DEFAULT_BRANCH: '' });
    assert.equal(code, 1);
    assert.match(out, /default branch is not available/);
  });

  it('fails closed on a missing default branch', () => {
    assert.equal(run({ EVENT_NAME: 'push', REF: 'refs/heads/main' }).code, 1);
  });

  it('fails on a branch whose name only starts with the default', () => {
    assert.equal(
      run({ EVENT_NAME: 'push', REF: 'refs/heads/main-2', DEFAULT_BRANCH: 'main' }).code,
      1
    );
  });
});
