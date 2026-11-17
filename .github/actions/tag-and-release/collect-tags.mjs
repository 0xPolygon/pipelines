// Part A of the 3.x finalize tagging: creates the local git tags for every
// package that needs one and writes the list of tags it created, for the step
// that publishes them (tag-and-release.cjs).
//
// This script runs with no token in its environment and never reads one: the
// CLI it starts loads the repository's dependency code. It only runs
// `changeset git-tag`, which creates annotated tags in the local clone and
// never pushes. The tag list comes from the CLI's own output file, and is
// cross-checked against the tags that appeared in the clone, so a CLI that
// reports one thing and does another fails the step.

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 * Runs `changeset git-tag` and returns `{ tags: [{ tag, packageName, directory }] }`
 * for the tags it created. `ndjsonPath` must be a path the CLI may create; it
 * is created empty first because the CLI appends and never truncates.
 */
export function collectTags({ run = defaultRun, ndjsonPath, root = '.' }) {
  writeFileSync(ndjsonPath, '');
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
      return { ...entry, directory };
    })
  };
}

export function main({ env = process.env, run = defaultRun, log = console.log } = {}) {
  const tagsFile = env.TAGS_FILE;
  if (!tagsFile) {
    log('::error::TAGS_FILE is not set');
    return 1;
  }
  try {
    mkdirSync(dirname(tagsFile), { recursive: true });
    const result = collectTags({ run, ndjsonPath: `${tagsFile}.ndjson` });
    writeFileSync(tagsFile, JSON.stringify(result));
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
  process.exit(main());
}
