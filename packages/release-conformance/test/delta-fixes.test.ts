import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { scanRepo } from '../src/repo-scan.ts';
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

const WF = '.github/workflows/r.yml';
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'delta-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const workflow = (steps: string): string =>
  `on:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      id-token: write\n    steps:\n${steps}`;
const runStep = (command: string): string => `      - run: ${command}\n`;
const classOf = (files: Record<string, string>): string | undefined =>
  scanRepo({ root: tree(files) }).files[0]?.class;
const check = (files: Record<string, string>): CheckResult =>
  runChecks({
    root: tree(files),
    profile,
    context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
  });
const errorIds = (result: CheckResult): string[] =>
  [...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId))].sort();

void describe('publish forms behind a package-manager binary, wrapper or leading flag', () => {
  const publishing = [
    'pnpm changeset publish',
    'yarn changeset publish',
    'pnpm lerna publish from-package',
    'npm --tag beta publish',
    'npm --registry https://registry.npmjs.org publish',
    'ls *.tgz | xargs npm publish',
    'ls *.tgz | xargs -n1 npm publish --provenance',
    'timeout 300 npm publish',
    'exec npm publish',
    "find . -name '*.tgz' -exec npm publish {} +",
    'bash -c "npm publish"',
    'npx @changesets/cli publish',
    'npx changeset publish',
    'pnpm dlx @changesets/cli publish',
    'pnpm exec changeset publish'
  ];
  for (const command of publishing) {
    void it(`is a publisher: ${command}`, () => {
      assert.equal(
        classOf({ [WF]: workflow(runStep(`'${command.replaceAll("'", "''")}'`)) }),
        'bespoke-publisher'
      );
    });
  }

  void it('a tool that merely has a publish subcommand is not a package publish', () => {
    for (const command of [
      'pnpm exec wrangler publish',
      'npm run docs:publish',
      'npm run publish:docs'
    ]) {
      assert.equal(classOf({ [WF]: workflow(runStep(`'${command}'`)) }), 'not-in-scope', command);
    }
  });
});

void describe('what counts as repository code', () => {
  const errorsFor = (command: string): string[] =>
    errorIds(check({ [WF]: workflow(`${runStep(`'${command}'`)}${runStep('npm publish')}`) }));

  void it('a global tool install and a version print are not repository code', () => {
    for (const command of [
      'npm install -g npm@latest',
      'npm i -g npm@latest',
      'node --version',
      'node -v'
    ]) {
      assert.deepEqual(errorsFor(command), [], command);
    }
  });

  void it('a plain install and a node script still are', () => {
    for (const command of ['npm install', 'npm ci', 'node scripts/x.mjs']) {
      assert.deepEqual(errorsFor(command), ['publisher/id-token-with-code'], command);
    }
  });
});

void describe('setup-node default caching starts at v5', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const errorsWith = (uses: string, extra = ''): string[] =>
    errorIds(check({ [WF]: workflow(`      - uses: ${uses}\n${extra}${runStep('npm publish')}`) }));

  void it('v5 and a v5 SHA comment need the opt-out; v4 does not', () => {
    assert.deepEqual(errorsWith('actions/setup-node@v5'), ['publisher/no-cache']);
    assert.deepEqual(errorsWith(`actions/setup-node@${sha} # v5.0.0`), ['publisher/no-cache']);
    assert.deepEqual(errorsWith('actions/setup-node@v4'), []);
    assert.deepEqual(errorsWith(`actions/setup-node@${sha} # v4.4.0`), []);
  });

  void it('the opt-out clears it', () => {
    assert.deepEqual(
      errorsWith(
        `actions/setup-node@${sha} # v5.0.0`,
        '        with:\n          package-manager-cache: false\n'
      ),
      []
    );
  });
});

void describe('script lookup', () => {
  void it('a script named like an object property does not crash the run', () => {
    const files = {
      [WF]: workflow(runStep('pnpm run constructor')),
      'package.json': '{"scripts":{"release":"npm publish"}}'
    };
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const swapped = { ...files, [WF]: workflow(runStep(`pnpm run ${name}`)) };
      assert.doesNotThrow(() => classOf(swapped), name);
    }
  });

  void it('test, install and their hooks are looked up like run <script>', () => {
    const cases: [string, string][] = [
      ['npm test', '{"scripts":{"test":"npm publish"}}'],
      ['npm test', '{"scripts":{"posttest":"npm publish"}}'],
      ['npm ci', '{"scripts":{"prepare":"npm publish"}}'],
      ['npm install', '{"scripts":{"postinstall":"npm publish"}}'],
      ['pnpm install', '{"scripts":{"preinstall":"npm publish"}}']
    ];
    for (const [command, pkg] of cases) {
      assert.equal(
        classOf({ [WF]: workflow(runStep(command)), 'package.json': pkg }),
        'bespoke-publisher',
        `${command} ${pkg}`
      );
    }
  });

  void it('npm ci without any hook stays out of scope and raises no unresolved-script notice', () => {
    const files = { [WF]: workflow(runStep('npm ci')), 'package.json': '{"scripts":{}}' };
    assert.equal(classOf(files), 'not-in-scope');
    const result = check(files);
    assert.ok(!result.findings.some((f) => f.message.includes('`install`')));
  });
});
