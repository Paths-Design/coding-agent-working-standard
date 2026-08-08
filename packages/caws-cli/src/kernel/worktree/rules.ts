// Stable rule identifiers for the worktree authority kernel.
//
// Four namespaces:
//   - worktree.identity.*    — name and session-identity validation
//   - worktree.binding.*     — bind/rebind/derived-binding decisions
//   - worktree.ownership.*   — claim assertion and takeover audit
//   - worktree.transition.*  — spec-lifecycle transitions vs active bindings
//
// These ids are public contract. Tests, agents, and the shell consume them
// by name. Add new rules; do not rename or remove existing ones without a
// schema-version bump.

export const EVIDENCE_RULE_PREFIXES_UNUSED = undefined;

export const WORKTREE_RULES = {
  // ---- identity ------------------------------------------------------------
  IDENTITY_NAME_INVALID: 'worktree.identity.name_invalid',
  IDENTITY_SESSION_ID_EMPTY: 'worktree.identity.session_id_empty',
  IDENTITY_SESSION_PLATFORM_EMPTY: 'worktree.identity.platform_empty',

  // ---- binding -------------------------------------------------------------
  BINDING_SPEC_ID_MISMATCH: 'worktree.binding.spec_id_mismatch',
  BINDING_REBIND_REQUIRES_EXPLICIT_FLAG: 'worktree.binding.rebind_requires_explicit_flag',
  /** Warning emitted only when opts.rebind === true. Never paired with Err. */
  BINDING_REBIND_PERFORMED: 'worktree.binding.rebind_performed',
  BINDING_ONE_SIDED: 'worktree.binding.one_sided',
  BINDING_UNBOUND: 'worktree.binding.unbound',
  BINDING_SPEC_NOT_GOVERNABLE: 'worktree.binding.spec_not_governable',

  // ---- ownership -----------------------------------------------------------
  OWNERSHIP_FOREIGN_OWNER_BLOCKED: 'worktree.ownership.foreign_owner_blocked',
  OWNERSHIP_NO_OWNER_RECORDED: 'worktree.ownership.no_owner_recorded',
  /** Warning emitted on takeover; never paired with Err. */
  OWNERSHIP_TAKEOVER_PERFORMED: 'worktree.ownership.takeover_performed',
  OWNERSHIP_STALE_HEARTBEAT_NOT_ABANDONMENT: 'worktree.ownership.stale_heartbeat_not_abandonment',

  // ---- transition ----------------------------------------------------------
  TRANSITION_BLOCKED_BY_ACTIVE_BINDING: 'worktree.transition.blocked_by_active_binding',
  TRANSITION_INVALID: 'worktree.transition.invalid_transition',
} as const;

export type WorktreeRule = (typeof WORKTREE_RULES)[keyof typeof WORKTREE_RULES];

/**
 * Public namespace prefixes used by integration tests to assert that every
 * rule constant falls under one of the published namespaces.
 */
export const WORKTREE_RULE_PREFIXES = [
  'worktree.identity.',
  'worktree.binding.',
  'worktree.ownership.',
  'worktree.transition.',
] as const;
