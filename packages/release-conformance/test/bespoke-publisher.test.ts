import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Finding, Profile, RuleContext, ScannedFile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { scanRepo } from '../src/repo-scan.ts';
import {
  PUBLISHER_NEVER_WAIVABLE_RULES,
  PUBLISHER_WAIVABLE_RULES,
  checkBespokePublisher,
  checkUnclassifiedJobs,
  runsRepositoryCode
} from '../src/rules/bespoke-publisher.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const dir = join(fixtures, 'bespoke-publisher');

const scratch: string[] = [];
after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});

const context: RuleContext = {
  defaultBranch: 'main',
  repository: 'example-org/example',
  today: '2026-11-15'
};

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

const scanFlat = (name: string): ScannedFile => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-'));
  scratch.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  cpSync(join(dir, name), join(root, '.github/workflows', name));
  const [file] = scanRepo({ root }).files;
  assert.ok(file, 'scan returned no file');
  return file;
};

const run = (file: ScannedFile): Finding[] =>
  checkBespokePublisher({ model: file.model, scan: file, profile, context });

/** Findings of a flat fixture that must classify as a bespoke publisher. */
const check = (name: string): Finding[] => {
  const file = scanFlat(name);
  assert.equal(file.class, 'bespoke-publisher', `${name} classifies as ${file.class}`);
  return run(file);
};

const errorRules = (findings: Finding[]): string[] =>
  findings.filter((f) => f.severity === 'error').map((f) => f.ruleId);

/** Asserts the fixture trips exactly one rule id (possibly more than once). */
const failsOnly = (name: string, ruleId: string): void => {
  const rules = [...new Set(errorRules(check(name)))];
  assert.deepEqual(rules, [ruleId], `${name}: ${rules.join(', ')}`);
};

const checkRepoPublisher = (repo: string, file: string): Finding[] => {
  const scan = scanRepo({ root: join(dir, 'repos', repo) });
  const found = scan.files.find((candidate) => candidate.model.file.endsWith(file));
  assert.ok(found, `${file} not scanned`);
  assert.equal(found.class, 'bespoke-publisher');
  return run(found);
};

suite('pass cases', () => {
  test('a split workflow started by a push to the default branch conforms', () => {
    assert.deepEqual(check('pass-split.yml'), []);
  });

  test('a release published event conforms', () => {
    assert.deepEqual(check('pass-release.yml'), []);
  });

  test('a local reusable publisher called from a conforming trigger conforms', () => {
    assert.deepEqual(checkRepoPublisher('reusable-ok', 'publish.yml'), []);
  });
});

suite('publisher/split and credential-with-code', () => {
  test('install and publish in one job', () => {
    failsOnly('fail-install-publish.yml', 'publisher/id-token-with-code');
  });

  test('a token publisher with an install in the same job has its own never-waivable id', () => {
    failsOnly('fail-token-install.yml', 'publisher/token-with-code');
  });

  test('workflow-level credential with more than one job', () => {
    failsOnly('fail-toplevel-credential.yml', 'publisher/split');
  });

  test('a publishing job holding another write scope', () => {
    failsOnly('fail-extra-write.yml', 'publisher/split');
  });

  test('a publishing job with no permissions block', () => {
    failsOnly('fail-no-permissions.yml', 'publisher/split');
  });

  test('recognises install, build, test and lint commands', () => {
    for (const text of [
      'pnpm install',
      'npm ci',
      'yarn add x',
      'pnpm -r install',
      'pnpm --filter pkg build',
      'npm run build',
      'npm run lint:ts',
      'pnpm test',
      'npm run prepublishOnly',
      'echo hi && yarn install'
    ])
      assert.equal(runsRepositoryCode(text), true, text);
    for (const text of ['npm publish', 'echo pnpm install', 'pnpm publish -r', 'npm run release'])
      assert.equal(runsRepositoryCode(text), false, text);
  });
});

suite('publisher/no-cache', () => {
  test('cache input on a setup step', () => {
    failsOnly('fail-cache-setup.yml', 'publisher/no-cache');
  });

  test('cache action in a sibling job', () => {
    failsOnly('fail-cache-action.yml', 'publisher/no-cache');
  });
});

suite('publisher/environment', () => {
  test('no environment', () => {
    failsOnly('fail-no-environment.yml', 'publisher/environment');
  });

  test('environment given as an expression', () => {
    failsOnly('fail-env-expression.yml', 'publisher/environment');
    assert.match(check('fail-env-expression.yml')[0]?.message ?? '', /not an expression/);
  });

  test('stage-only publishing does not satisfy the environment rule', () => {
    failsOnly('fail-stage-publish.yml', 'publisher/environment');
  });
});

suite('publisher/events', () => {
  test('push with tags', () => {
    failsOnly('fail-tag-push.yml', 'publisher/events');
  });

  test('push to a branch other than the default', () => {
    failsOnly('fail-other-branch.yml', 'publisher/events');
  });

  test('release with types other than published', () => {
    failsOnly('fail-release-types.yml', 'publisher/events');
  });

  test('release with published plus another type', () => {
    failsOnly('fail-release-types-extra.yml', 'publisher/events');
  });

  test('schedule', () => {
    failsOnly('fail-schedule.yml', 'publisher/events');
  });

  test('workflow_run', () => {
    failsOnly('fail-workflow-run.yml', 'publisher/events');
  });

  test('workflow_dispatch has its own rule id', () => {
    failsOnly('fail-dispatch.yml', 'publisher/publishing-dispatch');
  });

  test('pull_request_target is a never-waivable rule', () => {
    failsOnly('fail-pull-request-target.yml', 'publisher/pull-request-target');
  });

  test('a local caller that adds workflow_dispatch fails the reusable publisher', () => {
    const findings = checkRepoPublisher('reusable-dispatch', 'publish.yml');
    assert.deepEqual([...new Set(errorRules(findings))], ['publisher/publishing-dispatch']);
    assert.match(findings[0]?.message ?? '', /calling workflow/);
  });

  test('the never-waivable rule ids are exported for the exception logic', () => {
    assert.deepEqual([...PUBLISHER_NEVER_WAIVABLE_RULES].sort(), [
      'publisher/id-token-with-code',
      'publisher/pull-request-target',
      'publisher/token-with-code'
    ]);
    assert.ok(PUBLISHER_WAIVABLE_RULES.includes('publisher/publishing-dispatch'));
  });
});

suite('unclassified id-token notice', () => {
  test('a job holding id-token outside any recognised class gets a notice', () => {
    const file = scanFlat('unclassified-id-token.yml');
    assert.equal(file.class, 'not-in-scope');
    const findings = checkUnclassifiedJobs({
      model: file.model,
      scan: file,
      profile,
      context
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, 'notice');
    assert.match(findings[0]?.message ?? '', /`deploy`/);
  });

  test('a non-publishing job holding id-token in a publisher file gets a notice, not an error', () => {
    const findings = check('pass-split.yml');
    assert.deepEqual(findings, []);
    const file = scanFlat('fail-toplevel-credential.yml');
    const notices = run(file).filter((f) => f.severity === 'notice');
    assert.deepEqual(
      notices.map((f) => f.ruleId),
      ['publisher/unclassified-id-token']
    );
  });
});
