import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  defaultRun,
  isStagedOutput,
  main,
  meetsMinimum,
  publishAll,
  READ_BACK_REQUEST_TIMEOUT_MS,
  READ_BACK_WINDOW_MS,
  sha512Integrity,
  versionDocumentUrl
} from './publish-tarballs.mjs';

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
function fakeRun({ npmVersion = '11.6.0', views = {}, publishes = {} } = {}) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'tar') return defaultRun(command, args);
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

/** Integrity of the tarball `entry(name)` wrote, as the registry would report it. */
const integrityOf = (name) => sha512Integrity(readFileSync(join(dir, `${name}-1.0.0.tgz`)));

/**
 * Fake registry + clock: `answers[name]` is a list of responses served in
 * order (the last repeats); `sleeps` records requested waits without waiting.
 */
function fakeNet(answers = {}) {
  const urls = [];
  const sleeps = [];
  const served = {};
  const fetchFn = async (url, init) => {
    urls.push({ url, init });
    const name = decodeURIComponent(url.replace('https://registry.npmjs.org/', '').split('/')[0]);
    const list = answers[name] ?? [{ status: 200, integrity: integrityOf(name) }];
    const index = Math.min(served[name] ?? 0, list.length - 1);
    served[name] = (served[name] ?? 0) + 1;
    const { status, integrity, fail, body, noIntegrity } = list[index];
    if (fail) throw fail;
    return {
      status,
      json: async () => {
        if (body !== undefined) return JSON.parse(body);
        return noIntegrity ? { name } : { dist: { integrity } };
      }
    };
  };
  // A fake clock that only sleeping advances, so the shared deadline is testable.
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock += ms;
  };
  return { fetchFn, sleep, now, urls, sleeps };
}
/** Default network for tests that do not care: every package visible, matching. */
const net = () => {
  const { fetchFn, sleep, now } = fakeNet();
  return { fetchFn, sleep, now };
};

describe('publishAll', () => {
  it('publishes each entry with its access and tag', async () => {
    writeManifest([entry('a'), entry('b', { tag: 'next' })]);
    const { run, calls } = fakeRun();
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
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

  it('refuses a SHA-256 mismatch before publishing anything', async () => {
    const good = entry('a');
    const bad = entry('b', { sha256: sha('something else') });
    writeManifest([good, bad]);
    const { run, calls } = fakeRun();
    await assert.rejects(
      publishAll({ directory: dir, ...net(), run, log: quiet }),
      /SHA-256.*does not match/
    );
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a tarball path that escapes the directory', async () => {
    mkdirSync(join(dir, 'out'));
    writeFileSync(join(dir, 'outside.tgz'), 'x');
    const escaping = { ...entry('a'), file: '../outside.tgz', sha256: sha('x') };
    const outDir = join(dir, 'out');
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify([escaping]));
    const { run, calls } = fakeRun();
    await assert.rejects(
      publishAll({ directory: outDir, ...net(), run, log: quiet }),
      /escapes the directory/
    );
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a missing tarball', async () => {
    writeManifest([entry('a', { file: 'nope.tgz' })]);
    const { run, calls } = fakeRun();
    await assert.rejects(publishAll({ directory: dir, ...net(), run, log: quiet }), /is missing/);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('refuses a tarball whose package.json sets another registry, publishing nothing', async () => {
    for (const publishConfig of [
      { registry: 'https://other.test/' },
      { '@scope:registry': 'https://other.test/' }
    ]) {
      writeManifest([entry('a'), entry('b', {}, { publishConfig })]);
      const { run, calls } = fakeRun();
      await assert.rejects(
        publishAll({ directory: dir, ...net(), run, log: quiet }),
        /registry other than/
      );
      assert.equal(publishCalls(calls).length, 0);
    }
  });

  it('accepts a tarball whose publishConfig names npmjs', async () => {
    writeManifest([entry('a', {}, { publishConfig: { registry: 'https://registry.npmjs.org' } })]);
    const { run } = fakeRun();
    assert.deepEqual(
      (await publishAll({ directory: dir, ...net(), run, log: quiet })).failures,
      []
    );
  });

  it('skips a version that is already on the registry', async () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 0, stdout: '"1.0.0"\n', stderr: '' } }
    });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.skipped, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('skips a version already on the registry with different contents as a failure', async () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 0, stdout: '"1.0.0"\n', stderr: '' } }
    });
    const network = fakeNet({ a: [{ status: 200, integrity: 'sha512-BBBB' }] });
    const lines = [];
    const result = await publishAll({ directory: dir, run, log: (l) => lines.push(l), ...network });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.skipped, []);
    assert.equal(publishCalls(calls).length, 0);
    assert.match(lines.join('\n'), /a@1\.0\.0.*integrity \(sha512-BBBB\) does not match/);
  });

  it('fails a package whose registry lookup fails for a reason other than 404', async () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '', stderr: 'npm error code ECONNRESET' } }
    });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 1);
  });

  it('continues past a failed publish and reports the failure', async () => {
    writeManifest([entry('a'), entry('b')]);
    const { run, calls } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.equal(publishCalls(calls).length, 2);
  });

  it('does not read a 404 inside a version string as a missing package', async () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '', stderr: 'npm error a@1.404.0 request failed' } }
    });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.equal(publishCalls(calls).length, 0);
  });

  it('reads the E404 error code in JSON output as a missing package', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({
      views: { 'a@1.0.0': { status: 1, stdout: '{"error":{"code":"E404"}}', stderr: '' } }
    });
    assert.deepEqual((await publishAll({ directory: dir, ...net(), run, log: quiet })).published, [
      'a@1.0.0'
    ]);
  });

  it('refuses a malformed manifest entry before publishing anything', async () => {
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
      await assert.rejects(
        publishAll({ directory: dir, ...net(), run, log: quiet }),
        /is invalid|missing/
      );
      assert.equal(publishCalls(calls).length, 0);
    }
  });

  it('refuses a tarball whose own package.json differs from the manifest entry', async () => {
    const swapped = entry('a');
    writeManifest([{ ...swapped, name: 'other' }]);
    const { run, calls } = fakeRun();
    await assert.rejects(
      publishAll({ directory: dir, ...net(), run, log: quiet }),
      /holds a@1\.0\.0, which does not match/
    );
    assert.equal(publishCalls(calls).length, 0);
    const wrongVersion = entry('c');
    writeManifest([{ ...wrongVersion, version: '2.0.0' }]);
    await assert.rejects(
      publishAll({ directory: dir, ...net(), run, log: quiet }),
      /does not match/
    );
  });

  it('fails before any publish when npm is too old', async () => {
    writeManifest([entry('a')]);
    const { run, calls } = fakeRun({ npmVersion: '11.5.0' });
    await assert.rejects(
      publishAll({ directory: dir, ...net(), run, log: quiet }),
      /11\.5\.1 or later/
    );
    assert.equal(publishCalls(calls).length, 0);
  });
});

describe('read-back after publish', () => {
  it('passes when the version is visible with the integrity of the published tarball', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet();
    const lines = [];
    const result = await publishAll({
      directory: dir,
      run,
      log: (l) => lines.push(l),
      fetchFn: network.fetchFn,
      sleep: network.sleep,
      now: network.now
    });
    assert.deepEqual(result.published, ['a@1.0.0']);
    assert.deepEqual(result.failures, []);
    assert.equal(network.urls.length, 1);
    assert.equal(network.urls[0].url, 'https://registry.npmjs.org/a/1.0.0');
    assert.deepEqual(Object.keys(network.urls[0].init.headers), ['accept']);
    assert.match(lines.join('\n'), /read back from the registry/);
  });

  it('encodes a scoped name and carries no credential', () => {
    assert.equal(
      versionDocumentUrl({ name: '@scope/pkg', version: '1.0.0-rc.1' }),
      'https://registry.npmjs.org/%40scope%2Fpkg/1.0.0-rc.1'
    );
  });

  it('passes after the version appears following two 404s', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet({
      a: [{ status: 404 }, { status: 404 }, { status: 200, integrity: integrityOf('a') }]
    });
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.deepEqual(result.published, ['a@1.0.0']);
    assert.deepEqual(network.sleeps, [15000, 30000]);
  });

  it('passes when the version is listed only after about three minutes of 404s', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet({
      a: [...Array(7).fill({ status: 404 }), { status: 200, integrity: integrityOf('a') }]
    });
    const lines = [];
    const result = await publishAll({ directory: dir, run, log: (l) => lines.push(l), ...network });
    assert.deepEqual(result.published, ['a@1.0.0']);
    assert.equal(
      network.sleeps.reduce((sum, ms) => sum + ms, 0),
      15000 + 30000 * 6
    );
    assert.match(lines.join('\n'), /round 3, 45s elapsed/);
  });

  it('keeps polling for the full default window before giving up', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet({ a: [{ status: 404 }] });
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    const total = network.sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.ok(total >= 9 * 60 * 1000 && total <= 15 * 60 * 1000, `total wait ${total}`);
    assert.ok(READ_BACK_WINDOW_MS <= 15 * 60 * 1000);
  });

  it('fails when the version never becomes visible (including npm rejecting it after its scan), within a bounded wait', async () => {
    writeManifest([entry('a'), entry('b')]);
    const { run } = fakeRun();
    const network = fakeNet({ a: [{ status: 404 }] });
    const lines = [];
    const result = await publishAll({
      directory: dir,
      run,
      log: (l) => lines.push(l),
      ...network,
      windowMs: 60000
    });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(result.published, ['b@1.0.0']);
    assert.deepEqual(network.sleeps, [15000, 30000]);
    assert.match(lines.join('\n'), /a@1\.0\.0 was not visible on the registry/);
  });

  it('fails when the registry integrity differs from the published tarball', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet({ a: [{ status: 200, integrity: 'sha512-AAAA' }] });
    const lines = [];
    const result = await publishAll({ directory: dir, run, log: (l) => lines.push(l), ...network });
    assert.deepEqual(result.failures, ['a@1.0.0']);
    assert.deepEqual(network.sleeps, []);
    assert.match(lines.join('\n'), /integrity \(sha512-AAAA\) does not match/);
  });

  it('fails on staged publish output without waiting on the registry', async () => {
    for (const out of [
      { stdout: '+ a@1.0.0 (staged)\n', stderr: '' },
      { stdout: '+ a@1.0.0 (staged with id abc123)\n', stderr: '' },
      { stdout: '', stderr: 'npm notice package a@1.0.0 has been staged with tag latest' }
    ]) {
      writeManifest([entry('a')]);
      const { run } = fakeRun({ publishes: { a: { status: 0, ...out } } });
      const network = fakeNet({ a: [{ status: 404 }] });
      const lines = [];
      const result = await publishAll({
        directory: dir,
        run,
        log: (l) => lines.push(l),
        ...network
      });
      assert.deepEqual(result.failures, ['a@1.0.0']);
      assert.equal(network.urls.length, 0);
      assert.match(lines.join('\n'), /does not support staged publishing/);
    }
  });

  it('prints npm output for each publish and does not flag ordinary output as staged', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({
      publishes: { a: { status: 0, stdout: '+ a@1.0.0\n', stderr: 'npm notice published' } }
    });
    const lines = [];
    const result = await publishAll({ directory: dir, run, log: (l) => lines.push(l), ...net() });
    assert.deepEqual(result.published, ['a@1.0.0']);
    assert.ok(lines.includes('+ a@1.0.0'));
    assert.ok(lines.includes('npm notice published'));
    assert.equal(isStagedOutput('+ a@1.0.0'), false);
  });
});

describe('shared read-back deadline', () => {
  it('publishes every package before the first registry read', async () => {
    writeManifest([entry('a'), entry('b'), entry('c')]);
    const order = [];
    const { run } = fakeRun();
    const network = fakeNet();
    const result = await publishAll({
      directory: dir,
      log: quiet,
      run: (command, args) => {
        order.push(args[0]);
        return run(command, args);
      },
      fetchFn: (...a) => {
        order.push('fetch');
        return network.fetchFn(...a);
      },
      sleep: network.sleep,
      now: network.now
    });
    assert.equal(result.published.length, 3);
    const firstFetch = order.indexOf('fetch');
    assert.equal(order.slice(firstFetch).includes('publish'), false);
  });

  it('waits one window in total for six packages that each list after about three minutes', async () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    writeManifest(names.map((n) => entry(n)));
    const { run } = fakeRun();
    const answers = Object.fromEntries(
      names.map((n) => [
        n,
        [...Array(7).fill({ status: 404 }), { status: 200, integrity: integrityOf(n) }]
      ])
    );
    const network = fakeNet(answers);
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.equal(result.published.length, 6);
    assert.equal(
      network.sleeps.reduce((sum, ms) => sum + ms, 0),
      15000 + 30000 * 6
    );
  });

  it('prints the failure list within one window when no package ever appears', async () => {
    writeManifest([entry('a'), entry('b'), entry('c')]);
    const { run } = fakeRun();
    const network = fakeNet({ a: [{ status: 404 }], b: [{ status: 404 }], c: [{ status: 404 }] });
    const lines = [];
    const code = await main({
      env: { TARBALL_DIRECTORY: dir },
      run,
      log: (l) => lines.push(l),
      ...network
    });
    assert.equal(code, 1);
    assert.ok(network.sleeps.reduce((sum, ms) => sum + ms, 0) <= 10 * 60 * 1000);
    assert.match(lines.join('\n'), /Failed to publish: a@1\.0\.0, b@1\.0\.0, c@1\.0\.0/);
  });

  it('confirms the packages that appear and fails only those that do not', async () => {
    writeManifest([entry('a'), entry('b')]);
    const { run } = fakeRun();
    const network = fakeNet({ b: [{ status: 404 }] });
    const result = await publishAll({
      directory: dir,
      run,
      log: quiet,
      ...network,
      windowMs: 60000
    });
    assert.deepEqual(result.published, ['a@1.0.0']);
    assert.deepEqual(result.failures, ['b@1.0.0']);
  });
});

describe('integrity algorithm', () => {
  it('matches a known sha512 vector for fixed bytes', () => {
    // printf 'polygon' | openssl dgst -sha512 -binary | base64, computed outside this module.
    assert.equal(
      sha512Integrity(Buffer.from('polygon')),
      'sha512-89aYp8gm4YQzhK+q631nPqYz7PI0bc1iWJUUOdkYgzhlskj1bnlyaREPmz223HK97zva/d32xCkIsbs4GUPY+Q=='
    );
  });
});

describe('registry failure modes', () => {
  const never = (extra) => [extra];
  const cases = {
    'a network error': never({ fail: new TypeError('fetch failed') }),
    'a request timeout': never({
      fail: Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }),
    'a 5xx answer': never({ status: 503 }),
    'a non-JSON body': never({ status: 200, body: '<html>oops' }),
    'a document without dist.integrity': never({ status: 200, noIntegrity: true })
  };
  for (const [label, answers] of Object.entries(cases)) {
    it(`retries through the window and never passes on ${label}`, async () => {
      writeManifest([entry('a')]);
      const { run } = fakeRun();
      const network = fakeNet({ a: answers });
      const result = await publishAll({ directory: dir, run, log: quiet, ...network });
      assert.deepEqual(result.published, []);
      assert.deepEqual(result.failures, ['a@1.0.0']);
      assert.ok(network.sleeps.length > 10);
      assert.ok(network.sleeps.reduce((sum, ms) => sum + ms, 0) <= 10 * 60 * 1000);
    });
  }

  it('recovers when a failing answer is followed by a good one', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet({
      a: [
        { fail: new TypeError('fetch failed') },
        { status: 200, body: 'x' },
        { status: 200, integrity: integrityOf('a') }
      ]
    });
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.deepEqual(result.published, ['a@1.0.0']);
  });

  it('gives every request an abort signal bounded by the per-request timeout', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const network = fakeNet();
    await publishAll({ directory: dir, run, log: quiet, ...network });
    const { signal } = network.urls[0].init;
    assert.ok(signal instanceof AbortSignal);
    assert.ok(READ_BACK_REQUEST_TIMEOUT_MS <= 60 * 1000);
    // A fetch that honours the signal rejects once it fires.
    const stalled = AbortSignal.timeout(5);
    await assert.rejects(
      new Promise((_, reject) => stalled.addEventListener('abort', () => reject(stalled.reason))),
      (err) => err.name === 'TimeoutError'
    );
  });
});

describe('re-run inside the registry validation window', () => {
  const refusal = {
    status: 1,
    stdout: '',
    stderr:
      'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/a - You cannot publish over the previously published versions: 1.0.0.'
  };

  it('treats an already-published refusal as a read-back, passing when integrity matches', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: refusal } });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.skipped, ['a@1.0.0']);
    assert.deepEqual(result.failures, []);
  });

  it('fails the refusal when the registry copy has different contents', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: refusal } });
    const network = fakeNet({ a: [{ status: 200, integrity: 'sha512-BBBB' }] });
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.deepEqual(result.failures, ['a@1.0.0']);
  });

  it('waits for the version to list after the refusal', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: refusal } });
    const network = fakeNet({ a: [{ status: 404 }, { status: 200, integrity: integrityOf('a') }] });
    const result = await publishAll({ directory: dir, run, log: quiet, ...network });
    assert.deepEqual(result.skipped, ['a@1.0.0']);
  });

  it('still fails an unrelated publish error', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({
      publishes: {
        a: { status: 1, stdout: '', stderr: 'npm error code E403\nForbidden - bad token' }
      }
    });
    const result = await publishAll({ directory: dir, ...net(), run, log: quiet });
    assert.deepEqual(result.failures, ['a@1.0.0']);
  });
});

describe('main', () => {
  it('exits non-zero listing the failed packages', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun({ publishes: { a: { status: 1, stdout: '', stderr: 'boom' } } });
    const lines = [];
    const code = await main({
      env: { TARBALL_DIRECTORY: dir },
      ...net(),
      run,
      log: (l) => lines.push(l)
    });
    assert.equal(code, 1);
    assert.match(lines.join('\n'), /Failed to publish: a@1\.0\.0/);
  });

  it('exits zero when everything publishes and never logs the environment', async () => {
    writeManifest([entry('a')]);
    const { run } = fakeRun();
    const lines = [];
    const code = await main({
      env: { TARBALL_DIRECTORY: dir, SOME_SECRET: 'hunter2' },
      ...net(),
      run,
      log: (l) => lines.push(l)
    });
    assert.equal(code, 0);
    assert.doesNotMatch(lines.join('\n'), /hunter2/);
  });
});

describe('meetsMinimum', () => {
  it('compares versions numerically', async () => {
    assert.equal(meetsMinimum('11.5.1', '11.5.1'), true);
    assert.equal(meetsMinimum('11.10.0', '11.5.1'), true);
    assert.equal(meetsMinimum('10.9.9', '11.5.1'), false);
    assert.equal(meetsMinimum('garbage', '11.5.1'), false);
  });
});
