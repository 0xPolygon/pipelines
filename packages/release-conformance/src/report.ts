import type { ActiveException, CheckResult, FileClass, Finding } from './types.ts';

/**
 * Every value that comes from the repository under review (file names, keys,
 * reasons) reaches the runner as text that the runner parses: workflow commands
 * on the log, Markdown in the job summary. Escaping here is what keeps a crafted
 * value from becoming a second command or a second table row.
 */

/** Workflow-command message text: `%`, CR and LF are the only characters the runner decodes. */
export const escapeCommandData = (value: string): string =>
  value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** Workflow-command property text: the data escapes plus the two property delimiters. */
export const escapeCommandProperty = (value: string): string =>
  escapeCommandData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** Markdown table cell text: one line, no HTML, no link, emphasis, code or table syntax. */
export const escapeMarkdown = (value: string): string =>
  value
    .replace(/\r\n|\r|\n/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()|~]/g, (char) => `\\${char}`)
    // Break what the Markdown renderer would turn into a link or a mention.
    .replace(/:\/\//g, ':\u200b//')
    .replace(/www\./gi, (match) => `${match.slice(0, 3)}\u200b.`)
    .replace(/@/g, '@\u200b');

export interface InScopeFile {
  file: string;
  class: Exclude<FileClass, 'not-in-scope'>;
}

const CLASS_LABEL: Record<InScopeFile['class'], string> = {
  'shared-caller': 'shared caller',
  'bespoke-publisher': 'bespoke publisher',
  unparseable: 'unreadable'
};

const annotation = ({ finding }: { finding: Finding }): string => {
  const command = finding.severity === 'error' ? 'error' : 'notice';
  const file = escapeCommandProperty(finding.file);
  const title = escapeCommandProperty(finding.ruleId);
  return `::${command} file=${file},line=${Math.max(1, Math.trunc(finding.line))},title=${title}::${escapeCommandData(finding.message)}`;
};

const exceptionAnnotation = ({ exception }: { exception: ActiveException }): string => {
  const file = escapeCommandProperty(exception.file);
  const title = escapeCommandProperty(`${exception.ruleId} (exception)`);
  const message = `Exception active until ${exception.until}: ${exception.reason}`;
  return `::notice file=${file},line=${Math.max(1, Math.trunc(exception.line))},title=${title}::${escapeCommandData(message)}`;
};

/** Exactly one workflow command per finding and per active exception. */
export const formatAnnotations = ({ result }: { result: CheckResult }): string[] => [
  ...result.findings.map((finding) => annotation({ finding })),
  ...result.exceptions.map((exception) => exceptionAnnotation({ exception }))
];

const table = ({ header, rows }: { header: string[]; rows: string[][] }): string[] => [
  `| ${header.join(' | ')} |`,
  `| ${header.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.join(' | ')} |`)
];

export const formatSummary = ({
  result,
  inScope
}: {
  result: CheckResult;
  inScope: InScopeFile[];
}): string => {
  const errors = result.findings.filter((f) => f.severity === 'error').length;
  const lines: string[] = ['## Release workflow conformance', ''];
  lines.push(
    errors === 0 ? 'No errors.' : `${errors} ${errors === 1 ? 'error' : 'errors'} must be fixed.`,
    ''
  );

  if (inScope.length === 0) {
    lines.push('Nothing in scope: no workflow here calls or runs an npm publish.', '');
  } else {
    lines.push('### Files in scope', '');
    lines.push(
      ...table({
        header: ['File', 'Class'],
        rows: inScope.map((f) => [escapeMarkdown(f.file), CLASS_LABEL[f.class]])
      }),
      ''
    );
  }

  if (result.findings.length > 0) {
    lines.push('### Findings', '');
    lines.push(
      ...table({
        header: ['Rule', 'Severity', 'File', 'Line', 'Message'],
        rows: result.findings.map((f) => [
          escapeMarkdown(f.ruleId),
          f.severity,
          escapeMarkdown(f.file),
          String(Math.trunc(f.line)),
          escapeMarkdown(f.message)
        ])
      }),
      ''
    );
  }

  if (result.exceptions.length > 0) {
    lines.push('### Active exceptions', '');
    lines.push(
      ...table({
        header: ['Rule', 'File', 'Until', 'Reason'],
        rows: result.exceptions.map((e) => [
          escapeMarkdown(e.ruleId),
          escapeMarkdown(e.file),
          escapeMarkdown(e.until),
          escapeMarkdown(e.reason)
        ])
      }),
      ''
    );
  }

  if (result.notInScope.length > 0) {
    lines.push('### Files not in scope', '');
    lines.push(...result.notInScope.map((file) => `- ${escapeMarkdown(file)}`), '');
  }

  return `${lines.join('\n')}\n`;
};

export const formatJson = ({
  result,
  inScope,
  context
}: {
  result: CheckResult;
  inScope: InScopeFile[];
  context: { repository: string; defaultBranch: string; today: string };
}): string =>
  `${JSON.stringify(
    {
      repository: context.repository,
      defaultBranch: context.defaultBranch,
      date: context.today,
      errorCount: result.findings.filter((f) => f.severity === 'error').length,
      findings: result.findings,
      exceptions: result.exceptions,
      inScope,
      notInScope: result.notInScope
    },
    null,
    2
  )}\n`;
