import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { Profile } from './types.ts';

import { deriveProfile } from './canonical.ts';
import { runChecks } from './engine.ts';
import { scanRepo } from './repo-scan.ts';
import { formatAnnotations, formatJson, formatSummary } from './report.ts';
import { parseWorkflow } from './workflow-model.ts';

const VERSION = '1.0.0';
const MIN_NODE_MAJOR = 20;

const TRIGGER_FILE = '.github/workflows/apps-npm-release-trigger.yml';
const RELEASE_FILE = '.github/workflows/apps-npm-release.yml';

/** Raised for a usage or environment problem; the process exits 2, never 0 or 1. */
class UsageError extends Error {}

const USAGE = `Usage: release-conformance [options]

Options (each also reads the environment variable shown):
  --root <dir>             repository under review (RC_ROOT, default ".")
  --canonical-dir <dir>    checkout holding the shared release workflow and its trigger (RC_CANONICAL_DIR)
  --default-branch <name>  the repository's default branch (RC_DEFAULT_BRANCH)
  --repository <owner/name>  repository name for the report (RC_REPOSITORY, GITHUB_REPOSITORY)
  --json <file>            also write the findings as JSON to this file
  --today <YYYY-MM-DD>     override the UTC date used for exception expiry (tests)
  --version                print the version and exit

Exit status: 0 no errors, 1 at least one error, 2 usage or internal error.
`;

const loadProfile = (canonicalDir: string): Profile => {
  const read = (relative: string) => {
    const path = join(canonicalDir, relative);
    if (!existsSync(path)) throw new UsageError(`Canonical file not found: ${path}`);
    const model = parseWorkflow({ file: relative, text: readFileSync(path, 'utf8') });
    if (model.parseError !== undefined) {
      throw new UsageError(`Canonical file ${path} could not be read: ${model.parseError}`);
    }
    return model;
  };
  return deriveProfile({ trigger: read(TRIGGER_FILE), release: read(RELEASE_FILE) });
};

const requireDirectory = ({ path, what }: { path: string; what: string }): void => {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new UsageError(`${what} is not a directory: ${path}`);
  }
};

const main = (): number => {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < MIN_NODE_MAJOR) {
    throw new UsageError(
      `Node ${MIN_NODE_MAJOR} or newer is required; this is Node ${process.versions.node}.`
    );
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        root: { type: 'string' },
        'canonical-dir': { type: 'string' },
        'default-branch': { type: 'string' },
        repository: { type: 'string' },
        json: { type: 'string' },
        today: { type: 'string' },
        version: { type: 'boolean' },
        help: { type: 'boolean' }
      },
      strict: true,
      allowPositionals: false
    }));
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  if (values.version === true) {
    process.stdout.write(`release-conformance ${VERSION}\n`);
    return 0;
  }
  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const env = process.env;
  const pick = (flag: string | undefined, name: string): string | undefined => {
    if (flag !== undefined) return flag;
    const fromEnv = env[name];
    return fromEnv === undefined || fromEnv.trim() === '' ? undefined : fromEnv;
  };

  const root = resolve(pick(values.root, 'RC_ROOT') ?? '.');
  const canonicalDirInput = pick(values['canonical-dir'], 'RC_CANONICAL_DIR');
  const defaultBranch = pick(values['default-branch'], 'RC_DEFAULT_BRANCH')?.trim();
  const repository =
    pick(values.repository, 'RC_REPOSITORY') ?? pick(undefined, 'GITHUB_REPOSITORY') ?? 'unknown';
  const today = values.today ?? new Date().toISOString().slice(0, 10);

  if (defaultBranch === undefined || defaultBranch === '') {
    throw new UsageError('The default branch is required (--default-branch or RC_DEFAULT_BRANCH).');
  }
  if (canonicalDirInput === undefined) {
    throw new UsageError(
      'The canonical directory is required (--canonical-dir or RC_CANONICAL_DIR).'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new UsageError(`--today must be YYYY-MM-DD, got: ${today}`);
  }
  const canonicalDir = resolve(canonicalDirInput);
  requireDirectory({ path: root, what: 'The root' });
  requireDirectory({ path: canonicalDir, what: 'The canonical directory' });

  const profile = loadProfile(canonicalDir);
  const context = { defaultBranch, repository, today };
  const result = runChecks({ root, profile, context });

  const inScope = scanRepo({ root }).files.flatMap((file) =>
    file.class === 'not-in-scope' ? [] : [{ file: file.model.file, class: file.class }]
  );

  for (const line of formatAnnotations({ result })) process.stdout.write(`${line}\n`);

  const errors = result.findings.filter((f) => f.severity === 'error').length;
  process.stdout.write(
    inScope.length === 0
      ? 'release-conformance: nothing in scope.\n'
      : `release-conformance: ${inScope.length} file(s) in scope, ${errors} error(s).\n`
  );

  const summaryPath = env['GITHUB_STEP_SUMMARY'];
  if (summaryPath !== undefined && summaryPath !== '') {
    appendFileSync(summaryPath, formatSummary({ result, inScope }));
  }
  if (values.json !== undefined) {
    writeFileSync(values.json, formatJson({ result, inScope, context }));
  }

  return errors > 0 ? 1 : 0;
};

try {
  process.exitCode = main();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // A crash must never read as a pass: any failure here is exit 2.
  process.stderr.write(`release-conformance: ${message}\n`);
  process.exitCode = 2;
}
