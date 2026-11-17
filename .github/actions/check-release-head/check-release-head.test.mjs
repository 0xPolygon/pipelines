import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { main } from './check-release-head.mjs';

const SHA = 'a'.repeat(40);
const NEWER = 'b'.repeat(40);

const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-head-'));
  mkdirSync(join(dir, '.changeset'));
  for (const name of files) writeFileSync(join(dir, '.changeset', name), '');
  return dir;
};

const headIs = (sha) => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ object: { sha } }) };
  };
  return { fetchImpl, urls };
};

const run = async ({ files, fetchImpl, ref = 'refs/heads/main' }) => {
  const lines = [];
  const outputs = {};
  const code = await main({
    env: { REF: ref, SHA, REPOSITORY: 'o/r', GITHUB_TOKEN: 't' },
    cwd: repo(files),
    fetchImpl,
    log: (l) => lines.push(l),
    setOutput: (name, value) => {
      outputs[name] = value;
    }
  });
  return { code, outputs, out: lines.join('\n') };
};

describe('release head check', () => {
  it('is superseded when changesets are pending and the branch has moved', async () => {
    const { code, outputs, out } = await run({
      files: ['README.md', 'config.json', 'a-change.md'],
      fetchImpl: headIs(NEWER).fetchImpl
    });
    assert.equal(code, 0);
    assert.equal(outputs.superseded, 'true');
    assert.match(out, /::notice::Release PR left untouched/);
  });

  it('is not superseded when the run commit is still the head', async () => {
    const { code, outputs } = await run({
      files: ['a-change.md'],
      fetchImpl: headIs(SHA).fetchImpl
    });
    assert.equal(code, 0);
    assert.equal(outputs.superseded, 'false');
  });

  it('never skips a run with no changesets pending, and does not ask GitHub', async () => {
    const { fetchImpl, urls } = headIs(NEWER);
    const { code, outputs } = await run({ files: ['README.md', 'config.json'], fetchImpl });
    assert.equal(code, 0);
    assert.equal(outputs.superseded, 'false');
    assert.deepEqual(urls, []);
  });

  it('does not apply the check in pre mode', async () => {
    const { fetchImpl, urls } = headIs(NEWER);
    const { code, outputs } = await run({ files: ['a-change.md', 'pre.json'], fetchImpl });
    assert.equal(code, 0);
    assert.equal(outputs.superseded, 'false');
    assert.deepEqual(urls, []);
  });

  it('reads the ref of a branch whose name has a slash', async () => {
    const { fetchImpl, urls } = headIs(SHA);
    await run({ files: ['a-change.md'], fetchImpl, ref: 'refs/heads/release/v1' });
    assert.deepEqual(urls, ['https://api.github.com/repos/o/r/git/ref/heads/release/v1']);
  });

  it('fails when the branch head cannot be read', async () => {
    const { code, outputs, out } = await run({
      files: ['a-change.md'],
      fetchImpl: async () => ({ ok: false, status: 503 })
    });
    assert.equal(code, 1);
    assert.equal(outputs.superseded, undefined);
    assert.match(out, /::error::Could not read the head of main: GitHub answered 503/);
  });

  it('fails when the run is not for a branch', async () => {
    const { code } = await run({
      files: ['a-change.md'],
      fetchImpl: headIs(SHA).fetchImpl,
      ref: 'refs/tags/v1'
    });
    assert.equal(code, 1);
  });
});
