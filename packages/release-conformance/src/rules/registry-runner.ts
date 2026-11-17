import { readdirSync } from 'node:fs';
import { join, posix } from 'node:path';

import type { ScriptReader } from '../package-scripts.ts';
import type { Finding, JobModel, JobScan, ScanResult, ScannedFile, Severity } from '../types.ts';

import { CALLEE_PATH, CALLEE_REPOSITORY, sameRepository } from '../canonical.ts';
import { createScriptReader } from '../package-scripts.ts';
import { readLocalAction } from '../repo-scan.ts';
import { linkedParent } from '../safe-read.ts';
import { analyzeShell } from '../shell-commands.ts';
import { secretReferences } from '../workflow-model.ts';

/** A registry-fetching runner anywhere a command can run. A dated in-file marker may waive it. */
export const REGISTRY_RUNNER_RULE = 'runner/registry-fetch';
/**
 * The same condition in a job that holds a credential. A separate id, because a marker
 * waives by id and this one must never be waivable.
 */
export const REGISTRY_RUNNER_CREDENTIAL_RULE = 'runner/registry-fetch-with-credential';

const ACTIONS_DIR = '.github/actions';
const MAX_ACTION_DEPTH = 4;
const MAX_ACTION_DIRECTORIES = 400;
/** Where the shared release workflow checks out its own repository, so its local actions resolve into this tree. */
const CALLEE_CHECKOUT_PREFIX = '.pipelines/';

interface Hit {
  runner: string;
  /** The package script whose body holds the runner, when the command only runs the script. */
  viaScript?: string;
}

/**
 * Runners named by a piece of shell text, plus those in the body of a package script the text runs
 * (one level down, the same lookup the publish detection uses).
 */
const runnersIn = ({
  text,
  baseDirs,
  reader
}: {
  text: string;
  baseDirs: string[];
  reader: ScriptReader;
}): Hit[] => {
  const facts = analyzeShell({ text, baseDirs });
  const hits: Hit[] = facts.registryRunners.map((runner) => ({ runner }));
  for (const ref of facts.scripts) {
    for (const body of reader.lookup(ref).bodies) {
      for (const runner of analyzeShell({ text: body }).registryRunners)
        hits.push({ runner, viaScript: ref.name });
    }
  }
  return hits;
};

/** True when the text reads any secret other than the workflow's own `GITHUB_TOKEN`. */
const readsSecret = (text: string): boolean =>
  secretReferences(text).some((name) => name.toUpperCase() !== 'GITHUB_TOKEN');

/**
 * Whether a job holds a credential for this rule. Wider than the publishing-credential test the other
 * rules use: a registry fetch beside any secret (a deploy token, say) runs unvetted code with it, so
 * any secret except `GITHUB_TOKEN` counts, wherever the job references it: `env`, a `with:` value,
 * `run:` text, or `secrets:` on a reusable-workflow call (`inherit`, or any named secret).
 */
const holdsCredential = ({ job, info }: { job: JobModel; info: JobScan | undefined }): boolean =>
  info?.holdsPublishCredential === true ||
  job.secrets.inherit ||
  job.secrets.names.length > 0 ||
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
 * never failing the run. The credentialed id is always an error.
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

/** Repository-relative action directory a local `uses:` reaches, or undefined when it is outside the action tree. */
const actionDirectory = ({ path, calleeContext }: { path: string; calleeContext: boolean }) => {
  let relative = posix.normalize(path.replace(/^\.\//, ''));
  if (calleeContext && relative.startsWith(CALLEE_CHECKOUT_PREFIX))
    relative = relative.slice(CALLEE_CHECKOUT_PREFIX.length);
  return relative.startsWith(`${ACTIONS_DIR}/`) ? relative : undefined;
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

const lineOf = ({ text, snippet }: { text: string; snippet: string }): number => {
  const first = snippet
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  const at = first === undefined ? -1 : text.indexOf(first);
  if (at < 0) return 1;
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
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
 * `npm x`, `pnpm dlx`, `yarn dlx`) in any workflow step or `with:` string, in a composite action of the
 * repository, or in a package script a command runs. It reads every workflow, not only the release ones:
 * a fetch at run time bypasses the lockfile wherever it happens. `pnpm exec` resolves from the lockfile
 * and is allowed. In a job that holds a credential the finding carries the never-waivable id;
 * a composite action counts as credentialed when any job that holds one uses it.
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
  const credentialedActions = new Set<string>();
  const ruleFor = (credential: boolean): string =>
    credential ? REGISTRY_RUNNER_CREDENTIAL_RULE : REGISTRY_RUNNER_RULE;

  for (const file of scan.files) {
    if (file.class === 'unparseable') continue;
    const { model } = file;
    const calleeContext =
      model.file === CALLEE_PATH && sameRepository({ a: repository, b: CALLEE_REPOSITORY });
    const report = ({
      hits,
      line,
      credential
    }: {
      hits: Hit[];
      line: number;
      credential: boolean;
    }): void => {
      for (const hit of hits)
        findings.push({
          ruleId: ruleFor(credential),
          file: model.file,
          line,
          message: messageFor({ hit, credential }),
          severity: severityFor(credential)
        });
    };
    for (const job of model.jobs) {
      const credential = holdsCredential({
        job,
        info: file.jobs.find((candidate) => candidate.jobId === job.id)
      });
      const jobDirs = job.workingDirectory === undefined ? [] : [job.workingDirectory];
      for (const value of Object.values(job.withValues))
        report({
          hits: runnersIn({ text: value, baseDirs: jobDirs, reader }),
          line: job.line,
          credential
        });
      for (const step of job.steps) {
        const dir = step.workingDirectory ?? job.workingDirectory;
        const baseDirs = dir === undefined ? [] : [dir];
        if (step.run !== undefined)
          report({
            hits: runnersIn({ text: step.run, baseDirs, reader }),
            line: step.line,
            credential
          });
        if (step.uses === undefined) continue;
        for (const value of Object.values(step.with))
          report({
            hits: runnersIn({ text: value, baseDirs, reader }),
            line: step.line,
            credential
          });
        if (credential && step.uses.local) {
          const directory = actionDirectory({ path: step.uses.path, calleeContext });
          if (directory !== undefined) credentialedActions.add(directory);
        }
      }
    }
  }

  const actionFiles: ScannedFile[] = [];
  for (const directory of listActionDirectories(scan.root)) {
    const read = readLocalAction({ root: scan.root, path: directory, calleeContext: false });
    const { steps, text } = read;
    if (steps === undefined || text === undefined) continue;
    const credential = credentialedActions.has(directory);
    const file = `${directory}/action.yml`;
    actionFiles.push(actionAsFile({ file, text }));
    for (const step of steps) {
      const texts = [
        ...(step.run === undefined ? [] : [step.run]),
        ...(step.uses === undefined ? [] : Object.values(step.with))
      ];
      for (const value of texts)
        for (const hit of runnersIn({ text: value, baseDirs: [], reader }))
          findings.push({
            ruleId: ruleFor(credential),
            file,
            line: lineOf({ text, snippet: value }),
            message: messageFor({ hit, credential }),
            severity: severityFor(credential)
          });
    }
  }
  return { findings, actionFiles };
};
