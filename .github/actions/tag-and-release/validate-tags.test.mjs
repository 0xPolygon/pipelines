import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { main, validateArtifact } from './validate-tags.mjs';

const SHA = 'a'.repeat(40);
const scratch = mkdtempSync(join(tmpdir(), 'validate-tags-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const workspace = join(scratch, 'ws');
const writePackage = (directory, json) => {
  mkdirSync(join(workspace, directory), { recursive: true });
  writeFileSync(join(workspace, directory, 'package.json'), JSON.stringify(json));
};
const writeFile = (ws, name, text) => {
  mkdirSync(join(ws, ...name.split('/').slice(0, -1)), { recursive: true });
  writeFileSync(join(ws, name), text);
};
writePackage('.', { name: 'root', version: '3.1.0' });
writePackage('packages/pub', { name: '@s/pub', version: '1.0.0' });
writePackage('packages/priv', { name: '@s/priv', version: '2.0.0-beta.1', private: true });
writePackage('packages/skipped', { name: '@s/skipped', version: '1.0.0' });
writePackage('examples/demo', { name: '@s/demo', version: '1.0.0' });
writeFile(workspace, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
writeFile(
  workspace,
  '.changeset/config.json',
  JSON.stringify({
    ignore: ['@s/skipped', '@s/glob-*'],
    privatePackages: { version: true, tag: true }
  })
);

const created = (overrides = {}) => ({
  tag: '@s/pub@1.0.0',
  packageName: '@s/pub',
  directory: 'packages/pub',
  commit: SHA,
  ...overrides
});
const expected = (overrides = {}) => ({
  tag: '@s/priv@2.0.0-beta.1',
  packageName: '@s/priv',
  directory: 'packages/priv',
  ...overrides
});
const check = (artifact, { sha = SHA, ws = workspace } = {}) =>
  validateArtifact({
    text: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
    workspace: ws,
    sha
  });
const failsWith = (artifact, pattern, options) => {
  const { errors } = check(artifact, options);
  assert.ok(errors.length > 0, 'expected a failure');
  assert.match(errors.join('\n'), pattern);
};

describe('validate-tags', () => {
  it('a valid artifact passes', () => {
    const result = check({
      tags: [created()],
      expected: [
        expected(),
        expected({
          tag: '@s/pub@1.0.0',
          packageName: '@s/pub',
          directory: 'packages/pub'
        })
      ]
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.tags.length, 1);
    assert.equal(result.expected.length, 2);
  });

  it('an empty artifact passes as nothing to tag', () => {
    assert.deepEqual(check({ tags: [], expected: [] }).errors, []);
  });

  it('the root package of a single-package repository may use v<version>, other packages may not', () => {
    const single = join(scratch, 'single');
    mkdirSync(single, { recursive: true });
    writeFileSync(join(single, 'package.json'), JSON.stringify({ name: 'root', version: '3.1.0' }));
    writeFile(single, '.changeset/config.json', '{}');
    const root = { tag: 'v3.1.0', packageName: 'root', directory: '.' };
    assert.deepEqual(
      check({ tags: [{ ...root, commit: SHA }], expected: [root] }, { ws: single }).errors,
      []
    );
    failsWith(
      { tags: [], expected: [expected({ tag: 'v2.0.0-beta.1' })] },
      /not the package.json name and version/
    );
  });

  it('v<version> is refused for the root of a repository that has a workspace file', () => {
    const root = { tag: 'v3.1.0', packageName: 'root', directory: '.' };
    failsWith({ tags: [{ ...root, commit: SHA }], expected: [root] }, /not a workspace package/);
  });

  it('malformed JSON fails', () => {
    failsWith('{not json', /not valid JSON/);
    failsWith('null', /exactly a "tags" and an "expected" list/);
    failsWith({ tags: [] }, /exactly a "tags" and an "expected" list/);
    failsWith({ tags: [], expected: {} }, /exactly a "tags" and an "expected" list/);
  });

  it('a wrong-shape entry fails, in either list', () => {
    failsWith({ tags: [{ ...created(), extra: 1 }], expected: [] }, /tags\[0\].*wrong shape/);
    failsWith(
      { tags: [], expected: [{ ...expected(), commit: SHA }] },
      /expected\[0\].*wrong shape/
    );
    failsWith({ tags: [created({ directory: 5 })], expected: [] }, /non-string/);
    failsWith({ tags: ['x', null], expected: [] }, /wrong shape/);
    failsWith({ tags: [created({ packageName: 'UPPER' })], expected: [] }, /invalid package name/);
  });

  it("a commit that is not this run's commit fails", () => {
    failsWith(
      { tags: [created({ commit: 'b'.repeat(40) })], expected: [] },
      /commit that is not this run/
    );
    failsWith({ tags: [created()], expected: [] }, /commit that is not this run/, {
      sha: 'c'.repeat(40)
    });
  });

  it('a packageName or directory that differs from package.json fails', () => {
    failsWith(
      { tags: [created({ packageName: '@s/other' })], expected: [] },
      /differs from package.json/
    );
    failsWith(
      { tags: [], expected: [expected({ directory: 'packages/pub' })] },
      /differs from package.json/
    );
    failsWith(
      { tags: [created({ directory: 'packages/nope' })], expected: [] },
      /outside the workspace/
    );
  });

  it('a tag whose version differs from package.json fails', () => {
    failsWith(
      { tags: [created({ tag: '@s/pub@9.9.9' })], expected: [] },
      /not the package.json name and version/
    );
    failsWith(
      { tags: [], expected: [expected({ tag: '@s/priv@2.0.0' })] },
      /not the package.json name and version/
    );
  });

  it('a directory that leaves the workspace fails', () => {
    mkdirSync(join(scratch, 'outside'), { recursive: true });
    writeFileSync(
      join(scratch, 'outside', 'package.json'),
      JSON.stringify({ name: '@s/pub', version: '1.0.0' })
    );
    symlinkSync(join(scratch, 'outside'), join(workspace, 'link'));
    for (const directory of ['..', '../outside', '/etc', 'link', 'packages\\pub', '']) {
      failsWith({ tags: [created({ directory })], expected: [] }, /outside the workspace/);
    }
  });

  it('a repeated tag in one list fails', () => {
    failsWith({ tags: [created(), created()], expected: [] }, /repeats an earlier tag/);
  });

  it('lists every bad entry in one error', () => {
    const { errors } = check({
      tags: [created({ tag: '@s/pub@9.9.9' })],
      expected: [expected({ packageName: '@s/x' })]
    });
    assert.ok(errors.some((e) => e.startsWith('tags[0]')));
    assert.ok(errors.some((e) => e.startsWith('expected[0]')));
  });

  it('a created tag that is not in the expected list fails', () => {
    failsWith({ tags: [created()], expected: [] }, /not in the expected list/);
    failsWith({ tags: [created()], expected: [expected()] }, /not in the expected list/);
  });

  it('a package listed by literal name under ignore fails, in either list', () => {
    const skipped = {
      tag: '@s/skipped@1.0.0',
      packageName: '@s/skipped',
      directory: 'packages/skipped'
    };
    failsWith({ tags: [{ ...skipped, commit: SHA }], expected: [skipped] }, /ignores/);
    failsWith({ tags: [], expected: [skipped] }, /ignores/);
  });

  it('a private package fails when privatePackages is false, tag is false or the setting is absent', () => {
    for (const privatePackages of [false, { version: true, tag: false }, undefined]) {
      const ws = join(
        scratch,
        `priv-${JSON.stringify(privatePackages) ?? 'absent'}`.replace(/\W/g, '_')
      );
      writeFile(ws, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
      writeFile(
        ws,
        'packages/priv/package.json',
        JSON.stringify({ name: '@s/priv', version: '2.0.0-beta.1', private: true })
      );
      writeFile(ws, '.changeset/config.json', JSON.stringify({ privatePackages }));
      const { errors } = check({ tags: [], expected: [expected()] }, { ws });
      assert.match(errors.join('\n'), /private package that .changeset\/config.json does not tag/);
    }
    assert.deepEqual(check({ tags: [], expected: [expected()] }).errors, []);
  });

  it('an unreadable or missing .changeset/config.json fails closed', () => {
    const ws = join(scratch, 'noconfig');
    writeFile(ws, 'pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    writeFile(
      ws,
      'packages/pub/package.json',
      JSON.stringify({ name: '@s/pub', version: '1.0.0' })
    );
    failsWith({ tags: [], expected: [] }, /config.json is not readable/, { ws });
    writeFile(ws, '.changeset/config.json', '{nope');
    failsWith({ tags: [], expected: [] }, /config.json is not readable/, { ws });
  });

  it('a package.json outside the workspace globs fails (a committed example is not a workspace package)', () => {
    failsWith(
      {
        tags: [],
        expected: [{ tag: '@s/demo@1.0.0', packageName: '@s/demo', directory: 'examples/demo' }]
      },
      /not a workspace package/
    );
    failsWith({ tags: [], expected: [expected({ directory: 'packages/priv/..' })] }, /workspace/);
  });

  it('workspace patterns: dir/*, dir/**, literal paths and ! exclusions are evaluated', () => {
    const ws = join(scratch, 'globs');
    writeFile(
      ws,
      'pnpm-workspace.yaml',
      "# comment\npackages:\n  - 'a/*'   # direct children\n  - \"b/**\"\n  - c/lib\n  - '!a/excluded'\n\ncatalog:\n  x: 1\n"
    );
    writeFile(ws, '.changeset/config.json', '{}');
    const dirs = [
      'a/one',
      'a/excluded',
      'a/one/deep',
      'b/x',
      'b/x/y',
      'c/lib',
      'c/other',
      'node_modules/p'
    ];
    for (const dir of dirs) {
      writeFile(ws, `${dir}/package.json`, JSON.stringify({ name: 'p', version: '1.0.0' }));
    }
    const verdict = (directory) =>
      check({ tags: [], expected: [{ tag: 'p@1.0.0', packageName: 'p', directory }] }, { ws })
        .errors.length === 0;
    assert.deepEqual(dirs.map(verdict), [true, false, false, true, true, true, false, false]);
  });

  it('a workspace pattern shape that cannot be evaluated fails closed', () => {
    for (const body of [
      "packages:\n  - 'a/{x,y}'\n",
      "packages:\n  - 'a/*/b'\n",
      "packages:\n  - 'a/[xy]'\n",
      "packages: ['a/*/b']\n",
      'packages: [a/*, b/{c,d}]\n',
      'packages:\n  - a/*\n  - "!a/*/b"\n  - a/**/c\n',
      'packages: []\n',
      'packages: a/*\n'
    ]) {
      const ws = join(
        scratch,
        `bad-${Math.abs([...body].reduce((h, c) => h * 31 + c.charCodeAt(0), 7))}`
      );
      writeFile(ws, 'pnpm-workspace.yaml', body);
      writeFile(ws, '.changeset/config.json', '{}');
      writeFile(ws, 'a/x/package.json', JSON.stringify({ name: 'p', version: '1.0.0' }));
      failsWith(
        { tags: [], expected: [{ tag: 'p@1.0.0', packageName: 'p', directory: 'a/x' }] },
        /cannot be evaluated|cannot be read|not a block or flow list|empty packages list/,
        { ws }
      );
    }
  });

  it('no workspace file, or a settings-only one, means the root is the only package', () => {
    for (const [name, files] of [
      ['none', {}],
      [
        'settings-only',
        { 'pnpm-workspace.yaml': 'minimumReleaseAge: 1440\nblockExoticSubdeps: true\n' }
      ]
    ]) {
      const ws = join(scratch, `root-only-${name}`);
      for (const [file, body] of Object.entries(files)) writeFile(ws, file, body);
      writeFile(ws, '.changeset/config.json', '{}');
      writeFile(ws, 'package.json', JSON.stringify({ name: 'solo', version: '1.2.3' }));
      writeFile(ws, 'a/x/package.json', JSON.stringify({ name: 'solo', version: '1.2.3' }));
      const root = { tag: 'solo@1.2.3', packageName: 'solo', directory: '.' };
      assert.deepEqual(check({ tags: [], expected: [root] }, { ws }).errors, [], name);
      assert.deepEqual(
        check({ tags: [], expected: [{ ...root, directory: 'a/x' }] }, { ws }).errors.length > 0,
        true,
        `${name}: a subdirectory is not a package`
      );
    }
  });

  it('a one-line flow list is read, including the root', () => {
    const ws = join(scratch, 'flow');
    writeFile(ws, 'pnpm-workspace.yaml', 'packages: [\'.\', a/*, "b/**"] # members\n');
    writeFile(ws, '.changeset/config.json', '{}');
    for (const dir of ['.', 'a/x', 'b/y/z']) {
      writeFile(ws, `${dir}/package.json`, JSON.stringify({ name: 'p', version: '1.0.0' }));
    }
    for (const directory of ['.', 'a/x', 'b/y/z']) {
      const entry = { tag: 'p@1.0.0', packageName: 'p', directory };
      assert.deepEqual(check({ tags: [], expected: [entry] }, { ws }).errors, [], directory);
    }
  });

  it('a block list with a ! exclusion is evaluated', () => {
    const ws = join(scratch, 'negation');
    writeFile(ws, 'pnpm-workspace.yaml', "packages:\n  - 'pkgs/**'\n  - '!pkgs/test/**'\n");
    writeFile(ws, '.changeset/config.json', '{}');
    for (const dir of ['pkgs/a', 'pkgs/test/b']) {
      writeFile(ws, `${dir}/package.json`, JSON.stringify({ name: 'p', version: '1.0.0' }));
    }
    const ok = (directory) =>
      check({ tags: [], expected: [{ tag: 'p@1.0.0', packageName: 'p', directory }] }, { ws })
        .errors.length === 0;
    assert.deepEqual(['pkgs/a', 'pkgs/test/b'].map(ok), [true, false]);
  });

  it('declared workspaces without a pnpm-workspace.yaml fail closed', () => {
    const ws = join(scratch, 'npm-workspaces');
    writeFile(
      ws,
      'package.json',
      JSON.stringify({ name: 'root', version: '1.0.0', workspaces: ['a/*'] })
    );
    writeFile(ws, '.changeset/config.json', '{}');
    failsWith({ tags: [], expected: [] }, /workspaces without a pnpm-workspace.yaml/, { ws });
  });

  it('main reads its inputs from the environment and reports through the log', () => {
    const file = join(scratch, 'tags.json');
    const run = (env) => {
      const logs = [];
      return { code: main({ env, log: (m) => logs.push(m) }), logs };
    };
    writeFileSync(
      file,
      JSON.stringify({
        tags: [created()],
        expected: [
          expected({ tag: '@s/pub@1.0.0', packageName: '@s/pub', directory: 'packages/pub' })
        ]
      })
    );
    const base = { TAGS_FILE: file, GITHUB_WORKSPACE: workspace, GITHUB_SHA: SHA };
    assert.equal(run(base).code, 0);
    assert.equal(run({ ...base, GITHUB_SHA: 'b'.repeat(40) }).code, 1);
    assert.equal(run({ ...base, TAGS_FILE: join(scratch, 'absent.json') }).code, 1);
    for (const key of Object.keys(base)) {
      const { [key]: _removed, ...rest } = base;
      assert.equal(run(rest).code, 1, key);
    }
  });
});
