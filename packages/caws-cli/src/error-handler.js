/**
 * @fileoverview CAWS CLI Error Handler - Centralized error handling utilities
 * Provides consistent error categorization, formatting, and recovery suggestions
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const {
  ERROR_CATEGORIES,
  getErrorCategory,
} = require('./utils/error-categories');

/**
 * Enhanced error class with category and recovery suggestions
 */
class CAWSError extends Error {
  constructor(message, category = null, suggestions = []) {
    super(message);
    this.name = 'CAWSError';
    this.category = category || getErrorCategory(message);
    this.suggestions = Array.isArray(suggestions) ? suggestions : [suggestions].filter(Boolean);
    this.timestamp = new Date();
    this.executionTime = null;
  }
}

/**
 * Execution timing utilities
 */
class ExecutionTimer {
  constructor() {
    this.startTime = null;
    this.endTime = null;
  }

  start() {
    this.startTime = process.hrtime.bigint();
  }

  end() {
    this.endTime = process.hrtime.bigint();
    return this.getDuration();
  }

  getDuration() {
    if (!this.startTime || !this.endTime) return 0;
    const durationNs = Number(this.endTime - this.startTime);
    return durationNs / 1_000_000; // Convert to milliseconds
  }

  formatDuration() {
    const ms = this.getDuration();
    if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
  }
}

/**
 * Wrap async operations with consistent error handling and timing
 * @param {Function} operation - Async operation to wrap
 * @param {string} context - Context for error messages
 * @param {boolean} includeTiming - Whether to include timing in results
 * @returns {Promise<any>} Operation result or throws handled error
 */
async function safeAsync(operation, context = '', includeTiming = false) {
  const timer = includeTiming ? new ExecutionTimer() : null;
  if (timer) timer.start();

  try {
    const result = await operation();

    if (includeTiming && timer && !isJsonOutput() && process.env.CAWS_QUIET !== '1') {
      const duration = timer.formatDuration();
      console.log(chalk.gray(`   (completed in ${duration})`));
    }

    return result;
  } catch (error) {
    if (timer) {
      error.executionTime = timer.formatDuration();
    }

    const category = getErrorCategory(error);
    const enhancedError = new CAWSError(
      `${context}: ${error.message}`,
      category,
      getRecoverySuggestions(error, category)
    );
    enhancedError.originalError = error;
    enhancedError.executionTime = error.executionTime;
    throw enhancedError;
  }
}

/**
 * Wrap sync operations with timing
 * @param {Function} operation - Sync operation to wrap
 * @param {string} context - Context for error messages
 * @param {boolean} includeTiming - Whether to include timing in results
 * @returns {any} Operation result or throws handled error
 */
function safeSync(operation, context = '', includeTiming = false) {
  const timer = includeTiming ? new ExecutionTimer() : null;
  if (timer) timer.start();

  try {
    const result = operation();

    if (includeTiming && timer && !isJsonOutput() && process.env.CAWS_QUIET !== '1') {
      const duration = timer.formatDuration();
      console.log(chalk.gray(`   (completed in ${duration})`));
    }

    return result;
  } catch (error) {
    if (timer) {
      error.executionTime = timer.formatDuration();
    }

    const category = getErrorCategory(error);
    const enhancedError = new CAWSError(
      `${context}: ${error.message}`,
      category,
      getRecoverySuggestions(error, category)
    );
    enhancedError.originalError = error;
    enhancedError.executionTime = error.executionTime;
    throw enhancedError;
  }
}

/**
 * Command-specific error suggestions
 */
// v11 command surface. Mirrors docs/architecture/caws-vnext-command-surface.md
// §2 — the eight v11.0 governed-core groups plus `specs` and `worktree`
// restored in v11.1. When v11.2 lands `agents` and bridge claims, extend
// this list in the same commit as the doctrine update.
const V11_COMMANDS = [
  'init',
  'doctor',
  'status',
  'scope',
  'claim',
  'gates',
  'evidence',
  'waiver',
  'specs',
  'worktree',
];

const COMMAND_SUGGESTIONS = {
  'unknown option': (option, command) => {
    const suggestions = [];

    const optionMap = {
      '--help': 'Try: caws --help or caws <command> --help',
      '--json': 'v11 commands accept --json for machine-readable output where supported',
    };

    if (optionMap[option]) {
      suggestions.push(optionMap[option]);
    } else {
      suggestions.push(`Try: caws ${command || ''} --help for available options`);
    }

    return suggestions;
  },

  'unknown command': (command) => {
    const similar = findSimilarCommand(command, V11_COMMANDS);

    const suggestions = [];
    if (similar) {
      suggestions.push(`Did you mean: caws ${similar}?`);
    }

    // Suggest category based on what the user might be trying to do.
    // Each branch points only at the v11 surface — no removed-command leakage.
    if (command.includes('setup') || command.includes('start')) {
      suggestions.push('For project setup: caws init');
    } else if (command.includes('new') || command.includes('create')) {
      suggestions.push('For a new spec: caws specs create <id>');
      suggestions.push('For a new worktree: caws worktree create <name> --spec <id>');
    } else if (
      command.includes('check') ||
      command.includes('verify') ||
      command.includes('valid')
    ) {
      suggestions.push('For drift detection: caws doctor');
      suggestions.push('For policy and quality gates: caws gates run --spec <id>');
      suggestions.push('For path scope: caws scope check <path>');
    } else if (command.includes('list') || command.includes('show') || command.includes('get')) {
      suggestions.push('For project status: caws status');
      suggestions.push('For specs: caws specs list / caws specs show <id>');
      suggestions.push('For worktrees: caws worktree list');
    } else if (command.includes('evidence') || command.includes('record')) {
      suggestions.push('To record test/gate/ac evidence: caws evidence record --type <kind> --spec <id> --data <json>');
    }

    suggestions.push(`Available v11 commands: ${V11_COMMANDS.join(', ')}`);
    suggestions.push('Try: caws --help for full command list with descriptions');

    return suggestions;
  },

  'not a caws project': () => [
    'Initialize CAWS first: caws init',
    'Verify .caws/ exists in the current directory',
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
      suggestions.push('Run: caws doctor for spec and policy drift detection');
      suggestions.push('Run: caws gates run --spec <id> for policy and quality gates');
      suggestions.push('Check .caws/specs/<id>.yaml against the spec schema in packages/caws-kernel');
      break;

    case ERROR_CATEGORIES.CONFIGURATION:
      suggestions.push('Run: caws init to bootstrap canonical .caws/ state (idempotent)');
      suggestions.push('Run: caws doctor to surface configuration drift');
      suggestions.push('Inspect .caws/ contents directly to confirm expected layout');
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
    // v11 doc anchors. Generic fallback to the architecture doctrine if a
    // specific command page is not yet authored.
    const doctrine = `${baseUrl}/docs/architecture/caws-vnext-command-surface.md`;
    const commandLinks = {
      init: doctrine,
      doctor: doctrine,
      status: doctrine,
      scope: doctrine,
      claim: doctrine,
      gates: doctrine,
      evidence: doctrine,
      waiver: doctrine,
      specs: doctrine,
      worktree: doctrine,
    };

    if (commandLinks[context.command]) {
      return commandLinks[context.command];
    }
  }

  return categoryLinks[category] || `${baseUrl}/docs/agents/full-guide.md`;
}

/**
 * JSON output formatter for programmatic use
 * @param {Object} data - Data to format as JSON
 * @param {boolean} pretty - Whether to pretty-print (default: true)
 */
function formatJsonOutput(data, pretty = true) {
  return JSON.stringify(data, null, pretty ? 2 : 0);
}

/**
 * Check if user requested JSON output
 * @returns {boolean} True if --json flag is present
 */
function isJsonOutput() {
  return (
    process.argv.includes('--json') ||
    process.argv.includes('-j') ||
    process.env.CAWS_OUTPUT_FORMAT === 'json'
  );
}

/**
 * Output data in appropriate format (JSON or human-readable)
 * @param {Object} data - Data to output
 * @param {boolean} success - Whether this is a success response
 */
function outputResult(data, success = true) {
  if (isJsonOutput()) {
    const jsonData = {
      success,
      timestamp: new Date().toISOString(),
      ...data,
    };
    console.log(formatJsonOutput(jsonData));
  } else {
    // Human-readable output (existing behavior)
    return data;
  }
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
  const troubleshootingGuide = suggestTroubleshootingGuide(error.message);

  if (isJsonOutput()) {
    // JSON output mode
    const jsonError = {
      success: false,
      error: {
        message: error.message,
        category,
        suggestions,
        documentation: docLink,
        executionTime: error.executionTime,
        timestamp: error.timestamp?.toISOString(),
        troubleshootingGuide: troubleshootingGuide
          ? getTroubleshootingGuide(troubleshootingGuide)
          : null,
      },
    };
    console.log(formatJsonOutput(jsonError));
  } else {
    // Human-readable output
    console.error(chalk.red(`\n${error.message}`));

    if (suggestions && suggestions.length > 0) {
      console.error(chalk.yellow('\nSuggestions:'));
      suggestions.forEach((suggestion) => {
        console.error(chalk.yellow(`   ${suggestion}`));
      });
    }

    // Add troubleshooting guide suggestion if available
    if (troubleshootingGuide) {
      const guide = getTroubleshootingGuide(troubleshootingGuide);
      console.error(chalk.cyan(`\nTroubleshooting Guide: ${guide.title}`));
      console.error(
        chalk.cyan(`   Run: caws troubleshoot ${troubleshootingGuide} for detailed guide`)
      );
    }

    console.error(chalk.blue(`\nDocumentation: ${docLink}`));
  }

  if (exit) {
    process.exit(1);
  }
}

/**
 * Troubleshooting guide system
 */
const TROUBLESHOOTING_GUIDES = {
  'coverage-report-not-found': {
    title: 'Coverage Report Not Found',
    symptoms: [
      'Coverage check fails with "report not found"',
      'Tests pass but coverage reports missing',
      'Jest/Vitest coverage not generating files',
    ],
    rootCauses: [
      'Tests not run with coverage flag',
      'Coverage output directory misconfigured',
      'Test framework not configured for coverage',
      'Working directory detection issue',
    ],
    solutions: [
      'Run tests with coverage: npm test -- --coverage --coverageReporters=json',
      'Check coverage configuration in package.json or jest.config.js',
      'Ensure coverage output directory exists',
      'Run from workspace directory in monorepos',
    ],
    commands: [
      'npm test -- --coverage --coverageReporters=json',
      'jest --coverage --coverageReporters=json',
      'vitest run --coverage',
      'caws status --verbose',
    ],
  },

  'mutation-report-not-found': {
    title: 'Mutation Report Not Found',
    symptoms: [
      'Mutation check fails with "report not found"',
      'Stryker mutation tests not generating reports',
      'Mutation testing configured but no results',
    ],
    rootCauses: [
      'Mutation tests not run',
      'Stryker configuration incorrect',
      'Report output path misconfigured',
      'Working directory detection issue',
    ],
    solutions: [
      'Run mutation tests: npx stryker run',
      'Check stryker.conf.json configuration',
      'Verify report output paths',
      'Run from workspace directory in monorepos',
    ],
    commands: [
      'npx stryker run',
      'npx stryker run --configFile stryker.conf.json',
      'caws status --verbose',
    ],
  },

  'spec-validation': {
    title: 'Spec Validation Errors',
    symptoms: [
      'A spec under .caws/specs/<id>.yaml fails to load',
      'doctor reports spec.schema errors',
      'Invalid risk tier, scope, or acceptance criteria',
    ],
    rootCauses: [
      'Invalid YAML syntax',
      'Missing required fields',
      'Incorrect schema structure',
      'Invalid scope paths (e.g., globs in scope.out)',
    ],
    solutions: [
      'Run: caws doctor — drift detection over .caws/ state',
      'Inspect the failing spec at .caws/specs/<id>.yaml directly',
      'Compare against existing specs in .caws/specs/ for shape',
      'See packages/caws-kernel for the canonical spec schema',
    ],
    commands: [
      'caws doctor',
      'caws specs show <id>',
      'caws specs list',
    ],
  },

  'monorepo-detection': {
    title: 'Monorepo Detection Issues',
    symptoms: [
      'CAWS not detecting workspace structure',
      'False positives about missing dependencies',
      'Commands fail from workspace directories',
    ],
    rootCauses: [
      'Unsupported monorepo tool (not npm/yarn/pnpm/lerna)',
      'Invalid workspace configuration',
      'Running from wrong directory',
      'Missing package.json files in workspaces',
    ],
    solutions: [
      'Verify workspace configuration in root package.json',
      'Ensure workspace directories contain package.json',
      'Run commands from workspace directories',
      'Check for supported monorepo tools',
    ],
    commands: [
      'cat package.json | grep workspaces',
      'find packages -name package.json',
      'caws doctor',
      'caws status',
    ],
  },
};

/**
 * Get troubleshooting guide for a specific issue
 * @param {string} issueKey - Key for the troubleshooting guide
 * @returns {Object|null} Troubleshooting guide or null if not found
 */
function getTroubleshootingGuide(issueKey) {
  return TROUBLESHOOTING_GUIDES[issueKey] || null;
}

/**
 * Get all available troubleshooting guides
 * @returns {Object} All troubleshooting guides
 */
function getAllTroubleshootingGuides() {
  return TROUBLESHOOTING_GUIDES;
}

/**
 * Suggest troubleshooting guide based on error message
 * @param {string} errorMessage - Error message to analyze
 * @returns {string|null} Issue key if match found, null otherwise
 */
function suggestTroubleshootingGuide(errorMessage) {
  const lowerMessage = errorMessage.toLowerCase();

  if (lowerMessage.includes('coverage') && lowerMessage.includes('not found')) {
    return 'coverage-report-not-found';
  }
  if (lowerMessage.includes('mutation') && lowerMessage.includes('not found')) {
    return 'mutation-report-not-found';
  }
  // 'spec' (per-feature .caws/specs/<id>.yaml) replaces the v10 'working spec' term.
  // Match either for compatibility with errors that quote either phrase.
  if (
    lowerMessage.includes('spec') ||
    lowerMessage.includes('validation') ||
    lowerMessage.includes('schema')
  ) {
    return 'spec-validation';
  }
  if (lowerMessage.includes('workspace') || lowerMessage.includes('monorepo')) {
    return 'monorepo-detection';
  }

  return null;
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
  ExecutionTimer,
  getErrorCategory,
  safeAsync,
  safeSync,
  handleCliError,
  validateEnvironment,
  getRecoverySuggestions,
  getDocumentationLink,
  findSimilarCommand,
  COMMAND_SUGGESTIONS,
  formatJsonOutput,
  isJsonOutput,
  outputResult,
  TROUBLESHOOTING_GUIDES,
  getTroubleshootingGuide,
  getAllTroubleshootingGuides,
  suggestTroubleshootingGuide,
};
