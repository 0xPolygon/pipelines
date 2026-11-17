import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import type { Profile } from '../src/types.ts';

import { deriveProfile } from '../src/canonical.ts';
import { runChecks } from '../src/engine.ts';
import { scanRepo } from '../src/repo-scan.ts';
import { parseWorkflow } from '../src/workflow-model.ts';

const suite = (name: string, body: () => void): void => {
  void describe(name, body);
};
const test = (name: string, body: () => void): void => {
  void it(name, body);
};

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const workflows = join(repoRoot, '.github', 'workflows');
const fixtures = join(import.meta.dirname, 'fixtures');
const TRIGGER = 'apps-npm-release-trigger.yml';
const RELEASE = 'apps-npm-release.yml';

const scratch: string[] = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const profileFrom = ({ trigger, release }: { trigger: string; release: string }): Profile =>
  deriveProfile({
    trigger: parseWorkflow({ file: TRIGGER, text: trigger }),
    release: parseWorkflow({ file: RELEASE, text: release })
  });

const readExpected = (name: string): Profile =>
  JSON.parse(readFileSync(join(fixtures, 'expected-profiles', name), 'utf8')) as Profile;

/** The shapes the canonical files may have: the base, the one with the attestation job, and the base with the `version_script` input. */
const expected = {
  'npm-release.pr1.json': readExpected('npm-release.pr1.json'),
  'npm-release.pr2.json': readExpected('npm-release.pr2.json'),
  'npm-release.pr3.json': readExpected('npm-release.pr3.json')
};

const liveTrigger = readFileSync(join(workflows, TRIGGER), 'utf8');
const liveRelease = readFileSync(join(workflows, RELEASE), 'utf8');

/** Names of the committed profiles the given profile equals. */
const matches = (profile: Profile): string[] =>
  Object.entries(expected)
    .filter(([, candidate]) => {
      try {
        assert.deepEqual(profile, candidate);
        return true;
      } catch {
        return false;
      }
    })
    .map(([name]) => name);

suite('canonical profile', () => {
  test('the profile derived from the live trigger and release workflow equals a committed one', () => {
    const live = profileFrom({ trigger: liveTrigger, release: liveRelease });
    assert.ok(
      matches(live).length > 0,
      'the canonical files changed shape: add a matching file under fixtures/expected-profiles/ on purpose'
    );
  });

  test('each committed profile is the one derived from its committed canonical fixtures', () => {
    for (const [name, shape] of [
      ['npm-release.pr1.json', 'pr1'],
      ['npm-release.pr2.json', 'pr2'],
      ['npm-release.pr3.json', 'pr3']
    ] as const) {
      const read = (file: string) => readFileSync(join(fixtures, 'canonical', shape, file), 'utf8');
      assert.deepEqual(
        profileFrom({ trigger: read(TRIGGER), release: read(RELEASE) }),
        expected[name],
        name
      );
    }
  });

  test('the two committed profiles differ only in the attestation floor', () => {
    const { floor: floor1, ...rest1 } = expected['npm-release.pr1.json'];
    const { floor: floor2, ...rest2 } = expected['npm-release.pr2.json'];
    assert.deepEqual(rest1, rest2);
    assert.deepEqual(floor2, { ...floor1, attestations: 'write' });
  });

  test('the live trigger passes every caller rule under its own profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'canonical-'));
    scratch.push(root);
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    cpSync(join(workflows, TRIGGER), join(root, '.github/workflows', TRIGGER));
    // A trigger that no longer calls the shared workflow would pass every rule vacuously.
    assert.deepEqual(
      scanRepo({ root }).files.map((file) => file.class),
      ['shared-caller']
    );
    const { findings } = runChecks({
      root,
      profile: profileFrom({ trigger: liveTrigger, release: liveRelease }),
      context: { defaultBranch: 'main', repository: '0xPolygon/pipelines', today: '2026-11-16' }
    });
    assert.deepEqual(
      findings.filter((finding) => finding.ruleId.startsWith('caller/')),
      []
    );
  });

  test('a release workflow whose publish job gains packages: write matches no committed profile', () => {
    const anchor = '    permissions:\n      id-token: write # npm OIDC trusted publishing\n';
    assert.equal(liveRelease.split(anchor).length, 2, 'the publish job permissions anchor moved');
    const mutated = liveRelease.replace(anchor, `${anchor}      packages: write\n`);
    const profile = profileFrom({ trigger: liveTrigger, release: mutated });
    assert.equal(profile.floor.packages, 'write');
    assert.deepEqual(matches(profile), []);
  });
});
