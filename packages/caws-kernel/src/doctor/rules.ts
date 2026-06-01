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
   * Registry entry exists for a worktree, but the backing git worktree
   * directory is absent at the canonical path AND not present in
   * `git worktree list --porcelain`. H1 in WORKTREE-DOCTOR-HALF-STATE-001.
   * Authority split-brain: registry claims a worktree that is physically
   * gone.
   */
  WORKTREE_GHOST_REGISTRY_ENTRY: 'doctor.worktree.ghost_registry_entry',
  /**
   * 3-way registry/spec contradiction (the bindWorktreeRepair post-fault
   * class). Registry binds `<name>` to spec B; spec A still claims
   * `worktree: <name>`; spec B has no `worktree:` field. H5 in
   * WORKTREE-DOCTOR-HALF-STATE-001. The repair is intentionally a
   * non-actionable doctrine pointer — no shell command — because
   * picking a winner requires authority policy from
   * WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001.
   */
  WORKTREE_BINDING_CONTRADICTION_3WAY:
    'doctor.worktree.binding_contradiction_3way',
  /**
   * `git worktree list --porcelain` reports a linked worktree at some
   * path; no `.caws/worktrees.json` entry references that path. H6 in
   * WORKTREE-DOCTOR-HALF-STATE-001. Severity INFO — CAWS does not
   * govern raw git worktrees, but silent acceptance is a footgun.
   * The main worktree (path === repoRoot) is filtered out and never
   * reported as foreign.
   */
  WORKTREE_FOREIGN_PHYSICAL: 'doctor.worktree.foreign_physical',
  /**
   * `git worktree list --porcelain` failed (no git, repo corruption,
   * permission error). Doctor still produces a full report; this
   * finding signals that git-backed half-state classes (H1, H6) and
   * the H4 enrichment on BINDING_SPEC_MISSING_REGISTRY could not be
   * evaluated. Severity INFO — incomplete observability is preferable
   * to fail-closed.
   */
  WORKTREE_GIT_OBSERVATION_UNAVAILABLE:
    'doctor.worktree.git_observation_unavailable',
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

  // ---- lease/worktree liveness drift (AGENT-LIVENESS-DOCTOR-001 D10) --------
  /**
   * A worktrees.json entry has an `owner` whose session has no live lease
   * (the lease file is absent, stale by TTL, or stopped). DIAGNOSTIC ONLY —
   * the owner is still authoritative for ownership decisions (leases are
   * operational cache, never authority). This surfaces post-merge / post-probe
   * half-state where the owning session has gone quiet but the registry still
   * names it. Severity: warning.
   */
  WORKTREE_OWNER_LEASE_MISSING: 'doctor.worktree.owner_lease_missing',
  /**
   * Leases exist under `.caws/leases/` but the platform's PID liveness signal
   * is unreliable here — specifically, every running lease's recorded pid is
   * dead while its heartbeat is recent (the ephemeral-per-invocation-pid case
   * that made `prune --dead` reap healthy sessions). DIAGNOSTIC ONLY — it tells
   * the operator the PID oracle is invalid on this platform, NOT that anything
   * should be cleaned up. Severity: info.
   */
  AGENT_PID_ORACLE_UNRELIABLE: 'doctor.agent.pid_oracle_unreliable',

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

  // ---- init layout (slice 7c.2) -------------------------------------------
  /**
   * `.caws/working-spec.yaml` is present. The vNext model is multi-spec
   * under `.caws/specs/`; the legacy single-spec entry point is a hard
   * authority contradiction. Severity: error.
   */
  INIT_LEGACY_WORKING_SPEC_PRESENT: 'doctor.init.legacy_working_spec_present',
  /** `.caws/working-spec.schema.json` legacy artifact present. Error. */
  INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT:
    'doctor.init.legacy_working_spec_schema_present',
  /**
   * `.caws/specs/` directory absent on a project that otherwise looks
   * initialized. Stores default to "no specs" so this is operational
   * drift, not corruption. Severity: warning.
   */
  INIT_SPECS_DIR_MISSING: 'doctor.init.specs_dir_missing',
  /** `.caws/waivers/` directory absent. Same shape as specs_dir_missing. */
  INIT_WAIVERS_DIR_MISSING: 'doctor.init.waivers_dir_missing',
  /**
   * `.caws/worktrees.json` absent. The store treats absence as `{}`,
   * but doctor should flag drift on a project that has been initialized.
   */
  INIT_WORKTREES_REGISTRY_MISSING: 'doctor.init.worktrees_registry_missing',
  /** `.caws/agents.json` absent. Same shape as worktrees_registry_missing. */
  INIT_AGENTS_REGISTRY_MISSING: 'doctor.init.agents_registry_missing',
  // No rule for events.jsonl missing — first append creates it under
  // lock and a missing file is valid until then.

  // ---- registry hygiene (slice 7c.2) -------------------------------------
  /**
   * worktrees.json or agents.json parsed as something other than a plain
   * object. Severity is inherited from the source diagnostic so the
   * loader's intent (always error today) survives.
   */
  REGISTRY_MALFORMED_LOADED: 'doctor.registry.malformed_loaded',

  // ---- policy posture (slice 7c.2) ---------------------------------------
  /**
   * A critical gate (budget_limit, spec_completeness, scope_boundary) is
   * disabled OR not in block mode. Doctor reports this as posture risk;
   * policy validation already emits its own semantic warning. The two
   * audiences are different (operator vs. config validator) and the
   * doctor finding is what shows up in `caws status`.
   */
  POLICY_CRITICAL_GATE_NOT_BLOCKING: 'doctor.policy.critical_gate_not_blocking',
  /**
   * `policy.non_governed_zones` contains a dangerously broad pattern
   * (e.g. "*", "**", ".", "/"). Severity: warning by default; error if
   * `non_governed_zones_force === true` (the team has explicitly armed
   * the dangerous pattern, which removes any "off by default" safety net).
   */
  POLICY_NON_GOVERNED_ZONE_BROAD: 'doctor.policy.non_governed_zone_broad',
  /**
   * `policy.root_passthrough` lists a high-blast-radius root file
   * (e.g. package.json, tsconfig.json). Severity: warning.
   */
  POLICY_ROOT_PASSTHROUGH_RISKY: 'doctor.policy.root_passthrough_risky',

  // ---- waiver posture (slice 7c.2) ---------------------------------------
  /**
   * The number of *currently effective* waivers covering a given gate
   * exceeds `policy.waivers.max_active_waivers_per_gate`. Counts only
   * effective waivers (active && not expired); revoked/expired records
   * cannot affect gates and would be noise in this count. Severity: warning.
   */
  WAIVER_TOO_MANY_ACTIVE_FOR_GATE: 'doctor.waiver.too_many_active_for_gate',
  /**
   * An effective waiver expires within a policy-defined window. Skipped
   * entirely if no threshold is configured — doctor will not invent a
   * default that surprises the operator. Severity: info.
   */
  WAIVER_EXPIRES_SOON: 'doctor.waiver.expires_soon',
  /**
   * CAWS-ARCHIVE-AS-TOMBSTONE-001: a legacy
   * `.caws/specs/.archive/<id>.yaml` body exists on disk. Post-
   * tombstone, archive does not write bodies to `.archive/` — these
   * are leftovers from pre-slice archive operations. Severity WARN
   * (not error): the bodies are harmless on disk but pollute agent
   * grep/RAG surfaces with stale spec content. Repair: run
   * `caws specs prune-archive --dry-run` to preview migration;
   * `--apply` to execute (recoverable bodies removed, unrecoverable
   * quarantined).
   */
  ARCHIVE_LEGACY_BODIES_PRESENT: 'doctor.archive.legacy_bodies_present',
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
  'doctor.init.',
  'doctor.registry.',
  'doctor.worktree.',
  'doctor.archive.',
] as const;
