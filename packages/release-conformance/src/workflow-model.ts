import type { Document } from 'yaml';

import { LineCounter, isMap, isNode, isScalar, parseDocument } from 'yaml';

import type {
  EnvSecretRef,
  EnvironmentModel,
  EventModel,
  JobModel,
  PermissionLevel,
  Permissions,
  StepModel,
  UsesRef,
  WorkflowModel
} from './types.ts';

/** Files larger than this are rejected: workflow files are small, and a huge one is not worth parsing. */
export const MAX_WORKFLOW_BYTES = 1_000_000;
/** Caps alias expansion so a file of nested anchors cannot blow up memory. */
export const MAX_ALIAS_COUNT = 50;

type Path = (string | number)[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

const toStringList = (value: unknown): string[] | undefined => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.map(toText);
  return undefined;
};

const toStringMap = (value: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) out[key] = toText(entry);
  }
  return out;
};

export const emptyPermissions = (): Permissions => ({ present: false, scopes: {}, line: 0 });

/**
 * GitHub resolves owner and repository names case-insensitively, so identity is
 * compared on the lower-cased pair. The path inside the repository is a file
 * path and keeps its case.
 */
export const parseUses = (raw: string): UsesRef => {
  if (raw.startsWith('./')) {
    return { raw, local: true, owner: '', repo: '', path: raw, ref: '' };
  }
  const match = /^([^/@\s]+)\/([^/@\s]+)(?:\/([^@\s]*))?@(\S+)$/.exec(raw);
  if (match === null) {
    return { raw, local: false, owner: '', repo: '', path: raw, ref: '' };
  }
  return {
    raw,
    local: false,
    owner: (match[1] ?? '').toLowerCase(),
    repo: (match[2] ?? '').toLowerCase(),
    path: match[3] ?? '',
    ref: match[4] ?? ''
  };
};

const toLevel = (value: unknown): PermissionLevel =>
  value === 'write' || value === 'read' ? value : 'none';

const parsePermissions = ({
  value,
  present,
  line
}: {
  value: unknown;
  present: boolean;
  line: number;
}): Permissions => {
  if (!present) return { present: false, scopes: {}, line };
  if (value === 'read-all' || value === 'write-all')
    return { present: true, all: value, scopes: {}, line };
  const scopes: Record<string, PermissionLevel> = {};
  if (isRecord(value)) {
    for (const [scope, level] of Object.entries(value)) scopes[scope] = toLevel(level);
  }
  return { present: true, scopes, line };
};

/**
 * Secret names referenced in an expression. The `secrets` context name and the
 * property syntax are case-insensitive in expressions, and both `secrets.NAME`
 * and `secrets['NAME']` read the same secret.
 */
export const secretReferences = (text: string): string[] => {
  const names: string[] = [];
  for (const match of text.matchAll(
    /\bsecrets\s*(?:\.\s*([A-Za-z0-9_-]+)|\[\s*(?:'([^']*)'|"([^"]*)")\s*\])/gi
  )) {
    names.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return names;
};

/** Environment variable names the npm client reads its registry token from. */
export const NPM_TOKEN_KEYS = new Set(['NODE_AUTH_TOKEN', 'NPM_TOKEN']);

/** Entries that reference a secret, plus every npm token variable whatever its value. */
const envSecretRefs = (env: unknown): EnvSecretRef[] => {
  const refs: EnvSecretRef[] = [];
  if (isRecord(env)) {
    for (const [key, entry] of Object.entries(env)) {
      const expression = toText(entry);
      if (NPM_TOKEN_KEYS.has(key.toUpperCase()) || secretReferences(expression).length > 0)
        refs.push({ key, expression });
    }
  }
  return refs;
};

const parseEnvironment = (value: unknown): EnvironmentModel => {
  const name = isRecord(value) ? value['name'] : value;
  const text = toText(name);
  if (text === '') return { kind: 'none' };
  return text.includes('${{') ? { kind: 'expression', text } : { kind: 'literal', name: text };
};

interface Lines {
  doc: Document.Parsed;
  counter: LineCounter;
}

const lineOfKey = ({ doc, counter }: Lines, path: Path): number => {
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1];
  const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
  if (isMap(parent)) {
    for (const pair of parent.items) {
      if (isScalar(pair.key) && String(pair.key.value) === String(last) && pair.key.range) {
        return counter.linePos(pair.key.range[0]).line;
      }
    }
  }
  return 0;
};

const lineOfNode = ({ doc, counter }: Lines, path: Path): number => {
  const node = doc.getIn(path, true);
  if (isNode(node) && node.range) return counter.linePos(node.range[0]).line;
  return 0;
};

const eventFromValue = ({
  name,
  value,
  line
}: {
  name: string;
  value: unknown;
  line: number;
}): EventModel => {
  const event: EventModel = { name, line, inputs: [] };
  if (!isRecord(value)) return event;
  const branches = toStringList(value['branches']);
  const branchesIgnore = toStringList(value['branches-ignore']);
  const tags = toStringList(value['tags']);
  const tagsIgnore = toStringList(value['tags-ignore']);
  const paths = toStringList(value['paths']);
  const types = toStringList(value['types']);
  if (branches) event.branches = branches;
  if (branchesIgnore) event.branchesIgnore = branchesIgnore;
  if (tags) event.tags = tags;
  if (tagsIgnore) event.tagsIgnore = tagsIgnore;
  if (paths) event.paths = paths;
  if (types) event.types = types;
  const inputs = value['inputs'];
  if (isRecord(inputs)) event.inputs = Object.keys(inputs);
  return event;
};

/** `on:` may be a string, a list of names, or a map of name to filters. */
const parseEvents = ({ raw, lines }: { raw: unknown; lines: Lines }): EventModel[] => {
  const onLine = lineOfKey(lines, ['on']);
  if (typeof raw === 'string') return [{ name: raw, line: onLine, inputs: [] }];
  if (Array.isArray(raw))
    return raw.map((name) => ({ name: toText(name), line: onLine, inputs: [] }));
  if (isRecord(raw)) {
    return Object.entries(raw).map(([name, value]) =>
      eventFromValue({ name, value, line: lineOfKey(lines, ['on', name]) })
    );
  }
  return [];
};

const parseSteps = ({
  raw,
  lines,
  jobId
}: {
  raw: unknown;
  lines: Lines;
  jobId: string;
}): StepModel[] => {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index): StepModel => {
    const step = isRecord(entry) ? entry : {};
    const uses = typeof step['uses'] === 'string' ? parseUses(step['uses']) : undefined;
    const model: StepModel = {
      line: lineOfNode(lines, ['jobs', jobId, 'steps', index]),
      with: toStringMap(step['with']),
      envSecretRefs: envSecretRefs(step['env'])
    };
    if (uses) model.uses = uses;
    if (typeof step['run'] === 'string') model.run = step['run'];
    return model;
  });
};

const parseJobs = ({
  raw,
  topLevel,
  topLevelEnv,
  lines
}: {
  raw: unknown;
  topLevel: Permissions;
  topLevelEnv: EnvSecretRef[];
  lines: Lines;
}): JobModel[] => {
  if (!isRecord(raw)) return [];
  return Object.entries(raw).map(([id, value]): JobModel => {
    const job = isRecord(value) ? value : {};
    const permissions = parsePermissions({
      value: job['permissions'],
      present: 'permissions' in job,
      line: lineOfKey(lines, ['jobs', id, 'permissions'])
    });
    const secrets = job['secrets'];
    const model: JobModel = {
      id,
      line: lineOfKey(lines, ['jobs', id]),
      needs: toStringList(job['needs']) ?? [],
      permissions,
      effectivePermissions: permissions.present ? permissions : topLevel,
      defaultTokenPermissions: !permissions.present && !topLevel.present,
      environment: parseEnvironment(job['environment']),
      secrets: {
        inherit: secrets === 'inherit',
        names: isRecord(secrets) ? Object.keys(secrets) : []
      },
      withKeys: isRecord(job['with']) ? Object.keys(job['with']) : [],
      withValues: toStringMap(job['with']),
      // Workflow-level `env` reaches every job, so its secret references are held by each of them.
      envSecretRefs: [...topLevelEnv, ...envSecretRefs(job['env'])],
      steps: parseSteps({ raw: job['steps'], lines, jobId: id })
    };
    if (typeof job['uses'] === 'string') model.uses = parseUses(job['uses']);
    return model;
  });
};

const failed = ({
  file,
  text,
  reason,
  unreadable = false
}: {
  file: string;
  text: string;
  reason: string;
  unreadable?: boolean;
}): WorkflowModel => ({
  file,
  text,
  parseError: reason,
  ...(unreadable ? { unreadable } : {}),
  events: [],
  permissions: emptyPermissions(),
  jobs: []
});

/** A directory entry that looks like a workflow file but was not read, so it cannot be checked. */
export const unreadableWorkflow = ({ file, reason }: { file: string; reason: string }) =>
  failed({ file, text: '', reason, unreadable: true });

export const parseWorkflow = ({ file, text }: { file: string; text: string }): WorkflowModel => {
  if (Buffer.byteLength(text, 'utf8') > MAX_WORKFLOW_BYTES) {
    return unreadableWorkflow({
      file,
      reason: `file is larger than ${MAX_WORKFLOW_BYTES} bytes`
    });
  }
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter });
  const firstError = doc.errors[0];
  // The parser's own message quotes the offending source line; the code and position are enough.
  if (firstError) {
    const position = firstError.linePos?.[0];
    return failed({
      file,
      text,
      reason: `YAML ${firstError.code}${position ? ` at line ${position.line}` : ''}`
    });
  }

  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (error) {
    return failed({
      file,
      text,
      reason: error instanceof Error ? error.message : 'could not read the document'
    });
  }
  if (!isRecord(raw)) return failed({ file, text, reason: 'the document is not a mapping' });

  const lines: Lines = { doc, counter };
  const permissions = parsePermissions({
    value: raw['permissions'],
    present: 'permissions' in raw,
    line: lineOfKey(lines, ['permissions'])
  });
  return {
    file,
    text,
    events: parseEvents({ raw: raw['on'], lines }),
    permissions,
    jobs: parseJobs({
      raw: raw['jobs'],
      topLevel: permissions,
      topLevelEnv: envSecretRefs(raw['env']),
      lines
    })
  };
};
