import { strict as assert } from 'node:assert';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { FileClass, Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { normalizeShell, scanRepo, stripShellComments } from '../src/repo-scan.ts';
import { escapeMarkdown } from '../src/report.ts';
import { runsRepositoryCode } from '../src/rules/bespoke-publisher.ts';
import { parseUses, parseWorkflow, secretReferences } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const dir = join(fixtures, 'hardening');

const scratch: string[] = [];
after(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});
const tmp = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'hardening-'));
  scratch.push(path);
  mkdirSync(join(path, '.github/workflows'), { recursive: true });
  return path;
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

const check = ({ root, repository = 'acme/widget' }: { root: string; repository?: string }) =>
  runChecks({
    root,
    profile,
    context: { defaultBranch: 'main', repository, today: '2026-11-16' }
  });

const ruleIds = (findings: Finding[], severity: 'error' | 'notice' = 'error'): string[] =>
  [...new Set(findings.filter((f) => f.severity === severity).map((f) => f.ruleId))].sort();

/** One flat fixture copied into a scratch tree; returns the file's class and the run's findings. */
const runFixture = ({
  name,
  repository,
  from = dir
}: {
  name: string;
  repository?: string;
  from?: string;
}): { class: FileClass; findings: Finding[] } => {
  const root = tmp();
  cpSync(join(from, name), join(root, '.github/workflows/fixture.yml'));
  const [file] = scanRepo({ root, repository: repository ?? 'acme/widget' }).files;
  assert.ok(file, 'scan returned no file');
  return { class: file.class, findings: check({ root, repository }).findings };
};

suite('publishers are recognised in more workflow forms', () => {
  const publisher = ['publisher/environment', 'publisher/publishing-dispatch', 'publisher/split'];
  const cases: Array<{ name: string; class: FileClass; errors: string[] }> = [
    { name: 'workflow-env-token.yml', class: 'bespoke-publisher', errors: publisher },
    { name: 'run-text-token.yml', class: 'bespoke-publisher', errors: publisher },
    { name: 'bracket-secret.yml', class: 'bespoke-publisher', errors: publisher },
    { name: 'upper-case-secret.yml', class: 'bespoke-publisher', errors: publisher },
    { name: 'token-key-literal.yml', class: 'bespoke-publisher', errors: publisher },
    {
      name: 'hash-in-quotes.yml',
      class: 'bespoke-publisher',
      errors: [
        'publisher/environment',
        'publisher/id-token-with-code',
        'publisher/publishing-dispatch',
        'publisher/split'
      ]
    },
    {
      name: 'line-continuation.yml',
      class: 'bespoke-publisher',
      errors: ['publisher/environment', 'publisher/publishing-dispatch']
    },
    {
      name: 'changesets-action-case.yml',
      class: 'bespoke-publisher',
      errors: ['publisher/environment', 'publisher/id-token-with-code', 'publisher/split']
    },
    {
      name: 'tag-and-publish-script.yml',
      class: 'bespoke-publisher',
      errors: ['publisher/environment', 'publisher/split']
    }
  ];
  for (const expected of cases) {
    test(`${expected.name} is a publisher and is checked`, () => {
      const result = runFixture({ name: expected.name });
      assert.equal(result.class, expected.class);
      assert.deepEqual(ruleIds(result.findings), expected.errors);
    });
  }

  test('a workflow-level token in a shared caller is held by every job', () => {
    const result = runFixture({ name: 'workflow-env-token-caller.yml' });
    assert.equal(result.class, 'shared-caller');
    assert.deepEqual(ruleIds(result.findings), ['caller/publish-permission-scope']);
  });
});

suite('shell text is read the way the shell reads it', () => {
  test('a hash inside quotes does not start a comment', () => {
    assert.equal(
      normalizeShell('echo "Release #12" && npm publish'),
      'echo "Release #12" && npm publish'
    );
    assert.equal(runsRepositoryCode('echo "build #3"; pnpm install'), true);
    assert.equal(runsRepositoryCode("echo 'a #b' && npm ci"), true);
  });

  test('a hash that starts a word outside quotes still starts a comment', () => {
    assert.equal(stripShellComments('npm ci # npm publish').trim(), 'npm ci');
    assert.equal(stripShellComments('# npm publish\nnpm ci').trim(), 'npm ci');
    assert.equal(stripShellComments('echo a#b').trim(), 'echo a#b');
  });

  test('a quote inside a comment does not hide the next line', () => {
    assert.equal(stripShellComments("# it's here\nnpm publish").trim(), 'npm publish');
  });

  test('a backslash continuation is joined before matching', () => {
    assert.equal(normalizeShell('npm \\\n  publish'), 'npm    publish');
    assert.equal(runsRepositoryCode('pnpm \\\n  install'), true);
  });
});

suite('secret references', () => {
  test('dot, bracket and upper-case forms are all read', () => {
    assert.deepEqual(secretReferences('${{ secrets.NPM_TOKEN }}'), ['NPM_TOKEN']);
    assert.deepEqual(secretReferences("${{ secrets['NPM_TOKEN'] }}"), ['NPM_TOKEN']);
    assert.deepEqual(secretReferences('${{ secrets["NPM_TOKEN"] }}'), ['NPM_TOKEN']);
    assert.deepEqual(secretReferences('${{ SECRETS.NPM_TOKEN }}'), ['NPM_TOKEN']);
    assert.deepEqual(secretReferences('${{ github.token }}'), []);
  });
});

suite('owner and repository names are compared without case', () => {
  test('a call written in another case is still a call to the release workflow', () => {
    const result = runFixture({ name: 'callee-owner-case.yml' });
    assert.equal(result.class, 'shared-caller');
    assert.deepEqual(ruleIds(result.findings), [
      'caller/callee',
      'caller/permissions-ceiling',
      'caller/pull-request-target',
      'caller/secrets-inherit'
    ]);
  });

  test('the owner and repository are lower-cased and the raw text is kept', () => {
    const uses = parseUses('0xPolygon/Pipelines/.github/workflows/Apps-Npm-Release.yml@main');
    assert.equal(uses.owner, '0xpolygon');
    assert.equal(uses.repo, 'pipelines');
    assert.equal(uses.path, '.github/workflows/Apps-Npm-Release.yml');
    assert.ok(uses.raw.startsWith('0xPolygon/Pipelines'));
  });

  test('a changesets action written in another case is seen', () => {
    const result = runFixture({ name: 'changesets-action-case.yml' });
    assert.equal(result.class, 'bespoke-publisher');
  });

  test('a cache action written in another case is a cache', () => {
    const result = runFixture({ name: 'cache-action-case.yml' });
    assert.deepEqual(ruleIds(result.findings), ['publisher/no-cache']);
  });

  test('a repository that is only named pipelines does not silence the identity-token notice', () => {
    const result = runFixture({ name: 'pr-target-lookalike-owner.yml' });
    assert.deepEqual(ruleIds(result.findings, 'notice'), ['publisher/unclassified-id-token']);
  });
});

suite('a reusable publisher is followed to the workflows that start it', () => {
  test('a call that names this repository counts as a local caller', () => {
    const findings = check({ root: join(dir, 'repos/self-qualified-caller') }).findings;
    assert.deepEqual(
      findings
        .filter((f) => f.severity === 'error' && f.file.endsWith('publish.yml'))
        .map((f) => f.ruleId)
        .sort(),
      ['publisher/publishing-dispatch', 'publisher/pull-request-target']
    );
  });

  test('a call that names another repository does not', () => {
    const findings = check({
      root: join(dir, 'repos/self-qualified-caller'),
      repository: 'acme/other'
    }).findings;
    assert.ok(!findings.some((f) => f.ruleId === 'publisher/pull-request-target'));
  });

  test('a reusable publisher with no caller here cannot be checked and is an error', () => {
    const findings = check({ root: join(dir, 'repos/reusable-no-caller') }).findings;
    assert.deepEqual(ruleIds(findings), ['publisher/events']);
  });
});

suite('files that cannot be read are never a pass', () => {
  test('a workflow file over the size limit is an error even when it only mentions a trigger', () => {
    const root = tmp();
    const body = 'on:\n  pull_request_target:\n# padding\n' + '#' + 'x'.repeat(1_100_000) + '\n';
    writeFileSync(join(root, '.github/workflows/big.yml'), body);
    const findings = check({ root }).findings;
    assert.deepEqual(ruleIds(findings), ['workflow/unparseable']);
  });

  test('a symlinked workflow file is reported and its target is not read', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'secret.yml'), 'TOP_SECRET_LINE: [unterminated\n');
    symlinkSync(join(outside, 'secret.yml'), join(root, '.github/workflows/link.yml'));
    const findings = check({ root }).findings;
    assert.deepEqual(ruleIds(findings), ['workflow/unparseable']);
    assert.ok(!findings.some((f) => f.message.includes('TOP_SECRET_LINE')));
  });

  test('a parse error does not quote the source line', () => {
    const root = tmp();
    writeFileSync(
      join(root, '.github/workflows/bad.yml'),
      'run: npm publish\nTOP_SECRET_LINE: [unterminated\n'
    );
    const findings = check({ root }).findings;
    assert.equal(findings.length, 1);
    assert.ok(!findings.some((f) => f.message.includes('TOP_SECRET_LINE')));
  });

  test('a directory named like a workflow file is skipped, not a crash', () => {
    const root = tmp();
    mkdirSync(join(root, '.github/workflows/x.yml'));
    assert.deepEqual(check({ root }).findings, []);
  });

  test('a workflow file with an upper-case extension is scanned', () => {
    const root = tmp();
    cpSync(join(dir, 'workflow-env-token.yml'), join(root, '.github/workflows/UPPER.YML'));
    const [file] = scanRepo({ root }).files;
    assert.equal(file?.class, 'bespoke-publisher');
  });
});

suite('exception markers and reports', () => {
  test('a marker with the keyword in another case is invalid, not ignored', () => {
    const root = tmp();
    writeFileSync(
      join(root, '.github/workflows/marked.yml'),
      '# Release-Conformance-Exception: publisher/split until 2027-01-01 reason\non:\n  push:\n    branches: [main]\njobs: {}\n'
    );
    const findings = check({ root }).findings;
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ['exception/invalid']
    );
  });

  test('a link and a mention in a reason are broken up in the summary', () => {
    const cell = escapeMarkdown('see https://example.test/x and www.example.test @some-org/team');
    assert.ok(!cell.includes('://'));
    assert.ok(!/www\./i.test(cell));
    assert.ok(!cell.includes('@some'));
  });
});
