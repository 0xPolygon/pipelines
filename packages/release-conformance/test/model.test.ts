import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { FileClass, RuleContext, ScannedFile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { scanRepo } from '../src/repo-scan.ts';
import { MAX_WORKFLOW_BYTES, parseWorkflow } from '../src/workflow-model.ts';
import { materialiseFixtureRepo } from './helpers/fixture-repo.ts';

/** `node:test` registration returns a promise that runner bookkeeping owns; callers never await it. */
const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const modelDir = join(fixtures, 'model');

const parseFixture = (name: string) =>
  parseWorkflow({ file: name, text: readFileSync(join(modelDir, name), 'utf8') });

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Copies one flat fixture into a throwaway repository layout so the scanner sees it as a workflow. */
const scanFlat = (name: string): ScannedFile => {
  const root = mkdtempSync(join(tmpdir(), 'conformance-'));
  scratch.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  cpSync(join(modelDir, name), join(root, '.github/workflows', name));
  const [file] = scanRepo({ root }).files;
  assert.ok(file, 'scan returned no file');
  return file;
};

const scanRepoFixture = (name: string) =>
  scanRepo({ root: materialiseFixtureRepo(join(modelDir, 'repos', name)) });

const job = (name: string, id: string) => {
  const found = parseFixture(name).jobs.find((candidate) => candidate.id === id);
  assert.ok(found, `job ${id} not found in ${name}`);
  return found;
};

const context: RuleContext = {
  defaultBranch: 'main',
  repository: 'example-org/example',
  today: '2026-11-15'
};

suite('events', () => {
  test('normalises `on:` given as a string', () => {
    assert.deepEqual(
      parseFixture('on-string.yml').events.map((event) => event.name),
      ['push']
    );
  });

  test('normalises `on:` given as a list', () => {
    assert.deepEqual(
      parseFixture('on-list.yml').events.map((event) => event.name),
      ['push', 'pull_request']
    );
  });

  test('reads filters and dispatch inputs from `on:` given as a map', () => {
    const events = parseFixture('on-map.yml').events;
    const byName = (name: string) => events.find((event) => event.name === name);
    assert.deepEqual(byName('push')?.branches, ['main']);
    assert.deepEqual(byName('push')?.paths, ['src/**']);
    assert.deepEqual(byName('pull_request')?.types, ['opened', 'synchronize']);
    assert.deepEqual(byName('workflow_dispatch')?.inputs, ['first_input', 'second_input']);
    assert.equal(byName('schedule')?.name, 'schedule');
  });

  test('records the line of each event key', () => {
    const lines = Object.fromEntries(
      parseFixture('on-map.yml').events.map((event) => [event.name, event.line])
    );
    assert.equal(lines['push'], 3);
    assert.equal(lines['workflow_dispatch'], 9);
  });
});

suite('permissions', () => {
  test('uses the job block when the job has one, even a narrower one', () => {
    const narrow = job('perms-job-over-top.yml', 'narrow');
    assert.deepEqual(narrow.effectivePermissions.scopes, { contents: 'read' });
    assert.equal(narrow.defaultTokenPermissions, false);
  });

  test('falls back to the top-level block when the job has none', () => {
    const inherits = job('perms-job-over-top.yml', 'inherits');
    assert.deepEqual(inherits.effectivePermissions.scopes, {
      contents: 'write',
      'id-token': 'write'
    });
    assert.equal(inherits.permissions.present, false);
  });

  test('treats an empty job block as present and grants nothing', () => {
    const empty = job('perms-job-over-top.yml', 'empty');
    assert.equal(empty.permissions.present, true);
    assert.deepEqual(empty.effectivePermissions.scopes, {});
  });

  test('marks a job with no block at either level as using default token permissions', () => {
    const build = job('no-permissions.yml', 'build');
    assert.equal(build.defaultTokenPermissions, true);
    assert.equal(build.effectivePermissions.present, false);
  });
});

suite('jobs', () => {
  test('reads secrets, `with` keys and `secrets: inherit`', () => {
    assert.equal(job('secrets-inherit.yml', 'inherit').secrets.inherit, true);
    const named = job('secrets-inherit.yml', 'named');
    assert.equal(named.secrets.inherit, false);
    assert.deepEqual(named.secrets.names, ['TOKEN_A', 'TOKEN_B']);
    assert.deepEqual(named.withKeys, ['first', 'second']);
  });

  test('splits a `uses` reference into owner, repository, path and ref', () => {
    assert.deepEqual(job('secrets-inherit.yml', 'named').uses, {
      raw: 'example-org/shared/.github/workflows/build.yml@v1',
      local: false,
      owner: 'example-org',
      repo: 'shared',
      path: '.github/workflows/build.yml',
      ref: 'v1'
    });
  });

  test('tells a literal environment from an expression', () => {
    assert.deepEqual(job('bespoke-publisher.yml', 'publish').environment, {
      kind: 'literal',
      name: 'npm-publish'
    });
    assert.deepEqual(job('bespoke-publisher.yml', 'other').environment, {
      kind: 'expression',
      text: '${{ inputs.target }}'
    });
  });

  test('records secret references in job env and keeps steps with their uses, run and with', () => {
    assert.deepEqual(job('token-publisher.yml', 'publish').envSecretRefs, [
      { key: 'NODE_AUTH_TOKEN', expression: '${{ secrets.NPM_TOKEN }}' }
    ]);
    const steps = job('changesets-action-publish.yml', 'release').steps;
    assert.equal(steps[0]?.uses?.ref, 'v1');
    assert.deepEqual(steps[0]?.with, { publish: 'pnpm run release' });
    assert.equal(job('bespoke-publisher.yml', 'publish').steps[1]?.run, 'npm publish');
  });

  test('records the line of each job', () => {
    assert.equal(job('bespoke-publisher.yml', 'publish').line, 6);
    assert.equal(job('bespoke-publisher.yml', 'other').line, 15);
  });
});

suite('unreadable input', () => {
  test('reports a file that does not parse', () => {
    const model = parseFixture('unparseable.yml');
    assert.ok(model.parseError);
    assert.deepEqual(model.jobs, []);
  });

  test('rejects a file over the size limit without reading it', () => {
    const model = parseWorkflow({
      file: 'big.yml',
      text: `# ${'x'.repeat(MAX_WORKFLOW_BYTES)}\non: push\njobs: {}\n`
    });
    assert.match(model.parseError ?? '', /larger than/);
  });

  test('caps alias expansion', () => {
    const aliases = Array.from({ length: 200 }, () => '*a').join(', ');
    const model = parseWorkflow({
      file: 'aliases.yml',
      text: `a: &a [1, 2]\nlist: [${aliases}]\non: push\njobs: {}\n`
    });
    assert.ok(model.parseError);
  });
});

suite('classification', () => {
  const expected: Record<string, FileClass> = {
    'on-string.yml': 'not-in-scope',
    'on-list.yml': 'not-in-scope',
    'on-map.yml': 'not-in-scope',
    'perms-job-over-top.yml': 'not-in-scope',
    'no-permissions.yml': 'not-in-scope',
    'secrets-inherit.yml': 'not-in-scope',
    'shared-caller.yml': 'shared-caller',
    'archived-callee.yml': 'shared-caller',
    'bespoke-publisher.yml': 'bespoke-publisher',
    'token-publisher.yml': 'bespoke-publisher',
    'credential-free-changeset-publish.yml': 'not-in-scope',
    'changesets-action-tag-only.yml': 'not-in-scope',
    'changesets-action-publish.yml': 'bespoke-publisher',
    'comment-mention.yml': 'not-in-scope',
    'unparseable.yml': 'unparseable',
    'unparseable-plain.yml': 'unparseable'
  };
  for (const [name, fileClass] of Object.entries(expected)) {
    test(`${name} is ${fileClass}`, () => {
      assert.equal(scanFlat(name).class, fileClass);
    });
  }

  test('resolves a local composite action so its publish command counts for the job', () => {
    const [file] = scanRepoFixture('composite').files;
    assert.equal(file?.class, 'bespoke-publisher');
    assert.match(file?.jobs[0]?.runText ?? '', /pnpm publish -r/);
  });
});

suite('local call graph', () => {
  const scanned = scanRepoFixture('local-graph').files;
  const files = () => scanned;
  const publisher = () => {
    const found = files().find((file) => file.model.file.endsWith('/publisher.yml'));
    assert.ok(found);
    return found;
  };

  test('finds the local callers of a reusable workflow', () => {
    assert.deepEqual(publisher().localCallers, [
      '.github/workflows/caller-push.yml',
      '.github/workflows/caller-release.yml'
    ]);
  });

  test('classifies the reusable workflow as a publisher and its callers as out of scope', () => {
    assert.equal(publisher().class, 'bespoke-publisher');
    for (const file of files().filter((candidate) => candidate !== publisher())) {
      assert.equal(file.class, 'not-in-scope');
    }
  });

  test('computes the entry events of a publisher as the union over its local callers', () => {
    assert.deepEqual(
      publisher()
        .entryEvents.map((event) => event.name)
        .sort(),
      ['push', 'release']
    );
  });

  test('keeps `workflow_call` as the entry event when nothing local calls the workflow', () => {
    const [lone] = scanRepoFixture('lone-reusable').files;
    assert.deepEqual(
      lone?.entryEvents.map((event) => event.name),
      ['workflow_call']
    );
    assert.deepEqual(lone?.localCallers, []);
  });

  test("reports a non-reusable workflow's own events", () => {
    assert.deepEqual(
      scanFlat('on-list.yml').entryEvents.map((event) => event.name),
      ['push', 'pull_request']
    );
  });
});

suite('canonical profile', () => {
  const profileFor = (shape: 'pr1' | 'pr2') => {
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

  test('derives the pre-attestation profile', () => {
    const profile = profileFor('pr1');
    assert.deepEqual(profile.floor, {
      contents: 'write',
      'pull-requests': 'write',
      'id-token': 'write'
    });
    assert.deepEqual(Object.keys(profile.allowedEvents).sort(), ['push', 'workflow_dispatch']);
    assert.deepEqual(profile.allowedEvents['workflow_dispatch']?.inputs, ['snapshot_tag']);
    assert.deepEqual(profile.secretNames, [
      'CHANGESET_RELEASE_BOT_APP_ID',
      'CHANGESET_RELEASE_BOT_APP_PRIVATE_KEY'
    ]);
    assert.deepEqual(profile.withKeys, ['snapshot_tag']);
    assert.deepEqual(profile.allowedRefs, ['main']);
  });

  test('derives a post-attestation floor that differs by exactly `attestations: write`', () => {
    const before = profileFor('pr1');
    const after = profileFor('pr2');
    assert.deepEqual(after.floor, { ...before.floor, attestations: 'write' });
    assert.deepEqual({ ...after, floor: before.floor }, before);
  });

  test('keeps the ceiling above both floors', () => {
    for (const shape of ['pr1', 'pr2'] as const) {
      const profile = profileFor(shape);
      for (const scope of Object.keys(profile.floor)) {
        assert.ok(profile.ceiling[scope], `${scope} missing from the ceiling`);
      }
    }
  });
});

suite('engine', () => {
  const profile = deriveProfile({
    trigger: parseFixture('shared-caller.yml'),
    release: parseFixture('perms-job-over-top.yml')
  });

  test('fails an unreadable file that mentions the release workflow and only notes one that does not', () => {
    const root = mkdtempSync(join(tmpdir(), 'conformance-'));
    scratch.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    for (const name of ['unparseable.yml', 'unparseable-plain.yml', 'on-string.yml']) {
      cpSync(join(modelDir, name), join(root, '.github/workflows', name));
    }
    const result = runChecks({ root, profile, context });
    const severities = Object.fromEntries(
      result.findings.map((finding) => [finding.file, finding.severity])
    );
    assert.deepEqual(severities, {
      '.github/workflows/unparseable-plain.yml': 'notice',
      '.github/workflows/unparseable.yml': 'error'
    });
    assert.ok(result.findings.every((finding) => finding.ruleId === 'workflow/unparseable'));
    assert.deepEqual(result.notInScope, ['.github/workflows/on-string.yml']);
    assert.deepEqual(result.exceptions, []);
  });

  test('runs the rules over the local call graph without reporting an error', () => {
    const result = runChecks({
      root: materialiseFixtureRepo(join(modelDir, 'repos', 'local-graph')),
      profile,
      context
    });
    assert.deepEqual(
      result.findings.filter((f) => f.severity === 'error'),
      []
    );
  });
});
