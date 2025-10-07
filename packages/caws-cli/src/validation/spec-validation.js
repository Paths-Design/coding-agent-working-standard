/**
 * @fileoverview Working Spec Validation Utilities
 * Functions for validating CAWS working specifications
 * @author @darianrosebrook
 */

/**
 * Basic validation of working spec
 * @param {Object} spec - Working spec object
 * @returns {Object} Validation result
 */
const validateWorkingSpec = (spec) => {
  try {
    // Basic structural validation for essential fields
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'change_budget',
      'blast_radius',
      'operational_rollback_slo',
      'scope',
      'invariants',
      'acceptance',
      'non_functional',
      'contracts',
    ];

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
  const { autoFix = false } = options;

  try {
    // Basic structural validation for essential fields
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'change_budget',
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

    // Validate risk tier
    if (spec.risk_tier !== undefined && (spec.risk_tier < 1 || spec.risk_tier > 3)) {
      errors.push({
        instancePath: '/risk_tier',
        message: 'Risk tier must be 1, 2, or 3',
        suggestion:
          'Tier 1: Critical (auth, billing), Tier 2: Standard (features), Tier 3: Low risk (UI)',
        canAutoFix: true,
      });
      fixes.push({ field: 'risk_tier', value: Math.max(1, Math.min(3, spec.risk_tier || 2)) });
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
        errors.push({
          instancePath: '/contracts',
          message: 'Contracts required for Tier 1 and 2 changes',
          suggestion: 'Specify API contracts (OpenAPI, GraphQL, etc.)',
          canAutoFix: false,
        });
      }
    }

    // Apply auto-fixes if requested
    if (autoFix && fixes.length > 0) {
      console.log('🔧 Applying auto-fixes...');
      for (const fix of fixes) {
        const pathParts = fix.field.split('.');
        let current = spec;
        for (let i = 0; i < pathParts.length - 1; i++) {
          if (!current[pathParts[i]]) current[pathParts[i]] = {};
          current = current[pathParts[i]];
        }
        current[pathParts[pathParts.length - 1]] = fix.value;
        console.log(`   Fixed ${fix.field}: ${fix.value}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      fixes: fixes.length > 0 ? fixes : undefined,
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
    change_budget: 'Set max_files and max_loc based on risk tier',
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
};
