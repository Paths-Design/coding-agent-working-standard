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
  /**
   * The AGGREGATE of the two rules above (CAWS-SPEC-ACTIVATION-BINDS-001).
   * One finding for the whole repo, not one per spec: a repo that has drifted
   * to 27 unbound-active specs produced 27 warnings that buried every other
   * doctor finding, which is how the condition went unnoticed long enough to
   * reach 27. Escalates to `error` above unboundActiveErrorCount. Every
   * affected spec id stays in `data.spec_ids`; only the human message
   * truncates.
   */
  SPEC_UNBOUND_ACTIVE_BACKLOG: 'doctor.spec.unbound_active_backlog',

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
  WORKTREE_BINDING_CONTRADICTION_3WAY: 'doctor.worktree.binding_contradiction_3way',
  /**
   * `git worktree list --porcelain` reports a linked worktree at some
   * path; no `.caws/worktrees.json` entry references that path. H6 in
   * WORKTREE-DOCTOR-HALF-STATE-001. Severity INFO — CAWS does not
   * govern raw git worktrees, but silent acceptance is a footgun.
   * The main worktree (path === repoRoot) is filtered out and never
   * reported as foreign.
   */
  WORKTREE_FOREIGN_PHYSICAL: 'doctor.worktree.foreign_physical',
  // CANONICAL-DRIFT-GUARDS-001 (Entry 37): the canonical checkout's HEAD is
  // parked on a non-base branch while CAWS worktrees are active — spec
  // lifecycle auto-commits will land on the parked branch.
  CANONICAL_MIS_PARKED_HEAD: 'doctor.canonical.mis_parked_head',
  /**
   * Event-backed governance-half-state: the event log contains a
   * `worktree_created` event for a worktree name, but `.caws/worktrees.json`
   * has no live registry entry for that name AND no loaded spec carries a live
   * `worktree:` binding to it. This is the createWorktree second-event
   * divergence proven by CAWS-LIFECYCLE-ROLLBACK-HARNESS-COMPLETE-001: the
   * worktree_created event was appended to the immutable hash chain, then the
   * worktree_bound event failed and the transaction rolled back the registry +
   * filesystem writes — leaving an event recording a worktree the control plane
   * does not reflect. WORKTREE-DOCTOR-HALF-STATE-001. Suppressed when a later
   * `worktree_destroyed` event for the same name closes the lifecycle, or when
   * the worktree is live.
   *
   * CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01: severity is now conditional.
   * WARN (the reconcilable-residue case) when any physical remainder exists or
   * any tombstone observation is missing — no governed command can close this
   * class, so an unverifiable orphan stays visible as actionable-looking
   * residue. INFO (verifiable tombstone) when the name is observably dead
   * everywhere: registry absent, spec binding absent, destroy event absent,
   * recorded branch absent from the observed local refs, recorded path
   * observed absent, and no linked worktree listed at the recorded path. A
   * warning nobody can discharge trains operators to ignore doctor; the
   * tombstone records the verification without demanding a remedy.
   */
  WORKTREE_EVENT_WITHOUT_CONTROL_PLANE_BINDING:
    'doctor.worktree.event_without_control_plane_binding',
  /**
   * `git worktree list --porcelain` failed (no git, repo corruption,
   * permission error). Doctor still produces a full report; this
   * finding signals that git-backed half-state classes (H1, H6) and
   * the H4 enrichment on BINDING_SPEC_MISSING_REGISTRY could not be
   * evaluated. Severity INFO — incomplete observability is preferable
   * to fail-closed.
   */
  WORKTREE_GIT_OBSERVATION_UNAVAILABLE: 'doctor.worktree.git_observation_unavailable',
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
  // AGENT_STALE_DISPLAY_ONLY ('doctor.agent.stale_display_only') was removed by
  // CAWS-DEFECT-DOCTOR-FROZEN-AGENTS-LIVENESS-01. It reported per-record
  // freshness from the frozen `.caws/agents.json`, could not distinguish a
  // stopped session from a stale one, and no command could discharge it.
  // Agent liveness is a lease concern — see WORKTREE_OWNER_LEASE_MISSING below
  // and `caws agents list` for the human-facing freshness view.

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
  INIT_LEGACY_WORKING_SPEC_SCHEMA_PRESENT: 'doctor.init.legacy_working_spec_schema_present',
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
  /**
   * CAWS-DOCTOR-HOOKS-NO-CAWS-DRIFT-001: the CAWS hook pack is installed
   * under `.claude/hooks/` but `.caws/` does NOT exist. This is the
   * "hooks-present, substrate-absent" split-brain: governance hooks
   * (scope-guard, worktree-write-guard, doc-frontmatter caws_specs gate)
   * are wired and will fire, but there is no control plane behind them, so
   * agents get cornered into satisfying a hook against state that cannot
   * exist (the turn-003 placeholder-spec failure). Distinct from the
   * INIT_*_MISSING rules, which presuppose `.caws/` exists and a sub-path
   * is absent — this rule is the inverse: the hooks exist, the whole
   * `.caws/` does not. Severity: warning. Repair: `caws init`.
   */
  INIT_HOOKS_PRESENT_CAWS_ABSENT: 'doctor.init.hooks_present_caws_absent',

  /**
   * CAWS-HARNESS-TELEMETRY-ADAPTER-001: the vendored telemetry rows
   * (agent-heartbeat.sh, agent-stop.sh, session-log.sh,
   * session_log_renderer.py under .caws/hooks/) are still installed as
   * shared-pack managed files while an adapter-covered surface pack (dsh)
   * is ALSO installed. The telemetry plane for an adapter-covered surface
   * is owned by that surface's harness adapter, so the vendored rows are
   * stale dual-writers over the same .caws/sessions/ and .caws/leases/
   * state. Absence is never staleness: no rows present, or rows without an
   * installed adapter pack, stays silent. Severity: warning (render-only;
   * the vendored rows still work). Repair: re-run `caws init` — for an
   * adapter-covered surface init omits the rows from the install set and
   * retires managed stale copies (retireStaleTelemetryRows); unmanaged
   * local growth is never touched.
   */
  HOOKS_STALE_TELEMETRY_PACK: 'doctor.hooks.stale_telemetry_pack',

  /**
   * CAWS-DEFECT-STALE-INSTALLED-GUARD-PLANE-01: the repo's INSTALLED shared
   * hook pack (.caws/hooks rows, stamped hook_pack_version header) lags the
   * SHIPPING SHARED_PACK_VERSION. The hooks that enforce governance are the
   * CLI's runtime; running a pack the shipping code no longer contains is
   * the guard-plane equivalent of shipping stale runtime (observed live:
   * v43 installed vs v53 shipped — including a pre-PID-anchor session-id.sh
   * whose removed capsule tier was still enforcing). Severity: warning.
   * Repair: `caws init diff` to inspect per-file drift, then
   * `caws init --overwrite --force` to refresh, or `--adopt` to keep local
   * growth. Absent/unreadable headers are unobserved (silent).
   *
   * HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001: this rule is NOT suppressed by the
   * presence of a machine runtime. The runtime makes a repo's copied pack inert
   * ONLY for a surface CAWS has REGISTERED in that harness's native config, and
   * registration is deliberately narrow: system-runtime.ts vendorFor admits just
   * codex, claude-code and qwen-code (an unregistered harness is refused, because
   * registering one with no verified adapter would let systemSurfaceEnabled()
   * report true while `caws init` stops maintaining the pack that harness
   * actually executes). Every other harness keeps running the repo's own copy —
   * the adapter-wired DSH bridge invokes
   * <repoRoot>/.caws/hooks/dispatch/<event>.sh directly and has no runtime path
   * at all. So `systemRuntime !== undefined` reports which surfaces are
   * configured; it does NOT prove the harness executing against this repo is
   * among them. Suppressing on it asserted a wiring fact doctor cannot observe,
   * and the failure mode was silence about a live, old guard plane — reproduced
   * live: runtime installed, copied pack at v56 while the CLI shipped v68, DSH
   * executing the v56 copy, doctor silent. Reporting is the fail-safe direction:
   * a false-positive advisory at worst, never silence about a live old plane.
   */
  HOOKS_INSTALLED_PACK_VERSION_LAG: 'doctor.hooks.installed_pack_version_lag',

  /**
   * HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001: an installed copied shared hook
   * file differs in BODY from the shipping template once the install-time
   * `hook_pack_version` stamp is normalized on both sides. The version stamp is
   * NOT a freshness proxy — manifest-shared.ts records content changes that
   * landed without a version bump — so version equality cannot prove the copied
   * pack matches what the CLI ships. This is the gap the version-lag rule above
   * structurally cannot see.
   *
   * CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01: this rule now fires
   * ONLY over rows WITHOUT verified new growth — no baseline, or the installed
   * body matches its baseline. That shape is AMBIGUOUS rather than refreshable:
   * a port run under CLI 12.0.0 or 12.1.0 baselined the reconciled body it
   * landed, so a growth file that went through one of those ports shows "no
   * edit over baseline" too. CAWS-DEFECT-DRIFT-DISCHARGE-UNDISCOVERABLE-01
   * changed port to baseline the upstream template, which removes the ambiguity
   * for new ports but does not heal baselines already written. Severity:
   * warning, with a repair that demands reading the diff before any refresh
   * and names `caws init port` for deltas worth keeping. Rows whose
   * baseline PROVES new growth (installed differs from baseline) render as
   * HOOKS_PACK_LOCAL_GROWTH (info) instead.
   */
  HOOKS_PACK_BODY_DRIFT: 'doctor.hooks.pack_body_drift',

  /**
   * CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01: installed copied
   * shared hook files whose pristine baseline (written by the installer at
   * .caws/hooks/.pristine/<packId>/<destPath>) PROVES deliberate local growth —
   * the installed body differs from the as-installed baseline. Refreshing
   * would destroy that growth, so a warning demanding refresh is a demand
   * nobody can safely perform (the destructive no-discharge class). Severity:
   * INFO — the divergence is verified repo-owned surface awaiting the retrofit
   * (absorb the growth upstream, then re-init), and rows that also carry
   * upstream template changes name them so the retrofit ports everything.
   */
  HOOKS_PACK_LOCAL_GROWTH: 'doctor.hooks.pack_local_growth',

  /**
   * CAWS-DOCTOR-FORK-LAG-UPSTREAM-MOVED-01: a locally grown hook file whose
   * UPSTREAM template has also moved since its baseline was recorded. Growth
   * alone is a standing, discharged state (HOOKS_PACK_LOCAL_GROWTH, info);
   * growth whose upstream moved is an outstanding obligation — the fork is
   * running without upstream fixes it never received.
   *
   * This is deliberately NOT folded into HOOKS_INSTALLED_PACK_VERSION_LAG.
   * That rule's warning branch prescribes `caws init --overwrite --force`,
   * which DESTROYS a fork; escalating a fork into it would aim the operator
   * at the one command that loses the work. Severity: WARNING with a PORT
   * remediation — the obligation is real, and the safe discharge is
   * `caws init port`, never a wholesale refresh.
   */
  HOOKS_PACK_FORK_UPSTREAM_MOVED: 'doctor.hooks.pack_fork_upstream_moved',

  /**
   * CAWS-DEFECT-LEASE-TMP-STRANDING-01: stranded atomic-write tmp files in
   * .caws/leases/ — a lease write crashed between tmp creation and rename,
   * littering the directory invisibly (the loader already ignores non-.json
   * names). Severity: warning. Repair: automatic (the next lease write
   * sweeps dead-owner/hard-aged tmps) or manual removal. Foreign files are
   * never named.
   */
  LEASES_STRANDED_TMP: 'doctor.leases.stranded_tmp',

  /**
   * CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A4: the machine's ~/.caws global
   * home exists but carries entries outside the known structure (state/,
   * surfaces/, lib/) — unmanaged global state is the pre-v11 residue class
   * (observed live: working-spec.yaml + orphan events.jsonl). Severity:
   * warning. Repair: archive the foreign entries with a manifest (the A1
   * migration pattern), never blind-delete.
   */
  HOOKS_SYSTEM_RUNTIME: 'doctor.hooks.system_runtime',
  HOOKS_SYSTEM_RUNTIME_INVALID: 'doctor.hooks.system_runtime_invalid',
  HOOKS_SYSTEM_LEGACY_WIRING: 'doctor.hooks.system_legacy_wiring',
  GLOBAL_HOME_UNMANAGED_STATE: 'doctor.global_home.unmanaged_state',
  /**
   * CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01: entries in the machine's
   * ~/.caws global home that are RECOGNIZED legacy output of a prior CLI
   * generation (`sessions` — pre-v11 machine-home session logs; current
   * session logs are repo-local). Distinct from unmanaged state: the
   * provenance is known, the current CLI neither reads nor writes these, and
   * no review is demanded. Severity INFO — names the legacy provenance so a
   * future reader knows what the bytes are; keeping them is safe.
   */
  GLOBAL_HOME_RECOGNIZED_LEGACY_STATE: 'doctor.global_home.recognized_legacy_state',
  /** Existing home with neither a legacy migration stamp nor a verified runtime. */
  GLOBAL_HOME_STAMP_MISSING: 'doctor.global_home.stamp_missing',
  GLOBAL_HOME_UNREADABLE: 'doctor.global_home.unreadable',
  GLOBAL_HOME_RUNTIME_INVALID: 'doctor.global_home.runtime_invalid',

  /**
   * CAWS-GATED-SURFACE-SCOPE-GUARD-001: a trust-gated surface (qwen-code,
   * zcode) carries CAWS hook wiring at BOTH user scope and project scope on
   * this machine. The harness merges the two additively, so every CAWS
   * dispatcher double-fires (doubled audit events, SessionStart hangs —
   * proven live 2026-08-13). Severity: warning (render-only; wiring still
   * works, twice). Repair: keep ONE scope — the user-scope wiring (immune
   * to the qwen trust gate and the zcode project-hook strip); remove the
   * project-scope hook entries. `caws init` for a gated surface now refuses
   * to add them, but entries from a pre-guard init must be removed by hand.
   */
  HOOKS_USER_SCOPE_DUAL_WIRING: 'doctor.hooks.user_scope_dual_wiring',

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
   * Deprecated compatibility rule name from the tombstone-only archive
   * era. Current archive operations intentionally write bodies under
   * `.caws/specs/.archive/`, so doctor no longer emits this finding
   * for ordinary archive bodies.
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
