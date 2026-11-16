import type {
  EventModel,
  Finding,
  JobModel,
  JobScan,
  Rule,
  RuleParams,
  Severity,
  StepModel
} from '../types.ts';

import { CALLEE_REPOSITORY, sameRepository } from '../canonical.ts';
import { normalizeShell } from '../repo-scan.ts';

/** Rules a dated in-file marker may waive. */
export const PUBLISHER_WAIVABLE_RULES = [
  'publisher/split',
  'publisher/no-cache',
  'publisher/environment',
  'publisher/events',
  // Waivable for now; move it to the never-waivable list if a publishing dispatch is ever disallowed outright.
  'publisher/publishing-dispatch'
] as const;

/**
 * Rules no marker may waive: the publishing credential in a job that runs
 * repository or dependency code and an event that lets untrusted input start a
 * publisher. A marker naming one of these is invalid.
 */
export const PUBLISHER_NEVER_WAIVABLE_RULES = [
  'publisher/id-token-with-code',
  'publisher/pull-request-target'
] as const;

export const UNCLASSIFIED_ID_TOKEN_RULE = 'publisher/unclassified-id-token';

const CODE_SUBCOMMANDS = new Set(['install', 'i', 'ci', 'add', 'test', 't', 'build', 'lint']);
const CODE_SCRIPTS = /^(?:build|test|lint|prepublishOnly|prepublish|prepare|prepack)(?::.*)?$/;
const RUNNERS = new Set(['run', 'run-script']);
const MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Package-manager flags that take a separate value, so the value is not the subcommand. */
const FLAGS_WITH_VALUE = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--cwd']);

const finding = ({
  ruleId,
  model,
  line,
  message,
  severity = 'error'
}: {
  ruleId: string;
  model: { file: string };
  line: number;
  message: string;
  severity?: Severity;
}): Finding => ({ ruleId, file: model.file, line, message, severity });

/** The first non-flag tokens after the package manager name: the subcommand and the next word. */
const subcommandOf = (tokens: string[]): [string | undefined, string | undefined] => {
  const words: string[] = [];
  for (let index = 1; index < tokens.length && words.length < 2; index += 1) {
    const token = tokens[index] ?? '';
    if (token.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(token)) index += 1;
      continue;
    }
    words.push(token);
  }
  return [words[0], words[1]];
};

/** True when the shell text installs dependencies or runs a build, test or lint script. */
export const runsRepositoryCode = (runText: string): boolean => {
  const joined = normalizeShell(runText);
  for (const segment of joined.split(/\n|;|&&|\|\||\|/)) {
    const tokens = segment.trim().split(/\s+/);
    const [first] = tokens;
    if (first === undefined || !MANAGERS.has(first)) continue;
    const [sub, next] = subcommandOf(tokens);
    if (sub === undefined) continue;
    if (CODE_SUBCOMMANDS.has(sub)) return true;
    if (RUNNERS.has(sub) && next !== undefined && CODE_SCRIPTS.test(next)) return true;
    if (CODE_SCRIPTS.test(sub)) return true;
  }
  return false;
};

const holdsIdToken = (job: JobModel): boolean =>
  job.effectivePermissions.all === 'write-all' ||
  job.effectivePermissions.scopes['id-token'] === 'write';

const otherWriteScopes = (job: JobModel): string[] =>
  Object.entries(job.effectivePermissions.scopes)
    .filter(([scope, level]) => level === 'write' && scope !== 'id-token')
    .map(([scope]) => scope);

const publishingJobs = (scan: RuleParams['scan']): Array<{ job: JobModel; info: JobScan }> => {
  const out: Array<{ job: JobModel; info: JobScan }> = [];
  for (const job of scan.model.jobs) {
    const info = scan.jobs.find((candidate) => candidate.jobId === job.id);
    if (info?.holdsPublishCredential && info.runsPublishCommand) out.push({ job, info });
  }
  return out;
};

const splitFindings = (params: RuleParams): Finding[] => {
  const { model, scan } = params;
  const out: Finding[] = [];
  const top = model.permissions;
  const topCredential = top.all === 'write-all' || top.scopes['id-token'] === 'write';
  if (topCredential && model.jobs.length > 1) {
    out.push(
      finding({
        ruleId: 'publisher/split',
        model,
        line: top.line,
        message:
          'The publishing credential must be granted in the publishing job only; remove it from the workflow-level `permissions` and set it on that job.'
      })
    );
  }
  for (const { job, info } of publishingJobs(scan)) {
    if (runsRepositoryCode(info.runText)) {
      const idToken = holdsIdToken(job);
      out.push(
        finding({
          ruleId: idToken ? 'publisher/id-token-with-code' : 'publisher/split',
          model,
          line: job.line,
          message: `Job \`${job.id}\` holds the publishing credential and must not run a dependency install, build, test or lint command; run those in an earlier job and pass the result as an artifact.`
        })
      );
    }
    if (job.defaultTokenPermissions) {
      out.push(
        finding({
          ruleId: 'publisher/split',
          model,
          line: job.line,
          message: `Job \`${job.id}\` must declare its own \`permissions\` block.`
        })
      );
    } else {
      const scopes = otherWriteScopes(job);
      if (job.effectivePermissions.all === 'write-all' || scopes.length > 0) {
        const named = scopes.length > 0 ? ` (${scopes.map((s) => `\`${s}\``).join(', ')})` : '';
        out.push(
          finding({
            ruleId: 'publisher/split',
            model,
            line: job.effectivePermissions.line || job.line,
            message: `Job \`${job.id}\` must hold no write scope other than the publishing credential${named}.`
          })
        );
      }
    }
  }
  return out;
};

const CACHE_ACTION = /^actions\/cache(?:\/(?:restore|save))?$/i;

const SETUP_NODE_ACTION = /^actions\/setup-node$/i;
/** From this major version `actions/setup-node` caches npm dependencies unless told not to. */
const SETUP_NODE_DEFAULT_CACHE_MAJOR = 6;

const actionName = (step: StepModel): string | undefined =>
  step.uses && !step.uses.local
    ? `${step.uses.owner}/${step.uses.repo}${step.uses.path === '' ? '' : `/${step.uses.path}`}`
    : undefined;

/**
 * `actions/setup-node` from v6 caches npm dependencies on its own when
 * `package.json` names npm as the package manager, and `package-manager-cache: false`
 * turns that off. The workflow file cannot show what `package.json` says, so the
 * opt-out is required whenever the action's major version is 6 or later, or
 * cannot be told (a branch or a commit SHA).
 */
const setupNodeCachesByDefault = (step: StepModel): boolean => {
  const name = actionName(step);
  if (name === undefined || !SETUP_NODE_ACTION.test(name)) return false;
  if (step.with['package-manager-cache']?.trim().toLowerCase() === 'false') return false;
  const major = /^v?(\d+)(?:\.\d+){0,2}$/.exec(step.uses?.ref ?? '')?.[1];
  return major === undefined || Number(major) >= SETUP_NODE_DEFAULT_CACHE_MAJOR;
};

const cacheProblem = (step: StepModel): string | undefined => {
  const name = actionName(step);
  if (name !== undefined && CACHE_ACTION.test(name)) return 'remove the cache action';
  const cache = step.with['cache'];
  if (cache !== undefined && cache.trim() !== '' && cache.trim() !== 'false')
    return 'remove the `cache` input';
  if (setupNodeCachesByDefault(step))
    return 'set `package-manager-cache: false` on the setup action, which caches by default';
  return undefined;
};

const cacheFindings = ({ model }: RuleParams): Finding[] =>
  model.jobs.flatMap((job) =>
    job.steps.flatMap((step) => {
      const problem = cacheProblem(step);
      if (problem === undefined) return [];
      return [
        finding({
          ruleId: 'publisher/no-cache',
          model,
          line: step.line,
          message: `Job \`${job.id}\` must not use a dependency or build cache; ${problem}.`
        })
      ];
    })
  );

const environmentFindings = (params: RuleParams): Finding[] =>
  publishingJobs(params.scan).flatMap(({ job }) => {
    const { environment } = job;
    if (environment.kind === 'literal' && environment.name.trim() !== '') return [];
    const how =
      environment.kind === 'expression'
        ? 'a literal name, not an expression'
        : 'a literal `environment:` name';
    return [
      finding({
        ruleId: 'publisher/environment',
        model: params.model,
        line: job.line,
        message: `Publishing job \`${job.id}\` must declare ${how}.`
      })
    ];
  });

const pushProblem = ({
  event,
  defaultBranch
}: {
  event: EventModel;
  defaultBranch: string;
}): string | undefined => {
  if (event.tags !== undefined || event.tagsIgnore !== undefined)
    return '`push` must not declare `tags` or `tags-ignore`; publish from the default branch only.';
  const branches = event.branches ?? [];
  if (branches.length === 0 || branches.some((branch) => branch !== defaultBranch))
    return `\`push\` must be limited to \`branches: [${defaultBranch}]\`.`;
  return undefined;
};

const eventFindings = ({ model, scan, context }: RuleParams): Finding[] => {
  const out: Finding[] = [];
  const fallbackLine = model.events[0]?.line ?? 1;
  for (const event of scan.entryEvents) {
    const line = model.events.includes(event) ? event.line : fallbackLine;
    const where = model.events.includes(event) ? '' : ' (started through a calling workflow)';
    const add = (ruleId: string, message: string) =>
      out.push(finding({ ruleId, model, line, message: `${message}${where}` }));
    switch (event.name) {
      case 'pull_request_target':
        add(
          'publisher/pull-request-target',
          'A workflow that publishes must not start on `pull_request_target`.'
        );
        break;
      case 'workflow_dispatch':
        add(
          'publisher/publishing-dispatch',
          'A workflow that publishes must not start on `workflow_dispatch`.'
        );
        break;
      case 'push': {
        const problem = pushProblem({ event, defaultBranch: context.defaultBranch });
        if (problem) add('publisher/events', problem);
        break;
      }
      case 'release': {
        const types = event.types ?? [];
        if (types.length !== 1 || types[0] !== 'published')
          add('publisher/events', '`release` must be limited to `types: [published]`.');
        break;
      }
      case 'workflow_call':
        // No caller in this repository: whatever starts it is out of sight, so it cannot be checked.
        add(
          'publisher/events',
          'A reusable workflow that publishes has no caller in this repository, so the events that start it cannot be checked; call it from a workflow in this repository.'
        );
        break;
      default:
        add(
          'publisher/events',
          `A workflow that publishes must start only on \`push\` to the default branch or on \`release\` with \`types: [published]\`, not \`${event.name}\`.`
        );
    }
  }
  return out;
};

/** Workflows of the canonical repository are checked in their own right; any other reusable workflow is not seen into. */
const callsKnownPipelinesWorkflow = (job: JobModel): boolean =>
  job.uses !== undefined &&
  !job.uses.local &&
  sameRepository({ a: `${job.uses.owner}/${job.uses.repo}`, b: CALLEE_REPOSITORY });

const idTokenNotices = ({ params, jobs }: { params: RuleParams; jobs: JobModel[] }): Finding[] =>
  jobs
    .filter(holdsIdToken)
    .filter((job) => !callsKnownPipelinesWorkflow(job))
    .map((job) =>
      finding({
        ruleId: UNCLASSIFIED_ID_TOKEN_RULE,
        model: params.model,
        line: job.effectivePermissions.line || job.line,
        severity: 'notice',
        message: `Job \`${job.id}\` holds \`id-token: write\` but is not recognised as a release job; confirm it does not publish a package.`
      })
    );

/**
 * Notice for every job that holds `id-token: write` in a file the checker does
 * not otherwise classify, so a publish the checker cannot see is still surfaced.
 * Intended for files outside both rule sets.
 */
export const checkUnclassifiedIdToken: Rule = (params) =>
  idTokenNotices({ params, jobs: params.model.jobs });

export const checkBespokePublisher: Rule = (params) => {
  const publishing = new Set(publishingJobs(params.scan).map(({ job }) => job.id));
  return [
    ...splitFindings(params),
    ...cacheFindings(params),
    ...environmentFindings(params),
    ...eventFindings(params),
    ...idTokenNotices({ params, jobs: params.model.jobs.filter((job) => !publishing.has(job.id)) })
  ];
};
