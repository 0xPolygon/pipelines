import type { CheckResult, Finding, Profile, RuleContext, ScannedFile } from './types.ts';

import { CALLEE_PATH } from './canonical.ts';
import { applyExceptions } from './exceptions.ts';
import { runsPublishText, scanRepo } from './repo-scan.ts';
import { checkBespokePublisher } from './rules/bespoke-publisher.ts';
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
    else notInScope.push(file.model.file);
  }

  const applied = applyExceptions({ findings, files: scan.files, today: context.today });
  return {
    findings: applied.findings.sort(byLocation),
    exceptions: applied.exceptions,
    notInScope
  };
};
