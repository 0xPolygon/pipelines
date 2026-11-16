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
import { readRegularFile } from './safe-read.ts';
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

/** Characters that may sit just before a command word: whitespace, quotes and shell openers. */
const BEFORE_COMMAND = String.raw`(?:^|[\s("'\`{])`;
const MANAGER_WORD = new RegExp(`${BEFORE_COMMAND}(?:npm|pnpm|yarn|lerna|bun)\\b`);
const CHANGESET_PUBLISH = new RegExp(
  `${BEFORE_COMMAND}(?:@changesets/cli(?:@\\S*)?|changesets?)\\s+publish(?![\\w:-])`
);
/** The word `publish` itself, not a script such as `docs:publish` or `publish:docs`. */
const PUBLISH_WORD = /(?<![\w:./-])publish(?![\w:-])/;

/**
 * Loose publish-command test for text the parser may not understand (wrappers
 * such as `xargs` or `bash -c`); errs towards seeing a publish. It works one
 * command at a time and does one pass over each, so its cost is linear in the
 * text however the text is built.
 */
/** Subcommands that run some other tool; the parser reads the tool, so the loose test leaves them alone. */
const RUNS_OTHER_TOOL = /^\s+(?:exec|dlx|x|run|run-script)(?![\w-])/;

const looseRunsPublish = (text: string): boolean =>
  CHANGESET_PUBLISH.test(text) ||
  text.split(/[\n;&|]/).some((segment) => {
    const manager = MANAGER_WORD.exec(segment);
    if (manager === null) return false;
    const rest = segment.slice(manager.index + manager[0].length);
    return !RUNS_OTHER_TOOL.test(rest) && PUBLISH_WORD.test(rest);
  });

/** Arguments of a tag-only command: plain words and flags, with no quoting or shell syntax. */
const TAG_ARGUMENT = /^[\w./:@-]+$/;
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn']);
const NPM_TOKEN_NAME = /npm/i;

export const runsPublishText = (text: string): boolean => looseRunsPublish(normalizeShell(text));

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
    if (facts.publishes || runsPublishText(text)) publishes = true;
    if (facts.runsCode) runsCode = true;
    for (const ref of facts.scripts) {
      const found = env.reader.lookup(ref);
      if (!found.defined && ref.optional !== true) unresolved.add(ref.name);
      // One level only: the script body itself must hold an explicit publish command.
      for (const body of found.bodies)
        if (analyzeShell({ text: body }).publishes || runsPublishText(body)) publishes = true;
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
  return {
    jobId: job.id,
    runText: runs.join('\n'),
    holdsPublishCredential: idToken || npmToken,
    holdsIdToken: idToken,
    holdsNpmToken: npmToken,
    runsPublishCommand: publishes,
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
