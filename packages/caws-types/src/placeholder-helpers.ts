/**
 * @fileoverview Placeholder Governance Helper Functions
 * Utility functions for validating and managing placeholder degradations
 * @author @darianrosebrook
 */

import type {
  AgentEnvelope,
  Placeholder,
  PlaceholderImpact,
  PlaceholderValidationResult,
  PlaceholderViolation,
  PlaceholderDebtScore,
  PlaceholderGovernanceConfig,
} from './placeholder-types';

/**
 * Default placeholder governance configuration
 */
export const DEFAULT_PLACEHOLDER_CONFIG: PlaceholderGovernanceConfig = {
  maxPlaceholdersPerArtifact: {
    doc: 2,
    code: 1,
    json: 1,
    plan: 2,
    test: 1,
    config: 0,
  },
  maxDebtScore: 10,
  impactWeights: {
    non_blocking: 1,
    partial: 3,
    blocks_acceptance: 10,
  },
  allowTier1Placeholders: false,
  nonDegradableScopes: ['code_region', 'implementation'],
  requiredPlaceholderFields: ['id', 'scope', 'reason', 'impact', 'fallback'],
};

/**
 * Assert that no blocking placeholders exist in envelope
 * Throws error if any placeholder has impact='blocks_acceptance'
 * @param env Agent envelope to check
 * @throws Error if blocking placeholders found
 */
export function assertNoBlockingPlaceholders(env: AgentEnvelope): void {
  const blocking = (env.placeholders ?? []).filter(
    (p) => p.impact === 'blocks_acceptance'
  );
  if (blocking.length > 0) {
    throw new Error(
      `Blocking placeholders found: ${blocking.map((p) => p.scope).join(', ')}`
    );
  }
}

/**
 * Calculate debt score for placeholders
 * @param placeholders Array of placeholders
 * @param config Governance configuration
 * @returns Debt score calculation
 */
export function calculateDebtScore(
  placeholders: Placeholder[],
  config: PlaceholderGovernanceConfig = DEFAULT_PLACEHOLDER_CONFIG
): PlaceholderDebtScore {
  const byImpact = {
    non_blocking: 0,
    partial: 0,
    blocks_acceptance: 0,
  };

  let total = 0;
  const violations: PlaceholderViolation[] = [];

  for (const placeholder of placeholders) {
    const weight = config.impactWeights[placeholder.impact];
    byImpact[placeholder.impact] += weight;
    total += weight;

    // Check if exceeds threshold
    if (placeholder.impact === 'blocks_acceptance') {
      violations.push({
        id: placeholder.id,
        type: 'blocking_placeholder',
        message: `Placeholder ${placeholder.id} blocks acceptance criteria`,
        location: placeholder.location,
        severity: 'error',
      });
    }
  }

  // Check total debt score
  if (total > config.maxDebtScore) {
    violations.push({
      type: 'debt_score_exceeded',
      message: `Total debt score ${total} exceeds maximum ${config.maxDebtScore}`,
      severity: 'error',
    });
  }

  return {
    total,
    byImpact,
    count: placeholders.length,
    violations,
  };
}

/**
 * Validate placeholder structure (Gate P0 - Schema validity)
 * Ensures placeholder has all required fields and valid values
 * @param placeholder Placeholder to validate
 * @returns Validation result
 */
export function validatePlaceholderSchema(
  placeholder: Placeholder
): PlaceholderValidationResult {
  const violations: PlaceholderViolation[] = [];

  // Check required fields
  const requiredFields: (keyof Placeholder)[] = [
    'id',
    'scope',
    'reason',
    'impact',
    'fallback',
  ];

  for (const field of requiredFields) {
    if (!placeholder[field]) {
      violations.push({
        id: placeholder.id,
        type: 'missing_required_field',
        message: `Placeholder missing required field: ${field}`,
        severity: 'error',
      });
    }
  }

  // Validate impact value
  const validImpacts: PlaceholderImpact[] = [
    'non_blocking',
    'partial',
    'blocks_acceptance',
  ];
  if (placeholder.impact && !validImpacts.includes(placeholder.impact)) {
    violations.push({
      id: placeholder.id,
      type: 'invalid_impact',
      message: `Invalid impact value: ${placeholder.impact}`,
      severity: 'error',
    });
  }

  // Validate reason value
  const validReasons = [
    'token_budget',
    'dependency_missing',
    'timebox',
    'redaction',
    'non_critical_expansion',
  ];
  if (placeholder.reason && !validReasons.includes(placeholder.reason)) {
    violations.push({
      id: placeholder.id,
      type: 'invalid_reason',
      message: `Invalid reason value: ${placeholder.reason}`,
      severity: 'error',
    });
  }

  return {
    passed: violations.length === 0,
    gate: 'P0',
    gateName: 'Schema Validity',
    message:
      violations.length === 0
        ? 'Placeholder schema is valid'
        : `Schema validation failed: ${violations.length} violations`,
    violations,
  };
}

/**
 * Validate placeholder registry (Gate P1)
 * Ensures status='degraded' if placeholders exist and no blocking placeholders
 * @param env Agent envelope to validate
 * @returns Validation result
 */
export function validatePlaceholderRegistry(
  env: AgentEnvelope
): PlaceholderValidationResult {
  const violations: PlaceholderViolation[] = [];
  const warnings: string[] = [];

  const hasPlaceholders = (env.placeholders ?? []).length > 0;

  // P1.1: If placeholders exist, status must be 'degraded'
  if (hasPlaceholders && env.status !== 'degraded') {
    violations.push({
      type: 'status_mismatch',
      message:
        'Placeholders exist but status is not "degraded". Status must be "degraded" when placeholders are present.',
      severity: 'error',
    });
  }

  // P1.2: No blocking placeholders allowed
  const blocking = (env.placeholders ?? []).filter(
    (p) => p.impact === 'blocks_acceptance'
  );
  if (blocking.length > 0) {
    violations.push({
      type: 'blocking_placeholders',
      message: `Found ${blocking.length} placeholder(s) that block acceptance criteria`,
      severity: 'error',
    });
  }

  // P1.3: If status is 'degraded', placeholders array must exist
  if (env.status === 'degraded' && !hasPlaceholders) {
    violations.push({
      type: 'missing_placeholders',
      message:
        'Status is "degraded" but no placeholders array provided. Degraded status requires explicit placeholder declarations.',
      severity: 'error',
    });
  }

  return {
    passed: violations.length === 0,
    gate: 'P1',
    gateName: 'Placeholder Registry',
    message:
      violations.length === 0
        ? 'Placeholder registry is valid'
        : `Registry validation failed: ${violations.length} violations`,
    violations,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validate debt budget (Gate P2)
 * Checks placeholder count and debt score against limits
 * @param env Agent envelope to validate
 * @param config Governance configuration
 * @returns Validation result
 */
export function validateDebtBudget(
  env: AgentEnvelope,
  config: PlaceholderGovernanceConfig = DEFAULT_PLACEHOLDER_CONFIG
): PlaceholderValidationResult {
  const violations: PlaceholderViolation[] = [];
  const placeholders = env.placeholders ?? [];

  if (placeholders.length === 0) {
    return {
      passed: true,
      gate: 'P2',
      gateName: 'Debt Budget',
      message: 'No placeholders to validate',
    };
  }

  // Check per-artifact limits
  const resultType = env.result.type;
  const maxForType =
    config.maxPlaceholdersPerArtifact[
      resultType as keyof typeof config.maxPlaceholdersPerArtifact
    ] ?? 1;

  if (placeholders.length > maxForType) {
    violations.push({
      type: 'placeholder_count_exceeded',
      message: `Found ${placeholders.length} placeholders, maximum allowed for ${resultType} is ${maxForType}`,
      severity: 'error',
    });
  }

  // Calculate debt score
  const debtScore = calculateDebtScore(placeholders, config);
  if (debtScore.total > config.maxDebtScore) {
    violations.push({
      type: 'debt_score_exceeded',
      message: `Debt score ${debtScore.total} exceeds maximum ${config.maxDebtScore}`,
      severity: 'error',
    });
  }

  // Add debt score violations
  violations.push(...debtScore.violations);

  return {
    passed: violations.length === 0,
    gate: 'P2',
    gateName: 'Debt Budget',
    message:
      violations.length === 0
        ? `Debt budget valid (score: ${debtScore.total}/${config.maxDebtScore})`
        : `Debt budget exceeded: ${violations.length} violations`,
    violations,
  };
}

/**
 * Validate no dangling promises (Gate P3)
 * Checks for TODO/TBD/later references without matching placeholder entries
 * @param content Text content to check
 * @param placeholders Array of declared placeholders
 * @returns Validation result
 */
export function validateNoDanglingPromises(
  content: string,
  placeholders: Placeholder[]
): PlaceholderValidationResult {
  const violations: PlaceholderViolation[] = [];
  const warnings: string[] = [];

  // Patterns that indicate dangling promises
  const danglingPatterns = [
    /\bTODO\b/gi,
    /\bTBD\b/gi,
    /\blater\b/gi,
    /\bsee above\b/gi,
    /\bcoming soon\b/gi,
    /\bwill be implemented\b/gi,
    /\bto be added\b/gi,
  ];

  // Extract placeholder IDs and debt notes for matching
  const placeholderIds = new Set(placeholders.map((p) => p.id));
  const debtNotes = placeholders.map((p) => p.debt_note ?? '').join(' ');

  for (const pattern of danglingPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const matchText = match[0];
      const matchIndex = match.index ?? 0;

      // Check if this matches a placeholder debt note
      const matchesDebtNote = debtNotes.includes(matchText);

      // Check if this is near a placeholder ID reference
      const contextStart = Math.max(0, matchIndex - 50);
      const contextEnd = Math.min(content.length, matchIndex + 50);
      const context = content.substring(contextStart, contextEnd);
      const hasPlaceholderRef = Array.from(placeholderIds).some((id) =>
        context.includes(id)
      );

      if (!matchesDebtNote && !hasPlaceholderRef) {
        violations.push({
          type: 'dangling_promise',
          message: `Found "${matchText}" without matching placeholder entry`,
          location: `Character ${matchIndex}`,
          severity: 'error',
        });
      }
    }
  }

  return {
    passed: violations.length === 0,
    gate: 'P3',
    gateName: 'No Dangling Promises',
    message:
      violations.length === 0
        ? 'No dangling promises found'
        : `Found ${violations.length} dangling promise(s) without placeholder entries`,
    violations,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Validate non-degradable scopes (Gate P4)
 * Ensures critical sections never have placeholders
 * @param env Agent envelope to validate
 * @param config Governance configuration
 * @returns Validation result
 */
export function validateNonDegradableScopes(
  env: AgentEnvelope,
  config: PlaceholderGovernanceConfig = DEFAULT_PLACEHOLDER_CONFIG
): PlaceholderValidationResult {
  const violations: PlaceholderViolation[] = [];
  const placeholders = env.placeholders ?? [];

  for (const placeholder of placeholders) {
    if (config.nonDegradableScopes.includes(placeholder.scope)) {
      violations.push({
        id: placeholder.id,
        type: 'non_degradable_scope',
        message: `Placeholder ${placeholder.id} in non-degradable scope: ${placeholder.scope}`,
        location: placeholder.location,
        severity: 'error',
      });
    }
  }

  return {
    passed: violations.length === 0,
    gate: 'P4',
    gateName: 'Non-Degradable Scopes',
    message:
      violations.length === 0
        ? 'No placeholders in non-degradable scopes'
        : `Found ${violations.length} placeholder(s) in non-degradable scopes`,
    violations,
  };
}

/**
 * Run all placeholder validation gates
 * @param env Agent envelope to validate
 * @param content Optional content string for P3 validation
 * @param config Governance configuration
 * @returns Array of validation results
 */
export function validatePlaceholderGovernance(
  env: AgentEnvelope,
  content?: string,
  config: PlaceholderGovernanceConfig = DEFAULT_PLACEHOLDER_CONFIG
): PlaceholderValidationResult[] {
  const results: PlaceholderValidationResult[] = [];

  // P0: Schema validity (validate each placeholder)
  if (env.placeholders) {
    for (const placeholder of env.placeholders) {
      results.push(validatePlaceholderSchema(placeholder));
    }
  }

  // P1: Placeholder registry
  results.push(validatePlaceholderRegistry(env));

  // P2: Debt budget
  results.push(validateDebtBudget(env, config));

  // P3: No dangling promises (if content provided)
  if (content && env.placeholders) {
    results.push(validateNoDanglingPromises(content, env.placeholders));
  }

  // P4: Non-degradable scopes
  results.push(validateNonDegradableScopes(env, config));

  return results;
}

/**
 * Check if envelope passes all placeholder gates
 * @param env Agent envelope to check
 * @param content Optional content string
 * @param config Governance configuration
 * @returns True if all gates pass
 */
export function passesPlaceholderGovernance(
  env: AgentEnvelope,
  content?: string,
  config: PlaceholderGovernanceConfig = DEFAULT_PLACEHOLDER_CONFIG
): boolean {
  const results = validatePlaceholderGovernance(env, content, config);
  return results.every((r) => r.passed);
}

/**
 * Generate placeholder ID with timestamp
 * @param prefix Optional prefix (default: 'PH')
 * @returns Placeholder ID
 */
export function generatePlaceholderId(prefix: string = 'PH'): string {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  const timeStr = now.toTimeString().split(' ')[0].replace(/:/g, '').substring(0, 4);
  const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${dateStr}-${timeStr}-${random}`;
}

