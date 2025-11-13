#!/usr/bin/env node

/**
 * Quality Gate: Placeholder Governance
 *
 * Enforces "no-surprises" contract for agent outputs with explicit placeholder degradations.
 * Validates that placeholders are declared, scoped, justified, and paired with fallbacks.
 *
 * Gates:
 * - P0: Schema validity (placeholder structure)
 * - P1: Placeholder registry (status matches placeholders, no blocking)
 * - P2: Debt budget (count and score limits)
 * - P3: No dangling promises (TODO/TBD without placeholders)
 * - P4: Non-degradable scopes (critical sections never degraded)
 *
 * @author: @darianrosebrook
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getFilesToCheck } from './file-scope-manager.mjs';
import {
  getEnforcementLevel as getGlobalEnforcementLevel,
  processViolations,
} from './shared-exception-framework.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Default placeholder governance configuration
 */
const DEFAULT_CONFIG = {
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
 * Patterns that indicate dangling promises
 */
const DANGLING_PATTERNS = [
  { pattern: /\bTODO\b/gi, name: 'TODO' },
  { pattern: /\bTBD\b/gi, name: 'TBD' },
  { pattern: /\blater\b/gi, name: 'later' },
  { pattern: /\bsee above\b/gi, name: 'see above' },
  { pattern: /\bcoming soon\b/gi, name: 'coming soon' },
  { pattern: /\bwill be implemented\b/gi, name: 'will be implemented' },
  { pattern: /\bto be added\b/gi, name: 'to be added' },
];

/**
 * Extract placeholder declarations from content
 * Looks for JSON envelope format or Degradations section
 */
function extractPlaceholders(content, filePath) {
  const placeholders = [];

  // Try to parse as JSON envelope
  try {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[1]);
      if (parsed.placeholders && Array.isArray(parsed.placeholders)) {
        return parsed.placeholders;
      }
    }
  } catch (e) {
    // Not JSON, continue with text parsing
  }

  // Try to find Degradations section
  const degradationsMatch = content.match(/##?\s*Degradations?\s*\n([\s\S]*?)(?=\n##|\n---|$)/);
  if (degradationsMatch) {
    const degradationsText = degradationsMatch[1];
    // Parse bullet points with placeholder IDs
    const bulletPattern = /[-*]\s*\[([^\]]+)\]\s*(.+)/g;
    let match;
    while ((match = bulletPattern.exec(degradationsText)) !== null) {
      const [, scope, description] = match;
      placeholders.push({
        id: `PH-${Date.now()}-${placeholders.length}`,
        scope: scope.trim(),
        location: filePath,
        fallback: description.trim(),
      });
    }
  }

  return placeholders;
}

/**
 * Validate placeholder schema (Gate P0)
 */
function validatePlaceholderSchema(placeholder, filePath) {
  const violations = [];
  const requiredFields = ['id', 'scope', 'reason', 'impact', 'fallback'];

  for (const field of requiredFields) {
    if (!placeholder[field]) {
      violations.push({
        gate: 'placeholders',
        type: 'missing_required_field',
        message: `Placeholder missing required field: ${field}`,
        file: filePath,
        severity: 'block',
        suggestion: `Add ${field} field to placeholder declaration`,
      });
    }
  }

  // Validate impact value
  const validImpacts = ['non_blocking', 'partial', 'blocks_acceptance'];
  if (placeholder.impact && !validImpacts.includes(placeholder.impact)) {
    violations.push({
      gate: 'placeholders',
      type: 'invalid_impact',
      message: `Invalid impact value: ${placeholder.impact}`,
      file: filePath,
      severity: 'block',
      suggestion: `Use one of: ${validImpacts.join(', ')}`,
    });
  }

  return violations;
}

/**
 * Check for dangling promises (Gate P3)
 */
function checkDanglingPromises(content, filePath, declaredPlaceholders) {
  const violations = [];
  const placeholderIds = new Set(declaredPlaceholders.map((p) => p.id || '').filter(Boolean));
  const debtNotes = declaredPlaceholders
    .map((p) => p.debt_note || '')
    .join(' ')
    .toLowerCase();

  for (const { pattern, name } of DANGLING_PATTERNS) {
    const matches = [...content.matchAll(pattern)];
    for (const match of matches) {
      const matchText = match[0];
      const matchIndex = match.index ?? 0;
      const lineNumber = content.substring(0, matchIndex).split('\n').length;

      // Check if this matches a placeholder debt note
      const matchesDebtNote = debtNotes.includes(matchText.toLowerCase());

      // Check if this is near a placeholder ID reference
      const contextStart = Math.max(0, matchIndex - 100);
      const contextEnd = Math.min(content.length, matchIndex + 100);
      const context = content.substring(contextStart, contextEnd);
      const hasPlaceholderRef = Array.from(placeholderIds).some((id) => context.includes(id));

      if (!matchesDebtNote && !hasPlaceholderRef) {
        violations.push({
          gate: 'placeholders',
          type: 'dangling_promise',
          message: `Found "${matchText}" without matching placeholder entry`,
          file: filePath,
          line: lineNumber,
          severity: 'block',
          suggestion: 'Either add a placeholder entry for this degradation or remove the promise',
        });
      }
    }
  }

  return violations;
}

/**
 * Check for placeholders in non-degradable scopes (Gate P4)
 */
function checkNonDegradableScopes(placeholders, filePath, config) {
  const violations = [];

  for (const placeholder of placeholders) {
    if (config.nonDegradableScopes.includes(placeholder.scope)) {
      violations.push({
        gate: 'placeholders',
        type: 'non_degradable_scope',
        message: `Placeholder ${placeholder.id} in non-degradable scope: ${placeholder.scope}`,
        file: filePath,
        location: placeholder.location,
        severity: 'block',
        suggestion: `Remove placeholder or change scope (non-degradable: ${config.nonDegradableScopes.join(', ')})`,
      });
    }
  }

  return violations;
}

/**
 * Calculate debt score
 */
function calculateDebtScore(placeholders, config) {
  let total = 0;
  const byImpact = {
    non_blocking: 0,
    partial: 0,
    blocks_acceptance: 0,
  };

  for (const placeholder of placeholders) {
    const weight = config.impactWeights[placeholder.impact] || 1;
    byImpact[placeholder.impact] += weight;
    total += weight;
  }

  return { total, byImpact };
}

/**
 * Check debt budget (Gate P2)
 */
function checkDebtBudget(placeholders, filePath, resultType, config) {
  const violations = [];

  if (placeholders.length === 0) {
    return violations;
  }

  // Check per-artifact limits
  const maxForType =
    config.maxPlaceholdersPerArtifact[resultType] ?? config.maxPlaceholdersPerArtifact.doc;

  if (placeholders.length > maxForType) {
    violations.push({
      gate: 'placeholders',
      type: 'placeholder_count_exceeded',
      message: `Found ${placeholders.length} placeholders, maximum allowed for ${resultType} is ${maxForType}`,
      file: filePath,
      severity: 'block',
      suggestion: `Reduce placeholder count to ${maxForType} or fewer`,
    });
  }

  // Check debt score
  const debtScore = calculateDebtScore(placeholders, config);
  if (debtScore.total > config.maxDebtScore) {
    violations.push({
      gate: 'placeholders',
      type: 'debt_score_exceeded',
      message: `Debt score ${debtScore.total} exceeds maximum ${config.maxDebtScore}`,
      file: filePath,
      severity: 'block',
      suggestion: `Reduce debt score by removing or reducing impact of placeholders`,
    });
  }

  // Check for blocking placeholders
  const blocking = placeholders.filter((p) => p.impact === 'blocks_acceptance');
  if (blocking.length > 0) {
    violations.push({
      gate: 'placeholders',
      type: 'blocking_placeholders',
      message: `Found ${blocking.length} placeholder(s) that block acceptance criteria`,
      file: filePath,
      severity: 'block',
      suggestion: 'Remove blocking placeholders or change impact to "partial" or "non_blocking"',
    });
  }

  return violations;
}

/**
 * Detect result type from file extension
 */
function detectResultType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.md', '.txt', '.rst'].includes(ext)) return 'doc';
  if (['.ts', '.tsx', '.js', '.jsx', '.rs', '.py', '.go'].includes(ext)) return 'code';
  if (['.json', '.yaml', '.yml'].includes(ext)) return 'json';
  if (filePath.includes('test') || filePath.includes('spec')) return 'test';
  return 'doc';
}

/**
 * Main placeholder validation function
 */
export async function checkPlaceholders(options = {}) {
  const { files = [], config = DEFAULT_CONFIG, enforcement } = options;

  const effectiveEnforcement = enforcement ?? getGlobalEnforcementLevel('placeholders');

  const violations = [];
  const filesToCheck = files.length > 0 ? files : await getFilesToCheck();

  for (const filePath of filesToCheck) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const resultType = detectResultType(filePath);

      // Extract placeholders from content
      const placeholders = extractPlaceholders(content, filePath);

      // P0: Schema validity
      for (const placeholder of placeholders) {
        violations.push(...validatePlaceholderSchema(placeholder, filePath));
      }

      // P1: Placeholder registry (check status if JSON envelope)
      try {
        const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[1]);
          if (parsed.status === 'degraded' && placeholders.length === 0) {
            violations.push({
              gate: 'placeholders',
              type: 'status_mismatch',
              message: 'Status is "degraded" but no placeholders array provided',
              file: filePath,
              severity: 'block',
              suggestion: 'Add placeholders array or change status to "ok"',
            });
          }
          if (parsed.status === 'ok' && placeholders.length > 0) {
            violations.push({
              gate: 'placeholders',
              type: 'status_mismatch',
              message: 'Placeholders exist but status is not "degraded"',
              file: filePath,
              severity: 'block',
              suggestion: 'Change status to "degraded" when placeholders are present',
            });
          }
        }
      } catch (e) {
        // Not JSON, skip P1 check
      }

      // P2: Debt budget
      violations.push(...checkDebtBudget(placeholders, filePath, resultType, config));

      // P3: No dangling promises
      violations.push(...checkDanglingPromises(content, filePath, placeholders));

      // P4: Non-degradable scopes
      violations.push(...checkNonDegradableScopes(placeholders, filePath, config));
    } catch (error) {
      violations.push({
        gate: 'placeholders',
        type: 'gate_error',
        message: `Error checking placeholders in ${filePath}: ${error.message}`,
        file: filePath,
        severity: 'warning',
      });
    }
  }

  return processViolations('placeholders', violations, undefined, {
    enforcement: effectiveEnforcement,
    maxViolations: 5000, // Performance limit for large codebases
  });
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  checkPlaceholders()
    .then((result) => {
      if (result.violations.length > 0) {
        console.error(`Found ${result.violations.length} placeholder violation(s)`);
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error('Placeholder gate error:', error);
      process.exit(1);
    });
}
