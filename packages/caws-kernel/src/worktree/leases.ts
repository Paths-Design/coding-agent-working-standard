// Agent liveness substrate — pure kernel logic.
//
// MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A1–A4.
//
// Leases (.caws/leases/<safe-session-id>.json) are operational cache,
// NEVER authority. No code path in this module or anywhere else may
// consult lease state to authorize ownership, scope admission, takeover,
// worktree destruction, merge, spec lifecycle transition, or any other
// governance decision. TTL never authorizes anything. Stale lease is
// evidence, not permission.
//
// Architectural separation (load-bearing):
//   - LeasePatch is a SEPARATE type from RegistryPatch (worktree/types.ts).
//     RegistryPatch mutates governance state (worktrees.json, agents.json);
//     LeasePatch mutates operational-cache state (.caws/leases/). They do
//     not share a union, do not share an apply function, do not share a
//     lock. Lease patches are applied ONLY through leases-store.ts.
//
//   - The on-disk AgentLease.status enum is exactly {active, stopping,
//     stopped}. 'stale' is NEVER written to disk. Stale is computed at
//     read time by summarizeActiveAgents(now, ttlMs). Auto-materializing
//     'stale' would mean session A writes session B's lease file, which
//     violates the per-session-file ownership model that makes per-file
//     atomic writes safe in the first place.
//
//   - This module is PURE: no fs, no path, no env, no clock, no network,
//     no git, no process. All time is injected via positional `now: Date`.
//     The store layer (packages/caws-cli/src/store/leases-store.ts) owns
//     filesystem I/O; the shell layer composes context (git_common_dir,
//     git_dir, branch, etc.) from the runtime environment.

import { diagnostic } from '../diagnostics';
import { err, ok } from '../result';
import type { Diagnostic } from '../diagnostics/types';
import type { Result } from '../result/types';
import { validateSessionIdentity } from './identity';
import type { SessionIdentity } from './types';

// ─── public surface ───────────────────────────────────────────────────────

/**
 * Stable rule identifiers for lease diagnostics.
 *
 * These are part of the public contract; tests and store/shell handlers
 * match on these strings. Renames are breaking changes.
 */
export const LEASE_RULES = {
  SESSION_INVALID: 'kernel.lease.session_invalid',
  CONTEXT_INVALID: 'kernel.lease.context_invalid',
  STATUS_UNEXPECTED: 'kernel.lease.status_unexpected',
} as const;

export type LeaseRule = (typeof LEASE_RULES)[keyof typeof LEASE_RULES];

/**
 * Last seen reason — why this lease was last touched.
 *
 * Closed vocabulary; new values require a slice amendment. Hooks pass
 * 'session_start' / 'pre_tool_use' / 'session_stop'. CLI surfaces pass
 * 'claim' / 'status' / 'manual_register'.
 */
export type LeaseReason =
  | 'session_start'
  | 'pre_tool_use'
  | 'claim'
  | 'status'
  | 'manual_register'
  | 'session_stop';

/**
 * On-disk AgentLease record.
 *
 * status enum is exactly {active, stopping, stopped} — 'stale' is read-side
 * classification only (computed by summarizeActiveAgents) and is NEVER
 * written here.
 *
 * SESSION-OWNERSHIP-METADATA-001 (lease-substrate amendment 2026-05-28)
 * adds optional `claimed_paths` and `last_modified_paths`. These are
 * advisory working-tree ownership metadata consumed by future provenance
 * surfaces (working-tree provenance guard, push-range classifier, handoff
 * event emitter). They are NOT authority — lease records remain
 * operational cache. Absent fields mean "no information", not "no claims".
 * The lease_version discriminator stays at 1 because the addition is
 * additive on optional properties only.
 */
export interface AgentLease {
  readonly lease_version: 1;
  readonly session_id: string;
  readonly platform: string;
  readonly status: 'active' | 'stopping' | 'stopped';
  readonly started_at: string;
  readonly last_active: string;
  readonly stopped_at?: string;
  readonly repo_root: string;
  readonly cwd: string;
  readonly git_common_dir: string;
  readonly git_dir: string;
  readonly branch?: string;
  readonly bound_worktree?: string;
  readonly bound_spec_id?: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly session_log_path?: string;
  readonly hook_pack_version?: number;
  readonly last_seen_reason: LeaseReason;
  /**
   * Paths this session has explicitly declared via the explicit-claim
   * surface (e.g. `caws claim --paths <glob>...`). Strings are stored
   * verbatim as the caller passed them — no glob expansion, no
   * normalization that would lose information. Claim takeover requires
   * explicit action, not TTL expiry.
   *
   * SESSION-OWNERSHIP-METADATA-001 A2.
   */
  readonly claimed_paths?: readonly string[];
  /**
   * TTL-bounded set of recently-touched paths. The TTL is CALLER-enforced,
   * not writer-enforced — the substrate has no per-path timestamps and
   * does not compute TTL membership from persisted state. Storage-bound
   * invariants only (enforced at the store-write boundary in commit 2):
   * non-empty strings, no null bytes, max 1000 entries (FIFO truncation
   * preserving caller order).
   *
   * SESSION-OWNERSHIP-METADATA-001 A3.
   */
  readonly last_modified_paths?: readonly string[];
}

/**
 * Keyed-by-session-id registry. Composed by the store layer from
 * per-session lease files; the kernel never reads the directory.
 */
export interface LeaseRegistry {
  readonly [session_id: string]: AgentLease;
}

/**
 * Context the shell layer must compose for each lease write.
 *
 * git_common_dir and git_dir MUST be realpath-normalized absolute paths
 * before reaching the kernel. The kernel does not normalize; equality
 * comparison without normalization is unreliable (git may return '.git'
 * relative in one context and absolute in another). See spec invariant 8.
 */
export interface LeaseContext {
  readonly repo_root: string;
  readonly cwd: string;
  readonly git_common_dir: string;
  readonly git_dir: string;
  readonly branch?: string;
  readonly bound_worktree?: string;
  readonly bound_spec_id?: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly session_log_path?: string;
  readonly hook_pack_version?: number;
}

/**
 * Discriminated patch type returned by lease-mutating kernel functions.
 *
 * MUST be kept separate from RegistryPatch (worktree/types.ts). Lease
 * patches are operational cache, not governance. Mixing them would let
 * future code treat lease writes as just another registry mutation —
 * exactly the authority-boundary blur this slice exists to prevent.
 *
 * NOTE: mark_stale is intentionally absent. Auto-materializing stale
 * means session A writes session B's lease file, which violates
 * per-session-file ownership.
 */
export type LeasePatch =
  | { readonly kind: 'write_lease'; readonly session_id: string; readonly lease: AgentLease }
  | { readonly kind: 'mark_stopped'; readonly session_id: string; readonly transitioned_at: string }
  | { readonly kind: 'delete_lease'; readonly session_id: string };

/**
 * Read-side classification of a LeaseRegistry against a TTL.
 *
 * Returned by summarizeActiveAgents. No write side effect.
 */
export interface ActivitySummary {
  readonly total: number;
  readonly active: ReadonlyArray<AgentLease>;
  readonly stale: ReadonlyArray<AgentLease>;
  readonly stopped: ReadonlyArray<AgentLease>;
}

// ─── pure validators ──────────────────────────────────────────────────────

function diag(rule: LeaseRule, message: string, data?: Record<string, unknown>): Diagnostic {
  return diagnostic({
    rule,
    authority: 'kernel/worktree',
    severity: 'error',
    message,
    ...(data !== undefined ? { data } : {}),
  });
}

function validateContext(context: LeaseContext): Result<LeaseContext> {
  if (typeof context !== 'object' || context === null) {
    return err(diag(LEASE_RULES.CONTEXT_INVALID, 'LeaseContext must be an object.'));
  }
  if (typeof context.repo_root !== 'string' || context.repo_root.length === 0) {
    return err(
      diag(LEASE_RULES.CONTEXT_INVALID, 'LeaseContext.repo_root must be a non-empty string.')
    );
  }
  if (typeof context.cwd !== 'string' || context.cwd.length === 0) {
    return err(diag(LEASE_RULES.CONTEXT_INVALID, 'LeaseContext.cwd must be a non-empty string.'));
  }
  if (typeof context.git_common_dir !== 'string' || context.git_common_dir.length === 0) {
    return err(
      diag(
        LEASE_RULES.CONTEXT_INVALID,
        'LeaseContext.git_common_dir must be a non-empty string (realpath-normalized absolute).'
      )
    );
  }
  if (typeof context.git_dir !== 'string' || context.git_dir.length === 0) {
    return err(
      diag(
        LEASE_RULES.CONTEXT_INVALID,
        'LeaseContext.git_dir must be a non-empty string (realpath-normalized absolute).'
      )
    );
  }
  return ok(context);
}

// ─── public functions ─────────────────────────────────────────────────────

/**
 * Upsert lease for a session.
 *
 * If a lease already exists for this session_id, started_at is preserved
 * (the original registration time). All other fields are updated from the
 * new context. Status is set to 'active' (registration always reactivates).
 *
 * Returns a 'write_lease' LeasePatch. The store applies it as a single-file
 * atomic write at .caws/leases/<safe-session-id>.json.
 */
export function registerAgentSession(
  leases: LeaseRegistry,
  session: SessionIdentity,
  context: LeaseContext,
  now: Date,
  reason: LeaseReason
): Result<LeasePatch> {
  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  const ctxRes = validateContext(context);
  if (ctxRes.ok === false) return ctxRes;
  const ctx = ctxRes.value;

  const nowIso = now.toISOString();
  const existing = leases[me.session_id];
  const startedAt = existing?.started_at ?? nowIso;

  const lease: AgentLease = {
    lease_version: 1,
    session_id: me.session_id,
    platform: me.platform ?? 'unknown',
    status: 'active',
    started_at: startedAt,
    last_active: nowIso,
    repo_root: ctx.repo_root,
    cwd: ctx.cwd,
    git_common_dir: ctx.git_common_dir,
    git_dir: ctx.git_dir,
    ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
    ...(ctx.bound_worktree !== undefined ? { bound_worktree: ctx.bound_worktree } : {}),
    ...(ctx.bound_spec_id !== undefined ? { bound_spec_id: ctx.bound_spec_id } : {}),
    ...(ctx.pid !== undefined ? { pid: ctx.pid } : {}),
    ...(ctx.hostname !== undefined ? { hostname: ctx.hostname } : {}),
    ...(ctx.session_log_path !== undefined ? { session_log_path: ctx.session_log_path } : {}),
    ...(ctx.hook_pack_version !== undefined ? { hook_pack_version: ctx.hook_pack_version } : {}),
    last_seen_reason: reason,
  };

  return ok({ kind: 'write_lease', session_id: me.session_id, lease });
}

/**
 * Heartbeat — differential update on last_active + reason + dynamic context.
 *
 * Preserves started_at. Status is set to 'active' (heartbeat reactivates a
 * stopping or stopped lease — the agent is alive). If no existing lease
 * is found, behaves identically to registerAgentSession (creates a new
 * record); this is the throttled-first-call case.
 *
 * Returns a 'write_lease' LeasePatch.
 */
export function heartbeatAgentSession(
  leases: LeaseRegistry,
  session: SessionIdentity,
  context: LeaseContext,
  now: Date,
  reason: LeaseReason
): Result<LeasePatch> {
  // Heartbeat semantics are upsert with status='active'. Same shape as
  // register; the throttle decision lives in the store layer.
  return registerAgentSession(leases, session, context, now, reason);
}

/**
 * Mark a lease stopped.
 *
 * Returns a 'mark_stopped' transition patch. The store layer interprets
 * this as a differential update: set status='stopped' and stopped_at,
 * preserve every other on-disk field. The kernel does NOT emit a full
 * write_lease for stop because the dynamic context (cwd, branch, etc.)
 * at stop time is irrelevant — the session is ending.
 *
 * Stop is best-effort. A session that crashes between heartbeats will
 * stay in status='active' until its last_active ages past TTL, at which
 * point summarizeActiveAgents classifies it as 'stale'. The crash-safe
 * invariant is that absence of stop never breaks liveness correctness.
 */
export function stopAgentSession(
  leases: LeaseRegistry,
  session: SessionIdentity,
  now: Date
): Result<LeasePatch> {
  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  // Unused but kept for symmetry; future kernel logic may compare against
  // existing record state to decide whether to short-circuit.
  void leases;

  return ok({
    kind: 'mark_stopped',
    session_id: me.session_id,
    transitioned_at: now.toISOString(),
  });
}

/**
 * Pure read-side classification.
 *
 * Buckets every lease in the registry into active / stale / stopped:
 *   - status === 'stopped' → stopped bucket
 *   - status === 'active' or 'stopping' AND (now - last_active) <= ttlMs → active
 *   - status === 'active' or 'stopping' AND (now - last_active) > ttlMs → stale
 *
 * 'stale' is read-side only; the on-disk record still has status='active'.
 * Materializing 'stale' as a write would mean session A writes session B's
 * lease file, which violates per-session-file ownership.
 *
 * No write side effect. Safe to call from read-only commands (caws status,
 * caws agents list).
 */
export function summarizeActiveAgents(
  leases: LeaseRegistry,
  now: Date,
  ttlMs: number
): ActivitySummary {
  const active: AgentLease[] = [];
  const stale: AgentLease[] = [];
  const stopped: AgentLease[] = [];

  for (const lease of Object.values(leases)) {
    if (lease.status === 'stopped') {
      stopped.push(lease);
      continue;
    }
    const lastActiveMs = Date.parse(lease.last_active);
    if (Number.isNaN(lastActiveMs)) {
      // Treat unparseable last_active as infinitely stale; don't crash on
      // a corrupted-but-loadable record.
      stale.push(lease);
      continue;
    }
    const age = now.getTime() - lastActiveMs;
    if (age > ttlMs) {
      stale.push(lease);
    } else {
      active.push(lease);
    }
  }

  return {
    total: active.length + stale.length + stopped.length,
    active,
    stale,
    stopped,
  };
}
