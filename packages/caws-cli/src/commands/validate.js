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
 * @param {string} specFile - Path to spec file
 * @param {Object} options - Command options
 */
async function validateCommand(specFile, options) {
  try {
    let specPath = specFile || path.join('.caws', 'working-spec.yaml');

    if (!fs.existsSync(specPath)) {
      console.error(chalk.red(`❌ Spec file not found: ${specPath}`));
      console.error(chalk.blue('💡 Run "caws init" first to create a working spec'));
      process.exit(1);
    }

    const specContent = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specContent);

    console.log(chalk.cyan('🔍 Validating CAWS working spec...'));

    const result = validateWorkingSpecWithSuggestions(spec, {
      autoFix: options.autoFix,
      suggestions: !options.quiet,
    });

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
  } catch (error) {
    console.error(chalk.red('❌ Error during validation:'), error.message);
    process.exit(1);
  }
}

module.exports = {
  validateCommand,
};
