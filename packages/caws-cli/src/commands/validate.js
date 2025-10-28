/**
 * @fileoverview Validate Command Handler
 * Handles validation commands for CAWS CLI with multi-spec support
 * @author @darianrosebrook
 */

const path = require('path');
const chalk = require('chalk');

// Import validation functionality
const {
  validateWorkingSpecWithSuggestions,
  getComplianceGrade,
} = require('../validation/spec-validation');

// Import spec resolution system
const { resolveSpec, suggestMigration } = require('../utils/spec-resolver');

/**
 * Validate command handler
 * Enhanced with multi-spec support and JSON output format
 * @param {string} specFile - Path to spec file (optional, uses spec resolution)
 * @param {Object} options - Command options
 * @param {string} [options.specId] - Feature-specific spec ID
 * @param {boolean} [options.interactive] - Use interactive spec selection
 * @param {boolean} [options.format] - Output format (json)
 */
async function validateCommand(specFile, options = {}) {
  try {
    // Resolve spec using priority system
    const resolved = await resolveSpec({
      specId: options.specId,
      specFile,
      warnLegacy: options.format !== 'json',
      interactive: options.interactive || false,
    });

    const { path: specPath, type: specType, spec } = resolved;

    // Suggest migration if using legacy spec
    if (specType === 'legacy' && options.format !== 'json') {
      await suggestMigration();
    }

    if (options.format !== 'json') {
      console.log(
        chalk.cyan(`🔍 Validating ${specType === 'feature' ? 'feature' : 'working'} spec...`)
      );
      console.log(chalk.gray(`   Spec: ${path.relative(process.cwd(), specPath)}`));
    }

    const result = validateWorkingSpecWithSuggestions(spec, {
      autoFix: options.autoFix,
      dryRun: options.dryRun,
      suggestions: !options.quiet,
      checkBudget: true,
      projectRoot: path.dirname(specPath),
      specType,
    });

    // Enhanced validation for multi-spec scenarios
    const enhancedValidation = { ...result };

    if (specType === 'feature') {
      // Check for potential issues in feature specs
      const featureIssues = [];

      // Check scope conflicts (if multiple specs exist)
      const { checkMultiSpecStatus } = require('../utils/spec-resolver');
      const multiSpecStatus = await checkMultiSpecStatus();

      if (multiSpecStatus.specCount > 1) {
        const { checkScopeConflicts } = require('../utils/spec-resolver');
        const conflicts = await checkScopeConflicts(
          Object.keys(multiSpecStatus.registry?.specs || {})
        );

        if (conflicts.length > 0) {
          const myConflicts = conflicts.filter((c) => c.spec1 === spec.id || c.spec2 === spec.id);

          if (myConflicts.length > 0) {
            featureIssues.push({
              type: 'warning',
              message: `Scope conflicts detected with other specs`,
              details: myConflicts.map((c) => {
                const otherSpec = c.spec1 === spec.id ? c.spec2 : c.spec1;
                return `Conflict with ${otherSpec}: ${c.conflicts.join(', ')}`;
              }),
            });
          }
        }
      }

      // Check for missing contracts in feature specs
      if (spec.contracts && spec.contracts.length === 0 && spec.mode === 'feature') {
        featureIssues.push({
          type: 'info',
          message: 'Consider adding API contracts for better integration',
          suggestion: 'Add contracts section to define API boundaries',
        });
      }

      // Check for overly broad scopes
      if (spec.scope && spec.scope.in) {
        const broadPatterns = spec.scope.in.filter(
          (pattern) => pattern === 'src/' || pattern === 'tests/' || pattern.includes('*')
        );

        if (broadPatterns.length > 0) {
          featureIssues.push({
            type: 'warning',
            message: 'Broad scope patterns detected',
            details: `Patterns like ${broadPatterns.join(', ')} may conflict with other features`,
            suggestion: 'Use more specific scope.in paths',
          });
        }
      }

      // Add feature-specific issues to validation result
      if (featureIssues.length > 0) {
        enhancedValidation.issues = (enhancedValidation.issues || []).concat(featureIssues);
        enhancedValidation.featureValidation = {
          passed: featureIssues.filter((i) => i.type === 'error').length === 0,
          issues: featureIssues,
        };
      }
    }

    const finalResult = enhancedValidation;

    // Format output based on requested format
    if (options.format === 'json') {
      // Structured JSON output matching CAWSValidationResult
      const jsonResult = {
        passed: finalResult.valid,
        cawsVersion: '3.4.0',
        timestamp: new Date().toISOString(),
        verdict: finalResult.valid ? 'pass' : 'fail',
        spec: {
          id: spec.id,
          title: spec.title,
          risk_tier: spec.risk_tier,
          mode: spec.mode,
        },
        validation: {
          errors: finalResult.errors || [],
          warnings: finalResult.warnings || [],
          fixes: finalResult.fixes || [],
        },
        budgetCompliance: finalResult.budget_check || null,
        specType,
        specPath: path.relative(process.cwd(), specPath),
        featureValidation: finalResult.featureValidation,
      };

      console.log(JSON.stringify(jsonResult, null, 2));

      if (!finalResult.valid) {
        // Don't call process.exit in test environment
        if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
          process.exit(1);
        } else {
          throw new Error('Validation failed');
        }
      }
    } else {
      // Human-readable text output
      if (finalResult.valid) {
        console.log(chalk.green('✅ Working spec validation passed'));
        if (!options.quiet) {
          console.log(chalk.gray(`   Risk tier: ${spec.risk_tier}`));
          console.log(chalk.gray(`   Mode: ${spec.mode}`));
          if (spec.title) {
            console.log(chalk.gray(`   Title: ${spec.title}`));
          }
          if (finalResult.complianceScore !== undefined) {
            const grade = getComplianceGrade(finalResult.complianceScore);
            const scorePercent = (finalResult.complianceScore * 100).toFixed(0);
            const scoreColor =
              finalResult.complianceScore >= 0.9
                ? 'green'
                : finalResult.complianceScore >= 0.7
                  ? 'yellow'
                  : 'red';
            console.log(chalk[scoreColor](`   Compliance: ${scorePercent}% (Grade ${grade})`));
          }
        }
      } else {
        console.log(chalk.red('❌ Working spec validation failed'));

        // Show errors
        finalResult.errors.forEach((error, index) => {
          console.log(`   ${index + 1}. ${chalk.red(error.message)}`);
          if (error.suggestion) {
            console.log(`      ${chalk.blue('💡 ' + error.suggestion)}`);
          }
        });

        // Show warnings
        if (finalResult.warnings && finalResult.warnings.length > 0) {
          console.log(chalk.yellow('\n⚠️  Warnings:'));
          finalResult.warnings.forEach((warning, index) => {
            console.log(`   ${index + 1}. ${chalk.yellow(warning.message)}`);
          });
        }

        // Don't call process.exit in test environment
        if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
          process.exit(1);
        } else {
          throw new Error('Validation failed');
        }
      }
    }
  } catch (error) {
    if (options.format === 'json') {
      console.log(
        JSON.stringify(
          {
            passed: false,
            verdict: 'fail',
            error: error.message,
          },
          null,
          2
        )
      );
    } else {
      console.error(chalk.red('❌ Error during validation:'), error.message);
    }
    // Don't call process.exit in test environment
    if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
      process.exit(1);
    }
  }
}

module.exports = {
  validateCommand,
};
