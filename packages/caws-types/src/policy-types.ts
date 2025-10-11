/**
 * @fileoverview CAWS Policy Type Definitions
 * Types for policy.yaml configuration and governance
 * Enhanced from agent-agency implementation
 * @author @darianrosebrook
 */

/**
 * CAWS Policy Configuration
 * Defines governance rules, risk tiers, and quality requirements
 */
export interface CAWSPolicy {
  /** Policy schema version */
  version: number | string;

  /** Risk tier configurations */
  risk_tiers: RiskTierPolicy;

  /** Rules for editing policy.yaml itself */
  edit_rules?: PolicyEditRules;

  /** Quality gate configurations */
  gates?: GateConfigurations;

  /** Waiver approval requirements */
  waiver_approval?: WaiverApprovalPolicy;
}

/**
 * Risk tier policy mapping
 */
export type RiskTierPolicy = {
  [tier: number]: RiskTierConfiguration;
};

/**
 * Configuration for a single risk tier
 */
export interface RiskTierConfiguration {
  /** Maximum number of files that can be changed */
  max_files: number;

  /** Maximum lines of code that can be changed */
  max_loc: number;

  /** Minimum branch coverage percentage (0-100) */
  coverage_threshold?: number;

  /** Minimum mutation score percentage (0-100) */
  mutation_threshold?: number;

  /** Whether API contracts are required */
  contracts_required?: boolean;

  /** Whether manual code review is required */
  manual_review_required?: boolean;

  /** Human-readable description of tier */
  description?: string;

  /** Allowed development modes for this tier */
  allowed_modes?: Array<'feature' | 'refactor' | 'fix' | 'doc' | 'chore'>;
}

/**
 * Rules governing policy file modifications
 */
export interface PolicyEditRules {
  /** Whether policy and code changes can be in the same PR */
  policy_and_code_same_pr: boolean;

  /** Minimum approvers required for budget increases */
  min_approvers_for_budget_raise: number;

  /** Whether signed commits are required for policy changes */
  require_signed_commits?: boolean;

  /** Role required to approve policy changes */
  approver_role?: string;
}

/**
 * Quality gate configurations
 */
export interface GateConfigurations {
  /** Budget limit enforcement */
  budget_limit?: {
    enabled: boolean;
    description?: string;
  };

  /** Spec completeness checking */
  spec_completeness?: {
    enabled: boolean;
    description?: string;
  };

  /** Contract compliance validation */
  contract_compliance?: {
    enabled: boolean;
    description?: string;
  };

  /** Coverage threshold enforcement */
  coverage_threshold?: {
    enabled: boolean;
    description?: string;
  };

  /** Mutation testing enforcement */
  mutation_threshold?: {
    enabled: boolean;
    description?: string;
  };

  /** Security vulnerability scanning */
  security_scan?: {
    enabled: boolean;
    description?: string;
  };
}

/**
 * Waiver approval policy
 */
export interface WaiverApprovalPolicy {
  /** Minimum number of approvers required */
  required_approvers: number;

  /** Maximum duration for waivers in days */
  max_duration_days: number;

  /** Roles that can approve waivers */
  approver_roles?: string[];

  /** Whether expired waivers auto-revoke */
  auto_revoke_expired?: boolean;
}

/**
 * Tier-specific quality requirements
 * Computed from policy configuration
 */
export interface TierRequirements {
  /** Risk tier level */
  tier: number;

  /** Budget limits */
  budget: {
    max_files: number;
    max_loc: number;
  };

  /** Quality thresholds */
  quality: {
    coverage: number;
    mutation: number;
  };

  /** Requirement flags */
  requires: {
    contracts: boolean;
    manual_review: boolean;
    observability: boolean;
    rollback: boolean;
    security: boolean;
  };
}
