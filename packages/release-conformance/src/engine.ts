import type { CheckResult, Finding, Profile, RuleContext, ScannedFile } from './types.ts';

import { CALLEE_PATH, CALLEE_REPOSITORY, sameRepository } from './canonical.ts';
import { applyExceptions } from './exceptions.ts';
import { runsPublishText, scanRepo } from './repo-scan.ts';
import { checkBespokePublisher, checkUnclassifiedJobs } from './rules/bespoke-publisher.ts';
import { checkSharedCaller } from './rules/shared-caller.ts';

/** An unreadable file is only a failure when it could be a release workflow; otherwise it is a notice. */
const unparseableFinding = (file: ScannedFile): Finding => {
  const { model } = file;
  // A file that was never read (too large, not a regular file) could hold anything, so it always fails.
  const mentionsRelease =
    model.unreadable === true || model.text.includes(CALLEE_PATH) || runsPublishText(model.text);
  return {
    ruleId: 'workflow/unparseable',
    file: model.file,
    line: 1,
    message: `The workflow file could not be read (${model.parseError ?? 'unknown error'}), so it cannot be checked.`,
    severity: mentionsRelease ? 'error' : 'notice'
  };
};

/**
 * The only publisher findings the reference workflow may carry as notices. The
 * set is closed on purpose: a new rule, or any other condition on that file,
 * stays an error so a change to the reference cannot add a defect unseen.
 */
export const REFERENCE_DOWNGRADE_RULES: ReadonlySet<string> = new Set([
  'publisher/publishing-dispatch',
  'publisher/id-token-with-code',
  'publisher/environment'
]);

/**
 * The shared release workflow is the reference this checker derives its
 * profile from, so it is allowed to differ from the rules derived from it in
 * the three ways named above. It applies only when the run's own repository
 * identity (never a value read from the scanned tree) is the canonical
 * repository and the file is exactly the canonical path; every other rule and
 * every other file is checked normally, and a fork or copy gets no exclusion.
 */
const downgradeCanonicalCalleeFindings = ({
  findings,
  repository
}: {
  findings: Finding[];
  repository: string;
}): Finding[] =>
  !sameRepository({ a: repository, b: CALLEE_REPOSITORY })
    ? findings
    : findings.map((finding) =>
        finding.file === CALLEE_PATH &&
        REFERENCE_DOWNGRADE_RULES.has(finding.ruleId) &&
        finding.severity === 'error'
          ? { ...finding, severity: 'notice' }
          : finding
      );

/** The same rule reporting the same message at the same place is one finding, however many steps led to it. */
const unique = (findings: Finding[]): Finding[] => {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = JSON.stringify([f.ruleId, f.file, f.line, f.message, f.severity]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const byLocation = (a: Finding, b: Finding): number =>
  a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;

export const runChecks = ({
  root,
  profile,
  context
}: {
  root: string;
  profile: Profile;
  context: RuleContext;
}): CheckResult => {
  const scan = scanRepo({ root, repository: context.repository });
  const findings: Finding[] = [];
  const notInScope: string[] = [];

  for (const file of scan.files) {
    const params = { model: file.model, scan: file, profile, context };
    if (file.class === 'unparseable') findings.push(unparseableFinding(file));
    else if (file.class === 'shared-caller') findings.push(...checkSharedCaller(params));
    else if (file.class === 'bespoke-publisher') findings.push(...checkBespokePublisher(params));
    else {
      notInScope.push(file.model.file);
      findings.push(...checkUnclassifiedJobs(params));
    }
  }

  const applied = applyExceptions({ findings, files: scan.files, today: context.today });
  return {
    findings: unique(
      downgradeCanonicalCalleeFindings({
        findings: applied.findings,
        repository: context.repository
      })
    ).sort(byLocation),
    exceptions: applied.exceptions,
    notInScope
  };
};
