#!/usr/bin/env node

/**
 * @fileoverview CAWS Error Handler - Centralized error handling utilities
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
    lowerMessage.includes('permission') ||
    lowerMessage.includes('access denied') ||
    lowerMessage.includes('forbidden')
  ) {
    return ERROR_CATEGORIES.PERMISSION;
  }

  if (
    lowerMessage.includes('not found') ||
    lowerMessage.includes('does not exist') ||
    lowerMessage.includes('enoent')
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
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('malformed') ||
    lowerMessage.includes('syntax')
  ) {
    return ERROR_CATEGORIES.VALIDATION;
  }

  if (
    lowerMessage.includes('missing') ||
    lowerMessage.includes('required') ||
    lowerMessage.includes('empty')
  ) {
    return ERROR_CATEGORIES.CONFIGURATION;
  }

  if (lowerMessage.includes('dependency') || lowerMessage.includes('module not found')) {
    return ERROR_CATEGORIES.DEPENDENCY;
  }

  return ERROR_CATEGORIES.UNKNOWN;
}

/**
 * Get user-friendly error message based on category
 * @param {string} category - Error category
 * @param {string} originalMessage - Original error message
 * @returns {string} User-friendly message
 */
function getFriendlyMessage(category, originalMessage) {
  const messages = {
    [ERROR_CATEGORIES.PERMISSION]:
      'Permission denied. Check file permissions or run with elevated privileges.',
    [ERROR_CATEGORIES.FILESYSTEM]:
      'File system error. Check if the file/directory exists and is accessible.',
    [ERROR_CATEGORIES.NETWORK]: 'Network error. Check your connection and try again.',
    [ERROR_CATEGORIES.VALIDATION]:
      'Data validation failed. Check your input format and requirements.',
    [ERROR_CATEGORIES.CONFIGURATION]:
      'Configuration error. Check your settings and required fields.',
    [ERROR_CATEGORIES.USER_INPUT]: 'Invalid user input. Check the command syntax and parameters.',
    [ERROR_CATEGORIES.DEPENDENCY]: 'Missing dependency. Install required packages.',
    [ERROR_CATEGORIES.UNKNOWN]: 'An unexpected error occurred.',
  };

  return messages[category] || originalMessage;
}

/**
 * Get recovery suggestions based on error category
 * @param {string} category - Error category
 * @returns {Array<string>} Array of recovery suggestions
 */
function getRecoverySuggestions(category) {
  const suggestions = {
    [ERROR_CATEGORIES.PERMISSION]: [
      'Try running with sudo/admin privileges',
      'Check file/directory permissions with chmod/chown',
      'Verify user has write access to the target directory',
    ],
    [ERROR_CATEGORIES.FILESYSTEM]: [
      'Verify the file/directory path is correct',
      'Check if the file is not corrupted',
      'Ensure sufficient disk space is available',
      'Check if the file is not being used by another process',
    ],
    [ERROR_CATEGORIES.NETWORK]: [
      'Check your internet connection',
      'Verify network configuration and firewall settings',
      'Try again in a few moments',
      'Check if the remote service is available',
    ],
    [ERROR_CATEGORIES.VALIDATION]: [
      'Review the input format and requirements',
      'Check for typos in file paths or values',
      'Validate against the schema documentation',
      'Use the --help flag to see correct syntax',
    ],
    [ERROR_CATEGORIES.CONFIGURATION]: [
      'Check that all required configuration files exist',
      'Verify configuration values are in the correct format',
      'Review the setup documentation',
      'Ensure environment variables are set correctly',
    ],
    [ERROR_CATEGORIES.USER_INPUT]: [
      'Check the command syntax with --help',
      'Verify all required arguments are provided',
      'Ensure arguments are in the correct order',
      'Check for typos in command names or options',
    ],
    [ERROR_CATEGORIES.DEPENDENCY]: [
      'Install missing dependencies with npm install',
      'Check if all peer dependencies are installed',
      'Verify Node.js version compatibility',
      'Clear npm cache and try again',
    ],
    [ERROR_CATEGORIES.UNKNOWN]: [
      'Check the logs for more detailed information',
      'Try restarting the process',
      'Verify system resources (memory, disk space)',
      'Report the issue with full error details',
    ],
  };

  return suggestions[category] || suggestions[ERROR_CATEGORIES.UNKNOWN];
}

/**
 * Format error for display with category, suggestions, and debug info
 * @param {Error|string} error - Error object or message
 * @param {string} context - Additional context about where the error occurred
 * @param {boolean} includeDebug - Whether to include debug information
 * @returns {string} Formatted error message
 */
function formatError(error, context = '', includeDebug = false) {
  const errorMessage = typeof error === 'string' ? error : error.message;
  const category = getErrorCategory(error);
  const friendlyMessage = getFriendlyMessage(category, errorMessage);
  const suggestions = getRecoverySuggestions(category);

  let formatted = '';
  formatted += chalk.red(`❌ Error: ${friendlyMessage}\n`);

  if (context) {
    formatted += chalk.cyan(`📍 Context: ${context}\n`);
  }

  if (suggestions.length > 0) {
    formatted += chalk.yellow('💡 Suggestions:\n');
    suggestions.forEach((suggestion, index) => {
      formatted += `   ${index + 1}. ${suggestion}\n`;
    });
  }

  if (includeDebug) {
    formatted += chalk.gray('\n🔍 Debug Information:\n');
    formatted += `   Category: ${category}\n`;
    formatted += `   Node.js: ${process.version}\n`;
    formatted += `   Platform: ${process.platform}\n`;
    formatted += `   Working Directory: ${process.cwd()}\n`;

    if (typeof error === 'object' && error.stack) {
      formatted += `   Stack Trace: ${error.stack.split('\n')[1]?.trim() || 'Not available'}\n`;
    }
  }

  return formatted;
}

/**
 * Handle CLI error with appropriate exit code
 * @param {Error|string} error - Error to handle
 * @param {string} context - Context about where error occurred
 * @param {number} exitCode - Exit code (default: 1)
 */
function handleCliError(error, context = '', exitCode = 1) {
  console.error(formatError(error, context, true));

  // Set specific exit codes based on error category
  if (getErrorCategory(error) === ERROR_CATEGORIES.USER_INPUT) {
    exitCode = 2; // Standard exit code for command line syntax errors
  }

  process.exit(exitCode);
}

/**
 * Safe async operation wrapper with error handling
 * @param {Function} operation - Async operation to wrap
 * @param {string} context - Context for error messages
 * @returns {Promise<any>} Operation result or throws handled error
 */
async function safeAsync(operation, context = '') {
  try {
    return await operation();
  } catch (error) {
    const category = getErrorCategory(error);
    const enhancedError = new Error(`${context}: ${error.message}`);
    enhancedError.originalError = error;
    enhancedError.category = category;
    throw enhancedError;
  }
}

/**
 * Validate required environment and dependencies
 * @returns {Object} Validation result with any errors
 */
function validateEnvironment() {
  const errors = [];

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (majorVersion < 18) {
    errors.push({
      category: ERROR_CATEGORIES.DEPENDENCY,
      message: `Node.js version ${nodeVersion} is not supported. Please use Node.js 18 or later.`,
    });
  }

  // Check required directories
  const requiredDirs = ['.caws', 'apps/tools/caws'];
  requiredDirs.forEach((dir) => {
    if (!require('fs').existsSync(dir)) {
      errors.push({
        category: ERROR_CATEGORIES.CONFIGURATION,
        message: `Required directory '${dir}' not found. Run 'caws init' to set up the project.`,
      });
    }
  });

  return { valid: errors.length === 0, errors };
}

module.exports = {
  ERROR_CATEGORIES,
  getErrorCategory,
  getFriendlyMessage,
  getRecoverySuggestions,
  formatError,
  handleCliError,
  safeAsync,
  validateEnvironment,
};
