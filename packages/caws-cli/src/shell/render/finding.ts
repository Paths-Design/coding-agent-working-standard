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
  /**
   * Strip any `--takeover` hand-off suggestion from a finding's repair line.
   * Default false (the full `caws doctor` command renders repair prose
   * verbatim). The `caws status` surface sets this true: status is a glance
   * dashboard, and a stale-but-not-abandoned foreign owner must NOT be
   * presented there with a takeover hint (STATUS-STALE-OWNER-NO-TAKEOVER-001;
   * Campaign-2 doctrine: heartbeat staleness is display/hygiene only, never
   * ownership authority). The finding's severity, rule id, message, and
   * subject are preserved; only the takeover-suggesting tail of the repair
   * is replaced with a neutral pointer to `caws doctor`.
   */
  readonly suppressTakeoverHints?: boolean;
}

/**
 * Rewrite a repair string for the status surface when takeover hints are
 * suppressed. If the repair mentions `--takeover`, drop from the first
 * sentence that introduces the hand-off through the end of the repair and
 * replace it with a neutral pointer. Repairs that never mention takeover are
 * returned unchanged. This is deliberately conservative — it only fires when
 * the literal `--takeover` token is present, so it cannot silently alter an
 * unrelated repair.
 */
function sanitizeRepairForStatus(repair: string): string {
  if (!repair.includes('--takeover')) return repair;
  // The kernel owner_lease_missing repair has the shape:
  //   "...still authoritative... If the owning session is truly gone, hand
  //    off explicitly via `caws claim <wt> --takeover`."
  // Cut at the hand-off sentence (the one that introduces the takeover) and
  // substitute a neutral hygiene pointer. We split on the sentence boundary
  // that precedes the takeover guidance so the authoritative-owner sentence
  // is preserved.
  const handoffMarker = /\s*(?:If the owning session[\s\S]*)$/;
  const trimmed = repair.replace(handoffMarker, '');
  const base = trimmed.length > 0 ? trimmed : repair;
  return `${base} Run \`caws doctor\` for full hygiene context.`.replace(/\s+/g, ' ').trim();
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
    const repair =
      opts.suppressTakeoverHints === true
        ? sanitizeRepairForStatus(f.narrowRepair)
        : f.narrowRepair;
    lines.push(`            repair:  ${repair}`);
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
