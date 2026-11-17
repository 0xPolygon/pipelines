// Part B of the 3.x finalize tagging: pushes the tags that collect-tags.mjs
// created locally and creates a GitHub Release for each.
//
// Everything goes through the GitHub API with the token the calling step was
// given; no repository dependency code runs here. Safe to re-run: a tag that
// already points at the run's commit is left alone, a tag that points
// anywhere else fails the step and is never moved, and a Release that exists
// is never recreated. A Release that is missing for a tag at the run's commit
// (a previous attempt pushed the ref and failed before the Release) is created.
//
// Loaded with require() from actions/github-script, which is why this is CommonJS.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  isHighestStable,
  parseTag
} = require('../correct-latest-release/correct-latest-release.cjs');

const isNotFound = (err) => err.status === 404;

/** The commit a tag ref resolves to; null when the ref is absent. An annotated tag is dereferenced. */
async function resolveTagCommit({ github, owner, repo, tag }) {
  let data;
  try {
    // The tag is one path segment (slashes encoded), as for any scoped name.
    ({ data } = await github.request('GET /repos/{owner}/{repo}/git/ref/tags/{tag}', {
      owner,
      repo,
      tag
    }));
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
  let object = data.object;
  while (object.type === 'tag') {
    ({
      data: { object }
    } = await github.rest.git.getTag({ owner, repo, tag_sha: object.sha }));
  }
  return object.sha;
}

async function releaseExists({ github, owner, repo, tag }) {
  try {
    await github.rest.repos.getReleaseByTag({ owner, repo, tag });
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

function changelogsEnabled(workspace) {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(workspace, '.changeset', 'config.json'), 'utf8')
    );
    return config.changelog !== false;
  } catch {
    return true;
  }
}

/**
 * The text under the `## <version>` heading, up to the next `## ` heading.
 * Null when the heading is absent.
 */
function changelogSection({ text, version }) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

/** Resolves a package directory inside the workspace; null when it escapes it. */
function packageDirectory({ workspace, directory }) {
  const root = path.resolve(workspace);
  const dir = path.resolve(root, directory);
  const rel = path.relative(root, dir);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) ? null : dir;
}

/**
 * Pushes every tag in the tags file and creates a Release for each tag that
 * needs one. A Release is created for every created tag, and also for every
 * `expected` tag whose remote ref already points at this run's commit and has
 * no Release: the recovery after a run that pushed its refs and failed before
 * creating the Release. An expected tag at any other commit is never touched.
 * Every changelog is read before the first ref is created, so a changelog
 * error leaves nothing half done. Sets the step output `releases-created` to
 * 'true' when this run created at least one GitHub Release (not merely a tag
 * ref), else 'false'.
 */
async function tagAndRelease({ github, context, core, tagsFile, workspace }) {
  const { owner, repo } = context.repo;
  const { tags, expected = [] } = JSON.parse(fs.readFileSync(tagsFile, 'utf8'));
  core.setOutput('releases-created', 'false');
  if (tags.length === 0 && expected.length === 0) {
    core.info('Nothing to tag');
    return { created: [] };
  }

  const wrongCommit = [];
  const refsToCreate = [];
  for (const { tag } of tags) {
    const commit = await resolveTagCommit({ github, owner, repo, tag });
    if (commit === null) refsToCreate.push(tag);
    else if (commit !== context.sha) wrongCommit.push(`${tag} (at ${commit})`);
  }
  if (wrongCommit.length > 0) {
    throw new Error(
      `These tags already exist on the remote at a different commit than ${context.sha}, ` +
        `and are never moved: ${wrongCommit.join(', ')}. Check whether that version was released ` +
        'from another commit; if the existing tag is wrong, delete it in the repository and ' +
        're-run the failed job. The workflow never moves or deletes a tag itself.'
    );
  }

  // Tags that need a Release: the created ones (they will point at this
  // commit) and the expected ones that already do.
  const candidates = [...tags];
  const createdTags = new Set(tags.map((t) => t.tag));
  for (const entry of expected) {
    if (createdTags.has(entry.tag)) continue;
    if ((await resolveTagCommit({ github, owner, repo, tag: entry.tag })) === context.sha) {
      candidates.push(entry);
    }
  }

  const enabled = changelogsEnabled(workspace);
  // Read and validate every changelog before creating any ref or Release.
  const pending = [];
  for (const { tag, directory } of candidates) {
    const parsed = parseTag(tag);
    if (parsed === null) throw new Error(`${tag} is not a version tag`);
    const dir = packageDirectory({ workspace, directory });
    const changelog = dir === null ? null : path.join(dir, 'CHANGELOG.md');
    if (!enabled || changelog === null || !fs.existsSync(changelog)) {
      core.info(`${tag} has no CHANGELOG.md; no Release`);
      continue;
    }
    if (await releaseExists({ github, owner, repo, tag })) {
      core.info(`${tag} already has a Release`);
      continue;
    }
    const body = changelogSection({
      text: fs.readFileSync(changelog, 'utf8'),
      version: parsed.version
    });
    if (body === null) {
      throw new Error(
        `${path.relative(workspace, changelog)} has no "## ${parsed.version}" section`
      );
    }
    pending.push({ tag, body, version: parsed.version });
  }

  for (const tag of refsToCreate) {
    await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${tag}`, sha: context.sha });
    core.info(`Created tag ${tag}`);
  }

  const existing = await github.paginate(github.rest.repos.listTags, {
    owner,
    repo,
    per_page: 100
  });
  const allTags = [...new Set([...existing.map((t) => t.name), ...candidates.map((t) => t.tag)])];

  const created = [];
  for (const { tag, body, version } of pending) {
    const prerelease = version.includes('-');
    await github.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      // Pins the commit if the tag ref vanished since it was created above.
      target_commitish: context.sha,
      name: tag,
      body,
      prerelease,
      make_latest: !prerelease && isHighestStable({ tag, allTags }) ? 'true' : 'false'
    });
    created.push(tag);
    core.info(`Created Release ${tag}`);
  }
  core.setOutput('releases-created', created.length > 0 ? 'true' : 'false');
  return { created };
}

module.exports = { changelogSection, tagAndRelease };
