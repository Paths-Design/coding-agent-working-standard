/**
 * @fileoverview Centralized Error Categories
 * Shared error categorization for consistent error handling across CAWS packages
 * @author @darianrosebrook
 */

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
  const errorMessage = typeof error === 'string' ? error : (error?.message || '');
  const errorCode = typeof error === 'object' && error?.code ? error.code : null;

  // Check error codes first
  if (errorCode && ERROR_CODES[errorCode]) {
    return ERROR_CODES[errorCode];
  }

  // Check message patterns
  const lowerMessage = errorMessage.toLowerCase();

  if (
    lowerMessage.includes('validation') ||
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('required') ||
    lowerMessage.includes('malformed') ||
    lowerMessage.includes('syntax')
  ) {
    return ERROR_CATEGORIES.VALIDATION;
  }

  if (
    lowerMessage.includes('permission') ||
    lowerMessage.includes('access') ||
    lowerMessage.includes('denied') ||
    lowerMessage.includes('forbidden')
  ) {
    return ERROR_CATEGORIES.PERMISSION;
  }

  if (
    lowerMessage.includes('file') ||
    lowerMessage.includes('directory') ||
    lowerMessage.includes('path') ||
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
    lowerMessage.includes('config') ||
    lowerMessage.includes('setting') ||
    lowerMessage.includes('option') ||
    lowerMessage.includes('missing') ||
    lowerMessage.includes('empty')
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

  if (
    lowerMessage.includes('dependency') ||
    lowerMessage.includes('module not found')
  ) {
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
function getCategorySuggestions(category) {
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

module.exports = {
  ERROR_CATEGORIES,
  ERROR_CODES,
  getErrorCategory,
  getFriendlyMessage,
  getCategorySuggestions,
};
