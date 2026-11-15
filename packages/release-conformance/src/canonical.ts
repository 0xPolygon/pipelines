import type { PermissionLevel, Profile, WorkflowModel } from './types.ts';

/** Repository and path of the shared npm release workflow that callers must use. */
export const CALLEE_REPOSITORY = '0xPolygon/pipelines';
export const CALLEE_PATH = '.github/workflows/apps-npm-release.yml';
/** The archived predecessor of the shared workflow repository; calls to it are still shared-caller calls. */
export const ARCHIVED_CALLEE_REPOSITORY = '0xPolygon/apps-team-workflows';

/** Fixed settings: the most a caller may grant, and the refs it may use. */
export const FIXED_CEILING: Record<string, PermissionLevel> = {
  contents: 'write',
  'pull-requests': 'write',
  'id-token': 'write',
  attestations: 'write'
};
export const FIXED_ALLOWED_REFS = ['main'];

const RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2 };

export const higherLevel = ({
  a,
  b
}: {
  a: PermissionLevel;
  b: PermissionLevel;
}): PermissionLevel => (RANK[a] >= RANK[b] ? a : b);

export const levelRank = (level: PermissionLevel): number => RANK[level];

/**
 * The permissions a caller must grant: for each scope, the highest level any
 * job of the release workflow declares. GitHub refuses to start a run whose
 * caller grants less than a called job asks for, so the floor follows the
 * release workflow rather than a copy of it.
 */
export const deriveFloor = (release: WorkflowModel): Record<string, PermissionLevel> => {
  const floor: Record<string, PermissionLevel> = {};
  for (const job of release.jobs) {
    for (const [scope, level] of Object.entries(job.effectivePermissions.scopes)) {
      floor[scope] = higherLevel({ a: floor[scope] ?? 'none', b: level });
    }
  }
  for (const [scope, level] of Object.entries(floor)) {
    if (level === 'none') delete floor[scope];
  }
  return floor;
};

/**
 * Builds the caller profile from the canonical trigger and release files:
 * events and inputs the trigger offers, the secret names and `with` keys on
 * its calling job, and the floor from the release file.
 */
export const deriveProfile = ({
  trigger,
  release
}: {
  trigger: WorkflowModel;
  release: WorkflowModel;
}): Profile => {
  const allowedEvents: Profile['allowedEvents'] = {};
  for (const event of trigger.events) allowedEvents[event.name] = { inputs: [...event.inputs] };
  const caller = trigger.jobs.find((job) => job.uses !== undefined);
  return {
    allowedEvents,
    secretNames: caller ? [...caller.secrets.names] : [],
    withKeys: caller ? [...caller.withKeys] : [],
    floor: deriveFloor(release),
    ceiling: { ...FIXED_CEILING },
    allowedRefs: [...FIXED_ALLOWED_REFS],
    callee: `${CALLEE_REPOSITORY}/${CALLEE_PATH}`
  };
};
