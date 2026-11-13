// Packs every public workspace package whose current version is not on the
// npm registry, and writes a manifest describing the tarballs.
//
// The selection, dist-tag and access rules mirror what `changeset publish`
// decides, so packing and publishing from tarballs picks the same packages
// with the same tag and access as publishing from source would. Sources are
// in @changesets/cli 2.30.0, `dist/changesets-cli.cjs.js`, cited below as
// `cli:<line>`.
//
// The pure functions are exported for tests; registry lookups and command
// execution are injected so tests never touch the network or run pnpm.
// Inputs reach the CLI only through environment variables set by action.yml.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

const readJsonIfExists = (path) => (existsSync(path) ? readJson(path) : undefined);

// Workspace member globs the repository declares: the `packages:` list of
// pnpm-workspace.yaml (block or flow list), or `workspaces` in package.json
// (array, or `{ packages }`). Returns undefined when none are declared. Such a
// repository publishes its members only, never its root, even when no member
// matches, unless a glob names the root itself (see below).
export function workspaceGlobs(root) {
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
  const workspaces = readJsonIfExists(join(root, 'package.json'))?.workspaces;
  if (workspaces === undefined) return undefined;
  const list = Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
  return list.filter((glob) => typeof glob === 'string');
}

// @manypkg/get-packages 1.1.3 expands the member globs with globby, so a glob
// that matches the root directory (`.` or `./`) makes the root a member, and
// changesets then publishes it (verified by running that globby call with
// `['.']` against a directory holding a package.json: it returns `['.']`).
const namesRoot = (glob) => /^\.\/*$/.test(glob);

// Lists workspace projects with pnpm, which reads pnpm-workspace.yaml itself,
// needs no install and makes no assumption about the layout. pnpm lists the
// workspace root among the projects. As in changesets, the root of a
// multi-package workspace is never a publish candidate, and a workspace whose
// globs match no member publishes nothing: only the member
// packages are (@manypkg/get-packages 1.1.3, `dist/get-packages.cjs.dev.js`
// lines 237-241 return the root separately from `packages`), while a
// repository with a single package publishes that package (same file, lines
// 179-181). A kept public package without a name or version fails with its
// directory; private packages are never published and never fail.
export async function discoverPackages({ root, listProjects = listProjectsWithPnpm }) {
  const projects = await listProjects(root);
  const rootDir = resolve(root);
  const globs = workspaceGlobs(rootDir);
  const rootIsMember = globs?.some(namesRoot) ?? false;
  const kept =
    !rootIsMember && (projects.length > 1 || (projects.length === 1 && globs !== undefined))
      ? projects.filter((project) => resolve(project.path) !== rootDir)
      : projects;
  return kept.map((project) => {
    const packageJson = readJson(join(project.path, 'package.json'));
    if (!packageJson.private && (!packageJson.name || !packageJson.version)) {
      throw new Error(
        `The package in ${project.path} has no "name" or no "version" in package.json`
      );
    }
    return { name: packageJson.name, version: packageJson.version, dir: project.path, packageJson };
  });
}

async function listProjectsWithPnpm(root) {
  const { stdout } = await execFileAsync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

// Reads `.changeset/pre.json`. Its presence puts the repository in
// pre-release mode (cli:917 treats any existing pre state that way).
export function readPreState(root) {
  return readJsonIfExists(join(root, '.changeset', 'pre.json'));
}

// The `access` option from `.changeset/config.json`. When the option is
// unset, changesets defaults it to "restricted".
export function readConfigAccess(root) {
  return readJsonIfExists(join(root, '.changeset', 'config.json'))?.access;
}

// Access for a package: its own `publishConfig.access`, else the changesets
// config `access`, else the changesets default of "restricted" (cli:981).
export function resolveAccess({ packageJson, configAccess }) {
  return packageJson.publishConfig?.access || configAccess || 'restricted';
}

// First prerelease identifier of a semver version, e.g. "beta" for
// "1.0.0-beta.2"; undefined for a release version.
function firstPrereleaseIdentifier(version) {
  const withoutBuild = version.split('+')[0];
  const dash = withoutBuild.indexOf('-');
  return dash === -1 ? undefined : withoutBuild.slice(dash + 1).split('.')[0];
}

// Whether every published version is a prerelease of the pre-mode tag. Such a
// package has never had a regular release (cli:995-1001).
export function isOnlyPrereleases({ versions, preTag }) {
  return versions.length > 0 && versions.every((v) => firstPrereleaseIdentifier(v) === preTag);
}

// The dist-tag a package publishes under (cli:915-921). An explicit override
// wins; in pre-release mode the pre tag is used unless the package has only
// ever published prereleases of that tag, which goes to `latest`; otherwise
// `latest`.
export function resolveDistTag({ preState, publishedState, override }) {
  if (override) return override;
  if (preState !== undefined && publishedState !== 'only-pre') return preState.tag;
  return 'latest';
}

// Public packages whose local version is absent from the registry's version
// list (cli:990-1031). `lookupVersions(name)` resolves to the list of
// published versions, or `null` when the package has never been published
// (a 404). Any other lookup failure must make it reject, which fails the run.
export async function selectUnpublished({ packages, lookupVersions, preState, override }) {
  const publicPackages = packages.filter((pkg) => !pkg.packageJson.private);
  const looked = await Promise.all(
    publicPackages.map(async (pkg) => ({ pkg, versions: await lookupVersions(pkg.name) }))
  );
  const selected = [];
  for (const { pkg, versions } of looked) {
    const published = versions ?? [];
    if (published.includes(pkg.version)) continue;
    let publishedState = 'never';
    if (versions !== null) {
      publishedState =
        preState !== undefined && isOnlyPrereleases({ versions, preTag: preState.tag })
          ? 'only-pre'
          : 'published';
    }
    selected.push({ ...pkg, tag: resolveDistTag({ preState, publishedState, override }) });
  }
  return selected;
}

// Fails when a selected package would publish with restricted access. This
// workflow publishes public packages only, so a package that resolves to
// "restricted" is reported rather than silently packed.
export function assertPublicAccess({ selected, configAccess }) {
  const restricted = selected
    .filter((pkg) => resolveAccess({ packageJson: pkg.packageJson, configAccess }) !== 'public')
    .map((pkg) => pkg.name);
  if (restricted.length > 0) {
    throw new Error(
      `Packages resolve to "restricted" access: ${restricted.join(', ')}. ` +
        'Set "publishConfig": { "access": "public" } in each package.json, ' +
        'or set "access": "public" in .changeset/config.json.'
    );
  }
}

export const NPM_REGISTRY = 'https://registry.npmjs.org/';

const normaliseRegistry = (url) => String(url).trim().replace(/\/+$/, '').toLowerCase();

/**
 * The `publishConfig` keys that point somewhere other than the public npm
 * registry: `registry`, and any scoped `<scope>:registry` (npm copies those
 * into its options and prefers the scope's registry over `--registry`).
 */
export function foreignRegistryKeys(publishConfig) {
  if (publishConfig === null || typeof publishConfig !== 'object') return [];
  return Object.entries(publishConfig)
    .filter(
      ([key, value]) =>
        (key === 'registry' || key.endsWith(':registry')) &&
        normaliseRegistry(value) !== normaliseRegistry(NPM_REGISTRY)
    )
    .map(([key]) => key);
}

// `npm publish <tarball>` applies the tarball's own `publishConfig` registry
// settings unless a CLI flag overrides them, and this workflow publishes to
// npmjs.org only. A package that names another registry fails here, in the job
// that holds no credential, rather than publishing somewhere unexpected. The
// publish job repeats the check on the tarball's own package.json.
export function assertNpmRegistry({ selected }) {
  const foreign = selected
    .map((pkg) => ({ name: pkg.name, keys: foreignRegistryKeys(pkg.packageJson.publishConfig) }))
    .filter(({ keys }) => keys.length > 0)
    .map(({ name, keys }) => `${name} (${keys.join(', ')})`);
  if (foreign.length > 0) {
    throw new Error(
      `Packages set a publishConfig registry other than ${NPM_REGISTRY}: ` +
        `${foreign.join('; ')}. This workflow publishes to the public npm registry only; ` +
        'remove publishConfig.registry and any publishConfig "<scope>:registry" from each package.json.'
    );
  }
}

// One manifest entry per tarball.
// `directory` is the package directory relative to the repository root; the
// finalize job reads it to find the package's CHANGELOG.md.
export function buildManifestEntry({ pkg, file, sha256, access, directory }) {
  return { name: pkg.name, version: pkg.version, file, sha256, access, tag: pkg.tag, directory };
}

// Registry lookup through `npm info`, the same call changesets makes
// (cli:774): a JSON `E404` error, or empty output from registries that answer
// a missing package that way, means never published. A failed command with no
// parseable output, or any other error code, is a lookup failure.
export async function lookupVersionsWithNpm(name) {
  let stdout;
  let failure;
  try {
    ({ stdout } = await execFileAsync('npm', ['info', name, '--json', '--registry', NPM_REGISTRY], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }));
  } catch (error) {
    stdout = error.stdout ?? '';
    failure = error;
  }
  if (stdout.trim() === '') {
    if (failure) throw new Error(`npm info ${name} failed: ${failure.message}`);
    return null;
  }
  const info = JSON.parse(stdout);
  if (info.error) {
    if (info.error.code === 'E404') return null;
    throw new Error(`npm info ${name} failed with ${info.error.code}: ${info.error.summary ?? ''}`);
  }
  const versions = info.versions ?? [];
  return Array.isArray(versions) ? versions : [versions];
}

async function runCommand({ command, args, cwd }) {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  return stdout;
}

// Paths inside a tarball, listed with the system `tar`.
async function listTarballEntries(path) {
  const { stdout } = await execFileAsync('tar', ['-tzf', path], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024
  });
  return stdout.split('\n').filter(Boolean);
}

// A packed tarball must hold the package only. A `.pipelines` directory
// inside a package comes from a checkout of this workflow's repository left in
// the workspace, and an npm version cannot be replaced once published.
export function assertNoCheckoutContent({ entries, packageName, file }) {
  const stray = entries.filter((entry) => /^(\.\/)?package\/\.pipelines(\/|$)/.test(entry));
  if (stray.length > 0) {
    throw new Error(
      `${file} (${packageName}) contains ${stray.length} file(s) under package/.pipelines/, ` +
        'a checkout of the workflow repository. Nothing may be added to the workspace before packing.'
    );
  }
}

const sha256OfFile = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

// Packs each selected package into `outDir` and returns the manifest.
// `prepublishOnly` runs first because `pnpm pack` does not run it.
export async function packSelected({
  selected,
  outDir,
  configAccess,
  root = process.cwd(),
  run = runCommand,
  listEntries = listTarballEntries
}) {
  const manifest = [];
  const files = new Set();
  for (const pkg of selected) {
    await run({ command: 'pnpm', args: ['run', '--if-present', 'prepublishOnly'], cwd: pkg.dir });
    const stdout = await run({
      command: 'pnpm',
      args: ['pack', '--pack-destination', outDir],
      cwd: pkg.dir
    });
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const file = basename(lines[lines.length - 1] ?? '');
    const filePath = join(outDir, file);
    if (!file.endsWith('.tgz') || !existsSync(filePath)) {
      throw new Error(`pnpm pack for ${pkg.name} did not produce a tarball in ${outDir}`);
    }
    // Two packages can share a file name (`@a/b` and `a-b` at one version);
    // the second `pnpm pack` would have overwritten the first tarball.
    if (files.has(file)) {
      throw new Error(`Two selected packages produce the same tarball name ${file}`);
    }
    files.add(file);
    assertNoCheckoutContent({
      entries: await listEntries(filePath),
      packageName: pkg.name,
      file
    });
    manifest.push(
      buildManifestEntry({
        pkg,
        file,
        sha256: sha256OfFile(filePath),
        access: resolveAccess({ packageJson: pkg.packageJson, configAccess }),
        directory: relative(resolve(root), resolve(pkg.dir)) || '.'
      })
    );
  }
  return manifest;
}

export async function main({
  env = process.env,
  root = process.cwd(),
  lookupVersions = lookupVersionsWithNpm,
  listProjects,
  run,
  listEntries
} = {}) {
  const outDirInput = env.PACK_OUT_DIR;
  if (!outDirInput) throw new Error('PACK_OUT_DIR is required');
  const outDir = resolve(outDirInput);
  const override = env.PACK_DIST_TAG || undefined;

  const packages = await discoverPackages({ root, listProjects });
  const preState = readPreState(root);
  const configAccess = readConfigAccess(root);

  const selected = await selectUnpublished({ packages, lookupVersions, preState, override });
  assertPublicAccess({ selected, configAccess });
  assertNpmRegistry({ selected });

  mkdirSync(outDir, { recursive: true });
  const manifest = await packSelected({ selected, outDir, configAccess, root, run, listEntries });
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  for (const entry of manifest) {
    console.log(`Packed ${entry.name}@${entry.version} -> ${entry.file} (tag ${entry.tag})`);
  }
  if (manifest.length === 0) console.log('No unpublished public packages; nothing to pack.');

  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      `has_tarballs=${manifest.length > 0 ? 'true' : 'false'}\ncount=${manifest.length}\n`
    );
  }
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.log(`::error title=Pack failed::${String(error.message).replaceAll('\n', ' ')}`);
    process.exit(1);
  });
}
