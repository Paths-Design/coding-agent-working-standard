// Worktree + claim authority types.
//
// The worktree kernel answers four questions, all as pure functions:
//
//   1. "Given a spec, a worktrees registry, and a worktree name, what is the
//      binding state?" -> deriveBindingState
//
//   2. "Given a request to bind/rebind, is it legal, and what registry patch
//      should the shell apply?" -> bindWorktree
//
//   3. "Given an ownership claim, is it the same session, a foreign owner, or
//      a takeover?" -> assertOwnership / takeoverClaim
//
//   4. "Given a spec lifecycle transition request, does an active worktree
//      block it?" -> canTransitionSpecWithWorktree
//
// The kernel never reads files, never reads environment variables, never
// shells out to git, and never calls Date.now(). All time is injected by the
// caller. All side effects are returned as a typed RegistryPatch envelope
// that the shell layer materializes into JSON/YAML writes and event emits.
//
// Authority discipline:
//   - Ownership of a worktree is whatever `worktrees.json[name].owner` says.
//   - `agents.json` last_active is freshness/display only; never an authority
//     source for ownership decisions.
//   - A stale heartbeat is NOT abandonment. TTL pruning is hygiene; it does
//     not authorize takeover. Only `--takeover` does.
//   - Session identity is passed in by the caller. The kernel never resolves
//     `CLAUDE_SESSION_ID`, `CURSOR_TRACE_ID`, or session capsule files.

import type { Spec } from '../spec/types';

// ----------------------------------------------------------------------------
// SessionIdentity
// ----------------------------------------------------------------------------

/**
 * Identity of the actor making a worktree-level decision.
 *
 * `session_id` is the authoritative key for ownership decisions. `platform`
 * is the human-readable origin tag (e.g. 'claude-code', 'cursor', 'cli') and
 * is part of display/audit, not authority.
 */
export interface SessionIdentity {
  readonly session_id: string;
  readonly platform?: string;
}

// ----------------------------------------------------------------------------
// PriorOwner
// ----------------------------------------------------------------------------

/**
 * Audit record appended to a worktree's `prior_owners` array on takeover.
 *
 * The kernel never truncates this list. If growth becomes pathological, that
 * is a hygiene signal for `doctor`, not authority kernel concern.
 */
export interface PriorOwner {
  readonly session_id: string;
  readonly platform?: string;
  readonly last_seen?: string;
  readonly takenOver_at: string;
}

// ----------------------------------------------------------------------------
// WorktreeRegistry
// ----------------------------------------------------------------------------

/**
 * One row in `.caws/worktrees.json`.
 *
 * The shell maps this onto the on-disk JSON. The kernel reasons over the
 * shape; it does not parse YAML or read filesystems.
 */
export interface WorktreeRecord {
  /** The bound spec id, or undefined if unbound. */
  readonly specId?: string;
  /** Branch name (e.g. `caws/<name>`). */
  readonly branch?: string;
  /** Absolute path on disk (display only). */
  readonly path?: string;
  /** Base branch from which the worktree was forked. */
  readonly baseBranch?: string;
  /** The current ownership claim. */
  readonly owner?: SessionIdentity;
  /** Heartbeat for the current owner. ISO-8601. */
  readonly last_heartbeat?: string;
  /** Append-only audit of takeovers. */
  readonly prior_owners?: readonly PriorOwner[];
}

/**
 * The full `.caws/worktrees.json` shape, keyed by worktree name.
 *
 * The kernel treats this as a read model. All mutations are returned as
 * `RegistryPatch` for the shell to apply.
 */
export interface WorktreeRegistry {
  readonly [name: string]: WorktreeRecord;
}

// ----------------------------------------------------------------------------
// AgentRegistry (freshness/display only — NEVER authority)
// ----------------------------------------------------------------------------

/**
 * One row in `.caws/agents.json`.
 *
 * This is freshness/display state for `caws agents list` and `caws status`.
 * It is not consulted for ownership decisions.
 *
 * `claimed_paths` and `last_modified_paths` are added by
 * SESSION-OWNERSHIP-METADATA-001 as additive optional substrate for
 * multi-agent coordination consumers (working-tree provenance guard,
 * push-range classifier, handoff event emitter). The fields are
 * stored verbatim; consumers canonicalize at query time.
 */
export interface AgentRecord {
  readonly session_id: string;
  readonly platform?: string;
  readonly last_active: string;
  readonly bound_worktree?: string;
  readonly bound_spec_id?: string;
  readonly claimed_paths?: readonly string[];
  readonly last_modified_paths?: readonly string[];
}

/**
 * The full `.caws/agents.json` shape, keyed by session id.
 */
export interface AgentRegistry {
  readonly [session_id: string]: AgentRecord;
}

/**
 * Structural predicate: does a value look like a real agent record?
 *
 * `agents.json` currently carries top-level keys that are NOT per-session
 * records (`version: 1`, `agents: {}`) alongside the actual session
 * records. The loader returns the whole object verbatim, so consumers
 * that iterate the registry would treat those non-record values as
 * "agents" unless they filter.
 *
 * This predicate is the substrate that consumer surfaces — the
 * working-tree provenance guard, push-range classifier, and handoff
 * event emitter — route through to enumerate "active agents." It is
 * structural disambiguation, NOT structural normalization: the
 * on-disk shape is unchanged, and existing display-only warnings
 * (e.g., doctor's stale_display_only on `version` and `agents`) are
 * left alone here. Their cleanup belongs to a future normalization
 * slice.
 *
 * Acceptance: SESSION-OWNERSHIP-METADATA-001 A8.
 */
export function isAgentRecord(value: unknown): value is AgentRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.session_id === 'string' &&
    typeof candidate.last_active === 'string'
  );
}

// ----------------------------------------------------------------------------
// BindingState (canonical home; scope/types.ts re-exports)
// ----------------------------------------------------------------------------

/**
 * Binding state of the worktree the path was authored in.
 *
 * The shell layer constructs this from `.caws/worktrees.json` plus the bound
 * spec's `worktree:` field. The kernel never reads either. The canonical home
 * is here (worktree owns binding); `scope/types.ts` re-exports for consumer
 * stability.
 *
 * Three variants:
 *  - `bound`: registry has `specId` AND spec.worktree points back. Full
 *    governed evaluation runs.
 *  - `one_sided`: exactly one side points to the other. This is corrupt
 *    state — mechanically equivalent to `unbound` for governed writes,
 *    but diagnostically distinct so doctor can prescribe a precise repair
 *    (rebind vs bind).
 *  - `unbound`: no spec is linked to the worktree (or the caller is outside
 *    any worktree). Governed writes fail closed.
 */
export type BindingState =
  | {
      readonly kind: 'bound';
      readonly spec: Spec;
      readonly worktreeName: string;
    }
  | {
      readonly kind: 'one_sided';
      readonly detail: {
        readonly specHasWorktree: boolean;
        readonly registryHasSpecId: boolean;
        readonly specWorktree?: string;
        readonly registrySpecId?: string;
        readonly worktreeName?: string;
      };
    }
  | {
      readonly kind: 'unbound';
    };

// ----------------------------------------------------------------------------
// RegistryPatch (typed; discriminated by `kind`)
// ----------------------------------------------------------------------------

/**
 * A typed patch envelope describing exactly what the shell should apply.
 *
 * Patches are intent, not partial-object diffs. The shell knows how to
 * materialize each kind into `worktrees.json`/`agents.json` writes and
 * (separately) into the corresponding `evidence_recorded`/`worktree_bound`
 * event emissions.
 */
export type RegistryPatch =
  | {
      readonly kind: 'bind_worktree';
      readonly worktree_name: string;
      readonly spec_id: string;
      readonly owner: SessionIdentity;
      readonly when: string;
      readonly idempotent: boolean;
    }
  | {
      readonly kind: 'rebind_worktree';
      readonly worktree_name: string;
      readonly from_spec_id: string;
      readonly to_spec_id: string;
      readonly owner: SessionIdentity;
      readonly when: string;
    }
  | {
      readonly kind: 'takeover_claim';
      readonly worktree_name: string;
      readonly owner: SessionIdentity;
      readonly prior_owner: PriorOwner;
      readonly when: string;
    }
  | {
      readonly kind: 'refresh_agent';
      readonly session: SessionIdentity;
      readonly last_active: string;
      readonly bound_worktree?: string;
      readonly bound_spec_id?: string;
      readonly claimed_paths?: readonly string[];
      readonly last_modified_paths?: readonly string[];
    };

// ----------------------------------------------------------------------------
// TransitionDecision
// ----------------------------------------------------------------------------

/**
 * The set of spec lifecycle transitions the worktree kernel reasons about.
 *
 * `merge_finalize` is the only path that may close a spec while a worktree
 * is bound — it is the legal close vector that runs as part of
 * `caws worktree merge`. All other transitions (`close`, `archive`, `delete`)
 * require the worktree to be cleared first.
 */
export type SpecTransition = 'close' | 'archive' | 'delete' | 'merge_finalize';

export interface TransitionDecision {
  readonly transition: SpecTransition;
  readonly allowed: true;
  /** The active binding (if any) the transition is operating on. */
  readonly binding?: {
    readonly worktree_name: string;
    readonly spec_id: string;
  };
}
