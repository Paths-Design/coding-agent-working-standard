/**
 * @fileoverview CAWS Working Specification Types
 * Type definitions for CAWS working specs and related structures
 * Ported from agent-agency implementation
 * @author @darianrosebrook
 */

/**
 * CAWS Working Specification
 * Complete specification for a development task
 */
export interface WorkingSpec {
  /** Unique identifier (e.g., FEAT-001, FIX-042) */
  id: string;

  /** Human-readable title */
  title: string;

  /** Risk tier (1=critical, 2=standard, 3=low) */
  risk_tier: number;

  /** Development mode */
  mode: 'feature' | 'refactor' | 'fix' | 'doc' | 'chore';

  /** Change budget limits (deprecated - use policy.yaml) */
  change_budget?: {
    max_files: number;
    max_loc: number;
  };

  /** Blast radius definition */
  blast_radius: {
    modules: string[];
    data_migration: boolean;
  };

  /** Operational rollback SLO */
  operational_rollback_slo: string;

  /** Scope definition */
  scope: {
    /** Paths included in scope */
    in: string[];
    /** Paths excluded from scope */
    out: string[];
  };

  /** System invariants that must be maintained */
  invariants: string[];

  /** Acceptance criteria (Given-When-Then) */
  acceptance: AcceptanceCriterion[];

  /** Non-functional requirements */
  non_functional: {
    /** Accessibility requirements */
    a11y?: string[];
    /** Performance requirements */
    perf?: {
      api_p95_ms?: number;
      lcp_ms?: number;
      tti_ms?: number;
      bundle_kb?: number;
    };
    /** Security requirements */
    security?: string[];
  };

  /** API contracts */
  contracts: ContractDefinition[];

  /** Rollback procedures */
  rollback?: string[];

  /** Observability requirements */
  observability?: {
    logs?: string[];
    metrics?: string[];
    traces?: string[];
  };

  /** Migration steps */
  migrations?: string[];

  /** Waiver IDs if budget exceptions needed */
  waiver_ids?: string[];

  /** Experimental mode configuration */
  experimental_mode?: {
    enabled: boolean;
    rationale: string;
    expires_at: string;
  };

  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Acceptance criterion in Given-When-Then format
 */
export interface AcceptanceCriterion {
  /** Criterion ID (e.g., A1, A2) */
  id: string;

  /** Given: Initial state/context */
  given: string;

  /** When: Action/event that occurs */
  when: string;

  /** Then: Expected outcome */
  then: string;

  /** Progress status */
  status?: 'pending' | 'in_progress' | 'completed';

  /** Progress tracking details */
  tests?: {
    written?: number;
    passing?: number;
  };

  /** Coverage percentage for this criterion */
  coverage?: number;

  /** Last update timestamp */
  last_updated?: string;
}

/**
 * API contract definition
 */
export interface ContractDefinition {
  /** Contract type */
  type: 'openapi' | 'graphql' | 'grpc' | 'typescript' | 'json-schema' | 'pact' | 'proto';

  /** Path to contract file */
  path: string;

  /** Contract version */
  version?: string;

  /** Whether contract tests are required */
  tests_required?: boolean;
}

/**
 * CAWS configuration from package.json
 */
export interface CAWSConfig {
  /** Risk tier for the project */
  tier: number;

  /** Enabled features */
  features?: {
    thinking_budgets?: boolean;
    minimal_diff_evaluation?: boolean;
    turn_level_rl?: boolean;
    model_based_judges?: boolean;
    tool_learning?: boolean;
  };

  /** Contract definitions */
  contracts?: {
    openapi?: string[];
    graphql?: string[];
  };

  /** Quality thresholds */
  quality?: {
    coverage?: number;
    mutation?: number;
  };
}
