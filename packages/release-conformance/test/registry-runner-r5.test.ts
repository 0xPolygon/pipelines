import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const fixtures = join(import.meta.dirname, 'fixtures');
const scratch: string[] = [];
after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

const profile: Profile = (() => {
  const read = (name: string) =>
    parseWorkflow({
      file: name,
      text: readFileSync(join(fixtures, 'canonical', 'pr1', name), 'utf8')
    });
  return deriveProfile({
    trigger: read('apps-npm-release-trigger.yml'),
    release: read('apps-npm-release.yml')
  });
})();

const WF = '.github/workflows/ci.yml';
const CREDENTIALED = 'runner/registry-fetch-with-credential';

const check = (files: Record<string, string>, repository = 'acme/widget'): CheckResult => {
  const root = mkdtempSync(join(tmpdir(), 'runner-r3-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return runChecks({
    root,
    profile,
    context: { defaultBranch: 'main', repository, today: '2026-11-17' }
  });
};
const found = (result: CheckResult): Finding[] =>
  result.findings.filter((f) => f.ruleId.startsWith('runner/'));
const ids = (result: CheckResult): string[] => found(result).map((f) => f.ruleId);

const HEAD = 'on:\n  push:\n    branches: [main]\npermissions: {}\n';
const job = ({ env = '', steps }: { env?: string; steps: string }): string =>
  `${HEAD}jobs:\n  ci:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n${env}    steps:\n${steps}`;
const CRED_ENV = '    env:\n      TOK: ${{ secrets.DEPLOY }}\n';
const credJob = (steps: string): string => job({ env: CRED_ENV, steps });
const run = (command: string): string => `      - run: ${JSON.stringify(command)}\n`;
const block = (lines: string[]): string =>
  `      - run: |\n${lines.map((l) => `          ${l}`).join('\n')}\n`;
/** Runs a one-line command in a credential job and returns the runner finding ids. */
const credIds = (command: string): string[] => ids(check({ [WF]: credJob(run(command)) }));
const credBlockIds = (lines: string[]): string[] => ids(check({ [WF]: credJob(block(lines)) }));
const hit = [CREDENTIALED];

const MISS: string[] = [];

void describe('F1: npm innit <package> is a runner like npm init <package>', () => {
  for (const command of ['npm innit foo', 'npm innit @scope/app', 'npm --yes innit foo'])
    void it(`reads run text: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  void it('reads a heredoc', () => {
    assert.deepEqual(credBlockIds(['cat > r.sh <<EOF', 'npm innit foo', 'EOF', 'sh r.sh']), hit);
  });
  void it('reads a wrapper argument', () => {
    assert.deepEqual(credIds('mywrap "npm innit foo"'), hit);
  });
  for (const command of ['npm innit', 'npm innit -y', 'npm init', 'npm init -y'])
    void it(`passes bare: ${command}`, () => {
      assert.deepEqual(credIds(command), MISS);
    });
});

const lifecycle = (script: string): Record<string, string> => ({
  'package.json': `{"scripts":{"postinstall":"npx foo","build":"npx foo"${script}}}`
});

void describe('npm documented aliases read lifecycle scripts like their command', () => {
  const groups: Record<string, string[]> = {
    ci: ['npm clean-install', 'npm install-clean', 'npm ic', 'npm isntall-clean'],
    install: ['npm in', 'npm ins', 'npm inst', 'npm insta', 'npm instal', 'npm isntall'],
    'install-test': ['npm cit', 'npm install-ci-test', 'npm clean-install-test', 'npm sit']
  };
  for (const [group, commands] of Object.entries(groups))
    for (const command of commands)
      void it(`${group}: ${command} reads postinstall`, () => {
        assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...lifecycle('') })), hit);
      });
  void it('a benign postinstall passes', () => {
    const files = { 'package.json': '{"scripts":{"postinstall":"echo hi"}}' };
    assert.deepEqual(ids(check({ [WF]: credJob(run('npm ic')), ...files })), MISS);
  });
  for (const command of ['npm rum build', 'npm urn build', 'npm run-script build'])
    void it(`run: ${command} reads the named script`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...lifecycle('') })), hit);
    });
  void it('test: npm tst reads the test script', () => {
    const files = { 'package.json': '{"scripts":{"test":"npx foo"}}' };
    assert.deepEqual(ids(check({ [WF]: credJob(run('npm tst')), ...files })), hit);
  });
  void it('run alias of a benign script passes', () => {
    const files = { 'package.json': '{"scripts":{"build":"tsc","postinstall":"npx foo"}}' };
    assert.deepEqual(ids(check({ [WF]: credJob(run('npm rum build')), ...files })), MISS);
  });
});

void describe('E6: --ignore-scripts with a separate value', () => {
  const files = { 'package.json': '{"scripts":{"postinstall":"npx foo"}}' };
  for (const command of [
    'npm ci --ignore-scripts false',
    'pnpm install --ignore-scripts false',
    'npm ci --ignore-scripts 0',
    'npm ci --ignore-scripts no',
    'npm ci --ignore-scripts "false"',
    'npm ci --ignore-scripts $X'
  ])
    void it(`reads the script: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), hit);
    });
  for (const command of [
    'npm ci --ignore-scripts',
    'npm --ignore-scripts ci',
    'pnpm install --ignore-scripts && echo done'
  ])
    void it(`passes with scripts off: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), MISS);
    });
});
