// Agent freshness telemetry.
//
// `agents.json` is freshness/display state. It is never authority for
// ownership decisions. The functions in this module:
//
//   - refreshAgentClaim: compute the patch that records "session is alive
//     right now". Updates last_active only.
//   - heartbeatAge: pure helper for diagnostics.
//   - isStaleByTTL: pure predicate for display/hygiene.
//
// None of these mutate ownership. None of them authorize takeover. Stale
// heartbeat is NOT abandonment — that rule is enforced in ownership.ts.

import { validateSessionIdentity } from './identity';
import type { Result } from '../result/types';
import { ok } from '../result/construct';
import type { AgentRecord, AgentRegistry, RegistryPatch, SessionIdentity } from './types';

export interface RefreshAgentClaimOptions {
  readonly bound_worktree?: string;
  readonly bound_spec_id?: string;
}

/**
 * Compute the patch that updates an agent's freshness record.
 *
 * Returns a `refresh_agent` RegistryPatch. The shell applies it to
 * `agents.json`. The kernel never reads or writes the file.
 */
export function refreshAgentClaim(
  _agents: AgentRegistry,
  session: SessionIdentity,
  now: Date,
  opts: RefreshAgentClaimOptions = {}
): Result<RegistryPatch> {
  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  const patch: RegistryPatch = {
    kind: 'refresh_agent',
    session: me,
    last_active: now.toISOString(),
    ...(opts.bound_worktree ? { bound_worktree: opts.bound_worktree } : {}),
    ...(opts.bound_spec_id ? { bound_spec_id: opts.bound_spec_id } : {}),
  };
  return ok(patch);
}

/**
 * Heartbeat age in milliseconds, computed against an injected `now`.
 *
 * Returns Infinity when the record has no `last_active` or it does not
 * parse — callers can treat that as "infinitely stale" for display purposes
 * but MUST NOT use it as a takeover authority. Display is display.
 */
export function heartbeatAge(record: AgentRecord, now: Date): number {
  const lastActive = Date.parse(record.last_active);
  if (Number.isNaN(lastActive)) return Number.POSITIVE_INFINITY;
  return now.getTime() - lastActive;
}

/**
 * `true` iff the heartbeat is older than `ttlMs`. Display/hygiene only.
 *
 * This is the predicate `caws agents list` uses to render a "stale" tag.
 * It is the predicate `doctor` uses to suggest pruning. It is NOT the
 * predicate ownership decisions consult.
 */
export function isStaleByTTL(record: AgentRecord, ttlMs: number, now: Date): boolean {
  return heartbeatAge(record, now) > ttlMs;
}
