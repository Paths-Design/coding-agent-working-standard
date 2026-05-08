// Policy types. Hand-curated to match src/schemas/policy.v1.json.
// Schema codegen deferred to caws-types replacement (later slice).

import type { RiskTier } from '../spec/types';

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

// --- Waiver types (no schema file yet; lives in .caws/waivers/) ---

export type WaiverStatus = 'proposed' | 'active' | 'revoked' | 'expired';

export interface WaiverApprover {
  name: string;
  role?: string;
}

export interface WaiverDelta {
  max_files?: number;
  max_loc?: number;
}

export interface Waiver {
  waiver_id: string;
  status: WaiverStatus;
  spec_id?: string;
  gates: GateId[];
  delta?: WaiverDelta;
  expires_at?: string;
  approvers?: WaiverApprover[];
  reason_code?: string;
  created_at?: string;
}

// --- Budget derivation types ---

export interface EffectiveBudget {
  max_files: number;
  max_loc: number;
}

export type SkipReason =
  | 'status_not_active'
  | 'expired'
  | 'gate_not_covered'
  | 'negative_delta'
  | 'insufficient_approvers'
  | 'malformed';

export interface AppliedWaiverEntry {
  waiver_id: string;
  delta: { max_files: number; max_loc: number };
}

export interface SkippedWaiverEntry {
  waiver_id: string;
  reason: SkipReason;
  detail?: string;
}

export interface BudgetDerivationTrace {
  tier: RiskTier;
  baseline: EffectiveBudget;
  appliedWaivers: AppliedWaiverEntry[];
  skippedWaivers: SkippedWaiverEntry[];
  effective: EffectiveBudget;
  evaluatedAt: string;
}
