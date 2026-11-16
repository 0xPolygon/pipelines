/**
 * Reads shell text the way the release rules need it: which commands publish a
 * package, which install or run repository code, and which package scripts a
 * command refers to. Nothing here runs a command; it only reads text.
 */

/**
 * Drops shell comments so a comment that names a publish command does not count
 * as running it. A `#` only starts a comment outside single and double quotes
 * and at the start of a word, so `echo "Release #12" && npm publish` keeps its
 * publish command. An unbalanced quote leaves later comments in place, which
 * errs towards seeing more commands, never fewer.
 */
export const stripShellComments = (text: string): string => {
  let out = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') {
        out += char + (text[index + 1] ?? '');
        index += 1;
        continue;
      }
      if (char === quote) quote = undefined;
      out += char;
      continue;
    }
    if (char === '\\') {
      out += char + (text[index + 1] ?? '');
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }
    const previous = text[index - 1];
    if (char === '#' && (previous === undefined || /\s/.test(previous))) {
      while (index + 1 < text.length && text[index + 1] !== '\n') index += 1;
      continue;
    }
    out += char;
  }
  return out;
};

/**
 * The one form every matcher reads: backslash line continuations joined into
 * one line, then comments removed. Joining first keeps a command that is wrapped
 * across lines in one piece.
 */
export const normalizeShell = (text: string): string =>
  stripShellComments(text.replace(/\\\r?\n/g, ' '));

/** A package script a command runs by name, with the directories it was pointed at. */
export interface ScriptRef {
  name: string;
  /** A hook-style lookup (`npm test` reaches `test` if the package defines it): a missing script is not worth a notice. */
  optional?: boolean;
  /** Directories named by `cd`, a working directory or a directory flag; empty means the repository root. */
  dirs: string[];
  /** True when the command runs in several workspace packages (`-r`, `--filter`, `--workspaces`). */
  wide: boolean;
}

export interface ShellFacts {
  /** An explicit publish command: `<manager> publish`, `changeset publish` and the like. */
  publishes: boolean;
  /** Installs dependencies or runs a build, test or lint step, or runs a tool from the repository. */
  runsCode: boolean;
  scripts: ScriptRef[];
  /** A command nests wrappers deeper than the parser follows; it is treated as publishing and running code. */
  tooDeep?: boolean;
}

/**
 * True for the word `publish`, alone or with shell syntax glued to it (`publish>out.log`, `publish<<<y`,
 * `publish\n` inside printed text). A name that merely starts with it (`publishConfig`, `publish-please`,
 * `publish:docs`) is not. A single anchored test, so the cost is linear in the word.
 */
export const isPublishWord = (word: string): boolean => /^publish(?:[^A-Za-z0-9_:-]|$)/.test(word);

/**
 * npm resolves any unambiguous prefix of a command name, and `pu`, `pub`, `publ`, `publi` and `publis`
 * all resolve to `publish` (checked with the npm command table: `p` alone is ambiguous). Other managers
 * are not given prefixes here: none is known to accept them.
 */
export const isNpmPublishWord = (word: string): boolean =>
  /^pu(?:b(?:l(?:i(?:s(?:h)?)?)?)?)?(?:[^A-Za-z0-9_:-]|$)/.test(word);

/** The publish-word test for one tool: npm also accepts its abbreviations. */
export const publishWordTest = (tool: string): ((word: string) => boolean) =>
  tool === 'npm' ? isNpmPublishWord : isPublishWord;

/**
 * Drops an `@<version or tag>` suffix from a tool word (`npm@11` is `npm`, `@changesets/cli@3` is
 * `@changesets/cli`), so a pinned or tagged tool is read as the tool. The scope's own leading `@` stays.
 */
export const stripVersion = (word: string): string => {
  const at = word.indexOf('@', 1);
  return at > 0 ? word.slice(0, at) : word;
};

const noFacts = (): ShellFacts => ({ publishes: false, runsCode: false, scripts: [] });

const merge = (into: ShellFacts, from: ShellFacts): void => {
  if (from.publishes) into.publishes = true;
  if (from.runsCode) into.runsCode = true;
  if (from.tooDeep) into.tooDeep = true;
  into.scripts.push(...from.scripts);
};

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'lerna']);
/** Runs a package binary that is not installed yet: the command that follows is the real one. */
const BINARY_RUNNERS = new Set(['npx', 'pnpx', 'bunx']);
const CODE_SUBCOMMANDS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'test',
  't',
  'build',
  'lint',
  'install-test',
  'it',
  'rebuild'
]);
const CODE_SCRIPTS = /^(?:build|test|lint|prepublishOnly|prepublish|prepare|prepack)(?::.*)?$/;
const RUN_SUBCOMMANDS = new Set(['run', 'run-script']);
const EXEC_SUBCOMMANDS = new Set(['exec', 'dlx', 'x']);
/** Subcommands that wrap another command whose own words follow (`npm stage publish`, `yarn npm publish`). */
const WRAPPING_SUBCOMMANDS = new Set([
  'stage',
  'npm',
  'workspaces',
  'workspace',
  'foreach',
  'recursive',
  'multi'
]);
/** Package-manager commands that are not a package script, so `pnpm <word>` for these is not a script. */
const BUILTIN_COMMANDS = new Set([
  'access',
  'approve-builds',
  'audit',
  'bin',
  'cache',
  'config',
  'create',
  'deploy',
  'deprecate',
  'dist-tag',
  'env',
  'fetch',
  'help',
  'import',
  'info',
  'init',
  'licenses',
  'link',
  'list',
  'login',
  'logout',
  'ls',
  'node',
  'outdated',
  'owner',
  'pack',
  'patch',
  'patch-commit',
  'prune',
  'publish',
  'remove',
  'rm',
  'root',
  'set',
  'setup',
  'store',
  'team',
  'token',
  'unlink',
  'unpublish',
  'up',
  'update',
  'upgrade',
  'version',
  'view',
  'whoami',
  'why'
]);
const SHELL_KEYWORDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
  '(',
  'corepack'
]);
/**
 * Commands that run the command that follows them. Their own flags (and the values some flags
 * take) are skipped to reach it, so `timeout 300 npm publish` and `xargs -n1 npm publish` read as
 * the publish they run.
 */
const WRAPPER_VALUE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'xargs',
    new Set([
      '-a',
      '-d',
      '-E',
      '-e',
      '-I',
      '-i',
      '-L',
      '-l',
      '-n',
      '-P',
      '-s',
      '--arg-file',
      '--delimiter',
      '--max-args',
      '--max-procs',
      '--max-lines',
      '--max-chars'
    ])
  ],
  ['timeout', new Set(['-s', '--signal', '-k', '--kill-after'])],
  [
    'sudo',
    new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-R', '--user', '--group'])
  ],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '--unset', '--chdir'])],
  ['nice', new Set(['-n', '--adjustment'])],
  ['ionice', new Set(['-c', '-n', '-p', '-P', '-u'])],
  ['exec', new Set(['-a'])],
  ['nohup', new Set()],
  ['time', new Set(['-f', '-o', '--format', '--output'])],
  ['command', new Set()],
  ['setsid', new Set()],
  ['stdbuf', new Set(['-i', '-o', '-e'])]
]);
const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;
/** Nesting deeper than this is not a real command line; the parser stops following it and fails closed. */
const MAX_DEPTH = 8;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DIR_FLAGS = new Set(['--dir', '-C', '--prefix', '--cwd']);
const WIDE_FLAGS = new Set(['-r', '--recursive', '--workspaces', '-ws', '--filter', '-F']);

/** Value flags of the publish commands, so `npm --tag beta publish` still reads `publish` as the subcommand. */
const PUBLISH_VALUE_FLAGS = new Set([
  '--tag',
  '--registry',
  '--otp',
  '--access',
  '--userconfig',
  '--globalconfig',
  '--cache',
  '--loglevel',
  '--publish-branch',
  '--scope',
  '--dist-tag',
  '--npm-tag',
  '--git-remote',
  '--reporter',
  '--config'
]);

/** Flags that take a separate value, so the value is not the subcommand. */
const flagTakesValue = ({ manager, flag }: { manager: string; flag: string }): boolean => {
  if (DIR_FLAGS.has(flag) || flag === '--filter' || flag === '-F') return true;
  if (flag === '--workspace') return true;
  if (PUBLISH_VALUE_FLAGS.has(flag)) return true;
  if (flag === '-w' || flag === '-m') return manager === (flag === '-w' ? 'npm' : 'lerna');
  return flag === '--package' || flag === '-p';
};

const QUOTES = new Set(['"', "'", '`']);

/** Strips quote characters from both ends of a word, by index so the cost is linear in its length. */
export const unquote = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && QUOTES.has(token[start] ?? '')) start += 1;
  while (end > start && QUOTES.has(token[end - 1] ?? '')) end -= 1;
  return token.slice(start, end);
};

/** Index of the word after a `NAME=value` word, past the rest of a quoted value that holds spaces. */
const skipAssignment = ({ words, index }: { words: string[]; index: number }): number => {
  const token = words[index] ?? '';
  const value = token.slice(token.indexOf('=') + 1);
  const open = value[0];
  let next = index + 1;
  if ((open === '"' || open === "'") && !(value.length > 1 && value.endsWith(open))) {
    while (next < words.length && !(words[next] ?? '').endsWith(open)) next += 1;
    next += 1;
  }
  return next;
};

/**
 * Unquotes words one by one, but reads a quoted `NAME="a b"` value from the raw words first: once the
 * quotes are stripped the end of the value can no longer be found, and `PATH="$PATH"` would swallow
 * the rest of the line. Each assignment becomes a single word without quotes.
 */
const unquoteWords = (raw: string[]): string[] => {
  const out: string[] = [];
  let index = 0;
  while (index < raw.length) {
    const token = raw[index] ?? '';
    if (!ASSIGNMENT.test(token)) {
      out.push(unquote(token));
      index += 1;
      continue;
    }
    const next = skipAssignment({ words: raw, index });
    out.push(
      raw
        .slice(index, next)
        .map((word, at) =>
          at === 0
            ? word.slice(0, word.indexOf('=') + 1) + unquote(word.slice(word.indexOf('=') + 1))
            : unquote(word)
        )
        .join(' ')
    );
    index = next;
  }
  return out;
};

/** Words of one command with leading shell keywords, variable assignments and wrappers removed. */
const commandWords = (segment: string): string[] => {
  const raw = segment
    .trim()
    .replace(/^[({]+\s*/, '')
    .split(/\s+/)
    .filter((token) => token !== '');
  let index = 0;
  while (index < raw.length) {
    const token = raw[index] ?? '';
    if (SHELL_KEYWORDS.has(token)) {
      index += 1;
      continue;
    }
    if (ASSIGNMENT.test(token)) {
      index = skipAssignment({ words: raw, index });
      continue;
    }
    break;
  }
  return unquoteWords(raw.slice(index));
};

const basename = (word: string): string => word.replace(/^.*\//, '');

const tooDeepFacts = (): ShellFacts => ({
  publishes: true,
  runsCode: true,
  scripts: [],
  tooDeep: true
});

/** The command a wrapper runs: its own flags (and their values), assignments and a leading duration skipped. */
const wrappedCommand = ({ name, rest }: { name: string; rest: string[] }): string[] => {
  const valueFlags = WRAPPER_VALUE_FLAGS.get(name) ?? new Set<string>();
  let index = 0;
  let sawDuration = false;
  while (index < rest.length) {
    const token = rest[index] ?? '';
    if (token === '--') {
      index += 1;
      break;
    }
    if (token.startsWith('-') && token.length > 1) {
      index += valueFlags.has(token) ? 2 : 1;
      continue;
    }
    if (name === 'env' && ASSIGNMENT.test(token)) {
      index = skipAssignment({ words: rest, index });
      continue;
    }
    if (name === 'timeout' && !sawDuration && DURATION.test(token)) {
      sawDuration = true;
      index += 1;
      continue;
    }
    break;
  }
  return rest.slice(index);
};

/** `bash -c "<command>"`: the words after the `-c` flag are the command it runs. */
const shellCommandString = (rest: string[]): string[] => {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (!token.startsWith('-') && !token.startsWith('+')) return [];
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(token)) return rest.slice(index + 1);
    if (token === '-o' || token === '+o') index += 1;
  }
  return [];
};

/** `find ... -exec <command> {} \;` runs the command that follows the `-exec` family flag. */
const findExecCommand = (rest: string[]): string[] => {
  const at = rest.findIndex((token) => ['-exec', '-execdir', '-ok', '-okdir'].includes(token));
  return at < 0 ? [] : rest.slice(at + 1);
};

const classify = ({
  words,
  dirs,
  depth = 0
}: {
  words: string[];
  dirs: string[];
  depth?: number;
}): ShellFacts => {
  if (depth > MAX_DEPTH) return tooDeepFacts();
  const [first = '', ...rest] = words;
  const name = stripVersion(basename(first));
  const inner = (next: string[]): ShellFacts =>
    next.length === 0 ? noFacts() : classify({ words: next, dirs, depth: depth + 1 });
  if (PACKAGE_MANAGERS.has(name)) return classifyManager({ manager: name, rest, dirs, depth });
  if (BINARY_RUNNERS.has(name)) return classifyExec({ rest, dirs, depth });
  if (name === 'changeset' || name === 'changesets' || CHANGESETS_CLI.test(first)) {
    return { ...noFacts(), publishes: isPublishWord(firstWord(rest) ?? '') };
  }
  if (WRAPPER_VALUE_FLAGS.has(name) || name === 'corepack') {
    return inner(wrappedCommand({ name, rest }));
  }
  if (SHELL_NAMES.has(name)) return inner(shellCommandString(rest));
  if (name === 'find') return inner(findExecCommand(rest));
  if (name === 'node') {
    return { ...noFacts(), runsCode: !runsOwnActionScript(rest) && !onlyReportsVersion(rest) };
  }
  if (name === 'make') return { ...noFacts(), runsCode: true };
  return noFacts();
};

/**
 * Stands in for a composite action's own directory in its shell text, so a
 * script the action ships can be told from a script of the repository that runs
 * it. Control characters are removed from input first, so it cannot be typed.
 */
const ACTION_PATH_MARK = '\u0001ACTIONPATH\u0001';
const CONTROL_MARK = /\u0001/g;

/** `node <script>` where the script sits inside the action's own directory (and does not climb out of it). */
const runsOwnActionScript = (rest: string[]): boolean => {
  const script = firstWord(rest);
  return script !== undefined && script.startsWith(ACTION_PATH_MARK) && !script.includes('..');
};

const CHANGESETS_CLI = /^@changesets\/cli(?:@\S*)?$/;

/** `node --version` and the like print a string and run no repository code. */
const onlyReportsVersion = (rest: string[]): boolean =>
  rest.length === 1 && ['--version', '-v', '--help', '-h'].includes(rest[0] ?? '');

/** Install-style subcommands that add to the repository's dependencies, so their lifecycle hooks can run. */
const INSTALL_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add', 'install-test', 'it']);
const TEST_SUBCOMMANDS = new Set(['test', 't', 'install-test', 'it']);

const firstWord = (tokens: string[]): string | undefined => tokens.find((t) => !t.startsWith('-'));

/** `<runner> [flags] <command ...>`: runs another command, which is repository code unless it only publishes. */
const classifyExec = ({
  rest,
  dirs,
  depth
}: {
  rest: string[];
  dirs: string[];
  depth: number;
}): ShellFacts => {
  let index = 0;
  while (index < rest.length) {
    const token = rest[index] ?? '';
    if (token === '--') {
      index += 1;
      break;
    }
    if (!token.startsWith('-')) break;
    index += token === '--package' || token === '-p' ? 2 : 1;
  }
  const inner = rest.slice(index);
  if (inner.length === 0) return { ...noFacts(), runsCode: true };
  const facts = classify({ words: inner, dirs, depth: depth + 1 });
  return {
    publishes: facts.publishes,
    runsCode: !facts.publishes || facts.tooDeep === true,
    scripts: facts.scripts,
    ...(facts.tooDeep ? { tooDeep: true } : {})
  };
};

const classifyManager = ({
  manager,
  rest,
  dirs,
  depth
}: {
  manager: string;
  rest: string[];
  dirs: string[];
  depth: number;
}): ShellFacts => {
  const facts = noFacts();
  const flagDirs: string[] = [];
  let wide = false;
  const words: string[] = [];
  let global = false;
  let subIndex = -1;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token.startsWith('-')) {
      const [flag = '', inline] = token.split('=', 2);
      if (WIDE_FLAGS.has(flag) || (flag === '-w' && manager === 'npm') || flag === '--workspace')
        wide = true;
      if (flag === '-g' || flag === '--global' || (flag === '--location' && inline === 'global'))
        global = true;
      let value = inline;
      if (inline === undefined && flagTakesValue({ manager, flag })) {
        value = rest[index + 1];
        index += 1;
      }
      if (DIR_FLAGS.has(flag) && value !== undefined) flagDirs.push(value);
      continue;
    }
    if (words.length === 0) subIndex = index;
    words.push(token);
  }
  const [sub, second, third] = words;
  const where = [...flagDirs, ...dirs];
  const isPublish = publishWordTest(manager);
  if (sub === undefined) {
    // A bare `yarn` installs dependencies.
    facts.runsCode = manager === 'yarn';
    return facts;
  }
  if (sub === 'foreach' || sub === 'workspaces') wide = true;
  if (isPublish(sub)) {
    facts.publishes = true;
    return facts;
  }
  if (WRAPPING_SUBCOMMANDS.has(sub) && words.slice(1).some(isPublish)) {
    facts.publishes = true;
    return facts;
  }
  if (RUN_SUBCOMMANDS.has(sub)) {
    if (second !== undefined) {
      facts.scripts.push({ name: second, dirs: where, wide });
      facts.runsCode = CODE_SCRIPTS.test(second);
    }
    return facts;
  }
  if (sub === 'workspace' && third !== undefined) {
    // `yarn workspace <package> <script>`
    facts.scripts.push({ name: third, dirs: where, wide: true });
    facts.runsCode = CODE_SCRIPTS.test(third);
    return facts;
  }
  if (EXEC_SUBCOMMANDS.has(sub)) {
    return classifyExec({ rest: rest.slice(subIndex + 1), dirs: where, depth });
  }
  if (sub === 'global') return facts;
  if (CODE_SUBCOMMANDS.has(sub) || CODE_SCRIPTS.test(sub)) {
    // A global install puts a tool on the machine; it does not install the repository's dependencies.
    if (INSTALL_SUBCOMMANDS.has(sub) && global) return facts;
    facts.runsCode = true;
    const hooks = [
      ...(TEST_SUBCOMMANDS.has(sub) ? ['test'] : []),
      ...(INSTALL_SUBCOMMANDS.has(sub) ? ['install', 'prepare'] : []),
      ...(!INSTALL_SUBCOMMANDS.has(sub) && !TEST_SUBCOMMANDS.has(sub) && manager !== 'npm'
        ? [sub]
        : [])
    ];
    for (const name of hooks) facts.scripts.push({ name, optional: true, dirs: where, wide });
    return facts;
  }
  const known = BUILTIN_COMMANDS.has(sub) || RUN_SUBCOMMANDS.has(sub) || EXEC_SUBCOMMANDS.has(sub);
  // npm and lerna take no bare script or binary name, so a word before `publish` can only be the
  // value of a flag this parser does not know (`npm --tag beta publish`); `publish` still publishes.
  if (!known && (manager === 'npm' || manager === 'lerna') && words.some(isPublish)) {
    facts.publishes = true;
    return facts;
  }
  // `pnpm <script>` and `yarn <script>` run a package script by name, or a package binary of that
  // name; `pnpm wrangler publish` publishes with wrangler, not with the package manager.
  if ((manager === 'pnpm' || manager === 'yarn') && !BUILTIN_COMMANDS.has(sub)) {
    facts.scripts.push({ name: sub, dirs: where, wide });
    const ran = classify({ words, dirs: where, depth: depth + 1 });
    if (ran.publishes) facts.publishes = true;
    if (ran.tooDeep) {
      facts.tooDeep = true;
      facts.runsCode = true;
    }
  }
  return facts;
};

/** Splits shell text into commands at newlines and the usual command separators. */
const SEGMENT_SEPARATOR = /\n|;|&&|\|\||\||\$\(|\)|`/;

/**
 * Reads normalized shell text command by command. `baseDirs` are the directories
 * the step already runs in (its `working-directory`); a `cd` earlier in the same
 * text adds to them.
 */
export const analyzeShell = ({
  text,
  baseDirs = [],
  actionPathVars
}: {
  text: string;
  baseDirs?: string[];
  /**
   * Set only for the steps of a composite action: the names of environment
   * variables the step sets from `github.action_path`. A `node` command whose
   * script is under that path runs the action's own script, not repository code.
   */
  actionPathVars?: string[];
}): ShellFacts => {
  const facts = noFacts();
  let cwd: string | undefined;
  let source = text.replace(CONTROL_MARK, '');
  if (actionPathVars !== undefined) {
    const names = ['GITHUB_ACTION_PATH', ...actionPathVars].map((n) =>
      n.replace(/[^A-Za-z0-9_]/g, '')
    );
    source = source.replace(/\$\{\{\s*github\.action_path\s*\}\}/g, ACTION_PATH_MARK);
    for (const name of names)
      source = source.replace(
        new RegExp(`\\$(?:\\{${name}\\}|${name}(?![A-Za-z0-9_]))`, 'g'),
        ACTION_PATH_MARK
      );
  }
  for (const segment of normalizeShell(source).split(SEGMENT_SEPARATOR)) {
    const words = commandWords(segment);
    if (words.length === 0) continue;
    if (words[0] === 'cd') {
      cwd = words[1];
      continue;
    }
    const dirs = [...(cwd === undefined ? [] : [cwd]), ...baseDirs];
    merge(facts, classify({ words, dirs }));
  }
  return facts;
};
