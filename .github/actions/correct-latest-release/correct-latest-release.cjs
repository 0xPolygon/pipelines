// Keeps the repository's Latest Release from moving backwards.
//
// GitHub marks the Release it creates as Latest by default, so when releases
// are approved out of order an older version created last would become Latest.
// finalize records the Latest Release before changesets/action creates
// Releases (recordLatest), then restores it afterwards when the new Latest is
// not the highest stable version of its own package (correctLatest). A repo
// has one Latest Release but may hold several packages, so "highest" is
// judged per package, using that package's git tags.
//
// Loaded with require() from actions/github-script, which is why this is CommonJS.

'use strict';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(text) {
  const match = SEMVER.exec(String(text));
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
  const at = tag.lastIndexOf('@');
  if (at > 0) {
    const version = tag.slice(at + 1);
    return parseSemver(version) ? { pkg: tag.slice(0, at), version } : null;
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  return parseSemver(version) ? { pkg: '', version } : null;
}

const isStable = (version) => parseSemver(version).pre.length === 0;

/** The highest stable tag of a package, or null when it has none. */
function highestStableTag({ pkg, allTags }) {
  let best = null;
  for (const tag of allTags) {
    const parsed = parseTag(tag);
    if (parsed === null || parsed.pkg !== pkg || !isStable(parsed.version)) continue;
    if (best === null || compareSemver(parsed.version, parseTag(best).version) > 0) best = tag;
  }
  return best;
}

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

/**
 * After Releases were created: when the Latest Release is no longer the
 * recorded one and is not the highest stable version of its package, puts
 * Latest back with make_latest. `previousId` is recorded by recordLatest ('' for none).
 * Returns what it did: 'unchanged' | 'kept' | 'restored' | 'promoted' | 'cleared'.
 */
async function correctLatest({ github, context, core, previousId, previousTag }) {
  const { owner, repo } = context.repo;
  const current = await getLatestRelease({ github, owner, repo });
  if (current === null) return 'unchanged';
  if (previousId !== '' && String(current.id) === String(previousId)) return 'unchanged';

  const tags = (
    await github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 })
  ).map((t) => t.name);
  if (isHighestStable({ tag: current.tag, allTags: tags })) {
    core.info(`${current.tag} is the highest stable version of its package; keeping it as Latest`);
    return 'kept';
  }

  if (previousId !== '') {
    await github.rest.repos.updateRelease({
      owner,
      repo,
      release_id: Number(previousId),
      make_latest: 'true'
    });
    core.info(
      `${current.tag} is not the highest stable version of its package; restored Latest to ${previousTag}`
    );
    return 'restored';
  }
  // No earlier Latest to return to. Name one explicitly rather than leave
  // GitHub to choose: the package's highest stable Release when it has one,
  // otherwise (only prereleases so far) just stop the new Release being Latest.
  const parsed = parseTag(current.tag);
  const best = parsed === null ? null : highestStableTag({ pkg: parsed.pkg, allTags: tags });
  if (best !== null) {
    const { data } = await github.rest.repos.getReleaseByTag({ owner, repo, tag: best });
    await github.rest.repos.updateRelease({
      owner,
      repo,
      release_id: data.id,
      make_latest: 'true'
    });
    core.info(
      `${current.tag} is not the highest stable version of its package; set Latest to ${best}`
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
    `${current.tag} is not the highest stable version of its package and none exists; cleared it as Latest`
  );
  return 'cleared';
}

module.exports = { compareSemver, correctLatest, isHighestStable, parseTag, recordLatest };
