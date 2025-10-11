/**
 * @fileoverview CAWS Validation Type Definitions
 * Core types for CAWS constitutional authority validation
 * Ported from agent-agency implementation
 * @author @darianrosebrook
 */

/**
 * Result of CAWS validation process
 * Represents complete verdict from constitutional authority
 */
export interface CAWSValidationResult {
  /** Whether validation passed */
  passed: boolean;

  /** CAWS version used for validation */
  cawsVersion: string;

  /** ISO timestamp of validation */
  timestamp: string;

  /** Budget compliance check results */
  budgetCompliance: BudgetCompliance;

  /** Quality gate execution results */
  qualityGates: QualityGateResult[];

  /** Applied waivers */
  waivers: WaiverApplication[];

  /** Final verdict determination */
  verdict: 'pass' | 'fail' | 'waiver-required';

  /** Remediation steps if validation failed */
  remediation?: string[];

  /** Cryptographic signature of verdict (for immutability) */
  signature?: string;

  /** Additional metadata */
  metadata?: ValidationMetadata;
}

/**
 * Budget compliance check result
 */
export interface BudgetCompliance {
  /** Whether current changes comply with budget */
  compliant: boolean;

  /** Baseline budget from policy.yaml */
  baseline: BudgetLimits;

  /** Effective budget after applying waivers */
  effective: BudgetLimits;

  /** Current change statistics */
  current: ChangeStats;

  /** Budget violations if any */
  violations: BudgetViolation[];

  /** Waivers that were applied */
  waiversApplied: string[];
}

/**
 * Budget limits (max files and lines of code)
 */
export interface BudgetLimits {
  /** Maximum number of files that can be changed */
  max_files: number;

  /** Maximum lines of code that can be changed */
  max_loc: number;
}

/**
 * Current change statistics
 */
export interface ChangeStats {
  /** Number of files changed */
  filesChanged: number;

  /** Total lines changed (insertions + deletions) */
  linesChanged: number;

  /** Line insertions */
  insertions?: number;

  /** Line deletions */
  deletions?: number;

  /** Modified files list */
  modifiedFiles?: string[];
}

/**
 * Budget violation details
 */
export interface BudgetViolation {
  /** Quality gate that was violated */
  gate: string;

  /** Type of violation */
  type: 'max_files' | 'max_loc';

  /** Current value */
  current: number;

  /** Limit that was exceeded */
  limit: number;

  /** Baseline limit before waivers */
  baseline: number;

  /** Human-readable violation message */
  message: string;
}

/**
 * Quality gate execution result
 */
export interface QualityGateResult {
  /** Name of the quality gate */
  gate: string;

  /** Whether gate passed */
  passed: boolean;

  /** Actual score/value (e.g., coverage percentage) */
  score?: number;

  /** Required threshold */
  threshold?: number;

  /** Human-readable message */
  message: string;

  /** Supporting evidence/data */
  evidence?: unknown;

  /** Execution time in milliseconds */
  executionTime?: number;

  /** Error details if gate failed to execute */
  error?: string;
}

/**
 * Waiver application details
 */
export interface WaiverApplication {
  /** Waiver ID (e.g., WV-0001) */
  id: string;

  /** Gates/requirements waived */
  gates: string[];

  /** Waiver status */
  status: 'active' | 'expired' | 'revoked';

  /** Expiration date */
  expiresAt: string;

  /** Approver information */
  approvedBy: string;

  /** Reason for waiver */
  reason: string;

  /** Budget delta provided by waiver */
  delta?: {
    max_files?: number;
    max_loc?: number;
  };
}

/**
 * Validation metadata
 */
export interface ValidationMetadata {
  /** Working spec ID being validated */
  specId: string;

  /** Risk tier of the change */
  riskTier: number;

  /** Development mode */
  mode: string;

  /** Duration of validation in milliseconds */
  durationMs: number;

  /** Validation environment */
  environment?: string;

  /** Git commit hash at validation time */
  commitHash?: string;
}

/**
 * Spec validation result
 */
export interface SpecValidationResult {
  /** Whether spec structure is valid */
  valid: boolean;

  /** Validation errors */
  errors: ValidationError[];

  /** Validation warnings */
  warnings: ValidationWarning[];

  /** Auto-fix suggestions */
  fixes?: AutoFix[];
}

/**
 * Validation error details
 */
export interface ValidationError {
  /** Field path that has error */
  field: string;

  /** Error message */
  message: string;

  /** Suggestion for fixing */
  suggestion?: string;

  /** Whether error can be auto-fixed */
  canAutoFix?: boolean;
}

/**
 * Validation warning details
 */
export interface ValidationWarning {
  /** Field path that has warning */
  field: string;

  /** Warning message */
  message: string;

  /** Suggestion for improvement */
  suggestion?: string;
}

/**
 * Auto-fix suggestion
 */
export interface AutoFix {
  /** Field to fix */
  field: string;

  /** Suggested value */
  value: unknown;

  /** Description of fix */
  description: string;
}

/**
 * Derived budget with baseline and effective limits
 */
export interface DerivedBudget {
  /** Baseline budget from policy */
  baseline: BudgetLimits;

  /** Effective budget after waivers */
  effective: BudgetLimits;

  /** Waiver IDs that were applied */
  waiversApplied: string[];

  /** ISO timestamp when budget was derived */
  derivedAt: string;
}

/**
 * Waiver document structure
 */
export interface WaiverDocument {
  /** Waiver ID */
  id: string;

  /** Title/summary */
  title: string;

  /** Detailed reason */
  reason: string;

  /** Waiver status */
  status: 'active' | 'expired' | 'revoked';

  /** Gates being waived */
  gates: string[];

  /** Expiration date */
  expires_at: string;

  /** Approvers list */
  approvers: string[];

  /** Impact level */
  impact_level: 'low' | 'medium' | 'high' | 'critical';

  /** Mitigation plan */
  mitigation_plan: string;

  /** Budget delta */
  delta?: {
    max_files?: number;
    max_loc?: number;
  };

  /** Creation timestamp */
  created_at: string;

  /** Creator */
  created_by: string;
}

/**
 * Validation options
 */
export interface ValidationOptions {
  /** Skip spec structure validation */
  skipSpecValidation?: boolean;

  /** Dry run (don't publish verdict) */
  dryRun?: boolean;

  /** Auto-fix validation errors */
  autoFix?: boolean;

  /** Check budget compliance */
  checkBudget?: boolean;

  /** Execute quality gates */
  executeGates?: boolean;

  /** Project root directory */
  projectRoot?: string;

  /** Quiet mode (minimal output) */
  quiet?: boolean;
}

/**
 * Verdict publication result
 */
export interface VerdictPublicationResult {
  /** Whether verdict was published successfully */
  published: boolean;

  /** Path to verdict file */
  verdictPath?: string;

  /** Git commit hash */
  commitHash?: string;

  /** Cryptographic signature */
  signature?: string;

  /** Provenance entry */
  provenanceEntry?: ProvenanceEntry;

  /** Error message if publication failed */
  error?: string;
}

/**
 * Provenance entry for audit trail
 */
export interface ProvenanceEntry {
  /** Entry ID */
  id: string;

  /** Entry type */
  type: 'validation' | 'verdict' | 'waiver';

  /** ISO timestamp */
  timestamp: string;

  /** Working spec ID */
  specId: string;

  /** Verdict outcome */
  verdict: 'pass' | 'fail' | 'waiver-required';

  /** Git commit hash */
  commitHash?: string;

  /** Actor (human or AI) */
  actor: string;

  /** Additional metadata */
  metadata: Record<string, unknown>;
}

/**
 * Quality gate requirement
 */
export interface GateRequirement {
  /** Required threshold/limit */
  threshold?: number;

  /** Whether requirement is enforced */
  required: boolean;

  /** Additional options */
  options?: Record<string, unknown>;
}

/**
 * Coverage report structure (from Jest/Istanbul)
 */
export interface CoverageReport {
  total: {
    lines: { pct: number };
    statements: { pct: number };
    functions: { pct: number };
    branches: { pct: number };
  };
}

/**
 * Mutation report structure (from Stryker)
 */
export interface MutationReport {
  mutationScore: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  runtimeErrors: number;
}

/**
 * CAWS validation error (thrown during validation)
 */
export class CAWSValidationError extends Error {
  constructor(
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'CAWSValidationError';
  }
}

/**
 * Budget utilization metrics
 */
export interface BudgetUtilization {
  /** File budget utilization percentage (0-100) */
  files: number;

  /** LOC budget utilization percentage (0-100) */
  loc: number;

  /** Overall utilization (max of files and loc) */
  overall: number;
}
