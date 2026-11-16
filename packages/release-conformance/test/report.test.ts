import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { CheckResult } from '../src/types.ts';

import {
  escapeCommandData,
  escapeCommandProperty,
  escapeMarkdown,
  formatAnnotations,
  formatJson,
  formatSummary
} from '../src/report.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

/** A value crafted to end its own command and start a second one. */
const INJECTED_NAME = 'a.yml,line=1::error title=forged::forged message\n::error::second';
const INJECTED_REASON = 'ok%0A::error::forged\r\n::warning::second';

const base: CheckResult = { findings: [], exceptions: [], notInScope: [] };

const commandLines = (lines: string[]): string[] =>
  lines.flatMap((line) => line.split(/\r\n|\r|\n/)).filter((line) => line.startsWith('::'));

suite('workflow command escaping', () => {
  test('data escapes percent, carriage return and line feed', () => {
    assert.equal(escapeCommandData('a%b\r\nc'), 'a%25b%0D%0Ac');
  });

  test('properties also escape colon and comma', () => {
    assert.equal(escapeCommandProperty('a:b,c%'), 'a%3Ab%2Cc%25');
  });

  test('a crafted file name yields exactly one command per finding', () => {
    const lines = formatAnnotations({
      result: {
        ...base,
        findings: [
          {
            ruleId: 'caller/events',
            file: INJECTED_NAME,
            line: 3,
            message: 'Unexpected event.',
            severity: 'error'
          },
          {
            ruleId: 'caller/inputs',
            file: 'b.yml',
            line: 4,
            message: 'Unexpected input.',
            severity: 'notice'
          }
        ]
      }
    });
    assert.equal(lines.length, 2);
    assert.equal(commandLines(lines).length, 2);
    for (const line of lines) assert.ok(!/[\r\n]/.test(line), 'a command is one physical line');
    assert.ok(
      lines[0]?.startsWith(
        '::error file=a.yml%2Cline=1%3A%3Aerror title=forged%3A%3Aforged message%0A%3A%3Aerror%3A%3Asecond,line=3,title=caller/events::'
      )
    );
    assert.ok(lines[1]?.startsWith('::notice file=b.yml,line=4,title=caller/inputs::'));
  });

  test('a crafted message cannot start a second command', () => {
    const lines = formatAnnotations({
      result: {
        ...base,
        findings: [
          {
            ruleId: 'x/y',
            file: 'a.yml',
            line: 1,
            message: 'first\n::add-mask::secret\r::error::again',
            severity: 'error'
          }
        ]
      }
    });
    assert.equal(commandLines(lines).length, 1);
    assert.ok(lines[0]?.endsWith('::first%0A::add-mask::secret%0D::error::again'));
  });

  test('a crafted exception reason yields exactly one notice', () => {
    const lines = formatAnnotations({
      result: {
        ...base,
        exceptions: [
          {
            ruleId: 'caller/events',
            file: INJECTED_NAME,
            until: '2027-01-01',
            reason: INJECTED_REASON,
            line: 2
          }
        ]
      }
    });
    assert.equal(lines.length, 1);
    assert.equal(commandLines(lines).length, 1);
    assert.ok(lines[0]?.startsWith('::notice file='));
    assert.ok(lines[0]?.includes('until 2027-01-01'));
    assert.ok(lines[0]?.includes('ok%250A'));
  });

  test('a line number below one is reported as line one', () => {
    const [line] = formatAnnotations({
      result: {
        ...base,
        findings: [{ ruleId: 'x/y', file: 'a.yml', line: 0, message: 'm', severity: 'error' }]
      }
    });
    assert.ok(line?.includes('line=1,'));
  });
});

suite('job summary', () => {
  test('markdown cells cannot break out of their table row', () => {
    const cell = escapeMarkdown('a|b\n<img src=x onerror=1>[l](http://x)`c`');
    assert.ok(!cell.includes('\n'));
    assert.ok(!cell.includes('<'));
    assert.ok(!/(^|[^\\])\|/.test(cell));
    assert.ok(!/(^|[^\\])\[/.test(cell));
  });

  test('a crafted file name and reason keep every table row on one line', () => {
    const summary = formatSummary({
      result: {
        findings: [
          {
            ruleId: 'caller/events',
            file: INJECTED_NAME,
            line: 2,
            message: 'bad | <b>x</b>',
            severity: 'error'
          }
        ],
        exceptions: [
          {
            ruleId: 'caller/inputs',
            file: 'c.yml',
            until: '2027-01-01',
            reason: '| forged | row |\n# heading',
            line: 5
          }
        ],
        notInScope: ['d.yml\n# heading']
      },
      inScope: [{ file: INJECTED_NAME, class: 'shared-caller' }]
    });
    const rows = summary.split('\n').filter((line) => line.startsWith('|'));
    // Each table: header, divider, then one row per entry (files, findings, exceptions).
    assert.equal(rows.length, 9, 'one row per entry and no injected rows');
    assert.ok(!/^# /m.test(summary), 'no injected heading');
    assert.ok(!summary.includes('<b>'));
  });

  test('lists the active exceptions with their end dates and the files not in scope', () => {
    const summary = formatSummary({
      result: {
        findings: [],
        exceptions: [
          { ruleId: 'caller/inputs', file: 'c.yml', until: '2027-01-01', reason: 'later', line: 1 }
        ],
        notInScope: ['ci.yml']
      },
      inScope: [{ file: 'release.yml', class: 'bespoke-publisher' }]
    });
    assert.ok(summary.includes('2027-01-01'));
    assert.ok(summary.includes('bespoke publisher'));
    assert.ok(summary.includes('- ci.yml'));
    assert.ok(summary.includes('No errors.'));
  });

  test('says so when nothing is in scope', () => {
    assert.ok(formatSummary({ result: base, inScope: [] }).includes('Nothing in scope'));
  });
});

suite('JSON document', () => {
  test('carries findings, exceptions and the counts with raw values', () => {
    const doc: unknown = JSON.parse(
      formatJson({
        result: {
          findings: [
            { ruleId: 'x/y', file: INJECTED_NAME, line: 2, message: 'm', severity: 'error' },
            { ruleId: 'x/z', file: 'a.yml', line: 2, message: 'm', severity: 'notice' }
          ],
          exceptions: [],
          notInScope: ['ci.yml']
        },
        inScope: [],
        context: { repository: 'example-org/example', defaultBranch: 'main', today: '2026-11-16' }
      })
    );
    assert.ok(typeof doc === 'object' && doc !== null);
    assert.ok('errorCount' in doc && doc.errorCount === 1);
    assert.ok('findings' in doc && Array.isArray(doc.findings) && doc.findings.length === 2);
    assert.ok('notInScope' in doc && Array.isArray(doc.notInScope));
    const [first] = 'findings' in doc && Array.isArray(doc.findings) ? doc.findings : [];
    assert.ok(typeof first === 'object' && first !== null && 'file' in first);
    assert.equal(first.file, INJECTED_NAME);
  });
});
