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

  it('evaluates `*` inside a path segment without crossing a slash', () => {
    const ok = (patterns, directory) => isWorkspaceDirectory({ patterns, directory });
    assert.deepEqual(
      ['pos-a', 'pos-', 'pos-a/x', 'pos', 'xpos-a'].map((d) => ok(['pos-*'], d)),
      [true, true, false, false, false]
    );
    assert.deepEqual(
      ['packages/app-web', 'packages/lib-web', 'packages/app-web/src'].map((d) =>
        ok(['packages/app-*'], d)
      ),
      [true, false, false]
    );
    assert.deepEqual(
      ['a/x/b', 'a/y/b', 'a/x/c', 'a/x/y/b'].map((d) => ok(['a/*/b'], d)),
      [true, true, false, false]
    );
    assert.equal(ok(['pos-*', '!pos-legacy'], 'pos-legacy'), false);
    assert.deepEqual(readWorkspacePatterns(dir({ yaml: "packages:\n  - 'pos-*'\n" })), ['pos-*']);
  });

  it('matches real `pnpm ls -r` for every supported pattern form', () => {
    // Expected sets were captured from `pnpm ls -r --depth -1 --json
    // --config.ignore-pnpmfile=true` (pnpm 10.33.3) on a scratch layout holding a
    // package.json in each of these directories. A wildcard never matches a
    // dot-prefixed directory, and `dir/**` includes `dir` itself.
    const layout = [
      'a',
      'a/one',
      'a/one/deep',
      'b',
      'b/x',
      'b/x/y',
      'pos-a',
      'pos-a/nested',
      'pos',
      'c/lib',
      'a/x/b',
      'a/y/b',
      'a/x/c',
      '.hid',
      'a/.hid',
      'pkgs',
      'pkgs/test',
      'pkgs/test/b',
      'pkgs/p'
    ];
    const captured = [
      [['a'], ['a']],
      [['./b'], ['b']],
      [['c/lib'], ['c/lib']],
      [['a/*'], ['a/one']],
      [['a/**'], ['a', 'a/one', 'a/one/deep', 'a/x/b', 'a/y/b', 'a/x/c']],
      [['pos-*'], ['pos-a']],
      [['a/*/b'], ['a/x/b', 'a/y/b']],
      [['*'], ['a', 'b', 'pos-a', 'pos', 'pkgs']],
      [
        ['**'],
        [
          'a',
          'a/one',
          'a/one/deep',
          'b',
          'b/x',
          'b/x/y',
          'pos-a',
          'pos-a/nested',
          'pos',
          'c/lib',
          'a/x/b',
          'a/y/b',
          'a/x/c',
          'pkgs',
          'pkgs/test',
          'pkgs/test/b',
          'pkgs/p'
        ]
      ],
      [
        ['pkgs/**', '!pkgs/test/**'],
        ['pkgs', 'pkgs/p']
      ],
      [['a/*', '!a/one'], []],
      [['pos-*', '!pos-a'], []],
      [
        ['a/x/*', 'b/**'],
        ['b', 'b/x', 'b/x/y', 'a/x/b', 'a/x/c']
      ]
    ];
    for (const [patterns, expected] of captured) {
      const got = layout.filter((directory) => isWorkspaceDirectory({ patterns, directory }));
      assert.deepEqual(got, expected, JSON.stringify(patterns));
    }
  });

  it('matches real `pnpm ls -r` on nested, node_modules, no-package.json and negation-order cases', () => {
    // Captured from `pnpm ls -r --depth -1 --json --config.ignore-pnpmfile=true`
    // (pnpm 10.33.3) on a layout with a package inside a package (pkgs/p1/inner),
    // node_modules packages, directories without a package.json (pkgs/grp,
    // pkgs/p3/q) and a dot-directory (pkgs/.dot).
    const layout = [
      'pkgs/p1',
      'pkgs/p1/inner',
      'pkgs/p1/node_modules/dep',
      'pkgs/p2',
      'pkgs/p2/a/b/c',
      'pkgs/grp/x',
      'pkgs/.dot/z',
      'pkgs/p3/q/r',
      'apps/web',
      'apps/web/node_modules/n',
      'libs/l1',
      'libs/l1/sub',
      'pos-a',
      'pos-b/inner',
      'pos-b/node_modules/m'
    ];
    const captured = [
      [['pkgs/*'], ['pkgs/p1', 'pkgs/p2']],
      [
        ['pkgs/**'],
        ['pkgs/p1', 'pkgs/p1/inner', 'pkgs/p2', 'pkgs/p2/a/b/c', 'pkgs/grp/x', 'pkgs/p3/q/r']
      ],
      [['pkgs/*/*'], ['pkgs/p1/inner', 'pkgs/grp/x']],
      [['pkgs/*/x'], ['pkgs/grp/x']],
      [['pkgs/p1/inner'], ['pkgs/p1/inner']],
      [
        ['pkgs/**', '!pkgs/p1'],
        ['pkgs/p1/inner', 'pkgs/p2', 'pkgs/p2/a/b/c', 'pkgs/grp/x', 'pkgs/p3/q/r']
      ],
      [
        ['pkgs/**', '!pkgs/p1/**'],
        ['pkgs/p2', 'pkgs/p2/a/b/c', 'pkgs/grp/x', 'pkgs/p3/q/r']
      ],
      [
        ['!pkgs/p1', 'pkgs/**'],
        ['pkgs/p1/inner', 'pkgs/p2', 'pkgs/p2/a/b/c', 'pkgs/grp/x', 'pkgs/p3/q/r']
      ],
      [['pkgs/*', '!pkgs/p1', '!pkgs/p2'], []],
      [
        ['**', '!apps/**'],
        [
          'pkgs/p1',
          'pkgs/p1/inner',
          'pkgs/p2',
          'pkgs/p2/a/b/c',
          'pkgs/grp/x',
          'pkgs/p3/q/r',
          'libs/l1',
          'libs/l1/sub',
          'pos-a',
          'pos-b/inner'
        ]
      ],
      [
        ['!apps/**', '**'],
        [
          'pkgs/p1',
          'pkgs/p1/inner',
          'pkgs/p2',
          'pkgs/p2/a/b/c',
          'pkgs/grp/x',
          'pkgs/p3/q/r',
          'libs/l1',
          'libs/l1/sub',
          'pos-a',
          'pos-b/inner'
        ]
      ],
      [
        ['apps/*', 'libs/*', 'pos-*'],
        ['apps/web', 'libs/l1', 'pos-a']
      ],
      [['pos-*/inner'], ['pos-b/inner']],
      [['*/inner'], ['pos-b/inner']],
      [['libs/**', '!libs/l1'], ['libs/l1/sub']],
      [['!pkgs/p1'], []],
      [['apps/web/node_modules/*'], []],
      [['pkgs/*/z'], []],
      [
        ['.', 'pkgs/*'],
        ['pkgs/p1', 'pkgs/p2']
      ]
    ];
    for (const [patterns, expected] of captured) {
      const got = layout.filter((directory) => isWorkspaceDirectory({ patterns, directory }));
      assert.deepEqual(got, expected, JSON.stringify(patterns));
    }
  });

  it('throws on anything it cannot evaluate', () => {
    for (const yaml of [
      "packages:\n  - 'a/**/b'\n",
      'packages: []\n',
      'packages: a/*\n',
      'packages:\n  - a/*\npackages:\n  - b/*\n',
      "packages:\n  - 'a/{x,y}'\n",
      "packages:\n  - '{a,b}/*'\n",
      "packages:\n  - 'a/?'\n",
      "packages:\n  - 'a/[xy]'\n",
      "packages:\n  - 'a/@(x|y)'\n",
      "packages:\n  - 'a/x**'\n",
      "packages:\n  - '**/x'\n",
      "packages:\n  - '!**/x'\n",
      "packages:\n  - 'a/*'\n  - '!a/{x,y}'\n"
    ]) {
      assert.throws(() => readWorkspacePatterns(dir({ yaml })), Error, yaml);
    }
    assert.throws(
      () => readWorkspacePatterns(dir({ pkg: { name: 'r', workspaces: ['a/*'] } })),
      /workspaces without a pnpm-workspace.yaml/
    );
  });
});
