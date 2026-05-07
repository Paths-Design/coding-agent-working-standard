// Spec types. Hand-curated to match src/schemas/spec.v1.json.
// Generation from JSON Schema is deferred to caws-types replacement (later slice).

export type RiskTier = 1 | 2 | 3;

export type Mode = 'feature' | 'refactor' | 'fix' | 'doc' | 'chore';

export type LifecycleState = 'draft' | 'active' | 'closed' | 'archived';

export type Resolution = 'completed' | 'superseded' | 'abandoned';

export type ContractType = 'api' | 'schema' | 'contract-test' | 'behavior';

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
