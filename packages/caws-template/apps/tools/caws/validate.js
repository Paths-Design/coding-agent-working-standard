#!/usr/bin/env node

/**
 * @fileoverview CAWS Validate Tool - Real Implementation
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

/**
 * Working specification schema for validation
 */
const WORKING_SPEC_SCHEMA = {
  type: 'object',
  required: ['id', 'title', 'risk_tier', 'mode', 'scope', 'invariants', 'acceptance'],
  properties: {
    id: {
      type: 'string',
      pattern: '^[A-Z]+-\\d+$',
      description: 'Project identifier in format PREFIX-NUMBER',
    },
    title: {
      type: 'string',
      minLength: 1,
      description: 'Human-readable project title',
    },
    risk_tier: {
      type: 'number',
      enum: [1, 2, 3],
      description: 'Risk level: 1=low, 2=medium, 3=high',
    },
    mode: {
      type: 'string',
      enum: ['feature', 'refactor', 'fix', 'doc', 'chore'],
      description: 'Type of change being made',
    },
    scope: {
      type: 'object',
      required: ['in', 'out'],
      properties: {
        in: {
          type: ['string', 'array'],
          description: 'Files/directories included in scope',
        },
        out: {
          type: ['string', 'array'],
          description: 'Files/directories excluded from scope',
        },
      },
    },
    invariants: {
      type: 'array',
      items: { type: 'string' },
      description: 'System invariants that must be maintained',
    },
    acceptance: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'given', 'when', 'then'],
        properties: {
          id: { type: 'string' },
          given: { type: 'string' },
          when: { type: 'string' },
          then: { type: 'string' },
        },
      },
      description: 'Acceptance criteria for the change',
    },
    threats: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential threats or risks',
    },
    migrations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Database or data migration steps',
    },
    rollback: {
      type: 'array',
      items: { type: 'string' },
      description: 'Rollback procedures if needed',
    },
  },
};

/**
 * Validate a working specification file
 * @param {string} specPath - Path to the working spec file
 * @returns {Object} Validation result with success status and details
 */
function validateWorkingSpec(specPath) {
  try {
    // Check if file exists
    if (!fs.existsSync(specPath)) {
      return {
        success: false,
        error: `Working spec file not found: ${specPath}`,
      };
    }

    // Read and parse the YAML file
    const specContent = fs.readFileSync(specPath, 'utf8');
    let spec;

    try {
      spec = yaml.load(specContent);
    } catch (parseError) {
      return {
        success: false,
        error: `Invalid YAML format: ${parseError.message}`,
      };
    }

    // Validate against schema
    const ajv = new Ajv({ allErrors: true });
    const validate = ajv.compile(WORKING_SPEC_SCHEMA);
    const isValid = validate(spec);

    if (!isValid) {
      const errors = validate.errors
        .map((error) => `${error.instancePath || 'root'}: ${error.message}`)
        .join(', ');

      return {
        success: false,
        error: `Schema validation failed: ${errors}`,
      };
    }

    // Additional business logic validation
    const businessValidation = validateBusinessRules(spec);
    if (!businessValidation.valid) {
      return {
        success: false,
        error: `Business rule violation: ${businessValidation.error}`,
      };
    }

    // Generate validation summary
    const summary = generateValidationSummary(spec);

    return {
      success: true,
      details: summary,
    };
  } catch (error) {
    return {
      success: false,
      error: `Error validating working spec: ${error.message}`,
    };
  }
}

/**
 * Validate business rules for working specifications
 * @param {Object} spec - Parsed working specification
 * @returns {Object} Validation result
 */
function validateBusinessRules(spec) {
  // Rule: High risk projects should have detailed acceptance criteria
  if (spec.risk_tier >= 3) {
    if (!spec.acceptance || spec.acceptance.length < 3) {
      return {
        valid: false,
        error: 'High risk projects (tier 3) must have at least 3 acceptance criteria',
      };
    }
  }

  // Rule: Refactor projects should specify what is being refactored
  if (spec.mode === 'refactor') {
    if (!spec.threats || spec.threats.length === 0) {
      return {
        valid: false,
        error: 'Refactor projects must specify what is being refactored in threats section',
      };
    }
  }

  // Rule: Projects with data migration should have rollback plan
  if (spec.migrations && spec.migrations.length > 0) {
    if (!spec.rollback || spec.rollback.length === 0) {
      return {
        valid: false,
        error: 'Projects with migrations must include rollback procedures',
      };
    }
  }

  return { valid: true };
}

/**
 * Generate detailed validation summary
 * @param {Object} spec - Validated working specification
 * @returns {Object} Summary details
 */
function generateValidationSummary(spec) {
  return {
    id: spec.id,
    title: spec.title,
    risk_tier: spec.risk_tier,
    mode: spec.mode,
    scope_in_count: Array.isArray(spec.scope.in) ? spec.scope.in.length : 1,
    scope_out_count: Array.isArray(spec.scope.out) ? spec.scope.out.length : 1,
    invariants_count: spec.invariants.length,
    acceptance_criteria_count: spec.acceptance.length,
    threats_count: (spec.threats || []).length,
    migrations_count: (spec.migrations || []).length,
    rollback_steps_count: (spec.rollback || []).length,
    validation_timestamp: new Date().toISOString(),
  };
}

// Command-line interface
if (require.main === module) {
  const specPath = process.argv[2];

  if (!specPath) {
    console.error('❌ Working spec file path is required');
    console.error('💡 Usage: node validate.js <path-to-working-spec.yaml>');
    process.exit(1);
  }

  const result = validateWorkingSpec(specPath);

  if (result.success) {
    console.log('✅ Working specification is valid');
    console.log('');
    console.log('📋 Validation Summary:');
    console.log(`ID: ${result.details.id}`);
    console.log(`Title: ${result.details.title}`);
    console.log(`Risk Tier: ${result.details.risk_tier}`);
    console.log(`Mode: ${result.details.mode}`);
    console.log('');
    console.log('📊 Scope Analysis:');
    console.log(`Files in scope: ${result.details.scope_in_count}`);
    console.log(`Files out of scope: ${result.details.scope_out_count}`);
    console.log('');
    console.log('📝 Quality Metrics:');
    console.log(`Invariants: ${result.details.invariants_count}`);
    console.log(`Acceptance criteria: ${result.details.acceptance_criteria_count}`);
    console.log(`Threats identified: ${result.details.threats_count}`);
    console.log(`Migration steps: ${result.details.migrations_count}`);
    console.log(`Rollback steps: ${result.details.rollback_steps_count}`);
    console.log('');
    console.log(`✅ Validated at: ${result.details.validation_timestamp}`);
  } else {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
}

// Export for module usage
module.exports = validateWorkingSpec;
