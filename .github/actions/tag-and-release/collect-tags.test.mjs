import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { collectTags, expectedTags, expectedTagsFor, main } from './collect-tags.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'collect-tags-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;
const ndjson = () => join(scratch, `out${counter++}.ndjson`);

const COMMIT = 'a'.repeat(40);
const line = (tag, packageName) => JSON.stringify({ type: 'git-tag', tag, packageName });

/**
 * Fake command runner. `existing` tags are at HEAD before the CLI runs;
 * `cli` decides what the CLI writes and which tags it creates.
 */
function fakeRun({
  existing = [],
  created = [],
  written,
  cliStatus = 0,
  projects = [],
  version = '3.0.3'
}) {
  const calls = [];
  let tags = [...existing];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, env: options.env });
    if (args.includes('--version')) return { status: 0, stdout: `${version}\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${COMMIT}\n`, stderr: '' };
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
        { tag: '@s/pub@1.0.0', packageName: '@s/pub', directory: 'packages/pub', commit: COMMIT },
        { tag: '@s/priv@2.0.0', packageName: '@s/priv', directory: 'packages/priv', commit: COMMIT }
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
      tags: [{ tag: 'v1.2.3', packageName: 'root', directory: '.', commit: COMMIT }]
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

  it('a HEAD that cannot be resolved fails', () => {
    const { run } = fakeRun({ projects });
    const noHead = (command, args, options) =>
      args[0] === 'rev-parse' ? { status: 1, stdout: '', stderr: '' } : run(command, args, options);
    assert.throws(() => collectTags({ run: noHead, ndjsonPath: ndjson(), root }), /resolve HEAD/);
  });

  it('a tag for a package missing from the workspace fails', () => {
    const { run } = fakeRun({ created: [['@s/x@1.0.0', '@s/x']], projects });
    assert.throws(() => collectTags({ run, ndjsonPath: ndjson(), root }), /not in the workspace/);
  });

  it('main writes the tags file with the expected set and fails without TAGS_FILE', async () => {
    const { run } = fakeRun({ created: [['v1.0.0', 'root']], projects });
    const logs = [];
    const tagsFile = join(scratch, 'sub', 'tags.json');
    const loadContext = async () => ({ cliMajor: 3, config: config(), packages: workspace() });
    assert.equal(
      await main({ env: { TAGS_FILE: tagsFile }, run, log: (m) => logs.push(m), loadContext }),
      0
    );
    assert.ok(existsSync(tagsFile));
    const written = JSON.parse(readFileSync(tagsFile, 'utf8'));
    assert.equal(written.tags[0].tag, 'v1.0.0');
    assert.equal(written.tags[0].commit, COMMIT);
    assert.deepEqual(
      written.expected.map(({ tag, packageName }) => ({ tag, packageName })),
      [{ tag: '@s/pub@1.0.0', packageName: '@s/pub' }]
    );
    assert.deepEqual(Object.keys(written.expected[0]).sort(), ['directory', 'packageName', 'tag']);
    assert.equal(await main({ env: {}, run, log: (m) => logs.push(m) }), 1);
  });

  it('main fails, and writes nothing, when the expected set cannot be derived', async () => {
    const { run } = fakeRun({ created: [], projects });
    const tagsFile = join(scratch, 'none', 'tags.json');
    const logs = [];
    const loadContext = async () => {
      throw new Error('read failed');
    };
    assert.equal(
      await main({ env: { TAGS_FILE: tagsFile }, run, log: (m) => logs.push(m), loadContext }),
      1
    );
    assert.equal(existsSync(tagsFile), false);
    assert.match(logs.join('\n'), /read failed/);
  });
});

const pkgEntry = (name, version, extra = {}) => ({
  dir: `/repo/packages/${name.replace(/^@s\//, '')}`,
  packageJson: { name, version, ...extra }
});
const workspace = (packages = [pkgEntry('@s/pub', '1.0.0')], type = 'pnpm') => ({
  tool: { type },
  packages
});
const config = ({ ignore = [], tag = false } = {}) => ({ ignore, privatePackages: { tag } });

describe('expectedTagsFor', () => {
  const all = [
    pkgEntry('@s/pub', '1.0.0'),
    pkgEntry('@s/ign', '2.0.0'),
    pkgEntry('@s/priv', '3.0.0', { private: true }),
    pkgEntry('@s/noversion', undefined)
  ];

  it('expects public packages that are not ignored and have a version', () => {
    const out = expectedTagsFor({
      packages: workspace(all),
      config: config({ ignore: ['@s/ign'] }),
      root: '/repo'
    });
    assert.deepEqual(out, [
      { tag: '@s/pub@1.0.0', packageName: '@s/pub', directory: 'packages/pub' }
    ]);
  });

  it('expects a private package only when privatePackages.tag is true', () => {
    const names = (cfg) =>
      expectedTagsFor({ packages: workspace(all), config: cfg, root: '/repo' }).map(
        (e) => e.packageName
      );
    assert.deepEqual(names(config({ ignore: ['@s/ign'] })), ['@s/pub']);
    assert.deepEqual(names(config({ ignore: ['@s/ign'], tag: true })), ['@s/pub', '@s/priv']);
  });

  // Ignore lists below are what @changesets/cli 3.0.3 expanded for the same
  // entries over @s/alpha, @s/keep, @t/gamma and delta.
  it('uses the CLI-expanded ignore list: scope glob, negation, glob and exact name', () => {
    const four = [
      pkgEntry('@s/alpha', '1.0.0'),
      pkgEntry('@s/keep', '1.0.0'),
      pkgEntry('@t/gamma', '1.0.0'),
      pkgEntry('delta', '1.0.0')
    ];
    const names = (ignore) =>
      expectedTagsFor({ packages: workspace(four), config: config({ ignore }), root: '/repo' }).map(
        (e) => e.packageName
      );
    assert.deepEqual(names(['@s/alpha', '@s/keep']), ['@t/gamma', 'delta']);
    assert.deepEqual(names(['@s/alpha']), ['@s/keep', '@t/gamma', 'delta']);
    assert.deepEqual(names(['@t/gamma', 'delta']), ['@s/alpha', '@s/keep']);
  });

  it('names the single-package root tag v<version>', () => {
    const out = expectedTagsFor({
      packages: workspace(
        [{ dir: '/repo', packageJson: { name: 'root', version: '1.2.3' } }],
        'root'
      ),
      config: config(),
      root: '/repo'
    });
    assert.deepEqual(out, [{ tag: 'v1.2.3', packageName: 'root', directory: '.' }]);
  });
});

describe('expectedTags', () => {
  it('fails closed unless the CLI is major 3 and agrees with the installed package', async () => {
    const loadContext = async () => ({ cliMajor: 3, config: config(), packages: workspace() });
    assert.equal(
      (await expectedTags({ run: fakeRun({}).run, root: '/repo', loadContext })).length,
      1
    );
    await assert.rejects(
      expectedTags({ run: fakeRun({ version: '2.30.0' }).run, root: '/repo', loadContext }),
      /major 3/
    );
    await assert.rejects(
      expectedTags({ run: fakeRun({ version: '' }).run, root: '/repo', loadContext }),
      /found none/
    );
    await assert.rejects(
      expectedTags({
        run: fakeRun({}).run,
        root: '/repo',
        loadContext: async () => ({ cliMajor: 2, config: config(), packages: workspace() })
      }),
      /installed package is major 2/
    );
  });
});
