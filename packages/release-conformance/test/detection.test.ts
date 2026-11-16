import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { REFERENCE_DOWNGRADE_RULES, runChecks } from '../src/engine.ts';
import { scanRepo } from '../src/repo-scan.ts';
import { runsRepositoryCode } from '../src/rules/bespoke-publisher.ts';
import { analyzeShell } from '../src/shell-commands.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const CALLEE = '.github/workflows/apps-npm-release.yml';

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

/** A scratch repository tree from `{ path: text }`. */
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'detect-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};

const run = ({
  files,
  repository = 'example-org/example'
}: {
  files: Record<string, string>;
  repository?: string;
}): CheckResult =>
  runChecks({
    root: tree(files),
    profile,
    context: { defaultBranch: 'main', repository, today: '2026-11-16' }
  });

const errors = (result: CheckResult): string[] =>
  [...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId))].sort();
const notices = (result: CheckResult): Finding[] =>
  result.findings.filter((f) => f.severity === 'notice');

const WF = '.github/workflows/release.yml';
const PUSH = 'on:\n  push:\n    branches: [main]\npermissions: {}\n';

suite('publisher/unreadable-local-action', () => {
  const job = (uses: string, extra = '') =>
    `${PUSH}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      id-token: write\n${extra}    steps:\n      - uses: ${uses}\n`;

  test('an action outside the actions directory is an error even when the file exists', () => {
    const result = run({
      files: {
        [WF]: job('./tools/ship'),
        'tools/ship/action.yml':
          'runs:\n  using: composite\n  steps:\n    - run: npm ci && npm publish\n      shell: bash\n'
      }
    });
    assert.deepEqual(errors(result), ['publisher/unreadable-local-action']);
  });

  test('a missing action under the actions directory is an error', () => {
    const result = run({ files: { [WF]: job('./.github/actions/missing') } });
    assert.deepEqual(errors(result), ['publisher/unreadable-local-action']);
  });

  test('a node action is not read, so it is an error', () => {
    const result = run({
      files: {
        [WF]: job('./.github/actions/ship'),
        '.github/actions/ship/action.yml': 'runs:\n  using: node20\n  main: index.js\n'
      }
    });
    assert.deepEqual(errors(result), ['publisher/unreadable-local-action']);
  });

  test('a second level of local action is not followed, so it is an error', () => {
    const result = run({
      files: {
        [WF]: job('./.github/actions/outer'),
        '.github/actions/outer/action.yml':
          'runs:\n  using: composite\n  steps:\n    - uses: ./.github/actions/inner\n'
      }
    });
    assert.deepEqual(errors(result), ['publisher/unreadable-local-action']);
  });

  test('a readable composite action is followed and its publish is seen', () => {
    const result = run({
      files: {
        [WF]: job('./.github/actions/ship'),
        '.github/actions/ship/action.yml':
          'runs:\n  using: composite\n  steps:\n    - run: npm publish\n      shell: bash\n'
      }
    });
    assert.deepEqual(errors(result), []);
    assert.equal(scanRepo({ root: tree({}) }).files.length, 0);
  });

  test('an npm token in a job that uses an unreadable action is also an error', () => {
    const text = `${PUSH}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    env:\n      NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n    steps:\n      - uses: ./tools/ship\n`;
    assert.deepEqual(errors(run({ files: { [WF]: text } })), ['publisher/unreadable-local-action']);
  });

  test('a job with no credential may use any local action', () => {
    const text = `${PUSH}jobs:\n  lint:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n    steps:\n      - uses: ./tools/lint\n`;
    const result = run({ files: { [WF]: text } });
    assert.deepEqual(result.findings, []);
  });

  test('a dated marker waives it', () => {
    const marked = `# release-conformance-exception: publisher/unreadable-local-action until 2027-01-31 action is reviewed by hand\n${job('./tools/ship')}`;
    const result = run({ files: { [WF]: marked } });
    assert.deepEqual(errors(result), []);
    assert.equal(result.exceptions.length, 1);
  });

  test('the reference downgrade never covers it', () => {
    assert.ok(!REFERENCE_DOWNGRADE_RULES.has('publisher/unreadable-local-action'));
    const result = run({
      files: { [CALLEE]: job('./tools/ship') },
      repository: '0xPolygon/pipelines'
    });
    assert.deepEqual(errors(result), ['publisher/unreadable-local-action']);
  });
});

suite('the shared release workflow reads its own actions', () => {
  const callee = `name: release
on:
  push:
    branches: [main]
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    environment: npm-publish
    permissions:
      id-token: write
    steps:
      - uses: ./.pipelines/.github/actions/release-guard
      - uses: ./.pipelines/.github/actions/npm-publish-tarballs
`;
  const actions = {
    '.github/actions/release-guard/action.yml':
      'runs:\n  using: composite\n  steps:\n    - run: echo guard\n      shell: bash\n',
    '.github/actions/npm-publish-tarballs/action.yml':
      'runs:\n  using: composite\n  steps:\n    - run: node "$ACTION_PATH/publish-tarballs.mjs"\n      shell: bash\n'
  };

  test('in the canonical repository the publish job is classified, with no unreadable-action error', () => {
    const files = { [CALLEE]: callee, ...actions };
    const result = run({ files, repository: '0xPolygon/pipelines' });
    assert.deepEqual(errors(result), []);
    assert.ok(!result.findings.some((f) => f.ruleId.startsWith('publisher/unclassified')));
    assert.ok(!result.notInScope.includes(CALLEE));
  });

  test('the same file in another repository keeps the error', () => {
    const files = { [CALLEE]: callee, ...actions };
    for (const repository of ['example-org/pipelines', 'unknown']) {
      assert.deepEqual(errors(run({ files, repository })), ['publisher/unreadable-local-action']);
    }
  });

  test('another file in the canonical repository keeps the error', () => {
    const files = { [WF]: callee, ...actions };
    assert.deepEqual(errors(run({ files, repository: '0xPolygon/pipelines' })), [
      'publisher/unreadable-local-action'
    ]);
  });
});

suite('publisher/token-with-code is never waivable', () => {
  const dir = join(fixtures, 'bespoke-publisher');
  const withFixture = (name: string): CheckResult => {
    const root = mkdtempSync(join(tmpdir(), 'detect-'));
    scratch.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    cpSync(join(dir, name), join(root, '.github/workflows', name));
    return runChecks({
      root,
      profile,
      context: { defaultBranch: 'main', repository: 'example-org/example', today: '2026-11-16' }
    });
  };

  test('a split marker does not silence a token in a job that installs and builds', () => {
    const result = withFixture('fail-token-with-code-split-marker.yml');
    assert.deepEqual(errors(result), ['publisher/token-with-code']);
  });

  test('a marker for the new id is refused', () => {
    const root = tree({
      [WF]: `# release-conformance-exception: publisher/token-with-code until 2027-01-31 legacy\n${readFileSync(join(dir, 'fail-token-install.yml'), 'utf8')}`
    });
    const result = runChecks({
      root,
      profile,
      context: { defaultBranch: 'main', repository: 'example-org/example', today: '2026-11-16' }
    });
    assert.deepEqual(errors(result), ['exception/invalid', 'publisher/token-with-code']);
  });
});

suite('publish detection: explicit commands and one-level script lookup', () => {
  const tokenJob = (steps: string) =>
    `${PUSH}jobs:\n  release:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      contents: read\n    env:\n      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}\n    steps:\n${steps}`;

  test('lerna publish and bun publish are publish commands', () => {
    for (const command of ['npx lerna publish from-package --yes', 'bun publish']) {
      const text = tokenJob(`      - run: ${command}\n`);
      assert.deepEqual(errors(run({ files: { [WF]: text } })), [], command);
      const file = scanRepo({ root: tree({ [WF]: text }) }).files[0];
      assert.equal(file?.class, 'bespoke-publisher', command);
    }
  });

  test('a script alias whose body publishes is a publish, and the install makes it token-with-code', () => {
    const text = tokenJob('      - run: pnpm install && pnpm run release\n');
    const result = run({
      files: { [WF]: text, 'package.json': '{"scripts":{"release":"changeset publish"}}' }
    });
    assert.deepEqual(errors(result), ['publisher/token-with-code']);
  });

  test('a script alias in a workspace package directory is found', () => {
    const text = tokenJob('      - run: pnpm --filter pkg run release\n');
    const result = run({
      files: {
        [WF]: text,
        'package.json': '{"scripts":{}}',
        'packages/pkg/package.json': '{"scripts":{"release":"npm publish"}}'
      }
    });
    assert.equal(
      scanRepo({
        root: tree({
          [WF]: text,
          'packages/pkg/package.json': '{"scripts":{"release":"npm publish"}}'
        })
      }).files[0]?.class,
      'bespoke-publisher'
    );
    assert.deepEqual(errors(result), []);
  });

  test('the pnpm shorthand and a pre hook are read the same way', () => {
    const text = tokenJob('      - run: pnpm release\n');
    const direct = scanRepo({
      root: tree({ [WF]: text, 'package.json': '{"scripts":{"release":"yarn publish"}}' })
    });
    assert.equal(direct.files[0]?.class, 'bespoke-publisher');
    const hook = scanRepo({
      root: tree({
        [WF]: text,
        'package.json': '{"scripts":{"release":"echo x","prerelease":"npm publish"}}'
      })
    });
    assert.equal(hook.files[0]?.class, 'bespoke-publisher');
  });

  test('an unresolvable script in a token job is a notice, never a silent pass', () => {
    const text = tokenJob('      - run: pnpm install\n      - run: pnpm run release\n');
    const result = run({ files: { [WF]: text } });
    assert.deepEqual(errors(result), []);
    const found = notices(result).filter((f) => f.ruleId === 'publisher/unclassified-npm-token');
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /`release`/);
  });

  test('a script name is never enough: a script that does not publish is not a publish', () => {
    const text = `${PUSH}jobs:\n  docs:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm run docs:publish\n`;
    const result = run({
      files: { [WF]: text, 'package.json': '{"scripts":{"docs:publish":"wrangler pages deploy"}}' }
    });
    assert.deepEqual(errors(result), []);
    assert.deepEqual(
      notices(result).map((f) => f.ruleId),
      ['publisher/unclassified-id-token']
    );
  });

  test('a tool that has publish as a subcommand is not a package publish', () => {
    for (const command of [
      'pnpm exec wrangler publish',
      'npx wrangler publish',
      'wrangler publish'
    ]) {
      const text = `${PUSH}jobs:\n  docs:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: ${command}\n`;
      assert.deepEqual(errors(run({ files: { [WF]: text } })), [], command);
      assert.equal(scanRepo({ root: tree({ [WF]: text }) }).files[0]?.class, 'not-in-scope');
    }
  });

  test('a script alias is followed one level only', () => {
    const text = tokenJob('      - run: pnpm run release\n');
    const result = scanRepo({
      root: tree({
        [WF]: text,
        'package.json': '{"scripts":{"release":"pnpm run ship","ship":"npm publish"}}'
      })
    });
    assert.equal(result.files[0]?.class, 'not-in-scope');
  });

  test('a package.json that is not valid JSON counts as absent', () => {
    const text = tokenJob('      - run: pnpm run release\n');
    const result = run({ files: { [WF]: text, 'package.json': '{not json' } });
    assert.deepEqual(errors(result), []);
    assert.ok(notices(result).some((f) => f.ruleId === 'publisher/unclassified-npm-token'));
  });
});

suite('install and build detection', () => {
  test('ordinary forms are recognised', () => {
    for (const text of [
      'yarn',
      'CI=1 npm ci',
      'if true; then pnpm install; fi',
      'npx tsc',
      'make build',
      'node scripts/build.js',
      'pnpm exec tsc -b',
      'pnpm dlx some-tool',
      'FOO="a b" npm ci',
      'corepack pnpm install',
      'for d in a b; do pnpm build; done'
    ]) {
      assert.equal(runsRepositoryCode(text), true, text);
    }
  });

  test('publish commands and plain text are not repository code', () => {
    for (const text of [
      'npm publish',
      'pnpm exec changeset publish',
      'npx lerna publish from-package',
      'echo yarn',
      'yarn publish',
      'bun publish',
      'git tag v1'
    ]) {
      assert.equal(runsRepositoryCode(text), false, text);
    }
  });

  test('a token publisher whose install uses these forms fails token-with-code', () => {
    for (const command of [
      'yarn',
      'CI=1 npm ci',
      'if true; then pnpm install; fi',
      'npx tsc && make build && node scripts/build.js'
    ]) {
      const text = `${PUSH}jobs:\n  release:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      contents: read\n    env:\n      NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n    steps:\n      - run: |\n          ${command}\n          npm publish\n`;
      assert.deepEqual(
        errors(run({ files: { [WF]: text } })),
        ['publisher/token-with-code'],
        command
      );
    }
  });

  test('shell facts report the scripts a command runs and where', () => {
    const facts = analyzeShell({
      text: 'cd packages/a && pnpm --dir pkg run build',
      baseDirs: ['x']
    });
    assert.deepEqual(facts.scripts, [
      { name: 'build', dirs: ['pkg', 'packages/a', 'x'], wide: false }
    ]);
    assert.equal(facts.runsCode, true);
  });
});

suite('reference downgrade is pinned to three rule ids', () => {
  test('the downgrade set is exactly the three current ids', () => {
    assert.deepEqual([...REFERENCE_DOWNGRADE_RULES].sort(), [
      'publisher/environment',
      'publisher/id-token-with-code',
      'publisher/publishing-dispatch'
    ]);
  });

  test('any other publisher finding on the callee in the canonical repository stays an error', () => {
    const text = `name: release
on:
  pull_request_target:
  schedule:
    - cron: '0 0 * * *'
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          cache: npm
      - run: npm publish
`;
    const result = run({ files: { [CALLEE]: text }, repository: '0xPolygon/pipelines' });
    assert.deepEqual(errors(result), [
      'publisher/events',
      'publisher/no-cache',
      'publisher/pull-request-target'
    ]);
    const downgraded = notices(result).map((f) => f.ruleId);
    assert.ok(downgraded.includes('publisher/environment'));
  });
});

suite('a reviewed repository action running its own script is repository code', () => {
  const wf = `${PUSH}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      id-token: write\n    steps:\n      - uses: ./.github/actions/ship\n`;
  const action = (steps: string) => `runs:\n  using: composite\n  steps:\n${steps}`;
  const publish = '    - run: npm publish\n      shell: bash\n';
  const withAction = (steps: string): CheckResult =>
    run({ files: { [WF]: wf, '.github/actions/ship/action.yml': action(steps) } });
  const ownPath = `    - run: node "$ACTION_PATH/publish.mjs"\n      shell: bash\n      env:\n        ACTION_PATH: \${{ github.action_path }}\n${publish}`;

  test('node on its own action path is still code in a reviewed repository', () => {
    assert.deepEqual(errors(withAction(ownPath)), ['publisher/id-token-with-code']);
    for (const script of ['${{ github.action_path }}/x.mjs', '${GITHUB_ACTION_PATH}/x.mjs']) {
      const steps = `    - run: node ${script}\n      shell: bash\n${publish}`;
      assert.deepEqual(errors(withAction(steps)), ['publisher/id-token-with-code'], script);
    }
  });

  test('with an npm token the finding is token-with-code', () => {
    const text = `${PUSH}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      contents: read\n    env:\n      NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}\n    steps:\n      - uses: ./.github/actions/ship\n`;
    const result = run({
      files: { [WF]: text, '.github/actions/ship/action.yml': action(ownPath) }
    });
    assert.deepEqual(errors(result), ['publisher/token-with-code']);
  });

  test('node on a repository script is code', () => {
    const steps = `    - run: node scripts/build.js\n      shell: bash\n${publish}`;
    assert.deepEqual(errors(withAction(steps)), ['publisher/id-token-with-code']);
  });
});

suite('the shared release workflow runs its own action scripts', () => {
  const callee = `name: release\non:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      id-token: write\n    steps:\n      - uses: ./.pipelines/.github/actions/npm-publish-tarballs\n`;
  const action = (script: string) =>
    `runs:\n  using: composite\n  steps:\n    - run: node "${script}"\n      shell: bash\n      env:\n        ACTION_PATH: \${{ github.action_path }}\n`;
  const files = (script: string) => ({
    [CALLEE]: callee,
    '.github/actions/npm-publish-tarballs/action.yml': action(script)
  });

  test('in the canonical repository node on the action path is not code', () => {
    const result = run({
      files: files('$ACTION_PATH/publish-tarballs.mjs'),
      repository: '0xPolygon/pipelines'
    });
    assert.deepEqual(result.findings, []);
  });

  test('a script outside the action path is still code there', () => {
    const result = run({ files: files('scripts/x.js'), repository: '0xPolygon/pipelines' });
    assert.deepEqual(
      result.findings.map((f) => f.ruleId),
      ['publisher/id-token-with-code']
    );
  });

  test('another repository gets no exemption', () => {
    const result = run({
      files: files('$ACTION_PATH/publish-tarballs.mjs'),
      repository: 'example-org/pipelines'
    });
    assert.ok(errors(result).includes('publisher/unreadable-local-action'));
  });

  test('a control character in the text cannot pose as the action path', () => {
    assert.equal(
      analyzeShell({ text: 'node \u0001ACTIONPATH\u0001/x.js', actionPathVars: [] }).runsCode,
      true
    );
  });
});

suite('findings are reported once', () => {
  test('several steps using the same unreadable action give one finding', () => {
    const steps = '      - uses: ./tools/ship\n'.repeat(5);
    const text = `${PUSH}jobs:\n  ship:\n    runs-on: ubuntu-latest\n    environment: npm-publish\n    permissions:\n      id-token: write\n    steps:\n${steps}`;
    const found = run({ files: { [WF]: text } }).findings.filter(
      (f) => f.ruleId === 'publisher/unreadable-local-action'
    );
    assert.equal(found.length, 1);
  });
});
