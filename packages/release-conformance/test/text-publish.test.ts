import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { runsPublishText, scanRepo, textSeesPublish } from '../src/repo-scan.ts';
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

const WF = '.github/workflows/r.yml';
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'text-publish-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const check = (root: string): CheckResult =>
  runChecks({
    root,
    profile,
    context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
  });
const errorIds = (result: CheckResult): string[] =>
  [...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId))].sort();

/** Quotes a command for a one-line YAML `run:` value. */
const yamlRun = (command: string): string => `      - run: '${command.replaceAll("'", "''")}'\n`;

/** A job that signs in to a cloud with OIDC, installs dependencies, then runs the probed command. */
const oidcJob = ({ command, token = false }: { command: string; token?: boolean }): string =>
  `on:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      contents: read\n      id-token: write\n${
    token ? '    env:\n      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n' : ''
  }    steps:\n      - run: pnpm install --frozen-lockfile\n${yamlRun(command)}`;

void describe('a tool that has its own publish command is not a package publish', () => {
  for (const command of [
    'pnpm wrangler publish',
    'pnpm vsce publish',
    'pnpm build --mode publish',
    'echo "skipping npm publish on this branch"',
    "printf '%s' 'npm publish later'",
    'git commit -m "npm publish pending"'
  ]) {
    void it(`gives no never-waivable finding: ${command}`, () => {
      const root = tree({ [WF]: oidcJob({ command }) });
      assert.equal(scanRepo({ root }).files[0]?.class, 'not-in-scope');
      assert.deepEqual(errorIds(check(root)), []);
    });
  }
});

void describe('the parser itself recognises the known publish forms', () => {
  const forms = [
    'pnpm changeset publish',
    'yarn changeset publish',
    'pnpm lerna publish from-package',
    'yarn lerna publish',
    'ls *.tgz | xargs npm publish',
    'xargs -n1 npm publish --provenance',
    'xargs -I {} npm publish {}',
    'env NODE_ENV=production npm publish',
    'env -u FOO npm publish',
    'sudo npm publish',
    'sudo -u deploy npm publish',
    'timeout 300 npm publish',
    'timeout -s KILL 30s npm publish',
    'exec npm publish',
    'npx changeset publish',
    'npx --yes @changesets/cli publish',
    'pnpm exec changeset publish',
    'pnpm dlx @changesets/cli publish',
    'yarn dlx @changesets/cli publish',
    'bunx changeset publish',
    'bash -c "npm publish"',
    'bash -ec "pnpm publish"',
    "sh -c 'yarn publish'",
    "find . -name '*.tgz' -exec npm publish {} \;",
    'npm --tag beta publish',
    'npm --registry https://registry.npmjs.org publish',
    'pnpm --filter pkg publish',
    'pnpm -r publish --no-git-checks',
    'yarn --cwd pkg publish',
    'lerna --registry https://registry.npmjs.org publish',
    'bun --tag beta publish'
  ];
  for (const command of forms) {
    void it(`parser: ${command}`, () => {
      assert.equal(analyzeShell({ text: command }).publishes, true);
    });
    void it(`never-waivable in an installing id-token job: ${command}`, () => {
      const result = check(tree({ [WF]: oidcJob({ command }) }));
      assert.ok(errorIds(result).includes('publisher/id-token-with-code'), errorIds(result).join());
    });
  }

  void it('does not read a publish into a wrapper that runs something else', () => {
    for (const command of [
      'xargs echo npm publish',
      'timeout 300 pnpm test',
      'env FOO=bar node --version',
      'bash -c "echo npm publish"',
      "find . -name 'publish' -print"
    ]) {
      assert.equal(analyzeShell({ text: command }).publishes, false, command);
    }
  });
});

void describe('the text-level test is narrow', () => {
  void it('counts publish only right after a publishing tool, flags allowed between', () => {
    for (const text of [
      'parallel npm publish ::: a',
      'foo && pnpm --silent publish',
      '(yarn publish)'
    ]) {
      assert.equal(textSeesPublish(text), true, text);
    }
  });

  void it('ignores publish after any other word, and inside a printed string', () => {
    for (const text of [
      'wrangler publish',
      'pnpm wrangler publish',
      'pnpm build --mode publish',
      'echo "skipping npm publish on this branch"',
      'npm pkg get publishConfig',
      'pnpm run docs:publish',
      'git commit -m "npm publish pending"'
    ]) {
      assert.equal(textSeesPublish(text), false, text);
    }
  });

  void it('still counts a quoted publish given to a command that runs the string', () => {
    assert.equal(textSeesPublish('eval "npm publish"'), true);
  });
});

void describe('a publish only the text test sees', () => {
  const command = 'parallel npm publish ::: pkg-a pkg-b';

  void it('is one waivable error, and the job is not classified as a publisher', () => {
    const root = tree({ [WF]: oidcJob({ command }) });
    assert.equal(scanRepo({ root }).files[0]?.class, 'not-in-scope');
    const result = check(root);
    assert.deepEqual(errorIds(result), ['publisher/possible-publish']);
    assert.equal(result.findings.length, 1);
  });

  void it('is waived by a dated marker', () => {
    const marker =
      '# release-conformance-exception: publisher/possible-publish until 2027-01-31 the command is reviewed by a code owner\n';
    const result = check(tree({ [WF]: marker + oidcJob({ command }) }));
    assert.deepEqual(errorIds(result), []);
  });

  void it('keeps the token rules when the job holds an npm token', () => {
    const result = check(tree({ [WF]: oidcJob({ command, token: true }) }));
    assert.ok(errorIds(result).includes('publisher/id-token-with-code'));
    assert.ok(!errorIds(result).includes('publisher/possible-publish'));
  });

  void it('is not reported for a job with no publishing credential', () => {
    const noCredential = oidcJob({ command }).replace('      id-token: write\n', '');
    assert.deepEqual(errorIds(check(tree({ [WF]: noCredential }))), []);
  });
});

void describe('cost limits', () => {
  const MEGABYTE = 1_000_000;
  const timed = (run: () => unknown): number => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };

  for (const [name, piece] of [
    ['a scoped package name repeated with no spaces', '@changesets/cli@'],
    ['quote characters', '"'],
    ['publish-tool words', 'npm '],
    ['flag words after a tool', 'pnpm -a '],
    ['close brackets', ')']
  ] as const) {
    void it(`the text-level test stays under a second on 1 MB of ${name}`, () => {
      const input = piece.repeat(Math.ceil(MEGABYTE / piece.length));
      const ms = timed(() => {
        textSeesPublish(input);
        runsPublishText(input);
      });
      assert.ok(ms < 1000, `took ${ms} ms`);
    });
  }

  void it('a publish is still found after a long run of the same text', () => {
    assert.equal(textSeesPublish(`${'@changesets/cli@ '.repeat(50_000)}\nnpm publish`), true);
  });

  for (const [name, piece, size] of [
    ['`npm x` words', 'npm x ', 400_000],
    ['`pnpm` words', 'pnpm ', 300_000],
    ['`xargs` words', 'xargs ', 300_000],
    ['`bash -c` words', 'bash -c ', 300_000]
  ] as const) {
    void it(`a very long chain of ${name} finishes and fails closed`, () => {
      const input = piece.repeat(Math.ceil(size / piece.length));
      let facts: ReturnType<typeof analyzeShell> | undefined;
      const ms = timed(() => {
        facts = analyzeShell({ text: input });
      });
      assert.ok(ms < 1000, `took ${ms} ms`);
      assert.equal(facts?.tooDeep, true);
      assert.equal(facts?.runsCode, true);
      assert.equal(facts?.publishes, true);
    });
  }

  void it('a chain of ordinary depth is not treated as too deep', () => {
    assert.equal(analyzeShell({ text: 'sudo env A=1 timeout 5 npm publish' }).tooDeep, undefined);
  });

  void it('says so in the finding when a command is nested too deeply', () => {
    const result = check(tree({ [WF]: oidcJob({ command: 'pnpm '.repeat(5000) }) }));
    const finding = result.findings.find((f) => f.ruleId === 'publisher/id-token-with-code');
    assert.ok(finding?.message.includes('nests wrappers'), finding?.message);
  });
});

void describe('a linked parent directory is reported, not followed', () => {
  const publisher = oidcJob({ command: 'npm publish' }).replace(
    '      - run: pnpm install --frozen-lockfile\n',
    ''
  );

  void it('a linked `.github` directory is an error', () => {
    const real = tree({ 'elsewhere/workflows/r.yml': publisher });
    const root = tree({ 'placeholder.txt': 'x' });
    symlinkSync(join(real, 'elsewhere'), join(root, '.github'));
    const result = check(root);
    assert.ok(errorIds(result).includes('workflow/unparseable'), errorIds(result).join());
  });

  void it('a linked `.github/workflows` directory is an error', () => {
    const real = tree({ 'wf/r.yml': publisher });
    const root = tree({ '.github/placeholder.txt': 'x' });
    symlinkSync(join(real, 'wf'), join(root, '.github/workflows'));
    const result = check(root);
    assert.ok(errorIds(result).includes('workflow/unparseable'), errorIds(result).join());
  });

  void it('a linked `.github/actions` directory makes a local action unreadable', () => {
    const real = tree({
      'acts/build/action.yml':
        'runs:\n  using: composite\n  steps:\n    - run: echo hi\n      shell: bash\n'
    });
    const useLocal = publisher.replace(
      '    steps:\n',
      '    steps:\n      - uses: ./.github/actions/build\n'
    );
    const root = tree({ [WF]: useLocal });
    symlinkSync(join(real, 'acts'), join(root, '.github/actions'));
    const result = check(root);
    assert.ok(
      errorIds(result).includes('publisher/unreadable-local-action'),
      errorIds(result).join()
    );
  });
});

void describe('a quoted command word', () => {
  void it('a publish tool in quotes of its own is still a publish', () => {
    assert.equal(textSeesPublish('- run: "npm" publish'), true);
    assert.equal(analyzeShell({ text: '"npm" publish' }).publishes, true);
  });
});
