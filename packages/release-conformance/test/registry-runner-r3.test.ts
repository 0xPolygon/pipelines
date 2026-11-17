import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { normalizeShell } from '../src/repo-scan.ts';
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
const plainJob = (steps: string): string => job({ steps });
const credJob = (steps: string): string => job({ env: CRED_ENV, steps });
const run = (command: string): string => `      - run: ${JSON.stringify(command)}\n`;
const block = (lines: string[]): string =>
  `      - run: |\n${lines.map((l) => `          ${l}`).join('\n')}\n`;
const ACTION = (command: string): string =>
  `name: a\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: ${command}\n`;

/** Runs a one-line command in a credential job and returns the runner finding ids. */
const credIds = (command: string): string[] => ids(check({ [WF]: credJob(run(command)) }));
const credBlockIds = (lines: string[]): string[] => ids(check({ [WF]: credJob(block(lines)) }));
const hit = [CREDENTIALED];

void describe('D1: echo and printf are text only when their output cannot run later', () => {
  for (const command of [
    'echo "npx foo" 2>&1 | sh',
    'echo "npx foo" 2>&1 |& sh',
    'echo "npx foo" > run.sh; sh run.sh',
    'echo "npx foo" >> run.sh; sh run.sh',
    "printf '%s\\n' 'npx foo' > x.sh && . ./x.sh",
    'echo -e "set -e\\nnpx foo" > r.sh && sh r.sh',
    'echo "npx foo" > >(sh)',
    'echo npx foo 1> >(bash)',
    'echo "npx foo" &> x.sh',
    'echo "npx foo" > run.sh && chmod +x run.sh && ./run.sh',
    'echo "npx foo" >> "$GITHUB_OUTPUT"',
    'echo "npx foo" >> $GITHUB_ENV',
    'echo "npx foo" >&3'
  ]) {
    void it(`is a hit: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  }

  void it('a script written on one line and run on the next is a hit', () => {
    assert.deepEqual(credBlockIds(['echo "npx foo" > run.sh', 'sh run.sh']), hit);
  });

  for (const command of [
    'echo "npx foo"',
    'echo "npx foo" >> "$GITHUB_STEP_SUMMARY"',
    "printf '%s\\n' 'npx foo' > \"$GITHUB_STEP_SUMMARY\"",
    'echo "npx foo" >&2',
    'echo "npx foo" 1>&2',
    'echo "npx foo" 2>&1',
    'echo "npx foo" 2>/dev/null',
    'echo "npx foo" > /dev/null',
    'echo "a => npx foo"',
    'echo "npx foo" &'
  ]) {
    void it(`stays text: ${command}`, () => {
      assert.deepEqual(credIds(command), []);
    });
  }
});

void describe('D2: flags between the manager and the subcommand', () => {
  const forms = [
    'npm --yes exec foo',
    'npm -y exec foo',
    'pnpm --silent dlx foo',
    'yarn -s dlx foo',
    'npm -y init foo',
    'npm --foo bar exec foo',
    'pnpm -C dir dlx foo',
    'npm -w x init foo',
    'pnpm -r dlx foo',
    'npm -q x foo'
  ];
  for (const form of forms) {
    void it(`a heredoc body is a hit: ${form}`, () => {
      assert.deepEqual(credBlockIds(['cat > r.sh <<EOF', form, 'EOF', 'sh r.sh']), hit);
    });
    void it(`a quoted argument of an unknown wrapper is a hit: ${form}`, () => {
      assert.deepEqual(credIds(`mywrap "${form}"`), hit);
    });
    void it(`a prose input is a hit: ${form}`, () => {
      const step = `      - uses: acme/notify@v1\n        with:\n          content: ${JSON.stringify(form)}\n`;
      assert.deepEqual(ids(check({ [WF]: credJob(step) })), hit);
    });
  }

  void it('flags before an ordinary subcommand are not a runner', () => {
    for (const command of [
      'mywrap "npm --silent run build"',
      'mywrap "pnpm -C dir install"',
      'mywrap "yarn -s test"'
    ])
      assert.deepEqual(credIds(command), []);
  });
});

void describe('D3: runner words at any word boundary', () => {
  for (const command of [
    'mywrap "cd x&&npx foo"',
    'mywrap "cd x;npx foo"',
    'mywrap "true|npx foo"',
    'mywrap \'["npx","foo"]\'',
    'mywrap run:npx foo',
    'mywrap (npx foo)',
    'mywrap X=npx',
    "mywrap 'npx foo'",
    'mywrap "cd x&&pnpm dlx foo"',
    'mywrap "a&&bunx foo"'
  ]) {
    void it(`is a hit: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  }

  for (const script of [
    'require("child_process").execSync("npx foo")',
    'await exec.exec("npx", ["foo"])'
  ]) {
    void it(`a github-script string is a hit: ${script}`, () => {
      const step = `      - uses: actions/github-script@v7\n        with:\n          script: ${JSON.stringify(script)}\n`;
      assert.deepEqual(ids(check({ [WF]: credJob(step) })), hit);
    });
  }

  void it('a name that only contains a runner word is not one', () => {
    for (const command of [
      'mywrap mynpx npxfoo mybunx pnpxfoo',
      'mywrap npx-foo foo-npx',
      'mywrap registry.npmjs.org yarn.lock pnpm-lock.yaml'
    ])
      assert.deepEqual(credIds(command), []);
  });
});

void describe('D4: comments and backslashes', () => {
  for (const lines of [
    ['echo hi # note \\', 'npx foo'],
    ['# install \\', 'npx foo'],
    ['echo a \\\\', 'npx foo']
  ]) {
    void it(`the next line is read: ${lines.join(' / ')}`, () => {
      assert.deepEqual(credBlockIds(lines), hit);
    });
  }

  void it('a backslash-newline outside a comment still joins', () => {
    assert.deepEqual(credBlockIds(['npm exec \\', '  foo']), hit);
    assert.equal(normalizeShell('npm \\\n exec foo'), 'npm   exec foo');
    assert.equal(normalizeShell('a \\\\\\\nb'), 'a \\\\ b');
  });

  void it('normalizeShell keeps the line after a commented continuation', () => {
    assert.equal(normalizeShell('echo hi # n \\\nnpx foo'), 'echo hi \nnpx foo');
    assert.equal(normalizeShell('echo a \\\\\nnpx foo'), 'echo a \\\\\nnpx foo');
  });
});

void describe('D5: search output that is run is not excused', () => {
  for (const command of [
    'grep npx cmds.txt | sh',
    'grep -o "npx [a-z]*" README.md | bash',
    "sed -n '/npx/p' cmds.txt | sh",
    'eval "$(sed -n \'/npx/p\' cmds.txt)"',
    'grep npx f > r.sh; sh r.sh',
    'rg -N npx cmds.txt | sh',
    'grep npx f 2>&1 | sh',
    'grep npx f > >(sh)',
    'grep npx f | xargs sh -c'
  ]) {
    void it(`is a hit: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  }

  for (const command of [
    'grep -n npx README.md',
    '! grep -nE "npx |pnpm dlx" file',
    'grep -q npx f && echo found',
    'sed -n \'/npx/p\' f >> "$GITHUB_STEP_SUMMARY"',
    'grep npx f >&2',
    'cat f | grep npx'
  ]) {
    void it(`stays a search: ${command}`, () => {
      assert.deepEqual(credIds(command), []);
    });
  }
});

void describe('D6: a local path that climbs out is unreadable', () => {
  const used = (uses: string): string => credJob(`      - uses: ${uses}\n`);
  for (const uses of ['./../x', './a/../x', './.github/actions/../actions/ok']) {
    void it(`${uses} in a credential job is the unreadable-action error`, () => {
      const result = check({
        [WF]: used(uses),
        '.github/actions/ok/action.yml': ACTION('ls')
      });
      assert.deepEqual(ids(result), hit);
      assert.match(found(result)[0]?.message ?? '', /could not be read/);
    });
  }

  void it('without a credential there is no finding', () => {
    assert.deepEqual(ids(check({ [WF]: plainJob('      - uses: ./../x\n') })), []);
  });

  void it('a climbing path inside an action a credential job uses is the error too', () => {
    const files = {
      [WF]: used('./.github/actions/a'),
      '.github/actions/a/action.yml':
        'name: a\nruns:\n  using: composite\n  steps:\n    - uses: ./../x\n'
    };
    assert.deepEqual(ids(check(files)), hit);
    assert.deepEqual(
      ids(check({ ...files, [WF]: plainJob('      - uses: ./.github/actions/a\n') })),
      []
    );
  });
});

void describe('D7: the mapped and the literal path are both read', () => {
  const files = {
    [WF]: credJob('      - uses: ./.pipelines/.github/actions/a\n'),
    '.github/actions/a/action.yml': ACTION('ls'),
    '.pipelines/.github/actions/a/action.yml': ACTION('npx foo')
  };

  void it('a literal action with a runner is found beside a benign mapped one', () => {
    assert.deepEqual(ids(check(files, '0xPolygon/pipelines')), hit);
  });

  void it('another repository reads the literal path only', () => {
    assert.deepEqual(ids(check(files, 'acme/widget')), hit);
    const benignLiteral = {
      ...files,
      '.pipelines/.github/actions/a/action.yml': ACTION('ls'),
      '.github/actions/a/action.yml': ACTION('npx foo')
    };
    // The credential job reads only the benign literal path; the unused action stays a notice.
    assert.deepEqual(ids(check(benignLiteral, 'acme/widget')), [PLAIN]);
    assert.deepEqual(ids(check(benignLiteral, '0xPolygon/pipelines')), hit);
  });

  void it('an absent literal path is not an unreadable action', () => {
    const mappedOnly = Object.fromEntries(
      Object.entries(files).filter(([path]) => !path.startsWith('.pipelines/'))
    );
    assert.deepEqual(ids(check(mappedOnly, '0xPolygon/pipelines')), []);
  });
});

void describe('D10(a): an install that ignores scripts reads no lifecycle script', () => {
  const files = {
    'package.json': '{"scripts":{}}',
    'packages/db/package.json': '{"scripts":{"postinstall":"npx prisma generate"}}'
  };
  for (const command of [
    'pnpm install --frozen-lockfile --ignore-scripts',
    'pnpm --ignore-scripts install',
    'npm ci --ignore-scripts',
    'yarn install --ignore-scripts',
    'yarn --ignore-scripts',
    'npm_config_ignore_scripts=true pnpm install',
    'env npm_config_ignore_scripts=true npm ci',
    'NPM_CONFIG_IGNORE_SCRIPTS=1 yarn install'
  ]) {
    void it(`reads nothing: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: plainJob(run(command)), ...files })), []);
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), []);
    });
  }

  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm install --ignore-scripts=false',
    'npm_config_ignore_scripts=false npm ci'
  ]) {
    void it(`still reads the script: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), hit);
    });
  }
});

void describe('a deny list of runners is not a use of one', () => {
  const PINNED = 'anthropics/claude-code-action@4845bacbb38b3c4b15d948f035349786f678e068';
  const action = (args: string, uses = PINNED, key = 'claude_args'): string =>
    `      - uses: ${uses}\n        with:\n          ${key}: ${JSON.stringify(args)}\n`;
  const viaAction = (args: string, uses?: string, key?: string): string =>
    ids(check({ [WF]: credJob(action(args, uses, key)) })).join();
  const REAL =
    '--disallowedTools "Edit(.git/**),Edit(**/.git),Edit(**/.git/**),Bash(git *--output*),Bash(gh pr comment *--body-file*),Bash(gh pr comment * -F*),Edit(~/.gitconfig),Edit(~/.config/**),Edit(~/.claude/**),Edit(~/.claude.json),Edit(/${{ runner.temp }}/**),Read(//proc/**),Bash(cd *),Bash(pushd *),Bash(git -C *),Bash(git -c *),Bash(git --git-dir*),Bash(git --work-tree*),Bash(git --exec-path*),Bash(git -*),Bash(gh pr * --repo*),Bash(gh pr * -R*),Bash(gh run * --repo*),Bash(gh run * -R*),Bash(node),Bash(node *),Bash(python),Bash(python *),Bash(python3),Bash(python3 *),Bash(bash),Bash(bash *),Bash(sh),Bash(sh *),Bash(zsh),Bash(zsh *),Bash(perl),Bash(perl *),Bash(ruby),Bash(ruby *),Bash(npx),Bash(npx *),Bash(npm),Bash(npm *),Bash(pnpm),Bash(pnpm *),Bash(yarn),Bash(yarn *),Bash(bun),Bash(bun *),Bash(deno),Bash(deno *),Bash(make),Bash(make *),Bash(go),Bash(go *),Bash(cargo),Bash(cargo *),Bash(curl),Bash(curl *),Bash(wget),Bash(wget *),Bash(env),Bash(env *),Bash(xargs),Bash(xargs *),Bash(python*),Bash(exec *),Bash(eval *),Bash(source *),Bash(. *),Bash(command *),Bash(/*),Bash(./*),Bash(awk *),Bash(sed *),Bash(php *)"';

  void it("the real autofix deny list passes, through the action's input", () => {
    assert.equal(viaAction(REAL), '');
    assert.equal(viaAction(REAL.replace('--disallowedTools ', '--disallowed-tools ')), '');
    assert.equal(viaAction(REAL.replace('--disallowedTools ', '--disallowedTools=')), '');
  });

  void it('the same list passes as arguments of a claude command', () => {
    assert.deepEqual(credIds(REAL.replace(/^/, 'claude -p x ')), []);
    assert.deepEqual(credIds(REAL.replace(/^/, '/usr/local/bin/claude -p x ')), []);
  });

  for (const [name, args] of [
    ['a substitution in an entry', '--disallowedTools "Bash($(npx x))"'],
    ['a backtick in an entry', '--disallowedTools "Bash(`npx x`)"'],
    ['a workflow expression in an entry', '--disallowedTools "Bash(npx ${{ inputs.x }})"'],
    ['a variable in an entry', '--disallowedTools "Bash(${X} npx a)"'],
    ['an allow list', '--allowedTools "Bash(npx *)"'],
    ['an allow list, hyphenated', '--allowed-tools "Bash(npx *)"'],
    ['a command after the list', '--disallowedTools "Bash(a)" && npx foo'],
    ['an unbalanced entry', '--disallowedTools "Bash(npx"'],
    ['an unbalanced entry after a good one', '--disallowedTools "Bash(a),Bash(npx b"'],
    ['another spelling', '--disallowedtools "Bash(npx a)"'],
    ['another spelling, hyphen and capital', '--disallowed-Tools "Bash(npx a)"'],
    ['text outside an entry', '--disallowedTools "Bash(a),npx b"']
  ] as const)
    void it(`is confirmed through the action: ${name}`, () => {
      assert.equal(viaAction(args), CREDENTIALED);
    });

  void it('an unpinned or other action, or another input, gets no exception', () => {
    const rule = '--disallowedTools "Bash(npx a)"';
    assert.equal(viaAction(rule, 'anthropics/claude-code-action@v1'), CREDENTIALED);
    assert.equal(viaAction(rule, 'acme/claude-code-action@' + '4'.repeat(40)), CREDENTIALED);
    assert.equal(viaAction(rule, PINNED, 'prompt'), CREDENTIALED);
    assert.equal(viaAction(rule, PINNED, 'claude_args_extra'), CREDENTIALED);
  });

  void it('any other program gets no exception', () => {
    assert.deepEqual(credIds('somecmd --disallowedTools "Bash(npx a)"'), hit);
    assert.deepEqual(credIds('notclaude --disallowedTools "Bash(npx a)"'), hit);
    assert.deepEqual(credIds('claude-wrapper --disallowedTools "Bash(npx a)"'), hit);
    assert.deepEqual(credIds('claude -p x --disallowedTools "Bash(npx a)" && npx foo'), hit);
    assert.deepEqual(credIds('claude -p x --disallowedTools "Bash($(npx x))"'), hit);
    assert.deepEqual(credIds('claude -p x --allowedTools "Bash(npx a)"'), hit);
  });
});
