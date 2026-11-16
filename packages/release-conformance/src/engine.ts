import type { CheckResult, Finding, Profile, RuleContext, ScannedFile } from './types.ts';

import { CALLEE_PATH } from './canonical.ts';
import { applyExceptions } from './exceptions.ts';
import { runsPublishText, scanRepo } from './repo-scan.ts';
import { checkBespokePublisher, checkUnclassifiedIdToken } from './rules/bespoke-publisher.ts';
import { checkSharedCaller } from './rules/shared-caller.ts';

/** An unreadable file is only a failure when it could be a release workflow; otherwise it is a notice. */
const unparseableFinding = (file: ScannedFile): Finding => {
  const { model } = file;
  const mentionsRelease = model.text.includes(CALLEE_PATH) || runsPublishText(model.text);
  return {
    ruleId: 'workflow/unparseable',
    file: model.file,
    line: 1,
    message: `The workflow file could not be read (${model.parseError ?? 'unknown error'}), so it cannot be checked.`,
    severity: mentionsRelease ? 'error' : 'notice'
  };
};

const CANONICAL_REPOSITORY = '0xPolygon/pipelines';
const CANONICAL_CALLEE_FILE = '.github/workflows/apps-npm-release.yml';

/**
 * The shared release workflow is the reference this checker derives its
 * profile from. Its publisher findings are reported as notices until the
 * planned change to its snapshot path lands, at which point this exclusion is
 * deleted. It applies only when the run's own repository identity (never a
 * value read from the scanned tree) is the canonical repository and the file
 * is exactly the canonical path; every other rule and every other file is
 * checked normally, and a fork or copy gets no exclusion.
 */
const downgradeCanonicalCalleeFindings = ({
  findings,
  repository
}: {
  findings: Finding[];
  repository: string;
}): Finding[] =>
  repository !== CANONICAL_REPOSITORY
    ? findings
    : findings.map((finding) =>
        finding.file === CANONICAL_CALLEE_FILE &&
        finding.ruleId.startsWith('publisher/') &&
        finding.severity === 'error'
          ? { ...finding, severity: 'notice' }
          : finding
      );

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
  const scan = scanRepo({ root });
  const findings: Finding[] = [];
  const notInScope: string[] = [];

  for (const file of scan.files) {
    const params = { model: file.model, scan: file, profile, context };
    if (file.class === 'unparseable') findings.push(unparseableFinding(file));
    else if (file.class === 'shared-caller') findings.push(...checkSharedCaller(params));
    else if (file.class === 'bespoke-publisher') findings.push(...checkBespokePublisher(params));
    else {
      notInScope.push(file.model.file);
      findings.push(...checkUnclassifiedIdToken(params));
    }
  }

  const applied = applyExceptions({ findings, files: scan.files, today: context.today });
  return {
    findings: downgradeCanonicalCalleeFindings({
      findings: applied.findings,
      repository: context.repository
    }).sort(byLocation),
    exceptions: applied.exceptions,
    notInScope
  };
};
