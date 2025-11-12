/**
 * @fileoverview Working Spec Validation Utilities
 * Functions for validating CAWS working specifications
 * @author @darianrosebrook
 */

const { deriveBudget, checkBudgetCompliance } = require('../budget-derivation');

/**
 * Basic validation of working spec
 * @param {Object} spec - Working spec object
 * @param {Object} options - Validation options
 * @returns {Object} Validation result
 */
const validateWorkingSpec = (spec, _options = {}) => {
  try {
    // Basic structural validation for essential fields
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'blast_radius',
      'operational_rollback_slo',
      'scope',
      'invariants',
      'acceptance',
      'non_functional',
      'contracts',
    ];

    // For new policy-based specs, change_budget is not required
    // It's derived from policy.yaml + waivers

    for (const field of requiredFields) {
      if (!spec[field]) {
        return {
          valid: false,
          errors: [
            {
              instancePath: `/${field}`,
              message: `Missing required field: ${field}`,
            },
          ],
        };
      }
    }

    // Validate specific field formats
    if (!/^[A-Z]+-\d+$/.test(spec.id)) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/id',
            message: 'Project ID should be in format: PREFIX-NUMBER (e.g., FEAT-1234)',
          },
        ],
      };
    }

    // Validate experimental mode
    if (spec.experimental_mode) {
      if (typeof spec.experimental_mode !== 'object') {
        return {
          valid: false,
          errors: [
            {
              instancePath: '/experimental_mode',
              message:
                'Experimental mode must be an object with enabled, rationale, and expires_at fields',
            },
          ],
        };
      }

      const requiredExpFields = ['enabled', 'rationale', 'expires_at'];
      for (const field of requiredExpFields) {
        if (!(field in spec.experimental_mode)) {
          return {
            valid: false,
            errors: [
              {
                instancePath: `/experimental_mode/${field}`,
                message: `Missing required experimental mode field: ${field}`,
              },
            ],
          };
        }
      }

      if (spec.experimental_mode.enabled && spec.risk_tier < 3) {
        return {
          valid: false,
          errors: [
            {
              instancePath: '/experimental_mode',
              message: 'Experimental mode can only be used with Tier 3 (low risk) changes',
            },
          ],
        };
      }
    }

    if (spec.risk_tier < 1 || spec.risk_tier > 3) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/risk_tier',
            message: 'Risk tier must be 1, 2, or 3',
          },
        ],
      };
    }

    if (!spec.scope || !spec.scope.in || spec.scope.in.length === 0) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/scope/in',
            message: 'Scope IN must not be empty',
          },
        ],
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '',
          message: `Validation error: ${error.message}`,
        },
      ],
    };
  }
};

/**
 * Enhanced validation with suggestions and auto-fix
 * @param {Object} spec - Working spec object
 * @param {Object} options - Validation options
 * @returns {Object} Enhanced validation result
 */
function validateWorkingSpecWithSuggestions(spec, options = {}) {
  const { autoFix = false, checkBudget = false, projectRoot } = options;

  try {
    // Basic structural validation for essential fields
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'blast_radius',
      'operational_rollback_slo',
      'scope',
      'invariants',
      'acceptance',
      'non_functional',
      'contracts',
    ];

    let errors = [];
    let warnings = [];
    let fixes = [];

    for (const field of requiredFields) {
      if (!spec[field]) {
        errors.push({
          instancePath: `/${field}`,
          message: `Missing required field: ${field}`,
          suggestion: getFieldSuggestion(field, spec),
          canAutoFix: canAutoFixField(field, spec),
        });
      }
    }

    // Validate specific field formats
    if (spec.id && !/^[A-Z]+-\d+$/.test(spec.id)) {
      errors.push({
        instancePath: '/id',
        message: 'Project ID should be in format: PREFIX-NUMBER (e.g., FEAT-1234)',
        suggestion: 'Use format like: PROJ-001, FEAT-002, FIX-003',
        canAutoFix: false,
      });
    }

    // Validate risk tier with enhanced auto-fix
    if (spec.risk_tier !== undefined && (spec.risk_tier < 1 || spec.risk_tier > 3)) {
      const fixedValue = Math.max(1, Math.min(3, spec.risk_tier || 2));
      errors.push({
        instancePath: '/risk_tier',
        message: 'Risk tier must be 1, 2, or 3',
        suggestion:
          'Tier 1: Critical (auth, billing), Tier 2: Standard (features), Tier 3: Low risk (UI)',
        canAutoFix: true,
      });
      fixes.push({
        field: 'risk_tier',
        value: fixedValue,
        description: `Clamping risk_tier from ${spec.risk_tier} to valid range [1-3]: ${fixedValue}`,
        reason: 'Risk tier out of bounds',
      });
    }

    // Auto-fix empty arrays with sensible defaults
    if (!spec.invariants || spec.invariants.length === 0) {
      if (autoFix) {
        fixes.push({
          field: 'invariants',
          value: ['System must remain operational during changes'],
          description: 'Adding default invariant for empty invariants array',
          reason: 'Invariants array was empty',
        });
      }
    }

    if (!spec.acceptance || spec.acceptance.length === 0) {
      if (autoFix) {
        fixes.push({
          field: 'acceptance',
          value: [
            {
              id: 'A1',
              given: 'the system is in a valid state',
              when: 'the change is applied',
              then: 'the system remains functional',
            },
          ],
          description: 'Adding placeholder acceptance criteria',
          reason: 'Acceptance criteria array was empty',
        });
      }
    }

    // Validate scope.out doesn't contain glob patterns
    if (spec.scope && spec.scope.out && Array.isArray(spec.scope.out)) {
      const globPatterns = spec.scope.out.filter(
        (pattern) => pattern.includes('*') || pattern.includes('?')
      );
      if (globPatterns.length > 0) {
        errors.push({
          instancePath: '/scope/out',
          message: `Unsupported glob patterns in scope.out: ${globPatterns.join(', ')}`,
          suggestion:
            'Use directory paths only (e.g., __pycache__/ instead of *.pyc or **/*.pyc). Python cache files are already covered by __pycache__/',
          canAutoFix: true,
        });

        // Auto-fix: remove glob patterns and keep only directory paths
        if (autoFix) {
          const fixedOut = spec.scope.out
            .filter((pattern) => !pattern.includes('*') && !pattern.includes('?'))
            .map((pattern) => {
              // Ensure directory paths end with /
              if (!pattern.includes('.') && !pattern.endsWith('/')) {
                return pattern + '/';
              }
              return pattern;
            });

          fixes.push({
            field: 'scope.out',
            value: fixedOut,
            description: `Removed glob patterns from scope.out: ${globPatterns.join(', ')}`,
            reason: 'Glob patterns are not supported in scope.out',
          });
        }
      }
    }

    // Auto-fix missing scope.out
    if (spec.scope && !spec.scope.out) {
      fixes.push({
        field: 'scope.out',
        value: ['node_modules/', 'dist/', '.git/'],
        description: 'Adding default exclusions to scope.out',
        reason: 'scope.out was missing',
      });
    }

    // Auto-fix missing mode
    if (!spec.mode) {
      fixes.push({
        field: 'mode',
        value: 'feature',
        description: 'Setting default mode to "feature"',
        reason: 'mode field was missing',
      });
    }

    // Auto-fix missing blast_radius
    if (!spec.blast_radius) {
      fixes.push({
        field: 'blast_radius',
        value: {
          modules: [],
          data_migration: false,
        },
        description: 'Adding empty blast_radius structure',
        reason: 'blast_radius was missing',
      });
    }

    // Auto-fix missing non_functional
    if (!spec.non_functional) {
      fixes.push({
        field: 'non_functional',
        value: {
          a11y: [],
          perf: {},
          security: [],
        },
        description: 'Adding empty non_functional requirements structure',
        reason: 'non_functional was missing',
      });
    }

    // Auto-fix missing contracts
    if (!spec.contracts) {
      fixes.push({
        field: 'contracts',
        value: [],
        description: 'Adding empty contracts array',
        reason: 'contracts field was missing',
      });
    }

    // Validate scope.in is not empty
    if (!spec.scope || !spec.scope.in || spec.scope.in.length === 0) {
      errors.push({
        instancePath: '/scope/in',
        message: 'Scope IN must not be empty',
        suggestion: 'Specify directories/files that are included in changes',
        canAutoFix: false,
      });
    }

    // Check for common issues
    if (!spec.invariants || spec.invariants.length === 0) {
      warnings.push({
        instancePath: '/invariants',
        message: 'No system invariants defined',
        suggestion: 'Add 1-3 statements about what must always remain true',
      });
    }

    if (!spec.acceptance || spec.acceptance.length === 0) {
      warnings.push({
        instancePath: '/acceptance',
        message: 'No acceptance criteria defined',
        suggestion: 'Add acceptance criteria in GIVEN/WHEN/THEN format',
      });
    }

    // Tier-specific validations
    if (spec.risk_tier === 1 || spec.risk_tier === 2) {
      if (!spec.contracts || spec.contracts.length === 0) {
        const isChoreMode = spec.mode === 'chore';
        const suggestion = isChoreMode
          ? 'For infrastructure/setup work, add a minimal project_setup contract or create a waiver'
          : 'Add API contracts (OpenAPI, GraphQL, etc.) or change mode to "chore" for maintenance work';

        errors.push({
          instancePath: '/contracts',
          message: `Contracts required for Tier ${spec.risk_tier} changes`,
          suggestion: suggestion,
          canAutoFix: false,
          example: isChoreMode
            ? {
                contracts: [
                  {
                    type: 'project_setup',
                    path: '.caws/working-spec.yaml',
                    description:
                      'Project-level CAWS configuration. Feature-specific contracts will be added as features are developed.',
                  },
                ],
              }
            : {
                contracts: [
                  {
                    type: 'openapi',
                    path: 'docs/api/feature.yaml',
                    version: '1.0.0',
                  },
                ],
              },
        });
      }
    }

    // Tier 1 specific requirements (critical changes)
    if (spec.risk_tier === 1) {
      if (!spec.observability) {
        errors.push({
          instancePath: '/observability',
          message: 'Observability required for Tier 1 changes',
          suggestion: 'Define logging, metrics, and tracing strategy',
          canAutoFix: false,
        });
      }

      if (!spec.rollback || spec.rollback.length === 0) {
        errors.push({
          instancePath: '/rollback',
          message: 'Rollback procedures required for Tier 1 changes',
          suggestion: 'Document rollback steps and data migration reversal',
          canAutoFix: false,
        });
      }

      if (
        !spec.non_functional ||
        !spec.non_functional.security ||
        spec.non_functional.security.length === 0
      ) {
        errors.push({
          instancePath: '/non_functional/security',
          message: 'Security requirements required for Tier 1 changes',
          suggestion: 'Define authentication, authorization, and data protection requirements',
          canAutoFix: false,
        });
      }
    }

    // Validate rollback format if present (for all tiers)
    if (spec.rollback !== undefined) {
      if (!Array.isArray(spec.rollback)) {
        errors.push({
          instancePath: '/rollback',
          message: 'rollback must be an array of strings',
          suggestion: 'Use format: ["Step 1", "Step 2", "Step 3"]',
          canAutoFix: false,
        });
      } else {
        // Check for duplicates
        const uniqueSteps = [...new Set(spec.rollback)];
        if (uniqueSteps.length !== spec.rollback.length) {
          warnings.push({
            instancePath: '/rollback',
            message: 'Duplicate entries found in rollback array',
            suggestion: 'Remove duplicate entries',
          });

          if (autoFix) {
            fixes.push({
              field: 'rollback',
              value: uniqueSteps,
              description: 'Removed duplicate rollback entries',
              reason: 'Duplicate entries detected',
            });
          }
        }

        // Validate each entry is a string
        const invalidEntries = spec.rollback.filter((entry) => typeof entry !== 'string');
        if (invalidEntries.length > 0) {
          errors.push({
            instancePath: '/rollback',
            message: `Invalid rollback entries (must be strings): ${invalidEntries.length}`,
            suggestion: 'All rollback entries must be string descriptions',
            canAutoFix: false,
          });
        }
      }
    }

    // Validate waiver_ids format if present
    if (spec.waiver_ids) {
      if (!Array.isArray(spec.waiver_ids)) {
        errors.push({
          instancePath: '/waiver_ids',
          message: 'waiver_ids must be an array of waiver IDs',
          suggestion: 'Use format: ["WV-0001", "WV-0002"]',
          canAutoFix: false,
        });
      } else {
        for (const waiverId of spec.waiver_ids) {
          if (!/^WV-\d{4}$/.test(waiverId)) {
            errors.push({
              instancePath: '/waiver_ids',
              message: `Invalid waiver ID format: ${waiverId}`,
              suggestion: 'Use format: WV-XXXX where XXXX is exactly 4 digits (e.g., WV-0001)',
              canAutoFix: false,
            });
          }
        }
      }
    }

    // Warn if change_budget is present (deprecated/informational only)
    if (spec.change_budget) {
      warnings.push({
        instancePath: '/change_budget',
        message:
          'change_budget field in working spec is informational only and not used for validation',
        suggestion:
          'Budget is derived from policy.yaml risk_tier + waivers. This field is auto-calculated.',
      });
    }

    // Derive and check budget if requested
    let budgetCheck = null;
    if (checkBudget && projectRoot) {
      try {
        const derivedBudget = deriveBudget(spec, projectRoot);

        // Mock current stats for now - in real implementation this would analyze git changes
        const mockStats = {
          files_changed: 50, // This would be calculated from actual changes
          lines_changed: 5000,
          risk_tier: spec.risk_tier,
        };

        budgetCheck = checkBudgetCompliance(derivedBudget, mockStats);

        if (!budgetCheck.compliant) {
          for (const violation of budgetCheck.violations) {
            errors.push({
              instancePath: '/budget',
              message: violation.message,
              suggestion: 'Create a waiver or reduce scope to fit within budget',
              canAutoFix: false,
            });
          }

          // Suggest adding waiver_ids if budget exceeded and none referenced
          if (!spec.waiver_ids || spec.waiver_ids.length === 0) {
            warnings.push({
              instancePath: '/waiver_ids',
              message: 'Budget exceeded but no waivers referenced',
              suggestion:
                'Add waiver_ids: ["WV-0001"] to working spec, then create waiver file with: caws waiver create',
            });
          }
        }
      } catch (error) {
        warnings.push({
          instancePath: '/budget',
          message: `Budget derivation failed: ${error.message}`,
          suggestion: 'Check that .caws/policy.yaml exists and is valid',
        });
      }
    }

    // Apply auto-fixes if requested and not in dry-run mode
    const { dryRun = false } = options;
    let appliedFixes = [];

    if (autoFix && fixes.length > 0) {
      if (dryRun) {
        console.log('🔍 Auto-fix preview (dry-run mode):');
        for (const fix of fixes) {
          console.log(`   [WOULD FIX] ${fix.field}`);
          console.log(`      Description: ${fix.description}`);
          console.log(`      Reason: ${fix.reason}`);
          console.log(
            `      Value: ${typeof fix.value === 'object' ? JSON.stringify(fix.value) : fix.value}`
          );
          console.log('');
        }
      } else {
        console.log('🔧 Applying auto-fixes...');
        for (const fix of fixes) {
          try {
            const pathParts = fix.field.split('.');
            let current = spec;
            for (let i = 0; i < pathParts.length - 1; i++) {
              if (!current[pathParts[i]]) current[pathParts[i]] = {};
              current = current[pathParts[i]];
            }
            current[pathParts[pathParts.length - 1]] = fix.value;
            appliedFixes.push(fix);
            console.log(`   ✅ Fixed ${fix.field}`);
            console.log(`      ${fix.description}`);
          } catch (error) {
            console.warn(`   ⚠️  Failed to apply fix for ${fix.field}: ${error.message}`);
          }
        }
      }
    }

    // Calculate compliance score (0-1 scale)
    const complianceScore = calculateComplianceScore(errors, warnings);

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      fixes: fixes.length > 0 ? fixes : undefined,
      appliedFixes: appliedFixes.length > 0 ? appliedFixes : undefined,
      dryRun,
      budget_check: budgetCheck,
      complianceScore,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '',
          message: `Validation error: ${error.message}`,
        },
      ],
    };
  }
}

/**
 * Calculate compliance score based on errors and warnings
 * Score ranges from 0 (many issues) to 1 (perfect)
 * @param {Array} errors - Validation errors
 * @param {Array} warnings - Validation warnings
 * @returns {number} Compliance score (0-1)
 */
function calculateComplianceScore(errors, warnings) {
  // Start at perfect score
  let score = 1.0;

  // Each error reduces score by 0.2
  score -= errors.length * 0.2;

  // Each warning reduces score by 0.1
  score -= warnings.length * 0.1;

  // Floor at 0
  return Math.max(0, score);
}

/**
 * Get compliance grade from score
 * @param {number} score - Compliance score (0-1)
 * @returns {string} Grade (A, B, C, D, F)
 */
function getComplianceGrade(score) {
  if (score >= 0.9) return 'A';
  if (score >= 0.8) return 'B';
  if (score >= 0.7) return 'C';
  if (score >= 0.6) return 'D';
  return 'F';
}

/**
 * Get suggestion for a missing field
 * @param {string} field - Field name
 * @param {Object} _spec - Spec object (for context)
 * @returns {string} Suggestion text
 */
function getFieldSuggestion(field, _spec) {
  const suggestions = {
    id: 'Use format like: PROJ-001, FEAT-002, FIX-003',
    title: 'Add a descriptive project title',
    risk_tier: 'Choose: 1 (critical), 2 (standard), or 3 (low risk)',
    mode: 'Choose: feature, refactor, fix, doc, or chore',
    waiver_ids: 'Reference active waivers by ID (e.g., ["WV-0001"]) if budget exceptions needed',
    blast_radius: 'List affected modules and data migration needs',
    operational_rollback_slo: 'Choose: 1m, 5m, 15m, or 1h',
    scope: "Define what's included (in) and excluded (out) from changes",
    invariants: 'Add 1-3 statements about what must always remain true',
    acceptance: 'Add acceptance criteria in GIVEN/WHEN/THEN format',
    non_functional: 'Define accessibility, performance, and security requirements',
    contracts: 'Specify API contracts (OpenAPI, GraphQL, etc.)',
  };
  return suggestions[field] || `Add the ${field} field`;
}

/**
 * Check if a field can be auto-fixed
 * @param {string} field - Field name
 * @param {Object} _spec - Spec object (for context)
 * @returns {boolean} Whether field can be auto-fixed
 */
function canAutoFixField(field, _spec) {
  const autoFixable = ['risk_tier'];
  return autoFixable.includes(field);
}

module.exports = {
  validateWorkingSpec,
  validateWorkingSpecWithSuggestions,
  getFieldSuggestion,
  canAutoFixField,
  calculateComplianceScore,
  getComplianceGrade,
};
