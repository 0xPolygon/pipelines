// Fails when a workspace package depends on a sibling workspace package
// through a plain semver range instead of the `workspace:` protocol.
//
// Why this shape is a defect: `changeset version` never rewrites
// `workspace:` ranges, and pnpm turns them into the sibling's real version
// only when it packs the package for publish. A sibling declared as
// `^1.2.0` instead is resolved against the registry (pnpm's default
// `link-workspace-packages=false`), so it installs whatever is published
// rather than the source in this repo, and the release job's frozen
// install fails once `changeset version` bumps the range past the
// lockfile. Catching it on the PR keeps that failure out of a release.
//
// peerDependencies are exempt: a semver peer range is how a published
// library states which sibling versions it supports, and changesets
// (with `bumpVersionsWithWorkspaceProtocolOnly: false`) keeps those ranges
// current. pnpm does not record a package's own peers in the lockfile, so
// bumping them cannot stale it.
//
// Uses `pnpm ls -r --depth -1 --json` to enumerate workspace projects: it
// reads pnpm-workspace.yaml directly, needs no install, and makes no
// assumption about the workspace layout. A repo that is not a workspace
// lists only its root, so it has no siblings and passes.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const CHECKED_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

const projects = JSON.parse(
  execFileSync('pnpm', ['ls', '-r', '--depth', '-1', '--json'], { encoding: 'utf8' })
);

const siblingNames = new Set(projects.map((p) => p.name).filter(Boolean));
const root = process.cwd();
const violations = [];

for (const project of projects) {
  const manifestPath = join(project.path, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const field of CHECKED_FIELDS) {
    for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
      if (siblingNames.has(dep) && !String(range).startsWith('workspace:')) {
        violations.push({
          file: relative(root, manifestPath) || 'package.json',
          field,
          dep,
          range
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(
    `All intra-workspace dependencies use the workspace: protocol (${projects.length} projects checked).`
  );
  process.exit(0);
}

for (const v of violations) {
  console.log(
    `::error file=${v.file},title=Non-workspace internal dependency::${v.field}.${v.dep} is "${v.range}" but ${v.dep} is a package in this workspace. Use "workspace:*" (or "workspace:^"); pnpm replaces it with the real version at publish.`
  );
}
console.log(
  `\n${violations.length} intra-workspace dependenc${violations.length === 1 ? 'y uses' : 'ies use'} a plain version range. ` +
    'Change each to "workspace:*", then run `pnpm install` and commit the updated pnpm-lock.yaml.'
);
process.exit(1);
