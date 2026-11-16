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
}

const noFacts = (): ShellFacts => ({ publishes: false, runsCode: false, scripts: [] });

const merge = (into: ShellFacts, from: ShellFacts): void => {
  if (from.publishes) into.publishes = true;
  if (from.runsCode) into.runsCode = true;
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
  'time',
  'env',
  'sudo',
  'command',
  'nohup',
  'corepack'
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DIR_FLAGS = new Set(['--dir', '-C', '--prefix', '--cwd']);
const WIDE_FLAGS = new Set(['-r', '--recursive', '--workspaces', '-ws', '--filter', '-F']);

/** Flags that take a separate value, so the value is not the subcommand. */
const flagTakesValue = ({ manager, flag }: { manager: string; flag: string }): boolean => {
  if (DIR_FLAGS.has(flag) || flag === '--filter' || flag === '-F') return true;
  if (flag === '--workspace') return true;
  if (flag === '-w') return manager === 'npm';
  return flag === '--package' || flag === '-p';
};

const unquote = (token: string): string => token.replace(/^["'`]+|["'`]+$/g, '');

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
      // A quoted value may hold spaces: skip to the word that closes the quote.
      const value = token.slice(token.indexOf('=') + 1);
      const open = value[0];
      index += 1;
      if ((open === '"' || open === "'") && !(value.length > 1 && value.endsWith(open))) {
        while (index < raw.length && !(raw[index] ?? '').endsWith(open)) index += 1;
        index += 1;
      }
      continue;
    }
    break;
  }
  return raw.slice(index).map(unquote);
};

const basename = (word: string): string => word.replace(/^.*\//, '');

const classify = ({ words, dirs }: { words: string[]; dirs: string[] }): ShellFacts => {
  const [first = '', ...rest] = words;
  const name = basename(first);
  if (PACKAGE_MANAGERS.has(name)) return classifyManager({ manager: name, rest, dirs });
  if (BINARY_RUNNERS.has(name)) return classifyExec({ rest, dirs });
  if (name === 'changeset' || name === 'changesets') {
    return { ...noFacts(), publishes: firstWord(rest) === 'publish' };
  }
  if (name === 'node') return { ...noFacts(), runsCode: !runsOwnActionScript(rest) };
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

const firstWord = (tokens: string[]): string | undefined => tokens.find((t) => !t.startsWith('-'));

/** `<runner> [flags] <command ...>`: runs another command, which is repository code unless it only publishes. */
const classifyExec = ({ rest, dirs }: { rest: string[]; dirs: string[] }): ShellFacts => {
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
  const facts = classify({ words: inner, dirs });
  return { publishes: facts.publishes, runsCode: !facts.publishes, scripts: facts.scripts };
};

const classifyManager = ({
  manager,
  rest,
  dirs
}: {
  manager: string;
  rest: string[];
  dirs: string[];
}): ShellFacts => {
  const facts = noFacts();
  const flagDirs: string[] = [];
  let wide = false;
  const words: string[] = [];
  let subIndex = -1;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (token.startsWith('-')) {
      const [flag = '', inline] = token.split('=', 2);
      if (WIDE_FLAGS.has(flag) || (flag === '-w' && manager === 'npm') || flag === '--workspace')
        wide = true;
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
  if (sub === undefined) {
    // A bare `yarn` installs dependencies.
    facts.runsCode = manager === 'yarn';
    return facts;
  }
  if (sub === 'foreach' || sub === 'workspaces') wide = true;
  if (sub === 'publish') {
    facts.publishes = true;
    return facts;
  }
  if (WRAPPING_SUBCOMMANDS.has(sub) && words.slice(1).includes('publish')) {
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
    return classifyExec({ rest: rest.slice(subIndex + 1), dirs: where });
  }
  if (CODE_SUBCOMMANDS.has(sub) || CODE_SCRIPTS.test(sub)) {
    facts.runsCode = true;
    return facts;
  }
  // `pnpm <script>` and `yarn <script>` run a package script by name.
  if ((manager === 'pnpm' || manager === 'yarn') && !BUILTIN_COMMANDS.has(sub)) {
    facts.scripts.push({ name: sub, dirs: where, wide });
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
