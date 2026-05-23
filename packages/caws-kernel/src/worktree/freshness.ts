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
  /**
   * Explicitly-declared claimed paths (typically from `caws claim --paths`).
   *
   * Stored verbatim by the writer subject to structural validation. The
   * 256-entry user-facing cap is enforced at the CLI surface in commit 3
   * of SESSION-OWNERSHIP-METADATA-001, NOT here. Empty array is meaningful
   * (it does not clear an existing claim; the writer interprets `undefined`
   * vs `[]` — `undefined` leaves any existing claimed_paths untouched,
   * `[]` clears them).
   *
   * Acceptance: SESSION-OWNERSHIP-METADATA-001 A2.
   */
  readonly claimed_paths?: readonly string[];
  /**
   * Recently-modified paths (TTL-bounded, caller-enforced).
   *
   * The CALLER is responsible for assembling an already-TTL-pruned set
   * (per `agents.last_modified_paths_ttl_seconds` policy key); the
   * writer does NOT consult per-path timestamps because the substrate
   * carries none. The writer enforces only storage-bound invariants:
   * structural validation (non-empty strings, no null bytes) and a
   * deterministic FIFO cap of 1000 entries (caller order preserved,
   * lowest-index overflow dropped).
   *
   * Acceptance: SESSION-OWNERSHIP-METADATA-001 A3, A10.
   */
  readonly last_modified_paths?: readonly string[];
}

/**
 * Compute the patch that updates an agent's freshness record.
 *
 * Returns a `refresh_agent` RegistryPatch. The shell applies it to
 * `agents.json`. The kernel never reads or writes the file.
 *
 * The new optional fields `claimed_paths` and `last_modified_paths` are
 * forwarded verbatim into the patch envelope. The kernel does NOT
 * validate or cap them — that is the writer's responsibility at the
 * shell layer, per the C1 storage-contract interpretation of
 * SESSION-OWNERSHIP-METADATA-001. The kernel's job is to construct the
 * patch; the writer's job is to durably apply it under storage-safety
 * invariants.
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
    ...(opts.claimed_paths !== undefined
      ? { claimed_paths: opts.claimed_paths }
      : {}),
    ...(opts.last_modified_paths !== undefined
      ? { last_modified_paths: opts.last_modified_paths }
      : {}),
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
