import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { main, meetsMinimum, publishAll } from './publish-tarballs.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-tarballs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeTarball(file, content) {
  writeFileSync(join(dir, file), content);
  return sha(content);
}

function writeManifest(entries) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries));
}

function entry(name, overrides = {}) {
  const file = `${name}-1.0.0.tgz`;
  return {
    name,
    version: '1.0.0',
    file,
    sha256: writeTarball(file, `bytes of ${name}`),
    access: 'public',
    tag: 'latest',
    ...overrides
  };
}

/** Fake command runner; records every call. `views` and `publishes` override per package. */
function fakeRun({ npmVersion = '11.6.0', views = {}, publishes = {} } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === '--version') return { status: 0, stdout: `${npmVersion}\n`, stderr: '' };
    if (args[0] === 'view') {
      const spec = args[1];
      return views[spec] ?? { status: 1, stdout: '', stderr: 'npm error code E404' };
    }
    if (args[0] === 'publish') {
      const file = args[1];
      const hit = Object.keys(publishes).find((name) => file.endsWith(`${name}-1.0.0.tgz`));
      return hit ? publishes[hit] : { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected command ${args.join(' ')}`);
  };
  return { run, calls };
}

const publishCalls = (calls) => calls.filter((c) => c[1] === 'publish');
const quiet = () => {};

describe('publishAll', () => {
  it('publishes each entry with its access and tag', () => {
    writeManifest([entry('a'), entry('b', { access: 'restricted', tag: 'next' })]);
    const { run, calls } = fakeRun();
    const result = publishAll({ directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(publishCalls(calls), [
      ['npm', 'publish', join(dir, 'a-1.0.0.tgz'), '--access', 'public', '--tag', 'latest'],
      ['npm', 'publish', join(dir, 'b-1.0.0.tgz'), '--access', 'restricted', '--tag', 'next']
    ]);
  });

  it('refuses a SHA-256 mismatch before publishing anything', () => {
    const good = entry('a');
    const bad = entry('b', { sha256: sha('something else') });
    writeManifest([good, bad]);
    const { run, calls } = fakeRun();
    assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /SHA-256.*does not match/);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a tarball path that escapes the directory', () => {
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'outside.tgz'), 'x');
    const escaping = { ...entry('a'), file: '../outside.tgz', sha256: sha('x') };
    const outDir = join(dir, 'out');
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify([escaping]));
    const { run, calls } = fakeRun();
    assert.throws(
      () => publishAll({ directory: outDir, run, log: quiet }),
      /escapes the directory/
    );
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a missing tarball', () => {
    writeManifest([entry('a', { file: 'nope.tgz' })]);
    const { run, calls } = fakeRun();
    assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /is missing/);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('skips a version that is already on the registry', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 0, stdout: '"1.0.0"\n', stderr: '' } }
    });
    const result = publishAll({ directory: dir, run, log: quiet });
    assert.deepEqual(result.skipped, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('fails a package whose registry lookup fails for a reason other than 404', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '', stderr: 'npm error code ECONNRESET' } }
    });
    const result = publishAll({ directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('continues past a failed publish and reports the failure', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const result = publishAll({ directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 2);
  });

  it('fails before any publish when npm is too old', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({ npmVersion: '11.5.0' });
    assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /11\.5\.1 or later/);
    assert.equal(publishCalls(calls).length, 0);
  });
});

describe('main', () => {
  it('exits non-zero listing the failed packages', () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const lines = [];
    const code = main({ env: { TARBALL_DIRECTORY: dir }, run, log: (l) => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /Failed to publish: a@1\.0\.0/);
  });

  it('exits zero when everything publishes and never logs the environment', () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const lines = [];
    const code = main({
      env: { TARBALL_DIRECTORY: dir, SOME_SECRET: 'hunter2' },
      run,
      log: (l) => lines.push(l)
    });
    assert.equal(code, 0);
    assert.doesNotMatch(lines.join('\n'), /hunter2/);
  });
});

describe('meetsMinimum', () => {
  it('compares versions numerically', () => {
    assert.equal(meetsMinimum('11.5.1', '11.5.1'), true);
    assert.equal(meetsMinimum('11.10.0', '11.5.1'), true);
    assert.equal(meetsMinimum('10.9.9', '11.5.1'), false);
    assert.equal(meetsMinimum('garbage', '11.5.1'), false);
  });
});
