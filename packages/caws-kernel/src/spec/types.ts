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
}
