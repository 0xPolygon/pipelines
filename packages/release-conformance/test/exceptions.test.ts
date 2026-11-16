import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import type { Finding, ScannedFile } from '../src/types.ts';

import {
  applyExceptions,
  EXCEPTION_MARKER,
  NEVER_WAIVABLE_RULE_IDS,
  WAIVABLE_RULE_IDS
} from '../src/exceptions.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const TODAY = '2026-11-16';
const dir = join(import.meta.dirname, 'fixtures', 'exceptions');

const scanned = ({ file, text }: { file: string; text: string }): ScannedFile => ({
  model: parseWorkflow({ file, text }),
  class: 'not-in-scope',
  jobs: [],
  entryEvents: [],
  localCallers: []
});
const fromFixture = (name: string): ScannedFile =>
  scanned({ file: `.github/workflows/${name}`, text: readFileSync(join(dir, name), 'utf8') });
const inline = (marker: string): ScannedFile =>
  scanned({
    file: '.github/workflows/inline.yml',
    text: `# ${marker}\nname: x\non: push\njobs: {}\n`
  });

const finding = ({ ruleId, file }: { ruleId: string; file: string }): Finding => ({
  ruleId,
  file,
  line: 5,
  message: 'finding',
  severity: 'error'
});
const marker = (rest: string): string => `${EXCEPTION_MARKER}: ${rest}`;
const run = ({ files, findings }: { files: ScannedFile[]; findings: Finding[] }) =>
  applyExceptions({ files, findings, today: TODAY });
const invalidCount = (findings: Finding[]): number =>
  findings.filter((f) => f.ruleId === 'exception/invalid').length;

suite('exception markers', () => {
  test('a valid marker suppresses its rule in its own file and is reported', () => {
    const file = fromFixture('marker-valid.yml');
    const target = finding({ ruleId: 'publisher/no-cache', file: file.model.file });
    const result = run({ files: [file], findings: [target] });
    assert.deepEqual(result.findings, []);
    assert.equal(result.exceptions.length, 1);
    assert.equal(result.exceptions[0]?.until, '2027-01-31');
    assert.equal(result.exceptions[0]?.line, 1);
  });

  test('a marker suppresses only its own rule', () => {
    const file = fromFixture('marker-valid.yml');
    const other = finding({ ruleId: 'publisher/environment', file: file.model.file });
    const result = run({
      files: [file],
      findings: [finding({ ruleId: 'publisher/no-cache', file: file.model.file }), other]
    });
    assert.deepEqual(result.findings, [other]);
  });

  test('a marker does not suppress the same rule in another file', () => {
    const file = fromFixture('marker-valid.yml');
    const elsewhere = finding({
      ruleId: 'publisher/no-cache',
      file: '.github/workflows/other.yml'
    });
    const result = run({ files: [file], findings: [elsewhere] });
    assert.ok(result.findings.includes(elsewhere));
  });

  test('two markers for two rules in one file both apply', () => {
    const file = fromFixture('markers-two-rules.yml');
    const result = run({
      files: [file],
      findings: [
        finding({ ruleId: 'publisher/no-cache', file: file.model.file }),
        finding({ ruleId: 'publisher/environment', file: file.model.file })
      ]
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.exceptions.length, 2);
  });

  test('a marker inside a run block or quoted string is not a comment', () => {
    const file = fromFixture('marker-in-run-block.yml');
    const target = finding({ ruleId: 'publisher/no-cache', file: file.model.file });
    const result = run({ files: [file], findings: [target] });
    assert.deepEqual(result.findings, [target]);
    assert.deepEqual(result.exceptions, []);
  });

  test('expiry includes the end date and fails the day after', () => {
    const target = (f: ScannedFile) =>
      finding({ ruleId: 'publisher/no-cache', file: f.model.file });
    const onDay = inline(marker(`publisher/no-cache until ${TODAY} reason`));
    assert.equal(run({ files: [onDay], findings: [target(onDay)] }).exceptions.length, 1);
    const dayAfter = inline(marker('publisher/no-cache until 2026-11-15 reason'));
    const result = run({ files: [dayAfter], findings: [target(dayAfter)] });
    assert.equal(invalidCount(result.findings), 1);
    assert.equal(result.findings.filter((f) => f.ruleId === 'publisher/no-cache').length, 1);
    assert.deepEqual(result.exceptions, []);
  });

  test('366 days ahead passes and 367 fails', () => {
    const ok = inline(marker('publisher/no-cache until 2027-11-17 reason'));
    const tooFar = inline(marker('publisher/no-cache until 2027-11-18 reason'));
    const f = (s: ScannedFile) => [finding({ ruleId: 'publisher/no-cache', file: s.model.file })];
    assert.equal(run({ files: [ok], findings: f(ok) }).exceptions.length, 1);
    assert.equal(invalidCount(run({ files: [tooFar], findings: f(tooFar) }).findings), 1);
  });

  test('an unknown rule id, a missing reason, a malformed date and an impossible date are invalid', () => {
    const bad = [
      marker('publisher/nope until 2027-01-31 reason'),
      marker('publisher/no-cache until 2027-01-31'),
      marker('publisher/no-cache until 2027-1-31 reason'),
      marker('publisher/no-cache until 2027-02-30 reason'),
      marker('publisher/no-cache 2027-01-31 reason'),
      marker('')
    ];
    for (const text of bad) {
      const file = inline(text);
      const target = finding({ ruleId: 'publisher/no-cache', file: file.model.file });
      const result = run({ files: [file], findings: [target] });
      assert.equal(invalidCount(result.findings), 1, text);
      assert.ok(result.findings.includes(target), text);
      assert.deepEqual(result.exceptions, [], text);
    }
  });

  test('an invalid marker reports the line it is on', () => {
    const file = scanned({
      file: '.github/workflows/lines.yml',
      text: `name: x\non: push\n# ${marker('publisher/nope until 2027-01-31 reason')}\njobs: {}\n`
    });
    const [invalid] = run({ files: [file], findings: [] }).findings;
    assert.equal(invalid?.line, 3);
  });

  test('a marker for a rule with no finding is a notice, not a failure', () => {
    const file = fromFixture('marker-valid.yml');
    const result = run({ files: [file], findings: [] });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.ruleId, 'exception/unused');
    assert.equal(result.findings[0]?.severity, 'notice');
    assert.deepEqual(result.exceptions, []);
  });

  test('a rule that cannot be waived ignores the marker and reports it refused', () => {
    const file = fromFixture('marker-never-waivable.yml');
    const target = finding({ ruleId: 'publisher/publishing-dispatch', file: file.model.file });
    const result = run({ files: [file], findings: [target] });
    assert.ok(result.findings.includes(target));
    assert.deepEqual(result.exceptions, []);
    const refusal = result.findings.find((f) => f.ruleId === 'exception/invalid');
    assert.match(refusal?.message ?? '', /refused/);
    assert.equal(refusal?.severity, 'error');
  });

  test('every rule that cannot be waived is refused', () => {
    for (const ruleId of NEVER_WAIVABLE_RULE_IDS) {
      const file = inline(marker(`${ruleId} until 2027-01-31 reason`));
      const target = finding({ ruleId, file: file.model.file });
      const result = run({ files: [file], findings: [target] });
      assert.ok(result.findings.includes(target), ruleId);
      assert.equal(invalidCount(result.findings), 1, ruleId);
    }
  });

  test('caller/events can be waived', () => {
    const file = inline(marker('caller/events until 2027-01-31 reason'));
    const target = finding({ ruleId: 'caller/events', file: file.model.file });
    const result = run({ files: [file], findings: [target] });
    assert.deepEqual(result.findings, []);
    assert.equal(result.exceptions.length, 1);
  });

  test('the rest of the rules can be waived', () => {
    const waivable = WAIVABLE_RULE_IDS.filter((id) => !NEVER_WAIVABLE_RULE_IDS.includes(id));
    assert.ok(waivable.length > 0);
    for (const ruleId of waivable) {
      const file = inline(marker(`${ruleId} until 2027-01-31 reason`));
      const result = run({ files: [file], findings: [finding({ ruleId, file: file.model.file })] });
      assert.deepEqual(result.findings, [], ruleId);
    }
  });

  test('an expired marker is reported even in a file with no findings', () => {
    const file = inline(marker('publisher/no-cache until 2020-01-01 reason'));
    assert.equal(invalidCount(run({ files: [file], findings: [] }).findings), 1);
  });
});
