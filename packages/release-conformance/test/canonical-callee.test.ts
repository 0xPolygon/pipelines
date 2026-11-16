import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { CheckResult, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { formatAnnotations } from '../src/report.ts';
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

/** A tree holding one publisher that violates publisher rules, at `target`. */
const treeWithPublisherAt = (target: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'callee-'));
  scratch.push(root);
  const destination = join(root, target);
  mkdirSync(join(destination, '..'), { recursive: true });
  cpSync(join(fixtures, 'bespoke-publisher', 'fail-dispatch.yml'), destination);
  return root;
};

const check = ({ target, repository }: { target: string; repository: string }): CheckResult =>
  runChecks({
    root: treeWithPublisherAt(target),
    profile,
    context: { defaultBranch: 'main', repository, today: '2026-11-16' }
  });

const publisherFindings = (result: CheckResult): Finding[] =>
  result.findings.filter((f) => f.ruleId.startsWith('publisher/'));

suite('canonical callee reference', () => {
  test('the same path in another repository is not excluded', () => {
    const findings = publisherFindings(
      check({ target: CALLEE, repository: 'example-org/pipelines' })
    );
    assert.ok(findings.length > 0, 'fixture must produce publisher findings');
    assert.ok(findings.every((f) => f.severity === 'error'));
  });

  test('a fork named like the canonical repository by case or suffix is not excluded', () => {
    for (const repository of ['0xpolygon/pipelines', '0xPolygon/pipelines-fork', 'unknown']) {
      const findings = publisherFindings(check({ target: CALLEE, repository }));
      assert.ok(findings.length > 0 && findings.every((f) => f.severity === 'error'), repository);
    }
  });

  test('on the canonical repository the callee findings are notices that stay visible', () => {
    const result = check({ target: CALLEE, repository: '0xPolygon/pipelines' });
    const findings = publisherFindings(result);
    assert.ok(findings.length > 0, 'findings must remain in the result');
    assert.ok(findings.every((f) => f.severity === 'notice'));
    const lines = formatAnnotations({ result });
    assert.ok(lines.some((line) => line.startsWith('::notice file=' + CALLEE)));
    assert.ok(!lines.some((line) => line.startsWith('::error')));
  });

  test('a differently located or named file in the canonical repository is not excluded', () => {
    for (const target of [
      '.github/workflows/apps-npm-release.yaml',
      '.github/workflows/other-apps-npm-release.yml'
    ]) {
      const findings = publisherFindings(check({ target, repository: '0xPolygon/pipelines' }));
      assert.ok(findings.length > 0 && findings.every((f) => f.severity === 'error'), target);
    }
  });

  test('only publisher findings are downgraded; other findings match a non-canonical run', () => {
    const canonical = check({ target: CALLEE, repository: '0xPolygon/pipelines' });
    const copy = check({ target: CALLEE, repository: 'example-org/pipelines' });
    const nonPublisher = (result: CheckResult) =>
      result.findings.filter((f) => !f.ruleId.startsWith('publisher/'));
    assert.deepEqual(nonPublisher(canonical), nonPublisher(copy));
    assert.equal(publisherFindings(canonical).length, publisherFindings(copy).length);
  });

  test('a non-publisher error on the callee file stays an error on the canonical repository', () => {
    const root = mkdtempSync(join(tmpdir(), 'callee-'));
    scratch.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    writeFileSync(join(root, CALLEE), 'run: npm publish\nbroken: [unclosed\n');
    const result = runChecks({
      root,
      profile,
      context: { defaultBranch: 'main', repository: '0xPolygon/pipelines', today: '2026-11-16' }
    });
    const unparseable = result.findings.filter((f) => f.ruleId === 'workflow/unparseable');
    assert.equal(unparseable.length, 1);
    assert.equal(unparseable[0]?.severity, 'error');
  });
});
