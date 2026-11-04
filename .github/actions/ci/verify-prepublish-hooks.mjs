#!/usr/bin/env node
/**
 * Fail the build if any publishable package that compiles does not rebuild on
 * publish via a `prepublishOnly` hook.
 *
 * Rule: for every package where `private !== true` (i.e. `changeset publish` /
 * `pnpm publish` / `npm publish` will push it to npm) AND that declares a
 * `build` script (i.e. it emits compiled output), `scripts.prepublishOnly`
 * must exist and run `pnpm run build` (not `build:clean`).
 *
 * Why this is a hard gate — and deliberately NOT a "build in CI before publish"
 * step: `prepublishOnly` is the only hook that runs on EVERY publish path (CI
 * `changeset publish`, a maintainer's local `pnpm publish`, `npm publish`).
 * Building in CI would make CI publishes correct while leaving local publishes
 * free to ship whatever stale `dist/` happens to be on disk — a new point or
 * major release that is silently a byte-for-byte copy of an old build, with no
 * error anywhere. That failure is worse than an empty publish because nothing
 * surfaces it. Requiring the hook protects every path; building in CI hides the
 * gap. (A missing hook shipped @polygonlabs/spol-api-client@1.0.0 to npm with no
 * dist/ — an empty, unimportable package.)
 *
 * Zero-dependency, Node built-ins only, so it runs from the composite action's
 * own directory with no ncc bundle.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const IGNORE_DIRS = new Set(['node_modules', 'dist', 'out-tsc', 'coverage']);
const root = process.cwd();

/** Recursively collect every package.json, skipping build output, deps, and dotdirs. */
function collectPackageJsons(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      collectPackageJsons(join(dir, entry.name), found);
    } else if (entry.name === 'package.json') {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

const failures = [];

for (const pkgPath of collectPackageJsons(root)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    continue; // not a JSON package manifest we can reason about
  }
  if (!pkg.name) continue;
  if (pkg.private === true) continue; // never published to npm
  const scripts = pkg.scripts ?? {};
  if (!scripts.build) continue; // nothing to compile → no build-on-publish needed

  const where = `${pkg.name} (${relative(root, pkgPath) || 'package.json'})`;
  const prepublish = scripts.prepublishOnly;

  if (!prepublish) {
    failures.push(
      `${where}: publishable and has a "build" script, but no "prepublishOnly". ` +
        `Add "prepublishOnly": "pnpm run build".`
    );
  } else if (/build:clean/.test(prepublish)) {
    failures.push(
      `${where}: "prepublishOnly" must run "pnpm run build", not build:clean ` +
        `(found ${JSON.stringify(prepublish)}). The rm in build:clean races with ` +
        `parallel prepublishOnly typechecks during changesets publish.`
    );
  } else if (!/\bpnpm(\s+run)?\s+build\b/.test(prepublish)) {
    failures.push(
      `${where}: "prepublishOnly" does not run the build (found ${JSON.stringify(prepublish)}). ` +
        `It must run "pnpm run build".`
    );
  }
}

if (failures.length > 0) {
  console.error('✖ prepublishOnly check failed — publishable packages must build on publish:\n');
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    '\nprepublishOnly is the only hook that runs on every publish path (CI and local).\n' +
      'Without it, a publish ships stale or empty dist/ silently. Add the hook — do not\n' +
      'work around it with a CI-side build, which only fixes CI and hides local publishes.'
  );
  process.exit(1);
}

console.log('✓ prepublishOnly check: every publishable package with a build rebuilds on publish.');
