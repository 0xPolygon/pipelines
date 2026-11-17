import type {
  EventModel,
  Finding,
  JobModel,
  PermissionLevel,
  Permissions,
  Rule
} from '../types.ts';

import {
  CALLEE_REPOSITORY,
  levelRank,
  normalizeWorkflowTarget,
  sameRepository
} from '../canonical.ts';
import { isSharedCallee } from '../repo-scan.ts';

/** An opt-in input takes a boolean or an expression; any other literal is a typo GitHub would coerce silently. */
const OPT_IN_VALUE = /^(?:true|false|\$\{\{[\s\S]*\}\})$/;

const levelOf = ({
  permissions,
  scope
}: {
  permissions: Permissions;
  scope: string;
}): PermissionLevel => {
  if (permissions.all === 'write-all') return 'write';
  if (permissions.all === 'read-all') return 'read';
  return permissions.scopes[scope] ?? 'none';
};

const exceedsCeiling = ({
  permissions,
  ceiling
}: {
  permissions: Permissions;
  ceiling: Record<string, PermissionLevel>;
}): string[] => {
  if (permissions.all !== undefined) return [permissions.all];
  return Object.entries(permissions.scopes)
    .filter(([scope, level]) => levelRank(level) > levelRank(ceiling[scope] ?? 'none'))
    .map(([scope, level]) => `${scope}: ${level}`);
};

/**
 * Rules for workflow files that call the shared npm release workflow. The
 * profile (events, inputs, secrets, floor) comes from the canonical trigger and
 * release files, so a canonical change moves these rules without a code edit.
 */
export const checkSharedCaller: Rule = ({ model, scan, profile, context }) => {
  const findings: Finding[] = [];
  const add = ({ ruleId, line, message }: { ruleId: string; line: number; message: string }) => {
    findings.push({ ruleId, file: model.file, line, message, severity: 'error' });
  };

  const callingJobs: JobModel[] = model.jobs.filter(
    (job) => job.uses !== undefined && isSharedCallee(job.uses)
  );
  const callingIds = new Set(callingJobs.map((job) => job.id));

  // caller/callee
  for (const job of callingJobs) {
    const uses = job.uses;
    if (uses === undefined) continue;
    if (uses.local) {
      if (!sameRepository({ a: context.repository, b: CALLEE_REPOSITORY })) {
        add({
          ruleId: 'caller/callee',
          line: job.line,
          message: `Job \`${job.id}\` must call \`${profile.callee}\` at one of: ${profile.allowedRefs.join(', ')}; a local path is accepted only in ${CALLEE_REPOSITORY}.`
        });
      }
      continue;
    }
    const target = uses.raw.slice(0, uses.raw.lastIndexOf('@'));
    if (normalizeWorkflowTarget(target) !== normalizeWorkflowTarget(profile.callee)) {
      add({
        ruleId: 'caller/callee',
        line: job.line,
        message: `Job \`${job.id}\` must call \`${profile.callee}\`, not \`${target}\`.`
      });
    } else if (!profile.allowedRefs.includes(uses.ref)) {
      add({
        ruleId: 'caller/callee',
        line: job.line,
        message: `Job \`${job.id}\` must call the release workflow at ref ${profile.allowedRefs.map((ref) => `\`${ref}\``).join(' or ')}, not \`${uses.ref}\`.`
      });
    }
  }

  // caller/events
  const checkPush = (event: EventModel) => {
    const branches = event.branches ?? [];
    const onlyDefault = branches.length === 1 && branches[0] === context.defaultBranch;
    if (!onlyDefault || event.branchesIgnore !== undefined) {
      add({
        ruleId: 'caller/events',
        line: event.line,
        message: `\`push\` must be limited to the default branch \`${context.defaultBranch}\` with \`branches: [${context.defaultBranch}]\`.`
      });
    }
    if (event.tags !== undefined || event.tagsIgnore !== undefined) {
      add({
        ruleId: 'caller/events',
        line: event.line,
        message: '`push` must not declare `tags` or `tags-ignore`.'
      });
    }
  };
  for (const event of model.events) {
    if (event.name === 'pull_request_target') {
      add({
        ruleId: 'caller/pull-request-target',
        line: event.line,
        message: 'A release caller must not use the `pull_request_target` event.'
      });
      continue;
    }
    const allowed = profile.allowedEvents[event.name];
    if (allowed === undefined) {
      add({
        ruleId: 'caller/events',
        line: event.line,
        message: `Event \`${event.name}\` is not one of the events the canonical trigger uses: ${Object.keys(profile.allowedEvents).join(', ')}.`
      });
      continue;
    }
    if (event.name === 'push') checkPush(event);
    for (const input of event.inputs) {
      if (!allowed.inputs.includes(input)) {
        add({
          ruleId: 'caller/events',
          line: event.line,
          message: `\`${event.name}\` input \`${input}\` is not declared by the canonical trigger.`
        });
      }
    }
  }

  // caller/permissions-ceiling
  if (!model.permissions.present) {
    add({
      ruleId: 'caller/permissions-ceiling',
      line: 1,
      message: 'A top-level `permissions` block is required.'
    });
  }
  const ceilingList = Object.entries(profile.ceiling)
    .map(([scope, level]) => `${scope}: ${level}`)
    .join(', ');
  for (const exceeded of exceedsCeiling({
    permissions: model.permissions,
    ceiling: profile.ceiling
  })) {
    add({
      ruleId: 'caller/permissions-ceiling',
      line: model.permissions.line,
      message: `Top-level permission \`${exceeded}\` exceeds the allowed ceiling (${ceilingList}).`
    });
  }
  for (const job of model.jobs) {
    for (const exceeded of exceedsCeiling({
      permissions: job.permissions,
      ceiling: profile.ceiling
    })) {
      add({
        ruleId: 'caller/permissions-ceiling',
        line: job.permissions.line,
        message: `Job \`${job.id}\` permission \`${exceeded}\` exceeds the allowed ceiling (${ceilingList}).`
      });
    }
  }

  // caller/permissions-floor
  for (const job of callingJobs) {
    // With no block at either level the token default applies; the ceiling rule reports that.
    if (job.defaultTokenPermissions) continue;
    for (const [scope, required] of Object.entries(profile.floor)) {
      const held = levelOf({ permissions: job.effectivePermissions, scope });
      if (levelRank(held) < levelRank(required)) {
        add({
          ruleId: 'caller/permissions-floor',
          line: job.line,
          message: `Job \`${job.id}\` must grant \`${scope}: ${required}\` to the release workflow.`
        });
      }
    }
  }

  // caller/publish-permission-scope
  for (const jobScan of scan.jobs) {
    if (callingIds.has(jobScan.jobId) || !jobScan.holdsPublishCredential) continue;
    const job = model.jobs.find((candidate) => candidate.id === jobScan.jobId);
    add({
      ruleId: 'caller/publish-permission-scope',
      line: job?.line ?? 1,
      message: `Only the job that calls the release workflow may hold \`id-token: write\` or an npm token; job \`${jobScan.jobId}\` must not.`
    });
  }

  // caller/secrets and caller/inputs
  for (const job of callingJobs) {
    if (job.secrets.inherit) {
      add({
        ruleId: 'caller/secrets-inherit',
        line: job.line,
        message: `Job \`${job.id}\` must pass secrets by name; \`secrets: inherit\` is not allowed.`
      });
    }
    for (const name of job.secrets.names) {
      if (!profile.secretNames.includes(name)) {
        add({
          ruleId: 'caller/secrets',
          line: job.line,
          message: `Secret \`${name}\` is not one the canonical trigger passes (${profile.secretNames.join(', ')}).`
        });
      }
    }
    for (const key of job.withKeys) {
      if (profile.withKeys.includes(key)) continue;
      if (profile.optInWithKeys.includes(key)) {
        const value = job.withValues[key] ?? '';
        if (!OPT_IN_VALUE.test(value.trim())) {
          add({
            ruleId: 'caller/inputs',
            line: job.line,
            message: `\`with\` key \`${key}\` must be \`true\`, \`false\` or a \`\${{ ... }}\` expression, not \`${value}\`.`
          });
        }
        continue;
      }
      add({
        ruleId: 'caller/inputs',
        line: job.line,
        message: `\`with\` key \`${key}\` is not allowed. The canonical trigger passes: ${profile.withKeys.join(', ') || '(none)'}. Allowed opt-ins: ${profile.optInWithKeys.join(', ') || '(none)'}.`
      });
    }
  }

  return findings;
};
