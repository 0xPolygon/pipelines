import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Finding, Profile, RuleContext } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { scanRepo } from '../src/repo-scan.ts';
import { checkSharedCaller } from '../src/rules/shared-caller.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

/** `node:test` registration returns a promise that runner bookkeeping owns; callers never await it. */
const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const callerDir = join(fixtures, 'shared-caller');

const loadProfile = (shape: 'pr1' | 'pr2' | 'pr3'): Profile => {
  const read = (name: string) =>
    parseWorkflow({
      file: name,
      text: readFileSync(join(fixtures, 'canonical', shape, name), 'utf8')
    });
  return deriveProfile({
    trigger: read('apps-npm-release-trigger.yml'),
    release: read('apps-npm-release.yml')
  });
};
const pr1 = loadProfile('pr1');
const pr2 = loadProfile('pr2');
const pr3 = loadProfile('pr3');

const context: RuleContext = {
  defaultBranch: 'main',
  repository: 'example-org/example',
  today: '2026-11-15'
};

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const runRule = ({
  dir,
  name,
  profile,
  ctx = context,
  defaultBranch
}: {
  dir: string;
  name: string;
  profile: Profile;
  ctx?: RuleContext;
  defaultBranch?: string;
}): Finding[] => {
  const root = mkdtempSync(join(tmpdir(), 'caller-'));
  scratch.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  cpSync(join(dir, name), join(root, '.github/workflows', name));
  const [file] = scanRepo({ root }).files;
  assert.ok(file, 'scan returned no file');
  assert.equal(file.class, 'shared-caller', `${name} must classify as a shared caller`);
  return checkSharedCaller({
    model: file.model,
    scan: file,
    profile,
    context: defaultBranch === undefined ? ctx : { ...ctx, defaultBranch }
  });
};

const ruleIds = (findings: Finding[]): string[] =>
  [...new Set(findings.map((f) => f.ruleId))].sort();

suite('passing callers', () => {
  const passes: { name: string; profile: Profile; defaultBranch?: string; label: string }[] = [
    { name: 'pass-canonical-shape.yml', profile: pr1, label: 'canonical shape against pr1' },
    { name: 'pass-canonical-shape.yml', profile: pr2, label: 'canonical shape against pr2' },
    {
      name: 'pass-master-branch.yml',
      profile: pr2,
      defaultBranch: 'master',
      label: 'default branch master'
    },
    { name: 'pass-no-dispatch.yml', profile: pr2, label: 'no workflow_dispatch' },
    { name: 'pass-paths-filter.yml', profile: pr2, label: 'narrower paths filter' },
    {
      name: 'pass-wrapper-extra-jobs.yml',
      profile: pr2,
      label: 'job-level permissions under an empty top level, extra read-only job'
    },
    {
      name: 'pass-extra-steps-job.yml',
      profile: pr2,
      label: 'extra job without publishing permission'
    },
    {
      name: 'pass-canonical-shape.yml',
      profile: pr1,
      label: 'attestations: write against the pr1 profile'
    }
  ];
  for (const { name, profile, defaultBranch, label } of passes) {
    test(`${label} (${name})`, () => {
      const options = { dir: callerDir, name, profile };
      const findings = runRule(
        defaultBranch === undefined ? options : { ...options, defaultBranch }
      );
      assert.deepEqual(findings, []);
    });
  }

  for (const shape of ['pr1', 'pr2'] as const) {
    test(`the canonical trigger of ${shape} passes in the checker's own repository`, () => {
      const findings = runRule({
        dir: join(fixtures, 'canonical', shape),
        name: 'apps-npm-release-trigger.yml',
        profile: shape === 'pr1' ? pr1 : pr2,
        ctx: { ...context, repository: '0xPolygon/pipelines' }
      });
      assert.deepEqual(findings, []);
    });
  }

  test('a caller without the attestations scope passes the pr1 profile', () => {
    assert.deepEqual(
      runRule({ dir: callerDir, name: 'fail-floor-missing-attestations.yml', profile: pr1 }),
      []
    );
  });
});

suite('failing callers: each fixture fails exactly the intended rule', () => {
  const fails: { name: string; rule: string; profile?: Profile }[] = [
    { name: 'fail-events-extra-input.yml', rule: 'caller/events' },
    { name: 'fail-events-pull-request-target.yml', rule: 'caller/pull-request-target' },
    { name: 'fail-events-push-tags.yml', rule: 'caller/events' },
    { name: 'fail-events-push-other-branch.yml', rule: 'caller/events' },
    { name: 'fail-events-push-two-branches.yml', rule: 'caller/events' },
    { name: 'fail-callee-ref-v1.yml', rule: 'caller/callee' },
    { name: 'fail-callee-ref-sha.yml', rule: 'caller/callee' },
    { name: 'fail-callee-ref-release.yml', rule: 'caller/callee' },
    { name: 'fail-callee-archived.yml', rule: 'caller/callee' },
    { name: 'fail-callee-local.yml', rule: 'caller/callee' },
    { name: 'fail-ceiling-write-all.yml', rule: 'caller/permissions-ceiling' },
    { name: 'fail-ceiling-no-block.yml', rule: 'caller/permissions-ceiling' },
    { name: 'fail-ceiling-packages-write.yml', rule: 'caller/permissions-ceiling' },
    { name: 'fail-floor-missing-attestations.yml', rule: 'caller/permissions-floor', profile: pr2 },
    { name: 'fail-scope-second-job-inherits.yml', rule: 'caller/publish-permission-scope' },
    { name: 'fail-scope-second-job-token.yml', rule: 'caller/publish-permission-scope' },
    { name: 'fail-secrets-inherit.yml', rule: 'caller/secrets-inherit' },
    { name: 'fail-secrets-extra.yml', rule: 'caller/secrets' },
    { name: 'fail-inputs-extra.yml', rule: 'caller/inputs' }
  ];
  for (const { name, rule, profile } of fails) {
    test(`${name} fails ${rule}`, () => {
      const findings = runRule({ dir: callerDir, name, profile: profile ?? pr2 });
      assert.deepEqual(ruleIds(findings), [rule]);
      for (const finding of findings) {
        assert.equal(finding.severity, 'error');
        assert.equal(finding.file, `.github/workflows/${name}`);
        assert.ok(finding.line >= 1, 'findings carry a line number');
      }
    });
  }

  test('a push with tags reports the tags requirement', () => {
    const findings = runRule({ dir: callerDir, name: 'fail-events-push-tags.yml', profile: pr2 });
    assert.ok(findings.some((f) => f.message.includes('tags')));
  });

  test('the message names the offending key', () => {
    const findings = runRule({ dir: callerDir, name: 'fail-inputs-extra.yml', profile: pr2 });
    assert.ok(findings[0]?.message.includes('extra_key'));
  });
});

suite('shared caller: allowed opt-in inputs', () => {
  for (const name of [
    'pass-opt-in-version-script-true.yml',
    'pass-opt-in-version-script-false.yml',
    'pass-opt-in-version-script-expression.yml'
  ]) {
    test(`${name} passes when the release workflow declares the input`, () => {
      assert.deepEqual(runRule({ dir: callerDir, name, profile: pr3 }), []);
    });
  }

  test('a non-boolean, non-expression value fails caller/inputs', () => {
    const findings = runRule({
      dir: callerDir,
      name: 'fail-opt-in-version-script-string.yml',
      profile: pr3
    });
    assert.deepEqual(ruleIds(findings), ['caller/inputs']);
    assert.ok(findings[0]?.message.includes('version_script'));
  });

  test('an unknown key still fails and the message lists the opt-ins', () => {
    const findings = runRule({ dir: callerDir, name: 'fail-inputs-unknown-key.yml', profile: pr3 });
    assert.deepEqual(ruleIds(findings), ['caller/inputs']);
    assert.ok(findings[0]?.message.includes('foo'));
    assert.ok(findings[0]?.message.includes('Allowed opt-ins: version_script'));
    assert.ok(findings[0]?.message.includes('snapshot_tag'));
  });

  test('the opt-in fails when the release workflow does not declare the input', () => {
    assert.deepEqual(pr2.optInWithKeys, []);
    const findings = runRule({
      dir: callerDir,
      name: 'pass-opt-in-version-script-true.yml',
      profile: pr2
    });
    assert.deepEqual(ruleIds(findings), ['caller/inputs']);
    assert.ok(findings[0]?.message.includes('version_script'));
  });
});
