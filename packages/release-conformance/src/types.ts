export type Severity = 'error' | 'notice';

export interface Finding {
  ruleId: string;
  file: string;
  line: number;
  message: string;
  severity: Severity;
}

export type PermissionLevel = 'none' | 'read' | 'write';

/**
 * A `permissions:` block. `present` is false when the key is missing, which
 * means the repository's default token permissions apply. `all` is set for the
 * `read-all` / `write-all` shorthands; otherwise `scopes` holds the listed
 * scopes (an empty map is `permissions: {}`, every scope `none`).
 */
export interface Permissions {
  present: boolean;
  all?: 'read-all' | 'write-all';
  scopes: Record<string, PermissionLevel>;
  line: number;
}

export interface EventModel {
  name: string;
  line: number;
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  types?: string[];
  /** Input names declared under `workflow_dispatch` or `workflow_call`. */
  inputs: string[];
}

export interface UsesRef {
  raw: string;
  local: boolean;
  /** Lower case: GitHub resolves owner and repository names case-insensitively. Empty for local references. */
  owner: string;
  repo: string;
  /** Path inside the repository (`.github/workflows/x.yml`, `./.github/actions/y` for local). */
  path: string;
  ref: string;
}

export type EnvironmentModel =
  | { kind: 'none' }
  | { kind: 'literal'; name: string }
  | { kind: 'expression'; text: string };

export interface EnvSecretRef {
  key: string;
  expression: string;
}

export interface StepModel {
  line: number;
  uses?: UsesRef;
  run?: string;
  with: Record<string, string>;
  envSecretRefs: EnvSecretRef[];
  /** Literal `working-directory`, when the step sets one. */
  workingDirectory?: string;
}

export interface JobModel {
  id: string;
  line: number;
  uses?: UsesRef;
  needs: string[];
  permissions: Permissions;
  /** Job-level block if present, otherwise the top-level block. */
  effectivePermissions: Permissions;
  /** True when neither level declares permissions: the token default applies. */
  defaultTokenPermissions: boolean;
  environment: EnvironmentModel;
  secrets: { inherit: boolean; names: string[] };
  withKeys: string[];
  withValues: Record<string, string>;
  envSecretRefs: EnvSecretRef[];
  /** Literal `defaults.run.working-directory` of the job or the workflow, when set. */
  workingDirectory?: string;
  steps: StepModel[];
}

export interface WorkflowModel {
  /** Path relative to the scanned root, forward slashes. */
  file: string;
  text: string;
  /** Set when the file could not be read as a workflow; other fields are then empty. */
  parseError?: string;
  /** True when the file was not read at all (too large, or not a regular file): always an error. */
  unreadable?: boolean;
  events: EventModel[];
  permissions: Permissions;
  jobs: JobModel[];
}

export type FileClass = 'shared-caller' | 'bespoke-publisher' | 'not-in-scope' | 'unparseable';

export interface JobScan {
  jobId: string;
  /** Step `run` text of the job plus the `run` text of local composite actions it uses, comments removed. */
  runText: string;
  holdsPublishCredential: boolean;
  /** `id-token: write` is in effect for the job. */
  holdsIdToken: boolean;
  /** An npm token reaches the job through a secret, an environment value or an `.npmrc` line. */
  holdsNpmToken: boolean;
  runsPublishCommand: boolean;
  /** The job installs dependencies or runs a build, test or lint step or a repository tool. */
  runsRepositoryCode: boolean;
  /** Local actions the job uses that the checker could not read, with the reason. */
  unreadableActions: Array<{ path: string; reason: string }>;
  /** Package scripts the job runs by name that no package.json the checker reads defines. */
  unresolvedScripts: string[];
}

export interface ScannedFile {
  model: WorkflowModel;
  class: FileClass;
  jobs: JobScan[];
  /** Events that can start this workflow, including those inherited from local callers. */
  entryEvents: EventModel[];
  /** Files that call this one by `uses: ./.github/workflows/<file>`. */
  localCallers: string[];
}

export interface ScanResult {
  root: string;
  files: ScannedFile[];
}

export interface Profile {
  /** Event name to the inputs the canonical declares for it. */
  allowedEvents: Record<string, { inputs: string[] }>;
  secretNames: string[];
  withKeys: string[];
  /** Highest level per scope across the callee's jobs. */
  floor: Record<string, PermissionLevel>;
  ceiling: Record<string, PermissionLevel>;
  allowedRefs: string[];
  /** `<owner>/<repo>/<path>` of the shared release workflow. */
  callee: string;
}

export interface RuleContext {
  defaultBranch: string;
  repository: string;
  /** UTC date, `YYYY-MM-DD`. */
  today: string;
}

export interface RuleParams {
  model: WorkflowModel;
  scan: ScannedFile;
  profile: Profile;
  context: RuleContext;
}

export type Rule = (params: RuleParams) => Finding[];

export interface ActiveException {
  ruleId: string;
  file: string;
  until: string;
  reason: string;
  line: number;
}

export interface CheckResult {
  findings: Finding[];
  exceptions: ActiveException[];
  notInScope: string[];
}
