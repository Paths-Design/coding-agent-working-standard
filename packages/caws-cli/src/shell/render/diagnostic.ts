// Pure string-formatter for kernel/store/shell Diagnostic[].
//
// Renderer keys presentation off `severity` and the `rule` prefix only.
// It does NOT inspect `authority`, does NOT compute exit codes, does NOT
// read files, does NOT call any kernel or store function, and does NOT
// mutate the input.
//
// Format:
//
//   [ERROR ] <rule.id>: <message>
//             subject: <subject>
//             repair:  <narrowRepair>
//             data:    {json}
//
// Severity bracket is fixed-width so output columns align. Rule id is
// always present — agents key off it; the message is human prose only.

import type { Diagnostic, Severity } from '@paths.design/caws-kernel';

export interface RenderDiagnosticsOptions {
  /** Show the optional `data` block. Default false (keeps output tight). */
  readonly showData?: boolean;
  /** Hide diagnostics below this severity. Default: render all. */
  readonly minSeverity?: Severity;
}

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  error: 2,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  info: '[INFO   ]',
  warning: '[WARN   ]',
  error: '[ERROR  ]',
};

function severityOf(d: Diagnostic): Severity {
  return d.severity ?? 'error';
}

export function renderDiagnostic(
  d: Diagnostic,
  opts: RenderDiagnosticsOptions = {}
): string {
  const sev = severityOf(d);
  const lines: string[] = [`${SEVERITY_LABEL[sev]} ${d.rule}: ${d.message}`];
  if (typeof d.subject === 'string' && d.subject.length > 0) {
    lines.push(`            subject: ${d.subject}`);
  }
  if (typeof d.narrowRepair === 'string' && d.narrowRepair.length > 0) {
    lines.push(`            repair:  ${d.narrowRepair}`);
  }
  if (opts.showData === true && d.data !== undefined) {
    lines.push(`            data:    ${JSON.stringify(d.data)}`);
  }
  return lines.join('\n');
}

export function renderDiagnostics(
  diagnostics: readonly Diagnostic[],
  opts: RenderDiagnosticsOptions = {}
): string {
  const min = opts.minSeverity ?? 'info';
  const minRank = SEVERITY_RANK[min];
  const kept = diagnostics.filter(
    (d) => SEVERITY_RANK[severityOf(d)] >= minRank
  );
  if (kept.length === 0) return '';
  return kept.map((d) => renderDiagnostic(d, opts)).join('\n');
}

/**
 * Count severities in a Diagnostic[]. Exposed for callers that want a
 * one-line summary without re-walking the list.
 */
export function countSeverities(diagnostics: readonly Diagnostic[]): {
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
} {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const d of diagnostics) {
    const s = severityOf(d);
    if (s === 'error') errors++;
    else if (s === 'warning') warnings++;
    else infos++;
  }
  return { errors, warnings, infos };
}
