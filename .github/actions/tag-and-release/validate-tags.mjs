// Validates the tags artifact written by collect-tags.mjs before any step that
// holds a token uses it. The artifact comes from a job that ran the
// repository's own dependency code, so it is treated as untrusted input.
//
// This script imports only node built-ins and never loads code from the
// repository: it reads package.json files as data. Every entry, in `tags` and
// in `expected`, must name a package that exists at the entry's directory in
// this checkout, and its tag must be exactly that package's `<name>@<version>`
// (or `v<version>` for the root package). Every `commit` must equal the
// commit this run is for. Beyond the entry shape, the artifact is held to what
// the repository's own configuration allows, read as plain data: every created
// tag is also an expected tag; an entry's directory is a workspace package
// (the globs of pnpm-workspace.yaml, or the one root package of a repository
// without a workspace file; `v<version>` only names that root package); a
// package listed by literal name under `ignore` in .changeset/config.json is
// never an entry; and a private package is an entry only when
// `privatePackages` turns tagging on. A pattern shape this script cannot
// evaluate fails closed. Any other shape fails closed with one error that
// lists every bad entry.

import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const NPM_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const COMMIT = /^[0-9a-f]{40}$/;
const TAG_KEYS = ['commit', 'directory', 'packageName', 'tag'];
const EXPECTED_KEYS = ['directory', 'packageName', 'tag'];
const MAX_ENTRIES = 5000;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function insideWorkspace({ root, directory }) {
  if (directory === '' || isAbsolute(directory) || directory.includes('\\')) return undefined;
  const dir = resolve(root, directory);
  const rel = relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  try {
    const real = realpathSync(dir);
    const realRel = relative(realpathSync(root), real);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

// Characters that make a pattern something other than a literal path segment.
const GLOB_CHARS = /[*?[\]{}()!]/;

/**
 * Reads the workspace package patterns of the checkout with plain fs: the
 * `packages:` list of pnpm-workspace.yaml (block list only), or `null` for a
 * repository with no workspace file, whose only package is the root. Throws
 * when the layout cannot be evaluated.
 */
function readWorkspacePatterns(root) {
  let text;
  try {
    text = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error('pnpm-workspace.yaml is not readable');
    const rootJson = readPackageJson(root);
    if (rootJson !== undefined && 'workspaces' in rootJson) {
      throw new Error('the repository declares workspaces without a pnpm-workspace.yaml');
    }
    return null;
  }
  const patterns = [];
  let inList = false;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^packages:\s*(#.*)?$/.test(line)) {
      inList = true;
      found = true;
      continue;
    }
    if (/^\S/.test(line)) {
      if (/^packages:/.test(line))
        throw new Error('pnpm-workspace.yaml packages is not a block list');
      inList = false;
      continue;
    }
    if (!inList) continue;
    const item = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|([^\s#'"][^\s#]*))\s*(?:#.*)?$/.exec(line);
    if (item === null)
      throw new Error('pnpm-workspace.yaml has a packages entry that cannot be read');
    patterns.push(item[1] ?? item[2] ?? item[3]);
  }
  if (!found || patterns.length === 0) {
    throw new Error('pnpm-workspace.yaml has no packages list');
  }
  // Every pattern is checked now, so an unevaluable shape fails the whole
  // artifact once rather than surfacing from inside an entry's check.
  for (const pattern of patterns) parsePattern(pattern.replace(/^!/, ''));
  return patterns;
}

/** Splits a pattern into its literal prefix and a trailing wildcard kind; throws on any other shape. */
function parsePattern(pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  const last = segments[segments.length - 1];
  const wildcard = last === '*' || last === '**' ? last : undefined;
  const prefix = wildcard === undefined ? segments : segments.slice(0, -1);
  if (
    pattern === '' ||
    prefix.some((segment) => segment === '' || segment === '..' || GLOB_CHARS.test(segment))
  ) {
    throw new Error(`the workspace pattern ${JSON.stringify(pattern)} cannot be evaluated`);
  }
  return { prefix: prefix.filter((segment) => segment !== '.'), wildcard };
}

function matchesPattern({ pattern, segments }) {
  const { prefix, wildcard } = parsePattern(pattern);
  if (!prefix.every((segment, i) => segments[i] === segment)) return false;
  if (wildcard === undefined) return segments.length === prefix.length;
  return wildcard === '*' ? segments.length === prefix.length + 1 : segments.length > prefix.length;
}

/** True when `directory` (relative, normalised) is a workspace package of the checkout. */
function isWorkspaceDirectory({ patterns, directory }) {
  if (patterns === null) return directory === '.';
  const segments = directory === '.' ? [] : directory.split('/');
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    segments.includes('node_modules')
  ) {
    return false;
  }
  const included = patterns.filter((p) => !p.startsWith('!'));
  const excluded = patterns.filter((p) => p.startsWith('!')).map((p) => p.slice(1));
  return (
    included.some((pattern) => matchesPattern({ pattern, segments })) &&
    !excluded.some((pattern) => matchesPattern({ pattern, segments }))
  );
}

/** Reads `.changeset/config.json` as plain JSON: literal `ignore` names and whether private packages are tagged. */
function readTagPolicy(root) {
  let config;
  try {
    config = JSON.parse(readFileSync(resolve(root, '.changeset', 'config.json'), 'utf8'));
  } catch {
    throw new Error('.changeset/config.json is not readable JSON');
  }
  if (!isRecord(config)) throw new Error('.changeset/config.json is not an object');
  const ignore = Array.isArray(config.ignore) ? config.ignore : [];
  const priv = config.privatePackages;
  return {
    ignoredNames: new Set(
      ignore.filter((name) => typeof name === 'string' && !GLOB_CHARS.test(name))
    ),
    tagsPrivate: priv === true || (isRecord(priv) && priv.tag === true)
  };
}

function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateEntry({ entry, keys, root, sha, patterns, policy }) {
  const problems = [];
  if (!isRecord(entry) || Object.keys(entry).sort().join() !== keys.join()) {
    return ['has the wrong shape'];
  }
  if (!keys.every((key) => typeof entry[key] === 'string')) return ['has a non-string field'];
  const { directory, packageName, tag } = entry;
  if (packageName.length > 214 || !NPM_NAME.test(packageName)) {
    problems.push('has an invalid package name');
  }
  if ('commit' in entry && (entry.commit !== sha || !COMMIT.test(entry.commit))) {
    problems.push("has a commit that is not this run's commit");
  }
  const dir = insideWorkspace({ root, directory });
  if (dir === undefined) return [...problems, 'has a directory outside the workspace'];
  if (!isWorkspaceDirectory({ patterns, directory })) {
    return [...problems, 'has a directory that is not a workspace package'];
  }
  const pkg = readPackageJson(dir);
  if (pkg === undefined) return [...problems, 'has no readable package.json at its directory'];
  if (pkg.name !== packageName) problems.push('names a package that differs from package.json');
  if (policy.ignoredNames.has(packageName)) {
    problems.push('names a package that .changeset/config.json ignores');
  }
  if (pkg.private === true && !policy.tagsPrivate) {
    problems.push('names a private package that .changeset/config.json does not tag');
  }
  if (typeof pkg.version !== 'string' || !SEMVER.test(pkg.version)) {
    problems.push('has a package.json without a valid version');
  } else if (
    !(tag === `${pkg.name}@${pkg.version}` || (directory === '.' && tag === `v${pkg.version}`))
  ) {
    problems.push('has a tag that is not the package.json name and version');
  }
  return problems;
}

/**
 * Returns `{ tags, expected, errors }`. `errors` is empty when the artifact is
 * valid; `tags` and `expected` are then the parsed lists.
 */
export function validateArtifact({ text, workspace, sha }) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { errors: ['the tags file is not valid JSON'] };
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join() !== 'expected,tags' ||
    !Array.isArray(parsed.tags) ||
    !Array.isArray(parsed.expected) ||
    parsed.tags.length > MAX_ENTRIES ||
    parsed.expected.length > MAX_ENTRIES
  ) {
    return {
      errors: ['the tags file must be an object with exactly a "tags" and an "expected" list']
    };
  }
  let root;
  try {
    root = realpathSync(resolve(workspace));
  } catch {
    return { errors: ['the workspace is not readable'] };
  }
  let patterns;
  let policy;
  try {
    patterns = readWorkspacePatterns(root);
    policy = readTagPolicy(root);
  } catch (err) {
    return { errors: [err.message] };
  }
  const errors = [];
  for (const [listName, keys] of [
    ['tags', TAG_KEYS],
    ['expected', EXPECTED_KEYS]
  ]) {
    const seen = new Set();
    for (const [index, entry] of parsed[listName].entries()) {
      const problems = validateEntry({ entry, keys, root, sha, patterns, policy });
      const tag = isRecord(entry) && typeof entry.tag === 'string' ? entry.tag : undefined;
      if (tag !== undefined && seen.has(tag)) problems.push('repeats an earlier tag');
      if (tag !== undefined) seen.add(tag);
      const label = tag === undefined ? `entry ${index}` : JSON.stringify(tag);
      for (const problem of problems) errors.push(`${listName}[${index}] ${label} ${problem}`);
    }
  }
  const expectedTags = new Set(
    parsed.expected.flatMap((entry) =>
      isRecord(entry) && typeof entry.tag === 'string' ? [entry.tag] : []
    )
  );
  for (const [index, entry] of parsed.tags.entries()) {
    if (isRecord(entry) && typeof entry.tag === 'string' && !expectedTags.has(entry.tag)) {
      errors.push(`tags[${index}] ${JSON.stringify(entry.tag)} is not in the expected list`);
    }
  }
  return errors.length > 0 ? { errors } : { tags: parsed.tags, expected: parsed.expected, errors };
}

export function main({ env = process.env, log = console.log } = {}) {
  const { TAGS_FILE: tagsFile, GITHUB_WORKSPACE: workspace, GITHUB_SHA: sha } = env;
  for (const [key, value] of [
    ['TAGS_FILE', tagsFile],
    ['GITHUB_WORKSPACE', workspace],
    ['GITHUB_SHA', sha]
  ]) {
    if (!value) {
      log(`::error::${key} is not set`);
      return 1;
    }
  }
  let text;
  try {
    text = readFileSync(tagsFile, 'utf8');
  } catch (err) {
    log(`::error title=Invalid tags file::Could not read the tags file: ${err.message}`);
    return 1;
  }
  const { tags, expected, errors } = validateArtifact({ text, workspace, sha });
  if (errors.length > 0) {
    log(`::error title=Invalid tags file::${errors.join('; ')}`);
    return 1;
  }
  log(`Validated ${tags.length} tag(s) to create and ${expected.length} expected tag(s)`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
