/**
 * @fileoverview Placeholder Governance Types
 * Type definitions for explicit, bounded placeholder degradations
 * Implements "no-surprises" contract for agent outputs
 * @author @darianrosebrook
 */

/**
 * Impact level of a placeholder on acceptance criteria
 */
export type PlaceholderImpact = 'non_blocking' | 'partial' | 'blocks_acceptance';

/**
 * Reason for placeholder degradation
 */
export type PlaceholderReason =
  | 'token_budget'
  | 'dependency_missing'
  | 'timebox'
  | 'redaction'
  | 'non_critical_expansion';

/**
 * Scope of placeholder degradation
 */
export type PlaceholderScope =
  | 'examples'
  | 'citations'
  | 'section'
  | 'file_region'
  | 'code_region'
  | 'documentation'
  | 'tests'
  | 'implementation';

/**
 * Result type for agent outputs
 */
export type ResultType = 'doc' | 'code' | 'json' | 'plan' | 'test' | 'config';

/**
 * Placeholder degradation declaration
 * Represents an explicit, bounded degradation in agent output
 */
export interface Placeholder {
  /** Unique identifier (e.g., PH-2025-11-11-001) */
  id: string;

  /** Scope of degradation */
  scope: PlaceholderScope;

  /** Location where placeholder occurs (file path, section anchor, etc.) */
  location?: string;

  /** Reason for placeholder */
  reason: PlaceholderReason;

  /** Budget information if applicable */
  budget?: {
    /** Tokens remaining when placeholder was created */
    tokens_remaining: number;
    /** Hard token cap */
    hard_cap: number;
  };

  /** Impact on acceptance criteria */
  impact: PlaceholderImpact;

  /** Acceptance criterion ID if placeholder affects specific criterion */
  required_by?: string | null;

  /** Fallback that preserves acceptance (e.g., "3 bullets summarizing missing case study") */
  fallback: string;

  /** Debt note describing what needs to be completed */
  debt_note?: string;

  /** Expiry date for placeholder (ISO 8601) */
  expiry?: string;
}

/**
 * Telemetry information for agent execution
 */
export interface AgentTelemetry {
  /** Tokens used in generation */
  tokens_used?: number;

  /** Token cap/budget */
  tokens_cap?: number;

  /** Elapsed time in milliseconds */
  elapsed_ms?: number;

  /** Confidence score (0-1) */
  confidence?: number;

  /** Section-level token attribution */
  section_tokens?: Record<string, number>;
}

/**
 * Agent output envelope with placeholder governance
 * Wraps agent outputs with explicit degradation declarations
 */
export interface AgentEnvelope<T = unknown> {
  /** Status: ok (no degradations) or degraded (placeholders present) */
  status: 'ok' | 'degraded';

  /** Result payload */
  result: {
    /** Type of result */
    type: ResultType;
    /** Result value */
    value: T;
  };

  /** Placeholder degradations (only present if status='degraded') */
  placeholders?: Placeholder[];

  /** Telemetry information */
  telemetry?: AgentTelemetry;
}

/**
 * Placeholder validation result
 */
export interface PlaceholderValidationResult {
  /** Whether validation passed */
  passed: boolean;

  /** Gate that was checked */
  gate: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';

  /** Gate name */
  gateName: string;

  /** Validation message */
  message: string;

  /** Violations found */
  violations?: PlaceholderViolation[];

  /** Warnings */
  warnings?: string[];
}

/**
 * Placeholder violation details
 */
export interface PlaceholderViolation {
  /** Placeholder ID or location */
  id?: string;

  /** Violation type */
  type: string;

  /** Violation message */
  message: string;

  /** Location of violation */
  location?: string;

  /** Severity */
  severity: 'error' | 'warning';
}

/**
 * Placeholder debt score calculation
 */
export interface PlaceholderDebtScore {
  /** Total debt score */
  total: number;

  /** Score breakdown by impact level */
  byImpact: {
    non_blocking: number;
    partial: number;
    blocks_acceptance: number;
  };

  /** Number of placeholders */
  count: number;

  /** Placeholders exceeding thresholds */
  violations: PlaceholderViolation[];
}

/**
 * Placeholder governance configuration
 */
export interface PlaceholderGovernanceConfig {
  /** Maximum placeholders per artifact */
  maxPlaceholdersPerArtifact: {
    doc: number;
    code: number;
    json: number;
    plan: number;
    test: number;
    config: number;
  };

  /** Maximum total debt score */
  maxDebtScore: number;

  /** Impact weights for debt calculation */
  impactWeights: {
    non_blocking: number;
    partial: number;
    blocks_acceptance: number;
  };

  /** Whether to allow placeholders in Tier 1 */
  allowTier1Placeholders: boolean;

  /** Non-degradable scopes (never allow placeholders) */
  nonDegradableScopes: PlaceholderScope[];

  /** Required fields for placeholders */
  requiredPlaceholderFields: (keyof Placeholder)[];
}

