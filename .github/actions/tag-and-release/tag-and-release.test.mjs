import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const { changelogSection, tagAndRelease } = createRequire(import.meta.url)('./tag-and-release.cjs');

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const context = { repo: { owner: 'o', repo: 'r' }, sha: SHA };
const scratch = mkdtempSync(join(tmpdir(), 'tag-and-release-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let counter = 0;

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

/** A workspace with a tags file; `changelogs` maps a directory to CHANGELOG.md text. */
function setup({ tags, changelogs = {}, config }) {
  const workspace = join(scratch, `w${counter++}`);
  mkdirSync(join(workspace, '.changeset'), { recursive: true });
  if (config !== undefined)
    writeFileSync(join(workspace, '.changeset', 'config.json'), JSON.stringify(config));
  for (const [dir, text] of Object.entries(changelogs)) {
    mkdirSync(join(workspace, dir), { recursive: true });
    writeFileSync(join(workspace, dir, 'CHANGELOG.md'), text);
  }
  const tagsFile = join(workspace, 'tags.json');
  writeFileSync(tagsFile, JSON.stringify({ tags }));
  return { workspace, tagsFile };
}

/** Fake Octokit. `refs`: tag -> {type, sha}; `annotated`: tag sha -> commit; `releases`: tags with a Release. */
function fakeGithub({ refs = {}, annotated = {}, releases = [], repoTags = [], lookupStatus }) {
  const calls = { createRef: [], createRelease: [] };
  const github = {
    request: async (route, { tag }) => {
      assert.equal(route, 'GET /repos/{owner}/{repo}/git/ref/tags/{tag}');
      if (lookupStatus) throw Object.assign(new Error('boom'), { status: lookupStatus });
      if (!(tag in refs)) throw notFound();
      return { data: { object: refs[tag] } };
    },
    paginate: async () => repoTags.map((name) => ({ name })),
    rest: {
      git: {
        getTag: async ({ tag_sha }) => ({
          data: { object: { type: 'commit', sha: annotated[tag_sha] } }
        }),
        createRef: async (p) => void calls.createRef.push(p)
      },
      repos: {
        listTags: () => {},
        getReleaseByTag: async ({ tag }) => {
          if (!releases.includes(tag)) throw notFound();
          return { data: {} };
        },
        createRelease: async (p) => void calls.createRelease.push(p)
      }
    }
  };
  return { github, calls };
}

const run = async ({ gh, fixture }) => {
  const outputs = {};
  const core = { setOutput: (k, v) => (outputs[k] = v), info: () => {} };
  const result = await tagAndRelease({ github: gh.github, context, core, ...fixture });
  return { outputs, result };
};

const pub = (version) => ({
  tag: `@s/pub@${version}`,
  packageName: '@s/pub',
  directory: 'packages/pub'
});
const log = (version, body = 'Notes') =>
  `# @s/pub\n\n## ${version}\n\n${body}\n\n## 0.0.1\n\nOld\n`;

describe('tag-and-release', () => {
  it('creates an absent ref at the run commit, then the Release', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({});
    const { outputs } = await run({ gh, fixture });
    assert.deepEqual(gh.calls.createRef, [
      { owner: 'o', repo: 'r', ref: 'refs/tags/@s/pub@1.0.0', sha: SHA }
    ]);
    assert.equal(gh.calls.createRelease[0].body, 'Notes');
    assert.equal(outputs['releases-created'], 'true');
  });

  it('leaves a ref at the run commit alone (re-run) and creates no missing Release twice', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({
      refs: { '@s/pub@1.0.0': { type: 'commit', sha: SHA } },
      releases: ['@s/pub@1.0.0']
    });
    const { outputs } = await run({ gh, fixture });
    assert.equal(gh.calls.createRef.length, 0);
    assert.equal(gh.calls.createRelease.length, 0);
    assert.equal(outputs['releases-created'], 'false');
  });

  it('a ref at another commit fails and creates nothing for that tag', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({ refs: { '@s/pub@1.0.0': { type: 'commit', sha: OTHER } } });
    await assert.rejects(run({ gh, fixture }), /different commit/);
    assert.equal(gh.calls.createRef.length, 0);
    assert.equal(gh.calls.createRelease.length, 0);
  });

  it('an annotated tag is dereferenced before comparing', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const ok = fakeGithub({
      refs: { '@s/pub@1.0.0': { type: 'tag', sha: 'tagobj' } },
      annotated: { tagobj: SHA }
    });
    await run({ gh: ok, fixture });
    assert.equal(ok.calls.createRef.length, 0);
    const bad = fakeGithub({
      refs: { '@s/pub@1.0.0': { type: 'tag', sha: 'tagobj' } },
      annotated: { tagobj: OTHER }
    });
    await assert.rejects(run({ gh: bad, fixture }), /different commit/);
  });

  it('a Release that exists is skipped', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({ releases: ['@s/pub@1.0.0'] });
    const { outputs } = await run({ gh, fixture });
    assert.equal(gh.calls.createRelease.length, 0);
    assert.equal(outputs['releases-created'], 'false');
  });

  it('no CHANGELOG.md means no Release, but the tag is still created', async () => {
    const fixture = setup({ tags: [pub('1.0.0')] });
    const gh = fakeGithub({});
    const { outputs } = await run({ gh, fixture });
    assert.equal(gh.calls.createRef.length, 1);
    assert.equal(gh.calls.createRelease.length, 0);
    assert.equal(outputs['releases-created'], 'false');
  });

  it('changelog disabled in the config means no Release', async () => {
    const fixture = setup({
      tags: [pub('1.0.0')],
      changelogs: { 'packages/pub': log('1.0.0') },
      config: { changelog: false }
    });
    const gh = fakeGithub({});
    await run({ gh, fixture });
    assert.equal(gh.calls.createRelease.length, 0);
  });

  it('a CHANGELOG.md without the version section fails and creates no Release', async () => {
    const fixture = setup({ tags: [pub('2.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({});
    await assert.rejects(run({ gh, fixture }), /no "## 2\.0\.0" section/);
    assert.equal(gh.calls.createRelease.length, 0);
  });

  it('a prerelease gets prerelease true and make_latest false', async () => {
    const fixture = setup({
      tags: [pub('2.0.0-rc.1')],
      changelogs: { 'packages/pub': log('2.0.0-rc.1') }
    });
    const gh = fakeGithub({ repoTags: ['@s/pub@1.0.0'] });
    await run({ gh, fixture });
    assert.equal(gh.calls.createRelease[0].prerelease, true);
    assert.equal(gh.calls.createRelease[0].make_latest, 'false');
  });

  it('an older stable version gets make_latest false', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({ repoTags: ['@s/pub@1.0.0', '@s/pub@2.0.0'] });
    await run({ gh, fixture });
    assert.equal(gh.calls.createRelease[0].make_latest, 'false');
    assert.equal(gh.calls.createRelease[0].prerelease, false);
  });

  it('the highest stable version gets make_latest true', async () => {
    const fixture = setup({ tags: [pub('2.0.0')], changelogs: { 'packages/pub': log('2.0.0') } });
    const gh = fakeGithub({ repoTags: ['@s/pub@1.0.0'] });
    await run({ gh, fixture });
    assert.equal(gh.calls.createRelease[0].make_latest, 'true');
  });

  it('a 5xx on lookup throws and is not read as absent', async () => {
    const fixture = setup({ tags: [pub('1.0.0')], changelogs: { 'packages/pub': log('1.0.0') } });
    const gh = fakeGithub({ lookupStatus: 503 });
    await assert.rejects(run({ gh, fixture }), /boom/);
    assert.equal(gh.calls.createRef.length, 0);
  });

  it('an empty tag list does nothing and succeeds', async () => {
    const fixture = setup({ tags: [] });
    const gh = fakeGithub({});
    const { outputs } = await run({ gh, fixture });
    assert.equal(gh.calls.createRef.length, 0);
    assert.equal(outputs['releases-created'], 'false');
  });

  it('a private root package tag with v<version> is created and released from the root changelog', async () => {
    const fixture = setup({
      tags: [{ tag: 'v1.0.0', packageName: 'root', directory: '.' }],
      changelogs: { '.': '# root\n\n## 1.0.0\n\nRoot notes\n' }
    });
    const gh = fakeGithub({});
    await run({ gh, fixture });
    assert.equal(gh.calls.createRelease[0].tag_name, 'v1.0.0');
    assert.equal(gh.calls.createRelease[0].body, 'Root notes');
  });
});

describe('changelogSection', () => {
  it('returns the text up to the next version heading', () => {
    assert.equal(
      changelogSection({ text: log('1.0.0', 'A\n\n### Minor\n\nB'), version: '1.0.0' }),
      'A\n\n### Minor\n\nB'
    );
  });
  it('returns null when the heading is absent', () => {
    assert.equal(changelogSection({ text: log('1.0.0'), version: '9.9.9' }), null);
  });
});
