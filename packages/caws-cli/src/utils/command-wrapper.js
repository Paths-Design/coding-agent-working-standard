/**
 * @fileoverview Unified Command Wrapper
 * Provides consistent error handling and output formatting for all CLI commands
 * @author @darianrosebrook
 */

const { safeAsync, handleCliError, outputResult, isJsonOutput } = require('../error-handler');
const chalk = require('chalk');

/**
 * Unified command wrapper that provides:
 * - Consistent error handling
 * - Standardized output formatting
 * - Execution timing
 * - JSON output support
 *
 * @param {Function} commandFn - Async command function to execute
 * @param {Object} options - Command options
 * @param {string} options.commandName - Name of the command (for error context)
 * @param {boolean} [options.includeTiming=true] - Include execution timing
 * @param {boolean} [options.exitOnError=true] - Exit process on error
 * @param {Object} [options.context={}] - Additional context for error handling
 * @returns {Promise<any>} Command result
 */
async function commandWrapper(commandFn, options = {}) {
  const {
    commandName = 'command',
    includeTiming = true,
    exitOnError = true,
    context = {},
  } = options;

  return safeAsync(
    async () => {
      try {
        const result = await commandFn();
        return result;
      } catch (error) {
        // Enhance error with command context
        error.commandName = commandName;
        error.context = { ...context, ...error.context };

        // Handle error with unified handler
        handleCliError(error, {
          command: commandName,
          ...context,
        }, exitOnError);

        // If exitOnError is false, rethrow for caller to handle
        if (!exitOnError) {
          throw error;
        }
      }
    },
    commandName,
    includeTiming
  );
}

/**
 * Unified output utilities for consistent formatting
 */
const Output = {
  /**
   * Output success message
   * @param {string} message - Success message
   * @param {Object} [data] - Additional data to output
   */
  success(message, data = {}) {
    if (isJsonOutput()) {
      outputResult({
        success: true,
        message,
        ...data,
      }, true);
    } else {
      console.log(chalk.green(`✅ ${message}`));
      if (Object.keys(data).length > 0 && !isJsonOutput()) {
        console.log(chalk.gray(JSON.stringify(data, null, 2)));
      }
    }
  },

  /**
   * Output error message
   * @param {string} message - Error message
   * @param {string[]} [suggestions] - Recovery suggestions
   */
  error(message, suggestions = []) {
    if (isJsonOutput()) {
      outputResult({
        success: false,
        error: {
          message,
          suggestions,
        },
      }, false);
    } else {
      console.error(chalk.red(`❌ ${message}`));
      if (suggestions.length > 0) {
        console.error(chalk.yellow('\n💡 Suggestions:'));
        suggestions.forEach((suggestion) => {
          console.error(chalk.yellow(`   ${suggestion}`));
        });
      }
    }
  },

  /**
   * Output warning message
   * @param {string} message - Warning message
   * @param {string} [suggestion] - Optional suggestion
   */
  warning(message, suggestion = null) {
    if (isJsonOutput()) {
      outputResult({
        warning: true,
        message,
        suggestion,
      }, true);
    } else {
      console.warn(chalk.yellow(`⚠️  ${message}`));
      if (suggestion) {
        console.warn(chalk.blue(`   💡 ${suggestion}`));
      }
    }
  },

  /**
   * Output info message
   * @param {string} message - Info message
   * @param {Object} [data] - Additional data
   */
  info(message, data = {}) {
    if (isJsonOutput()) {
      outputResult({
        info: true,
        message,
        ...data,
      }, true);
    } else {
      console.log(chalk.blue(`ℹ️  ${message}`));
      if (Object.keys(data).length > 0) {
        console.log(chalk.gray(JSON.stringify(data, null, 2)));
      }
    }
  },

  /**
   * Output data in JSON format
   * @param {Object} data - Data to output
   * @param {boolean} [success=true] - Whether operation was successful
   */
  json(data, success = true) {
    outputResult(data, success);
  },

  /**
   * Output progress message
   * @param {string} message - Progress message
   */
  progress(message) {
    if (!isJsonOutput()) {
      console.log(chalk.blue(`🔄 ${message}`));
    }
  },

  /**
   * Output section header
   * @param {string} title - Section title
   */
  section(title) {
    if (!isJsonOutput()) {
      console.log(chalk.bold(`\n${title}`));
      console.log('─'.repeat(Math.min(title.length, 60)));
    }
  },
};

module.exports = {
  commandWrapper,
  Output,
  isJsonOutput,
};

