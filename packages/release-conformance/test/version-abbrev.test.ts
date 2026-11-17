import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { scanRepo, textPublishHits } from '../src/repo-scan.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'versabbrev-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const quoted = (command: string): string => `'${command.replaceAll("'", "''")}'`;
/** A job with `id-token: write` that installs dependencies, then runs the command. */
const workflow = (command: string): string =>
  `on:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      id-token: write\n    steps:\n      - run: pnpm install\n      - run: ${quoted(command)}\n`;
const classOf = (command: string): string | undefined =>
  scanRepo({ root: tree({ [WF]: workflow(command) }) }).files[0]?.class;
const errorIds = (command: string): string[] => {
  const result: CheckResult = runChecks({
    root: tree({ [WF]: workflow(command) }),
    profile,
    context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
  });
  // The runner rules have their own tests; these probe the publish rules.
  return [
    ...new Set(
      result.findings
        .filter((f) => f.severity === 'error' && !f.ruleId.startsWith('runner/'))
        .map((f) => f.ruleId)
    )
  ];
};

void describe('a tool named with a version or tag is still the tool', () => {
  for (const command of [
    'npx -y npm@latest publish --provenance',
    'npx npm@11 publish',
    'pnpm dlx npm@11 publish',
    'yarn dlx -q npm@11 publish',
    'corepack pnpm@9 publish',
    'npx pnpm@9 -r publish',
    'npx corepack pnpm@9 publish',
    'npx @changesets/cli@3 publish',
    'pnpm dlx @changesets/cli@3 publish'
  ]) {
    void it(`is a publisher with code in the job: ${command}`, () => {
      assert.equal(classOf(command), 'bespoke-publisher');
      assert.deepEqual(errorIds(command), ['publisher/id-token-with-code']);
      assert.equal(analyzeShell({ text: command }).publishes, true);
      assert.equal(textPublishHits(command).confirmed, true);
    });
  }

  void it('a versioned name that does not publish stays out of scope', () => {
    for (const command of ['npx npm@11 install', 'npx prettier@3 --check .']) {
      assert.equal(classOf(command), 'not-in-scope', command);
    }
  });
});

void describe('npm accepts the prefixes that resolve to publish, and only npm', () => {
  for (const word of ['pu', 'pub', 'publ', 'publi', 'publis']) {
    void it(`npm ${word} publishes`, () => {
      const command = `npm ${word} --provenance`;
      assert.equal(classOf(command), 'bespoke-publisher');
      assert.equal(analyzeShell({ text: command }).publishes, true);
      assert.equal(textPublishHits(command).confirmed, true);
    });
  }

  void it('npm p is ambiguous and not a publish', () => {
    assert.equal(classOf('npm p'), 'not-in-scope');
  });

  void it('other managers get no prefixes', () => {
    for (const command of ['pnpm pub', 'yarn pub', 'bun pub', 'pnpm pu']) {
      assert.equal(analyzeShell({ text: command }).publishes, false, command);
      assert.equal(textPublishHits(command).confirmed, false, command);
    }
  });

  void it('a script or package that merely starts with the letters is not a publish', () => {
    for (const command of ['npm run pub', 'npm install pub', 'npm view publish-please']) {
      assert.equal(classOf(command), 'not-in-scope', command);
    }
  });
});

void describe('an arrow in printed text is not a redirect', () => {
  const printedOnly = (command: string) => {
    const hits = textPublishHits(command);
    assert.deepEqual(
      { confirmed: hits.confirmed, printed: hits.printed },
      { confirmed: false, printed: true },
      command
    );
  };

  for (const command of [
    'echo "=> skipping npm publish"',
    'echo ">>> npm publish is done by the release workflow"',
    'echo "build -> npm publish (later)"',
    "echo '=> npm publish' >&2"
  ]) {
    void it(`stays a waivable possible publish: ${command}`, () => printedOnly(command));
  }

  void it('a redirect outside quotes still makes the text a command', () => {
    for (const command of [
      'echo "npm publish --provenance" > p.sh',
      'echo "npm publish" >> p.sh',
      'echo "npm publish" &> p.sh',
      'echo "npm publish" > >(sh)',
      'echo "=> npm publish" > p.sh',
      'echo "npm publish"> p.sh',
      'printf "npm publish\\n" | sh'
    ]) {
      const hits = textPublishHits(command);
      assert.equal(hits.confirmed, true, command);
    }
  });
});

void describe('names that only contain publish are not flagged', () => {
  void it('the reviewer controls stay out of scope', () => {
    for (const command of [
      'npm version "$V" -m "publish %s"',
      'npm install --save-dev publish-please',
      'npm run build -- --target publish',
      'pnpm -r --if-present run prepublishOnly'
    ]) {
      assert.equal(classOf(command), 'not-in-scope', command);
    }
  });
});
