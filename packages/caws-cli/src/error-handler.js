/**
 * @fileoverview CAWS CLI Error Handler - Centralized error handling utilities
 * Provides consistent error categorization, formatting, and recovery suggestions
 * @author @darianrosebrook
 */

const chalk = require('chalk');

/**
 * Error categories for better user experience
 */
const ERROR_CATEGORIES = {
  VALIDATION: 'validation',
  PERMISSION: 'permission',
  FILESYSTEM: 'filesystem',
  NETWORK: 'network',
  CONFIGURATION: 'configuration',
  USER_INPUT: 'user_input',
  DEPENDENCY: 'dependency',
  UNKNOWN: 'unknown',
};

/**
 * Error code mappings for common system errors
 */
const ERROR_CODES = {
  EACCES: ERROR_CATEGORIES.PERMISSION,
  EPERM: ERROR_CATEGORIES.PERMISSION,
  ENOENT: ERROR_CATEGORIES.FILESYSTEM,
  ENOTFOUND: ERROR_CATEGORIES.NETWORK,
  ECONNREFUSED: ERROR_CATEGORIES.NETWORK,
  ETIMEDOUT: ERROR_CATEGORIES.NETWORK,
  ENOSPC: ERROR_CATEGORIES.FILESYSTEM,
  EEXIST: ERROR_CATEGORIES.FILESYSTEM,
  EISDIR: ERROR_CATEGORIES.FILESYSTEM,
  ENOTDIR: ERROR_CATEGORIES.FILESYSTEM,
};

/**
 * Get error category from error object or message
 * @param {Error|string} error - Error object or message
 * @returns {string} Error category
 */
function getErrorCategory(error) {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const errorCode = typeof error === 'object' && error.code ? error.code : null;

  // Check error codes first
  if (errorCode && ERROR_CODES[errorCode]) {
    return ERROR_CODES[errorCode];
  }

  // Check message patterns
  const lowerMessage = errorMessage.toLowerCase();

  if (
    lowerMessage.includes('validation') ||
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('required')
  ) {
    return ERROR_CATEGORIES.VALIDATION;
  }

  if (
    lowerMessage.includes('permission') ||
    lowerMessage.includes('access') ||
    lowerMessage.includes('denied')
  ) {
    return ERROR_CATEGORIES.PERMISSION;
  }

  if (
    lowerMessage.includes('file') ||
    lowerMessage.includes('directory') ||
    lowerMessage.includes('path')
  ) {
    return ERROR_CATEGORIES.FILESYSTEM;
  }

  if (
    lowerMessage.includes('network') ||
    lowerMessage.includes('connection') ||
    lowerMessage.includes('timeout')
  ) {
    return ERROR_CATEGORIES.NETWORK;
  }

  if (
    lowerMessage.includes('config') ||
    lowerMessage.includes('setting') ||
    lowerMessage.includes('option')
  ) {
    return ERROR_CATEGORIES.CONFIGURATION;
  }

  if (
    lowerMessage.includes('input') ||
    lowerMessage.includes('prompt') ||
    lowerMessage.includes('answer')
  ) {
    return ERROR_CATEGORIES.USER_INPUT;
  }

  return ERROR_CATEGORIES.UNKNOWN;
}

/**
 * Enhanced error class with category and recovery suggestions
 */
class CAWSError extends Error {
  constructor(message, category = null, suggestions = []) {
    super(message);
    this.name = 'CAWSError';
    this.category = category || getErrorCategory(message);
    this.suggestions = Array.isArray(suggestions) ? suggestions : [suggestions].filter(Boolean);
  }
}

/**
 * Wrap async operations with consistent error handling
 * @param {Function} operation - Async operation to wrap
 * @param {string} context - Context for error messages
 * @returns {Promise<any>} Operation result or throws handled error
 */
async function safeAsync(operation, context = '') {
  try {
    return await operation();
  } catch (error) {
    const category = getErrorCategory(error);
    const enhancedError = new CAWSError(
      `${context}: ${error.message}`,
      category,
      getRecoverySuggestions(error, category)
    );
    enhancedError.originalError = error;
    throw enhancedError;
  }
}

/**
 * Get recovery suggestions based on error category
 * @param {Error} error - Original error
 * @param {string} category - Error category
 * @returns {string[]} Array of recovery suggestions
 */
function getRecoverySuggestions(error, category) {
  const suggestions = [];

  switch (category) {
    case ERROR_CATEGORIES.PERMISSION:
      suggestions.push('Try running the command with elevated privileges (sudo)');
      suggestions.push('Check file/directory permissions with `ls -la`');
      break;

    case ERROR_CATEGORIES.FILESYSTEM:
      if (error.code === 'ENOENT') {
        suggestions.push('Verify the file/directory path exists');
        suggestions.push('Check for typos in file names');
      } else if (error.code === 'EEXIST') {
        suggestions.push('The file/directory already exists');
        suggestions.push('Use a different name or remove the existing item');
      }
      break;

    case ERROR_CATEGORIES.VALIDATION:
      suggestions.push('Run `caws validate --suggestions` for detailed validation help');
      suggestions.push('Check your working spec format against the documentation');
      break;

    case ERROR_CATEGORIES.CONFIGURATION:
      suggestions.push('Run `caws init --interactive` to reconfigure your project');
      suggestions.push('Check your .caws directory and configuration files');
      break;

    case ERROR_CATEGORIES.NETWORK:
      suggestions.push('Check your internet connection');
      suggestions.push('Verify the URL/service is accessible');
      break;

    default:
      suggestions.push('Run the command with --help for usage information');
      suggestions.push('Check the CAWS documentation at docs/README.md');
  }

  return suggestions;
}

/**
 * Handle CLI errors with consistent formatting and user guidance
 * @param {Error} error - Error to handle
 * @param {boolean} exit - Whether to exit the process (default: true)
 */
function handleCliError(error, exit = true) {
  const category = error.category || getErrorCategory(error);
  const suggestions = error.suggestions || getRecoverySuggestions(error, category);

  // Format error output
  console.error(chalk.red(`\n❌ Error (${category}): ${error.message}`));

  if (suggestions && suggestions.length > 0) {
    console.error(chalk.yellow('\n💡 Suggestions:'));
    suggestions.forEach((suggestion) => {
      console.error(chalk.yellow(`   • ${suggestion}`));
    });
  }

  console.error(
    chalk.gray(
      '\n📖 For more help, visit: https://github.com/Paths-Design/coding-agent-working-standard'
    )
  );

  if (exit) {
    process.exit(1);
  }
}

/**
 * Validate required environment and dependencies
 * @returns {Object} Validation result with any errors
 */
function validateEnvironment() {
  const errors = [];
  const warnings = [];

  // Check Node.js version
  const nodeVersion = process.versions.node;
  const majorVersion = parseInt(nodeVersion.split('.')[0], 10);
  if (majorVersion < 18) {
    errors.push(`Node.js version ${nodeVersion} is not supported. Minimum required: 18.0.0`);
  }

  // Check if running in supported environment
  if (!process.cwd()) {
    errors.push('Unable to determine current working directory');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  CAWSError,
  ERROR_CATEGORIES,
  getErrorCategory,
  safeAsync,
  handleCliError,
  validateEnvironment,
  getRecoverySuggestions,
};
