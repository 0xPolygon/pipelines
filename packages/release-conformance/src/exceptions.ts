import { Parser } from 'yaml';

import type { ActiveException, Finding, ScannedFile } from './types.ts';

/** The comment keyword that introduces an exception. One constant so a rename is a one-line change. */
export const EXCEPTION_MARKER = 'release-conformance-exception';

/** An exception may reach at most this many days past today (UTC), about one year. */
export const MAX_EXCEPTION_DAYS = 366;

export const WAIVABLE_RULE_IDS: readonly string[] = [
  'caller/callee',
  'caller/events',
  'caller/permissions-ceiling',
  'caller/permissions-floor',
  'caller/secrets',
  'caller/inputs',
  'publisher/split',
  'publisher/no-cache',
  'publisher/environment',
  'publisher/events',
  // Waivable for now: a publishing workflow_dispatch may still be waived with a dated marker.
  'publisher/publishing-dispatch',
  'publisher/unreadable-local-action',
  'publisher/possible-publish',
  'runner/registry-fetch'
];

/**
 * Rules that protect the publishing credential itself: untrusted triggers, inherited secrets, and
 * the publishing token reaching a job that runs repository or dependency code. A marker for one of
 * these is refused, never honoured. Each id names exactly one condition, so waiving a neighbouring
 * rule never unlocks one of these.
 */
export const NEVER_WAIVABLE_RULE_IDS: readonly string[] = [
  'caller/secrets-inherit',
  'caller/pull-request-target',
  'caller/publish-permission-scope',
  'publisher/pull-request-target',
  'publisher/id-token-with-code',
  'publisher/token-with-code',
  // A registry fetch at run time in a job holding a publishing credential runs code the lockfile never vouched for.
  'runner/registry-fetch-with-credential'
];

const DAY_MS = 86_400_000;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch milliseconds of a real calendar date `YYYY-MM-DD` at UTC midnight, or undefined. */
const parseUtcDate = (value: string): number | undefined => {
  if (!DATE_SHAPE.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(time)) return undefined;
  return new Date(time).toISOString().startsWith(value) ? time : undefined;
};

interface CommentToken {
  offset: number;
  source: string;
}

const isCommentToken = (value: object): value is CommentToken & { type: 'comment' } =>
  'type' in value &&
  value.type === 'comment' &&
  'offset' in value &&
  typeof value.offset === 'number' &&
  'source' in value &&
  typeof value.source === 'string';

const visit = (value: unknown, out: CommentToken[]): void => {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, out);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  if (isCommentToken(value)) out.push({ offset: value.offset, source: value.source });
  for (const child of Object.values(value)) visit(child, out);
};

/**
 * Real YAML comments only. Reading the token stream (not the raw lines) keeps a `#` line inside a
 * `run:` block or a quoted string from counting as a marker.
 */
const readComments = (text: string): { line: number; text: string }[] => {
  const found: CommentToken[] = [];
  for (const token of new Parser().parse(text)) visit(token, found);
  return found.map(({ offset, source }) => {
    let line = 1;
    for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
    return { line, text: source };
  });
};

/** Matched case-insensitively so a marker in the wrong case is reported, not silently ignored. */
const MARKER_COMMENT = new RegExp(`^#\\s*(${EXCEPTION_MARKER}):(.*)$`, 'is');

type Parsed =
  | { ok: true; ruleId: string; until: string; reason: string }
  | { ok: false; problem: string };

const parseMarker = ({ body, today }: { body: string; today: string }): Parsed => {
  const match = /^\s*(\S+)\s+until\s+(\S+)(?:\s+(.*\S))?\s*$/s.exec(body);
  if (!match) {
    return {
      ok: false,
      problem: `expected "${EXCEPTION_MARKER}: <rule id> until <YYYY-MM-DD> <reason>"`
    };
  }
  const [, ruleId = '', until = '', reason = ''] = match;
  if (!WAIVABLE_RULE_IDS.includes(ruleId) && !NEVER_WAIVABLE_RULE_IDS.includes(ruleId)) {
    return { ok: false, problem: `"${ruleId}" is not a rule id` };
  }
  const untilTime = parseUtcDate(until);
  if (untilTime === undefined) {
    return { ok: false, problem: `"${until}" is not a calendar date in YYYY-MM-DD form` };
  }
  if (reason.trim() === '') return { ok: false, problem: 'a reason is required after the date' };
  const todayTime = parseUtcDate(today);
  if (todayTime === undefined) return { ok: false, problem: 'the current date is not valid' };
  if (untilTime < todayTime) return { ok: false, problem: `the exception expired on ${until}` };
  if ((untilTime - todayTime) / DAY_MS > MAX_EXCEPTION_DAYS) {
    return { ok: false, problem: `the date is more than ${MAX_EXCEPTION_DAYS} days ahead` };
  }
  return { ok: true, ruleId, until, reason: reason.trim() };
};

const invalid = ({
  file,
  line,
  message
}: {
  file: string;
  line: number;
  message: string;
}): Finding => ({ ruleId: 'exception/invalid', file, line, message, severity: 'error' });

/**
 * Reads exception markers from each file's comments and applies them: a valid marker removes that
 * rule's findings in its own file and is reported as an active exception. A marker that is
 * malformed, expired, too far ahead, for an unknown rule, or for a rule that cannot be waived is an
 * `exception/invalid` finding and waives nothing. A valid marker with nothing to waive is a notice.
 * `today` is a UTC `YYYY-MM-DD` date supplied by the caller.
 */
export const applyExceptions = ({
  findings,
  files,
  today
}: {
  findings: Finding[];
  files: ScannedFile[];
  today: string;
}): { findings: Finding[]; exceptions: ActiveException[] } => {
  const added: Finding[] = [];
  const exceptions: ActiveException[] = [];
  const waived = new Set<Finding>();

  for (const { model } of files) {
    for (const comment of readComments(model.text)) {
      const match = MARKER_COMMENT.exec(comment.text);
      if (!match) continue;
      const { line } = comment;
      if (match[1] !== EXCEPTION_MARKER) {
        added.push(
          invalid({
            file: model.file,
            line,
            message: `Exception marker ignored: the keyword must be written in lower case as "${EXCEPTION_MARKER}".`
          })
        );
        continue;
      }
      const parsed = parseMarker({ body: match[2] ?? '', today });
      if (!parsed.ok) {
        added.push(
          invalid({
            file: model.file,
            line,
            message: `Exception marker ignored: ${parsed.problem}.`
          })
        );
        continue;
      }
      if (NEVER_WAIVABLE_RULE_IDS.includes(parsed.ruleId)) {
        added.push(
          invalid({
            file: model.file,
            line,
            message: `Exception marker refused: ${parsed.ruleId} cannot be waived.`
          })
        );
        continue;
      }
      const matched = findings.filter((f) => f.file === model.file && f.ruleId === parsed.ruleId);
      if (matched.length === 0) {
        added.push({
          ruleId: 'exception/unused',
          file: model.file,
          line,
          message: `Exception marker for ${parsed.ruleId} has no matching finding and can be removed.`,
          severity: 'notice'
        });
        continue;
      }
      for (const finding of matched) waived.add(finding);
      exceptions.push({
        ruleId: parsed.ruleId,
        file: model.file,
        until: parsed.until,
        reason: parsed.reason,
        line
      });
    }
  }

  return { findings: [...findings.filter((f) => !waived.has(f)), ...added], exceptions };
};
