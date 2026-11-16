import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Finding, Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { NEVER_WAIVABLE_RULE_IDS, WAIVABLE_RULE_IDS } from '../src/exceptions.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const fixtures = join(import.meta.dirname, 'fixtures');
const srcDir = join(import.meta.dirname, '..', 'src');

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const loadProfile = (shape: 'pr1' | 'pr2'): Profile => {
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
const profiles = { pr1: loadProfile('pr1'), pr2: loadProfile('pr2') };

interface Fixture {
  /** Path under `fixtures/`. */
  path: string;
  profile?: keyof typeof profiles;
  defaultBranch?: string;
}
interface Case {
  /** Near neighbours that satisfy the rule: a clean run, so any finding is a regression. */
  passing: Fixture[];
  /** Fixtures that violate the rule and only that rule. */
  failing: Fixture[];
}

/**
 * Every rule id the checker can emit, with fixtures on both sides of it. A rule is registered by
 * adding it here; the source scan below fails the suite when the checker emits an id that is not.
 */
const CASES: Record<string, Case> = {
  'caller/callee': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml' }],
    failing: [
      { path: 'shared-caller/fail-callee-archived.yml' },
      { path: 'shared-caller/fail-callee-ref-v1.yml' }
    ]
  },
  'caller/events': {
    passing: [
      { path: 'shared-caller/pass-no-dispatch.yml' },
      { path: 'shared-caller/pass-master-branch.yml', defaultBranch: 'master' }
    ],
    failing: [
      { path: 'shared-caller/fail-events-push-other-branch.yml' },
      { path: 'shared-caller/fail-events-push-tags.yml' }
    ]
  },
  'caller/inputs': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml' }],
    failing: [{ path: 'shared-caller/fail-inputs-extra.yml' }]
  },
  'caller/permissions-ceiling': {
    passing: [{ path: 'shared-caller/pass-wrapper-extra-jobs.yml' }],
    failing: [
      { path: 'shared-caller/fail-ceiling-packages-write.yml' },
      { path: 'shared-caller/fail-ceiling-no-block.yml' }
    ]
  },
  'caller/permissions-floor': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml', profile: 'pr2' }],
    failing: [{ path: 'shared-caller/fail-floor-missing-attestations.yml', profile: 'pr2' }]
  },
  'caller/publish-permission-scope': {
    passing: [{ path: 'shared-caller/pass-extra-steps-job.yml' }],
    failing: [
      { path: 'shared-caller/fail-scope-second-job-token.yml' },
      { path: 'shared-caller/fail-scope-second-job-inherits.yml' }
    ]
  },
  'caller/pull-request-target': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml' }],
    failing: [{ path: 'shared-caller/fail-events-pull-request-target.yml' }]
  },
  'caller/secrets': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml' }],
    failing: [{ path: 'shared-caller/fail-secrets-extra.yml' }]
  },
  'caller/secrets-inherit': {
    passing: [{ path: 'shared-caller/pass-canonical-shape.yml' }],
    failing: [{ path: 'shared-caller/fail-secrets-inherit.yml' }]
  },
  'publisher/environment': {
    passing: [{ path: 'bespoke-publisher/pass-release.yml' }],
    failing: [
      { path: 'bespoke-publisher/fail-no-environment.yml' },
      { path: 'bespoke-publisher/fail-stage-publish.yml' }
    ]
  },
  'publisher/events': {
    passing: [{ path: 'bespoke-publisher/pass-release.yml' }],
    failing: [
      { path: 'bespoke-publisher/fail-other-branch.yml' },
      { path: 'bespoke-publisher/fail-schedule.yml' }
    ]
  },
  'publisher/id-token-with-code': {
    passing: [{ path: 'bespoke-publisher/pass-split.yml' }],
    failing: [{ path: 'bespoke-publisher/fail-install-publish.yml' }]
  },
  'publisher/no-cache': {
    passing: [{ path: 'bespoke-publisher/pass-split.yml' }],
    failing: [
      { path: 'bespoke-publisher/fail-cache-setup.yml' },
      { path: 'bespoke-publisher/fail-cache-action.yml' }
    ]
  },
  'publisher/publishing-dispatch': {
    passing: [{ path: 'bespoke-publisher/pass-release.yml' }],
    failing: [{ path: 'bespoke-publisher/fail-dispatch.yml' }]
  },
  'publisher/pull-request-target': {
    passing: [{ path: 'bespoke-publisher/pass-release.yml' }],
    failing: [{ path: 'bespoke-publisher/fail-pull-request-target.yml' }]
  },
  'publisher/split': {
    passing: [{ path: 'bespoke-publisher/pass-split.yml' }],
    failing: [
      { path: 'bespoke-publisher/fail-extra-write.yml' },
      { path: 'bespoke-publisher/fail-token-install.yml' }
    ]
  },
  'publisher/unclassified-id-token': {
    passing: [{ path: 'model/on-map.yml' }],
    failing: [{ path: 'bespoke-publisher/unclassified-id-token.yml' }]
  },
  'workflow/unparseable': {
    passing: [{ path: 'model/on-map.yml' }],
    failing: [{ path: 'model/unparseable.yml' }]
  },
  'exception/invalid': {
    passing: [{ path: 'falsification/pass-waived-no-cache.yml' }],
    failing: [{ path: 'exceptions/marker-never-waivable.yml' }]
  },
  'exception/unused': {
    passing: [{ path: 'falsification/pass-waived-no-cache.yml' }],
    failing: [{ path: 'exceptions/marker-valid.yml' }]
  }
};

/** Rule ids the source can emit: every `'<family>/<name>'` literal under `src/`. */
const emittedRuleIds = (): string[] => {
  const ids = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(path, 'utf8');
        for (const match of text.matchAll(/'((?:caller|publisher|workflow|exception)\/[a-z-]+)'/g))
          ids.add(match[1] ?? '');
      }
    }
  };
  walk(srcDir);
  return [...ids].sort();
};

/**
 * Runs the checker over one fixture in a scratch tree. A rule outside `registry` is treated as not
 * registered: its findings are dropped, which is what removing the rule would do.
 */
const run = ({
  fixture,
  registry
}: {
  fixture: Fixture;
  registry: ReadonlySet<string>;
}): Finding[] => {
  const root = mkdtempSync(join(tmpdir(), 'falsify-'));
  scratch.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  cpSync(
    join(fixtures, fixture.path),
    join(root, '.github/workflows', fixture.path.split('/').pop() ?? fixture.path)
  );
  const { findings } = runChecks({
    root,
    profile: profiles[fixture.profile ?? 'pr1'],
    context: {
      defaultBranch: fixture.defaultBranch ?? 'main',
      repository: 'example-org/example',
      today: '2026-11-16'
    }
  });
  return findings.filter((finding) => registry.has(finding.ruleId));
};

const ids = (findings: Finding[]): string[] => [...new Set(findings.map((f) => f.ruleId))].sort();
const allRules: ReadonlySet<string> = new Set(Object.keys(CASES));

suite('rule registry is complete', () => {
  test('every rule id the source emits has fixtures, and no fixture entry names a missing rule', () => {
    assert.deepEqual(Object.keys(CASES).sort(), emittedRuleIds());
  });

  test('every rule id a marker may name is a registered rule', () => {
    for (const id of [...WAIVABLE_RULE_IDS, ...NEVER_WAIVABLE_RULE_IDS]) {
      assert.ok(allRules.has(id), `${id} is not a registered rule`);
    }
  });

  test('every rule has at least one passing and one failing fixture', () => {
    for (const [id, { passing, failing }] of Object.entries(CASES)) {
      assert.ok(passing.length > 0, `${id} has no passing fixture`);
      assert.ok(failing.length > 0, `${id} has no failing fixture`);
    }
  });
});

for (const [id, { passing, failing }] of Object.entries(CASES)) {
  suite(`rule ${id}`, () => {
    for (const fixture of passing) {
      test(`passes ${fixture.path}`, () => {
        assert.deepEqual(run({ fixture, registry: allRules }), []);
      });
    }
    for (const fixture of failing) {
      test(`fails ${fixture.path} for this rule only`, () => {
        assert.deepEqual(ids(run({ fixture, registry: allRules })), [id]);
      });
      test(`removing the rule turns ${fixture.path} green`, () => {
        const without = new Set([...allRules].filter((rule) => rule !== id));
        assert.deepEqual(run({ fixture, registry: without }), []);
      });
    }
  });
}
