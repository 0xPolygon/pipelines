// Evaluates a repository's workspace layout as plain data, with node built-ins
// only, so both the version job's detector (before anything is published) and
// the finalize job's tags validator (after) apply the same rule. A layout this
// module cannot evaluate throws, and each caller fails closed with that
// message, so a repository with such a layout learns about it before a release
// PR is merged rather than after a publish.
//
// Layout rules:
//   - no pnpm-workspace.yaml: the root is the only package (a package.json
//     `workspaces` field without a pnpm-workspace.yaml cannot be evaluated);
//   - a pnpm-workspace.yaml with no `packages:` key (settings only): the root
//     is the only package;
//   - `packages:` as a block list or a one-line flow list; a `!pattern` entry
//     excludes what it matches;
//   - a pattern is path segments, each a literal or containing `*` (matches
//     within that one segment, e.g. `pos-*`, `packages/app-*`, `a/*/b`),
//     optionally ending in `**` (the directory itself and any depth below, as pnpm does); any other glob shape throws.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const unquote = (item) => {
  const trimmed = item.trim();
  const quoted = /^(?:'([^']*)'|"([^"]*)")$/.exec(trimmed);
  return quoted === null ? trimmed : (quoted[1] ?? quoted[2]);
};

// Characters that make a pattern something other than a literal path segment.
export const GLOB_CHARS = /[*?[\]{}()!]/;

// Characters that make a segment something other than a literal or a `*` glob.
const OTHER_GLOB_CHARS = /[?[\]{}()!]/;

/**
 * Splits a pattern into segments: a literal, a `*` glob (a `*` never crosses a
 * `/`, so it stays inside its own segment), or a trailing `**` (any depth
 * below). Throws on any other shape.
 */
export function parsePattern(pattern) {
  const segments = pattern.replace(/^\.\//, '').replace(/\/+$/, '').split('/');
  const deep = segments[segments.length - 1] === '**';
  const body = (deep ? segments.slice(0, -1) : segments).filter((segment) => segment !== '.');
  if (
    pattern === '' ||
    segments.some((segment) => segment === '' || segment === '..') ||
    body.some((segment) => segment.includes('**') || OTHER_GLOB_CHARS.test(segment))
  ) {
    throw new Error(`the workspace pattern ${JSON.stringify(pattern)} cannot be evaluated`);
  }
  // Like pnpm's glob, a wildcard never matches a segment that starts with a dot.
  const matchers = body.map((segment) => {
    if (!segment.includes('*')) return segment;
    const source = segment
      .split('*')
      .map((part) => part.replace(/[.+^$|\\]/g, '\\$&'))
      .join('[^/]*');
    return new RegExp(`^${segment.startsWith('.') ? '' : '(?!\\.)'}${source}$`);
  });
  return { matchers, deep };
}

/**
 * Returns the workspace patterns of the checkout, or `null` when the root is
 * the only package. Throws when the layout cannot be evaluated.
 */
export function readWorkspacePatterns(root) {
  let text;
  try {
    text = readFileSync(resolve(root, 'pnpm-workspace.yaml'), 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw new Error('pnpm-workspace.yaml is not readable');
    let rootJson;
    try {
      rootJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    } catch {
      rootJson = undefined;
    }
    if (rootJson !== null && typeof rootJson === 'object' && 'workspaces' in rootJson) {
      throw new Error('the repository declares workspaces without a pnpm-workspace.yaml');
    }
    return null;
  }
  const patterns = [];
  let inList = false;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) {
      inList = false;
      if (!/^packages\s*:/.test(line)) continue;
      if (found) throw new Error('pnpm-workspace.yaml has more than one packages key');
      found = true;
      if (/^packages\s*:\s*(#.*)?$/.test(line)) {
        inList = true;
        continue;
      }
      const flow = /^packages\s*:\s*\[([^\]]*)\]\s*(#.*)?$/.exec(line);
      if (flow === null)
        throw new Error('pnpm-workspace.yaml packages is not a block or flow list');
      for (const item of flow[1].split(',')) {
        if (item.trim() === '') continue;
        const value = unquote(item);
        if (/['"\s]/.test(value))
          throw new Error('pnpm-workspace.yaml has a packages entry that cannot be read');
        patterns.push(value);
      }
      continue;
    }
    if (!inList) continue;
    const item = /^\s+-\s+(?:'([^']*)'|"([^"]*)"|([^\s#'"][^\s#]*))\s*(?:#.*)?$/.exec(line);
    if (item === null)
      throw new Error('pnpm-workspace.yaml has a packages entry that cannot be read');
    patterns.push(item[1] ?? item[2] ?? item[3]);
  }
  // A settings-only file (no `packages:` key) leaves the root as the only package.
  if (!found) return null;
  if (patterns.length === 0) throw new Error('pnpm-workspace.yaml has an empty packages list');
  // Every pattern is checked now, so an unevaluable shape fails the whole
  // layout once rather than surfacing from inside an entry's check.
  for (const pattern of patterns) parsePattern(pattern.replace(/^!/, ''));
  return patterns;
}

function matchesPattern({ pattern, segments }) {
  const { matchers, deep } = parsePattern(pattern);
  const matches = matchers.every((matcher, i) =>
    typeof matcher === 'string'
      ? segments[i] === matcher
      : segments[i] !== undefined && matcher.test(segments[i])
  );
  if (!matches) return false;
  if (!deep) return segments.length === matchers.length;
  return (
    segments.length >= matchers.length &&
    segments.slice(matchers.length).every((s) => !s.startsWith('.'))
  );
}

/** True when `directory` (relative, normalised) is a workspace package of the checkout. */
export function isWorkspaceDirectory({ patterns, directory }) {
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
