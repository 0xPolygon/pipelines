import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { parse } from 'yaml';

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

import { ARCHIVED_CALLEE_REPOSITORY, CALLEE_PATH } from './canonical.ts';
import { parseWorkflow } from './workflow-model.ts';

const WORKFLOW_DIR = '.github/workflows';
const LOCAL_WORKFLOW_PREFIX = './.github/workflows/';
const LOCAL_ACTION_PREFIX = './.github/actions/';

/** Shell publish commands: `npm|pnpm|yarn ... publish`, `npm stage publish`, `changeset publish`. */
const PUBLISH_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn)\b[^\n;&|]*?(?<![\w-])publish(?![\w-])|changesets?\s+publish(?![\w-]))/m;
/** A `publish` input whose every line only creates tags does not publish a package. */
const TAG_ONLY =
  /^\s*(?:(?:pnpm|npm|yarn)(?:\s+exec|\s+run)?\s+)?(?:changesets?\s+tag|git\s+tag|git\s+push\s+--tags)\b/;
const NPM_TOKEN_NAME = /npm/i;
const NPM_TOKEN_KEYS = new Set(['NODE_AUTH_TOKEN', 'NPM_TOKEN']);

/** Drops shell comments so a comment that names a publish command does not count as running it. */
export const stripShellComments = (text: string): string =>
  text
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');

export const runsPublishText = (text: string): boolean =>
  PUBLISH_COMMAND.test(stripShellComments(text));

const isTagOnly = (command: string): boolean =>
  command
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every((line) => TAG_ONLY.test(line));

const isNpmTokenRef = ({ key, expression }: { key: string; expression: string }): boolean => {
  if (NPM_TOKEN_KEYS.has(key)) return true;
  for (const match of expression.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    if (NPM_TOKEN_NAME.test(match[1] ?? '')) return true;
  }
  return false;
};

export const isSharedCallee = (uses: UsesRef): boolean => {
  if (uses.local) return uses.path === `./${CALLEE_PATH}`;
  if (uses.repo === 'pipelines' && uses.path === CALLEE_PATH) return true;
  return (
    `${uses.owner}/${uses.repo}` === ARCHIVED_CALLEE_REPOSITORY &&
    uses.path.startsWith(`${WORKFLOW_DIR}/`) &&
    uses.path.includes('npm-release')
  );
};

interface CompositeStep {
  run?: string;
  uses?: string;
  with: Record<string, string>;
}

const readComposite = ({ root, uses }: { root: string; uses: UsesRef }): CompositeStep[] => {
  const dir = join(root, uses.path.replace(/^\.\//, ''));
  for (const name of ['action.yml', 'action.yaml']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const doc: unknown = parse(readFileSync(path, 'utf8'), { maxAliasCount: 50 });
      if (typeof doc !== 'object' || doc === null || !('runs' in doc)) return [];
      const runs = doc.runs;
      if (
        typeof runs !== 'object' ||
        runs === null ||
        !('steps' in runs) ||
        !Array.isArray(runs.steps)
      )
        return [];
      return runs.steps.map((step: unknown): CompositeStep => {
        const out: CompositeStep = { with: {} };
        if (typeof step !== 'object' || step === null) return out;
        if ('run' in step && typeof step.run === 'string') out.run = step.run;
        if ('uses' in step && typeof step.uses === 'string') out.uses = step.uses;
        if ('with' in step && typeof step.with === 'object' && step.with !== null) {
          for (const [key, value] of Object.entries(step.with)) out.with[key] = String(value);
        }
        return out;
      });
    } catch {
      return [];
    }
  }
  return [];
};

const isChangesetsAction = (uses: string | undefined): boolean =>
  uses !== undefined && /^changesets\/action@/.test(uses);

const changesetsPublishesPackages = (withInputs: Record<string, string>): boolean => {
  const command = withInputs['publish'] ?? withInputs['publish-script'] ?? '';
  return command.trim() !== '' && !isTagOnly(command);
};

const scanJob = ({ job, root }: { job: JobModel; root: string }): JobScan => {
  const runs: string[] = [];
  let publishes = false;
  let credential = false;
  const eff = job.effectivePermissions;
  if (eff.all === 'write-all' || eff.scopes['id-token'] === 'write') credential = true;
  if (job.envSecretRefs.some(isNpmTokenRef)) credential = true;
  if (
    Object.entries(job.withValues).some(([key, expression]) => isNpmTokenRef({ key, expression }))
  )
    credential = true;

  for (const step of job.steps) {
    if (step.run !== undefined) runs.push(stripShellComments(step.run));
    if (step.envSecretRefs.some(isNpmTokenRef)) credential = true;
    if (Object.entries(step.with).some(([key, expression]) => isNpmTokenRef({ key, expression })))
      credential = true;
    if (isChangesetsAction(step.uses?.raw) && changesetsPublishesPackages(step.with))
      publishes = true;
    if (step.uses?.local && step.uses.path.startsWith(LOCAL_ACTION_PREFIX)) {
      for (const inner of readComposite({ root, uses: step.uses })) {
        if (inner.run !== undefined) runs.push(stripShellComments(inner.run));
        if (isChangesetsAction(inner.uses) && changesetsPublishesPackages(inner.with))
          publishes = true;
      }
    }
  }
  const runText = runs.join('\n');
  if (PUBLISH_COMMAND.test(runText)) publishes = true;
  return {
    jobId: job.id,
    runText,
    holdsPublishCredential: credential,
    runsPublishCommand: publishes
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
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => `${WORKFLOW_DIR}/${name}`);
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

export const scanRepo = ({ root }: { root: string }): ScanResult => {
  const models = new Map<string, WorkflowModel>();
  for (const file of listWorkflowFiles(root)) {
    models.set(file, parseWorkflow({ file, text: readFileSync(join(root, file), 'utf8') }));
  }

  const callers = new Map<string, string[]>();
  for (const model of models.values()) {
    for (const job of model.jobs) {
      if (job.uses?.local && job.uses.raw.startsWith(LOCAL_WORKFLOW_PREFIX)) {
        const callee = job.uses.raw.replace(/^\.\//, '');
        callers.set(callee, [...(callers.get(callee) ?? []), model.file]);
      }
    }
  }

  const files: ScannedFile[] = [...models.values()].map((model) => {
    const jobs = model.jobs.map((job) => scanJob({ job, root }));
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
