import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    writeFileSync(join(dir, 'CHANGELOG.md'), '# a\n');
    writeManifest([
      { name: 'a', version: '1.0.0', directory: '.' },
      { name: 'b', version: '2.0.0' }
    ]);
    const { code, logs } = await run(
      fakeFetch({ tags: ['a@1.0.0', 'b@2.0.0'], releases: ['b@2.0.0'] }).fetchImpl
    );
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /a@1\.0\.0 \(GitHub Release\)/);
    assert.doesNotMatch(logs.join('\n'), /b@2\.0\.0 \(/);
  });

  describe('Release requirement follows the changelog', () => {
    const setup = ({ changelogConfig, withChangelog }) => {
      mkdirSync(join(dir, 'pkgs', 'a'), { recursive: true });
      if (withChangelog) writeFileSync(join(dir, 'pkgs', 'a', 'CHANGELOG.md'), '# a\n');
      if (changelogConfig !== undefined) {
        mkdirSync(join(dir, '.changeset'), { recursive: true });
        writeFileSync(
          join(dir, '.changeset', 'config.json'),
          JSON.stringify({ changelog: changelogConfig })
        );
      }
      writeManifest([{ name: 'a', version: '1.0.0', directory: 'pkgs/a' }]);
    };

    it('needs no Release when changelogs are disabled', async () => {
      setup({ changelogConfig: false, withChangelog: true });
      const { code } = await run(fakeFetch({ tags: ['a@1.0.0'], releases: [] }).fetchImpl);
      assert.equal(code, 0);
    });

    it('needs no Release when the package has no CHANGELOG.md', async () => {
      setup({ changelogConfig: ['@changesets/cli/changelog'], withChangelog: false });
      const { code } = await run(fakeFetch({ tags: ['a@1.0.0'], releases: [] }).fetchImpl);
      assert.equal(code, 0);
    });

    it('fails when changelogs are enabled, a CHANGELOG.md exists and the Release is missing', async () => {
      setup({ changelogConfig: ['@changesets/cli/changelog'], withChangelog: true });
      const { code, logs } = await run(fakeFetch({ tags: ['a@1.0.0'], releases: [] }).fetchImpl);
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /a@1\.0\.0 \(GitHub Release\)/);
    });

    it('treats an absent config as changelogs enabled', async () => {
      setup({ withChangelog: true });
      const { code } = await run(fakeFetch({ tags: ['a@1.0.0'], releases: [] }).fetchImpl);
      assert.equal(code, 1);
    });

    it('ignores a directory that escapes the workspace', async () => {
      writeManifest([{ name: 'a', version: '1.0.0', directory: '../..' }]);
      const { code } = await run(fakeFetch({ tags: ['a@1.0.0'], releases: [] }).fetchImpl);
      assert.equal(code, 0);
    });
  });

  it('fails on a release API error other than 404', async () => {
    writeFileSync(join(dir, 'CHANGELOG.md'), '# a\n');
    writeManifest([{ name: 'a', version: '1.0.0', directory: '.' }]);
    const fetchImpl = async (url) => ({ status: url.includes('/releases/') ? 502 : 200 });
    const { code, logs } = await run(fetchImpl);
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /release lookup.*HTTP 502/);
  });

  describe('tags at HEAD in the local clone', () => {
    const HEAD = 'a'.repeat(40);
    const OTHER = 'b'.repeat(40);

    /** A command stub: HEAD and its tags, plus the pnpm workspace package list. */
    const gitRun =
      ({ tags = [], packages = [] } = {}) =>
      (command, args) => {
        if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: `${HEAD}\n` };
        if (command === 'git' && args[0] === 'tag') return { status: 0, stdout: tags.join('\n') };
        if (command === 'pnpm') {
          return {
            status: 0,
            stdout: JSON.stringify(packages.map((p) => ({ ...p, path: join(dir, p.directory) })))
          };
        }
        throw new Error(`unexpected command ${command}`);
      };

    /** Fetch stub for refs (`commits`: tag → commit) and Releases. */
    const refFetch =
      ({ commits = {}, releases = [], status } = {}) =>
      async (url) => {
        if (status) return { status };
        if (url.includes('/releases/tags/')) {
          const tag = decodeURIComponent(url.split('/releases/tags/')[1]);
          return { status: releases.includes(tag) ? 200 : 404 };
        }
        const tag = decodeURIComponent(url.split('/git/ref/tags/')[1]);
        if (!(tag in commits)) return { status: 404 };
        return {
          status: 200,
          json: async () => ({ object: { type: 'commit', sha: commits[tag] } })
        };
      };

    const runLocal = ({ fetchImpl, run, withManifest = true }) => {
      const logs = [];
      const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't', GITHUB_WORKSPACE: dir };
      if (withManifest) env.TARBALL_DIRECTORY = dir;
      return main({ env, fetchImpl, run, log: (m) => logs.push(m) }).then((code) => ({
        code,
        logs
      }));
    };

    const pkgA = { name: '@s/a', version: '1.0.0', directory: 'pkgs/a' };

    it('passes with nothing to tag', async () => {
      const { code, logs } = await runLocal({
        fetchImpl: refFetch(),
        run: gitRun(),
        withManifest: false
      });
      assert.equal(code, 0);
      assert.match(logs.join('\n'), /Nothing to tag/);
    });

    it('ignores a tag at HEAD that names no workspace package', async () => {
      const { code } = await runLocal({
        fetchImpl: refFetch(),
        run: gitRun({ tags: ['nightly'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 0);
    });

    it('fails a private-only run whose local tag is missing on the remote', async () => {
      const { code, logs } = await runLocal({
        fetchImpl: refFetch(),
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /Release tags missing.*@s\/a@1\.0\.0/);
    });

    it('passes a private-only run whose tag is at the run commit and has a Release', async () => {
      mkdirSync(join(dir, 'pkgs', 'a'), { recursive: true });
      writeFileSync(join(dir, 'pkgs', 'a', 'CHANGELOG.md'), '# a\n');
      const { code } = await runLocal({
        fetchImpl: refFetch({
          commits: { '@s/a@1.0.0': HEAD },
          releases: ['@s/a@1.0.0']
        }),
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 0);
    });

    it('fails a local tag that exists on the remote at another commit', async () => {
      const { code, logs } = await runLocal({
        fetchImpl: refFetch({ commits: { '@s/a@1.0.0': OTHER } }),
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /@s\/a@1\.0\.0 \(points at another commit\)/);
      assert.match(logs.join('\n'), /delete it in the repository and re-run the failed job/);
      assert.match(logs.join('\n'), /never moves or deletes a tag itself/);
    });

    it('follows an annotated tag to the commit it points at', async () => {
      const tagObject = 'c'.repeat(40);
      const fetchImpl = async (url) => {
        if (url.includes('/git/tags/')) {
          return { status: 200, json: async () => ({ object: { type: 'commit', sha: HEAD } }) };
        }
        return { status: 200, json: async () => ({ object: { type: 'tag', sha: tagObject } }) };
      };
      const { code } = await runLocal({
        fetchImpl,
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 0);
    });

    it('fails a published manifest entry with no tag even when no local tag exists', async () => {
      writeManifest([{ name: 'p', version: '1.0.0' }]);
      const { code, logs } = await runLocal({ fetchImpl: refFetch(), run: gitRun() });
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /p@1\.0\.0/);
    });

    it('passes a mixed published and private run when every tag is present', async () => {
      writeManifest([{ name: 'p', version: '1.0.0' }]);
      const { code } = await runLocal({
        fetchImpl: refFetch({ commits: { 'p@1.0.0': HEAD, '@s/a@1.0.0': HEAD } }),
        run: gitRun({
          tags: ['p@1.0.0', '@s/a@1.0.0'],
          packages: [pkgA, { name: 'p', version: '1.0.0', directory: 'pkgs/p' }]
        })
      });
      assert.equal(code, 0);
    });

    it('fails when the tag is present but its Release is missing where a changelog exists', async () => {
      mkdirSync(join(dir, 'pkgs', 'a'), { recursive: true });
      writeFileSync(join(dir, 'pkgs', 'a', 'CHANGELOG.md'), '# a\n');
      const { code, logs } = await runLocal({
        fetchImpl: refFetch({ commits: { '@s/a@1.0.0': HEAD } }),
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /@s\/a@1\.0\.0 \(GitHub Release\)/);
    });

    it('maps v<version> at HEAD to the root package', async () => {
      const root = { name: 'solo', version: '2.0.0', directory: '.' };
      const { code } = await runLocal({
        fetchImpl: refFetch({ commits: { 'v2.0.0': HEAD } }),
        run: gitRun({ tags: ['v2.0.0'], packages: [root] }),
        withManifest: false
      });
      assert.equal(code, 0);
    });

    it('does not throw when no manifest directory is given (publish skipped)', async () => {
      const { code } = await runLocal({
        fetchImpl: refFetch(),
        run: gitRun(),
        withManifest: false
      });
      assert.equal(code, 0);
    });

    it('throws on an HTTP 500 while looking up a local tag', async () => {
      const { code, logs } = await runLocal({
        fetchImpl: refFetch({ status: 500 }),
        run: gitRun({ tags: ['@s/a@1.0.0'], packages: [pkgA] }),
        withManifest: false
      });
      assert.equal(code, 1);
      assert.match(logs.join('\n'), /HTTP 500/);
      assert.doesNotMatch(logs.join('\n'), /Release tags missing/);
    });
  });
});

describe('tags file (@changesets/cli 3.x arm)', () => {
  const SHA = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const noGit = () => {
    throw new Error('the 3.x arm must not run any command');
  };
  const entry = (name, version, extra = {}) => ({
    tag: `${name}@${version}`,
    packageName: name,
    directory: `packages/${name.replace(/^@s\//, '')}`,
    ...extra
  });
  const created = (name, version, extra = {}) => ({
    ...entry(name, version),
    commit: SHA,
    ...extra
  });
  const tagsFile = ({ tags = [], expected = [] }) => {
    const file = join(dir, 'tags.json');
    writeFileSync(file, JSON.stringify({ tags, expected }));
    return file;
  };
  const expectedFile = (expected) => tagsFile({ expected });
  // Answers 200 for the tags in `commits` (each pointing at its commit) and
  // for the Releases in `releases`.
  const refFetch =
    ({ commits = {}, releases = [], status } = {}) =>
    async (url) => {
      if (status) return { status };
      if (url.includes('/releases/tags/')) {
        return {
          status: releases.includes(decodeURIComponent(url.split('/releases/tags/')[1])) ? 200 : 404
        };
      }
      const tag = decodeURIComponent(url.split('/git/ref/tags/')[1]);
      return tag in commits
        ? { status: 200, json: async () => ({ object: { type: 'commit', sha: commits[tag] } }) }
        : { status: 404 };
    };
  const runWith = ({ major = '3', file, fetchImpl, withManifest, sha = SHA }) => {
    const logs = [];
    const env = {
      GITHUB_REPOSITORY: 'o/r',
      GITHUB_TOKEN: 't',
      GITHUB_WORKSPACE: dir,
      CLI_MAJOR: major
    };
    if (sha !== undefined) env.GITHUB_SHA = sha;
    if (file !== undefined) env.TAGS_FILE = file;
    if (withManifest) env.TARBALL_DIRECTORY = dir;
    return main({ env, fetchImpl, run: noGit, log: (m) => logs.push(m) }).then((code) => ({
      code,
      logs
    }));
  };

  it('fails a tag-only private caller whose CLI created no tags (empty manifest, empty tags, non-empty expected)', async () => {
    writeManifest([]);
    const { code, logs } = await runWith({
      file: expectedFile([entry('@s/priv', '1.0.0')]),
      fetchImpl: fakeFetch().fetchImpl,
      withManifest: true
    });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /Release tags missing.*@s\/priv@1\.0\.0/);
  });

  it('passes when every expected tag is on the remote, at any commit', async () => {
    const { code, logs } = await runWith({
      file: expectedFile([entry('@s/a', '1.0.0'), entry('b', '2.0.0')]),
      fetchImpl: fakeFetch({ tags: ['@s/a@1.0.0', 'b@2.0.0'] }).fetchImpl
    });
    assert.equal(code, 0);
    assert.match(logs.join('\n'), /2 expected tag/);
  });

  it('reports every missing expected tag together with other missing tags', async () => {
    writeManifest([{ name: 'm', version: '1.0.0' }]);
    const { code, logs } = await runWith({
      file: expectedFile([entry('@s/a', '1.0.0'), entry('@s/b', '1.0.0')]),
      fetchImpl: fakeFetch({ tags: ['@s/a@1.0.0'] }).fetchImpl,
      withManifest: true
    });
    assert.equal(code, 1);
    const message = logs.join('\n');
    assert.match(message, /m@1\.0\.0/);
    assert.match(message, /@s\/b@1\.0\.0/);
    assert.doesNotMatch(message, /@s\/a@1\.0\.0/);
  });

  it('accepts empty lists as nothing to tag', async () => {
    const { code, logs } = await runWith({
      file: tagsFile({}),
      fetchImpl: fakeFetch().fetchImpl
    });
    assert.equal(code, 0);
    assert.match(logs.join('\n'), /Nothing to tag/);
  });

  it('accepts the v<version> tag form for a root package entry', async () => {
    const { code } = await runWith({
      file: expectedFile([{ ...entry('root', '1.2.3'), tag: 'v1.2.3', directory: '.' }]),
      fetchImpl: fakeFetch({ tags: ['v1.2.3'] }).fetchImpl
    });
    assert.equal(code, 0);
  });

  it('takes the created tags from the file, not from local tags, and runs no command', async () => {
    const file = tagsFile({ tags: [created('@s/a', '1.0.0')] });
    const { code } = await runWith({
      file,
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': SHA } })
    });
    assert.equal(code, 0);
  });

  it('fails a created tag that is missing, at another commit, or without its Release', async () => {
    mkdirSync(join(dir, 'packages', 'a'), { recursive: true });
    writeFileSync(join(dir, 'packages', 'a', 'CHANGELOG.md'), '# a\n');
    const file = tagsFile({ tags: [created('@s/a', '1.0.0')] });
    const missing = await runWith({ file, fetchImpl: refFetch() });
    assert.equal(missing.code, 1);
    assert.match(missing.logs.join('\n'), /@s\/a@1\.0\.0/);
    const moved = await runWith({
      file,
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': OTHER } })
    });
    assert.equal(moved.code, 1);
    assert.match(moved.logs.join('\n'), /points at another commit/);
    const noRelease = await runWith({
      file,
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': SHA } })
    });
    assert.equal(noRelease.code, 1);
    assert.match(noRelease.logs.join('\n'), /\(GitHub Release\)/);
    const ok = await runWith({
      file,
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': SHA }, releases: ['@s/a@1.0.0'] })
    });
    assert.equal(ok.code, 0);
  });

  it('an expected tag at another commit passes, an unchanged package keeps its earlier tag', async () => {
    const { code } = await runWith({
      file: expectedFile([entry('@s/a', '1.0.0')]),
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': OTHER } })
    });
    assert.equal(code, 0);
  });

  it('fails without GITHUB_SHA on 3.x', async () => {
    const { code, logs } = await runWith({
      file: tagsFile({ tags: [created('@s/a', '1.0.0')] }),
      fetchImpl: refFetch({ commits: { '@s/a@1.0.0': SHA } }),
      sha: ''
    });
    assert.equal(code, 1);
    assert.match(logs.join('\n'), /GITHUB_SHA/);
  });

  it('the 2.x arm and an empty major ignore the tags file, even a missing file', async () => {
    const file = tagsFile({ expected: [entry('@s/priv', '1.0.0')] });
    const gitless = () => ({ status: 1, stdout: '' });
    for (const major of ['2', '']) {
      for (const f of [file, join(dir, 'absent.json'), undefined]) {
        const logs = [];
        const env = {
          GITHUB_REPOSITORY: 'o/r',
          GITHUB_TOKEN: 't',
          GITHUB_WORKSPACE: dir,
          CLI_MAJOR: major
        };
        if (f !== undefined) env.TAGS_FILE = f;
        const code = await main({
          env,
          fetchImpl: fakeFetch().fetchImpl,
          run: gitless,
          log: (m) => logs.push(m)
        });
        assert.equal(code, 0);
      }
    }
  });

  it('fails closed on 3.x without a readable tags file', async () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    const noExpected = join(dir, 'noexpected.json');
    writeFileSync(noExpected, JSON.stringify({ tags: [] }));
    const noTags = join(dir, 'notags.json');
    writeFileSync(noTags, JSON.stringify({ expected: [] }));
    for (const file of [undefined, '', join(dir, 'absent.json'), bad, noExpected, noTags]) {
      const { code, logs } = await runWith({ file, fetchImpl: fakeFetch().fetchImpl });
      assert.equal(code, 1, String(file));
      assert.match(logs.join('\n'), /tags file/);
    }
  });

  it('fails closed on any malformed entry in either list', async () => {
    const good = entry('@s/a', '1.0.0');
    const bad = [
      { ...good, packageName: 'UPPER' },
      { ...good, packageName: '../x' },
      { ...good, tag: 'a b' },
      { ...good, directory: '' },
      { ...good, directory: 7 },
      { ...good, extra: 'x' },
      { ...good, commit: SHA },
      { packageName: good.packageName, tag: good.tag },
      'not an object',
      null,
      [good]
    ];
    for (const item of bad) {
      const { code, logs } = await runWith({
        file: expectedFile([item]),
        fetchImpl: fakeFetch({ tags: ['@s/a@1.0.0'] }).fetchImpl
      });
      assert.equal(code, 1, JSON.stringify(item));
      assert.match(logs.join('\n'), /malformed expected entry/);
    }
    for (const item of [good, { ...created('@s/a', '1.0.0'), commit: 'short' }]) {
      const { code, logs } = await runWith({
        file: tagsFile({ tags: [item] }),
        fetchImpl: fakeFetch({ tags: ['@s/a@1.0.0'] }).fetchImpl
      });
      assert.equal(code, 1, JSON.stringify(item));
      assert.match(logs.join('\n'), /malformed tags entry/);
    }
    const dup = await runWith({
      file: expectedFile([good, good]),
      fetchImpl: fakeFetch({ tags: ['@s/a@1.0.0'] }).fetchImpl
    });
    assert.equal(dup.code, 1);
  });

  it('fails on an API error while looking up an expected tag, and on an unknown major', async () => {
    const api = await runWith({
      file: expectedFile([entry('@s/a', '1.0.0')]),
      fetchImpl: fakeFetch({ status: 500 }).fetchImpl
    });
    assert.equal(api.code, 1);
    assert.match(api.logs.join('\n'), /HTTP 500/);
    const unknown = await runWith({ major: '4', fetchImpl: fakeFetch().fetchImpl });
    assert.equal(unknown.code, 1);
    assert.match(unknown.logs.join('\n'), /CLI_MAJOR/);
  });
});
