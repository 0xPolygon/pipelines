import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { main } from './check-release-tags.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-release-tags-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeManifest = (entries) =>
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(entries));

/**
 * A fetch stub that answers 200 for the given decoded tags and for the Releases
 * of `releases` (default: every tag in `tags`), 404 otherwise.
 */
function fakeFetch({ tags = [], releases = tags, status } = {}) {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    if (status) return { status };
    if (url.includes('/releases/tags/')) {
      const tag = decodeURIComponent(url.split('/releases/tags/')[1]);
      return { status: releases.includes(tag) ? 200 : 404 };
    }
    const encoded = url.split('/git/ref/tags/')[1];
    return { status: tags.includes(decodeURIComponent(encoded)) ? 200 : 404 };
  };
  return { fetchImpl, urls };
}

function run(fetchImpl) {
  const logs = [];
  const env = {
    TARBALL_DIRECTORY: dir,
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_TOKEN: 't',
    GITHUB_WORKSPACE: dir
  };
  return main({ env, fetchImpl, log: (m) => logs.push(m) }).then((code) => ({ code, logs }));
}

describe('check-release-tags', () => {
  it('passes when every package has a multi-package tag', async () => {
    writeManifest([
      { name: '@s/a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' }
    ]);
    const { code } = await run(fakeFetch({ tags: ['@s/a@1.0.0', 'b@2.0.0'] }).fetchImpl);
    assert.equal(code, 0);
  });

  it('accepts the single-package v<version> form for the root package', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'solo' }));
    writeManifest([{ name: 'solo', version: '3.1.0' }]);
    const { code } = await run(fakeFetch({ tags: ['v3.1.0'] }).fetchImpl);
    assert.equal(code, 0);
  });

  it('fails with one error listing every missing tag', async () => {
    writeManifest([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' },
      { name: 'c', version: '3.0.0' }
    ]);
    const { code, logs } = await run(fakeFetch({ tags: ['b@2.0.0'] }).fetchImpl);
    assert.equal(code, 1);
    const errors = logs.filter((l) => l.startsWith('::error'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /a@1\.0\.0, c@3\.0\.0/);
    assert.doesNotMatch(errors[0], /b@2\.0\.0/);
  });

  it('fails on an API error other than 404 instead of calling the tag missing', async () => {
    writeManifest([{ name: 'a', version: '1.0.0' }]);
    const { code, logs } = await run(fakeFetch({ status: 500 }).fetchImpl);
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /HTTP 500/);
    assert.doesNotMatch(logs.join('\n'), /Release tags missing/);
  });

  it('URL-encodes tags containing @ and /', async () => {
    writeManifest([{ name: '@scope/pkg', version: '1.0.0' }]);
    const { fetchImpl, urls } = fakeFetch({ tags: ['@scope/pkg@1.0.0'] });
    const { code } = await run(fetchImpl);
    assert.equal(code, 0);
    assert.equal(urls[0], 'https://api.github.com/repos/o/r/git/ref/tags/%40scope%2Fpkg%401.0.0');
  });

  it('does not accept v<version> for a one-entry manifest that is not the root package', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'monorepo-root' }));
    writeManifest([{ name: 'pkg', version: '1.2.3' }]);
    const { code } = await run(fakeFetch({ tags: ['v1.2.3'] }).fetchImpl);
    assert.equal(code, 1);
  });

  it('does not accept v<version> when the manifest has several entries', async () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'a' }));
    writeManifest([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '1.0.0' }
    ]);
    const { code } = await run(fakeFetch({ tags: ['v1.0.0', 'b@1.0.0'] }).fetchImpl);
    assert.equal(code, 1);
  });

  it('fails when a tag exists but its GitHub Release does not', async () => {
    writeManifest([
      { name: 'a', version: '1.0.0' },
      { name: 'b', version: '2.0.0' }
    ]);
    const { code, logs } = await run(
      fakeFetch({ tags: ['a@1.0.0', 'b@2.0.0'], releases: ['b@2.0.0'] }).fetchImpl
    );
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /a@1\.0\.0 \(GitHub Release\)/);
    assert.doesNotMatch(logs.join('\n'), /b@2\.0\.0 \(/);
  });

  it('fails on a release API error other than 404', async () => {
    writeManifest([{ name: 'a', version: '1.0.0' }]);
    const fetchImpl = async (url) => ({ status: url.includes('/releases/') ? 502 : 200 });
    const { code, logs } = await run(fetchImpl);
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /release lookup.*HTTP 502/);
  });
});
