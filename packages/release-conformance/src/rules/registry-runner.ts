import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import { LineCounter, isNode, parseDocument } from 'yaml';

import type { ScriptReader } from '../package-scripts.ts';
import type {
  Finding,
  JobModel,
  JobScan,
  ScanResult,
  ScannedFile,
  Severity,
  StepModel,
  UsesRef
} from '../types.ts';

import { CALLEE_REPOSITORY, sameRepository } from '../canonical.ts';
import { createScriptReader } from '../package-scripts.ts';
import { localCallee, textRunnerHits } from '../repo-scan.ts';
import { linkedParent, readRegularFile } from '../safe-read.ts';
import { analyzeShell } from '../shell-commands.ts';
import {
  MAX_WORKFLOW_BYTES,
  parseUses,
  secretReferences,
  usesSecretsDynamically
} from '../workflow-model.ts';

/** A registry-fetching runner anywhere a command can run. A dated in-file marker may waive it. */
export const REGISTRY_RUNNER_RULE = 'runner/registry-fetch';
/**
 * The same condition in a job that holds a credential. A separate id, because a marker
 * waives by id and this one must never be waivable.
 */
export const REGISTRY_RUNNER_CREDENTIAL_RULE = 'runner/registry-fetch-with-credential';
const ACTIONS_DIR = '.github/actions';
/** Directory depth the listing of `.github/actions` descends; actions used from elsewhere are reached by reference. */
const MAX_ACTION_DEPTH = 16;
const MAX_ACTION_DIRECTORIES = 400;
/**
 * Where the shared workflows of the canonical repository check out their own repository (the whole
 * repository, or the guard action alone), so a local `uses:` under these paths resolves into this tree.
 */
const SELF_CHECKOUT_PREFIXES = ['.pipelines/', '.pipelines-guard/'];
/** `with:` inputs that hold prose (a pull-request body, a message): their backticks mark code and nothing in them is a parsed command. */
const PROSE_KEY =
  /body|title|message|description|comment|text|summary|notes?|label|content|header|footer/i;

interface Hit {
  runner: string;
  /** The package script whose body holds the runner, when the command only runs the script. */
  viaScript?: string;
  /** Text of the command (or line) the runner was read from, to find its own line in the file. */
  snippet?: string;
}

/**
 * Runners named by a piece of shell text, plus those in the body of a package script the text runs
 * (one level down, the same lookup the publish detection uses). In a credential context a text-level
 * test adds a hit for every runner word the parser did not confirm, wherever it stands (a quoted
 * argument, a heredoc, a prose input), except in the two search-command forms the text test excuses.
 * `prose` text is never parsed as commands, so only the text-level test sees it.
 */
const runnersIn = ({
  text,
  baseDirs,
  reader,
  credential,
  prose = false
}: {
  text: string;
  baseDirs: string[];
  reader: ScriptReader;
  credential: boolean;
  prose?: boolean;
}): Hit[] => {
  const hits: Hit[] = [];
  const read = ({
    body,
    viaScript,
    dirs
  }: {
    body: string;
    viaScript?: string;
    dirs: string[];
  }) => {
    const facts = prose ? undefined : analyzeShell({ text: body, baseDirs: dirs });
    const unmatched: string[] = [];
    for (const site of facts?.runnerSites ?? []) {
      unmatched.push(site.runner);
      hits.push({
        runner: site.runner,
        ...(viaScript === undefined ? { snippet: site.segment } : { viaScript })
      });
    }
    if (credential)
      for (const found of textRunnerHits(body)) {
        const at = unmatched.indexOf(found.runner);
        if (at >= 0) unmatched.splice(at, 1);
        else
          hits.push({
            runner: found.runner,
            ...(viaScript === undefined ? { snippet: found.line } : { viaScript })
          });
      }
    return facts;
  };
  const facts = read({ body: text, dirs: baseDirs });
  for (const ref of facts?.scripts ?? [])
    for (const body of reader.lookup(ref).bodies) read({ body, viaScript: ref.name, dirs: [] });
  return hits;
};

/** True for a `with:` value that switches an install on (`run_install: true`, or a list of install settings). */
const truthyInput = (value: string | undefined): boolean =>
  value !== undefined && !['', 'false', 'null', '0', 'no'].includes(value.trim().toLowerCase());

/** `pnpm/action-setup` with `run_install` runs `pnpm install` itself, and with it every lifecycle script. */
const installsThroughAction = (step: Pick<StepModel, 'uses' | 'with'>): boolean =>
  step.uses !== undefined &&
  /^pnpm\/action-setup(?:\/|$)/i.test(
    `${step.uses.owner}/${step.uses.repo}${step.uses.path === '' ? '' : `/${step.uses.path}`}`
  ) &&
  truthyInput(step.with['run_install']);

const GITHUB_TOKEN_ONLY = /^\$\{\{\s*(?:secrets\s*\.\s*GITHUB_TOKEN|github\s*\.\s*token)\s*\}\}$/i;

/**
 * True when the text reads any secret other than the workflow's own `GITHUB_TOKEN`, by name or
 * dynamically (`secrets[matrix.name]`, `toJSON(secrets)`), which can reach any of them.
 */
const readsSecret = (text: string): boolean =>
  secretReferences(text).some((name) => name.toUpperCase() !== 'GITHUB_TOKEN') ||
  usesSecretsDynamically(text);

/**
 * Whether a job holds a credential for this rule. Wider than the publishing-credential test the other
 * rules use: a registry fetch beside any secret (a deploy token, say) runs unvetted code with it, so
 * any secret except `GITHUB_TOKEN` counts, wherever the job references it: `env`, a `with:` value,
 * `run:` text, or `secrets:` on a reusable-workflow call (`inherit`, or any value that is not only
 * `GITHUB_TOKEN`). A job also holds `id-token: write` when it declares no permissions and a local
 * caller job grants it.
 */
const holdsCredential = ({
  job,
  info,
  inheritsIdToken
}: {
  job: JobModel;
  info: JobScan | undefined;
  inheritsIdToken: boolean;
}): boolean =>
  inheritsIdToken ||
  info?.holdsPublishCredential === true ||
  job.secrets.inherit ||
  Object.values(job.secrets.values).some((value) => !GITHUB_TOKEN_ONLY.test(value.trim())) ||
  [...job.envSecretRefs, ...job.steps.flatMap((step) => step.envSecretRefs)].some(
    ({ expression }) => readsSecret(expression)
  ) ||
  Object.values(job.withValues).some(readsSecret) ||
  job.steps.some(
    (step) =>
      (step.run !== undefined && readsSecret(step.run)) ||
      Object.values(step.with).some(readsSecret)
  );

/**
 * The credential-free case is a notice for now (the checker has only `error` and `notice`): reported,
 * never failing the run. The credentialed ids are always errors.
 */
const severityFor = (credential: boolean): Severity => (credential ? 'error' : 'notice');

const messageFor = ({ hit, credential }: { hit: Hit; credential: boolean }): string => {
  const how =
    hit.viaScript === undefined
      ? `\`${hit.runner}\``
      : `\`${hit.runner}\` (in package script \`${hit.viaScript}\`)`;
  return `${how} fetches a package from the registry at run time, so the lockfile does not cover what runs${
    credential ? ' in a job that holds a credential' : ''
  }; add the tool as a dependency and run it with \`pnpm exec\`.`;
};

/**
 * Repository-relative directory a local `uses:` reaches: `./x/y`, a trailing slash, `./` for the root
 * action, and `<this repository>/x/y@<ref>`, which GitHub resolves to the same checkout. Undefined for
 * anything that is not a path inside the tree.
 */
const actionDirectory = ({
  uses,
  repository
}: {
  uses: UsesRef;
  repository: string;
}): string | undefined => {
  let path: string;
  if (uses.local) path = uses.path;
  else if (repository !== '' && `${uses.owner}/${uses.repo}` === repository.toLowerCase())
    path = uses.path;
  else return undefined;
  path = path.replace(/^\.\//, '');
  // Only the canonical repository's own run identity (never a value read from the tree) maps these paths.
  if (sameRepository({ a: repository, b: CALLEE_REPOSITORY }))
    for (const prefix of SELF_CHECKOUT_PREFIXES)
      if (path.startsWith(prefix)) path = path.slice(prefix.length);
  path = posix.normalize(path === '' ? '.' : path).replace(/\/+$/, '');
  if (path === '') path = '.';
  return path === '..' || path.startsWith('../') || posix.isAbsolute(path) ? undefined : path;
};

/** Directories under `.github/actions` that hold an action file, without following links. */
const listActionDirectories = (root: string): string[] => {
  if (linkedParent({ root, relative: ACTIONS_DIR }) !== undefined) return [];
  const found: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number): void => {
    if (visited >= MAX_ACTION_DIRECTORIES) return;
    visited += 1;
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && /^action\.ya?ml$/.test(e.name))) found.push(dir);
    if (depth >= MAX_ACTION_DEPTH) return;
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1)))
      if (entry.isDirectory() && entry.name !== 'node_modules')
        walk(posix.join(dir, entry.name), depth + 1);
  };
  walk(ACTIONS_DIR, 0);
  return found;
};

interface ActionStep {
  run?: string;
  uses?: string;
  with: Record<string, string>;
  line: number;
}

type ActionRead =
  | { kind: 'composite'; file: string; text: string; steps: ActionStep[] }
  /** A node or docker action: its code is not shell text, so it holds no command to read. */
  | { kind: 'other' }
  | { kind: 'unreadable'; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads the composite action in a repository directory (any directory), without following links. */
const readComposite = ({ root, directory }: { root: string; directory: string }): ActionRead => {
  const linked = linkedParent({ root, relative: directory });
  if (linked !== undefined)
    return {
      kind: 'unreadable',
      reason: `\`${linked}\` is a link, which the check does not follow`
    };
  for (const name of ['action.yml', 'action.yaml']) {
    let text: string;
    try {
      const read = readRegularFile({
        path: join(root, directory, name),
        maxBytes: MAX_WORKFLOW_BYTES
      });
      if (read.kind === 'missing' || read.kind === 'directory') continue;
      if (read.kind !== 'text')
        return { kind: 'unreadable', reason: `\`${name}\` is not a readable regular file` };
      text = read.text;
    } catch {
      return { kind: 'unreadable', reason: `\`${name}\` could not be read` };
    }
    const counter = new LineCounter();
    const doc = parseDocument(text, { lineCounter: counter });
    if (doc.errors.length > 0) return { kind: 'unreadable', reason: 'it could not be parsed' };
    let raw: unknown;
    try {
      raw = doc.toJS({ maxAliasCount: 50 });
    } catch {
      return { kind: 'unreadable', reason: 'it could not be parsed' };
    }
    const runs = isRecord(raw) ? raw['runs'] : undefined;
    if (!isRecord(runs)) return { kind: 'unreadable', reason: 'it has no `runs` block' };
    if (runs['using'] !== 'composite') return { kind: 'other' };
    const list = runs['steps'];
    if (!Array.isArray(list)) return { kind: 'unreadable', reason: 'it has no `steps` list' };
    const lineAt = (path: (string | number)[]): number => {
      const node = doc.getIn(path, true);
      return isNode(node) && node.range ? counter.linePos(node.range[0]).line : 0;
    };
    const steps = list.map((entry: unknown, index): ActionStep => {
      const step = isRecord(entry) ? entry : {};
      const out: ActionStep = {
        with: {},
        line: lineAt(['runs', 'steps', index]) || lineAt(['runs', 'steps']) || 1
      };
      if (typeof step['run'] === 'string') out.run = step['run'];
      if (typeof step['uses'] === 'string') out.uses = step['uses'];
      if (isRecord(step['with']))
        for (const [key, value] of Object.entries(step['with'])) out.with[key] = String(value);
      return out;
    });
    return {
      kind: 'composite',
      file: directory === '.' ? name : `${directory}/${name}`,
      text,
      steps
    };
  }
  return { kind: 'unreadable', reason: 'no `action.yml` was found there' };
};

/**
 * Line of a command in a file: the first line at or after `from` that holds the start of its text, so
 * an identical line earlier in the file is not taken for it. Falls back to `from`.
 */
const lineIn = ({
  lines,
  from,
  snippet
}: {
  lines: string[];
  from: number;
  snippet: string | undefined;
}): number => {
  const start = Math.max(from, 1);
  if (snippet === undefined) return start;
  const first =
    snippet
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  const words = first.split(/\s+/);
  for (const needle of [first, words.slice(0, 3).join(' '), words[0] ?? '']) {
    if (needle === '') continue;
    for (let at = start - 1; at < lines.length; at += 1)
      if ((lines[at] ?? '').includes(needle)) return at + 1;
  }
  return start;
};

/** A stand-in for an action file, so a marker comment in it is read like one in a workflow. */
const actionAsFile = ({ file, text }: { file: string; text: string }): ScannedFile => ({
  model: {
    file,
    text,
    events: [],
    permissions: { present: false, scopes: {}, line: 0 },
    jobs: []
  },
  class: 'not-in-scope',
  jobs: [],
  entryEvents: [],
  localCallers: []
});

/**
 * `runner/registry-fetch`: no registry-fetching runner (`npx`, `pnpx`, `bunx`, `bun x`, `npm exec`,
 * `npm x`, `pnpm dlx`, `yarn dlx`) in any workflow step or `with:` string, in a composite action the
 * repository has or uses, or in a package script a command runs (one level; a root install reads every
 * workspace package's install-time scripts). It reads every workflow, not only the release ones: a fetch
 * at run time bypasses the lockfile wherever it happens. `pnpm exec` resolves from the lockfile and is
 * allowed. In a job that holds a credential the finding carries the never-waivable id, and so does
 * any runner word the text-level test finds that the parser did not confirm. A composite action counts
 * as credentialed when a credential job uses it, directly or through other actions.
 */
export const checkRegistryRunners = ({
  scan,
  repository
}: {
  scan: ScanResult;
  repository: string;
}): { findings: Finding[]; actionFiles: ScannedFile[] } => {
  const reader = createScriptReader(scan.root);
  const findings: Finding[] = [];
  /** Local caller jobs of each workflow file, for `id-token: write` a callee job inherits. */
  const callerJobs = new Map<string, { file: string; job: JobModel }[]>();
  for (const file of scan.files)
    for (const job of file.model.jobs) {
      const callee = job.uses ? localCallee({ uses: job.uses, repository }) : undefined;
      if (callee !== undefined)
        callerJobs.set(callee, [...(callerJobs.get(callee) ?? []), { file: file.model.file, job }]);
    }
  const grantsIdToken = (job: JobModel): boolean =>
    job.effectivePermissions.all === 'write-all' ||
    job.effectivePermissions.scopes['id-token'] === 'write';
  const callerGrants = (path: string, seen: Set<string>): boolean => {
    if (seen.has(path)) return false;
    seen.add(path);
    return (callerJobs.get(path) ?? []).some(
      ({ file, job }) =>
        grantsIdToken(job) || (job.defaultTokenPermissions && callerGrants(file, seen))
    );
  };

  const emit = ({
    file,
    lines,
    from,
    hits,
    credential
  }: {
    file: string;
    lines: string[];
    from: number;
    hits: Hit[];
    credential: boolean;
  }): void => {
    for (const hit of hits) {
      findings.push({
        ruleId: credential ? REGISTRY_RUNNER_CREDENTIAL_RULE : REGISTRY_RUNNER_RULE,
        file,
        line: lineIn({ lines, from, snippet: hit.snippet }),
        message: messageFor({ hit, credential }),
        severity: severityFor(credential)
      });
    }
  };

  /** Steps' text, shared by workflow jobs and composite actions. */
  const readStep = ({
    step,
    baseDirs,
    credential
  }: {
    step: Pick<StepModel, 'uses' | 'with'> & { run?: string };
    baseDirs: string[];
    credential: boolean;
  }): Hit[] => {
    const hits: Hit[] = [];
    if (step.run !== undefined)
      hits.push(...runnersIn({ text: step.run, baseDirs, reader, credential }));
    if (step.uses !== undefined) {
      for (const [key, value] of Object.entries(step.with))
        hits.push(
          ...runnersIn({ text: value, baseDirs, reader, credential, prose: PROSE_KEY.test(key) })
        );
      if (installsThroughAction(step))
        hits.push(...runnersIn({ text: 'pnpm install', baseDirs, reader, credential }));
    }
    return hits;
  };

  interface Site {
    file: string;
    line: number;
    /** `publisher/unreadable-local-action` already reports an unreadable action for this job, so this rule stays quiet. */
    covered: boolean;
  }
  /** Action directories a workflow step uses, and whether the job holds a credential. */
  const workflowUses: { directory: string; credential: boolean; site: Site }[] = [];

  for (const file of scan.files) {
    if (file.class === 'unparseable') continue;
    const { model } = file;
    const lines = model.text.split('\n');
    for (const job of model.jobs) {
      const info = file.jobs.find((candidate) => candidate.jobId === job.id);
      const credential = holdsCredential({
        job,
        info,
        inheritsIdToken: job.defaultTokenPermissions && callerGrants(model.file, new Set())
      });
      const jobDirs = job.workingDirectory === undefined ? [] : [job.workingDirectory];
      for (const [key, value] of Object.entries(job.withValues))
        emit({
          file: model.file,
          lines,
          from: job.line,
          hits: runnersIn({
            text: value,
            baseDirs: jobDirs,
            reader,
            credential,
            prose: PROSE_KEY.test(key)
          }),
          credential
        });
      for (const step of job.steps) {
        const dir = step.workingDirectory ?? job.workingDirectory;
        const baseDirs = dir === undefined ? [] : [dir];
        emit({
          file: model.file,
          lines,
          from: step.line,
          hits: readStep({ step, baseDirs, credential }),
          credential
        });
        if (step.uses === undefined) continue;
        const directory = actionDirectory({ uses: step.uses, repository });
        if (directory !== undefined)
          workflowUses.push({
            directory,
            credential,
            site: {
              file: model.file,
              line: step.line,
              covered: info?.holdsPublishCredential === true
            }
          });
      }
    }
  }

  // Every action a workflow reaches, and every action it reaches in turn, is read once; the walk is
  // bounded by the visited set, so a cycle ends it.
  const reads = new Map<string, ActionRead>();
  const readAction = (directory: string): ActionRead => {
    let read = reads.get(directory);
    if (read === undefined) {
      read = readComposite({ root: scan.root, directory });
      reads.set(directory, read);
    }
    return read;
  };
  const edges = new Map<string, { to: string; file: string; line: number }[]>();
  const all = new Set<string>(listActionDirectories(scan.root));
  for (const use of workflowUses) all.add(use.directory);
  const queue = [...all];
  for (let at = 0; at < queue.length && at < MAX_ACTION_DIRECTORIES * 4; at += 1) {
    const directory = queue[at] ?? '';
    const read = readAction(directory);
    if (read.kind !== 'composite') continue;
    for (const step of read.steps) {
      if (step.uses === undefined) continue;
      const to = actionDirectory({ uses: parseUses(step.uses), repository });
      if (to === undefined) continue;
      edges.set(directory, [
        ...(edges.get(directory) ?? []),
        { to, file: read.file, line: step.line }
      ]);
      if (!all.has(to)) {
        all.add(to);
        queue.push(to);
      }
    }
  }

  // Credential status passes from a credential job to every action it uses, and on through the
  // actions those use.
  const credentialed = new Map<string, Site>();
  const spread: string[] = [];
  for (const use of workflowUses)
    if (use.credential && !credentialed.has(use.directory)) {
      credentialed.set(use.directory, use.site);
      spread.push(use.directory);
    }
  for (let at = 0; at < spread.length; at += 1)
    for (const edge of edges.get(spread[at] ?? '') ?? [])
      if (!credentialed.has(edge.to)) {
        credentialed.set(edge.to, {
          file: edge.file,
          line: edge.line,
          covered: credentialed.get(spread[at] ?? '')?.covered === true
        });
        spread.push(edge.to);
      }

  const actionFiles: ScannedFile[] = [];
  for (const directory of [...all].sort()) {
    const read = readAction(directory);
    const credential = credentialed.has(directory);
    if (read.kind === 'unreadable') {
      // Fail closed: a credential job runs an action whose code the check cannot see.
      const site = credentialed.get(directory);
      if (site !== undefined && !site.covered)
        findings.push({
          ruleId: REGISTRY_RUNNER_CREDENTIAL_RULE,
          file: site.file,
          line: site.line,
          message: `The local action \`${directory}\` is used in a job that holds a credential and could not be read (${read.reason}), so the check cannot confirm that it fetches nothing from the registry.`,
          severity: 'error'
        });
      continue;
    }
    if (read.kind !== 'composite') continue;
    const lines = read.text.split('\n');
    actionFiles.push(actionAsFile({ file: read.file, text: read.text }));
    for (const step of read.steps)
      emit({
        file: read.file,
        lines,
        from: step.line,
        hits: readStep({
          step: {
            with: step.with,
            ...(step.run === undefined ? {} : { run: step.run }),
            ...(step.uses === undefined ? {} : { uses: parseUses(step.uses) })
          },
          baseDirs: [],
          credential
        }),
        credential
      });
  }
  return { findings, actionFiles };
};
