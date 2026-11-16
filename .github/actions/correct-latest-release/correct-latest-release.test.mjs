import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

const { compareSemver, correctLatest, isHighestStable, parseTag, recordLatest } = createRequire(
  import.meta.url
)('./correct-latest-release.cjs');

const context = { repo: { owner: 'o', repo: 'r' } };

/** Fake Octokit: `latest` is the Latest Release now (or null), `tags` the repo's tags. */
function fakeGithub({ latest, tags = [], releaseIds = {}, noRelease = [] }) {
  const updates = [];
  const github = {
    paginate: async (fn, params) => {
      assert.equal(fn, github.rest.repos.listTags);
      assert.deepEqual(Object.keys(params).sort(), ['owner', 'per_page', 'repo']);
      return tags.map((name) => ({ name }));
    },
    rest: {
      repos: {
        getLatestRelease: async () => {
          if (latest === null) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { id: latest.id, tag_name: latest.tag } };
        },
        listTags: () => {},
        getReleaseByTag: async ({ tag }) => {
          if (noRelease.includes(tag)) throw Object.assign(new Error('Not Found'), { status: 404 });
          return { data: { id: releaseIds[tag] ?? 99 } };
        },
        updateRelease: async (params) => {
          updates.push(params);
        }
      }
    }
  };
  return { github, updates };
}
const fakeCore = () => {
  const outputs = {};
  return { outputs, core: { setOutput: (k, v) => (outputs[k] = v), info: () => {} } };
};
const run = async ({ latest, tags, previous, releaseIds, noRelease }) => {
  const { github, updates } = fakeGithub({ latest, tags, releaseIds, noRelease });
  const { core } = fakeCore();
  const result = await correctLatest({
    github,
    context,
    core,
    previousId: previous ? String(previous.id) : '',
    previousTag: previous?.tag ?? ''
  });
  return { result, updates };
};

describe('parseTag and isHighestStable', () => {
  it('parses name@version, v-prefixed and bare tags', () => {
    assert.deepEqual(parseTag('@s/a@1.2.3'), { pkg: '@s/a', version: '1.2.3' });
    assert.deepEqual(parseTag('v1.2.3'), { pkg: '', version: '1.2.3' });
    assert.deepEqual(parseTag('1.2.3-rc.1'), { pkg: '', version: '1.2.3-rc.1' });
    assert.equal(parseTag('release-2026'), null);
  });
  it('orders prereleases below their release', () => {
    assert.ok(compareSemver('1.0.0-rc.1', '1.0.0') < 0);
    assert.ok(compareSemver('1.0.0-pre.10', '1.0.0-pre.9') > 0);
  });
  it('judges highest per package', () => {
    const allTags = ['a@2.0.0', 'a@1.9.0', 'b@1.0.0', 'b@1.0.1', 'a@3.0.0-pre.1'];
    assert.equal(isHighestStable({ tag: 'a@2.0.0', allTags }), true);
    assert.equal(isHighestStable({ tag: 'a@1.9.0', allTags }), false);
    assert.equal(isHighestStable({ tag: 'b@1.0.1', allTags }), true);
    assert.equal(isHighestStable({ tag: 'a@3.0.0-pre.1', allTags }), false);
  });
});

describe('recordLatest', () => {
  it('records the current Latest Release as outputs', async () => {
    const { github } = fakeGithub({ latest: { id: 7, tag: 'a@2.0.0' } });
    const { core, outputs } = fakeCore();
    await recordLatest({ github, context, core });
    assert.deepEqual(outputs, { 'previous-id': '7', 'previous-tag': 'a@2.0.0' });
  });
  it('records nothing when there is no Latest Release (404)', async () => {
    const { github } = fakeGithub({ latest: null });
    const { core, outputs } = fakeCore();
    await recordLatest({ github, context, core });
    assert.deepEqual(outputs, { 'previous-id': '', 'previous-tag': '' });
  });
  it('does not swallow other errors', async () => {
    const github = {
      rest: {
        repos: {
          getLatestRelease: async () => {
            throw Object.assign(new Error('boom'), { status: 500 });
          }
        }
      }
    };
    await assert.rejects(recordLatest({ github, context, core: fakeCore().core }), /boom/);
  });
});

describe('correctLatest', () => {
  const previous = { id: 7, tag: 'a@2.0.0' };

  it('keeps a new higher stable Release as Latest', async () => {
    const { result, updates } = await run({
      latest: { id: 8, tag: 'a@2.1.0' },
      tags: ['a@2.0.0', 'a@2.1.0'],
      previous
    });
    assert.equal(result, 'kept');
    assert.deepEqual(updates, []);
  });

  it('restores Latest when the new Latest is an older stable version', async () => {
    const { result, updates } = await run({
      latest: { id: 8, tag: 'a@1.9.1' },
      tags: ['a@2.0.0', 'a@1.9.0', 'a@1.9.1'],
      previous
    });
    assert.equal(result, 'restored');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 7, make_latest: 'true' }]);
  });

  it('restores Latest when the new Latest is a prerelease, even a semver-higher one', async () => {
    const { result, updates } = await run({
      latest: { id: 8, tag: 'a@3.0.0-pre.3' },
      tags: ['a@2.0.0', 'a@3.0.0-pre.3'],
      previous
    });
    assert.equal(result, 'restored');
    assert.equal(updates[0].release_id, 7);
  });

  it('judges the new Latest against its own package in a multi-package repo', async () => {
    const tags = ['a@2.0.0', 'b@1.0.0', 'b@1.1.0'];
    const higher = await run({ latest: { id: 8, tag: 'b@1.1.0' }, tags, previous });
    assert.equal(higher.result, 'kept');
    const older = await run({
      latest: { id: 9, tag: 'b@1.0.0' },
      tags: [...tags, 'b@1.2.0'],
      previous
    });
    assert.equal(older.result, 'restored');
  });

  it('does nothing when Latest is still the recorded Release', async () => {
    const { result, updates } = await run({ latest: previous, tags: ['a@2.0.0'], previous });
    assert.equal(result, 'unchanged');
    assert.deepEqual(updates, []);
  });

  it('with no earlier Latest, keeps a highest stable Release as Latest', async () => {
    const { result, updates } = await run({
      latest: { id: 1, tag: 'v1.0.0' },
      tags: ['v1.0.0'],
      previous: null
    });
    assert.equal(result, 'kept');
    assert.deepEqual(updates, []);
  });

  it("with no earlier Latest, sets Latest to the package's highest stable Release", async () => {
    const { result, updates } = await run({
      latest: { id: 2, tag: 'a@1.9.1' },
      tags: ['a@2.0.0', 'a@1.9.1', 'b@5.0.0'],
      releaseIds: { 'a@2.0.0': 50, 'b@5.0.0': 60 },
      previous: null
    });
    assert.equal(result, 'promoted');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 50, make_latest: 'true' }]);
  });

  it('with no earlier Latest and only prereleases, clears the new Release as Latest', async () => {
    const { result, updates } = await run({
      latest: { id: 3, tag: 'a@1.0.0-rc.2' },
      tags: ['a@1.0.0-rc.1', 'a@1.0.0-rc.2', 'b@2.0.0'],
      previous: null
    });
    assert.equal(result, 'cleared');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 3, make_latest: 'false' }]);
  });

  it('does nothing when the repository has no Latest Release', async () => {
    const { result, updates } = await run({ latest: null, tags: [], previous: null });
    assert.equal(result, 'unchanged');
    assert.deepEqual(updates, []);
  });
  // Review findings on the first version of the helper, each a separate input.
  it('F1: never restores a stale recorded holder that is no longer its package highest', async () => {
    // Run B recorded v3.9.0; run A then released v4.0.0; B created v3.9.1.
    const { result, updates } = await run({
      latest: { id: 3, tag: 'v3.9.1' },
      tags: ['v3.9.0', 'v4.0.0', 'v3.9.1'],
      releaseIds: { 'v4.0.0': 2 },
      previous: { id: 1, tag: 'v3.9.0' }
    });
    assert.equal(result, 'promoted');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 2, make_latest: 'true' }]);
  });

  it('F2: a re-run after a failed correction still fixes a wrong Latest', async () => {
    // The re-run records the already-wrong Latest as the previous holder.
    const { result, updates } = await run({
      latest: { id: 3, tag: 'v3.9.1' },
      tags: ['v3.9.0', 'v4.0.0', 'v3.9.1'],
      releaseIds: { 'v4.0.0': 2 },
      previous: { id: 3, tag: 'v3.9.1' }
    });
    assert.equal(result, 'promoted');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 2, make_latest: 'true' }]);
  });

  it('F3: falls down the stable tags past one with no Release instead of failing', async () => {
    const { result, updates } = await run({
      latest: { id: 5, tag: 'v2.0.1' },
      tags: ['v2.0.0', 'v3.0.0', 'v4.0.0', 'v2.0.1'],
      releaseIds: { 'v3.0.0': 30 },
      noRelease: ['v4.0.0'],
      previous: null
    });
    assert.equal(result, 'promoted');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 30, make_latest: 'true' }]);
  });

  it('F3: keeps the current stable Latest when every higher tag has no Release', async () => {
    const { result, updates } = await run({
      latest: { id: 5, tag: 'v2.0.1' },
      tags: ['v2.0.0', 'v3.0.0', 'v2.0.1'],
      noRelease: ['v3.0.0'],
      previous: null
    });
    assert.equal(result, 'kept');
    assert.deepEqual(updates, []);
  });

  it('F3: clears a prerelease Latest when no stable tag has a Release', async () => {
    const { result, updates } = await run({
      latest: { id: 5, tag: 'a@2.0.0-rc.1' },
      tags: ['a@1.0.0', 'a@2.0.0-rc.1'],
      noRelease: ['a@1.0.0'],
      previous: null
    });
    assert.equal(result, 'cleared');
    assert.deepEqual(updates, [{ owner: 'o', repo: 'r', release_id: 5, make_latest: 'false' }]);
  });

  it('does not swallow non-404 errors from the Release lookup', async () => {
    const { github } = fakeGithub({
      latest: { id: 2, tag: 'a@1.9.1' },
      tags: ['a@2.0.0', 'a@1.9.1']
    });
    github.rest.repos.getReleaseByTag = async () => {
      throw Object.assign(new Error('boom'), { status: 500 });
    };
    await assert.rejects(
      correctLatest({ github, context, core: fakeCore().core, previousId: '', previousTag: '' }),
      /boom/
    );
  });
});
