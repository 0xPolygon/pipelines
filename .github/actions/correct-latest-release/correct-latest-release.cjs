// Keeps the repository's Latest Release from moving backwards.
//
// GitHub marks the Release it creates as Latest by default, so when releases
// are approved out of order an older version created last would become Latest.
// finalize records the Latest Release before changesets/action creates
// Releases (recordLatest), then judges the CURRENT Latest afterwards
// (correctLatest): if it is not the highest stable version of its own package,
// Latest is moved to a better Release. The recorded holder is only a hint,
// used when it is still the highest stable of its package; decisions never
// rest on it alone, because finalize runs are not serialized and a record can
// be stale, and a re-run after a failure records an already-wrong Latest. A
// repo has one Latest Release but may hold several packages, so "highest" is
// judged per package, using that package's git tags.
//
// Loaded with require() from actions/github-script, which is why this is CommonJS.

'use strict';

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(text) {
  const match = SEMVER.exec(String(text).trim());
  if (!match) return null;
  return {
    core: [match[1], match[2], match[3]].map(Number),
    pre: match[4] === undefined ? [] : match[4].split('.')
  };
}

/** Semver 2.0 precedence; same rules as the publish action's comparison. */
function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1;
  }
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < length; i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Splits a release tag into its package and version: `<name>@<version>`
 * (changesets' monorepo form) or `v<version>` / `<version>` (a root package,
 * package ''). Null for a tag that is neither.
 */
function parseTag(tag) {
  // The version inside a tag is bare: only a root tag may carry one `v`
  // prefix, which is stripped first. parseSemver itself tolerates a `v` (for
  // registry and Release versions), so a second one is refused here.
  const isVersion = (version) => !version.startsWith('v') && parseSemver(version) !== null;
  const at = tag.lastIndexOf('@');
  if (at > 0) {
    const version = tag.slice(at + 1);
    return isVersion(version) ? { pkg: tag.slice(0, at), version } : null;
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  return isVersion(version) ? { pkg: '', version } : null;
}

const isStable = (version) => parseSemver(version).pre.length === 0;

/** True when `tag` is a stable version with no higher stable tag for the same package. */
function isHighestStable({ tag, allTags }) {
  const parsed = parseTag(tag);
  if (!parsed || !isStable(parsed.version)) return false;
  return !allTags.some((other) => {
    const o = parseTag(other);
    return (
      o !== null &&
      o.pkg === parsed.pkg &&
      isStable(o.version) &&
      compareSemver(o.version, parsed.version) > 0
    );
  });
}

/** The repository's Latest Release, or null when it has none (404). */
async function getLatestRelease({ github, owner, repo }) {
  try {
    const { data } = await github.rest.repos.getLatestRelease({ owner, repo });
    return { id: data.id, tag: data.tag_name };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Reads the current Latest Release and exposes it as step outputs. Run before Releases are created. */
async function recordLatest({ github, context, core }) {
  const latest = await getLatestRelease({ github, ...context.repo });
  core.setOutput('previous-id', latest ? String(latest.id) : '');
  core.setOutput('previous-tag', latest ? latest.tag : '');
  core.info(latest ? `Latest Release before this run: ${latest.tag}` : 'No Latest Release yet');
}

/** The Release for a tag, or null when the tag has none (404). */
async function getReleaseByTag({ github, owner, repo, tag }) {
  try {
    const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag });
    return data;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** The package's stable tags, highest first. */
function stableTagsDescending({ pkg, allTags }) {
  return allTags
    .map((tag) => ({ tag, parsed: parseTag(tag) }))
    .filter(({ parsed }) => parsed !== null && parsed.pkg === pkg && isStable(parsed.version))
    .sort((a, b) => compareSemver(b.parsed.version, a.parsed.version))
    .map(({ tag }) => tag);
}

/**
 * After Releases were created: judges the CURRENT Latest Release from current
 * state. When it is its package's highest stable version it stays. Otherwise
 * Latest moves to, in order:
 *   1. the recorded holder, only if that is still the highest stable version
 *      of its own package (`previousId`/`previousTag` come from recordLatest,
 *      '' for none; a hint that may be stale);
 *   2. the highest stable tag of the wrong Latest's package that has a Release
 *      (falling down the tags past any without one);
 *   3. nothing: make_latest 'false' on the wrong one, when no stable Release exists.
 * Returns what it did: 'unchanged' | 'kept' | 'restored' | 'promoted' | 'cleared'.
 */
async function correctLatest({ github, context, core, previousId = '', previousTag = '' }) {
  const { owner, repo } = context.repo;
  const current = await getLatestRelease({ github, owner, repo });
  if (current === null) return 'unchanged';

  // A Latest whose tag is not a version tag was not made by a release this
  // workflow could judge (e.g. set by hand); leave it alone.
  const parsed = parseTag(current.tag);
  if (parsed === null) {
    core.info(`${current.tag} is not a version tag; leaving Latest unchanged`);
    return 'unchanged';
  }

  const tags = (
    await github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 })
  ).map((t) => t.name);
  if (isHighestStable({ tag: current.tag, allTags: tags })) {
    if (previousId !== '' && String(current.id) === String(previousId)) return 'unchanged';
    core.info(`${current.tag} is the highest stable version of its package; keeping it as Latest`);
    return 'kept';
  }

  const setLatest = (releaseId) =>
    github.rest.repos.updateRelease({
      owner,
      repo,
      release_id: releaseId,
      make_latest: 'true'
    });

  if (
    previousId !== '' &&
    String(current.id) !== String(previousId) &&
    isHighestStable({ tag: previousTag, allTags: tags })
  ) {
    await setLatest(Number(previousId));
    core.info(
      `${current.tag} is not the highest stable version of its package; restored Latest to ${previousTag}`
    );
    return 'restored';
  }

  // The recorded holder is gone, stale or absent: choose from current tags.
  const candidates = stableTagsDescending({ pkg: parsed.pkg, allTags: tags });
  for (const tag of candidates) {
    if (tag === current.tag) {
      core.info(`${current.tag} is the best stable Release its package has; keeping it as Latest`);
      return 'kept';
    }
    const release = await getReleaseByTag({ github, owner, repo, tag });
    if (release === null) {
      core.info(`${tag} has no Release; trying the next highest stable version`);
      continue;
    }
    await setLatest(release.id);
    core.info(
      `${current.tag} is not the highest stable version of its package; set Latest to ${tag}`
    );
    return 'promoted';
  }
  await github.rest.repos.updateRelease({
    owner,
    repo,
    release_id: current.id,
    make_latest: 'false'
  });
  core.info(
    `${current.tag} is not the highest stable version of its package and no stable Release exists; cleared it as Latest`
  );
  return 'cleared';
}

module.exports = { compareSemver, correctLatest, isHighestStable, parseTag, recordLatest };
