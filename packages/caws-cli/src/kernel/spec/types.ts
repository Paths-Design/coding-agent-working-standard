// Spec types. Hand-curated to match src/schemas/spec.v1.json.
// Generation from JSON Schema is deferred to caws-types replacement (later slice).
//
// The closed enums are exported as `const` value arrays (the single runtime
// source), and the corresponding TYPES are derived from them. This lets
// consumers (e.g. the CLI's --mode/--resolution/--risk-tier option help and
// validation) import the values rather than re-declaring them — eliminating
// the enum-duplication drift class (CAWS-CLI-HELP-METADATA-AUTHORITY-001).
// The arrays MUST mirror the corresponding enums in src/schemas/spec.v1.json,
// which remains the validation authority; a lock test asserts the equality.

export const RISK_TIERS = [1, 2, 3] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

export const SPEC_MODES = ['feature', 'refactor', 'fix', 'doc', 'chore'] as const;
export type Mode = (typeof SPEC_MODES)[number];

export const SPEC_LIFECYCLE_STATES = ['draft', 'active', 'closed', 'archived'] as const;
export type LifecycleState = (typeof SPEC_LIFECYCLE_STATES)[number];

export const SPEC_RESOLUTIONS = ['completed', 'superseded', 'abandoned'] as const;
export type Resolution = (typeof SPEC_RESOLUTIONS)[number];

export const CONTRACT_TYPES = ['api', 'schema', 'contract-test', 'behavior'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

// Source-side decision about a successor obligation. This axis records what the
// CLOSING spec decided; it never encodes the target's standing (active, closed,
// abandoned), which is derived from the target's own lifecycle_state +
// resolution at query time. "The target does not exist" is a resolver result
// (see SuccessorResolution), never a disposition.
export const SUCCESSOR_DISPOSITIONS = ['required', 'declined', 'absorbed'] as const;
export type SuccessorDisposition = (typeof SUCCESSOR_DISPOSITIONS)[number];

export interface Contract {
  name: string;
  type: ContractType;
  path?: string;
  description?: string;
}

export interface AcceptanceCriterion {
  id: string;
  given: string;
  when: string;
  then: string;
  test_command?: string;
  test_nodeids?: string[];
  evidence?: string;
  narrative?: string;
}

export interface NonFunctional {
  performance?: string[];
  security?: string[];
  accessibility?: string[];
  reliability?: string[];
}

export interface BlastRadius {
  modules: string[];
  data_migration?: boolean;
}

export interface Scope {
  in: string[];
  out?: string[];
  /**
   * Paths ADMITTED for Write/Edit like `in`, but which NEVER establish a
   * worktree claim (WORKTREE-SUPPORT-SCOPE-001). Use for repo-root deliverables
   * and shared artifacts a slice must touch without owning them. Still shadowed
   * by `out`. Optional; absence is unchanged behavior.
   */
  support?: string[];
}

export interface Blocker {
  reason: string;
  waiting_on?: string;
  since?: string;
}

export interface ExperimentalMode {
  enabled: boolean;
  rationale: string;
  expires_at: string;
}

/**
 * A structured successor declaration.
 *
 * Mirrors the `successors` items schema in spec.v1.json. Deliberately carries
 * NO target-standing field: whether the target is draft/active/closed/archived
 * (and with what resolution) is read from the target spec itself, never copied
 * here where it could go stale.
 */
export interface Successor {
  target_spec_id: string;
  disposition: SuccessorDisposition;
  rationale?: string;
  absorbed_by?: string;
}

/**
 * Per-criterion verified status, written by `caws specs evidence` and read by
 * the close gate. CLOSURE AUTHORITY for "is this AC satisfied."
 *
 * Mirrors the `evidence` items schema in spec.v1.json. The dual-write contract:
 * `recordSpecEvidence` patches this block (authority) AND appends an
 * `ac_recorded` event (audit history) in one transaction, so the two surfaces
 * agree by construction. The close gate reads ONLY this block — never the
 * event stream (mirrors how the successor-custody gate reads spec.successors,
 * not obligation events).
 *
 * `waiver_reason` is semantically required iff `status === 'waived'`
 * (validate-semantics.ts) — JSON Schema cannot express "required iff". An
 * undocumented waiver is indistinguishable from an oversight, paralleling
 * successors[].disposition: 'declined'.
 */
export const EVIDENCE_STATUSES = ['pass', 'fail', 'unchecked', 'waived'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export interface EvidenceRecord {
  criterion_id: string;
  status: EvidenceStatus;
  evidence_ref?: string;
  waiver_reason?: string;
  recorded_at: string;
  test_nodeid?: string;
  command?: string;
  exit_code?: number;
  artifact_path?: string;
  commit_sha?: string;
}

export interface Spec {
  id: string;
  title: string;
  risk_tier: RiskTier;
  mode: Mode;
  lifecycle_state: LifecycleState;
  resolution?: Resolution;
  blockers?: Blocker[];
  supersedes?: string;
  superseded_by?: string;
  successors?: Successor[];
  worktree?: string;
  operational_rollback_slo?: string;
  blast_radius: BlastRadius;
  scope: Scope;
  invariants: string[];
  acceptance: AcceptanceCriterion[];
  non_functional: NonFunctional;
  contracts: Contract[];
  observability?: string[];
  rollback?: string[];
  experimental_mode?: ExperimentalMode;
  created_at?: string;
  updated_at?: string;
  owner?: string;
  closure_notes?: string;
  evidence?: EvidenceRecord[];
}
