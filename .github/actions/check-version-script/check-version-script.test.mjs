import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { MAX_PACKAGE_JSON_BYTES, escapeCommandData, main } from './check-version-script.mjs';

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

  it('fails closed on shapes that are not a string script', () => {
    const bad = [
      JSON.stringify({ scripts: { 'ci:version': 123 } }),
      JSON.stringify({ scripts: { 'ci:version': ['x'] } }),
      JSON.stringify({ scripts: { 'ci:version': null } }),
      JSON.stringify({ scripts: 'ci:version' }),
      JSON.stringify({ scripts: ['ci:version'] }),
      JSON.stringify({ scripts: null }),
      'null',
      '[]',
      '"ci:version"'
    ];
    for (const pkg of bad) assert.equal(run({ ENABLED: 'true' }, fixture(pkg)).code, 1, pkg);
  });

  it('does not mistake inherited or prototype keys for a defined script', () => {
    const bad = [
      '{"scripts":{"__proto__":{"ci:version":"x"}}}',
      '{"__proto__":{"scripts":{"ci:version":"x"}}}',
      '{"scripts":{"constructor":{"ci:version":"x"}}}',
      '{"constructor":{"scripts":{"ci:version":"x"}}}'
    ];
    for (const pkg of bad) assert.equal(run({ ENABLED: 'true' }, fixture(pkg)).code, 1, pkg);
  });

  it('refuses a symlinked package.json', () => {
    const target = fixture(JSON.stringify({ scripts: { 'ci:version': 'changeset version' } }));
    const cwd = fixture(undefined);
    symlinkSync(join(target, 'package.json'), join(cwd, 'package.json'));
    assert.equal(run({ ENABLED: 'true' }, cwd).code, 1);
  });

  it('refuses a package.json over the size cap', () => {
    const big = JSON.stringify({ scripts: { 'ci:version': 'x'.repeat(MAX_PACKAGE_JSON_BYTES) } });
    const { code, out } = run({ ENABLED: 'true' }, fixture(big));
    assert.equal(code, 1);
    assert.match(out, /larger than/);
  });

  it('keeps error output on a single workflow-command line', () => {
    const { out } = run({ ENABLED: 'true' }, fixture('{"a":1,\n::warning::injected\n'));
    assert.equal(out.split('\n').length, 1);
    assert.doesNotMatch(out, /\n::warning::/);
  });

  it('escapes %, CR and LF in text echoed into a workflow command', () => {
    assert.equal(escapeCommandData('a%b\r\n::warning::x'), 'a%25b%0D%0A::warning::x');
  });

  it('skips when not opted in, even without the script', () => {
    const cwd = fixture('{}');
    assert.equal(run({ ENABLED: 'false' }, cwd).code, 0);
    assert.equal(run({}, cwd).code, 0);
  });
});
