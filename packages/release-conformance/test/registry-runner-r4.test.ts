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
const PINNED = 'anthropics/claude-code-action@4845bacbb38b3c4b15d948f035349786f678e068';

void describe('E1: an echo or search is excused only at the top level of the script', () => {
  for (const lines of [
    ['{ echo "npx foo"; } > run.sh; sh run.sh'],
    ['{ echo "npx foo"; } > run.sh && bash run.sh'],
    ['{', 'echo "#!/bin/sh"', 'echo "npx foo"', '} > run.sh', 'sh run.sh'],
    ['{ echo "npx foo"; } | sh'],
    ["{ printf '%s\\n' 'pnpm dlx foo'; } | bash"],
    ['{ echo "npx foo"; } 2>&1 | tee r.sh'],
    ['(echo "npx foo"; echo "true") | sh'],
    ['(echo "npx foo"; echo "true") > run.sh'],
    ['(', 'echo "npx foo"', ') > run.sh'],
    ['for t in a b; do echo "npx $t"; done > run.sh'],
    ['for t in a b; do', 'echo "npx $t"', 'done | sh'],
    ['while read t; do', 'echo "npx $t"', 'done < list > run.sh'],
    ['if true; then echo "npx foo"; fi > run.sh'],
    ['{ grep npx cmds.txt; } | sh'],
    ['{', 'grep npx cmds.txt', '} > r.sh'],
    ['X=$(', 'echo "npx foo"', ')', 'eval "$X"'],
    ['gen() { echo "npx foo"; }', 'gen | sh'],
    ['case $x in', 'a) echo "npx foo" > r.sh ;;', 'esac'],
    ['X=`', 'echo "npx foo"', '`']
  ])
    void it(`reads it: ${lines.join(' / ')}`, () => {
      assert.deepEqual(credBlockIds(lines), hit);
    });

  for (const lines of [
    ['echo "npx foo"'],
    ['echo "npx foo"; echo "pnpm dlx foo"'],
    ['{ echo hi; }', 'echo "npx foo"'],
    ['for t in a; do echo hi; done', 'echo "npx foo"'],
    ['if true; then echo hi; fi', 'echo "npx foo"'],
    ['echo "smile :("', 'echo "npx foo"'],
    ['echo "npx foo" || true'],
    ['echo "hint: npx foo" || true'],
    ['grep -n "npx" file.txt'],
    ['(cd x; ls)', 'echo "npx foo"']
  ])
    void it(`still excuses it at the top level: ${lines.join(' / ')}`, () => {
      assert.deepEqual(credBlockIds(lines), MISS);
    });
});

void describe('E2: rebuild runs the install lifecycle scripts', () => {
  const root = { 'package.json': '{"scripts":{"postinstall":"npx patch-package"}}' };
  const workspace = {
    'package.json': '{"scripts":{}}',
    'packages/db/package.json': '{"scripts":{"postinstall":"npx prisma generate"}}'
  };
  for (const [name, lines, files] of [
    ['pnpm', ['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm rebuild'], root],
    ['npm', ['npm ci --ignore-scripts', 'npm rebuild'], workspace],
    ['npm rb', ['npm install --ignore-scripts', 'npm rb'], workspace],
    ['pnpm rb', ['pnpm install --ignore-scripts', 'pnpm rb'], root]
  ] as const)
    void it(`reads the scripts after an install with scripts off: ${name}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(block([...lines])), ...files })), hit);
    });

  void it('a rebuild that ignores scripts itself reads nothing', () => {
    assert.deepEqual(
      ids(check({ [WF]: credJob(run('pnpm rebuild --ignore-scripts')), ...root })),
      MISS
    );
  });
});

void describe('E3: a version glued to the manager name is skipped', () => {
  for (const command of [
    'mywrap "corepack pnpm@9.1.0 dlx foo"',
    'mywrap "corepack yarn@4.1.0 dlx foo"',
    'mywrap "corepack npm@10 exec foo"',
    'mywrap "pnpm@9 dlx foo"'
  ])
    void it(`reads it: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  void it('reads a heredoc', () => {
    assert.deepEqual(
      credBlockIds(['cat > r.sh <<EOF', 'corepack pnpm@9.1.0 dlx foo', 'EOF', 'sh r.sh']),
      hit
    );
  });
  void it('leaves a plain version pin alone', () => {
    assert.deepEqual(credIds('corepack pnpm@9.1.0 install --frozen-lockfile'), MISS);
  });
});

void describe('E4: manager words inside argument lists are read', () => {
  for (const command of [
    'mywrap \'["pnpm","dlx","foo"]\'',
    'mywrap \'["npm", "x", "foo"]\'',
    'mywrap \'["npm","exec","foo"]\'',
    "mywrap \"('pnpm', ['dlx', 'foo'])\"",
    'mywrap \'spawnSync("yarn", ["dlx", "foo"])\'',
    'python3 -c \'import subprocess; subprocess.run(["npm", "exec", "foo"])\''
  ])
    void it(`reads it: ${command}`, () => {
      assert.deepEqual(credIds(command), hit);
    });
  void it('reads a github-script input', () => {
    const script = (code: string): string =>
      `      - uses: actions/github-script@${'a'.repeat(40)}\n        with:\n          script: ${JSON.stringify(code)}\n`;
    for (const code of [
      'await exec.exec("npm", ["exec", "foo"])',
      "await exec.exec('pnpm', ['dlx', 'foo'])",
      'spawnSync("yarn", ["dlx", "foo"])'
    ])
      assert.deepEqual(ids(check({ [WF]: credJob(script(code)) })), hit, code);
  });
  void it('leaves ordinary lists of managers alone', () => {
    assert.deepEqual(credIds('mywrap \'["pnpm","install"]\''), MISS);
    assert.deepEqual(credIds('echo "use npm, pnpm, or yarn"'), MISS);
  });
});

void describe('E5: the deny-list exception is narrower', () => {
  const viaAction = (args: string): string =>
    ids(
      check({
        [WF]: credJob(
          `      - uses: ${PINNED}\n        with:\n          claude_args: ${JSON.stringify(args)}\n`
        )
      })
    ).join();
  void describe('(a) an entry with a quote, process substitution or a dollar is read', () => {
    for (const command of [
      'claude --disallowedTools="Bash("<(npx$IFS\'cowsay\')")"',
      'claude --disallowedTools="Bash("<(npx cowsay)")"',
      'claude --disallowedTools="Bash("\\>(npx cowsay)")"',
      'claude -p x --disallowedTools "Bash(npx $X)"',
      'claude -p x --disallowedTools "Bash(npx \'a\')"',
      'claude -p x --disallowedTools "Bash(<(npx a))"',
      'claude -p x --disallowedTools "Bash(>(npx a))"'
    ])
      void it(`reads: ${command}`, () => {
        assert.deepEqual(credIds(command), hit);
      });
  });
  void describe('(b) a flag that is the value of another option or follows -- is read', () => {
    for (const command of [
      'claude -p --system-prompt --disallowedTools "Bash(npx -y evil)"',
      'claude -p -- --disallowedTools "Bash(npx -y evil)"',
      'claude --append-system-prompt --disallowedTools "Bash(npx -y evil)"',
      'claude -p --system-prompt hello --disallowedTools "Bash(npx -y evil)"'
    ])
      void it(`reads: ${command}`, () => {
        assert.deepEqual(credIds(command), hit);
      });
    void it('reads the same in claude_args', () => {
      assert.equal(
        viaAction('--append-system-prompt --disallowedTools "Bash(npx -y evil)"'),
        CREDENTIALED
      );
      assert.equal(viaAction('-p --system-prompt --disallowedTools "Bash(npx a)"'), CREDENTIALED);
    });
    for (const command of [
      'claude --disallowedTools "Bash(npx a)"',
      'claude -p x --disallowedTools "Bash(npx a)"',
      'claude --print --disallowedTools "Bash(npx a)"',
      'claude -p --disallowedTools "Bash(npx a)"',
      'claude --allowedTools "Edit" --disallowedTools "Bash(npx a)"',
      'claude --allowedTools=Edit --disallowedTools "Bash(npx a)"'
    ])
      void it(`keeps the exception: ${command}`, () => {
        assert.deepEqual(credIds(command), MISS);
      });
  });
  void describe('(c) an entry starts at a boundary', () => {
    void it('reads mcp__x__Bash(…)', () => {
      assert.deepEqual(credIds('claude -p x --disallowedTools "mcp__x__Bash(npx foo)"'), hit);
      assert.equal(viaAction('--disallowedTools "mcp__x__Bash(npx foo)"'), CREDENTIALED);
    });
    void it('keeps entries after a comma or a space', () => {
      assert.deepEqual(credIds('claude -p x --disallowedTools "Edit(a),Bash(npx a)"'), MISS);
      assert.deepEqual(credIds('claude -p x --disallowedTools "Edit(a) Bash(npx a)"'), MISS);
      assert.equal(viaAction('--disallowedTools "Bash(npx a)"'), '');
    });
  });
});

void describe('E6: an install that also overrides --ignore-scripts is read', () => {
  const files = {
    'package.json': '{"scripts":{}}',
    'packages/db/package.json': '{"scripts":{"postinstall":"npx prisma generate"}}'
  };
  for (const command of [
    'pnpm install --ignore-scripts --ignore-scripts=false',
    'pnpm install --ignore-scripts --no-ignore-scripts',
    'npm_config_ignore_scripts=true npm ci --ignore-scripts=false',
    'npm_config_ignore_scripts=true npm_config_ignore_scripts=false npm ci',
    'env npm_config_ignore_scripts=true npm_config_ignore_scripts=false npm ci',
    'npm ci --ignore-scripts --no-ignore-scripts'
  ])
    void it(`reads the script: ${command}`, () => {
      assert.deepEqual(ids(check({ [WF]: credJob(run(command)), ...files })), hit);
    });
  void it('still reads nothing for scripts off alone', () => {
    assert.deepEqual(
      ids(check({ [WF]: credJob(run('pnpm install --ignore-scripts')), ...files })),
      MISS
    );
  });
});

void describe('E10: || is not a pipe', () => {
  void it('excuses an echo before ||', () => {
    assert.deepEqual(credIds('echo "hint: npx foo" || true'), MISS);
  });
  void it('still reads an echo piped after ||', () => {
    assert.deepEqual(credIds('true || echo "npx foo" | sh'), hit);
  });
});
