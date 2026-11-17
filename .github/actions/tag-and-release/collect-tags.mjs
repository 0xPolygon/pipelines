// Part A of the 3.x tagging: creates the local git tags for every package that
// needs one and writes the list of tags it created, for the step that pushes
// them (tag-and-release.cjs). Each tag entry carries the commit it was created
// at. It also writes `expected`: the tags the CLI should leave for the
// repository's current package versions, derived from the repository's config
// without asking `git-tag`, so the end state check can tell "tagged nothing"
// from "nothing to tag".
//
// The artifact is `{ tags: [{ tag, packageName, directory, commit }],
// expected: [{ tag, packageName, directory }] }`. The job that runs this holds
// no token, and the job that consumes the artifact validates it with plain node
// (validate-tags.mjs) before using it.
//
// This script runs with no token in its environment and never reads one: the
// CLI it starts loads the repository's dependency code. It only runs
// `changeset git-tag`, which creates annotated tags in the local clone and
// never pushes. The tag list comes from the CLI's own output file, and is
// cross-checked against the tags that appeared in the clone, so a CLI that
// reports one thing and does another fails the step.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function defaultRun(command, args, { env } = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env }
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : '')
  };
}

function tagsAtHead(run) {
  const result = run('git', ['tag', '--points-at', 'HEAD']);
  if (result.status !== 0) throw new Error('Could not list the tags at HEAD.');
  return new Set(result.stdout.split('\n').filter((line) => line !== ''));
}

// Only `type: "git-tag"` lines count; each carries `tag` and `packageName`.
function parseNdjson(text) {
  const entries = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Line ${index + 1} of the changeset output is not valid JSON.`);
    }
    if (parsed?.type !== 'git-tag') continue;
    if (typeof parsed.tag !== 'string' || typeof parsed.packageName !== 'string') {
      throw new Error(`Line ${index + 1} of the changeset output has no tag or packageName.`);
    }
    entries.push({ tag: parsed.tag, packageName: parsed.packageName });
  }
  return entries;
}

const parseMajor = (output) => {
  const match = /^(\d+)\.\d+\.\d+/.exec(String(output).trim().split('\n').pop()?.trim() ?? '');
  return match ? Number(match[1]) : undefined;
};

// Reads the repository's changesets config through its own installed
// `@changesets/cli`: the config package, and the workspace reader, that CLI
// depends on are resolved from the CLI's own package. `ignore` therefore comes
// back expanded exactly as that CLI expands it (globs and `!` negation
// included), with no matcher of this script's own. Only a step that holds no
// credential runs this. Any failure throws, so a config that cannot be
// read never packs more than the CLI would tag.
//
// Mirrored from npm-pack/pack-packages.mjs: each job checks out single action
// directories, so a shared module is not reachable.
export async function loadChangesetsContext({
  root,
  importModule = (file) => import(pathToFileURL(file).href)
}) {
  const workspace = resolve(root);
  let cliPackagePath;
  try {
    cliPackagePath = createRequire(join(workspace, 'package.json')).resolve(
      '@changesets/cli/package.json'
    );
  } catch (cause) {
    throw new Error('Could not resolve the installed @changesets/cli from the repository.', {
      cause
    });
  }
  const cliRequire = createRequire(cliPackagePath);
  const cliMajor = parseMajor(readJson(cliPackagePath).version);
  let configModule;
  let manypkg;
  try {
    configModule = await importModule(cliRequire.resolve('@changesets/config'));
    manypkg = await importModule(cliRequire.resolve('@manypkg/get-packages'));
  } catch (cause) {
    throw new Error('Could not load the changesets config reader of the installed CLI.', {
      cause
    });
  }
  // `readConfig` in @changesets/config 4 returns { config, warnings, errors };
  // `read` in earlier majors returns the config itself.
  const readConfig = configModule.readConfig ?? configModule.read;
  if (typeof readConfig !== 'function' || typeof manypkg.getPackages !== 'function') {
    throw new Error('The installed @changesets/cli does not expose the expected config reader.');
  }
  const packages = await manypkg.getPackages(workspace);
  const result = await readConfig(packages.rootDir, packages);
  const wrapped =
    result !== null && typeof result === 'object' && ('config' in result || 'errors' in result);
  if (wrapped && Array.isArray(result.errors) && result.errors.length > 0) {
    throw new Error(`.changeset/config.json is invalid: ${result.errors.join('; ')}`);
  }
  const config = wrapped ? result.config : result;
  if (
    !Array.isArray(config?.ignore) ||
    !config.ignore.every((name) => typeof name === 'string') ||
    typeof config.privatePackages?.tag !== 'boolean'
  ) {
    throw new Error('The changesets config reader returned an unexpected shape.');
  }
  return { cliMajor, config, packages };
}

// Package directories (relative to `root`) by name, from the workspace list.
function packageDirectories({ run, root }) {
  const result = run('pnpm', ['ls', '-r', '--depth', '-1', '--json']);
  if (result.status !== 0) throw new Error('Could not list the workspace packages with pnpm.');
  const directories = new Map();
  for (const project of JSON.parse(result.stdout)) {
    if (typeof project?.name === 'string' && typeof project?.path === 'string') {
      directories.set(project.name, relative(resolve(root), resolve(project.path)) || '.');
    }
  }
  return directories;
}

/**
 * Runs `changeset git-tag` and returns `{ tags: [{ tag, packageName, directory, commit }] }`
 * for the tags it created, at the commit HEAD points to. `ndjsonPath` must be a path the CLI may create; it
 * is created empty first because the CLI appends and never truncates.
 */
export function collectTags({ run = defaultRun, ndjsonPath, root = '.' }) {
  writeFileSync(ndjsonPath, '');
  const head = run('git', ['rev-parse', 'HEAD']);
  const commit = head.stdout.trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Could not resolve HEAD.');
  }
  const before = tagsAtHead(run);
  const result = run('pnpm', ['exec', 'changeset', 'git-tag'], {
    env: { CHANGESETS_OUTPUT: ndjsonPath, GIT_TERMINAL_PROMPT: '0' }
  });
  if (result.status !== 0) {
    throw new Error(`"changeset git-tag" exited with status ${result.status}.`);
  }
  const entries = parseNdjson(readFileSync(ndjsonPath, 'utf8'));
  const after = tagsAtHead(run);

  const reported = new Set(entries.map((entry) => entry.tag));
  const created = new Set([...after].filter((tag) => !before.has(tag)));
  const onlyReported = [...reported].filter((tag) => !created.has(tag));
  const onlyCreated = [...created].filter((tag) => !reported.has(tag));
  if (onlyReported.length > 0 || onlyCreated.length > 0) {
    throw new Error(
      'The tags "changeset git-tag" reported differ from the tags created at HEAD. ' +
        `Reported only: [${onlyReported.join(', ')}]. Created only: [${onlyCreated.join(', ')}].`
    );
  }
  if (entries.length === 0) return { tags: [] };

  const directories = packageDirectories({ run, root });
  return {
    tags: entries.map((entry) => {
      const directory = directories.get(entry.packageName);
      if (directory === undefined) {
        throw new Error(`Package ${entry.packageName} (tag ${entry.tag}) is not in the workspace.`);
      }
      return { ...entry, directory, commit };
    })
  };
}

/**
 * The tags `changeset git-tag` leaves for the current package versions: every
 * workspace package that is not under `ignore`, has a version, and is public
 * (private only when `privatePackages.tag` is true), named `<name>@<version>`,
 * or `v<version>` for the root package of a single-package repository. It is
 * the selection `git-tag` makes in @changesets/cli 3.x (its `shouldSkipPackage`
 * filter and tag naming), read from the same config the CLI reads.
 */
export function expectedTagsFor({ packages, config, root = '.' }) {
  const single = packages.tool?.type === 'root';
  return packages.packages
    .filter((pkg) => {
      const { name, version, private: isPrivate } = pkg.packageJson;
      if (config.ignore.includes(name)) return false;
      if (isPrivate && !config.privatePackages.tag) return false;
      return Boolean(version);
    })
    .map((pkg) => {
      const { name, version } = pkg.packageJson;
      return {
        tag: single ? `v${version}` : `${name}@${version}`,
        packageName: name,
        directory: relative(resolve(root), resolve(pkg.dir)) || '.'
      };
    });
}

/** Loads the repository's CLI and returns its expected tags. 3.x only; any mismatch throws. */
export async function expectedTags({
  run = defaultRun,
  root = '.',
  loadContext = loadChangesetsContext
}) {
  const major = parseMajor(run('pnpm', ['exec', 'changeset', '--version']).stdout);
  if (major !== 3) {
    throw new Error(
      `Expected @changesets/cli major 3 to derive the tags; found ${major ?? 'none'}.`
    );
  }
  const context = await loadContext({ root });
  if (context.cliMajor !== major) {
    throw new Error(
      `@changesets/cli reports major ${major} but the installed package is major ${context.cliMajor}.`
    );
  }
  return expectedTagsFor({ packages: context.packages, config: context.config, root });
}

export async function main({
  env = process.env,
  run = defaultRun,
  log = console.log,
  loadContext
} = {}) {
  const tagsFile = env.TAGS_FILE;
  if (!tagsFile) {
    log('::error::TAGS_FILE is not set');
    return 1;
  }
  try {
    mkdirSync(dirname(tagsFile), { recursive: true });
    const result = collectTags({ run, ndjsonPath: `${tagsFile}.ndjson` });
    const expected = await expectedTags({ run, loadContext });
    writeFileSync(tagsFile, JSON.stringify({ ...result, expected }));
    log(
      result.tags.length === 0
        ? 'Nothing to tag'
        : `Created local tags: ${result.tags.map((t) => t.tag).join(', ')}`
    );
    return 0;
  } catch (err) {
    log(`::error title=Tagging failed::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
