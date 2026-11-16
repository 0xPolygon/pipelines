import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const entry = join(import.meta.dirname, '../src/index.ts');

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  scratch.push(dir);
  return dir;
};

const canonicalDir = (() => {
  const dir = tmp();
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  for (const name of ['apps-npm-release-trigger.yml', 'apps-npm-release.yml']) {
    cpSync(join(fixtures, 'canonical/pr2', name), join(dir, '.github/workflows', name));
  }
  return dir;
})();

const repoWith = (workflow?: string): string => {
  const root = tmp();
  if (workflow !== undefined) {
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    cpSync(join(fixtures, 'shared-caller', workflow), join(root, '.github/workflows', workflow));
  }
  return root;
};

const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env }
  });

const baseArgs = (root: string, json?: string): string[] => [
  '--root',
  root,
  '--canonical-dir',
  canonicalDir,
  '--default-branch',
  'main',
  '--repository',
  'example-org/example',
  '--today',
  '2026-11-16',
  ...(json === undefined ? [] : ['--json', json])
];

suite('entry point exit status', () => {
  test('a conforming tree exits 0', () => {
    const json = join(tmp(), 'out.json');
    const r = run(baseArgs(repoWith('pass-canonical-shape.yml'), json));
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const doc: unknown = JSON.parse(readFileSync(json, 'utf8'));
    assert.ok(typeof doc === 'object' && doc !== null && 'errorCount' in doc);
    assert.equal(doc.errorCount, 0);
  });

  test('a violating tree exits 1 and reports the rule ids', () => {
    const json = join(tmp(), 'out.json');
    const r = run(baseArgs(repoWith('fail-secrets-inherit.yml'), json));
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const doc: unknown = JSON.parse(readFileSync(json, 'utf8'));
    const findings =
      typeof doc === 'object' && doc !== null && 'findings' in doc && Array.isArray(doc.findings)
        ? doc.findings
        : [];
    const ids = findings.map((f: unknown) =>
      typeof f === 'object' && f !== null && 'ruleId' in f ? f.ruleId : undefined
    );
    assert.ok(ids.includes('caller/secrets-inherit'), `got ${JSON.stringify(ids)}`);
    assert.ok(r.stdout.includes('::error file=.github/workflows/fail-secrets-inherit.yml'));
  });

  test('a tree with no workflows directory exits 0 and says nothing is in scope', () => {
    const r = run(baseArgs(repoWith()));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('nothing in scope'));
  });

  test('a missing canonical directory exits 2', () => {
    const args = baseArgs(repoWith('pass-canonical-shape.yml'));
    args[args.indexOf('--canonical-dir') + 1] = join(tmp(), 'absent');
    const r = run(args);
    assert.equal(r.status, 2);
    assert.ok(r.stderr.includes('release-conformance:'));
  });

  test('a missing default branch exits 2', () => {
    const args = baseArgs(repoWith('pass-canonical-shape.yml'));
    args.splice(args.indexOf('--default-branch'), 2);
    assert.equal(run(args).status, 2);
  });

  test('an unreadable canonical workflow exits 2', () => {
    const dir = tmp();
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/apps-npm-release-trigger.yml'), 'a: [unclosed\n');
    writeFileSync(join(dir, '.github/workflows/apps-npm-release.yml'), 'a: [unclosed\n');
    const args = baseArgs(repoWith('pass-canonical-shape.yml'));
    args[args.indexOf('--canonical-dir') + 1] = dir;
    assert.equal(run(args).status, 2);
  });

  test('a file outside both rule sets that holds id-token write is surfaced as a notice', () => {
    const root = tmp();
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(root, '.github/workflows/other.yml'),
      'on: workflow_dispatch\npermissions: {}\njobs:\n  j:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: echo hi\n'
    );
    const r = run(baseArgs(root));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('::notice file=.github/workflows/other.yml'));
    assert.ok(r.stdout.includes('title=publisher/unclassified-id-token'));
  });

  test('an unknown flag exits 2', () => {
    assert.equal(run([...baseArgs(repoWith()), '--nope']).status, 2);
  });

  test('inputs may come from the environment', () => {
    const r = run([], {
      RC_ROOT: repoWith('pass-canonical-shape.yml'),
      RC_CANONICAL_DIR: canonicalDir,
      RC_DEFAULT_BRANCH: 'main'
    });
    assert.equal(r.status, 0, r.stderr);
  });

  test('--version prints the version and exits 0', () => {
    const r = run(['--version']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.startsWith('release-conformance '));
  });
});
