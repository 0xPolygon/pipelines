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
writePackage('.', { name: 'root', version: '3.1.0' });
writePackage('packages/pub', { name: '@s/pub', version: '1.0.0' });
writePackage('packages/priv', { name: '@s/priv', version: '2.0.0-beta.1', private: true });

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
const check = (artifact, { sha = SHA } = {}) =>
  validateArtifact({
    text: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
    workspace,
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

  it('the root package may use v<version>, other packages may not', () => {
    const root = { tag: 'v3.1.0', packageName: 'root', directory: '.' };
    assert.deepEqual(check({ tags: [{ ...root, commit: SHA }], expected: [root] }).errors, []);
    failsWith(
      { tags: [], expected: [expected({ tag: 'v2.0.0-beta.1' })] },
      /not the package.json name and version/
    );
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

  it('main reads its inputs from the environment and reports through the log', () => {
    const file = join(scratch, 'tags.json');
    const run = (env) => {
      const logs = [];
      return { code: main({ env, log: (m) => logs.push(m) }), logs };
    };
    writeFileSync(file, JSON.stringify({ tags: [created()], expected: [] }));
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
