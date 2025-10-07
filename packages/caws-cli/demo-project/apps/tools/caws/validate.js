#!/usr/bin/env node

/**
 * @fileoverview CAWS Working Spec Validator
 * Validates working specification against JSON schema and business rules
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { BaseTool } = require('../../../src/tool-interface');

/**
 * CAWS Working Spec Validator Tool
 */
class ValidateTool extends BaseTool {
  constructor() {
    super();
  }

  /**
   * Get tool metadata
   * @returns {Object} Tool metadata
   */
  getMetadata() {
    return {
      id: 'validate',
      name: 'Working Spec Validator',
      version: '1.0.0',
      description: 'Validates CAWS working specification against JSON schema and business rules',
      capabilities: ['validation', 'quality-gates'],
      author: '@darianrosebrook',
      license: 'MIT'
    };
  }

  /**
   * Execute validation
   * @param {Object} parameters - Validation parameters
   * @param {Object} context - Execution context
   * @returns {Promise<Object>} Validation result
   */
  async executeImpl(parameters, context) {
    const specPath = parameters.specPath || context.specPath || '.caws/working-spec.yaml';

    return await this.validateWorkingSpec(specPath);
  }

  /**
   * Validate working specification file
   * @param {string} specPath - Path to working spec file
   * @returns {Promise<Object>} Validation result
   */
  async validateWorkingSpec(specPath) {
  try {
    // Read and parse the spec file
    if (!fs.existsSync(specPath)) {
      console.error('❌ Working spec file not found:', specPath);
      process.exit(1);
    }

    const specContent = fs.readFileSync(specPath, 'utf8');
    let spec;

    try {
      spec = JSON.parse(specContent);
    } catch (error) {
      console.error('❌ Invalid JSON in working spec:', error.message);
      process.exit(1);
    }

    console.log('🔍 Validating working specification...');

    // Basic structure validation
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
      if (!(field in spec)) {
        console.error(`❌ Missing required field: ${field}`);
        process.exit(1);
      }
    }

    // Validate risk tier
    if (![1, 2, 3].includes(spec.risk_tier)) {
      console.error('❌ Risk tier must be 1, 2, or 3');
      process.exit(1);
    }

    // Validate mode
    const validModes = ['refactor', 'feature', 'fix', 'doc', 'chore'];
    if (!validModes.includes(spec.mode)) {
      console.error(`❌ Mode must be one of: ${validModes.join(', ')}`);
      process.exit(1);
    }

    // Validate change budget
    if (spec.change_budget.max_files < 1) {
      console.error('❌ max_files must be at least 1');
      process.exit(1);
    }

    if (spec.change_budget.max_loc < 1) {
      console.error('❌ max_loc must be at least 1');
      process.exit(1);
    }

    // Validate scope
    if (!spec.scope.in || spec.scope.in.length === 0) {
      console.error('❌ scope.in cannot be empty');
      process.exit(1);
    }

    // Validate invariants
    if (!spec.invariants || spec.invariants.length === 0) {
      console.error('❌ invariants cannot be empty');
      process.exit(1);
    }

    // Validate acceptance criteria
    if (!spec.acceptance || spec.acceptance.length === 0) {
      console.error('❌ acceptance criteria cannot be empty');
      process.exit(1);
    }

    // Validate contracts for tier 1 and 2
    if (
      (spec.risk_tier === 1 || spec.risk_tier === 2) &&
      (!spec.contracts || spec.contracts.length === 0)
    ) {
      console.error(`❌ Risk tier ${spec.risk_tier} requires at least one contract`);
      process.exit(1);
    }

    // Validate rollback SLO format
    const sloPattern = /^([0-9]+m|[0-9]+h)$/;
    if (!sloPattern.test(spec.operational_rollback_slo)) {
      console.error('❌ operational_rollback_slo must be in format like "5m" or "1h"');
      process.exit(1);
    }

    console.log('✅ Working specification is valid');
    console.log(`📋 Summary:`);
    console.log(`   - ID: ${spec.id}`);
    console.log(`   - Title: ${spec.title}`);
    console.log(`   - Risk Tier: ${spec.risk_tier}`);
    console.log(`   - Mode: ${spec.mode}`);
    console.log(`   - Max Files: ${spec.change_budget.max_files}`);
    console.log(`   - Max LOC: ${spec.change_budget.max_loc}`);
    console.log(`   - Contracts: ${spec.contracts?.length || 0}`);

    return {
      success: true,
      output: {
        valid: true,
        message: 'Working specification is valid',
        summary: {
          id: spec.id,
          mode: spec.mode,
          riskTier: spec.risk_tier,
          maxFiles: spec.change_budget.max_files,
          maxLoc: spec.change_budget.max_loc,
          contracts: spec.contracts?.length || 0
        }
      }
    };
  } catch (error) {
    return {
      success: false,
      errors: [error.message],
      output: {
        valid: false,
        message: error.message
      }
    };
  }
}

// Export both new class interface and legacy function interface for backward compatibility
const validateWorkingSpec = async (specPath) => {
  const tool = new ValidateTool();
  const result = await tool.execute({ specPath });
  if (result.success) {
    console.log('✅ Working specification is valid');
    return result.output;
  } else {
    console.error('❌ Validation failed:', result.errors.join(', '));
    throw new Error(result.errors.join(', '));
  }
};

module.exports = {
  ValidateTool,
  validateWorkingSpec
};

// CLI usage (for backward compatibility)
if (require.main === module) {
  const specPath = process.argv[2] || '.caws/working-spec.yaml';

  if (!specPath) {
    console.error('❌ Please provide path to working spec file');
    console.log('Usage: node validate.js [path-to-spec]');
    process.exit(1);
  }

  const tool = new ValidateTool();
  tool.execute({ specPath }).then(result => {
    if (result.success) {
      console.log('✅ Working specification is valid');
      process.exit(0);
    } else {
      console.error('❌ Validation failed:', result.errors.join(', '));
      process.exit(1);
    }
  }).catch(error => {
    console.error('❌ Error during validation:', error.message);
    process.exit(1);
  });
}
