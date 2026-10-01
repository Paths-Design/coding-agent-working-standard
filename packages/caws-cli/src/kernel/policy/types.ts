// Policy types. Hand-curated to match src/schemas/policy.v1.json.
// Schema codegen deferred to caws-types replacement (later slice).

export type GateId =
  | 'budget_limit'
  | 'spec_completeness'
  | 'scope_boundary'
  | 'god_object'
  | 'todo_detection';

export type GateMode = 'block' | 'warn' | 'skip';

export interface RiskTierBudget {
  max_files: number;
  max_loc: number;
  description?: string;
}

export interface GateConfig {
  enabled: boolean;
  mode: GateMode;
  description?: string;
  thresholds?: Record<string, unknown>;
}

export interface WaiversPolicy {
  /** Deprecated and inert: budgets are an advisory sizing goal and are never
   *  raised by waiver. Accepted so existing policies still load; semantics
   *  warns (BUDGET_RAISE_APPROVERS_INERT). */
  min_approvers_for_budget_raise?: number;
  max_active_waivers_per_gate?: number;
  default_expiry_days?: number;
}

export interface EditRules {
  policy_and_code_same_pr?: boolean;
  require_signed_commits?: boolean;
  require_dual_control_for_governance?: boolean;
}

export interface Policy {
  version: 1;
  risk_tiers: {
    '1': RiskTierBudget;
    '2': RiskTierBudget;
    '3': RiskTierBudget;
  };
  gates: {
    budget_limit: GateConfig;
    spec_completeness: GateConfig;
    scope_boundary: GateConfig;
    god_object?: GateConfig;
    todo_detection?: GateConfig;
  };
  waivers?: WaiversPolicy;
  non_governed_zones?: string[];
  non_governed_zones_force?: boolean;
  root_passthrough?: string[];
  edit_rules?: EditRules;
}
