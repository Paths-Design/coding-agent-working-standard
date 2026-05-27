// Evidence kernel types.
//
// The evidence kernel answers two questions:
//
//   1. Given a caller-supplied event body and the previous chained event
//      (or null for genesis), produce the next ChainedEvent — fully
//      sequenced, hashed, and chain-linked.
//
//   2. Given an array of already-parsed ChainedEvent instances, verify the
//      chain is internally consistent: monotonic seq, no gaps, no dup seqs,
//      every prev_hash matches its predecessor's event_hash, every
//      event_hash matches a fresh re-hash of the event minus event_hash.
//
// The kernel does NO I/O. The store layer (Slice 5b/5c) wraps these pure
// functions with file locking, append semantics, and tail recovery.
//
// The kernel does NOT verify session liveness, agents.json membership, or
// worktree ownership. Those are shell/session-layer concerns. The kernel
// only enforces actor *shape* (kind ∈ closed set, id non-empty).

/**
 * The closed actor kind enum. Adding a new kind is a schema bump.
 *
 *  - `human`:      end user typing into a terminal.
 *  - `agent`:      AI agent driving the CLI.
 *  - `system`:     kernel/shell-emitted events with no external actor.
 *  - `automation`: CI runner, scheduled task, git hook, daemon.
 */
export type ActorKind = 'human' | 'agent' | 'system' | 'automation';

/**
 * Structured actor identity. Required on every event.
 *
 * Identity is part of the evidentiary claim every event makes — keeping
 * actor as a string would let actor semantics drift by event type.
 *
 * The kernel enforces shape only:
 *   - `kind` is one of the closed values.
 *   - `id` is a non-empty string.
 *   - `session_id`, if present, is a non-empty string.
 *   - `platform`, if present, is a non-empty string.
 *
 * The kernel does NOT verify that `session_id` exists in agents.json,
 * matches a live session, owns a worktree, or has permission to emit
 * the event. That belongs to the shell/session/worktree layer.
 */
export interface Actor {
  readonly kind: ActorKind;
  readonly id: string;
  readonly session_id?: string;
  readonly platform?: string;
}

/**
 * The closed event vocabulary. Mirrors `schemas/events.v1.json#properties.event.enum`.
 * Adding a new event type is a schema bump and a kernel update.
 */
export type EventType =
  | 'spec_created'
  | 'spec_validated'
  | 'spec_updated'
  | 'spec_closed'
  | 'spec_archived'
  | 'spec_archive_pruned'
  | 'spec_deleted'
  | 'spec_drift_detected'
  | 'worktree_created'
  | 'worktree_bound'
  | 'worktree_merged'
  | 'worktree_destroyed'
  | 'claim_taken_over'
  | 'evidence_recorded'
  | 'ac_recorded'
  | 'test_recorded'
  | 'gate_evaluated'
  | 'waiver_applied'
  | 'waiver_revoked'
  | 'doctor_completed'
  | 'session_started'
  | 'session_ended'
  | 'commit_made'
  | 'branch_switched'
  | 'chain_rotated';

/**
 * REQUIRES_SPEC_ID: event MUST carry a non-empty spec_id.
 *
 * If the caller omits spec_id (or supplies empty/whitespace), validation
 * fails with `evidence.event.spec_id_required`. This is a fence — it MUST
 * NOT be catchable in a way that lets the operation proceed.
 */
export const REQUIRES_SPEC_ID: ReadonlySet<EventType> = new Set<EventType>([
  'spec_created',
  'spec_validated',
  'spec_updated',
  'spec_closed',
  'spec_archived',
  'spec_archive_pruned',
  'spec_deleted',
  'spec_drift_detected',
  'evidence_recorded',
  'ac_recorded',
  'test_recorded',
  'gate_evaluated',
  'waiver_applied',
  'waiver_revoked',
  'worktree_bound',
]);

/**
 * OPTIONAL_SPEC_ID: spec_id MAY be present. When present, it must satisfy
 * the spec id regex. When absent, the field is omitted from the canonical
 * JSON (NOT serialized as null).
 */
export const OPTIONAL_SPEC_ID: ReadonlySet<EventType> = new Set<EventType>([
  'worktree_created',
  'worktree_merged',
  'worktree_destroyed',
  'claim_taken_over',
  'commit_made',
]);

/**
 * NO_SPEC_ID: event MUST NOT carry a spec_id. Repo-level events.
 *
 * If the caller supplies spec_id for one of these types, validation fails
 * with `evidence.event.spec_id_forbidden`.
 */
export const NO_SPEC_ID: ReadonlySet<EventType> = new Set<EventType>([
  'session_started',
  'session_ended',
  'branch_switched',
  'doctor_completed',
  'chain_rotated',
]);

/**
 * Convenience: the spec-id requirement class for a given event type.
 * Returns 'unknown' for event types not in the closed vocabulary.
 */
export type SpecIdClass = 'requires' | 'optional' | 'forbidden' | 'unknown';

export function specIdClassOf(eventType: string): SpecIdClass {
  if (REQUIRES_SPEC_ID.has(eventType as EventType)) return 'requires';
  if (OPTIONAL_SPEC_ID.has(eventType as EventType)) return 'optional';
  if (NO_SPEC_ID.has(eventType as EventType)) return 'forbidden';
  return 'unknown';
}

/**
 * Per-event payload. Type-erased here; per-type payload schemas under
 * `schemas/events/<event>.v1.json` validate the shape per-type.
 *
 * Every event carries a data object — even when there's nothing to record,
 * use `{}`. This keeps the canonical JSON shape uniform.
 */
export type EventPayload = Readonly<Record<string, unknown>>;

/**
 * Hash format: `sha256:` + 64 lowercase hex chars.
 *
 * The prefix lets us migrate to a different hash algorithm in the future
 * without touching every call site — the validator can dispatch on the
 * prefix to pick the right verifier.
 */
export type Hash = `sha256:${string}`;

/** Full hash regex (anchored). The kernel uses this for shape validation. */
export const HASH_REGEX = /^sha256:[0-9a-f]{64}$/;

/**
 * EventBody — what callers provide to `prepareAppend`.
 *
 * Notably ABSENT: `seq`, `prev_hash`, `event_hash`. Those are evidence-kernel
 * outputs, not user inputs. Allowing callers to supply them would be a
 * footgun: a buggy or malicious caller could fork the chain.
 *
 * `spec_id` is optional at the type level but its presence/absence is
 * enforced by `validateEventBody` against the event type's spec-id class.
 */
export interface EventBody {
  readonly event: EventType;
  readonly ts: string;
  readonly actor: Actor;
  readonly spec_id?: string;
  readonly data: EventPayload;
}

/**
 * ChainedEvent — what `prepareAppend` returns and what `verifyChain` consumes.
 *
 * This is the on-disk shape: a fully sequenced, hashed, chain-linked event.
 * Every field is part of the evidentiary claim and contributes to event_hash
 * (except event_hash itself).
 *
 * `prev_hash` is `null` for the genesis event (seq=1) and a `Hash` for
 * everything after. We deliberately use `null` rather than empty string —
 * empty string looks like a malformed hash and conflates "no predecessor"
 * with "predecessor's hash is unknown."
 */
export interface ChainedEvent {
  readonly seq: number;
  readonly event: EventType;
  readonly ts: string;
  readonly actor: Actor;
  readonly spec_id?: string;
  readonly data: EventPayload;
  readonly prev_hash: Hash | null;
  readonly event_hash: Hash;
}

/**
 * Domain separator for the hash chain. Prepended to canonical JSON before
 * hashing. The trailing NUL prevents any user-controlled JSON from colliding
 * with the prefix.
 *
 * Versioned in the separator string so a future v2 chain can co-exist with
 * v1 events without hash collisions.
 */
export const DOMAIN_SEPARATOR = 'caws.events.v1\x00';
