// Validates the tags artifact written by collect-tags.mjs before any step that
// holds a token uses it. The artifact comes from a job that ran the
// repository's own dependency code, so it is treated as untrusted input.
//
// This script imports only node built-ins and never loads code from the
// repository: it reads package.json files as data. Every entry, in `tags` and
// in `expected`, must name a package that exists at the entry's directory in
// this checkout, and its tag must be exactly that package's `<name>@<version>`
// (or `v<version>` for the root package). Every `commit` must equal the
// commit this run is for. Any other shape fails closed with one error that
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

function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function validateEntry({ entry, keys, root, sha }) {
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
  const pkg = readPackageJson(dir);
  if (pkg === undefined) return [...problems, 'has no readable package.json at its directory'];
  if (pkg.name !== packageName) problems.push('names a package that differs from package.json');
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
  const errors = [];
  for (const [listName, keys] of [
    ['tags', TAG_KEYS],
    ['expected', EXPECTED_KEYS]
  ]) {
    const seen = new Set();
    for (const [index, entry] of parsed[listName].entries()) {
      const problems = validateEntry({ entry, keys, root, sha });
      const tag = isRecord(entry) && typeof entry.tag === 'string' ? entry.tag : undefined;
      if (tag !== undefined && seen.has(tag)) problems.push('repeats an earlier tag');
      if (tag !== undefined) seen.add(tag);
      const label = tag === undefined ? `entry ${index}` : JSON.stringify(tag);
      for (const problem of problems) errors.push(`${listName}[${index}] ${label} ${problem}`);
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
