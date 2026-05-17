// Pure string-formatter for the Claim panel.
//
// The claim panel shows ownership for the worktree that the command was
// invoked from. It distinguishes:
//
//   - owner is the current session       → "OWNED (you)"
//   - owner is a foreign session         → "OWNED (foreign)"
//   - no owner recorded                  → "UNOWNED"
//   - cwd is outside any tracked worktree → no panel; caller decides
//
// Authority discipline preserved in the rendering:
//   - `owner` line uses worktrees.json[name].owner verbatim — SOLE
//     authority for ownership.
//   - `heartbeat` line shows agents.json freshness — display only.
//     If the heartbeat is "stale" by the configured TTL, we say so
//     in parentheses but we DO NOT imply this authorizes takeover.

import type {
  AgentRecord,
  PriorOwner,
  SessionIdentity,
  WorktreeRecord,
} from '@paths.design/caws-kernel';
import { heartbeatAge, isStaleByTTL } from '@paths.design/caws-kernel';

export type OwnershipRelation = 'you' | 'foreign' | 'unowned';

export interface ClaimPanelInput {
  readonly worktreeName: string;
  readonly worktreeRecord: WorktreeRecord;
  /**
   * Optional matching agent record from agents.json. When present, the
   * panel renders a freshness line. When absent, the freshness line
   * is omitted entirely (we do NOT invent a stale-forever line).
   */
  readonly agentRecord?: AgentRecord;
  readonly currentSession: SessionIdentity;
  readonly now: Date;
  /**
   * Heartbeat staleness threshold in ms. Default 24h. ONLY used for the
   * display label "(stale)" — never as a takeover authority.
   */
  readonly staleTtlMs?: number;
}

const DEFAULT_STALE_TTL_MS = 24 * 60 * 60 * 1000;

export function classifyOwnership(
  record: WorktreeRecord,
  currentSession: SessionIdentity
): OwnershipRelation {
  if (record.owner === undefined) return 'unowned';
  return record.owner.session_id === currentSession.session_id ? 'you' : 'foreign';
}

function fmtSessionTag(owner: SessionIdentity): string {
  if (owner.platform !== undefined && owner.platform.length > 0) {
    return `${owner.session_id}:${owner.platform}`;
  }
  return owner.session_id;
}

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function renderClaimPanel(input: ClaimPanelInput): string {
  const rel = classifyOwnership(input.worktreeRecord, input.currentSession);
  const lines: string[] = [];
  lines.push(`Claim for worktree '${input.worktreeName}':`);

  switch (rel) {
    case 'you':
      lines.push(
        `  Owner:     OWNED (you) — ${fmtSessionTag(input.worktreeRecord.owner!)}`
      );
      break;
    case 'foreign':
      lines.push(
        `  Owner:     OWNED (foreign) — ${fmtSessionTag(input.worktreeRecord.owner!)}`
      );
      lines.push(
        `             your session:   ${fmtSessionTag(input.currentSession)}`
      );
      break;
    case 'unowned':
      lines.push('  Owner:     UNOWNED (no recorded owner)');
      break;
  }

  // Freshness — display only. Never authorizes takeover.
  if (input.agentRecord !== undefined) {
    const ttl = input.staleTtlMs ?? DEFAULT_STALE_TTL_MS;
    const age = heartbeatAge(input.agentRecord, input.now);
    const stale = isStaleByTTL(input.agentRecord, ttl, input.now);
    const staleNote = stale ? ' (stale; display only — NOT abandonment)' : '';
    lines.push(`  Heartbeat: ${fmtAge(age)}${staleNote}`);
  }

  const priorOwners: readonly PriorOwner[] = input.worktreeRecord.prior_owners ?? [];
  if (priorOwners.length > 0) {
    lines.push(
      `  History:   ${priorOwners.length} prior owner${priorOwners.length === 1 ? '' : 's'} (audit)`
    );
  }

  return lines.join('\n');
}
