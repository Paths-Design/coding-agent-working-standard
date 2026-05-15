// Stable rule identifiers for the doctor kernel.
//
// Each id is the contract that tests, agents, and the shell consume by name.
// Add new ids; do not rename existing ones without a schema-version bump.

export const DOCTOR_RULES = {
  // ---- spec lifecycle ------------------------------------------------------
  /** Active spec with no bound worktree, updated_at older than threshold. */
  SPEC_UNBOUND_ACTIVE_STALE: 'doctor.spec.unbound_active_stale',
  /** Active spec with no bound worktree and no updated_at to compare against. */
  SPEC_UNBOUND_ACTIVE_TIMESTAMP_MISSING: 'doctor.spec.unbound_active_timestamp_missing',

  // ---- binding integrity ---------------------------------------------------
  /** Registry has specId AND spec.worktree, but they disagree about each other. */
  BINDING_ONE_SIDED: 'doctor.binding.one_sided',
  /** worktrees.json names a spec id that no loaded spec matches. */
  BINDING_REGISTRY_MISSING_SPEC: 'doctor.binding.registry_missing_spec',
  /** A spec has worktree:<name> but no matching registry entry. */
  BINDING_SPEC_MISSING_REGISTRY: 'doctor.binding.spec_missing_registry',
  /**
   * Bidirectional binding exists, but the spec's lifecycle_state is not
   * 'active' (it is draft, closed, or archived). Closed/archived specs
   * cannot authorize governed writes, so this is contradictory authority
   * state, not just hygiene.
   */
  BINDING_SPEC_NOT_GOVERNABLE: 'doctor.binding.spec_not_governable',
  /**
   * A spec claims a worktree name that is held by a *different* spec id
   * in the registry. The worktree authority is occupied by another spec;
   * the repair is on the spec side (clear its `worktree:` field) or the
   * registry side (rebind), depending on intent.
   */
  BINDING_SPEC_POINTS_TO_FOREIGN_BINDING: 'doctor.binding.spec_points_to_foreign_binding',

  // ---- transition advisories (info — not failures) -------------------------
  TRANSITION_ACTIVE_BINDING_BLOCKS_CLOSE: 'doctor.transition.active_binding_blocks_close',

  // ---- agent freshness (display-only; never authority) ---------------------
  /**
   * An agent record's last_active is older than `staleAgentTtlMs`. This is a
   * DISPLAY signal only. It does NOT imply takeover authority. The shell may
   * choose to prune it from views; ownership decisions still consult
   * worktrees.json owner.
   */
  AGENT_STALE_DISPLAY_ONLY: 'doctor.agent.stale_display_only',

  // ---- ownership hygiene ---------------------------------------------------
  /** prior_owners list length exceeds threshold (hygiene warning, no action). */
  OWNERSHIP_PRIOR_OWNER_GROWTH: 'doctor.ownership.prior_owner_growth',

  // ---- event chain ---------------------------------------------------------
  /** verifyChain reported errors; doctor surfaces the count + first rule. */
  EVENT_CHAIN_INVALID: 'doctor.event.chain_invalid',

  // ---- policy --------------------------------------------------------------
  POLICY_MISSING: 'doctor.policy.missing',
  POLICY_VALID_WITH_WARNINGS: 'doctor.policy.valid_with_warnings',

  // ---- templates (caller-supplied; severity preserved) ---------------------
  TEMPLATE_DRIFT: 'doctor.template.drift',
  TEMPLATE_WARNING: 'doctor.template.warning',

  // ---- waivers --------------------------------------------------------------
  /**
   * A waiver has stored status='active' but expires_at <= now.
   * Severity: warning. Expired waivers are inert (the runtime applicability
   * check rejects them), so this is operational hygiene, not a corruption.
   */
  WAIVER_EXPIRED_ACTIVE: 'doctor.waiver.expired_active',
  /**
   * A waiver names a gate that is not present in `policy.gates`.
   * Severity: error when policy is loaded (policy cannot govern this gate,
   * so the waiver is structurally pointing at nothing). Severity: warning
   * when no policy is loaded (we cannot compare authoritatively).
   */
  WAIVER_UNKNOWN_GATE: 'doctor.waiver.unknown_gate',
  /**
   * A waiver file failed to parse or validate. Doctor passes through the
   * incoming diagnostic's severity unchanged so loader semantics
   * (error vs info) survive.
   */
  WAIVER_MALFORMED_LOADED: 'doctor.waiver.malformed_loaded',
  /**
   * A `gate_evaluated` event credits a waiver_id whose current waiver
   * record is `status: revoked`. Severity: warning. Auditors should know
   * that a previously-applied suppression is no longer authorized; the
   * historical event itself stays untouched (events are append-only).
   */
  WAIVER_REVOKED_REFERENCED: 'doctor.waiver.revoked_referenced',
} as const;

export type DoctorRule = (typeof DOCTOR_RULES)[keyof typeof DOCTOR_RULES];

export const DOCTOR_RULE_PREFIXES = [
  'doctor.spec.',
  'doctor.binding.',
  'doctor.transition.',
  'doctor.agent.',
  'doctor.ownership.',
  'doctor.event.',
  'doctor.policy.',
  'doctor.template.',
  'doctor.waiver.',
] as const;
