#!/usr/bin/env node

/**
 * @fileoverview CAWS Working Spec Validator
 * Validates working specification against JSON schema and business rules
 * @author @darianrosebrook
 */

const fs = require('fs');

/**
 * Validate working specification file
 * @param {string} specPath - Path to working spec file
 */
async function validateWorkingSpec(specPath) {
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
  } catch (error) {
    console.error('❌ Validation failed:', error.message);
    process.exit(1);
  }
}

// CLI interface
if (require.main === module) {
  const specPath = process.argv[2] || '.caws/working-spec.yaml';

  if (!specPath) {
    console.error('❌ Please provide path to working spec file');
    console.log('Usage: node validate.js [path-to-spec]');
    process.exit(1);
  }

  validateWorkingSpec(specPath);
}

module.exports = { validateWorkingSpec };
