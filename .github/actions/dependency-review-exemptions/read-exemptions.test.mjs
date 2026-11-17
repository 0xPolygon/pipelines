import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { main, parseExemptions } from './read-exemptions.mjs';

const run = (repository, files = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'exemptions-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  const output = join(root, 'output');
  writeFileSync(output, '');
  const lines = [];
  const code = main({
    env: { REPOSITORY: repository, GITHUB_OUTPUT: output },
    root,
    log: (l) => lines.push(l)
  });
  return { code, out: lines.join('\n'), output: readFileSync(output, 'utf8') };
};

describe('parseExemptions', () => {
  it('reads purls and skips comments and blank lines', () => {
    const { purls, errors } = parseExemptions(
      '# header\n\npkg:npm/@img/sharp-libvips-linux-x64\npkg:golang/github.com/ethereum/go-ethereum # GPL\n'
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(purls, [
      'pkg:npm/@img/sharp-libvips-linux-x64',
      'pkg:golang/github.com/ethereum/go-ethereum'
    ]);
  });

  it('rejects a version', () => {
    assert.match(parseExemptions('pkg:npm/snarkjs@0.7.5').errors[0], /line 1/);
    assert.equal(parseExemptions('pkg:npm/@scope/name@1.0.0').errors.length, 1);
  });

  it('rejects anything that is not a purl', () => {
    assert.equal(parseExemptions('snarkjs').errors.length, 1);
    assert.equal(parseExemptions('pkg:npm/a, pkg:npm/b').errors.length, 1);
    assert.equal(parseExemptions('pkg:npm/a?vcs_url=x').errors.length, 1);
  });

  it('rejects duplicates', () => {
    assert.match(parseExemptions('pkg:npm/a\npkg:npm/a').errors[0], /line 2: .* twice/);
  });
});

describe('main', () => {
  it('outputs the repository file as a comma-separated list', () => {
    const { code, output } = run('0xsequence/trails', {
      '.github/dependency-review/0xsequence/trails.txt': 'pkg:npm/a\npkg:npm/@b/c\n'
    });
    assert.equal(code, 0);
    assert.equal(output, 'allow-dependencies-licenses=pkg:npm/a, pkg:npm/@b/c\n');
  });

  it('outputs nothing to exempt when the repository has no file', () => {
    const { code, output, out } = run('agglayer/sdk');
    assert.equal(code, 0);
    assert.equal(output, 'allow-dependencies-licenses=\n');
    assert.match(out, /No licence exemptions/);
  });

  it('does not read another repository file', () => {
    const { output } = run('0xsequence/sequence.js', {
      '.github/dependency-review/0xsequence/trails.txt': 'pkg:npm/a\n'
    });
    assert.equal(output, 'allow-dependencies-licenses=\n');
  });

  it('fails on a malformed file', () => {
    const { code, out } = run('0xsequence/trails', {
      '.github/dependency-review/0xsequence/trails.txt': 'pkg:npm/a@1\n'
    });
    assert.equal(code, 1);
    assert.match(out, /::error file=\.github\/dependency-review\/0xsequence\/trails\.txt::line 1/);
  });

  it('fails on an unexpected repository name', () => {
    assert.equal(run('../etc').code, 1);
    assert.equal(run('a/..').code, 1);
    assert.equal(run('').code, 1);
  });
});
