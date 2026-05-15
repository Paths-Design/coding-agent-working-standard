// Pure formatter for waiver records.
//
// The renderer does NOT decide applicability. It receives a derived
// effectiveness label from the caller — `effectiveWaiversForGate`
// (kernel) and `waiverEffectiveness` (kernel) own that decision.
// Renderers stay pure so they're trivial to test and reuse from
// `list`, `show`, and any future doctor surface.
//
// Two output shapes:
//
//   renderWaiverSummary(input)  — single-line list row used by `list`.
//   renderWaiverDetail(input)   — multi-line detail block used by `show`.
//
// `now` is supplied by the caller, never read from the clock here. That
// keeps test output deterministic and matches the discipline that the
// rest of the shell follows.

import type {
  Waiver,
  WaiverEffectiveness,
} from '@paths.design/caws-kernel';

export interface RenderWaiverSummaryInput {
  readonly waiver: Waiver;
  /** Pre-derived effectiveness from kernel.waiverEffectiveness. */
  readonly effectiveness: WaiverEffectiveness;
}

export interface RenderWaiverDetailInput extends RenderWaiverSummaryInput {
  /** Now, used to format expiry deltas. Caller owns the clock. */
  readonly now: Date;
}

function effectivenessLabel(e: WaiverEffectiveness): string {
  switch (e) {
    case 'active':
      return 'ACTIVE         ';
    case 'expired':
      return 'EXPIRED        ';
    case 'revoked':
      return 'REVOKED        ';
    case 'not_applicable':
      return 'NOT_APPLICABLE ';
  }
}

function fmtScope(w: Waiver): string {
  if (w.scope?.spec_id !== undefined) return `spec=${w.scope.spec_id}`;
  return 'project-wide';
}

function fmtExpiryDelta(expiresAt: string, now: Date): string {
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return '(unparseable expires_at)';
  const deltaMs = expMs - now.getTime();
  const absMs = Math.abs(deltaMs);
  let unit: string;
  if (absMs < 60_000) unit = `${Math.round(absMs / 1000)}s`;
  else if (absMs < 3_600_000) unit = `${Math.round(absMs / 60_000)}m`;
  else if (absMs < 86_400_000) unit = `${Math.round(absMs / 3_600_000)}h`;
  else unit = `${Math.round(absMs / 86_400_000)}d`;
  return deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
}

/**
 * One-line summary suited to `caws waiver list`. Includes the kernel-
 * derived effectiveness label so the caller doesn't need to re-classify.
 */
export function renderWaiverSummary(input: RenderWaiverSummaryInput): string {
  const w = input.waiver;
  const gates = w.gates.join(',');
  return `${effectivenessLabel(input.effectiveness)}  ${w.id}  [${gates}]  (${fmtScope(w)})  ${w.title}`;
}

/**
 * Multi-line detail block suited to `caws waiver show`. Includes
 * everything `Waiver` carries plus a derived expiry delta.
 */
export function renderWaiverDetail(input: RenderWaiverDetailInput): string {
  const w = input.waiver;
  const lines: string[] = [];
  lines.push(`Waiver ${w.id}`);
  lines.push(`  Status (stored):  ${w.status}`);
  lines.push(`  Effectiveness:    ${input.effectiveness}`);
  lines.push(`  Title:            ${w.title}`);
  lines.push(`  Gates:            ${w.gates.join(', ')}`);
  lines.push(`  Scope:            ${fmtScope(w)}`);
  lines.push(`  Reason:           ${w.reason}`);
  lines.push(`  Approved by:      ${w.approved_by}`);
  lines.push(`  Created at:       ${w.created_at}`);
  lines.push(`  Expires at:       ${w.expires_at} (${fmtExpiryDelta(w.expires_at, input.now)})`);
  if (w.constraints?.max_uses !== undefined) {
    lines.push(`  Max uses:         ${w.constraints.max_uses} (kernel does not enforce)`);
  }
  if (w.revocation !== undefined) {
    lines.push('  Revocation:');
    lines.push(`    Revoked at:     ${w.revocation.revoked_at}`);
    if (w.revocation.revoked_by !== undefined)
      lines.push(`    Revoked by:     ${w.revocation.revoked_by}`);
    if (w.revocation.reason !== undefined)
      lines.push(`    Reason:         ${w.revocation.reason}`);
  }
  return lines.join('\n');
}
