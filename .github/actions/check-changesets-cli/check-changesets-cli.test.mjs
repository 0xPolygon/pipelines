import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { checkChangesetsCli, main } from './check-changesets-cli.mjs';

const answer =
  (stdout, status = 0) =>
  () => ({ status, stdout, stderr: '' });

const scratch = mkdtempSync(join(tmpdir(), 'check-cli-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let counter = 0;
// Builds a repository on disk: a root package.json, optional workspace members,
// an optional pnpm-workspace.yaml and a `.changeset/config.json` (a string is
// written verbatim so invalid JSON can be tested; undefined writes no file).
function repo({ rootPrivate = false, members = [], workspace = false, config }) {
  const root = join(scratch, `r${counter++}`);
  mkdirSync(join(root, '.changeset'), { recursive: true });
  const write = (dir, pkg) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  };
  write(root, { name: 'root', version: '1.0.0', private: rootPrivate });
  const projects = [{ path: root }];
  for (const [name, isPrivate] of members) {
    const dir = join(root, 'packages', name);
    write(dir, { name, version: '1.0.0', private: isPrivate });
    projects.push({ path: dir });
  }
  if (workspace) writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  if (config !== undefined) {
    writeFileSync(
      join(root, '.changeset', 'config.json'),
      typeof config === 'string' ? config : JSON.stringify(config)
    );
  }
  return { root, listProjects: () => projects };
}

const three = (r) => checkChangesetsCli({ run: answer('3.0.1\n'), ...r });

describe('check-changesets-cli: version detection', () => {
  it('2.x passes with major 2', () => {
    assert.deepEqual(checkChangesetsCli({ run: answer('2.30.0\n') }), {
      version: '2.30.0',
      major: 2
    });
  });

  it('3.x passes with major 3', () => {
    const r = repo({ config: {} });
    assert.deepEqual(three(r), { version: '3.0.1', major: 3 });
  });

  it('1.x fails', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('1.9.9\n') }), /majors 2 and 3.*1\.9\.9/);
  });

  it('4.x fails', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('4.0.0\n') }), /majors 2 and 3.*4\.0\.0/);
  });

  it('an unreadable version fails', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('garbage\n') }), /Could not determine/);
  });

  it('a non-zero exit fails', () => {
    assert.throws(() => checkChangesetsCli({ run: answer('3.0.1\n', 1) }), /Could not determine/);
  });

  it('main returns 0 for a supported major and 1 with an error annotation otherwise', () => {
    const lines = [];
    assert.equal(main({ run: answer('2.1.0'), log: (l) => lines.push(l), env: {} }), 0);
    assert.equal(main({ run: answer('4.0.0'), log: (l) => lines.push(l), env: {} }), 1);
    assert.match(lines.at(-1), /^::error title=Unsupported @changesets\/cli major::/);
  });

  it('main writes version and major to GITHUB_OUTPUT', () => {
    const file = join(scratch, 'output');
    writeFileSync(file, '');
    main({ run: answer('2.30.0'), log: () => {}, env: { GITHUB_OUTPUT: file } });
    assert.equal(readFileSync(file, 'utf8'), 'version=2.30.0\nmajor=2\n');
  });
});

describe('check-changesets-cli: annotation title per failure kind', () => {
  const titleOf = (opts) => {
    const lines = [];
    assert.equal(main({ log: (l) => lines.push(l), env: {}, ...opts }), 1);
    return /^::error title=([^:]*)::/.exec(lines.at(-1))?.[1];
  };

  it('unsupported major', () => {
    assert.equal(titleOf({ run: answer('4.0.0') }), 'Unsupported @changesets/cli major');
  });

  it('unreadable version', () => {
    assert.equal(titleOf({ run: answer('garbage') }), 'Unreadable @changesets/cli version');
  });

  it('privatePackages not explicit', () => {
    const r = repo({ rootPrivate: true, config: {} });
    assert.equal(titleOf({ run: answer('3.0.1'), ...r }), 'privatePackages not explicit');
  });

  it('unreadable or invalid config', () => {
    const r = repo({ rootPrivate: true, config: '{ not json' });
    assert.equal(
      titleOf({ run: answer('3.0.1'), ...r }),
      'Unreadable or invalid changesets config'
    );
  });
});

describe('check-changesets-cli: privatePackages on 3.x', () => {
  const privateRepo = (config) => repo({ rootPrivate: true, config });

  it('3.x + private package + key absent fails', () => {
    assert.throws(() => three(privateRepo({})), /privatePackages/);
  });

  it('3.x + key true passes', () => {
    assert.equal(three(privateRepo({ privatePackages: true })).major, 3);
  });

  it('3.x + key false passes', () => {
    assert.equal(three(privateRepo({ privatePackages: false })).major, 3);
  });

  it('3.x + {version:true} fails with the shape message naming the config file', () => {
    assert.throws(
      () => three(privateRepo({ privatePackages: { version: true } })),
      /\.changeset\/config\.json.*true, false, or an object with\s+boolean "version" and "tag"/
    );
  });

  it('3.x + key absent fails with the shape message', () => {
    assert.throws(() => three(privateRepo({})), /missing or malformed.*true, false, or an object/);
  });

  it('3.x + object with both booleans passes', () => {
    assert.equal(three(privateRepo({ privatePackages: { version: true, tag: true } })).major, 3);
    assert.equal(three(privateRepo({ privatePackages: { version: false, tag: false } })).major, 3);
  });

  it('3.x + object missing tag fails', () => {
    assert.throws(
      () => three(privateRepo({ privatePackages: { version: true } })),
      /privatePackages/
    );
  });

  it('3.x + no private package + key absent passes', () => {
    assert.equal(three(repo({ config: {} })).major, 3);
  });

  it('3.x + private root only in a multi-package workspace + key absent passes', () => {
    const r = repo({
      rootPrivate: true,
      workspace: true,
      members: [['a', false]],
      config: {}
    });
    assert.equal(three(r).major, 3);
  });

  it('3.x + private member in a multi-package workspace + key absent fails', () => {
    const r = repo({ workspace: true, members: [['a', true]], config: {} });
    assert.throws(() => three(r), /privatePackages/);
  });

  it('2.x + private package + key absent passes', () => {
    const r = privateRepo({});
    assert.equal(checkChangesetsCli({ run: answer('2.30.0\n'), ...r }).major, 2);
  });

  it('unreadable or invalid config on 3.x fails', () => {
    assert.throws(() => three(repo({ rootPrivate: true })), /Could not read/);
    assert.throws(() => three(repo({ rootPrivate: true, config: '{ not json' })), /Could not read/);
  });
});

describe('check-changesets-cli: workspace layout on 3.x', () => {
  const withWorkspaceFile = (body) => {
    const r = repo({ config: {} });
    if (body !== undefined) writeFileSync(join(r.root, 'pnpm-workspace.yaml'), body);
    return r;
  };

  it('accepts no workspace file, a settings-only file, a flow list with ".", and a block list with a negation', () => {
    for (const body of [
      undefined,
      'minimumReleaseAge: 1440\n',
      "packages: ['.']\n",
      'packages: [a/*, b/**]\n',
      "packages:\n  - 'pkgs/**'\n  - '!pkgs/test/**'\n"
    ]) {
      assert.equal(three(withWorkspaceFile(body)).major, 3, String(body));
    }
  });

  it('fails an unevaluable pattern with an actionable message and its own title', () => {
    for (const body of [
      "packages:\n  - 'a/*/b'\n",
      "packages: ['a/{x,y}']\n",
      "packages:\n  - 'a/[xy]'\n",
      'packages: []\n'
    ]) {
      const r = withWorkspaceFile(body);
      assert.throws(
        () => three(r),
        /workspace layout cannot be evaluated.*block or one-line list/s
      );
      const lines = [];
      assert.equal(main({ run: answer('3.0.1\n'), log: (l) => lines.push(l), env: {}, ...r }), 1);
      assert.match(lines[0], /^::error title=Unsupported workspace layout::/);
    }
  });

  it('does not apply on 2.x', () => {
    const r = withWorkspaceFile("packages:\n  - 'a/*/b'\n");
    assert.equal(checkChangesetsCli({ run: answer('2.30.0\n'), ...r }).major, 2);
  });
});
