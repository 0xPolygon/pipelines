// Reads the licence-check exemptions for the calling repository.
//
// The exemptions live in this repository, one file per consuming repository,
// so adding one goes through this repository's review (CODEOWNERS) rather than
// the consuming repository's. The file is chosen by `github.repository`, which
// a pull request cannot change. Format: one purl per line, without a version;
// blank lines and `#` comments are ignored. Anything else fails the step, so a
// typo cannot silently exempt nothing (or something else).

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// pkg:<type>/<namespace and name>, no version, qualifiers or subpath. An npm
// scope may start the name (`pkg:npm/@scope/name`); any other `@` is a version.
const PURL = /^pkg:[a-z][a-z0-9.+-]*\/(@?[^\s@?#,]+)$/;

export function parseExemptions(text) {
  const purls = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') return;
    if (!PURL.test(line)) {
      errors.push(`line ${i + 1}: "${line}" is not a purl without a version`);
    } else if (purls.includes(line)) {
      errors.push(`line ${i + 1}: "${line}" is listed twice`);
    } else {
      purls.push(line);
    }
  });
  return { purls, errors };
}

export function main({ env = process.env, root = DEFAULT_ROOT, log = console.log } = {}) {
  const repository = env.REPOSITORY ?? '';
  if (!REPOSITORY.test(repository) || repository.includes('..')) {
    log(`::error::Unexpected repository name: "${repository}".`);
    return 1;
  }
  const file = join('.github', 'dependency-review', `${repository}.txt`);
  let text;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    log(`No licence exemptions for ${repository} (${file} does not exist).`);
    text = '';
  }
  const { purls, errors } = parseExemptions(text);
  if (errors.length > 0) {
    for (const e of errors) log(`::error file=${file}::${e}`);
    return 1;
  }
  if (purls.length > 0) log(`${purls.length} licence exemption(s) for ${repository} from ${file}.`);
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `allow-dependencies-licenses=${purls.join(', ')}\n`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
