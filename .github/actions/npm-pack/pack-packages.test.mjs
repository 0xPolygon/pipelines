import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  assertNoCheckoutContent,
  assertNpmRegistry,
  assertPublicAccess,
  buildManifestEntry,
  discoverPackages,
  loadChangesetsContext,
  main,
  packSelected,
  readConfigAccess,
  readPreState,
  resolveAccess,
  resolveDistTag,
  resolveIgnoredNames,
  selectUnpublished
} from './pack-packages.mjs';

const pkg = (name, version, extra = {}) => ({
  name,
  version,
  dir: `/ws/${name}`,
  packageJson: { name, version, ...extra }
});

const registry = (table) => async (name) => (name in table ? table[name] : null);

describe('selectUnpublished', () => {
  it('selects a version that is absent from the registry list', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '1.1.0')],
      lookupVersions: registry({ a: ['1.0.0'] })
    });
    assert.deepEqual(
      out.map((p) => p.name),
      ['a']
    );
  });

  it('skips a version that is already published', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '1.0.0')],
      lookupVersions: registry({ a: ['1.0.0'] })
    });
    assert.equal(out.length, 0);
  });

  it('treats a 404 (null) as never published and selects it', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '0.0.1')],
      lookupVersions: registry({})
    });
    assert.equal(out.length, 1);
  });

  it('fails the run on any other lookup error', async () => {
    await assert.rejects(
      selectUnpublished({
        packages: [pkg('a', '1.0.0')],
        lookupVersions: async () => {
          throw new Error('ECONNRESET');
        }
      }),
      /ECONNRESET/
    );
  });

  it('never selects private packages and never looks them up', async () => {
    const looked = [];
    const out = await selectUnpublished({
      packages: [pkg('p', '1.0.0', { private: true })],
      lookupVersions: async (n) => {
        looked.push(n);
        return null;
      }
    });
    assert.equal(out.length, 0);
    assert.deepEqual(looked, []);
  });
});

describe('resolveDistTag', () => {
  it('is latest outside pre mode', () => {
    assert.equal(resolveDistTag({ preState: undefined, publishedState: 'published' }), 'latest');
  });

  it('is the pre tag in pre mode', () => {
    assert.equal(
      resolveDistTag({ preState: { tag: 'beta' }, publishedState: 'published' }),
      'beta'
    );
  });

  it('is latest in pre mode when only prereleases were published so far', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '1.0.0-beta.3')],
      lookupVersions: registry({ a: ['1.0.0-beta.1', '1.0.0-beta.2'] }),
      preState: { tag: 'beta' }
    });
    assert.equal(out[0]?.tag, 'latest');
    assert.equal(out[0]?.preTag, 'beta');
  });

  it('records no preTag outside pre mode', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '1.0.0')],
      lookupVersions: async () => null
    });
    assert.equal('preTag' in out[0], false);
  });

  it('is the pre tag in pre mode when a regular release exists', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '2.0.0-beta.1')],
      lookupVersions: registry({ a: ['1.0.0', '2.0.0-beta.0'] }),
      preState: { tag: 'beta' }
    });
    assert.equal(out[0]?.tag, 'beta');
  });

  it('is the pre tag for a never-published package in pre mode', async () => {
    const out = await selectUnpublished({
      packages: [pkg('a', '1.0.0-beta.0')],
      lookupVersions: registry({}),
      preState: { tag: 'beta' }
    });
    assert.equal(out[0]?.tag, 'beta');
  });

  it('lets an explicit override win', () => {
    assert.equal(
      resolveDistTag({ preState: { tag: 'beta' }, publishedState: 'never', override: 'next' }),
      'next'
    );
  });
});

describe('access', () => {
  it('prefers publishConfig.access over the config', () => {
    assert.equal(
      resolveAccess({
        packageJson: { publishConfig: { access: 'public' } },
        configAccess: 'restricted'
      }),
      'public'
    );
  });

  it('falls back to the config access, then to restricted', () => {
    assert.equal(resolveAccess({ packageJson: {}, configAccess: 'public' }), 'public');
    assert.equal(resolveAccess({ packageJson: {}, configAccess: undefined }), 'restricted');
  });

  it('errors when a selected package resolves to restricted', () => {
    assert.throws(
      () => assertPublicAccess({ selected: [pkg('a', '1.0.0')], configAccess: undefined }),
      /restricted.*a\b/s
    );
  });

  it('passes when every selected package resolves to public', () => {
    assertPublicAccess({
      selected: [pkg('a', '1.0.0', { publishConfig: { access: 'public' } }), pkg('b', '1.0.0')],
      configAccess: 'public'
    });
  });
});

describe('manifest and pack', () => {
  it('has the documented entry shape', () => {
    const entry = buildManifestEntry({
      pkg: { ...pkg('a', '1.0.0'), tag: 'latest' },
      file: 'a-1.0.0.tgz',
      sha256: 'abc',
      access: 'public',
      directory: 'packages/a'
    });
    assert.deepEqual(Object.keys(entry), [
      'name',
      'version',
      'file',
      'sha256',
      'access',
      'tag',
      'directory'
    ]);
  });

  it('records the pre-mode tag as preTag only when the package has one', () => {
    const base = { file: 'a.tgz', sha256: 'abc', access: 'public', directory: 'packages/a' };
    const pre = buildManifestEntry({
      pkg: { ...pkg('a', '1.0.0-beta.1'), tag: 'latest', preTag: 'beta' },
      ...base
    });
    assert.equal(pre.preTag, 'beta');
    assert.equal(pre.tag, 'latest');
    assert.equal(
      'preTag' in buildManifestEntry({ pkg: { ...pkg('a', '1.0.0'), tag: 'latest' }, ...base }),
      false
    );
  });

  it('runs prepublishOnly then pack per package and hashes the tarball', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pack-out-'));
    writeFileSync(join(out, 'a-1.0.0.tgz'), 'tarball-bytes');
    const calls = [];
    const manifest = await packSelected({
      selected: [{ ...pkg('a', '1.0.0', { publishConfig: { access: 'public' } }), tag: 'latest' }],
      outDir: out,
      configAccess: undefined,
      listEntries: async () => ['package/package.json'],
      run: async ({ command, args, cwd }) => {
        calls.push([command, ...args, cwd]);
        return args[0] === 'pack' ? `${out}/a-1.0.0.tgz\n` : '';
      }
    });
    assert.deepEqual(calls[0], ['pnpm', 'run', '--if-present', 'prepublishOnly', '/ws/a']);
    assert.deepEqual(calls[1], ['pnpm', 'pack', '--pack-destination', out, '/ws/a']);
    assert.equal(manifest[0]?.sha256, createHash('sha256').update('tarball-bytes').digest('hex'));
    assert.equal(manifest[0]?.file, 'a-1.0.0.tgz');
  });
});

describe('workspace fixture', () => {
  const makeRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'pack-ws-'));
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    mkdirSync(join(root, '.changeset'));
    writeFileSync(
      join(root, 'packages', 'a', 'package.json'),
      JSON.stringify({ name: 'a', version: '1.2.3', publishConfig: { access: 'public' } })
    );
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify({ access: 'public' }));
    writeFileSync(
      join(root, '.changeset', 'pre.json'),
      JSON.stringify({ mode: 'pre', tag: 'beta' })
    );
    return root;
  };

  it('discovers packages from the listed projects and reads changesets state', async () => {
    const root = makeRoot();
    const found = await discoverPackages({
      root,
      listProjects: async () => [{ path: join(root, 'packages', 'a') }]
    });
    assert.equal(found[0]?.version, '1.2.3');
    assert.equal(readConfigAccess(root), 'public');
    assert.equal(readPreState(root)?.tag, 'beta');
  });

  it('runs end to end: writes manifest.json and step outputs', async () => {
    const root = makeRoot();
    const out = join(root, 'out');
    const ghOutput = join(root, 'gh-output');
    writeFileSync(ghOutput, '');
    await main({
      root,
      env: { PACK_OUT_DIR: out, GITHUB_OUTPUT: ghOutput },
      listProjects: async () => [{ path: join(root, 'packages', 'a') }],
      lookupVersions: async () => null,
      listEntries: async () => ['package/package.json'],
      run: async ({ args }) => {
        if (args[0] !== 'pack') return '';
        writeFileSync(join(out, 'a-1.2.3.tgz'), 'x');
        return 'a-1.2.3.tgz\n';
      }
    });
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest[0].tag, 'beta');
    assert.equal(manifest[0].preTag, 'beta');
    assert.match(readFileSync(ghOutput, 'utf8'), /has_tarballs=true\ncount=1/);
  });
});

describe('root project handling', () => {
  const makeWs = (rootManifest, memberManifests) => {
    const root = mkdtempSync(join(tmpdir(), 'pack-root-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify(rootManifest));
    const projects = [{ path: root }];
    memberManifests.forEach((manifest, i) => {
      const dir = join(root, 'packages', `m${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
      projects.push({ path: dir });
    });
    return { root, listProjects: async () => projects };
  };

  it('excludes the root of a multi-package workspace even when it is not private', async () => {
    const { root, listProjects } = makeWs({ name: 'root-pkg', version: '1.0.0' }, [
      { name: 'm0', version: '1.0.0' }
    ]);
    const found = await discoverPackages({ root, listProjects });
    assert.deepEqual(
      found.map((p) => p.name),
      ['m0']
    );
  });

  it('keeps the root when it is the only project', async () => {
    const { root, listProjects } = makeWs({ name: 'solo', version: '1.0.0' }, []);
    const found = await discoverPackages({ root, listProjects });
    assert.deepEqual(
      found.map((p) => p.name),
      ['solo']
    );
  });

  it('does not throw on a private package with no version and never selects it', async () => {
    const { root, listProjects } = makeWs({ name: 'r', version: '1.0.0' }, [
      { name: 'svc', private: true },
      { name: 'pub', version: '1.0.0' }
    ]);
    const found = await discoverPackages({ root, listProjects });
    const selected = await selectUnpublished({ packages: found, lookupVersions: async () => null });
    assert.deepEqual(
      selected.map((p) => p.name),
      ['pub']
    );
  });

  it('fails naming the directory when a member has no name or version', async () => {
    const { root, listProjects } = makeWs({ name: 'r', version: '1.0.0' }, [{ version: '1.0.0' }]);
    await assert.rejects(discoverPackages({ root, listProjects }), /m0.*no "name" or no "version"/);
    const ws2 = makeWs({ name: 'r', version: '1.0.0' }, [{ name: 'x' }]);
    await assert.rejects(discoverPackages(ws2), /no "name" or no "version"/);
  });
});

// Builds a real gzipped tarball whose entries are the given files, laid out
// under `package/` like `pnpm pack` output.
function buildTarball(files) {
  const base = mkdtempSync(join(tmpdir(), 'pack-tar-'));
  const src = join(base, 'src');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(src, 'package', path, '..'), { recursive: true });
    writeFileSync(join(src, 'package', path), content);
  }
  const tgz = join(base, 'a-1.0.0.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', src, 'package']);
  return { base, tgz };
}

describe('workspace checkout guard', () => {
  const packWith = async (files) => {
    const { base, tgz } = buildTarball(files);
    const out = join(base, 'out');
    mkdirSync(out);
    writeFileSync(join(out, 'a-1.0.0.tgz'), readFileSync(tgz));
    return packSelected({
      selected: [{ ...pkg('a', '1.0.0', { publishConfig: { access: 'public' } }), tag: 'latest' }],
      outDir: out,
      run: async ({ args }) => (args[0] === 'pack' ? 'a-1.0.0.tgz\n' : '')
    });
  };

  it('packs a real tarball that holds only the package', async () => {
    const manifest = await packWith({ 'package.json': '{}', 'dist/index.js': 'x' });
    assert.equal(manifest[0]?.file, 'a-1.0.0.tgz');
  });

  it('fails when the tarball contains a .pipelines directory', async () => {
    await assert.rejects(
      packWith({ 'package.json': '{}', '.pipelines/.github/actions/x/action.yml': 'x' }),
      /under package\/\.pipelines\//
    );
  });

  it('matches only the .pipelines directory, not lookalike names', () => {
    assertNoCheckoutContent({
      entries: ['package/.pipelines-notes.md', 'package/src/.pipelines/x'],
      packageName: 'a',
      file: 'a.tgz'
    });
    assert.throws(() =>
      assertNoCheckoutContent({ entries: ['package/.pipelines'], packageName: 'a', file: 'a.tgz' })
    );
  });

  it('fails when two packages produce the same tarball name', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pack-dup-'));
    writeFileSync(join(out, 'a-b-1.0.0.tgz'), 'x');
    await assert.rejects(
      packSelected({
        selected: [
          { ...pkg('@a/b', '1.0.0'), tag: 'latest' },
          { ...pkg('a-b', '1.0.0'), tag: 'latest' }
        ],
        outDir: out,
        configAccess: 'public',
        listEntries: async () => [],
        run: async ({ args }) => (args[0] === 'pack' ? 'a-b-1.0.0.tgz\n' : '')
      }),
      /same tarball name a-b-1\.0\.0\.tgz/
    );
  });
});

describe('registry', () => {
  it('rejects a package that sets another publishConfig.registry', () => {
    assert.throws(
      () =>
        assertNpmRegistry({
          selected: [pkg('a', '1.0.0', { publishConfig: { registry: 'https://example.test/' } })]
        }),
      /a \(registry\)/
    );
  });

  it('accepts the public registry, with or without a trailing slash, and no setting', () => {
    assertNpmRegistry({
      selected: [
        pkg('a', '1.0.0', { publishConfig: { registry: 'https://registry.npmjs.org' } }),
        pkg('b', '1.0.0', { publishConfig: { registry: 'https://registry.npmjs.org/' } }),
        pkg('c', '1.0.0')
      ]
    });
  });
});

describe('publishConfig registry keys', () => {
  it('rejects a scoped registry that is not npmjs', () => {
    assert.throws(
      () =>
        assertNpmRegistry({
          selected: [
            pkg('a', '1.0.0', { publishConfig: { '@scope:registry': 'https://other.test/' } })
          ]
        }),
      /@scope:registry/
    );
  });

  it('accepts a scoped registry that is npmjs', () => {
    assertNpmRegistry({
      selected: [
        pkg('a', '1.0.0', { publishConfig: { '@scope:registry': 'https://registry.npmjs.org' } })
      ]
    });
  });
});

describe('root listed as a workspace member', () => {
  const rootWith = (workspaceYaml) => {
    const root = mkdtempSync(join(tmpdir(), 'pack-rootmember-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    writeFileSync(join(root, 'pnpm-workspace.yaml'), workspaceYaml);
    return root;
  };
  const names = async (root) =>
    (await discoverPackages({ root, listProjects: async () => [{ path: root }] })).map(
      (p) => p.name
    );

  // @manypkg/get-packages 1.1.3 (what changesets uses) globs the member list,
  // and the glob "." matches the root directory, so the root is a package.
  it("packs the root when packages lists '.'", async () => {
    assert.deepEqual(await names(rootWith("packages:\n  - '.'\n")), ['r']);
  });

  it('packs the root for flow-style and ./ forms', async () => {
    assert.deepEqual(await names(rootWith("packages: ['.']\n")), ['r']);
    assert.deepEqual(await names(rootWith('packages:\n  - ./\n')), ['r']);
  });

  it('still excludes the root when it is not named', async () => {
    assert.deepEqual(await names(rootWith("packages:\n  - 'packages/*'\n")), []);
  });
});

describe('workspace with no matching members', () => {
  const rootWith = (workspaceYaml) => {
    const root = mkdtempSync(join(tmpdir(), 'pack-empty-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', version: '1.0.0' }));
    if (workspaceYaml !== undefined)
      writeFileSync(join(root, 'pnpm-workspace.yaml'), workspaceYaml);
    return root;
  };

  it('packs nothing when pnpm-workspace.yaml has globs and only the root is listed', async () => {
    const root = rootWith("packages:\n  - 'packages/*'\n");
    const found = await discoverPackages({ root, listProjects: async () => [{ path: root }] });
    assert.deepEqual(found, []);
  });

  it('keeps the root when pnpm-workspace.yaml only carries settings', async () => {
    const root = rootWith('minimumReleaseAge: 1440\n');
    const found = await discoverPackages({ root, listProjects: async () => [{ path: root }] });
    assert.deepEqual(
      found.map((p) => p.name),
      ['r']
    );
  });
});

describe('ignore (applies on @changesets/cli 3.x only)', () => {
  const makeWs = ({ ignore, names }) => {
    const root = mkdtempSync(join(tmpdir(), 'pack-ignore-'));
    mkdirSync(join(root, '.changeset'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }));
    const config = { access: 'public' };
    if (ignore !== undefined) config.ignore = ignore;
    writeFileSync(join(root, '.changeset', 'config.json'), JSON.stringify(config));
    const projects = [{ path: root }];
    names.forEach((name, i) => {
      const dir = join(root, 'packages', `p${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name, version: '1.0.0', publishConfig: { access: 'public' } })
      );
      projects.push({ path: dir });
    });
    return { root, listProjects: async () => projects };
  };

  // The expansions below are what @changesets/cli 3.0.3 produced for the same
  // `ignore` entries over packages @s/alpha, @s/keep, @t/gamma and delta.
  const cliExpansion = {
    '["@s/*"]': ['@s/alpha', '@s/keep'],
    '["@s/*","!@s/keep"]': ['@s/alpha'],
    '["@t/gam*","delta"]': ['@t/gamma', 'delta']
  };
  const loadFor =
    (ignore, cliMajor = 3) =>
    async () => ({
      cliMajor,
      config: { ignore: cliExpansion[JSON.stringify(ignore)], privatePackages: { tag: false } }
    });
  const versionRun =
    (version) =>
    async ({ args }) => {
      if (args[0] === 'pack') return '';
      return args.includes('--version') ? `${version}\n` : '';
    };
  const packedNames = async ({ root, listProjects, ignore, version, cliMajor }) => {
    const out = join(root, 'out');
    const manifest = await main({
      root,
      env: { PACK_OUT_DIR: out },
      listProjects,
      lookupVersions: async () => null,
      listEntries: async () => ['package/package.json'],
      loadContext: loadFor(ignore, cliMajor),
      run: async (call) => {
        if (call.args[0] === 'pack') {
          const file = `${call.cwd.split('/').pop()}-1.0.0.tgz`;
          writeFileSync(join(out, file), 'x');
          return `${file}\n`;
        }
        return versionRun(version)(call);
      }
    });
    return manifest.map((entry) => entry.name);
  };
  const names = ['@s/alpha', '@s/keep', '@t/gamma', 'delta', 'plain'];

  it('an ignored public package is not packed on 3.x, by exact name and by glob', async () => {
    const ignore = ['@t/gam*', 'delta'];
    const ws = makeWs({ ignore, names });
    assert.deepEqual(await packedNames({ ...ws, ignore, version: '3.0.3' }), [
      '@s/alpha',
      '@s/keep',
      'plain'
    ]);
  });

  it('a scope glob ignores every package in the scope on 3.x', async () => {
    const ignore = ['@s/*'];
    const ws = makeWs({ ignore, names });
    assert.deepEqual(await packedNames({ ...ws, ignore, version: '3.0.3' }), [
      '@t/gamma',
      'delta',
      'plain'
    ]);
  });

  it('a negated entry keeps the negated package on 3.x', async () => {
    const ignore = ['@s/*', '!@s/keep'];
    const ws = makeWs({ ignore, names });
    assert.deepEqual(await packedNames({ ...ws, ignore, version: '3.0.3' }), [
      '@s/keep',
      '@t/gamma',
      'delta',
      'plain'
    ]);
  });

  it('2.x still packs an ignored public package, because 2.x publish does not skip it', async () => {
    const ignore = ['@s/*'];
    const ws = makeWs({ ignore, names });
    let loaded = false;
    const out = join(ws.root, 'out');
    const manifest = await main({
      root: ws.root,
      env: { PACK_OUT_DIR: out },
      listProjects: ws.listProjects,
      lookupVersions: async () => null,
      listEntries: async () => ['package/package.json'],
      loadContext: async () => {
        loaded = true;
        return loadFor(ignore)();
      },
      run: async (call) => {
        if (call.args[0] === 'pack') {
          const file = `${call.cwd.split('/').pop()}-1.0.0.tgz`;
          writeFileSync(join(out, file), 'x');
          return `${file}\n`;
        }
        return versionRun('2.30.0')(call);
      }
    });
    assert.equal(manifest.length, names.length);
    assert.equal(loaded, false);
  });

  it('no ignore key and an empty ignore list pack as before without reading the CLI', async () => {
    for (const ignore of [undefined, []]) {
      const ws = makeWs({ ignore, names: ['a', 'b'] });
      const out = join(ws.root, 'out');
      const manifest = await main({
        root: ws.root,
        env: { PACK_OUT_DIR: out },
        listProjects: ws.listProjects,
        lookupVersions: async () => null,
        listEntries: async () => ['package/package.json'],
        loadContext: async () => assert.fail('the CLI config must not be read'),
        run: async (call) => {
          assert.equal(call.args.includes('--version'), false);
          if (call.args[0] !== 'pack') return '';
          const file = `${call.cwd.split('/').pop()}-1.0.0.tgz`;
          writeFileSync(join(out, file), 'x');
          return `${file}\n`;
        }
      });
      assert.equal(manifest.length, 2);
    }
  });

  it('fails when the CLI major cannot be determined or disagrees with the installed package', async () => {
    const ws = makeWs({ ignore: ['@s/*'], names: ['a'] });
    await assert.rejects(
      resolveIgnoredNames({ root: ws.root, run: async () => '', loadContext: loadFor(['@s/*']) }),
      /Could not determine the version/
    );
    await assert.rejects(
      resolveIgnoredNames({
        root: ws.root,
        run: versionRun('3.0.3'),
        loadContext: loadFor(['@s/*'], 2)
      }),
      /reports major 3 but the installed package is major 2/
    );
    await assert.rejects(
      resolveIgnoredNames({ root: ws.root, run: versionRun('4.0.0') }),
      /not supported/
    );
  });

  it('fails when the CLI config cannot be loaded', async () => {
    const ws = makeWs({ ignore: ['@s/*'], names: ['a'] });
    await assert.rejects(
      resolveIgnoredNames({ root: ws.root, run: versionRun('3.0.3') }),
      /Could not resolve the installed @changesets\/cli/
    );
    await assert.rejects(
      resolveIgnoredNames({
        root: ws.root,
        run: versionRun('3.0.3'),
        loadContext: async () => {
          throw new Error('read failed');
        }
      }),
      /read failed/
    );
  });

  describe('loadChangesetsContext', () => {
    const writePackage = (dir, name, source, extra = {}) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name,
          version: '1.0.0',
          type: 'module',
          exports: { '.': './index.js', './package.json': './package.json' },
          ...extra
        })
      );
      writeFileSync(join(dir, 'index.js'), source);
    };
    // A CLI package on disk whose own dependencies provide the config reader,
    // so the loader resolves them from the CLI, not from the repository.
    const fakeCli = ({ version, configSource }) => {
      const root = mkdtempSync(join(tmpdir(), 'pack-cli-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }));
      const cli = join(root, 'node_modules', '@changesets', 'cli');
      writePackage(cli, '@changesets/cli', 'export {};', { version });
      writePackage(
        join(cli, 'node_modules', '@changesets', 'config'),
        '@changesets/config',
        configSource
      );
      writePackage(
        join(cli, 'node_modules', '@manypkg', 'get-packages'),
        '@manypkg/get-packages',
        `export const getPackages = async (dir) => ({ rootDir: dir, packages: [] });`
      );
      return root;
    };

    it('unwraps the { config, warnings, errors } result of @changesets/config 4', async () => {
      const root = fakeCli({
        version: '3.0.3',
        configSource: `export const readConfig = async () => ({ config: { ignore: ['@s/alpha'], privatePackages: { version: true, tag: true } }, warnings: [] });`
      });
      const context = await loadChangesetsContext({ root });
      assert.equal(context.cliMajor, 3);
      assert.deepEqual(context.config.ignore, ['@s/alpha']);
    });

    it('accepts the bare config returned by `read` in earlier majors', async () => {
      const root = fakeCli({
        version: '2.30.0',
        configSource: `export const read = async () => ({ ignore: ['a'], privatePackages: { version: false, tag: false } });`
      });
      const context = await loadChangesetsContext({ root });
      assert.equal(context.cliMajor, 2);
      assert.deepEqual(context.config.ignore, ['a']);
    });

    it('fails on config errors, an unexpected shape, or a missing reader', async () => {
      const bad = {
        errors: `export const readConfig = async () => ({ errors: ['bad ignore'], warnings: [] });`,
        shape: `export const readConfig = async () => ({ config: { ignore: 'x' }, warnings: [] });`,
        throws: `export const readConfig = async () => { throw new Error('boom'); };`,
        none: `export const other = 1;`
      };
      const expected = {
        errors: /config.json is invalid: bad ignore/,
        shape: /unexpected shape/,
        throws: /boom/,
        none: /does not expose/
      };
      for (const [key, configSource] of Object.entries(bad)) {
        const root = fakeCli({ version: '3.0.3', configSource });
        await assert.rejects(loadChangesetsContext({ root }), expected[key]);
      }
    });

    it('fails when the CLI cannot be resolved from the repository', async () => {
      const root = mkdtempSync(join(tmpdir(), 'pack-nocli-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'r' }));
      await assert.rejects(loadChangesetsContext({ root }), /Could not resolve the installed/);
    });
  });
});
