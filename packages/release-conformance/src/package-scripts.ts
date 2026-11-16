import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { ScriptRef } from './shell-commands.ts';

const MAX_PACKAGE_JSON_BYTES = 1_000_000;
const MAX_WALK_DEPTH = 5;
const MAX_WALK_DIRECTORIES = 400;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git']);

export interface ScriptLookup {
  /** True when at least one package.json the checker read defines the script. */
  defined: boolean;
  /** Bodies of the script and of its `pre`/`post` hooks, from every package.json that defines it. */
  bodies: string[];
}

export interface ScriptReader {
  lookup: (ref: ScriptRef) => ScriptLookup;
}

/** A repository-relative directory, or undefined for one that escapes the repository or holds an expression. */
const relativeDirectory = (dir: string): string | undefined => {
  if (dir.includes('${{') || posix.isAbsolute(dir)) return undefined;
  const normal = posix.normalize(dir === '' ? '.' : dir);
  return normal === '..' || normal.startsWith('../') ? undefined : normal;
};

/**
 * Reads `scripts` from the package.json files of a repository tree, read-only:
 * a file that is a link, too large or not valid JSON counts as absent. A script
 * that no readable file defines is reported as not defined, never as harmless.
 */
export const createScriptReader = (root: string): ScriptReader => {
  const cache = new Map<string, Record<string, string> | undefined>();

  const readScripts = (dir: string): Record<string, string> | undefined => {
    if (cache.has(dir)) return cache.get(dir);
    let scripts: Record<string, string> | undefined;
    try {
      const path = join(root, dir, 'package.json');
      const info = lstatSync(path);
      if (info.isFile() && info.size <= MAX_PACKAGE_JSON_BYTES) {
        const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
        if (typeof doc === 'object' && doc !== null && 'scripts' in doc) {
          const raw = doc.scripts;
          if (typeof raw === 'object' && raw !== null) {
            scripts = {};
            for (const [name, body] of Object.entries(raw)) {
              if (typeof body === 'string') scripts[name] = body;
            }
          }
        } else if (typeof doc === 'object' && doc !== null) {
          scripts = {};
        }
      }
    } catch {
      scripts = undefined;
    }
    cache.set(dir, scripts);
    return scripts;
  };

  let packageDirs: string[] | undefined;
  const allPackageDirs = (): string[] => {
    if (packageDirs) return packageDirs;
    const found: string[] = [];
    let visited = 0;
    const walk = (dir: string, depth: number): void => {
      if (visited >= MAX_WALK_DIRECTORIES) return;
      visited += 1;
      if (readScripts(dir) !== undefined) found.push(dir);
      if (depth >= MAX_WALK_DEPTH) return;
      let entries;
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name))
          walk(posix.join(dir, entry.name), depth + 1);
      }
    };
    walk('.', 0);
    packageDirs = found;
    return found;
  };

  const lookup = (ref: ScriptRef): ScriptLookup => {
    const named = ref.dirs.map(relativeDirectory);
    const dirs = new Set<string>();
    if (ref.dirs.length === 0) dirs.add('.');
    for (const dir of named) if (dir !== undefined) dirs.add(dir);
    if (ref.wide) for (const dir of allPackageDirs()) dirs.add(dir);
    const bodies: string[] = [];
    let defined = false;
    for (const dir of dirs) {
      const scripts = readScripts(dir);
      if (scripts === undefined) continue;
      for (const key of [ref.name, `pre${ref.name}`, `post${ref.name}`]) {
        const body = scripts[key];
        if (body === undefined) continue;
        bodies.push(body);
        if (key === ref.name) defined = true;
      }
    }
    return { defined, bodies };
  };

  return { lookup };
};
