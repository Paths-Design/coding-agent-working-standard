/**
 * @fileoverview Validate Command Handler
 * Handles validation commands for CAWS CLI
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

// Import validation functionality
const { validateWorkingSpecWithSuggestions } = require('../validation/spec-validation');

/**
 * Validate command handler
 * Enhanced with JSON output format support
 * @param {string} specFile - Path to spec file
 * @param {Object} options - Command options
 */
async function validateCommand(specFile, options) {
  try {
    let specPath = specFile || path.join('.caws', 'working-spec.yaml');

    if (!fs.existsSync(specPath)) {
      if (options.format === 'json') {
        console.log(
          JSON.stringify(
            {
              passed: false,
              verdict: 'fail',
              errors: [
                {
                  field: 'spec_file',
                  message: `Spec file not found: ${specPath}`,
                  suggestion: 'Run "caws init" first to create a working spec',
                },
              ],
            },
            null,
            2
          )
        );
      } else {
        console.error(chalk.red(`❌ Spec file not found: ${specPath}`));
        console.error(chalk.blue('💡 Run "caws init" first to create a working spec'));
      }
      process.exit(1);
    }

    const specContent = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specContent);

    if (options.format !== 'json') {
      console.log(chalk.cyan('🔍 Validating CAWS working spec...'));
    }

    const result = validateWorkingSpecWithSuggestions(spec, {
      autoFix: options.autoFix,
      suggestions: !options.quiet,
      checkBudget: true,
      projectRoot: path.dirname(specPath),
    });

    // Format output based on requested format
    if (options.format === 'json') {
      // Structured JSON output matching CAWSValidationResult
      const jsonResult = {
        passed: result.valid,
        cawsVersion: '3.4.0',
        timestamp: new Date().toISOString(),
        verdict: result.valid ? 'pass' : 'fail',
        spec: {
          id: spec.id,
          title: spec.title,
          risk_tier: spec.risk_tier,
          mode: spec.mode,
        },
        validation: {
          errors: result.errors || [],
          warnings: result.warnings || [],
          fixes: result.fixes || [],
        },
        budgetCompliance: result.budget_check || null,
      };

      console.log(JSON.stringify(jsonResult, null, 2));

      if (!result.valid) {
        process.exit(1);
      }
    } else {
      // Human-readable text output
      if (result.valid) {
        console.log(chalk.green('✅ Working spec validation passed'));
        if (!options.quiet) {
          console.log(chalk.gray(`   Risk tier: ${spec.risk_tier}`));
          console.log(chalk.gray(`   Mode: ${spec.mode}`));
          if (spec.title) {
            console.log(chalk.gray(`   Title: ${spec.title}`));
          }
        }
      } else {
        console.log(chalk.red('❌ Working spec validation failed'));

        // Show errors
        result.errors.forEach((error, index) => {
          console.log(`   ${index + 1}. ${chalk.red(error.message)}`);
          if (error.suggestion) {
            console.log(`      ${chalk.blue('💡 ' + error.suggestion)}`);
          }
        });

        // Show warnings
        if (result.warnings && result.warnings.length > 0) {
          console.log(chalk.yellow('\n⚠️  Warnings:'));
          result.warnings.forEach((warning, index) => {
            console.log(`   ${index + 1}. ${chalk.yellow(warning.message)}`);
          });
        }

        process.exit(1);
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
    process.exit(1);
  }
}

module.exports = {
  validateCommand,
};
