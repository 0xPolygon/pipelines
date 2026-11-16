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
import { analyzeShell } from '../shell-commands.ts';

/** Rules a dated in-file marker may waive. */
export const PUBLISHER_WAIVABLE_RULES = [
  'publisher/split',
  'publisher/no-cache',
  'publisher/environment',
  'publisher/events',
  // Waivable for now; move it to the never-waivable list if a publishing dispatch is ever disallowed outright.
  'publisher/publishing-dispatch',
  'publisher/unreadable-local-action',
  'publisher/possible-publish'
] as const;

/**
 * Rules no marker may waive: the publishing credential in a job that runs
 * repository or dependency code and an event that lets untrusted input start a
 * publisher. A marker naming one of these is invalid.
 */
export const PUBLISHER_NEVER_WAIVABLE_RULES = [
  'publisher/id-token-with-code',
  'publisher/token-with-code',
  'publisher/pull-request-target'
] as const;

export const UNCLASSIFIED_ID_TOKEN_RULE = 'publisher/unclassified-id-token';
export const POSSIBLE_PUBLISH_RULE = 'publisher/possible-publish';
export const UNREADABLE_LOCAL_ACTION_RULE = 'publisher/unreadable-local-action';
export const UNCLASSIFIED_NPM_TOKEN_RULE = 'publisher/unclassified-npm-token';

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

/** True when the shell text installs dependencies, runs a build, test or lint script, or runs a repository tool. */
export const runsRepositoryCode = (runText: string): boolean =>
  analyzeShell({ text: runText }).runsCode;

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
    if (info.runsRepositoryCode) {
      // The token and the OIDC credential each have their own never-waivable id, so a marker for
      // another condition (the permissions rules, say) can never silence either.
      const idToken = holdsIdToken(job);
      out.push(
        finding({
          ruleId: idToken ? 'publisher/id-token-with-code' : 'publisher/token-with-code',
          model,
          line: job.line,
          message: `Job \`${job.id}\` holds the publishing credential and must not run a dependency install, build, test or lint command; run those in an earlier job and pass the result as an artifact.${info.commandTooDeep ? ' A command in it nests wrappers more deeply than the check reads, so it is treated as one that runs code.' : ''}`
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
/** From this major version `actions/setup-node` caches dependencies unless told not to. */
const SETUP_NODE_DEFAULT_CACHE_MAJOR = 5;

const actionName = (step: StepModel): string | undefined =>
  step.uses && !step.uses.local
    ? `${step.uses.owner}/${step.uses.repo}${step.uses.path === '' ? '' : `/${step.uses.path}`}`
    : undefined;

/**
 * `actions/setup-node` from v5 caches dependencies on its own when `package.json`
 * has a `packageManager` field (v6 narrowed that to npm), and
 * `package-manager-cache: false` turns that off. The workflow file cannot show
 * what `package.json` says, so the opt-out is required whenever the action's
 * major version is 5 or later, or
 * cannot be told (a branch, or a commit SHA with no version comment). A commit
 * SHA is pinned with the version in a trailing comment on the `uses:` line
 * (`@<sha> # v4.4.0`); that comment supplies the major version.
 */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/** The major version in the comment that trails a step's `uses:` line, if there is one. */
const commentMajor = ({
  step,
  lines
}: {
  step: StepModel;
  lines: string[];
}): string | undefined => {
  const raw = step.uses?.raw ?? '';
  const first = lines[step.line - 1] ?? '';
  const indent = first.length - first.trimStart().length;
  for (let index = step.line - 1; index < Math.min(lines.length, step.line + 40); index += 1) {
    const text = lines[index] ?? '';
    if (
      index > step.line - 1 &&
      /^\s*-\s/.test(text) &&
      text.length - text.trimStart().length <= indent
    )
      return undefined;
    const at = text.indexOf(raw);
    if (at < 0 || !/uses:\s*["']?$/.test(text.slice(0, at))) continue;
    return /\s#\s*v?(\d+)(?:\.\d+){0,2}(?:\s|$)/.exec(text.slice(at + raw.length))?.[1];
  }
  return undefined;
};

const setupNodeCachesByDefault = ({
  step,
  lines
}: {
  step: StepModel;
  lines: string[];
}): boolean => {
  const name = actionName(step);
  if (name === undefined || !SETUP_NODE_ACTION.test(name)) return false;
  if (step.with['package-manager-cache']?.trim().toLowerCase() === 'false') return false;
  const ref = step.uses?.ref ?? '';
  const major = FULL_SHA.test(ref)
    ? commentMajor({ step, lines })
    : /^v?(\d+)(?:\.\d+){0,2}$/.exec(ref)?.[1];
  return major === undefined || Number(major) >= SETUP_NODE_DEFAULT_CACHE_MAJOR;
};

const cacheProblem = ({
  step,
  lines
}: {
  step: StepModel;
  lines: string[];
}): string | undefined => {
  const name = actionName(step);
  if (name !== undefined && CACHE_ACTION.test(name)) return 'remove the cache action';
  const cache = step.with['cache'];
  if (cache !== undefined && cache.trim() !== '' && cache.trim() !== 'false')
    return 'remove the `cache` input';
  if (setupNodeCachesByDefault({ step, lines }))
    return 'set `package-manager-cache: false` on the setup action, which caches by default';
  return undefined;
};

const cacheFindings = ({ model }: RuleParams): Finding[] => {
  const lines = model.text.split('\n');
  return model.jobs.flatMap((job) =>
    job.steps.flatMap((step) => {
      const problem = cacheProblem({ step, lines });
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
};

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

const unresolvedNote = (info: JobScan | undefined): string => {
  const names = info?.unresolvedScripts ?? [];
  return names.length === 0
    ? ''
    : ` It runs ${names.map((n) => `\`${n}\``).join(', ')}, which no package.json the check reads defines.`;
};

const unclassifiedNotices = ({
  params,
  jobs
}: {
  params: RuleParams;
  jobs: JobModel[];
}): Finding[] =>
  jobs
    .filter((job) => !callsKnownPipelinesWorkflow(job))
    .flatMap((job) => {
      const info = params.scan.jobs.find((candidate) => candidate.jobId === job.id);
      // The unreadable-action error already says why this job cannot be classified.
      if (info !== undefined && info.unreadableActions.length > 0) return [];
      const out: Finding[] = [];
      if (info?.possiblePublish) {
        // One finding stands for the job: it replaces the notices, and a marker waives it.
        return [
          finding({
            ruleId: POSSIBLE_PUBLISH_RULE,
            model: params.model,
            line: job.line,
            message: `Job \`${job.id}\` holds \`id-token: write\` and has a command that looks like a package publish the check cannot confirm; reword it as \`<package manager> publish\` if it publishes, or ask a code owner to waive this finding if it does not.${unresolvedNote(info)}`
          })
        ];
      }
      if (holdsIdToken(job)) {
        out.push(
          finding({
            ruleId: UNCLASSIFIED_ID_TOKEN_RULE,
            model: params.model,
            line: job.effectivePermissions.line || job.line,
            severity: 'notice',
            message: `Job \`${job.id}\` holds \`id-token: write\` but is not recognised as a release job; confirm it does not publish a package.${unresolvedNote(info)}`
          })
        );
      }
      if (info?.holdsNpmToken) {
        out.push(
          finding({
            ruleId: UNCLASSIFIED_NPM_TOKEN_RULE,
            model: params.model,
            line: job.line,
            severity: 'notice',
            message: `Job \`${job.id}\` holds an npm token but is not recognised as a release job; confirm it does not publish a package.${unresolvedNote(info)}`
          })
        );
      }
      return out;
    });

/**
 * A job that holds a publishing credential and uses a local action the check
 * cannot read: whatever that action runs is out of sight, so the job cannot be
 * classified. Waivable with a dated marker; never part of the reference downgrade.
 */
const unreadableActionFindings = (params: RuleParams): Finding[] =>
  params.model.jobs.flatMap((job) => {
    const info = params.scan.jobs.find((candidate) => candidate.jobId === job.id);
    if (!info?.holdsPublishCredential) return [];
    return info.unreadableActions.map(({ path, reason }) =>
      finding({
        ruleId: UNREADABLE_LOCAL_ACTION_RULE,
        model: params.model,
        line: job.line,
        message: `Job \`${job.id}\` holds a publishing credential and uses the local action \`${path}\`, which the check cannot read (${reason}); use an action under \`.github/actions/\` or move its steps into the workflow.`
      })
    );
  });

/**
 * Findings for every file outside both rule sets: a notice for each job holding
 * `id-token: write` or an npm token that is not recognised as a release job,
 * and an error for a credential-holding job whose local action cannot be read.
 */
export const checkUnclassifiedJobs: Rule = (params) => [
  ...unreadableActionFindings(params),
  ...unclassifiedNotices({ params, jobs: params.model.jobs })
];

export const checkBespokePublisher: Rule = (params) => {
  const publishing = new Set(publishingJobs(params.scan).map(({ job }) => job.id));
  return [
    ...splitFindings(params),
    ...cacheFindings(params),
    ...environmentFindings(params),
    ...eventFindings(params),
    ...unreadableActionFindings(params),
    ...unclassifiedNotices({
      params,
      jobs: params.model.jobs.filter((job) => !publishing.has(job.id))
    })
  ];
};
