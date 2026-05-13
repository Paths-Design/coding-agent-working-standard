// Pure string-formatter for kernel DoctorFinding[].
//
// DoctorFinding has the same envelope as Diagnostic. We render with a
// slightly different label set to make it visible which list the user
// is reading. The doctor command keeps store load diagnostics SEPARATE
// from these findings (the renderer doesn't merge them).

import type { DoctorFinding, FindingSeverity } from '@paths.design/caws-kernel';

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  info: '[INFO   ]',
  warning: '[WARN   ]',
  error: '[ERROR  ]',
};

export interface RenderFindingsOptions {
  /** Show the optional `data` block. Default false. */
  readonly showData?: boolean;
  /** Hide findings below this severity. Default: render all. */
  readonly minSeverity?: FindingSeverity;
}

export function renderFinding(
  f: DoctorFinding,
  opts: RenderFindingsOptions = {}
): string {
  const lines: string[] = [`${SEVERITY_LABEL[f.severity]} ${f.rule}: ${f.message}`];
  if (typeof f.subject === 'string' && f.subject.length > 0) {
    lines.push(`            subject: ${f.subject}`);
  }
  if (typeof f.narrowRepair === 'string' && f.narrowRepair.length > 0) {
    lines.push(`            repair:  ${f.narrowRepair}`);
  }
  if (opts.showData === true && f.data !== undefined) {
    lines.push(`            data:    ${JSON.stringify(f.data)}`);
  }
  return lines.join('\n');
}

export function renderFindings(
  findings: readonly DoctorFinding[],
  opts: RenderFindingsOptions = {}
): string {
  const min = opts.minSeverity ?? 'info';
  const minRank = SEVERITY_RANK[min];
  const kept = findings.filter((f) => SEVERITY_RANK[f.severity] >= minRank);
  if (kept.length === 0) return '';
  return kept.map((f) => renderFinding(f, opts)).join('\n');
}

export function countFindingSeverities(
  findings: readonly DoctorFinding[]
): {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const f of findings) {
    if (f.severity === 'error') errors++;
    else if (f.severity === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}
