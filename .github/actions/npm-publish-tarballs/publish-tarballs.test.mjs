import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { defaultRun, main, meetsMinimum, publishAll } from './publish-tarballs.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-tarballs-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a real tarball whose package/package.json is `inner`; returns its SHA-256. */
function writeTarball(file, inner) {
  const src = mkdtempSync(join(tmpdir(), 'publish-src-'));
  mkdirSync(join(src, 'package'));
  writeFileSync(join(src, 'package', 'package.json'), JSON.stringify(inner));
  execFileSync('tar', ['-czf', join(dir, file), '-C', src, 'package']);
  rmSync(src, { recursive: true, force: true });
  return sha(readFileSync(join(dir, file)));
}

function writeManifest(entries) {
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries));
}

function entry(name, overrides = {}, innerExtra = {}) {
  const file = `${name}-1.0.0.tgz`;
  return {
    name,
    version: '1.0.0',
    file,
    sha256: writeTarball(file, { name, version: overrides.version ?? '1.0.0', ...innerExtra }),
    access: 'public',
    tag: 'latest',
    ...overrides
  };
}

/** Fake command runner; records every call. `views` and `publishes` override per package. */
function fakeRun({
  npmVersion = '11.6.0',
  views = {},
  publishes = {},
  attestFails = [],
  ghMissing = false
} = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'tar') return defaultRun(command, args);
    if (command === 'gh') {
      if (ghMissing) return { status: 1, stdout: '', stderr: 'spawn gh ENOENT' };
      const file = args[2];
      return attestFails.some((name) => file.endsWith(`${name}-1.0.0.tgz`))
        ? { status: 1, stdout: '', stderr: 'no matching attestation' }
        : { status: 0, stdout: '', stderr: '' };
    }
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

const ctx = {
  repository: '0xPolygon/example',
  signerWorkflow: '0xPolygon/pipelines/.github/workflows/apps-npm-release.yml',
  signerDigest: '1111111111111111111111111111111111111111',
  sourceDigest: '2222222222222222222222222222222222222222',
  sourceRef: 'refs/heads/main'
};
const ghCalls = (calls) => calls.filter((c) => c[0] === 'gh');
const publishCalls = (calls) => calls.filter((c) => c[1] === 'publish');
const quiet = () => {};

describe('publishAll', () => {
  it('publishes each entry with its access and tag', () => {
    writeManifest([entry('a'), entry('b', { tag: 'next' })]);
    const { run, calls } = fakeRun();
    const result = publishAll({ ...ctx, directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(publishCalls(calls), [
      [
        'npm',
        'publish',
        join(dir, 'a-1.0.0.tgz'),
        '--access',
        'public',
        '--tag',
        'latest',
        '--registry',
        'https://registry.npmjs.org/',
        '--ignore-scripts'
      ],
      [
        'npm',
        'publish',
        join(dir, 'b-1.0.0.tgz'),
        '--access',
        'public',
        '--tag',
        'next',
        '--registry',
        'https://registry.npmjs.org/',
        '--ignore-scripts'
      ]
    ]);
    for (const call of calls.filter((c) => c[1] === 'view')) {
      assert.deepEqual(call.slice(-2), ['--registry', 'https://registry.npmjs.org/']);
    }
  });

  it('refuses a SHA-256 mismatch before publishing anything', () => {
    const good = entry('a');
    const bad = entry('b', { sha256: sha('something else') });
    writeManifest([good, bad]);
    const { run, calls } = fakeRun();
    assert.throws(
      () => publishAll({ ...ctx, directory: dir, run, log: quiet }),
      /SHA-256.*does not match/
    );
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
      () => publishAll({ ...ctx, directory: outDir, run, log: quiet }),
      /escapes the directory/
    );
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a missing tarball', () => {
    writeManifest([entry('a', { file: 'nope.tgz' })]);
    const { run, calls } = fakeRun();
    assert.throws(() => publishAll({ ...ctx, directory: dir, run, log: quiet }), /is missing/);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a tarball whose package.json sets another registry, publishing nothing', () => {
    for (const publishConfig of [
      { registry: 'https://other.test/' },
      { '@scope:registry': 'https://other.test/' }
    ]) {
      writeManifest([entry('a'), entry('b', {}, { publishConfig })]);
      const { run, calls } = fakeRun();
      assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /registry other than/);
      assert.equal(publishCalls(calls).length, 0);
    }
  });

  it('accepts a tarball whose publishConfig names npmjs', () => {
    writeManifest([entry('a', {}, { publishConfig: { registry: 'https://registry.npmjs.org' } })]);
    const { run } = fakeRun();
    assert.deepEqual(publishAll({ directory: dir, run, log: quiet }).failures, []);
  });

  it('skips a version that is already on the registry', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 0, stdout: '"1.0.0"\n', stderr: '' } }
    });
    const result = publishAll({ ...ctx, directory: dir, run, log: quiet });
    assert.deepEqual(result.skipped, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('fails a package whose registry lookup fails for a reason other than 404', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '', stderr: 'npm error code ECONNRESET' } }
    });
    const result = publishAll({ ...ctx, directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('continues past a failed publish and reports the failure', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const result = publishAll({ ...ctx, directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 2);
  });

  it('does not read a 404 inside a version string as a missing package', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '', stderr: 'npm error a@1.404.0 request failed' } }
    });
    const result = publishAll({ directory: dir, run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('reads the E404 error code in JSON output as a missing package', () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' } }
    });
    assert.deepEqual(publishAll({ directory: dir, run, log: quiet }).published, ['a@1.0.0']);
  });

  it('refuses a malformed manifest entry before publishing anything', () => {
    const bad = [
      { access: 'restricted' },
      { tag: '--otp=1' },
      { tag: 'Latest' },
      { name: '--foo' },
      { name: 'UPPER' },
      { version: 'latest' },
      { sha256: 'abc' }
    ];
    for (const override of bad) {
      writeManifest([entry('a'), entry('b', override)]);
      const { run, calls } = fakeRun();
      assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /is invalid|missing/);
      assert.equal(publishCalls(calls).length, 0);
    }
  });

  it('refuses a tarball whose own package.json differs from the manifest entry', () => {
    const swapped = entry('a');
    writeManifest([{ ...swapped, name: 'other' }]);
    const { run, calls } = fakeRun();
    assert.throws(
      () => publishAll({ directory: dir, run, log: quiet }),
      /holds a@1\.0\.0, which does not match/
    );
    assert.equal(publishCalls(calls).length, 0);
    const wrongVersion = entry('c');
    writeManifest([{ ...wrongVersion, version: '2.0.0' }]);
    assert.throws(() => publishAll({ directory: dir, run, log: quiet }), /does not match/);
  });

  it('fails before any publish when npm is too old', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({ npmVersion: '11.5.0' });
    assert.throws(
      () => publishAll({ ...ctx, directory: dir, run, log: quiet }),
      /11\.5\.1 or later/
    );
    assert.equal(publishCalls(calls).length, 0);
  });
});

const mainEnv = {
  GITHUB_REPOSITORY: ctx.repository,
  SIGNER_WORKFLOW: ctx.signerWorkflow,
  SIGNER_DIGEST: ctx.signerDigest,
  SOURCE_DIGEST: ctx.sourceDigest,
  SOURCE_REF: ctx.sourceRef
};

describe('attestation', () => {
  it('verifies every entry before the first publish, with repo and signer workflow', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun();
    publishAll({ ...ctx, directory: dir, run, log: quiet });
    const firstPublish = calls.findIndex((c) => c[1] === 'publish');
    const verifyIdx = calls.map((c, i) => (c[0] === 'gh' ? i : -1)).filter((i) => i >= 0);
    assert.equal(verifyIdx.length, 2);
    assert.ok(verifyIdx.every((i) => i < firstPublish));
    assert.deepEqual(ghCalls(calls)[0], [
      'gh',
      'attestation',
      'verify',
      join(dir, 'a-1.0.0.tgz'),
      '--repo',
      ctx.repository,
      '--signer-workflow',
      ctx.signerWorkflow,
      '--signer-digest',
      ctx.signerDigest,
      '--source-digest',
      ctx.sourceDigest,
      '--source-ref',
      ctx.sourceRef
    ]);
  });

  it('binds a branch-ref caller to the ref and signer digest it was given', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun();
    publishAll({
      ...ctx,
      sourceRef: 'refs/heads/feature-x',
      signerDigest: 'abc123',
      directory: dir,
      run,
      log: quiet
    });
    const argv = ghCalls(calls)[0];
    assert.equal(argv[argv.indexOf('--source-ref') + 1], 'refs/heads/feature-x');
    assert.equal(argv[argv.indexOf('--signer-digest') + 1], 'abc123');
    assert.equal(publishCalls(calls).length, 1);
  });

  it('publishes nothing when one verification fails', () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({ attestFails: ['b'] });
    assert.throws(
      () => publishAll({ ...ctx, directory: dir, run, log: quiet }),
      /b@1\.0\.0: attestation verification failed/
    );
    assert.equal(publishCalls(calls).length, 0);
  });

  it('fails when gh is not available', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({ ghMissing: true });
    assert.throws(() => publishAll({ ...ctx, directory: dir, run, log: quiet }), /attestation/);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('exits non-zero from main on a failed verification', () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({ attestFails: ['a'] });
    const code = main({ env: { ...mainEnv, TARBALL_DIRECTORY: dir }, run, log: quiet });
    assert.equal(code, 1);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('exits non-zero from main when any binding input is unset', () => {
    writeManifest([entry('a')]);
    for (const missing of Object.keys(mainEnv)) {
      const env = { ...mainEnv, TARBALL_DIRECTORY: dir };
      delete env[missing];
      const { run, calls } = fakeRun();
      assert.equal(main({ env, run, log: quiet }), 1, `${missing} unset`);
      assert.equal(calls.length, 0);
    }
  });

  it('passes GH_TOKEN to gh only, never to npm', () => {
    const probe = ['-e', 'process.stdout.write(process.env.GH_TOKEN ?? "none")'];
    process.env.GH_TOKEN = 'tok';
    try {
      assert.equal(defaultRun('node', probe).stdout, 'none');
    } finally {
      delete process.env.GH_TOKEN;
    }
  });
});

describe('main', () => {
  it('exits non-zero listing the failed packages', () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const lines = [];
    const code = main({
      env: { ...mainEnv, TARBALL_DIRECTORY: dir },
      run,
      log: (l) => lines.push(l)
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /Failed to publish: a@1\.0\.0/);
  });

  it('exits zero when everything publishes and never logs the environment', () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const lines = [];
    const code = main({
      env: { ...mainEnv, TARBALL_DIRECTORY: dir, SOME_SECRET: 'hunter2' },
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
