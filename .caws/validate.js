#!/usr/bin/env node

/**
 * @fileoverview CAWS Working Spec Validator (YAML-compatible)
 * Validates working specification against schema and business rules
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Validate working specification file
 * @param {string} specPath - Path to working spec file
 */
async function validateWorkingSpec(specPath) {
  try {
    // Read and parse the spec file
    if (!fs.existsSync(specPath)) {
      console.error(`❌ Working spec file not found: ${specPath}`);
      console.error('💡 Make sure the file exists and the path is correct.');
      console.error('📁 Current working directory:', process.cwd());
      process.exit(1);
    }

    let specContent;
    try {
      specContent = fs.readFileSync(specPath, 'utf8');
    } catch (readError) {
      console.error(`❌ Cannot read spec file: ${readError.message}`);
      console.error('💡 Check file permissions and ensure the file is not corrupted.');
      process.exit(1);
    }

    let spec;
    const fileExt = path.extname(specPath).toLowerCase();

    try {
      // Try YAML first (our preferred format), then JSON
      if (fileExt === '.yaml' || fileExt === '.yml') {
        spec = yaml.load(specContent);
      } else {
        spec = JSON.parse(specContent);
      }

      if (!spec || typeof spec !== 'object') {
        throw new Error('Invalid file structure - must be a valid object');
      }
    } catch (parseError) {
      console.error('❌ Invalid YAML or JSON in working spec:');
      console.error('   Error:', parseError.message);
      console.error('💡 Check your syntax and ensure the file is properly formatted.');
      if (fileExt === '.yaml' || fileExt === '.yml') {
        console.error('💡 For YAML files, ensure proper indentation and valid syntax.');
        console.error('📖 Example of valid YAML structure:');
        console.error('   id: FEAT-123');
        console.error('   title: "My Feature"');
        console.error('   mode: feature');
      } else {
        console.error('💡 For JSON files, ensure valid JSON syntax.');
      }
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
    if (!spec.scope.in || !Array.isArray(spec.scope.in) || spec.scope.in.length === 0) {
      console.error('❌ scope.in must be a non-empty array');
      process.exit(1);
    }

    // Validate blast radius
    if (!spec.blast_radius.modules || !Array.isArray(spec.blast_radius.modules)) {
      console.error('❌ blast_radius.modules must be an array');
      process.exit(1);
    }

    if (typeof spec.blast_radius.data_migration !== 'boolean') {
      console.error('❌ blast_radius.data_migration must be a boolean');
      process.exit(1);
    }

    // Validate operational rollback SLO
    if (!spec.operational_rollback_slo || typeof spec.operational_rollback_slo !== 'string') {
      console.error('❌ operational_rollback_slo must be a non-empty string');
      process.exit(1);
    }

    // Validate invariants
    if (!spec.invariants || !Array.isArray(spec.invariants) || spec.invariants.length === 0) {
      console.error('❌ invariants must be a non-empty array');
      process.exit(1);
    }

    // Validate acceptance criteria
    if (!spec.acceptance || !Array.isArray(spec.acceptance) || spec.acceptance.length === 0) {
      console.error('❌ acceptance must be a non-empty array');
      process.exit(1);
    }

    for (const criteria of spec.acceptance) {
      if (!criteria.id || !criteria.given || !criteria.when || !criteria.then) {
        console.error('❌ Each acceptance criteria must have id, given, when, then');
        process.exit(1);
      }
    }

    // Validate contracts
    if (!spec.contracts || !Array.isArray(spec.contracts) || spec.contracts.length === 0) {
      console.error('❌ contracts must be a non-empty array');
      process.exit(1);
    }

    for (const contract of spec.contracts) {
      if (!contract.type || !contract.path) {
        console.error('❌ Each contract must have type and path');
        process.exit(1);
      }

      const validTypes = ['openapi', 'graphql', 'proto', 'pact'];
      if (!validTypes.includes(contract.type)) {
        console.error(`❌ Contract type must be one of: ${validTypes.join(', ')}`);
        process.exit(1);
      }
    }

    // Validate non-functional requirements
    if (!spec.non_functional) {
      console.error('❌ non_functional requirements are required');
      process.exit(1);
    }

    if (!spec.non_functional.a11y || !Array.isArray(spec.non_functional.a11y)) {
      console.error('❌ non_functional.a11y must be an array');
      process.exit(1);
    }

    if (!spec.non_functional.perf) {
      console.error('❌ non_functional.perf requirements are required');
      process.exit(1);
    }

    if (!spec.non_functional.security || !Array.isArray(spec.non_functional.security)) {
      console.error('❌ non_functional.security must be an array');
      process.exit(1);
    }

    console.log('✅ Working specification is valid!');

    // Print summary
    console.log('\n📊 Specification Summary:');
    console.log(`   ID: ${spec.id}`);
    console.log(`   Title: ${spec.title}`);
    console.log(`   Mode: ${spec.mode}`);
    console.log(`   Risk Tier: ${spec.risk_tier}`);
    console.log(
      `   Budget: ${spec.change_budget.max_files} files, ${spec.change_budget.max_loc} LOC`
    );
    console.log(
      `   Scope: ${spec.scope.in.length} paths included, ${spec.scope.out?.length || 0} excluded`
    );
    console.log(`   Contracts: ${spec.contracts.length} APIs`);
    console.log(`   Invariants: ${spec.invariants.length}`);
    console.log(`   Acceptance Criteria: ${spec.acceptance.length}`);

    return { valid: true, spec };
  } catch (error) {
    // Categorize different types of errors for better user experience
    if (error.message.includes('Missing required field')) {
      console.error('❌ Validation Error: Missing required specification fields');
      console.error('💡 Ensure all required fields are present in your working spec.');
    } else if (error.message.includes('must be')) {
      console.error('❌ Validation Error: Invalid field values');
      console.error('💡 Check that all field values meet the required constraints.');
    } else if (error.message.includes('array') && error.message.includes('non-empty')) {
      console.error('❌ Validation Error: Empty required arrays');
      console.error(
        '💡 Ensure arrays like scope.in, invariants, and acceptance criteria are not empty.'
      );
    } else {
      console.error('❌ Unexpected validation error:', error.message);
    }

    console.error('🔍 Debug info:', {
      specPath,
      fileExists: fs.existsSync(specPath),
      fileSize: fs.existsSync(specPath) ? fs.statSync(specPath).size : 'N/A',
      nodeVersion: process.version,
    });

    process.exit(1);
  }
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('❌ Usage: node validate.js <spec-path>');
    console.error('📖 Example: node validate.js .caws/working-spec.yaml');
    console.error('💡 Use --help for more information');
    process.exit(1);
  }

  if (args.includes('--help') || args.includes('-h')) {
    console.log('🔍 CAWS Working Specification Validator');
    console.log('');
    console.log('Usage: node validate.js <spec-path>');
    console.log('');
    console.log('Arguments:');
    console.log('  spec-path    Path to the working specification file');
    console.log('');
    console.log('Examples:');
    console.log('  node validate.js .caws/working-spec.yaml');
    console.log('  node validate.js specs/feature-spec.yaml');
    console.log('');
    console.log('Exit codes:');
    console.log('  0 - Validation successful');
    console.log('  1 - Validation failed or file not found');
    process.exit(0);
  }

  const specPath = args[0];

  try {
    validateWorkingSpec(specPath);
  } catch (error) {
    console.error('💥 Unexpected error during validation:', error.message);
    console.error('🔍 Debug info:', {
      specPath,
      nodeVersion: process.version,
      platform: process.platform,
      cwd: process.cwd(),
    });
    process.exit(1);
  }
}

module.exports = { validateWorkingSpec };
