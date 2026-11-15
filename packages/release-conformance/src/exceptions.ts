import type { ActiveException, Finding, ScannedFile } from './types.ts';

/** Placeholder until the exception-marker stage: nothing is waived and no marker is read. */
export const applyExceptions = ({
  findings
}: {
  findings: Finding[];
  files: ScannedFile[];
  today: string;
}): { findings: Finding[]; exceptions: ActiveException[] } => ({ findings, exceptions: [] });
