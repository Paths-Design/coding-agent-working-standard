// Advisory stale-telemetry rendering (CAWS-HARNESS-TELEMETRY-ADAPTER-001).
//
// Renders a bounded, fail-open block for `caws status` when the doctor
// findings already carry `doctor.hooks.stale_telemetry_pack`: vendored
// telemetry rows (the turn-log fold + agent lease lifecycle hooks) are still
// installed under .caws/hooks/ while an adapter-covered surface pack (dsh)
// is also installed — stale dual-writers over the same .caws/sessions/ and
// .caws/leases/ state the surface's telemetry adapter owns.
//
// CONTRACT (mirrors peer-presence.ts; every invariant test-backed):
//   - Render-only and fail-open: the block derives ONLY from findings the
//     caller already has. No reads, no writes, no new refusals; the host
//     command's exit codes and `.caws/` mutations are unchanged.
//   - No stale-telemetry finding => empty string => the host command's
//     output is byte-identical to the pre-change baseline (no noise, no
//     placeholders, no "all clear" line — absence is not celebrated).
//   - Bounded output: the rows list is capped at
//     STALE_TELEMETRY_MAX_ROWS entries, then one overflow line.
//   - Content names the sanctioned repair (re-run `caws init`), never a
//     hand-edit of installed hooks.

/** Max stale rows named before the overflow handoff. */
export const STALE_TELEMETRY_MAX_ROWS = 4;

/** The doctor rule id this advisory renders. */
export const STALE_TELEMETRY_RULE = 'doctor.hooks.stale_telemetry_pack';

interface StaleTelemetryFindingLike {
  readonly rule: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Build the advisory block from doctor findings, or '' when there is no
 * stale-telemetry finding. Deterministic; reads nothing; mutates nothing.
 */
export function renderStaleTelemetryAdvisory(
  findings: readonly StaleTelemetryFindingLike[]
): string {
  const finding = findings.find((f) => f.rule === STALE_TELEMETRY_RULE);
  if (finding === undefined) return '';

  const rows = readStringArray(finding.data?.stale_rows);
  const surfaces = readStringArray(finding.data?.adapter_surfaces);
  if (rows.length === 0 || surfaces.length === 0) return '';

  const lines: string[] = [
    `Advisory: stale CAWS telemetry rows installed for adapter-covered surface(s) ${surfaces.join(', ')}:`,
  ];
  for (const row of rows.slice(0, STALE_TELEMETRY_MAX_ROWS)) {
    lines.push(`  - ${row}`);
  }
  if (rows.length > STALE_TELEMETRY_MAX_ROWS) {
    lines.push(`  ... and ${rows.length - STALE_TELEMETRY_MAX_ROWS} more`);
  }
  lines.push(
    `  The telemetry plane for ${surfaces.join(', ')} (turn logs under .caws/sessions/, ` +
      'agent leases under .caws/leases/) is owned by its harness adapter; these vendored rows are dual-writers.'
  );
  lines.push(
    '  Repair: re-run `caws init` with that surface selected — it retires managed stale rows and never touches unmanaged files.'
  );
  return lines.join('\n');
}

/** One-line call-site helper: render and emit the block when non-empty. */
export function emitStaleTelemetryAdvisory(
  findings: readonly StaleTelemetryFindingLike[],
  out: (line: string) => void
): void {
  const block = renderStaleTelemetryAdvisory(findings);
  if (block.length > 0) out(block);
}
