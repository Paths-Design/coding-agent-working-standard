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
  // SESSION-OWNERSHIP-METADATA-001 (lease-substrate amendment).
  // path_empty: a claimed_paths or last_modified_paths entry is the
  // empty string. path_null_byte: an entry contains a U+0000 byte
  // (filesystem/JSON hazard). not_found: an update_lease_paths patch
  // targets a session_id with no existing lease — this path is NOT
  // a lease-fabrication route; missing leases are an Err.
  LEASE_PATH_EMPTY: 'kernel.lease.path_empty',
  LEASE_PATH_NULL_BYTE: 'kernel.lease.path_null_byte',
  LEASE_NOT_FOUND: 'kernel.lease.not_found',
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
  | { readonly kind: 'delete_lease'; readonly session_id: string }
  // SESSION-OWNERSHIP-METADATA-001 (lease-substrate amendment).
  // update_lease_paths is the narrow partial-update primitive for
  // working-tree ownership metadata. It MUST NOT mutate last_active,
  // status, last_seen_reason, started_at, stopped_at, or any context
  // fields. Per-field semantics: undefined = leave existing field
  // value untouched; defined = replace the existing value with this
  // exact (already-validated, already-truncated) array. Empty array
  // is a valid declared state ("I have no claims") distinct from
  // undefined ("I haven't declared yet").
  | {
      readonly kind: 'update_lease_paths';
      readonly session_id: string;
      readonly claimed_paths?: readonly string[];
      readonly last_modified_paths?: readonly string[];
    };

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

// ─── SESSION-OWNERSHIP-METADATA-001: ownership-metadata write path ────

/**
 * Maximum retained entries in last_modified_paths. Truncation drops
 * the lowest-index overflow (FIFO), preserving caller order among the
 * retained final 1000. Configurable in spec wording, fixed at the
 * substrate layer.
 */
export const LAST_MODIFIED_PATHS_MAX_ENTRIES = 1000;

export interface UpdateAgentLeasePathsOptions {
  readonly claimed_paths?: readonly string[];
  readonly last_modified_paths?: readonly string[];
}

export interface ValidatedLeasePathMetadata {
  readonly claimed_paths?: readonly string[];
  readonly last_modified_paths?: readonly string[];
}

/**
 * Validate and normalize the path-metadata arrays for
 * SESSION-OWNERSHIP-METADATA-001.
 *
 * Rules:
 *   - Every entry must be a non-empty string (A3).
 *   - No entry may contain a U+0000 byte (A3 — filesystem/JSON hazard).
 *   - last_modified_paths is truncated to LAST_MODIFIED_PATHS_MAX_ENTRIES,
 *     dropping the lowest-index overflow first (FIFO; retained 1000
 *     preserve caller order). Truncation is deterministic normalization,
 *     not an error.
 *
 * Returned value contains exactly the keys that were defined on input
 * (undefined keys stay undefined; the patch downstream treats undefined
 * as "leave existing field untouched"). Empty array is admitted as a
 * valid declared state distinct from undefined.
 */
export function validateLeasePathMetadata(
  opts: UpdateAgentLeasePathsOptions
): Result<ValidatedLeasePathMetadata> {
  const errors: Diagnostic[] = [];

  if (opts.claimed_paths !== undefined) {
    const r = validatePathArray(opts.claimed_paths, 'claimed_paths');
    if (r.ok === false) errors.push(...r.errors);
  }

  if (opts.last_modified_paths !== undefined) {
    const r = validatePathArray(opts.last_modified_paths, 'last_modified_paths');
    if (r.ok === false) errors.push(...r.errors);
  }

  if (errors.length > 0) return err(errors);

  const result: { -readonly [K in keyof ValidatedLeasePathMetadata]: ValidatedLeasePathMetadata[K] } = {};

  if (opts.claimed_paths !== undefined) {
    // Verbatim, in caller order. No truncation on claimed_paths —
    // sessions claim explicitly and the operator authored the list.
    result.claimed_paths = [...opts.claimed_paths];
  }

  if (opts.last_modified_paths !== undefined) {
    const src = opts.last_modified_paths;
    if (src.length <= LAST_MODIFIED_PATHS_MAX_ENTRIES) {
      result.last_modified_paths = [...src];
    } else {
      // Drop lowest-index overflow; preserve caller order among the
      // retained final LAST_MODIFIED_PATHS_MAX_ENTRIES.
      result.last_modified_paths = src.slice(
        src.length - LAST_MODIFIED_PATHS_MAX_ENTRIES
      );
    }
  }

  return ok(result);
}

function validatePathArray(
  arr: readonly unknown[],
  fieldName: 'claimed_paths' | 'last_modified_paths'
): Result<undefined> {
  const errors: Diagnostic[] = [];
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i];
    if (typeof entry !== 'string') {
      errors.push(
        diagnostic({
          rule: LEASE_RULES.LEASE_PATH_EMPTY,
          authority: 'kernel/worktree',
          severity: 'error',
          message: `${fieldName}[${i}] must be a string, got ${typeof entry}.`,
          data: { field: fieldName, index: i, actual_type: typeof entry },
        })
      );
      continue;
    }
    if (entry.length === 0) {
      errors.push(
        diagnostic({
          rule: LEASE_RULES.LEASE_PATH_EMPTY,
          authority: 'kernel/worktree',
          severity: 'error',
          message: `${fieldName}[${i}] must be a non-empty string.`,
          data: { field: fieldName, index: i },
        })
      );
      continue;
    }
    if (entry.indexOf(' ') !== -1) {
      errors.push(
        diagnostic({
          rule: LEASE_RULES.LEASE_PATH_NULL_BYTE,
          authority: 'kernel/worktree',
          severity: 'error',
          message: `${fieldName}[${i}] contains a null byte (U+0000).`,
          data: { field: fieldName, index: i },
        })
      );
    }
  }
  if (errors.length > 0) return err(errors);
  return ok(undefined);
}

/**
 * Compute a partial-update patch for working-tree ownership metadata
 * (SESSION-OWNERSHIP-METADATA-001 commit 2).
 *
 * The patch updates ONLY claimed_paths and/or last_modified_paths.
 * It does NOT mutate last_active, status, last_seen_reason, started_at,
 * stopped_at, or any context fields. For heartbeat/freshness updates,
 * use registerAgentSession / heartbeatAgentSession.
 *
 * Refuses if no existing lease is present for the given session_id —
 * this path is NOT a lease-fabrication route. Sessions must register
 * (via registerAgentSession) before declaring ownership metadata.
 *
 * Refuses on validation failure (non-string, empty, null-byte entries).
 * last_modified_paths over the max-entries threshold is silently
 * truncated (deterministic normalization, not an error).
 *
 * Per-field undefined means "leave the existing field value untouched"
 * (the store apply path preserves that field). Defined means "replace
 * with this exact (already-validated, already-truncated) array."
 * Empty array is admitted as a valid declared state.
 */
export function updateAgentLeasePaths(
  leases: LeaseRegistry,
  session: SessionIdentity,
  opts: UpdateAgentLeasePathsOptions
): Result<LeasePatch> {
  const sessionRes = validateSessionIdentity(session);
  if (sessionRes.ok === false) return sessionRes;
  const me = sessionRes.value;

  // Existence check — not a lease-fabrication route.
  if (!Object.prototype.hasOwnProperty.call(leases, me.session_id)) {
    return err(
      diagnostic({
        rule: LEASE_RULES.LEASE_NOT_FOUND,
        authority: 'kernel/worktree',
        severity: 'error',
        message: `No existing lease for session "${me.session_id}". Register the session before declaring ownership metadata.`,
        data: { session_id: me.session_id },
      })
    );
  }

  const validatedRes = validateLeasePathMetadata(opts);
  if (validatedRes.ok === false) return validatedRes;
  const validated = validatedRes.value;

  const patch: LeasePatch = {
    kind: 'update_lease_paths',
    session_id: me.session_id,
    ...(validated.claimed_paths !== undefined ? { claimed_paths: validated.claimed_paths } : {}),
    ...(validated.last_modified_paths !== undefined
      ? { last_modified_paths: validated.last_modified_paths }
      : {}),
  };

  return ok(patch);
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
