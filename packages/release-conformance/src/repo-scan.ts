import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { parse } from 'yaml';

import type { ScriptReader } from './package-scripts.ts';
import type {
  EventModel,
  FileClass,
  JobModel,
  JobScan,
  ScanResult,
  ScannedFile,
  UsesRef,
  WorkflowModel
} from './types.ts';

import {
  ARCHIVED_CALLEE_REPOSITORY,
  CALLEE_PATH,
  CALLEE_REPOSITORY,
  sameRepository
} from './canonical.ts';
import { createScriptReader } from './package-scripts.ts';
import { linkedParent, readRegularFile } from './safe-read.ts';
import { blankSearchPatterns } from './search-patterns.ts';
import {
  analyzeShell,
  isPublishWord,
  publishWordTest,
  registryRunner,
  stripVersion,
  normalizeShell,
  stripShellComments
} from './shell-commands.ts';
import {
  MAX_WORKFLOW_BYTES,
  NPM_TOKEN_KEYS,
  parseWorkflow,
  secretReferences,
  unreadableWorkflow
} from './workflow-model.ts';

export { normalizeShell, stripShellComments };

const WORKFLOW_DIR = '.github/workflows';
const LOCAL_WORKFLOW_PREFIX = './.github/workflows/';
const LOCAL_ACTION_DIR = '.github/actions/';
/**
 * The shared release workflow checks out its own repository to this path and
 * runs actions from it. In that one file of the canonical repository the path
 * stands for the repository root, so its actions can be read from the tree.
 */
const CALLEE_CHECKOUT_PREFIX = '.pipelines/';
/** The action of the shared release workflow that publishes tarballs with the npm client; its script is not shell. */
const CALLEE_PUBLISH_ACTION = '.github/actions/npm-publish-tarballs';

/** The tools whose `publish` subcommand publishes a package. */
const PUBLISH_TOOL = /^(?:npm|pnpm|yarn|lerna|bun|changesets?|@changesets\/cli)$/;
/** Commands that only print their arguments, so a publish named in their text is not a command. */
const PRINTERS = new Set(['echo', 'printf']);
/** A word between the tool and `publish` that still means the tool publishes (it names another runner). */
const RUNNER_WORD = /^(?:exec|dlx|x|run|changesets?|lerna|npm|@changesets\/cli(?:@\S*)?)$/;
/** Anything on a line that turns printed text into something that runs, or reads it as a command. */
const RUNS_PRINTED_TEXT = /\$\(|`|(?:^|[^\w-])(?:eval|xargs)(?![\w-])/;
/**
 * True when a line sends output somewhere with a `>` (`>`, `>>`, `>(…)`, `&>`) outside quotes, but not a
 * descriptor copy such as `2>&1`. An arrow inside printed text (`echo "=> skipping"`) is not a redirect.
 * One pass over the characters, so the cost is linear in the line.
 */
const redirectsOutput = (line: string): boolean => {
  let quote = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
    } else if (char === '\\') at += 1;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>' && line[at + 1] !== '&') return true;
  }
  return false;
};
const SCRIPT_RUNNERS = new Set(['pnpm', 'yarn', 'bun']);
const LEADING_PUNCTUATION = new Set(['(', '{', '$', '"', "'", '`']);
const TRAILING_PUNCTUATION = new Set([')', '}', '"', "'", '`']);

/** Trims shell openers and quotes from both ends of a word, by index so the cost is linear in its length. */
const bareWord = (token: string): string => {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start] ?? '')) start += 1;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1] ?? '')) end -= 1;
  return token.slice(start, end);
};

/** A word read as a tool name: shell quoting and any `@version` or `@tag` suffix removed. */
const toolName = (token: string): string => stripVersion(bareWord(token));

/** The name of the command a tokenised segment runs, past variable assignments and shell keywords. */
const segmentCommand = (tokens: string[]): string => {
  const skipped = new Set([
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
    'time'
  ]);
  for (const token of tokens) {
    if (token === '' || skipped.has(token) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    return bareWord(token).replace(/^.*\//, '');
  }
  return '';
};

/** What the text-level test found: publishes it is sure of, and words that might still be one. */
export interface TextHits {
  confirmed: boolean;
  /** A publish named only as printed text. */
  printed: boolean;
  /** `<tool> <word> publish` where the word is not known to run the tool: the word may be a script name. */
  unknownWord: { tool: string; word: string }[];
}

/**
 * Text-level publish test, the second opinion beside the command parser. Any tool word (`npm`, `pnpm`,
 * `yarn`, `lerna`, `bun`, `changeset(s)`, `@changesets/cli`) followed by flags and then `publish`, in
 * any command, quoted string or heredoc, is a publish: the text cannot say what runs the string, so it
 * fails closed. One word may sit between the tool and `publish`; it keeps the hit confirmed when it is
 * another runner or a flag's possible value, and otherwise leaves a hit for the script lookup. Only an
 * `echo` or `printf` argument that is not piped, substituted, evaluated or passed to `xargs` is text.
 * It reads each line as a list of words in one pass, so its cost is linear however the text is built.
 */
export const textPublishHits = (text: string): TextHits => {
  const hits: TextHits = { confirmed: false, printed: false, unknownWord: [] };
  for (const line of normalizeShell(text).split('\n')) {
    const lineRuns = RUNS_PRINTED_TEXT.test(line);
    const parts = line.split(/([;&|])/);
    for (let at = 0; at < parts.length; at += 2) {
      const tokens = (parts[at] ?? '').split(/\s+/);
      const printer = PRINTERS.has(segmentCommand(tokens));
      const piped = parts[at + 1] === '|';
      // The redirect must belong to this command: `&` separates `2>&1` and `&>` from the next command.
      const separator = parts[at + 1];
      const redirected =
        printer &&
        (redirectsOutput((parts[at] ?? '') + (separator === '&' ? '&' : '')) ||
          (separator === '&' && (parts[at + 2] ?? '').startsWith('>')));
      for (let index = 0; index < tokens.length; index += 1) {
        const tool = toolName(tokens[index] ?? '');
        if (!PUBLISH_TOOL.test(tool)) continue;
        const isPublish = publishWordTest(tool);
        // Flags, the values flags take, and `$VAR` words may all sit before the word that matters; the
        // run ends at the next tool, so every token is read once.
        let next = index + 1;
        let afterFlag = false;
        while (next < tokens.length) {
          const token = tokens[next] ?? '';
          // `publish` is never a flag's value: a flag the check does not know cannot hide it.
          if (isPublish(bareWord(token))) break;
          if (token.startsWith('-')) afterFlag = !token.includes('=');
          else if (token.startsWith('$') || afterFlag) afterFlag = false;
          else break;
          if (PUBLISH_TOOL.test(toolName(token))) break;
          next += 1;
        }
        const word = bareWord(tokens[next] ?? '');
        let hit: 'sure' | 'word' | undefined;
        if (isPublish(word)) hit = 'sure';
        else if (word !== '' && !PUBLISH_TOOL.test(stripVersion(word))) {
          let after = next + 1;
          while ((tokens[after] ?? '').startsWith('-')) after += 1;
          // A runner word before the publish word (`npm run pub`) names a script, so no abbreviation here.
          if (isPublishWord(bareWord(tokens[after] ?? '')))
            hit = RUNNER_WORD.test(word) ? 'sure' : 'word';
        }
        if (hit === undefined) continue;
        if (printer && !lineRuns && !piped && !redirected) hits.printed = true;
        else if (hit === 'sure' || printer) hits.confirmed = true;
        else hits.unknownWord.push({ tool, word });
      }
    }
  }
  return hits;
};

/**
 * A runner word in a name-like context is not a command: `mynpx`, `npxfoo`, `npx-foo`, `@npm/x`. A
 * word right after a written-out escape (`\n`, `\t`) still counts: the text may be printed into a script.
 */
const RUNNER_BINARY_WORD =
  /(?:(?<![A-Za-z0-9_@-])|(?<=\\[nt]))(npx|pnpx|bunx)(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
const MANAGER_WORD =
  /(?:(?<![A-Za-z0-9_@-])|(?<=\\[nt]))(npm|pnpm|yarn|bun)(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;
/** Process substitution (`<(…)`, `>(…)`) runs a command whose output or input is the text. */
const RUNNER_LINE_RUNS = new RegExp(`${RUNS_PRINTED_TEXT.source}|[<>]\\(`);
/** Redirect targets that carry no text anywhere a command could read it back. */
const HARMLESS_TARGET = /^\$\{?GITHUB_STEP_SUMMARY\}?$|^\/dev\/(?:null|stderr)$/;

/**
 * `line.split(/([;&|])/)` that leaves separators inside quotes alone, so `echo "a; npx b"` stays one
 * command, and leaves the `&` of a redirection (`2>&1`, `>&2`, `&>file`) with its command, so a pipe
 * after `2>&1` is still the pipe of that command. A quote that is never closed (prose such as
 * `don't`) gives the plain split instead: the test fails closed rather than hiding the rest of the line.
 */
const splitCommandParts = (line: string): string[] => {
  const parts: string[] = [];
  let current = '';
  let quote = '';
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at] ?? '';
    if (quote !== '') {
      if (char === '\\' && quote === '"') {
        current += char + (line[at + 1] ?? '');
        at += 1;
        continue;
      }
      if (char === quote) quote = '';
      current += char;
    } else if (char === '\\') {
      current += char + (line[at + 1] ?? '');
      at += 1;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (
      char === '&' &&
      (line[at - 1] === '>' || line[at - 1] === '<' || line[at + 1] === '>')
    ) {
      current += char;
    } else if (char === '|' && line[at + 1] === '|') {
      // `||` is the "or" list separator, not a pipe: nothing is piped into the next command.
      parts.push(current, '||');
      current = '';
      at += 1;
    } else if (char === ';' || char === '&' || char === '|') {
      parts.push(current, char);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return quote === '' ? parts : line.split(/([;&|])/);
};

/**
 * True when the command's stdout can leave the command as something a later command reads: a redirect
 * to any file (or process substitution, `$GITHUB_OUTPUT`, `$GITHUB_ENV`) except `$GITHUB_STEP_SUMMARY`,
 * `/dev/null` and stderr (`>&2`, `1>&2`). A redirect of another descriptor (`2>file`) carries no stdout.
 * One pass over the characters, so the cost is linear in the part.
 */
const redirectsStdout = (part: string): boolean => {
  let quote = '';
  for (let at = 0; at < part.length; at += 1) {
    const char = part[at] ?? '';
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '\\') at += 1;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') {
      // Which descriptor: `&>` is both, a digit at the start of a word is that descriptor, none is stdout.
      let from = at;
      while (/[0-9]/.test(part[from - 1] ?? '')) from -= 1;
      const prior = part[from - 1];
      const descriptor =
        from < at && (prior === undefined || /\s/.test(prior)) ? part.slice(from, at) : '';
      const both = part[at - 1] === '&';
      if (descriptor !== '' && descriptor !== '1' && !both) {
        if (part[at + 1] === '>') at += 1;
        continue;
      }
      let next = at + 1;
      if (part[next] === '>' || part[next] === '|') next += 1;
      if (part[next] === '&') {
        const copy = /^[0-9]+|^-/.exec(part.slice(next + 1))?.[0];
        if (copy === '1' || copy === '2' || copy === '-') {
          at = next;
          continue;
        }
        return true;
      }
      while (part[next] === ' ' || part[next] === '\t') next += 1;
      const target = /^[^\s;|&)]*/.exec(part.slice(next))?.[0].replace(/["']/g, '') ?? '';
      if (!HARMLESS_TARGET.test(target)) return true;
      at = next;
    }
  }
  return false;
};

/** The Claude CLI's deny-list flag, in the two spellings it has. Any other spelling is read normally. */
const DENY_FLAG = /^--disallowed(?:Tools|-tools)(?:=|$)/;
/**
 * What a deny entry may not hold: anything the shell or the workflow expands before the CLI sees it
 * (any `$`, a backtick, process substitution), and any quote character, which can break the entry
 * apart so that a part of it is read as shell.
 */
const EXPANDS = /["'`$]|<\(|>\(/;

/** Whitespace-separated words of a text with their offsets, quoted strings kept whole. */
const positionedWords = (text: string): { start: number; end: number }[] => {
  const words: { start: number; end: number }[] = [];
  let at = 0;
  while (at < text.length) {
    while (at < text.length && /\s/.test(text[at] ?? '')) at += 1;
    if (at >= text.length) break;
    const start = at;
    let quote = '';
    while (at < text.length && (quote !== '' || !/\s/.test(text[at] ?? ''))) {
      const char = text[at] ?? '';
      if (char === '\\' && quote !== "'") at += 1;
      else if (quote !== '') {
        if (char === quote) quote = '';
      } else if (char === '"' || char === "'") quote = char;
      at += 1;
    }
    words.push({ start, end: Math.min(at, text.length) });
  }
  return words;
};

const LIST_FLAG = /^--(?:disallowed|allowed)(?:Tools|-tools)(?:=|$)/;
/** Flags that take no value, so the word after one is the next argument. */
const BOOLEAN_FLAGS = new Set(['-p', '--print', '-c', '--continue', '--verbose']);

/**
 * True when the deny-list flag at `index` is read by the Claude CLI as a flag, and not as the value of the
 * option before it (`--system-prompt --disallowedTools "Bash(npx x)"` makes the entry a prompt) or as text
 * after `--`. Fail closed: only a flag right after `claude`, after another deny or allow list, or after a
 * boolean flag (with at most the prompt word between) is known to be one.
 */
const flagIsAtArgumentPosition = ({
  segment,
  words,
  index
}: {
  segment: string;
  words: { start: number; end: number }[];
  index: number;
}): boolean => {
  const at = (position: number): string => {
    const word = words[position];
    return word === undefined ? '' : segment.slice(word.start, word.end);
  };
  const isCommand = (word: string): boolean => word.replace(/^.*\//, '') === 'claude';
  const startsArguments = (word: string): boolean => isCommand(word) || BOOLEAN_FLAGS.has(word);
  const checked = (position: number): boolean => {
    if (position <= 0) return true;
    const before = at(position - 1);
    if (startsArguments(before)) return true;
    if (LIST_FLAG.test(before) && before.endsWith('=')) return false;
    if (/^--(?:disallowed|allowed)(?:Tools|-tools)=./.test(before)) return checked(position - 1);
    if (before.startsWith('-')) return false;
    // A word that is not a flag is the value of the list flag before it, or the prompt after `claude -p`.
    const earlier = at(position - 2);
    if (/^--(?:disallowed|allowed)(?:Tools|-tools)$/.test(earlier)) return checked(position - 2);
    return startsArguments(earlier);
  };
  return checked(index);
};

/** Ranges of the balanced `Bash(…)` entries in a deny-list argument, or undefined when any is not safe to skip. */
const denyEntries = (value: string): [number, number][] | undefined => {
  const ranges: [number, number][] = [];
  let from = value.indexOf('Bash(');
  while (from >= 0) {
    // An entry starts at the start of the argument, after a comma or after whitespace: `mcp__x__Bash(…)` is not one.
    if (from > 0 && !/[,\s]/.test(value[from - 1] ?? '')) {
      from = value.indexOf('Bash(', from + 1);
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let at = from + 4; at < value.length; at += 1) {
      if (value[at] === '(') depth += 1;
      else if (value[at] === ')') {
        depth -= 1;
        if (depth === 0) {
          end = at + 1;
          break;
        }
      }
    }
    if (end < 0 || EXPANDS.test(value.slice(from, end))) return undefined;
    ranges.push([from, end]);
    from = value.indexOf('Bash(', end);
  }
  return ranges;
};

/**
 * Blanks the literal, balanced `Bash(…)` entries of the argument of the Claude CLI's deny-list flag
 * (`--disallowedTools "Bash(npx *)"`): each entry only restricts what an agent may run, so a runner
 * word in it is not a use of the runner. The caller establishes that the text is arguments of the
 * Claude CLI. An unbalanced entry, or one with `$(`, a backtick or `${` in it, leaves the whole
 * argument as it is, and so does any other flag (allow lists are always read). Text outside the
 * entries stays read.
 */
const blankDeniedTools = (segment: string): string => {
  const words = positionedWords(segment);
  let out = segment;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) continue;
    const flag = DENY_FLAG.exec(segment.slice(word.start, word.end));
    if (flag === null || !flagIsAtArgumentPosition({ segment, words, index })) continue;
    let start: number;
    let end: number;
    if (flag[0].endsWith('=')) {
      start = word.start + flag[0].length;
      end = word.end;
    } else {
      const next = words[index + 1];
      if (next === undefined) continue;
      ({ start, end } = next);
    }
    const quoted = /^["']/.test(segment.slice(start, start + 1));
    const inner = quoted
      ? segment.slice(start + 1, segment[end - 1] === segment[start] ? end - 1 : end)
      : segment.slice(start, end);
    const base = start + (quoted ? 1 : 0);
    const entries = denyEntries(inner);
    if (entries === undefined) continue;
    for (const [from, to] of entries)
      out = out.slice(0, base + from) + ' '.repeat(to - from) + out.slice(base + to);
  }
  return out;
};

/** The words of a command part with shell syntax kept in them, split on whitespace. */
const wordsOfPart = (part: string): string[] => part.split(/\s+/).filter((word) => word !== '');

/** Trims quote characters from both ends of a word, by index so the cost is linear in its length. */
const unquoted = (word: string): string => {
  let start = 0;
  let end = word.length;
  while (start < end && QUOTES.has(word[start] ?? '')) start += 1;
  while (end > start && QUOTES.has(word[end - 1] ?? '')) end -= 1;
  return word.slice(start, end);
};
const QUOTES = new Set(['"', "'", '`']);

/**
 * The words that follow a package manager's name in text that may be a command line or code that builds
 * one: a `@version` glued to the name (`pnpm@9.1.0`) is skipped, and quotes, commas and brackets around
 * words are dropped, so `["npm","exec","foo"]` and `('pnpm', ['dlx', 'foo'])` read as `npm exec foo`.
 */
const wordsAfterManager = (text: string): string[] => {
  const glued = text.startsWith('@') ? text.search(/[\s"',[\]()]|$/) : 0;
  return text
    .slice(glued)
    .split(/[\s,[\]]+/)
    .map(unquoted)
    .filter((word) => word !== '');
};

/**
 * Tracks whether the command being read is at the top level of the script: not inside `{ }`, `( )`,
 * `$( )`, a backtick pair, a loop, an `if`, a `case`, or a function body. An echo or a search inside any
 * of them can have its output written or piped by the enclosing construct, which closes on a later
 * word, so none of them is excused. One counter over the whole text; unbalanced closers never go below zero.
 */
interface Nesting {
  depth: number;
  cases: number;
  backtick: boolean;
}
const OPEN_WORDS = new Set(['{', '(', 'if', 'while', 'until', 'for', 'select']);
const CLOSE_WORDS = new Set(['}', ')', 'fi', 'done']);
const NEUTRAL_WORDS = new Set(['then', 'else', 'elif', 'do', '!', 'time']);

/** Reads one command part in order, moves the nesting state past it, and says whether its command word is at the top level. */
const enterPart = ({ state, part }: { state: Nesting; part: string }): boolean => {
  const words = wordsOfPart(part);
  let index = 0;
  for (; index < words.length; index += 1) {
    let word = words[index] ?? '';
    while (word.startsWith('(')) {
      state.depth += 1;
      word = word.slice(1);
    }
    words[index] = word;
    if (word === '' || NEUTRAL_WORDS.has(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      // An assignment may open a substitution on this line (`X=$(`): its characters are counted below.
      if (word !== '' && /^[A-Za-z_]/.test(word) && !NEUTRAL_WORDS.has(word)) break;
      continue;
    }
    if (word === 'case') state.cases += 1;
    else if (word === 'esac') state.cases = Math.max(0, state.cases - 1);
    else if (OPEN_WORDS.has(word)) state.depth += 1;
    else if (CLOSE_WORDS.has(word)) state.depth = Math.max(0, state.depth - 1);
    else break;
  }
  const topLevel = state.depth === 0 && state.cases === 0 && !state.backtick;
  // Parentheses and backticks outside quotes in the rest of the part. Inside a `case` the `)` of every
  // pattern would unbalance the count, and nothing in a `case` is excused anyway.
  let quote = '';
  const rest = words.slice(index).join(' ');
  for (let at = 0; at < rest.length; at += 1) {
    const char = rest[at] ?? '';
    if (quote !== '') {
      if (char === '\\' && quote === '"') at += 1;
      else if (char === quote) quote = '';
    } else if (char === '\\') at += 1;
    else if (char === '"' || char === "'") quote = char;
    else if (char === '`') state.backtick = !state.backtick;
    else if (state.cases === 0 && char === '(') state.depth += 1;
    else if (state.cases === 0 && char === ')') state.depth = Math.max(0, state.depth - 1);
  }
  return topLevel;
};

/**
 * Runner named by a package manager's words: after the manager's name come any number of flags (with
 * or without a value) and then the subcommand. A word after a flag that has no `=` is read both ways,
 * as the flag's value and as the subcommand, so `npm --yes exec foo` and `pnpm -C dir dlx foo` both hit.
 */
const managerRunner = ({
  manager,
  words
}: {
  manager: string;
  words: string[];
}): string | undefined => {
  let afterFlag = false;
  for (let index = 0; index < words.length; index += 1) {
    const token = words[index] ?? '';
    if (RUNNER_MANAGERS.has(runnerToolName(token))) return undefined;
    if (token.startsWith('-')) {
      afterFlag = !token.includes('=');
      continue;
    }
    if (token.startsWith('$')) {
      afterFlag = false;
      continue;
    }
    const sub = bareWord(token).replace(/[;,&|)]+$/, '');
    let arg: string | undefined;
    for (let after = index + 1; after < words.length; after += 1) {
      const candidate = words[after] ?? '';
      if (candidate.startsWith('-')) continue;
      arg = bareWord(candidate);
      break;
    }
    const runner = registryRunner({
      manager,
      sub,
      ...(arg === undefined ? {} : { arg })
    });
    if (runner !== undefined) return runner;
    if (!afterFlag) return undefined;
    afterFlag = false;
  }
  return undefined;
};

const RUNNER_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** A runner word read as a tool: shell quoting, a leading path and any `@version` suffix removed. */
const runnerToolName = (token: string): string => toolName(token).replace(/^.*\//, '');

/**
 * Text-level test for a registry-fetching runner, the second opinion beside the command parser: every
 * `npx`, `pnpx` or `bunx` word, and every `npm|pnpm|yarn|bun` followed by flags (and the values flags
 * may take) and then `exec`, `dlx`, `x`, `create` or `init <package>`, anywhere in the text: a
 * command, a quoted string, a heredoc, a string inside code, an action input. A word counts at any
 * word boundary (`"cd x&&npx foo"`, `(npx foo)`, `=npx`) and not inside a longer name (`mynpx`).
 *
 * Two forms are text and not a command, and only when the command's output cannot run later: it is
 * not piped (including after `2>&1`), not in `$(…)`, backticks or process substitution, not eval'd,
 * not passed to `xargs`, and not redirected anywhere except `$GITHUB_STEP_SUMMARY` and stderr.
 * The forms are the arguments of `echo` and `printf`, and the pattern of `grep`/`egrep`/`fgrep`/`rg`
 * or the match part of a `sed` script. A redirect to `$GITHUB_OUTPUT` or `$GITHUB_ENV` is not excused,
 * because a later step can run what was written there. Each hit carries its source line. One pass over
 * each line, so the cost is linear.
 */
export const textRunnerHits = (
  text: string,
  { claudeArgs = false }: { claudeArgs?: boolean } = {}
): { runner: string; line: string }[] => {
  const hits: { runner: string; line: string }[] = [];
  const nesting: Nesting = { depth: 0, cases: 0, backtick: false };
  for (const line of normalizeShell(text).split('\n')) {
    const lineRuns = RUNNER_LINE_RUNS.test(line);
    const parts = splitCommandParts(claudeArgs ? blankDeniedTools(line) : line);
    for (let at = 0; at < parts.length; at += 2) {
      const rawPart = parts[at] ?? '';
      // Arguments of a command whose program word is `claude` (or a path ending in `/claude`).
      const part =
        segmentCommand(wordsOfPart(rawPart)) === 'claude' ? blankDeniedTools(rawPart) : rawPart;
      const separator = parts[at + 1];
      const topLevel = enterPart({ state: nesting, part: rawPart });
      const textOnly = topLevel && !lineRuns && separator !== '|' && !redirectsStdout(part);
      if (textOnly && PRINTERS.has(segmentCommand(wordsOfPart(part)))) continue;
      const searched = textOnly ? blankSearchPatterns(part) : part;
      for (const match of searched.matchAll(RUNNER_BINARY_WORD))
        hits.push({ runner: match[1] ?? '', line });
      for (const match of searched.matchAll(MANAGER_WORD)) {
        const manager = match[1] ?? '';
        const runner = managerRunner({
          manager,
          words: wordsAfterManager(searched.slice((match.index ?? 0) + manager.length))
        });
        if (runner !== undefined) hits.push({ runner, line });
      }
    }
  }
  return hits;
};

/** Arguments of a tag-only command: plain words and flags, with no quoting or shell syntax. */
const TAG_ARGUMENT = /^[\w./:@-]+$/;
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn']);
const NPM_TOKEN_NAME = /npm/i;

/** True when the text-level test sees any publish, sure or not, in the text. */
export const textSeesPublish = (text: string): boolean => {
  const hits = textPublishHits(text);
  return hits.confirmed || hits.printed || hits.unknownWord.length > 0;
};

export const runsPublishText = (text: string): boolean =>
  analyzeShell({ text }).publishes || textSeesPublish(text);

/**
 * Tokenised rather than one pattern with nested repetition, so the cost stays
 * linear in the length of a line whatever the workflow text holds.
 */
const isTagOnlyLine = (line: string): boolean => {
  const tokens = line.split(/\s+/);
  let at = 0;
  if (PACKAGE_MANAGERS.has(tokens[0] ?? '')) {
    at = tokens[1] === 'exec' || tokens[1] === 'run' ? 2 : 1;
  }
  const [command, second, third] = [tokens[at], tokens[at + 1], tokens[at + 2]];
  if ((command === 'changeset' || command === 'changesets') && second === 'tag') at += 2;
  else if (command === 'git' && second === 'tag') at += 2;
  else if (command === 'git' && second === 'push' && third === '--tags') at += 3;
  else return false;
  return tokens.slice(at).every((token) => TAG_ARGUMENT.test(token));
};

/** A `publish` input whose every line only creates tags does not publish a package. */
export const isTagOnly = (command: string): boolean =>
  command
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every(isTagOnlyLine);

/** A secret whose name mentions npm, or any value under the variable names the npm client reads. */
const mentionsNpmSecret = (text: string): boolean =>
  secretReferences(text).some((name) => NPM_TOKEN_NAME.test(name));

const isNpmTokenRef = ({ key, expression }: { key: string; expression: string }): boolean =>
  NPM_TOKEN_KEYS.has(key.toUpperCase()) || mentionsNpmSecret(expression);

export const isSharedCallee = (uses: UsesRef): boolean => {
  if (uses.local) return uses.path === `./${CALLEE_PATH}`;
  if (uses.repo === 'pipelines' && uses.path === CALLEE_PATH) return true;
  return (
    `${uses.owner}/${uses.repo}` === ARCHIVED_CALLEE_REPOSITORY.toLowerCase() &&
    uses.path.startsWith(`${WORKFLOW_DIR}/`) &&
    uses.path.includes('npm-release')
  );
};

export interface CompositeStep {
  run?: string;
  uses?: string;
  local: boolean;
  with: Record<string, string>;
  /** Environment variables the step sets from `github.action_path`. */
  actionPathVars: string[];
}

export type ActionRead =
  | { ok: true; steps: CompositeStep[]; text: string }
  | { ok: false; reason: string; steps?: CompositeStep[]; text?: string };

/**
 * Reads one local composite action: only under `.github/actions/`, which the
 * checker's checkout holds, and only its own steps. Anything else (a path
 * elsewhere, a missing file, a node or docker action, a second level of local
 * action) is reported as unreadable rather than assumed harmless.
 */
export const readLocalAction = ({
  root,
  path,
  calleeContext
}: {
  root: string;
  path: string;
  calleeContext: boolean;
}): ActionRead => {
  let relative = posix.normalize(path.replace(/^\.\//, ''));
  if (calleeContext && relative.startsWith(CALLEE_CHECKOUT_PREFIX))
    relative = relative.slice(CALLEE_CHECKOUT_PREFIX.length);
  if (!relative.startsWith(LOCAL_ACTION_DIR))
    return { ok: false, reason: 'it is outside `.github/actions/`, which the check reads' };
  const linked = linkedParent({ root, relative });
  if (linked !== undefined)
    return { ok: false, reason: `\`${linked}\` is a link, which the check does not follow` };
  for (const name of ['action.yml', 'action.yaml']) {
    const file = join(root, relative, name);
    let text: string;
    try {
      const read = readRegularFile({ path: file, maxBytes: MAX_WORKFLOW_BYTES });
      if (read.kind !== 'text') continue;
      text = read.text;
    } catch {
      continue;
    }
    try {
      const doc: unknown = parse(text, { maxAliasCount: 50 });
      if (typeof doc !== 'object' || doc === null || !('runs' in doc))
        return { ok: false, reason: 'it has no `runs` block' };
      const runs = doc.runs;
      if (
        typeof runs !== 'object' ||
        runs === null ||
        !('using' in runs) ||
        runs.using !== 'composite' ||
        !('steps' in runs) ||
        !Array.isArray(runs.steps)
      )
        return { ok: false, reason: 'it is not a composite action, so its code is not read' };
      const steps = runs.steps.map((step: unknown): CompositeStep => {
        const out: CompositeStep = { local: false, with: {}, actionPathVars: [] };
        if (typeof step !== 'object' || step === null) return out;
        if ('run' in step && typeof step.run === 'string') out.run = step.run;
        if ('uses' in step && typeof step.uses === 'string') {
          out.uses = step.uses;
          out.local = step.uses.startsWith('./');
        }
        if ('env' in step && typeof step.env === 'object' && step.env !== null) {
          for (const [key, value] of Object.entries(step.env)) {
            if (/github\.action_path|GITHUB_ACTION_PATH/.test(String(value)))
              out.actionPathVars.push(key);
          }
        }
        if ('with' in step && typeof step.with === 'object' && step.with !== null) {
          for (const [key, value] of Object.entries(step.with)) out.with[key] = String(value);
        }
        return out;
      });
      if (steps.some((step) => step.local))
        return {
          ok: false,
          reason: 'it uses a further local action, which the check does not follow',
          steps,
          text
        };
      return { ok: true, steps, text };
    } catch {
      return { ok: false, reason: 'it could not be parsed' };
    }
  }
  return { ok: false, reason: 'no `action.yml` was found there' };
};

const isChangesetsAction = (uses: string | undefined): boolean =>
  uses !== undefined && /^changesets\/action@/i.test(uses);

const changesetsPublishesPackages = (withInputs: Record<string, string>): boolean => {
  const command = withInputs['publish'] ?? withInputs['publish-script'] ?? '';
  return command.trim() !== '' && !isTagOnly(command);
};

interface ScanEnvironment {
  root: string;
  reader: ScriptReader;
  /** The file is the shared release workflow of the canonical repository, by the run's own identity. */
  calleeContext: boolean;
}

const scanJob = ({ job, env }: { job: JobModel; env: ScanEnvironment }): JobScan => {
  const runs: string[] = [];
  let publishes = false;
  /** Text that only names a publish (printed, or a word that may be a script): a person confirms it. */
  let printedPublish = false;
  let wordPublish = false;
  let tooDeep = false;
  let runsCode = false;
  let idToken = false;
  let npmToken = false;
  const unreadable: JobScan['unreadableActions'] = [];
  const unresolved = new Set<string>();
  const eff = job.effectivePermissions;
  if (eff.all === 'write-all' || eff.scopes['id-token'] === 'write') idToken = true;
  if (job.envSecretRefs.some(isNpmTokenRef)) npmToken = true;
  if (
    Object.entries(job.withValues).some(([key, expression]) => isNpmTokenRef({ key, expression }))
  )
    npmToken = true;

  /**
   * The text-level test over any string a job hands to something that may run it. A word between
   * `pnpm`/`yarn`/`bun` and `publish` that names a package script is decided by that script's body,
   * one level down; any other word leaves a possible publish.
   */
  const noteText = ({
    text,
    baseDirs,
    lookup
  }: {
    text: string;
    baseDirs: string[];
    lookup: boolean;
  }): void => {
    const hits = textPublishHits(text);
    if (hits.confirmed) publishes = true;
    if (hits.printed) printedPublish = true;
    for (const { tool, word } of hits.unknownWord) {
      const found =
        lookup && SCRIPT_RUNNERS.has(tool)
          ? env.reader.lookup({ name: word, dirs: baseDirs, wide: true })
          : undefined;
      if (found === undefined || !found.defined) {
        wordPublish = true;
        continue;
      }
      for (const body of found.bodies) {
        if (analyzeShell({ text: body }).publishes) publishes = true;
        noteText({ text: body, baseDirs: [], lookup: false });
      }
    }
  };

  const readShell = ({
    text,
    baseDirs,
    actionPathVars
  }: {
    text: string;
    baseDirs: string[];
    actionPathVars?: string[];
  }): void => {
    runs.push(normalizeShell(text));
    const facts = analyzeShell({
      text,
      baseDirs,
      ...(actionPathVars === undefined ? {} : { actionPathVars })
    });
    if (facts.publishes) publishes = true;
    noteText({ text, baseDirs, lookup: true });
    if (facts.tooDeep) tooDeep = true;
    if (facts.runsCode) runsCode = true;
    for (const ref of facts.scripts) {
      const found = env.reader.lookup(ref);
      if (!found.defined && ref.optional !== true) unresolved.add(ref.name);
      // One level only: the script body itself must hold an explicit publish command.
      for (const body of found.bodies) {
        const inner = analyzeShell({ text: body });
        if (inner.publishes) publishes = true;
        noteText({ text: body, baseDirs: [], lookup: false });
        if (inner.tooDeep) tooDeep = true;
      }
    }
  };

  const readInput = (value: string, baseDirs: string[]): void => {
    if (analyzeShell({ text: value, baseDirs }).publishes) publishes = true;
    noteText({ text: value, baseDirs, lookup: true });
  };

  for (const step of job.steps) {
    const dir = step.workingDirectory ?? job.workingDirectory;
    const baseDirs = dir === undefined ? [] : [dir];
    if (step.run !== undefined) {
      readShell({ text: step.run, baseDirs });
      // A token written straight into a command (for example an `.npmrc` line) is still a credential.
      if (mentionsNpmSecret(step.run)) npmToken = true;
    }
    if (step.envSecretRefs.some(isNpmTokenRef)) npmToken = true;
    if (Object.entries(step.with).some(([key, expression]) => isNpmTokenRef({ key, expression })))
      npmToken = true;
    if (isChangesetsAction(step.uses?.raw) && changesetsPublishesPackages(step.with))
      publishes = true;
    // A string handed to an action as an input can be a command the action runs (a retry wrapper's `command`).
    if (step.uses !== undefined)
      for (const value of Object.values(step.with)) readInput(value, baseDirs);
    if (step.uses?.local) {
      const read = readLocalAction({
        root: env.root,
        path: step.uses.path,
        calleeContext: env.calleeContext
      });
      if (!read.ok) {
        unreadable.push({ path: step.uses.raw, reason: read.reason });
        continue;
      }
      if (
        env.calleeContext &&
        posix.normalize(step.uses.path.replace(/^\.\//, '')) ===
          `${CALLEE_CHECKOUT_PREFIX}${CALLEE_PUBLISH_ACTION}`
      )
        publishes = true;
      // Only an action that does not come from the repository under review has its own
      // directory outside what the change can alter; in a reviewed repository the
      // action's directory is repository code like any other.
      const external =
        env.calleeContext &&
        posix.normalize(step.uses.path.replace(/^\.\//, '')).startsWith(CALLEE_CHECKOUT_PREFIX);
      for (const inner of read.steps) {
        if (inner.run !== undefined)
          readShell({
            text: inner.run,
            baseDirs: [],
            ...(external ? { actionPathVars: inner.actionPathVars } : {})
          });
        if (isChangesetsAction(inner.uses) && changesetsPublishesPackages(inner.with))
          publishes = true;
        if (inner.uses !== undefined)
          for (const value of Object.values(inner.with)) readInput(value, []);
      }
    }
  }
  // A publish the text names with an unknown word is, in a job with an npm token, still a publish for
  // the token rules; without one it is a possible publish for a person to confirm. Printed text
  // never classifies a job.
  const confirmed = publishes || (wordPublish && npmToken);
  return {
    jobId: job.id,
    runText: runs.join('\n'),
    holdsPublishCredential: idToken || npmToken,
    holdsIdToken: idToken,
    holdsNpmToken: npmToken,
    runsPublishCommand: confirmed,
    possiblePublish: (printedPublish || wordPublish) && !confirmed && idToken,
    commandTooDeep: tooDeep,
    runsRepositoryCode: runsCode,
    unreadableActions: unreadable,
    unresolvedScripts: [...unresolved]
  };
};

const classify = ({ model, jobs }: { model: WorkflowModel; jobs: JobScan[] }): FileClass => {
  if (model.parseError !== undefined) return 'unparseable';
  if (model.jobs.some((job) => job.uses !== undefined && isSharedCallee(job.uses)))
    return 'shared-caller';
  if (jobs.some((job) => job.holdsPublishCredential && job.runsPublishCommand))
    return 'bespoke-publisher';
  return 'not-in-scope';
};

const listWorkflowFiles = (root: string): string[] => {
  // The workflow directory itself is only listed when no part of its path is a link.
  if (linkedParent({ root, relative: WORKFLOW_DIR }) !== undefined) return [];
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/i.test(name))
    .sort()
    .map((name) => `${WORKFLOW_DIR}/${name}`);
};

/**
 * Reads one workflow entry without following links. A directory is not a
 * workflow file and is skipped; any other entry that is not a regular file
 * (a link, for example) is reported as unreadable instead of being followed.
 */
const readWorkflow = ({
  root,
  file
}: {
  root: string;
  file: string;
}): WorkflowModel | undefined => {
  const path = join(root, file);
  const read = readRegularFile({ path, maxBytes: MAX_WORKFLOW_BYTES });
  if (read.kind === 'directory') return undefined;
  if (read.kind === 'missing' || read.kind === 'not-regular') {
    return unreadableWorkflow({ file, reason: 'the entry is not a regular file and was not read' });
  }
  if (read.kind === 'too-large') {
    return unreadableWorkflow({ file, reason: `file is larger than ${MAX_WORKFLOW_BYTES} bytes` });
  }
  return parseWorkflow({ file, text: read.text });
};

/**
 * Events that can start a workflow. A reusable workflow is started by whatever
 * starts its local callers, so its entry events are the union over them; with no
 * local caller it stays callable from outside and reports `workflow_call`.
 */
const entryEventsOf = ({
  file,
  models,
  callers,
  seen
}: {
  file: string;
  models: Map<string, WorkflowModel>;
  callers: Map<string, string[]>;
  seen: Set<string>;
}): EventModel[] => {
  const model = models.get(file);
  if (!model || seen.has(file)) return [];
  const visited = new Set(seen).add(file);
  const own = model.events.filter((event) => event.name !== 'workflow_call');
  const reusable = model.events.find((event) => event.name === 'workflow_call');
  if (!reusable) return own;
  const localCallers = callers.get(file) ?? [];
  if (localCallers.length === 0) return [...own, reusable];
  const inherited = localCallers.flatMap((caller) =>
    entryEventsOf({ file: caller, models, callers, seen: visited })
  );
  return [...own, ...inherited];
};

/**
 * The workflow file a job calls inside this repository, or undefined. A call by
 * `./.github/workflows/<file>` and a call by `<this repository>/.github/workflows/<file>@<ref>`
 * both reach a file of this tree, so both count as local callers.
 */
export const localCallee = ({ uses, repository }: { uses: UsesRef; repository: string }) => {
  if (uses.local) {
    return uses.raw.startsWith(LOCAL_WORKFLOW_PREFIX) ? uses.raw.replace(/^\.\//, '') : undefined;
  }
  if (
    repository !== '' &&
    `${uses.owner}/${uses.repo}` === repository.toLowerCase() &&
    uses.path.startsWith(`${WORKFLOW_DIR}/`)
  )
    return uses.path;
  return undefined;
};

export const scanRepo = ({
  root,
  repository = ''
}: {
  root: string;
  /** `<owner>/<repo>` the tree belongs to; lets a call that names this repository count as local. */
  repository?: string;
}): ScanResult => {
  const models = new Map<string, WorkflowModel>();
  const linked = linkedParent({ root, relative: WORKFLOW_DIR });
  if (linked !== undefined) {
    // Reported as an unreadable workflow so the run fails instead of passing over a tree it never read.
    models.set(
      WORKFLOW_DIR,
      unreadableWorkflow({
        file: WORKFLOW_DIR,
        reason: `\`${linked}\` is a link and was not followed`
      })
    );
  }
  for (const file of listWorkflowFiles(root)) {
    const model = readWorkflow({ root, file });
    if (model) models.set(file, model);
  }

  const callers = new Map<string, string[]>();
  for (const model of models.values()) {
    for (const job of model.jobs) {
      const callee = job.uses ? localCallee({ uses: job.uses, repository }) : undefined;
      if (callee !== undefined) callers.set(callee, [...(callers.get(callee) ?? []), model.file]);
    }
  }

  const reader = createScriptReader(root);
  const files: ScannedFile[] = [...models.values()].map((model) => {
    const env: ScanEnvironment = {
      root,
      reader,
      calleeContext:
        model.file === CALLEE_PATH && sameRepository({ a: repository, b: CALLEE_REPOSITORY })
    };
    const jobs = model.jobs.map((job) => scanJob({ job, env }));
    return {
      model,
      class: classify({ model, jobs }),
      jobs,
      entryEvents: entryEventsOf({ file: model.file, models, callers, seen: new Set() }),
      localCallers: callers.get(model.file) ?? []
    };
  });
  return { root, files };
};
