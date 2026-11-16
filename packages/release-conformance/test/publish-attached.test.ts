import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { scanRepo, textPublishHits } from '../src/repo-scan.ts';
import { analyzeShell, isPublishWord } from '../src/shell-commands.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'publish-attached-'));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
};
const errorIds = (result: CheckResult): string[] =>
  [...new Set(result.findings.filter((f) => f.severity === 'error').map((f) => f.ruleId))].sort();

/** An OIDC job that installs dependencies, then runs a multi-line block. */
const oidcJob = (block: string): string =>
  `on:\n  push:\n    branches: [main]\npermissions: {}\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    environment: npm\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: |\n${block
    .split('\n')
    .map((line) => `          ${line}`)
    .join('\n')}\n`;

const errorsFor = (block: string): string[] => {
  const root = tree({ [WF]: oidcJob(block) });
  return errorIds(
    runChecks({
      root,
      profile,
      context: { defaultBranch: 'main', repository: 'acme/widget', today: '2026-11-16' }
    })
  );
};
const classFor = (block: string): string | undefined =>
  scanRepo({ root: tree({ [WF]: oidcJob(block) }) }).files[0]?.class;

void describe('isPublishWord', () => {
  for (const word of [
    'publish',
    'publish>out.log',
    'publish<<<y',
    'publish;',
    'publish)',
    'publish\\n'
  ])
    void it(`accepts ${word}`, () => assert.equal(isPublishWord(word), true));
  for (const word of [
    'publishConfig',
    'publish-please',
    'publish:docs',
    'publish_x',
    'publish2',
    'unpublish'
  ])
    void it(`rejects ${word}`, () => assert.equal(isPublishWord(word), false));
});

void describe('X1: publish with something attached is still a publish', () => {
  const publishing = [
    'npm publish>out.log 2>&1',
    'pnpm publish>out.log',
    'pnpm -r publish>out.log',
    'npm publish<<<y',
    'npm publish)',
    '(npm publish)',
    'printf "npm publish\\n" | sh',
    'sh -c "npm publish>out.log"',
    'npm publish >out.log 2>&1',
    'npm publish 2>&1 | tee out.log',
    'pnpm changeset publish>out.log'
  ];
  for (const command of publishing) {
    void it(`is a publisher: ${command}`, () => {
      assert.equal(classFor(command), 'bespoke-publisher');
      assert.ok(errorsFor(command).includes('publisher/id-token-with-code'));
    });
  }
  for (const command of [
    'npm publish>out.log 2>&1',
    'pnpm publish>out.log',
    'pnpm -r publish>out.log',
    'npm publish<<<y'
  ]) {
    void it(`the parser alone sees it: ${command}`, () => {
      assert.equal(analyzeShell({ text: command }).publishes, true);
    });
  }
  void it('the text test alone sees a printed-then-piped publish', () => {
    assert.equal(textPublishHits('printf "npm publish\\n" | sh').confirmed, true);
  });
  for (const command of [
    'npm run publishConfig',
    'npm view publish-please',
    'pnpm publish:docs',
    'pnpm run publish-please',
    'npm explain publishConfig'
  ]) {
    void it(`stays not a publish: ${command}`, () => {
      assert.equal(textPublishHits(command).confirmed, false);
      assert.equal(analyzeShell({ text: command }).publishes, false);
    });
  }
});

void describe('X2: printed text whose output is redirected is confirmed', () => {
  for (const block of [
    'echo "npm publish --provenance" > p.sh && bash p.sh',
    'echo "npm publish --provenance" > p.sh\nbash p.sh',
    'printf "npm publish\\n" >> p.sh; sh p.sh',
    'echo npm publish > >(sh)',
    'echo "npm publish" | tee p.sh',
    'echo "npm publish" &> p.sh',
    'echo "npm publish" | tee -a "$GITHUB_STEP_SUMMARY"',
    'echo "npm publish" >> "$GITHUB_STEP_SUMMARY"'
  ]) {
    void it(`is not waivable: ${JSON.stringify(block)}`, () => {
      assert.equal(classFor(block), 'bespoke-publisher');
      assert.ok(errorsFor(block).includes('publisher/id-token-with-code'));
    });
  }
  for (const block of [
    'echo "skipping npm publish on this branch"',
    'echo "npm publish" >&2',
    'echo "npm publish" 2>&1'
  ]) {
    void it(`stays a waivable possible publish: ${JSON.stringify(block)}`, () => {
      assert.equal(classFor(block), 'not-in-scope');
      assert.deepEqual(errorsFor(block), ['publisher/possible-publish']);
    });
  }
});

void describe('X4: runs of flags, flag values and variables before publish stay confirmed', () => {
  for (const command of [
    'pnpm --workspace-concurrency 1 --use-node-version 22 publish',
    'pnpm $A $B publish',
    'pnpm ${A} ${B} publish',
    'pnpm --a 1 --b 2 --c 3 publish',
    'pnpm -r --workspace-concurrency 1 $FLAGS publish',
    'yarn --a 1 $B --c 3 publish'
  ]) {
    void it(`is a publisher: ${command}`, () => {
      assert.equal(textPublishHits(command).confirmed, true);
      assert.equal(classFor(command), 'bespoke-publisher');
    });
  }
  void it('a flag run with no publish at the end is not a hit', () => {
    assert.deepEqual(textPublishHits('pnpm --a 1 --b 2 build'), {
      confirmed: false,
      printed: false,
      unknownWord: []
    });
  });
  void it('stays linear on a long flag and value run', () => {
    const started = Date.now();
    const hits = textPublishHits('npm -a npm '.repeat(100000));
    assert.equal(hits.confirmed, false);
    assert.ok(Date.now() - started < 2000);
  });
});
