import { cpSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const ACTION_FIXTURE = 'action.yml.fixture';

/** Restores `action.yml` names, which fixtures also hide from scanners that collect that exact name. */
const restoreActionNames = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) restoreActionNames(path);
    else if (entry.name === ACTION_FIXTURE) renameSync(path, join(dir, 'action.yml'));
  }
};

const scratch: string[] = [];

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/**
 * Copies a fixture repository into a fresh temp directory and renames its `dot-github` directory
 * to `.github`, returning the new root. Fixtures store the directory under a non-dot name so that
 * repository-wide workflow scanners do not treat them as real workflows; the checker under test
 * still needs the real name.
 */
export const materialiseFixtureRepo = (source: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'fixture-repo-'));
  scratch.push(root);
  cpSync(source, root, { recursive: true });
  renameSync(join(root, 'dot-github'), join(root, '.github'));
  restoreActionNames(join(root, '.github'));
  return root;
};
