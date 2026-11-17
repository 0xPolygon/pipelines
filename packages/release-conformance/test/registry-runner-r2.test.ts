import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { NEVER_WAIVABLE_RULE_IDS, WAIVABLE_RULE_IDS } from '../src/exceptions.ts';
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
const PLAIN = 'runner/registry-fetch';
const CREDENTIALED = 'runner/registry-fetch-with-credential';

const check = (files: Record<string, string>): CheckResult => {
  const root = mkdtempSync(join(tmpdir(), 'runner-r2-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return runChecks({
    root,
    profile,
    context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
  });
};
const found = (result: CheckResult): Finding[] =>
  result.findings.filter((f) => f.ruleId.startsWith('runner/'));
const ids = (result: CheckResult): string[] => found(result).map((f) => f.ruleId);

const HEAD = 'on:\n  push:\n    branches: [main]\npermissions: {}\n';
const job = ({ env = '', steps }: { env?: string; steps: string }): string =>
  `${HEAD}jobs:\n  ci:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n${env}    steps:\n${steps}`;
const CRED_ENV = '    env:\n      TOK: ${{ secrets.DEPLOY }}\n';
const plainJob = (steps: string): string => job({ steps });
const credJob = (steps: string): string => job({ env: CRED_ENV, steps });
const run = (command: string): string => `      - run: ${JSON.stringify(command)}\n`;
const block = (lines: string[]): string =>
  `      - run: |\n${lines.map((l) => `          ${l}`).join('\n')}\n`;
const ACTION = (command: string): string =>
  `name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${command}\n`;

void describe('H2: command forms the parser follows in a credential job', () => {
  for (const command of [
    'pnpm start & npx wait-on http://localhost:3000',
    'pnpm start &npx wait-on http://localhost:3000',
    'a |& npx b',
    'doppler run -- npx foo',
    'doppler run --project x --config y -- npx foo',
    'op run -- npx foo',
    'op run --env-file=.env -- npx foo',
    'dotenv -e .env -- npx prisma migrate deploy',
    'dotenvx run -- npx foo',
    'dotenvx run -f .env.ci -- pnpm dlx foo',
    'cross-env FOO=1 npx foo',
    'cross-env FOO=1 BAR=2 npm exec foo',
    'cross-env-shell FOO=1 "npx foo"',
    'concurrently "npx foo" "npx bar"',
    "concurrently -n a,b 'pnpm start' 'npx bar'",
    'start-server-and-test start 3000 "npx cypress run"',
    'docker run --rm node:24 npx foo',
    'docker run --rm -e A=b -v x:y node:24 sh -c "npx foo"',
    'retry 3 npx foo',
    'watch -n 5 npx foo',
    'su -c "npx foo" deploy',
    'script -qc "npx foo" /dev/null',
    'nix develop -c npx foo',
    'bash -euo pipefail -c "npx foo"',
    'bash -euo pipefail -c npx foo',
    'bash -euo pipefail -c "cd x && npx foo"',
    'sh -c "echo a; npx foo"',
    'eval "npx foo"',
    'diff <(npx foo) x'
  ]) {
    void it(`never-waivable for: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)) })), [CREDENTIALED]);
    });
  }

  void it('the same forms stay notices without a credential', () => {
    for (const command of [
      'pnpm start & npx wait-on x',
      'doppler run -- npx foo',
      'retry 3 npx foo'
    ])
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), [PLAIN]);
  });

  void it('a single & in a redirection is not a separator', () => {
    assert.deepEqual(
      ids(check({ [WF]: credJob(run('pnpm test >out.log 2>&1 && pnpm exec x')) })),
      []
    );
  });
});

void describe('H2 (d): the text-level test in a credential job', () => {
  for (const command of [
    'cat "npx wrangler"',
    'pnpm --store-dir /tmp/s dlx foo',
    'npm --foo bar exec foo',
    'yarn --foo /tmp dlx foo',
    'unknown-wrapper --flag npx foo',
    'make "CMD=npx foo"'
  ]) {
    void it(`never-waivable for text the parser does not follow: ${command}`, () => {
      const result = check({ [WF]: credJob(run(command)) });
      assert.deepEqual(ids(result), [CREDENTIALED]);
      assert.equal(found(result)[0]?.severity, 'error');
    });
    void it(`nothing new without a credential for: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), []);
    });
  }

  void it('there is no second, waivable id', () => {
    assert.ok(!WAIVABLE_RULE_IDS.includes('runner/possible-registry-fetch'));
    assert.ok(!NEVER_WAIVABLE_RULE_IDS.includes('runner/possible-registry-fetch'));
    assert.ok(NEVER_WAIVABLE_RULE_IDS.includes(CREDENTIALED));
  });

  void it('applies in a composite action a credential job uses', () => {
    const result = check({
      [WF]: credJob('      - uses: ./.github/actions/a\n'),
      '.github/actions/a/action.yml': ACTION('cat "npx foo"')
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });
});

void describe('the two excused forms, and the near-misses beside each', () => {
  for (const command of [
    'echo npx foo',
    'echo "first; npx foo"',
    'echo "a && npx foo"',
    "printf '%s\\n' 'run npx foo'",
    'echo "use npx foo" >> $GITHUB_STEP_SUMMARY',
    'grep -nE "npx |pnpm dlx" file',
    '! grep -nE "npx |pnpm dlx" file',
    'grep -e npx -e "pnpm dlx" file',
    "grep -rn --include='*.yml' 'npm exec' .",
    'grep -c npx file',
    'rg "npx foo" src',
    "sed -n '/npx/p' file",
    "sed 's/npx foo/ls/' file",
    "sed -E -n '/pnpm dlx/p' file"
  ]) {
    void it(`passes: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)) })), []);
    });
  }

  for (const command of [
    'echo npx foo | sh',
    'echo npx foo | bash',
    'echo "$(echo npx foo)"',
    'echo $(echo npx foo)',
    'echo `echo npx foo`',
    "echo 'use `npx foo` locally'",
    'echo npx foo | xargs',
    'eval "$(echo npx foo)"',
    'echo npx foo | eval',
    'grep foo "npx file"',
    'grep -E foo npx',
    'grep "$(npx foo)" file',
    "sed 's/a/npx foo/' file",
    "sed -n '/a/p' npx",
    'rg --unknown-flag "npx foo" src',
    'cat file | grep x | npx foo',
    'sudo grep x && npx foo',
    'echo npx foo; eval "$X"',
    'echo npx foo; ls | xargs rm'
  ]) {
    void it(`fails: ${command}`, () => {
      assert.deepEqual([...new Set(ids(check({ [WF]: credJob(run(command)) })))], [CREDENTIALED]);
    });
  }
});

void describe('text that is not an excused form', () => {
  void it('a pull-request body with a backticked runner fails', () => {
    const text = credJob(
      '      - uses: acme/pr@v1\n        with:\n          body: |\n            Run `npx changeset` to add a changeset.\n'
    );
    assert.deepEqual(ids(check({ [WF]: text })), [CREDENTIALED]);
  });

  void it('a body line that starts with a runner fails', () => {
    const text = credJob(
      '      - uses: acme/pr@v1\n        with:\n          body: |\n            npm exec foo\n'
    );
    assert.deepEqual(ids(check({ [WF]: text })), [CREDENTIALED]);
  });

  void it('a body is not read at all without a credential', () => {
    const text = plainJob(
      '      - uses: acme/pr@v1\n        with:\n          body: |\n            Run `npx changeset` to add a changeset.\n'
    );
    assert.deepEqual(ids(check({ [WF]: text })), []);
  });

  void it('a heredoc body fails in a credential job and passes without one', () => {
    assert.deepEqual(
      ids(check({ [WF]: credJob(block(['cat <<EOF > msg.md', 'npx changeset', 'EOF'])) })),
      [CREDENTIALED]
    );
    assert.deepEqual(ids(check({ [WF]: plainJob(block(['cat <<EOF > m', 'npx x', 'EOF'])) })), []);
  });

  void it('a heredoc handed to a shell is a script', () => {
    assert.deepEqual(ids(check({ [WF]: credJob(block(['bash <<EOF', 'npx foo', 'EOF'])) })), [
      CREDENTIALED
    ]);
  });

  void it('shell comments are not commands', () => {
    assert.deepEqual(ids(check({ [WF]: credJob(block(['# npx foo', 'ls # npx bar'])) })), []);
  });

  void it('a command after a quoted separator is still seen', () => {
    assert.deepEqual(ids(check({ [WF]: credJob(run('echo "a; b" && npx foo')) })), [CREDENTIALED]);
  });

  void it('npx --no-install and npm exec --offline stay flagged', () => {
    for (const command of ['npx --no-install foo', 'npx --no foo', 'npm exec --offline -- foo'])
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)) })), [CREDENTIALED]);
  });

  void it('a stray apostrophe does not hide a later command', () => {
    const text = credJob(block(["echo don't stop", 'npx foo']));
    assert.deepEqual(ids(check({ [WF]: text })), [CREDENTIALED]);
  });
});

void describe('the create forms', () => {
  for (const command of [
    'npm create vite@latest app',
    'npm create vite',
    'npm init vite@latest app',
    'npm init foo -y',
    'npm init @scope/foo',
    'pnpm create vite',
    'pnpm create next-app app',
    'yarn create react-app app',
    'bun create next app'
  ]) {
    void it(`fetches: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)) })), [CREDENTIALED]);
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), [PLAIN]);
    });
  }

  for (const command of [
    'npm init',
    'npm init -y',
    'npm init --yes',
    'pnpm init',
    'yarn init -y',
    'bun init'
  ]) {
    void it(`does not fetch: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)) })), []);
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)) })), []);
    });
  }
});

void describe('M1: composite action credential link', () => {
  const used = (uses: string): string => credJob(`      - uses: ${uses}\n`);
  const npxAction = ACTION('npx foo');

  void it('a trailing slash still links', () => {
    const result = check({
      [WF]: used('./.github/actions/a/'),
      '.github/actions/a/action.yml': npxAction
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('this repository by name is local', () => {
    const result = check({
      [WF]: used('acme/widget/.github/actions/a@main'),
      '.github/actions/a/action.yml': npxAction
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('another repository is not read', () => {
    const result = check({
      [WF]: used('acme/other/.github/actions/a@main'),
      '.github/actions/a/action.yml': npxAction
    });
    assert.deepEqual(ids(result), [PLAIN]);
  });

  void it('passes through action to action', () => {
    const outer = 'name: a\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/b\n';
    const result = check({
      [WF]: used('./.github/actions/a'),
      '.github/actions/a/action.yml': outer,
      '.github/actions/b/action.yml': npxAction
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.equal(found(result)[0]?.file, '.github/actions/b/action.yml');
  });

  void it('a cycle of actions ends', () => {
    const toB = 'name: a\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/b\n';
    const toA =
      'name: b\nruns:\n  using: composite\n  steps:\n    - uses: ./.github/actions/a\n    - run: npx foo\n      shell: bash\n';
    const result = check({
      [WF]: used('./.github/actions/a'),
      '.github/actions/a/action.yml': toB,
      '.github/actions/b/action.yml': toA
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
  });

  void it('reads an action outside .github/actions', () => {
    const result = check({ [WF]: used('./tools/act'), 'tools/act/action.yml': npxAction });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.equal(found(result)[0]?.file, 'tools/act/action.yml');
  });

  void it('reads the root action', () => {
    const result = check({ [WF]: used('./'), 'action.yml': npxAction });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.equal(found(result)[0]?.file, 'action.yml');
  });

  void it('reads an action more than four levels deep', () => {
    const path = '.github/actions/a/b/c/d/e/f';
    assert.deepEqual(ids(check({ [WF]: plainJob(run('ls')), [`${path}/action.yml`]: npxAction })), [
      PLAIN
    ]);
    assert.deepEqual(ids(check({ [WF]: used(`./${path}`), [`${path}/action.yml`]: npxAction })), [
      CREDENTIALED
    ]);
  });

  void it('an unreadable action in a credential job fails closed, and only there', () => {
    const result = check({ [WF]: used('./tools/missing') });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.equal(found(result)[0]?.file, WF);
    assert.deepEqual(ids(check({ [WF]: plainJob('      - uses: ./tools/missing\n') })), []);
  });

  void it('a marker for the unreadable-action finding is refused', () => {
    const body = readFileSync(join(fixtures, 'runner/fail-unreadable-action.yml'), 'utf8');
    const result = check({
      [WF]: `# release-conformance-exception: ${CREDENTIALED} until 2026-12-01 later\n${body}`
    });
    assert.deepEqual(ids(result), [CREDENTIALED]);
    assert.ok(result.findings.some((f) => f.ruleId === 'exception/invalid'));
    assert.match(found(result)[0]?.message ?? '', /cannot confirm that it fetches nothing/);
  });

  void it('an unparseable or oversized action is unreadable too', () => {
    assert.deepEqual(
      ids(check({ [WF]: used('./tools/bad'), 'tools/bad/action.yml': 'runs: [unclosed' })),
      [CREDENTIALED]
    );
    assert.deepEqual(
      ids(
        check({ [WF]: used('./tools/big'), 'tools/big/action.yml': `#${'x'.repeat(1_100_000)}\n` })
      ),
      [CREDENTIALED]
    );
  });

  void it('this repository by name is read the same way', () => {
    assert.deepEqual(ids(check({ [WF]: used('acme/widget/tools/missing@main') })), [CREDENTIALED]);
  });

  void it('an unreadable action is left to publisher/unreadable-local-action in a publishing job', () => {
    const text = `${HEAD}jobs:\n  j:\n    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: ./tools/missing\n`;
    assert.deepEqual(ids(check({ [WF]: text })), []);
  });

  void it('a node action is not a shell text to read', () => {
    const node = 'name: n\nruns:\n  using: node20\n  main: index.js\n';
    assert.deepEqual(ids(check({ [WF]: used('./tools/n'), 'tools/n/action.yml': node })), []);
  });
});

void describe('M1: the canonical repository checks itself out', () => {
  const checkedOut = credJob('      - uses: ./.pipelines/.github/actions/a\n');
  const files = { [WF]: checkedOut, '.github/actions/a/action.yml': ACTION('npx foo') };
  const asCanonical = (tree: Record<string, string>): CheckResult => {
    const root = mkdtempSync(join(tmpdir(), 'runner-r2-'));
    scratch.push(root);
    for (const [path, text] of Object.entries(tree)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return runChecks({
      root,
      profile,
      context: { defaultBranch: 'main', repository: '0xPolygon/pipelines', today: '2026-11-16' }
    });
  };

  void it('maps .pipelines/ onto the tree for the canonical repository only', () => {
    assert.deepEqual(ids(asCanonical(files)), [CREDENTIALED]);
    // Elsewhere the path is not this tree, so the action is not read through it; the listed action stays a notice.
    assert.deepEqual(ids(check(files)).sort(), [PLAIN, CREDENTIALED]);
  });
});

void describe('M2: install-time scripts of workspace packages', () => {
  const ROOT = { 'package.json': '{"scripts":{}}' };
  const DB = (script: string, body: string) => ({
    'packages/db/package.json': `{"scripts":{"${script}":"${body}"}}`
  });
  for (const [command, script] of [
    ['pnpm install --frozen-lockfile', 'postinstall'],
    ['pnpm i', 'preinstall'],
    ['npm ci', 'prepare'],
    ['npm install', 'install'],
    ['yarn install', 'postinstall'],
    ['yarn --frozen-lockfile', 'postinstall'],
    ['yarn', 'prepare'],
    ['bun install', 'postinstall']
  ] as const) {
    void it(`${command} reads the ${script} of a workspace package`, () => {
      const files = { ...ROOT, ...DB(script, 'npx prisma generate') };
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)), ...files })), [PLAIN]);
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), [CREDENTIALED]);
    });
  }

  void it('a script that is not an install-time one is not read', () => {
    const files = { ...ROOT, ...DB('gen', 'npx prisma generate') };
    assert.deepEqual(ids(check({ [WF]: plainJob(run('pnpm install')), ...files })), []);
  });

  void it('pnpm/action-setup with run_install is an install', () => {
    const files = { 'package.json': '{"scripts":{"prepare":"npx patch-package"}}' };
    const step = (input: string): string =>
      `      - uses: pnpm/action-setup@fe02b34f77f8bc703788d5817da081398fad5dd2\n        with:\n          run_install: ${input}\n`;
    assert.deepEqual(ids(check({ [WF]: plainJob(step('true')), ...files })), [PLAIN]);
    assert.deepEqual(ids(check({ [WF]: plainJob(step('false')), ...files })), []);
    assert.deepEqual(
      ids(
        check({
          [WF]: plainJob(
            '      - uses: pnpm/action-setup@fe02b34f77f8bc703788d5817da081398fad5dd2\n'
          ),
          ...files
        })
      ),
      []
    );
  });
});

void describe('M3: the credential test', () => {
  const callee = `on:\n  workflow_call:\njobs:\n  inner:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx foo\n`;
  const caller = (permissions: string): string =>
    `${HEAD.replace('permissions: {}\n', '')}jobs:\n  call:\n${permissions}    uses: ./.github/workflows/inner.yml\n`;

  void it('a callee job inherits id-token: write from a local caller job', () => {
    const result = check({
      [WF]: caller('    permissions:\n      id-token: write\n'),
      '.github/workflows/inner.yml': callee
    });
    assert.ok(ids(result).includes(CREDENTIALED));
    assert.ok(found(result).every((f) => f.file === '.github/workflows/inner.yml'));
  });

  void it('without a grant the callee is credential-free', () => {
    const result = check({
      [WF]: caller('    permissions:\n      contents: read\n'),
      '.github/workflows/inner.yml': callee
    });
    assert.deepEqual(ids(result), [PLAIN]);
  });

  for (const expression of [
    '${{ secrets[matrix.name] }}',
    "${{ secrets[format('{0}_KEY', inputs.env)] }}",
    '${{ toJSON(secrets) }}'
  ]) {
    void it(`counts ${expression} as a credential`, () => {
      const env = `    env:\n      T: ${JSON.stringify(expression)}\n`;
      assert.deepEqual(ids(check({ [WF]: job({ env, steps: run('npx foo') }) })), [CREDENTIALED]);
    });
  }

  void it('a literal GITHUB_TOKEN index is still not a credential', () => {
    const env = "    env:\n      T: ${{ secrets['GITHUB_TOKEN'] }}\n";
    assert.deepEqual(ids(check({ [WF]: job({ env, steps: run('npx foo') }) })), [PLAIN]);
  });

  for (const [label, secrets] of [
    ['GITHUB_TOKEN', '      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n'],
    ['a renamed token', '      token: ${{ secrets.GITHUB_TOKEN }}\n']
  ] as const) {
    void it(`a call passing only ${label} holds no credential`, () => {
      const text = `${HEAD}jobs:\n  call:\n    uses: acme/shared/.github/workflows/x.yml@main\n    secrets:\n${secrets}    with:\n      command: npx wrangler deploy\n`;
      assert.deepEqual(ids(check({ [WF]: text })), [PLAIN]);
    });
  }

  void it('a call passing another secret as well holds one', () => {
    const text = `${HEAD}jobs:\n  call:\n    uses: acme/shared/.github/workflows/x.yml@main\n    secrets:\n      GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}\n      K: \${{ secrets.DEPLOY }}\n    with:\n      command: npx wrangler deploy\n`;
    assert.deepEqual(ids(check({ [WF]: text })), [CREDENTIALED]);
  });
});

void describe('N1: where a finding is reported', () => {
  void it('reports the command line inside a multi-line step', () => {
    const result = check({ [WF]: plainJob(block(['pnpm install', 'ls', 'npx prettier'])) });
    assert.equal(found(result)[0]?.line, 14);
  });

  void it('a later identical line is not taken for an earlier one', () => {
    const action =
      'name: use npx foo here\ndescription: npx foo\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: npx foo\n';
    const result = check({
      [WF]: plainJob('      - uses: ./.github/actions/a\n'),
      '.github/actions/a/action.yml': action
    });
    assert.equal(found(result)[0]?.line, 7);
  });

  void it('a step reached through a YAML alias has a line', () => {
    const text = `${HEAD}jobs:\n  a:\n    runs-on: x\n    steps: &steps\n      - run: npx x\n  b:\n    runs-on: x\n    steps: *steps\n`;
    const lines = found(check({ [WF]: text })).map((f) => f.line);
    assert.equal(lines.length, 2);
    assert.ok(
      lines.every((line) => line > 0),
      `lines ${lines.join(',')}`
    );
  });

  void it('keeps action.yaml as action.yaml', () => {
    const result = check({
      [WF]: plainJob('      - uses: ./.github/actions/a\n'),
      '.github/actions/a/action.yaml': ACTION('npx foo')
    });
    assert.equal(found(result)[0]?.file, '.github/actions/a/action.yaml');
  });
});
