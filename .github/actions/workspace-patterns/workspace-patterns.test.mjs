import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { isWorkspaceDirectory, readWorkspacePatterns } from './workspace-patterns.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'ws-patterns-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
function dir({ yaml, pkg = { name: 'root', version: '1.0.0' } }) {
  const root = join(scratch, `d${counter++}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify(pkg));
  if (yaml !== undefined) writeFileSync(join(root, 'pnpm-workspace.yaml'), yaml);
  return root;
}

describe('workspace-patterns', () => {
  it('no workspace file and a settings-only file mean the root only', () => {
    assert.equal(readWorkspacePatterns(dir({})), null);
    assert.equal(readWorkspacePatterns(dir({ yaml: 'blockExoticSubdeps: true\n' })), null);
    assert.equal(isWorkspaceDirectory({ patterns: null, directory: '.' }), true);
    assert.equal(isWorkspaceDirectory({ patterns: null, directory: 'a' }), false);
  });

  it('reads block lists, flow lists and negations', () => {
    assert.deepEqual(readWorkspacePatterns(dir({ yaml: "packages:\n  - 'a/*'\n  - '!a/x'\n" })), [
      'a/*',
      '!a/x'
    ]);
    assert.deepEqual(readWorkspacePatterns(dir({ yaml: "packages: ['.', b/**]\n" })), [
      '.',
      'b/**'
    ]);
  });

  it('evaluates inclusion and exclusion', () => {
    const patterns = ['a/*', '!a/x', '.'];
    const ok = (directory) => isWorkspaceDirectory({ patterns, directory });
    assert.deepEqual(['.', 'a/y', 'a/x', 'a/y/z', 'b'].map(ok), [true, true, false, false, false]);
  });

  it('throws on anything it cannot evaluate', () => {
    for (const yaml of [
      "packages:\n  - 'a/*/b'\n",
      'packages: []\n',
      'packages: a/*\n',
      'packages:\n  - a/*\npackages:\n  - b/*\n',
      "packages:\n  - 'a/{x,y}'\n"
    ]) {
      assert.throws(() => readWorkspacePatterns(dir({ yaml })), Error, yaml);
    }
    assert.throws(
      () => readWorkspacePatterns(dir({ pkg: { name: 'r', workspaces: ['a/*'] } })),
      /workspaces without a pnpm-workspace.yaml/
    );
  });
});
