/**
 * @fileoverview Quality Gates Error Taxonomy
 * Comprehensive error handling for CAWS quality gates with structured error types,
 * recovery strategies, and audit trails.
 *
 * @author @darianrosebrook
 * @ts-nocheck
 */

const crypto = require('crypto');

/**
 * Quality Gates Error Categories
 */
const ERROR_CATEGORIES = {
  VALIDATION: 'validation',
  CONFIGURATION: 'configuration',
  EXECUTION: 'execution',
  NETWORK: 'network',
  SECURITY: 'security',
  PERFORMANCE: 'performance',
  BUSINESS_LOGIC: 'business_logic',
  INFRASTRUCTURE: 'infrastructure',
  DATA: 'data',
  TIMEOUT: 'timeout',
  INTERNAL: 'internal',
};

/**
 * Error Severity Levels
 */
const ERROR_SEVERITY = {
  DEBUG: 'debug',
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical',
  FATAL: 'fatal',
};

/**
 * Recovery Strategies
 */
const RECOVERY_STRATEGIES = {
  RETRY: 'retry',
  FALLBACK: 'fallback',
  SKIP: 'skip',
  ESCALATE: 'escalate',
  MANUAL_INTERVENTION: 'manual_intervention',
  AUTO_FIX: 'auto_fix',
  WAIVER: 'waiver',
};

/**
 * Quality Gates Error Class
 * @typedef {Object} QualityGatesErrorOptions
 * @property {string} category
 * @property {string} code
 * @property {string} message
 * @property {string} [severity]
 * @property {string} [component]
 * @property {string} [operation]
 * @property {Object} [context]
 * @property {string[]} [recoveryStrategies]
 * @property {boolean} [retryable]
 * @property {string|null} [correlationId]
 * @property {string[]} [errorChain]
 */
class QualityGatesError extends Error {
  /**
   * @param {QualityGatesErrorOptions} options
   */
  constructor(options) {
    const {
      category,
      code,
      message,
      severity = ERROR_SEVERITY.ERROR,
      component = 'quality-gates',
      operation = 'unknown',
      context = {},
      recoveryStrategies = [],
      retryable = false,
      correlationId = null,
      errorChain = [],
    } = options;

    super(message);

    this.name = 'QualityGatesError';
    this.errorId = `qg-err-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    this.category = category;
    this.code = code;
    this.severity = severity;
    this.component = component;
    this.operation = operation;
    this.context = context;
    this.recoveryStrategies = recoveryStrategies;
    this.retryable = retryable;
    this.correlationId = correlationId;
    this.errorChain = errorChain;
    this.timestamp = new Date().toISOString();
    this.stack = this.stack || new Error().stack;
  }

  /**
   * Add context to the error
   */
  withContext(key, value) {
    this.context[key] = value;
    return this;
  }

  /**
   * Add a recovery strategy
   */
  withRecoveryStrategy(strategy) {
    this.recoveryStrategies.push(strategy);
    return this;
  }

  /**
   * Mark as retryable
   */
  retryable(retryable) {
    this.retryable = retryable;
    return this;
  }

  /**
   * Set correlation ID for tracing
   */
  withCorrelationId(correlationId) {
    this.correlationId = correlationId;
    return this;
  }

  /**
   * Add to error chain
   */
  withErrorChain(previousError) {
    this.errorChain.push(previousError);
    return this;
  }

  /**
   * Convert to JSON for logging
   */
  toJSON() {
    return {
      errorId: this.errorId,
      name: this.name,
      category: this.category,
      code: this.code,
      message: this.message,
      severity: this.severity,
      component: this.component,
      operation: this.operation,
      context: this.context,
      recoveryStrategies: this.recoveryStrategies,
      retryable: this.retryable,
      correlationId: this.correlationId,
      errorChain: this.errorChain,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  /**
   * Get human-readable error summary
   */
  getSummary() {
    return `[${this.category.toUpperCase()}] ${this.code}: ${this.message}`;
  }

  /**
   * Check if error requires human intervention
   */
  requiresHumanIntervention() {
    return (
      this.recoveryStrategies.includes(RECOVERY_STRATEGIES.MANUAL_INTERVENTION) ||
      this.recoveryStrategies.includes(RECOVERY_STRATEGIES.ESCALATE) ||
      this.severity === ERROR_SEVERITY.FATAL
    );
  }

  /**
   * Check if error can be auto-recovered
   */
  canAutoRecover() {
    return (
      this.recoveryStrategies.includes(RECOVERY_STRATEGIES.AUTO_FIX) ||
      this.recoveryStrategies.includes(RECOVERY_STRATEGIES.RETRY) ||
      this.recoveryStrategies.includes(RECOVERY_STRATEGIES.FALLBACK)
    );
  }
}

/**
 * Specific Error Types for Quality Gates
 */

/**
 * God Object Detection Errors
 */
class GodObjectError extends QualityGatesError {
  constructor(file, lineCount, threshold, options = {}) {
    super({
      category: ERROR_CATEGORIES.BUSINESS_LOGIC,
      code: 'GOD_OBJECT_DETECTED',
      message: `God object detected: ${file} has ${lineCount} lines (threshold: ${threshold})`,
      severity: lineCount > threshold * 1.5 ? ERROR_SEVERITY.CRITICAL : ERROR_SEVERITY.ERROR,
      component: 'god-object-detector',
      operation: 'analyze_file_size',
      context: {
        file,
        lineCount,
        threshold,
        fileSizeKB: options.fileSizeKB,
        relativePath: options.relativePath,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.MANUAL_INTERVENTION, RECOVERY_STRATEGIES.WAIVER],
      retryable: false,
      ...options,
    });
  }
}

/**
 * Hidden TODO Detection Errors
 */
class HiddenTodoError extends QualityGatesError {
  constructor(file, todoCount, confidence, options = {}) {
    super({
      category: ERROR_CATEGORIES.BUSINESS_LOGIC,
      code: 'HIDDEN_TODOS_DETECTED',
      message: `Hidden TODOs detected: ${file} has ${todoCount} TODOs (confidence: ${confidence})`,
      severity: confidence > 0.9 ? ERROR_SEVERITY.CRITICAL : ERROR_SEVERITY.ERROR,
      component: 'todo-analyzer',
      operation: 'analyze_hidden_todos',
      context: {
        file,
        todoCount,
        confidence,
        blockingTodos: options.blockingTodos || 0,
        nonBlockingTodos: options.nonBlockingTodos || 0,
      },
      recoveryStrategies: [
        RECOVERY_STRATEGIES.MANUAL_INTERVENTION,
        RECOVERY_STRATEGIES.WAIVER,
        RECOVERY_STRATEGIES.AUTO_FIX,
      ],
      retryable: false,
      ...options,
    });
  }
}

/**
 * Configuration Errors
 */
class ConfigurationError extends QualityGatesError {
  constructor(configKey, expectedType, actualValue, options = {}) {
    super({
      category: ERROR_CATEGORIES.CONFIGURATION,
      code: 'INVALID_CONFIGURATION',
      message: `Invalid configuration: ${configKey} expected ${expectedType}, got ${typeof actualValue}`,
      severity: ERROR_SEVERITY.ERROR,
      component: 'config-manager',
      operation: 'validate_config',
      context: {
        configKey,
        expectedType,
        actualValue,
        configFile: options.configFile,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.MANUAL_INTERVENTION, RECOVERY_STRATEGIES.FALLBACK],
      retryable: false,
      ...options,
    });
  }
}

/**
 * Waiver Validation Errors
 */
class WaiverError extends QualityGatesError {
  constructor(waiverId, reason, options = {}) {
    super({
      category: ERROR_CATEGORIES.VALIDATION,
      code: 'INVALID_WAIVER',
      message: `Invalid waiver: ${waiverId} - ${reason}`,
      severity: ERROR_SEVERITY.WARNING,
      component: 'waiver-manager',
      operation: 'validate_waiver',
      context: {
        waiverId,
        reason,
        expiresAt: options.expiresAt,
        gates: options.gates,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.MANUAL_INTERVENTION, RECOVERY_STRATEGIES.SKIP],
      retryable: false,
      ...options,
    });
  }
}

/**
 * Execution Errors
 */
class ExecutionError extends QualityGatesError {
  constructor(command, exitCode, stderr, options = {}) {
    super({
      category: ERROR_CATEGORIES.EXECUTION,
      code: 'COMMAND_FAILED',
      message: `Command failed: ${command} (exit code: ${exitCode})`,
      severity: ERROR_SEVERITY.ERROR,
      component: 'command-executor',
      operation: 'execute_command',
      context: {
        command,
        exitCode,
        stderr,
        stdout: options.stdout,
        workingDirectory: options.workingDirectory,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.RETRY, RECOVERY_STRATEGIES.MANUAL_INTERVENTION],
      retryable: true,
      ...options,
    });
  }
}

/**
 * Network/External Service Errors
 */
class NetworkError extends QualityGatesError {
  constructor(url, statusCode, response, options = {}) {
    super({
      category: ERROR_CATEGORIES.NETWORK,
      code: 'NETWORK_REQUEST_FAILED',
      message: `Network request failed: ${url} (status: ${statusCode})`,
      severity: statusCode >= 500 ? ERROR_SEVERITY.ERROR : ERROR_SEVERITY.WARNING,
      component: 'network-client',
      operation: 'make_request',
      context: {
        url,
        statusCode,
        response,
        method: options.method,
        headers: options.headers,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.RETRY, RECOVERY_STRATEGIES.FALLBACK],
      retryable: true,
      ...options,
    });
  }
}

/**
 * File System Errors
 */
class FileSystemError extends QualityGatesError {
  constructor(operation, filePath, originalError, options = {}) {
    super({
      category: ERROR_CATEGORIES.INFRASTRUCTURE,
      code: 'FILE_SYSTEM_ERROR',
      message: `File system error: ${operation} failed for ${filePath}`,
      severity: ERROR_SEVERITY.ERROR,
      component: 'file-system',
      operation,
      context: {
        filePath,
        originalError: originalError.message,
        errorCode: originalError.code,
        permissions: options.permissions,
      },
      recoveryStrategies: [RECOVERY_STRATEGIES.RETRY, RECOVERY_STRATEGIES.MANUAL_INTERVENTION],
      retryable: true,
      ...options,
    });
  }
}

/**
 * Error Factory Functions
 */

/**
 * Create a god object error
 */
function createGodObjectError(file, lineCount, threshold, options = {}) {
  return new GodObjectError(file, lineCount, threshold, options);
}

/**
 * Create a hidden TODO error
 */
function createHiddenTodoError(file, todoCount, confidence, options = {}) {
  return new HiddenTodoError(file, todoCount, confidence, options);
}

/**
 * Create a configuration error
 */
function createConfigurationError(configKey, expectedType, actualValue, options = {}) {
  return new ConfigurationError(configKey, expectedType, actualValue, options);
}

/**
 * Create a waiver error
 */
function createWaiverError(waiverId, reason, options = {}) {
  return new WaiverError(waiverId, reason, options);
}

/**
 * Create an execution error
 */
function createExecutionError(command, exitCode, stderr, options = {}) {
  return new ExecutionError(command, exitCode, stderr, options);
}

/**
 * Create a network error
 */
function createNetworkError(url, statusCode, response, options = {}) {
  return new NetworkError(url, statusCode, response, options);
}

/**
 * Create a file system error
 */
function createFileSystemError(operation, filePath, originalError, options = {}) {
  return new FileSystemError(operation, filePath, originalError, options);
}

/**
 * Error Classification Utilities
 */

/**
 * Classify an error by its properties
 */
function classifyError(error) {
  const classification = {
    category: ERROR_CATEGORIES.INTERNAL,
    severity: ERROR_SEVERITY.ERROR,
    retryable: false,
    requiresHumanIntervention: false,
    canAutoRecover: false,
  };

  if (error instanceof QualityGatesError) {
    classification.category = error.category;
    classification.severity = error.severity;
    classification.retryable = error.retryable;
    classification.requiresHumanIntervention = error.requiresHumanIntervention();
    classification.canAutoRecover = error.canAutoRecover();
  }

  return classification;
}

/**
 * Get error statistics from a collection of errors
 */
function getErrorStatistics(errors) {
  const stats = {
    total: errors.length,
    byCategory: {},
    bySeverity: {},
    retryable: 0,
    requiresHumanIntervention: 0,
    canAutoRecover: 0,
  };

  errors.forEach((error) => {
    const classification = classifyError(error);

    // Count by category
    stats.byCategory[classification.category] =
      (stats.byCategory[classification.category] || 0) + 1;

    // Count by severity
    stats.bySeverity[classification.severity] =
      (stats.bySeverity[classification.severity] || 0) + 1;

    // Count flags
    if (classification.retryable) stats.retryable++;
    if (classification.requiresHumanIntervention) stats.requiresHumanIntervention++;
    if (classification.canAutoRecover) stats.canAutoRecover++;
  });

  return stats;
}

module.exports = {
  QualityGatesError,
  GodObjectError,
  HiddenTodoError,
  ConfigurationError,
  WaiverError,
  ExecutionError,
  NetworkError,
  FileSystemError,
  ERROR_CATEGORIES,
  ERROR_SEVERITY,
  RECOVERY_STRATEGIES,
  createGodObjectError,
  createHiddenTodoError,
  createConfigurationError,
  createWaiverError,
  createExecutionError,
  createNetworkError,
  createFileSystemError,
  classifyError,
  getErrorStatistics,
};
