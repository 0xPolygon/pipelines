import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { NEVER_WAIVABLE_RULE_IDS, WAIVABLE_RULE_IDS } from '../src/exceptions.ts';
import { analyzeShell } from '../src/shell-commands.ts';
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
const WAIVABLE = 'runner/registry-fetch';
const CREDENTIALED = 'runner/registry-fetch-with-credential';

const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'runner-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const check = (files: Record<string, string>): CheckResult =>
  runChecks({
    root: tree(files),
    profile,
    context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
  });
const runnerFindings = (result: CheckResult): Finding[] =>
  result.findings.filter((f) => f.ruleId.startsWith('runner/'));
const ids = (result: CheckResult): string[] => runnerFindings(result).map((f) => f.ruleId);

const HEAD = 'on:\n  push:\n    branches: [main]\npermissions: {}\n';
/** A job without a publishing credential running the given step lines. */
const plainJob = (steps: string): string =>
  `${HEAD}jobs:\n  ci:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n${steps}`;
const run = (command: string): string => `      - run: ${JSON.stringify(command)}\n`;
/** A job holding `id-token: write` that only calls a shared workflow, so no other rule fires on it. */
const credentialCall = (withLines: string): string =>
  `${HEAD}jobs:\n  call:\n    permissions:\n      id-token: write\n    uses: 0xPolygon/pipelines/.github/workflows/apps-some.yml@main\n    with:\n${withLines}`;

void describe('runner/registry-fetch: each runner', () => {
  for (const command of [
    'npx prettier --check .',
    'pnpx prettier --check .',
    'bunx prettier --check .',
    'bun x prettier --check .',
    'npm exec prettier -- --check .',
    'npm exe prettier -- --check .',
    'npm x prettier -- --check .',
    'pnpm dlx prettier --check .',
    'yarn dlx prettier --check .',
    'npx --yes prettier@3 --check .',
    'npx -p typescript tsc'
  ]) {
    void it(`flags ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), [WAIVABLE]);
    });
  }

  for (const command of [
    'pnpm exec prettier --check .',
    'yarn exec prettier --check .',
    'npm run lint',
    'pnpm run lint',
    'npm ex',
    'echo npx is banned'
  ]) {
    void it(`passes ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), []);
    });
  }

  void it('reports where the runner is', () => {
    const [finding] = runnerFindings(check({ [WF]: plainJob(run('npx prettier')) }));
    assert.equal(finding?.file, WF);
    assert.equal(finding?.line, 11);
    assert.equal(finding?.severity, 'notice');
  });
});

void describe('runner/registry-fetch: wrapper forms', () => {
  for (const command of [
    'env CI=1 npx prettier',
    'CI=1 npx prettier',
    'xargs npx prettier',
    'sudo npx prettier',
    'time npx prettier',
    'timeout 30 npx prettier',
    'pnpm install && npx prettier',
    'corepack pnpm dlx prettier',
    'pnpm exec npx prettier',
    'sh -c "npx prettier --check ."',
    "bash -c 'npm exec prettier'",
    'bash -c "cd x && pnpm dlx prettier"'
  ]) {
    void it(`flags ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), [WAIVABLE]);
    });
  }

  void it('flags a runner on a later line of a block', () => {
    const text = plainJob('      - run: |\n          pnpm install\n          npx prettier\n');
    assert.deepEqual(ids(check({ [WF]: text })), [WAIVABLE]);
  });

  void it('ignores a runner named only in a shell comment', () => {
    assert.deepEqual(
      ids(check({ [WF]: plainJob('      - run: |\n          # npx x\n          ls\n') })),
      []
    );
  });

  void it('exposes the runners as shell facts', () => {
    assert.deepEqual(
      analyzeShell({ text: 'sudo npx a && pnpm dlx b && pnpm exec c' }).registryRunners,
      ['npx', 'pnpm dlx']
    );
  });
});

void describe('runner/registry-fetch: other surfaces', () => {
  void it('flags a package script reached through pnpm run', () => {
    const result = check({
      [WF]: plainJob(run('pnpm run fmt')),
      'package.json': '{"scripts":{"fmt":"pnpm dlx prettier --write ."}}'
    });
    assert.deepEqual(ids(result), [WAIVABLE]);
    assert.match(runnerFindings(result)[0]?.message ?? '', /package script `fmt`/);
  });

  void it('flags a script of a workspace package named by a filter', () => {
    const result = check({
      [WF]: plainJob(run('pnpm --filter pkg run gen')),
      'package.json': '{"scripts":{}}',
      'packages/pkg/package.json': '{"scripts":{"gen":"npx openapi-gen"}}'
    });
    assert.deepEqual(ids(result), [WAIVABLE]);
  });

  void it('does not flag a script that is never run', () => {
    const result = check({
      [WF]: plainJob(run('pnpm run lint')),
      'package.json': '{"scripts":{"lint":"eslint .","other":"npx x"}}'
    });
    assert.deepEqual(ids(result), []);
  });

  void it('flags a runner in a with: input of a uses step', () => {
    const text = plainJob(
      '      - uses: acme/retry@v1\n        with:\n          command: npx prettier\n'
    );
    assert.deepEqual(ids(check({ [WF]: text })), [WAIVABLE]);
  });

  void it('flags a runner in a composite action run step, in the action file', () => {
    const action =
      'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npx prettier\n';
    const result = check({
      [WF]: plainJob('      - uses: ./.github/actions/fmt\n'),
      '.github/actions/fmt/action.yml': action
    });
    const [finding] = runnerFindings(result);
    assert.equal(finding?.ruleId, WAIVABLE);
    assert.equal(finding?.file, '.github/actions/fmt/action.yml');
    assert.equal(finding?.line, 6);
  });

  void it('flags a composite action no workflow uses', () => {
    const action =
      'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: yarn dlx x\n';
    assert.deepEqual(
      ids(check({ [WF]: plainJob(run('ls')), '.github/actions/lib/action.yml': action })),
      [WAIVABLE]
    );
  });

  void it('does not read READMEs or docs', () => {
    const result = check({
      [WF]: plainJob(run('ls')),
      'README.md': 'Run `npx my-cli init`.\n',
      'docs/use.md': 'npx my-cli\n'
    });
    assert.deepEqual(ids(result), []);
  });

  void it('reads every workflow, not only release files', () => {
    const result = check({ [WF]: plainJob(run('npx prettier')) });
    assert.deepEqual(result.notInScope, [WF]);
    assert.deepEqual(ids(result), [WAIVABLE]);
  });
});

void describe('runner/registry-fetch: credential-holding jobs', () => {
  void it('uses the never-waivable id in a job holding id-token: write', () => {
    const result = check({ [WF]: credentialCall('      command: npx prettier\n') });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('uses the never-waivable id in a job holding an npm token', () => {
    const text = plainJob(
      '      - run: npx prettier\n        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n'
    );
    assert.ok(ids(check({ [WF]: text })).includes(CREDENTIALED));
  });

  void it('uses the never-waivable id for a composite action a credentialed job uses', () => {
    const action =
      'name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npx prettier\n';
    const text = `${HEAD}jobs:\n  j:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: ./.github/actions/fmt\n`;
    const result = check({ [WF]: text, '.github/actions/fmt/action.yml': action });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('a job that reads a non-GITHUB_TOKEN secret and runs npx is never waivable, and a marker is refused', () => {
    const body = readFileSync(join(fixtures, 'runner/fail-secret-wrangler.yml'), 'utf8');
    const plain = check({ [WF]: body });
    assert.deepEqual(ids(plain), [CREDENTIALED]);
    const marked = check({
      [WF]: `# release-conformance-exception: ${CREDENTIALED} until 2026-12-01 deploy tool\n${body}`
    });
    assert.deepEqual(ids(marked), [CREDENTIALED]);
    assert.ok(marked.findings.some((f) => f.ruleId === 'exception/invalid'));
    assert.deepEqual(marked.exceptions, []);
  });

  for (const [label, text] of [
    [
      'a job-level env',
      plainJob('      - run: npx wrangler deploy\n').replace(
        '    steps:',
        '    env:\n      TOKEN: ${{ secrets.DEPLOY_KEY }}\n    steps:'
      )
    ],
    [
      'a with: value',
      plainJob(
        '      - uses: acme/deploy@v1\n        with:\n          key: ${{ secrets.DEPLOY_KEY }}\n      - run: npx wrangler deploy\n'
      )
    ],
    [
      'run text',
      plainJob(
        '      - run: |\n          echo "${{ secrets[\'DEPLOY_KEY\'] }}" | npx wrangler login\n'
      )
    ],
    [
      'an npm token variable',
      plainJob('      - run: npx wrangler deploy\n        env:\n          NODE_AUTH_TOKEN: x\n')
    ],
    [
      'a job-level with: value on a call',
      `${HEAD}jobs:\n  call:\n    uses: acme/shared/.github/workflows/x.yml@main\n    with:\n      key: \${{ secrets.DEPLOY_KEY }}\n      command: npx wrangler deploy\n`
    ],
    [
      'secrets: inherit on a call',
      `${HEAD}jobs:\n  call:\n    uses: acme/shared/.github/workflows/x.yml@main\n    secrets: inherit\n    with:\n      command: npx wrangler deploy\n`
    ],
    [
      'a named secret on a call',
      `${HEAD}jobs:\n  call:\n    uses: acme/shared/.github/workflows/x.yml@main\n    secrets:\n      KEY: \${{ secrets.DEPLOY_KEY }}\n    with:\n      command: npx wrangler deploy\n`
    ]
  ] as const) {
    void it(`counts a secret reached through ${label} as a credential`, () => {
      assert.deepEqual(ids(check({ [WF]: text })), [CREDENTIALED]);
    });
  }

  void it('does not count GITHUB_TOKEN as a credential', () => {
    const text = plainJob(
      '      - run: npx prettier\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'
    );
    assert.deepEqual(ids(check({ [WF]: text })), [WAIVABLE]);
  });

  void it('is not waived by a marker, and the marker is refused', () => {
    const text = `# release-conformance-exception: ${CREDENTIALED} until 2026-12-01 needed\n${credentialCall('      command: npx prettier\n')}`;
    const result = check({ [WF]: text });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.ok(result.findings.some((f) => f.ruleId === 'exception/invalid'));
    assert.deepEqual(result.exceptions, []);
  });

  void it('a marker for the plain id does not waive the credentialed one', () => {
    const text = `# release-conformance-exception: ${WAIVABLE} until 2026-12-01 needed\n${credentialCall('      command: npx prettier\n')}`;
    const result = check({ [WF]: text });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('lists the credentialed id as never waivable and the plain id as waivable', () => {
    assert.ok(NEVER_WAIVABLE_RULE_IDS.includes(CREDENTIALED));
    assert.ok(WAIVABLE_RULE_IDS.includes(WAIVABLE));
    assert.ok(!NEVER_WAIVABLE_RULE_IDS.includes(WAIVABLE));
    assert.ok(!WAIVABLE_RULE_IDS.includes(CREDENTIALED));
  });
});

void describe('runner/registry-fetch: waivable outside credential jobs', () => {
  void it('is waived by a dated marker in the workflow', () => {
    const text = `# release-conformance-exception: ${WAIVABLE} until 2026-12-01 pinned by hand\n${plainJob(run('npx prettier'))}`;
    const result = check({ [WF]: text });
    assert.deepEqual(ids(result), []);
    assert.equal(result.exceptions[0]?.ruleId, WAIVABLE);
  });

  void it('is waived by a marker in the composite action file', () => {
    const action = `# release-conformance-exception: ${WAIVABLE} until 2026-12-01 dev tool\nname: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npx prettier\n`;
    const result = check({
      [WF]: plainJob('      - uses: ./.github/actions/fmt\n'),
      '.github/actions/fmt/action.yml': action
    });
    assert.deepEqual(ids(result), []);
    assert.equal(result.exceptions.length, 1);
  });
});

void describe('runner/registry-fetch: severity and exit status', () => {
  const entry = join(import.meta.dirname, '../src/index.ts');
  const canonical = tree({});
  mkdirSync(join(canonical, '.github/workflows'), { recursive: true });
  for (const name of ['apps-npm-release-trigger.yml', 'apps-npm-release.yml'])
    cpSync(join(fixtures, 'canonical/pr2', name), join(canonical, '.github/workflows', name));
  const exitOf = (workflow: string): number | null =>
    spawnSync(
      process.execPath,
      [
        entry,
        '--root',
        tree({ [WF]: workflow }),
        '--canonical-dir',
        canonical,
        '--default-branch',
        'main',
        '--repository',
        'example-org/example'
      ],
      { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } }
    ).status;

  void it('a credential-free hit is a notice and the run exits 0', () => {
    const result = check({ [WF]: plainJob(run('npx prettier')) });
    assert.deepEqual(ids(result), [WAIVABLE]);
    assert.equal(result.findings.filter((f) => f.severity === 'error').length, 0);
    assert.equal(exitOf(plainJob(run('npx prettier'))), 0);
  });

  void it('a credential hit is an error and the run exits 1', () => {
    const text = credentialCall('      command: npx prettier\n');
    assert.equal(check({ [WF]: text }).findings.filter((f) => f.severity === 'error').length, 1);
    assert.equal(exitOf(text), 1);
  });

  void it('a valid marker still suppresses the credential-free notice', () => {
    const text = `# release-conformance-exception: ${WAIVABLE} until 2026-12-01 pinned by hand\n${plainJob(run('npx prettier'))}`;
    assert.deepEqual(ids(check({ [WF]: text })), []);
  });
});
