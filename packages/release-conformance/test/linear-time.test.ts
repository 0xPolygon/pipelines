import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';

import { createScriptReader } from '../src/package-scripts.ts';
import { isTagOnly, runsPublishText } from '../src/repo-scan.ts';

const BOUND_MS = 1000;
const REPEATS = 50_000;

/** The pattern this check used before it was made linear; kept only to prove the inputs below are hostile. */
const OLD_TAG_ONLY =
  /^\s*(?:(?:pnpm|npm|yarn)(?:\s+exec|\s+run)?\s+)?(?:changesets?\s+tag|git\s+tag|git\s+push\s+--tags)(?:\s+(?:--?[\w-]+|[\w./:@-]+))*\s*$/;

const timed = (run: () => unknown): number => {
  const start = performance.now();
  run();
  return performance.now() - start;
};

const dirs: string[] = [];
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-linear-'));
  dirs.push(dir);
  return dir;
};
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

void describe('workflow text cannot make the check slow', () => {
  const hostile = [
    ['repeated double-dash words, then a bad word', `git tag ${'-- '.repeat(REPEATS)}$bad`],
    ['repeated flags, then a bad word', `git tag ${'-a-b '.repeat(REPEATS)}"`],
    ['repeated path words, then a bad word', `pnpm exec changeset tag ${'a/b '.repeat(REPEATS)};`]
  ] as const;

  for (const [name, input] of hostile) {
    void it(`tag-only test stays fast and says no: ${name}`, () => {
      let answer = true;
      const ms = timed(() => {
        answer = isTagOnly(input);
      });
      assert.equal(answer, false);
      assert.ok(ms < BOUND_MS, `took ${ms} ms`);
    });
  }

  void it('tag-only test still says yes for a long run of plain arguments', () => {
    assert.equal(isTagOnly(`git tag ${'-- '.repeat(REPEATS)}v1.0.0`), true);
  });

  void it('the publish-command test stays fast on repeated package-manager words', () => {
    const ms = timed(() => runsPublishText(`${'npm '.repeat(5000)}\n`.repeat(4)));
    assert.ok(ms < BOUND_MS, `took ${ms} ms`);
  });

  void it('falsification: the previous pattern does not finish on the same input', async () => {
    const input = hostile[0][1];
    const worker = new Worker(
      `const { workerData, parentPort } = require('node:worker_threads');
       parentPort.postMessage(new RegExp(workerData.source).test(workerData.input));`,
      { eval: true, workerData: { source: OLD_TAG_ONLY.source, input } }
    );
    const finished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), BOUND_MS);
      worker.once('message', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    await worker.terminate();
    assert.equal(finished, false);
  });
});

void describe('package.json reads go through one descriptor', () => {
  const scriptsOf = (root: string): boolean =>
    createScriptReader(root).lookup({ name: 'build', dirs: [], wide: false }).defined;

  void it('reads a regular file', () => {
    const root = tmp();
    writeFileSync(join(root, 'package.json'), '{"scripts":{"build":"tsc"}}');
    assert.equal(scriptsOf(root), true);
  });

  void it('does not follow a symlinked package.json', () => {
    const root = tmp();
    const outside = tmp();
    writeFileSync(join(outside, 'package.json'), '{"scripts":{"build":"tsc"}}');
    symlinkSync(join(outside, 'package.json'), join(root, 'package.json'));
    assert.equal(scriptsOf(root), false);
  });

  void it('treats an oversize package.json as absent', () => {
    const root = tmp();
    writeFileSync(
      join(root, 'package.json'),
      `{"scripts":{"build":"tsc"},"pad":"${'x'.repeat(1_100_000)}"}`
    );
    assert.equal(scriptsOf(root), false);
  });

  void it('treats a directory named package.json as absent', () => {
    const root = tmp();
    mkdirSync(join(root, 'package.json'));
    assert.equal(scriptsOf(root), false);
  });
});
