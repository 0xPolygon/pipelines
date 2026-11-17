import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { collectTags, main } from './collect-tags.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'collect-tags-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const ndjson = () => join(scratch, `out${counter++}.ndjson`);

const line = (tag, packageName) => JSON.stringify({ type: 'git-tag', tag, packageName });

/**
 * Fake command runner. `existing` tags are at HEAD before the CLI runs;
 * `cli` decides what the CLI writes and which tags it creates.
 */
function fakeRun({ existing = [], created = [], written, cliStatus = 0, projects = [] }) {
  const calls = [];
  let tags = [...existing];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    if (command === 'git') return { status: 0, stdout: tags.join('\n'), stderr: '' };
    if (args[0] === 'ls') return { status: 0, stdout: JSON.stringify(projects), stderr: '' };
    writeFileSync(
      options.env.CHANGESETS_OUTPUT,
      written ?? created.map(([t, n]) => line(t, n)).join('\n')
    );
    tags = [...tags, ...created.map(([t]) => t)];
    return { status: cliStatus, stdout: '', stderr: '' };
  };
  return { run, calls };
}

const root = '/repo';
const projects = [
  { name: 'root', path: '/repo' },
  { name: '@s/pub', path: '/repo/packages/pub' },
  { name: '@s/priv', path: '/repo/packages/priv' }
];

describe('collect-tags', () => {
  it('collects public and private tags with their package directories', () => {
    const { run } = fakeRun({
      created: [
        ['@s/pub@1.0.0', '@s/pub'],
        ['@s/priv@2.0.0', '@s/priv']
      ],
      projects
    });
    assert.deepEqual(collectTags({ run, ndjsonPath: ndjson(), root }), {
      tags: [
        { tag: '@s/pub@1.0.0', packageName: '@s/pub', directory: 'packages/pub' },
        { tag: '@s/priv@2.0.0', packageName: '@s/priv', directory: 'packages/priv' }
      ]
    });
  });

  it('nothing to tag gives an empty list', () => {
    const { run } = fakeRun({ created: [], projects });
    assert.deepEqual(collectTags({ run, ndjsonPath: ndjson(), root }), { tags: [] });
  });

  it('an output file and git that disagree fail', () => {
    const missingTag = fakeRun({ created: [], written: line('@s/pub@1.0.0', '@s/pub'), projects });
    assert.throws(() => collectTags({ run: missingTag.run, ndjsonPath: ndjson(), root }), /differ/);
    const extraTag = fakeRun({ created: [['@s/pub@1.0.0', '@s/pub']], written: '', projects });
    assert.throws(() => collectTags({ run: extraTag.run, ndjsonPath: ndjson(), root }), /differ/);
  });

  it('a non-zero CLI exit fails', () => {
    const { run } = fakeRun({ cliStatus: 1, projects });
    assert.throws(() => collectTags({ run, ndjsonPath: ndjson(), root }), /status 1/);
  });

  it('a malformed output line fails', () => {
    const { run } = fakeRun({ written: '{not json', projects });
    assert.throws(() => collectTags({ run, ndjsonPath: ndjson(), root }), /not valid JSON/);
  });

  it('a pre-existing local tag at HEAD is not counted as created', () => {
    const { run } = fakeRun({ existing: ['@s/pub@1.0.0'], created: [], projects });
    assert.deepEqual(collectTags({ run, ndjsonPath: ndjson(), root }), { tags: [] });
  });

  it('a single-package v<version> tag is collected for the root package', () => {
    const { run } = fakeRun({ created: [['v1.2.3', 'root']], projects });
    assert.deepEqual(collectTags({ run, ndjsonPath: ndjson(), root }), {
      tags: [{ tag: 'v1.2.3', packageName: 'root', directory: '.' }]
    });
  });

  it('creates the output file empty before the CLI runs and passes only the output and prompt variables', () => {
    const path = ndjson();
    writeFileSync(path, 'stale');
    let seen;
    const { run, calls } = fakeRun({ created: [], projects });
    const wrapped = (command, args, options) => {
      if (command === 'pnpm' && args[0] === 'exec') seen = readFileSync(path, 'utf8');
      return run(command, args, options);
    };
    collectTags({ run: wrapped, ndjsonPath: path, root });
    assert.equal(seen, '');
    const cli = calls.find((c) => c.args[0] === 'exec');
    assert.deepEqual(cli.env, { CHANGESETS_OUTPUT: path, GIT_TERMINAL_PROMPT: '0' });
  });

  it('a tag for a package missing from the workspace fails', () => {
    const { run } = fakeRun({ created: [['@s/x@1.0.0', '@s/x']], projects });
    assert.throws(() => collectTags({ run, ndjsonPath: ndjson(), root }), /not in the workspace/);
  });

  it('main writes the tags file and fails without TAGS_FILE', () => {
    const { run } = fakeRun({ created: [['v1.0.0', 'root']], projects });
    const logs = [];
    const tagsFile = join(scratch, 'sub', 'tags.json');
    assert.equal(main({ env: { TAGS_FILE: tagsFile }, run, log: (m) => logs.push(m) }), 0);
    assert.ok(existsSync(tagsFile));
    assert.equal(JSON.parse(readFileSync(tagsFile, 'utf8')).tags[0].tag, 'v1.0.0');
    assert.equal(main({ env: {}, run, log: (m) => logs.push(m) }), 1);
  });
});
