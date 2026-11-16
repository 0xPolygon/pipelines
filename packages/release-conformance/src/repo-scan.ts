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
import { analyzeShell, normalizeShell, stripShellComments } from './shell-commands.ts';
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
const PUBLISH_TOOL = /^(?:npm|pnpm|yarn|lerna|bun|changesets?|@changesets\/cli(?:@[^\s]*)?)$/;
/** Commands that only print their arguments, so a quoted `npm publish` after them is text, not a command. */
const PRINTERS = new Set(['echo', 'printf']);
/** Commands that run the string they are given, so a quoted publish after them still runs. */
const STRING_EXECUTORS = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'eval',
  'su',
  'ssh',
  'watch'
]);
const LEADING_PUNCTUATION = new Set(['(', '{', '$', '"', "'", '`']);
const TRAILING_PUNCTUATION = new Set([')', '}', '"', "'", '`']);

/** Trims shell openers and quotes from both ends of a word, by index so the cost is linear in its length. */
const bareWord = (token: string): { word: string; opensQuote: boolean } => {
  let start = 0;
  let end = token.length;
  let opensQuote = false;
  while (start < end && LEADING_PUNCTUATION.has(token[start] ?? '')) {
    if (token[start] === '"' || token[start] === "'" || token[start] === '`') opensQuote = true;
    start += 1;
  }
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1] ?? '')) end -= 1;
  return { word: token.slice(start, end), opensQuote };
};

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
    return bareWord(token).word.replace(/^.*\//, '');
  }
  return '';
};

/** Tracks whether a run of words is inside an open quote, one word at a time. */
const nextQuoteState = ({
  quote,
  token
}: {
  quote: string | undefined;
  token: string;
}): string | undefined => {
  let state = quote;
  for (const char of token) {
    if (state === undefined) {
      if (char === '"' || char === "'") state = char;
    } else if (char === state) state = undefined;
  }
  return state;
};

/**
 * Text-level publish test, the second opinion beside the command parser. `publish` counts only as the
 * word right after `npm`, `pnpm`, `yarn`, `lerna`, `bun`, `changeset(s)` or `@changesets/cli`
 * (flags may sit between), never after another binary name and not inside a quoted argument of a
 * command that only prints (`echo "skipping npm publish"`). It reads each command as a list of words
 * in one pass, so its cost is linear in the text however the text is built.
 */
const looseRunsPublish = (text: string): boolean =>
  text.split(/[\n;&|]/).some((segment) => {
    const tokens = segment.split(/\s+/);
    const command = segmentCommand(tokens);
    if (PRINTERS.has(command)) return false;
    let quote: string | undefined;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index] ?? '';
      const { word, opensQuote } = bareWord(token);
      const before = quote;
      quote = nextQuoteState({ quote, token });
      // A word that opens a quote and closes it again (`"npm" publish`) is not inside a string.
      const quoted = before !== undefined || (opensQuote && quote !== undefined);
      if (!PUBLISH_TOOL.test(word) || (quoted && !STRING_EXECUTORS.has(command))) continue;
      let next = index + 1;
      while ((tokens[next] ?? '').startsWith('-')) next += 1;
      if (bareWord(tokens[next] ?? '').word === 'publish') return true;
    }
    return false;
  });

/** Arguments of a tag-only command: plain words and flags, with no quoting or shell syntax. */
const TAG_ARGUMENT = /^[\w./:@-]+$/;
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn']);
const NPM_TOKEN_NAME = /npm/i;

/** True when the text-level test alone sees a publish command in the text. */
export const textSeesPublish = (text: string): boolean => looseRunsPublish(normalizeShell(text));

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

interface CompositeStep {
  run?: string;
  uses?: string;
  local: boolean;
  with: Record<string, string>;
  /** Environment variables the step sets from `github.action_path`. */
  actionPathVars: string[];
}

type ActionRead = { ok: true; steps: CompositeStep[] } | { ok: false; reason: string };

/**
 * Reads one local composite action: only under `.github/actions/`, which the
 * checker's checkout holds, and only its own steps. Anything else (a path
 * elsewhere, a missing file, a node or docker action, a second level of local
 * action) is reported as unreadable rather than assumed harmless.
 */
const readLocalAction = ({
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
          reason: 'it uses a further local action, which the check does not follow'
        };
      return { ok: true, steps };
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
  /** Only the text-level test saw a publish; the command parser did not confirm one. */
  let textOnlyPublish = false;
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
    else if (textSeesPublish(text)) textOnlyPublish = true;
    if (facts.tooDeep) tooDeep = true;
    if (facts.runsCode) runsCode = true;
    for (const ref of facts.scripts) {
      const found = env.reader.lookup(ref);
      if (!found.defined && ref.optional !== true) unresolved.add(ref.name);
      // One level only: the script body itself must hold an explicit publish command.
      for (const body of found.bodies) {
        const inner = analyzeShell({ text: body });
        if (inner.publishes) publishes = true;
        else if (textSeesPublish(body)) textOnlyPublish = true;
        if (inner.tooDeep) tooDeep = true;
      }
    }
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
      }
    }
  }
  // An npm token in the job keeps the token rules whatever sees the publish; with no token, a
  // publish only the text test sees is a possible publish for a person to confirm, not a classification.
  const confirmed = publishes || (textOnlyPublish && npmToken);
  return {
    jobId: job.id,
    runText: runs.join('\n'),
    holdsPublishCredential: idToken || npmToken,
    holdsIdToken: idToken,
    holdsNpmToken: npmToken,
    runsPublishCommand: confirmed,
    possiblePublish: textOnlyPublish && !confirmed && idToken,
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
const localCallee = ({ uses, repository }: { uses: UsesRef; repository: string }) => {
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
