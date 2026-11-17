/**
 * The pattern argument of a search command is text to match, not a command, so a runner name in it
 * (`! grep -nE "npx |pnpm dlx" file`, `sed -n '/npx/p'`) is no use of the runner. Only the forms read
 * here are excused, and only when every flag before the pattern is one this file knows: a command it
 * cannot read with certainty is left as it is, so the runner name in it still counts.
 */

interface Word {
  start: number;
  end: number;
  text: string;
}

/** Whitespace-separated words of one command, with quoted strings kept whole. */
const wordsOf = (text: string): Word[] => {
  const words: Word[] = [];
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
    words.push({
      start,
      end: Math.min(at, text.length),
      text: text.slice(start, Math.min(at, text.length))
    });
  }
  return words;
};

const blank = ({ text, start, end }: { text: string; start: number; end: number }): string =>
  text.slice(0, start) + ' '.repeat(Math.max(0, end - start)) + text.slice(end);

const LEADING = new Set([
  '!',
  'if',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'do',
  'time',
  '{',
  '('
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Flags {
  /** Short flag letters that take no value. */
  plain: string;
  /** Short flag letters whose value is the rest of the word or the next word. */
  valued: string;
  /** Long flags that take no value. */
  longPlain: ReadonlySet<string>;
}

const GREP: Flags = {
  plain: 'EFGPHhIiLlnoqRrsTUVvwxzabcpuZ0123456789',
  valued: 'fmABCdD',
  longPlain: new Set([
    '--ignore-case',
    '--extended-regexp',
    '--fixed-strings',
    '--basic-regexp',
    '--perl-regexp',
    '--line-number',
    '--recursive',
    '--quiet',
    '--silent',
    '--count',
    '--files-with-matches',
    '--files-without-match',
    '--no-messages',
    '--invert-match',
    '--word-regexp',
    '--line-regexp',
    '--text',
    '--only-matching',
    '--no-filename',
    '--with-filename'
  ])
};
const RG: Flags = {
  plain: 'ncilFwxvaHhIJLloqsSuUVNpPzZb',
  valued: 'ABCgtTjmEfrdM',
  longPlain: GREP.longPlain
};

/** Blanks the pattern argument of a `grep`, `egrep`, `fgrep` or `rg` command, or returns the text unchanged when in doubt. */
const blankGrep = ({ text, args, flags }: { text: string; args: Word[]; flags: Flags }): string => {
  let out = text;
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (word.text === '--') {
      const pattern = args[index + 1];
      if (!found && pattern !== undefined)
        out = blank({ text: out, start: pattern.start, end: pattern.end });
      return out;
    }
    if (word.text.startsWith('--')) {
      if (word.text === '--regexp') {
        const pattern = args[index + 1];
        if (pattern === undefined) return text;
        out = blank({ text: out, start: pattern.start, end: pattern.end });
        found = true;
        index += 1;
      } else if (word.text.startsWith('--regexp=')) {
        out = blank({ text: out, start: word.start + '--regexp='.length, end: word.end });
        found = true;
      } else if (!word.text.includes('=') && !flags.longPlain.has(word.text)) return text;
      continue;
    }
    if (word.text.startsWith('-') && word.text.length > 1) {
      const cluster = word.text.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const char = cluster[at] ?? '';
        if (char === 'e') {
          if (at + 1 < cluster.length)
            out = blank({ text: out, start: word.start + 2 + at, end: word.end });
          else {
            const pattern = args[index + 1];
            if (pattern === undefined) return text;
            out = blank({ text: out, start: pattern.start, end: pattern.end });
            index += 1;
          }
          found = true;
          break;
        }
        if (flags.valued.includes(char)) {
          if (at + 1 >= cluster.length) index += 1;
          break;
        }
        if (!flags.plain.includes(char)) return text;
      }
      continue;
    }
    if (!found) {
      out = blank({ text: out, start: word.start, end: word.end });
      found = true;
    }
    return out;
  }
  return found ? out : text;
};

/** End of an `/`-style delimited part starting at `from`, skipping escaped characters; undefined when it never closes. */
const closing = ({
  script,
  from,
  delimiter
}: {
  script: string;
  from: number;
  delimiter: string;
}) => {
  for (let at = from; at < script.length; at += 1) {
    if (script[at] === '\\') at += 1;
    else if (script[at] === delimiter) return at;
  }
  return undefined;
};

/** Blanks the match part of a sed script: `/re/` addresses and the regex of an `s` command. */
const blankSedScript = ({ text, script }: { text: string; script: Word }): string => {
  const quoted = script.text.startsWith('"') || script.text.startsWith("'");
  const base = script.start + (quoted ? 1 : 0);
  const body = script.text.slice(quoted ? 1 : 0, quoted ? -1 : undefined);
  let out = text;
  let at = 0;
  const skip = (chars: string): void => {
    while (at < body.length && chars.includes(body[at] ?? '')) at += 1;
  };
  skip(' \t');
  while (body[at] === '/') {
    const end = closing({ script: body, from: at + 1, delimiter: '/' });
    if (end === undefined) return out;
    out = blank({ text: out, start: base + at + 1, end: base + end });
    at = end + 1;
    skip('IM');
    if (body[at] === ',') at += 1;
  }
  skip(' \t!');
  if (body[at] === 's' && at + 1 < body.length) {
    const delimiter = body[at + 1] ?? '/';
    const end = closing({ script: body, from: at + 2, delimiter });
    if (end !== undefined) out = blank({ text: out, start: base + at + 2, end: base + end });
  }
  return out;
};

const blankSed = ({ text, args }: { text: string; args: Word[] }): string => {
  let out = text;
  let found = false;
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index];
    if (word === undefined) break;
    if (word.text.startsWith('--')) {
      if (
        !/^--(?:quiet|silent|regexp-extended|posix|debug|separate|null-data|unbuffered|in-place(?:=\S*)?|sandbox|follow-symlinks|binary|line-length=\d+)$/.test(
          word.text
        )
      )
        return text;
      continue;
    }
    if (word.text.startsWith('-') && word.text.length > 1) {
      const cluster = word.text.slice(1);
      for (let at = 0; at < cluster.length; at += 1) {
        const char = cluster[at] ?? '';
        if (char === 'e') {
          const script = args[index + 1];
          if (at + 1 < cluster.length || script === undefined) return text;
          out = blankSedScript({ text: out, script });
          found = true;
          index += 1;
          break;
        }
        if (char === 'f' || char === 'l') {
          if (at + 1 >= cluster.length) index += 1;
          break;
        }
        // `-i` may carry a backup suffix glued to it; the rest of the word is that suffix.
        if (char === 'i') break;
        if (!'nErszub'.includes(char)) return text;
      }
      continue;
    }
    if (!found) out = blankSedScript({ text: out, script: word });
    return out;
  }
  return out;
};

/**
 * One command's text with the pattern of a `grep`/`egrep`/`fgrep`/`rg` and the match part of a `sed`
 * script replaced by spaces; unchanged for any other command. The search tool must be the command
 * itself (after `!`, `if`, `time` and variable assignments): behind any other wrapper it is not read.
 */
export const blankSearchPatterns = (command: string): string => {
  const words = wordsOf(command);
  let index = 0;
  while (index < words.length) {
    const text = words[index]?.text ?? '';
    if (LEADING.has(text) || ASSIGNMENT.test(text)) index += 1;
    else break;
  }
  const name = (words[index]?.text ?? '').replace(/^.*\//, '');
  const args = words.slice(index + 1);
  if (name === 'grep' || name === 'egrep' || name === 'fgrep')
    return blankGrep({ text: command, args, flags: GREP });
  if (name === 'rg') return blankGrep({ text: command, args, flags: RG });
  if (name === 'sed') return blankSed({ text: command, args });
  return command;
};
