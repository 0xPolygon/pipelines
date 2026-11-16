import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { main } from './check-version-script.mjs';

// Fixtures live under the OS temp dir and are left for it to reap.
const fixture = (pkg) => {
  const dir = mkdtempSync(join(tmpdir(), 'version-script-'));
  if (pkg !== undefined) writeFileSync(join(dir, 'package.json'), pkg);
  return dir;
};
const run = (env, cwd) => {
  const lines = [];
  const code = main({ env, cwd, log: (l) => lines.push(l) });
  return { code, out: lines.join('\n') };
};

describe('version script check', () => {
  it('passes when ci:version is defined', () => {
    const cwd = fixture(JSON.stringify({ scripts: { 'ci:version': 'changeset version' } }));
    assert.equal(run({ ENABLED: 'true' }, cwd).code, 0);
  });

  it('fails when scripts has no ci:version', () => {
    const cwd = fixture(JSON.stringify({ scripts: { build: 'tsc' } }));
    const { code, out } = run({ ENABLED: 'true' }, cwd);
    assert.equal(code, 1);
    assert.match(out, /no "ci:version" script/);
  });

  it('fails when there is no scripts block', () => {
    assert.equal(run({ ENABLED: 'true' }, fixture('{}')).code, 1);
  });

  it('fails when ci:version is empty', () => {
    const cwd = fixture(JSON.stringify({ scripts: { 'ci:version': ' ' } }));
    assert.equal(run({ ENABLED: 'true' }, cwd).code, 1);
  });

  it('fails when package.json is missing', () => {
    assert.equal(run({ ENABLED: 'true' }, fixture(undefined)).code, 1);
  });

  it('fails when package.json is not valid JSON', () => {
    assert.equal(run({ ENABLED: 'true' }, fixture('{')).code, 1);
  });

  it('skips when not opted in, even without the script', () => {
    const cwd = fixture('{}');
    assert.equal(run({ ENABLED: 'false' }, cwd).code, 0);
    assert.equal(run({}, cwd).code, 0);
  });
});
