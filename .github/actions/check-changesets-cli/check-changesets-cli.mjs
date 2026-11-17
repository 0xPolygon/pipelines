// Detects which @changesets/cli major the repository resolves (2 or 3) and, on
// 3.x, fails when private packages are in scope but `privatePackages` is not
// set explicitly in `.changeset/config.json`. The version comes from the
// installed binary (`pnpm exec changeset --version`), so it is the one the
// lockfile resolved and the one that will run in the release job.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkspacePatterns } from '../workspace-patterns/workspace-patterns.mjs';

export function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error ? String(result.error.message) : '')
  };
}

const SUPPORTED_MAJORS = ['2', '3'];

// Each failure kind has its own annotation title so the Actions UI says what
// is wrong; a bare Error from a dependency falls back to the unsupported title.
const TITLES = {
  unsupportedMajor: 'Unsupported @changesets/cli major',
  unreadableVersion: 'Unreadable @changesets/cli version',
  privatePackages: 'privatePackages not explicit',
  config: 'Unreadable or invalid changesets config',
  workspacePatterns: 'Unsupported workspace layout'
};

class CheckError extends Error {
  constructor(kind, message) {
    super(message);
    this.title = TITLES[kind];
  }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// Workspace member globs: the `packages:` list of pnpm-workspace.yaml (block or
// flow list), or `workspaces` in package.json. Undefined when none are
// declared. Same rule as the npm-pack action; copied because each job
// checks out single action directories only.
function workspaceGlobs(root) {
  const yamlPath = join(root, 'pnpm-workspace.yaml');
  if (existsSync(yamlPath)) {
    const text = readFileSync(yamlPath, 'utf8');
    if (/^packages\s*:/m.test(text)) {
      const globs = [];
      const flow = /^packages\s*:\s*\[([^\]]*)\]/m.exec(text);
      if (flow) globs.push(...flow[1].split(','));
      else {
        const block = /^packages\s*:[^\n]*\n((?:[ \t]+-[^\n]*\n?|[ \t]*(?:#[^\n]*)?\n)*)/m.exec(
          text
        );
        for (const line of (block?.[1] ?? '').split('\n')) {
          const item = /^\s*-\s*(.*?)\s*(?:#.*)?$/.exec(line);
          if (item) globs.push(item[1]);
        }
      }
      return globs.map((glob) => glob.trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  const workspaces = existsSync(join(root, 'package.json'))
    ? readJson(join(root, 'package.json')).workspaces
    : undefined;
  if (workspaces === undefined) return undefined;
  const list = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  return list.filter((glob) => typeof glob === 'string');
}

const namesRoot = (glob) => /^\.\/*$/.test(glob);

function listProjectsWithPnpm({ root, run }) {
  const result = run('pnpm', [
    'ls',
    '-r',
    '--depth',
    '-1',
    '--json',
    '--config.ignore-pnpmfile=true'
  ]);
  if (result.status !== 0) throw new Error('Could not list the workspace packages with pnpm.');
  return JSON.parse(result.stdout);
}

// Packages changesets would include. The root of a multi-package workspace is
// not one, unless a workspace glob names it.
function packagesInScope({ root, listProjects }) {
  const projects = listProjects();
  const rootDir = resolve(root);
  const globs = workspaceGlobs(rootDir);
  const rootIsMember = globs?.some(namesRoot) ?? false;
  const kept =
    !rootIsMember && (projects.length > 1 || (projects.length === 1 && globs !== undefined))
      ? projects.filter((project) => resolve(project.path) !== rootDir)
      : projects;
  return kept.map((project) => readJson(join(project.path, 'package.json')));
}

const isBoolean = (value) => typeof value === 'boolean';

// Explicit means present and either a boolean (changesets expands a boolean b
// to { version: b, tag: b }) or an object with boolean `version` and `tag`.
function privatePackagesIsExplicit(value) {
  if (isBoolean(value)) return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    isBoolean(value.version) &&
    isBoolean(value.tag)
  );
}

// The finalize job validates the tags it is given against this same
// evaluation, after the publish; running it here fails an unevaluable layout
// before any release PR is merged.
function checkWorkspaceLayout(root) {
  try {
    readWorkspacePatterns(resolve(root));
  } catch (err) {
    throw new CheckError(
      'workspacePatterns',
      `The workspace layout cannot be evaluated for @changesets/cli 3.x tagging: ${err.message}. ` +
        'List the packages in "pnpm-workspace.yaml" as a block or one-line list of directory paths, ' +
        'optionally ending in "*" or "**", with "!" for exclusions, or remove the "packages" key for a single root package.'
    );
  }
}

function checkPrivatePackagesConfig({ root, listProjects, run }) {
  let config;
  let packages;
  try {
    config = readJson(join(root, '.changeset', 'config.json'));
    packages = packagesInScope({
      root,
      listProjects: listProjects ?? (() => listProjectsWithPnpm({ root, run }))
    });
  } catch (err) {
    throw new CheckError(
      'config',
      `Could not read .changeset/config.json or the workspace package list (${err.message}). ` +
        'Both are needed to check the "privatePackages" setting.'
    );
  }
  const hasPrivate = packages.some((pkg) => pkg.private === true);
  if (hasPrivate && !privatePackagesIsExplicit(config.privatePackages)) {
    throw new CheckError(
      'privatePackages',
      'This repository has private packages and @changesets/cli 3.x, but "privatePackages" in ' +
        '".changeset/config.json" is missing or malformed. Without it, private packages get no ' +
        'version, tag or GitHub Release on 3.x. Set it to true, false, or an object with ' +
        'boolean "version" and "tag", for example "privatePackages": { "version": true, "tag": true }.'
    );
  }
}

/**
 * Returns `{ version, major }` for a supported @changesets/cli (major 2 or 3),
 * or throws a public, actionable error. On major 3 it also checks the
 * `privatePackages` setting.
 */
export function checkChangesetsCli({ run = defaultRun, root = '.', listProjects } = {}) {
  // pnpm options go before `exec`; anything after `changeset` is passed to the CLI.
  const result = run('pnpm', ['--config.ignore-pnpmfile=true', 'exec', 'changeset', '--version']);
  const version = result.stdout.trim().split('\n').pop()?.trim() ?? '';
  const match = /^(\d+)\.\d+\.\d+/.exec(version);
  if (result.status !== 0 || !match) {
    throw new CheckError(
      'unreadableVersion',
      'Could not determine the version of @changesets/cli. Add @changesets/cli (major 2 or 3) ' +
        "to the repository's devDependencies and install it from the lockfile."
    );
  }
  const major = match[1];
  if (!SUPPORTED_MAJORS.includes(major)) {
    throw new CheckError(
      'unsupportedMajor',
      `This workflow supports @changesets/cli majors 2 and 3; the repository resolves ${version}. ` +
        "Install a supported @changesets/cli from the repository's lockfile."
    );
  }
  if (major === '3') {
    checkWorkspaceLayout(root);
    checkPrivatePackagesConfig({ root, listProjects, run });
  }
  return { version, major: Number(major) };
}

export function main({
  run = defaultRun,
  log = console.log,
  root = '.',
  listProjects,
  env = process.env
} = {}) {
  try {
    const { version, major } = checkChangesetsCli({ run, root, listProjects });
    log(`@changesets/cli ${version}`);
    if (env.GITHUB_OUTPUT) {
      appendFileSync(env.GITHUB_OUTPUT, `version=${version}\nmajor=${major}\n`);
    }
    return 0;
  } catch (err) {
    log(`::error title=${err.title ?? TITLES.unsupportedMajor}::${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
