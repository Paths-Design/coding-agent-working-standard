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
 * Command-specific error suggestions
 */
const COMMAND_SUGGESTIONS = {
  'unknown option': (option, command) => {
    const suggestions = [];

    // Common typos and alternatives
    const optionMap = {
      '--suggestions': 'Validation includes suggestions by default. Try: caws validate',
      '--suggest': 'Validation includes suggestions by default. Try: caws validate',
      '--help': 'Try: caws --help or caws <command> --help',
      '--json': 'For JSON output, try: caws provenance show --format=json',
      '--dashboard': 'Try: caws provenance show --format=dashboard',
    };

    if (optionMap[option]) {
      suggestions.push(optionMap[option]);
    } else {
      suggestions.push(`Try: caws ${command || ''} --help for available options`);
    }

    return suggestions;
  },

  'unknown command': (command) => {
    const validCommands = [
      'init',
      'validate',
      'scaffold',
      'status',
      'templates',
      'provenance',
      'hooks',
      'burnup',
      'tool',
    ];
    const similar = findSimilarCommand(command, validCommands);

    const suggestions = [];
    if (similar) {
      suggestions.push(`Did you mean: caws ${similar}?`);
    }
    suggestions.push(
      'Available commands: init, validate, scaffold, status, templates, provenance, hooks'
    );
    suggestions.push('Try: caws --help for full command list');

    return suggestions;
  },

  'template not found': () => [
    'Templates are bundled with CAWS CLI',
    'Try: caws scaffold (should work automatically)',
    'If issue persists: npm i -g @paths.design/caws-cli@latest',
  ],

  'not a caws project': () => [
    'Initialize CAWS first: caws init .',
    'Or create new project: caws init <project-name>',
    'Check for .caws/working-spec.yaml file',
  ],
};

/**
 * Find similar command using Levenshtein distance
 * @param {string} input - User's input command
 * @param {string[]} validCommands - List of valid commands
 * @returns {string|null} Most similar command or null
 */
function findSimilarCommand(input, validCommands) {
  if (!input) return null;

  let minDistance = Infinity;
  let closestMatch = null;

  for (const cmd of validCommands) {
    const distance = levenshteinDistance(input.toLowerCase(), cmd.toLowerCase());
    if (distance < minDistance && distance <= 2) {
      minDistance = distance;
      closestMatch = cmd;
    }
  }

  return closestMatch;
}

/**
 * Calculate Levenshtein distance between two strings
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {number} Edit distance
 */
function levenshteinDistance(a, b) {
  const matrix = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Get recovery suggestions based on error category
 * @param {Error} error - Original error
 * @param {string} category - Error category
 * @param {Object} context - Additional context (command, options, etc.)
 * @returns {string[]} Array of recovery suggestions
 */
function getRecoverySuggestions(error, category, context = {}) {
  const suggestions = [];
  const errorMessage = error.message || '';

  // Check for command-specific suggestions first
  for (const [pattern, suggestionFn] of Object.entries(COMMAND_SUGGESTIONS)) {
    if (errorMessage.toLowerCase().includes(pattern)) {
      const commandSuggestions = suggestionFn(context.option, context.command);
      suggestions.push(...commandSuggestions);
      return suggestions;
    }
  }

  // Fall back to category-based suggestions
  switch (category) {
    case ERROR_CATEGORIES.PERMISSION:
      suggestions.push('Try running the command with elevated privileges (sudo)');
      suggestions.push('Check file/directory permissions with: ls -la');
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
      suggestions.push('Run: caws validate for detailed validation help');
      suggestions.push('Check your working spec format against the schema');
      suggestions.push('See: docs/api/schema.md for specification details');
      break;

    case ERROR_CATEGORIES.CONFIGURATION:
      suggestions.push('Run: caws init --interactive to reconfigure');
      suggestions.push('Check your .caws directory and configuration files');
      suggestions.push('Try: caws diagnose to identify configuration issues');
      break;

    case ERROR_CATEGORIES.NETWORK:
      suggestions.push('Check your internet connection');
      suggestions.push('Verify the URL/service is accessible');
      suggestions.push('Try again in a few moments');
      break;

    default:
      suggestions.push('Run: caws --help for usage information');
      suggestions.push('See: docs/agents/full-guide.md for detailed documentation');
  }

  return suggestions;
}

/**
 * Get documentation link for error category
 * @param {string} category - Error category
 * @param {Object} context - Additional context
 * @returns {string} Documentation URL
 */
function getDocumentationLink(category, context = {}) {
  const baseUrl = 'https://github.com/Paths-Design/coding-agent-working-standard/blob/main';

  const categoryLinks = {
    validation: `${baseUrl}/docs/api/schema.md`,
    configuration: `${baseUrl}/docs/guides/caws-developer-guide.md`,
    filesystem: `${baseUrl}/docs/agents/tutorial.md`,
    permission: `${baseUrl}/SECURITY.md`,
    network: `${baseUrl}/README.md#requirements`,
  };

  if (context.command) {
    const commandLinks = {
      init: `${baseUrl}/docs/agents/tutorial.md#initialization`,
      validate: `${baseUrl}/docs/api/cli.md#validate`,
      scaffold: `${baseUrl}/docs/api/cli.md#scaffold`,
      provenance: `${baseUrl}/docs/api/cli.md#provenance`,
      hooks: `${baseUrl}/docs/guides/hooks-and-agent-workflows.md`,
    };

    if (commandLinks[context.command]) {
      return commandLinks[context.command];
    }
  }

  return categoryLinks[category] || `${baseUrl}/docs/agents/full-guide.md`;
}

/**
 * Handle CLI errors with consistent formatting and user guidance
 * @param {Error} error - Error to handle
 * @param {Object} context - Error context (command, option, etc.)
 * @param {boolean} exit - Whether to exit the process (default: true)
 */
function handleCliError(error, context = {}, exit = true) {
  const category = error.category || getErrorCategory(error);
  const suggestions = error.suggestions || getRecoverySuggestions(error, category, context);
  const docLink = getDocumentationLink(category, context);

  // Format error output
  console.error(chalk.red(`\n❌ ${error.message}`));

  if (suggestions && suggestions.length > 0) {
    console.error(chalk.yellow('\n💡 Suggestions:'));
    suggestions.forEach((suggestion) => {
      console.error(chalk.yellow(`   ${suggestion}`));
    });
  }

  console.error(chalk.blue(`\n📚 Documentation: ${docLink}`));

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
  getDocumentationLink,
  findSimilarCommand,
  COMMAND_SUGGESTIONS,
};
