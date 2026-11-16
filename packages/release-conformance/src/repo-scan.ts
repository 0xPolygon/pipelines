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
import {
  analyzeShell,
  isPublishWord,
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
const PUBLISH_TOOL = /^(?:npm|pnpm|yarn|lerna|bun|changesets?|@changesets\/cli(?:@[^\s]*)?)$/;
/** Commands that only print their arguments, so a publish named in their text is not a command. */
const PRINTERS = new Set(['echo', 'printf']);
/** A word between the tool and `publish` that still means the tool publishes (it names another runner). */
const RUNNER_WORD = /^(?:exec|dlx|x|run|changesets?|lerna|npm|@changesets\/cli(?:@\S*)?)$/;
/** Anything on a line that turns printed text into something that runs, or reads it as a command. */
const RUNS_PRINTED_TEXT = /\$\(|`|(?:^|[^\w-])(?:eval|xargs)(?![\w-])/;
/** Output sent somewhere (`>`, `>>`, `>(…)`), but not a descriptor copy such as `2>&1`. */
const REDIRECTS_OUTPUT = />(?!&)/;
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
      const redirected = printer && REDIRECTS_OUTPUT.test(line);
      for (let index = 0; index < tokens.length; index += 1) {
        const tool = bareWord(tokens[index] ?? '');
        if (!PUBLISH_TOOL.test(tool)) continue;
        // Flags, the values flags take, and `$VAR` words may all sit before the word that matters; the
        // run ends at the next tool, so every token is read once.
        let next = index + 1;
        let afterFlag = false;
        while (next < tokens.length) {
          const token = tokens[next] ?? '';
          // `publish` is never a flag's value: a flag the check does not know cannot hide it.
          if (isPublishWord(bareWord(token))) break;
          if (token.startsWith('-')) afterFlag = !token.includes('=');
          else if (token.startsWith('$') || afterFlag) afterFlag = false;
          else break;
          if (PUBLISH_TOOL.test(bareWord(token))) break;
          next += 1;
        }
        const word = bareWord(tokens[next] ?? '');
        let hit: 'sure' | 'word' | undefined;
        if (isPublishWord(word)) hit = 'sure';
        else if (word !== '' && !PUBLISH_TOOL.test(word)) {
          let after = next + 1;
          while ((tokens[after] ?? '').startsWith('-')) after += 1;
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
