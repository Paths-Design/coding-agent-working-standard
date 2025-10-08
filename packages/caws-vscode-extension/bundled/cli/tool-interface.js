#!/usr/bin/env node

/**
 * @fileoverview CAWS Tool Interface - Base classes and contracts for tool implementation
 * Defines the standard interface that all CAWS tools must implement
 * @author @darianrosebrook
 */

/**
 * Standard tool execution result
 * @typedef {Object} ToolExecutionResult
 * @property {boolean} success - Whether execution succeeded
 * @property {number} duration - Execution duration in milliseconds
 * @property {Object} output - Tool-specific output data
 * @property {Array<string>} errors - Error messages if execution failed
 * @property {Object} metadata - Additional execution metadata
 */

/**
 * Tool metadata structure
 * @typedef {Object} ToolMetadata
 * @property {string} id - Unique tool identifier
 * @property {string} name - Human-readable tool name
 * @property {string} version - Tool version (semver)
 * @property {string} description - Tool description
 * @property {Array<string>} capabilities - Tool capabilities (e.g., ['validation', 'security'])
 * @property {string} author - Tool author
 * @property {string} license - Tool license
 * @property {Array<string>} dependencies - Required Node.js dependencies
 */

/**
 * Tool execution context
 * @typedef {Object} ToolExecutionContext
 * @property {string} workingDirectory - Current working directory
 * @property {Object} environment - Environment variables
 * @property {Object} config - CAWS configuration
 * @property {Object} workingSpec - Current working specification
 * @property {number} timeout - Execution timeout in milliseconds
 */

/**
 * Base Tool class - All CAWS tools should extend this class
 */
class BaseTool {
  constructor() {
    this.metadata = this.getMetadata();
  }

  /**
   * Execute the tool with given parameters
   * @param {Object} parameters - Tool-specific execution parameters
   * @param {ToolExecutionContext} context - Execution context
   * @returns {Promise<ToolExecutionResult>} Execution result
   */
  async execute(parameters = {}, context = {}) {
    const startTime = Date.now();

    try {
      // Validate parameters
      this.validateParameters(parameters);

      // Execute tool logic
      const result = await this.executeImpl(parameters, context);

      // Ensure result conforms to interface
      const executionResult = this.normalizeResult(result, Date.now() - startTime);

      return executionResult;
    } catch (error) {
      return this.createErrorResult(error, Date.now() - startTime);
    }
  }

  /**
   * Get tool metadata
   * @returns {ToolMetadata} Tool metadata
   */
  getMetadata() {
    throw new Error('Tool must implement getMetadata() method');
  }

  /**
   * Validate tool parameters
   * @param {Object} _parameters - Parameters to validate
   * @throws {Error} If parameters are invalid
   */
  validateParameters(_parameters) {
    // Default implementation - override in subclasses
    return true;
  }

  /**
   * Execute tool implementation (must be overridden by subclasses)
   * @param {Object} _parameters - Tool parameters
   * @param {ToolExecutionContext} _context - Execution context
   * @returns {Promise<Object>} Tool-specific result
   */
  async executeImpl(_parameters, _context) {
    throw new Error('Tool must implement executeImpl() method');
  }

  /**
   * Normalize execution result to standard format
   * @private
   * @param {Object} result - Raw tool result
   * @param {number} duration - Execution duration
   * @returns {ToolExecutionResult} Normalized result
   */
  normalizeResult(result, duration) {
    return {
      success: result.success !== false,
      duration,
      output: result.output || result,
      errors: Array.isArray(result.errors) ? result.errors : [],
      metadata: result.metadata || {},
    };
  }

  /**
   * Create error result
   * @private
   * @param {Error} error - Execution error
   * @param {number} duration - Execution duration
   * @returns {ToolExecutionResult} Error result
   */
  createErrorResult(error, duration) {
    return {
      success: false,
      duration,
      output: null,
      errors: [error.message],
      metadata: {
        errorType: error.constructor.name,
        stack: error.stack,
      },
    };
  }
}

/**
 * Validation Tool base class - For tools that perform validation checks
 */
class ValidationTool extends BaseTool {
  constructor() {
    super();
    this.capabilities = ['validation'];
  }

  /**
   * Execute validation
   * @param {Object} parameters - Validation parameters
   * @param {ToolExecutionContext} context - Execution context
   * @returns {Promise<ToolExecutionResult>} Validation result
   */
  async executeImpl(parameters, context) {
    const validationResult = await this.validate(parameters, context);

    return {
      success: validationResult.valid,
      output: validationResult,
      errors: validationResult.errors || [],
      metadata: {
        checksRun: validationResult.checks?.length || 0,
        score: validationResult.score || 0,
      },
    };
  }

  /**
   * Perform validation (must be implemented by subclasses)
   * @param {Object} parameters - Validation parameters
   * @param {ToolExecutionContext} context - Execution context
   * @returns {Promise<Object>} Validation result
   */
  async validate(_parameters, _context) {
    throw new Error('ValidationTool must implement validate() method');
  }
}

/**
 * Quality Gate Tool base class - For tools that enforce quality standards
 */
class QualityGateTool extends ValidationTool {
  constructor() {
    super();
    this.capabilities = ['validation', 'quality-gates'];
  }

  /**
   * Get quality gate thresholds for current tier
   * @param {number} tier - Risk tier (1-3)
   * @returns {Object} Threshold configuration
   */
  getTierThresholds(tier) {
    const thresholds = {
      1: {
        // Tier 1 - Highest rigor
        coverage: 0.9,
        mutation: 0.7,
        contracts: true,
        manualReview: true,
      },
      2: {
        // Tier 2 - Standard rigor
        coverage: 0.8,
        mutation: 0.5,
        contracts: true,
        manualReview: false,
      },
      3: {
        // Tier 3 - Low rigor
        coverage: 0.7,
        mutation: 0.3,
        contracts: false,
        manualReview: false,
      },
    };

    return thresholds[tier] || thresholds[2];
  }
}

/**
 * Security Tool base class - For tools that perform security checks
 */
class SecurityTool extends ValidationTool {
  constructor() {
    super();
    this.capabilities = ['validation', 'security'];
  }

  /**
   * Check for security violations
   * @param {Object} target - Target to check (file, code, etc.)
   * @returns {Promise<Array<Object>>} Array of security violations
   */
  async checkSecurityViolations(target) {
    const violations = [];

    // Check for common security patterns
    const patterns = [
      { name: 'hardcoded_secrets', pattern: /password|token|key|secret/i, severity: 'high' },
      { name: 'unsafe_eval', pattern: /eval\(|Function\(/, severity: 'high' },
      { name: 'dangerous_modules', pattern: /child_process|fs-extra/, severity: 'medium' },
    ];

    for (const { name, pattern, severity } of patterns) {
      if (pattern.test(target)) {
        violations.push({ name, severity, message: `${name} pattern detected` });
      }
    }

    return violations;
  }
}

/**
 * Utility functions for tool development
 */
const ToolUtils = {
  /**
   * Create standardized success result
   * @param {Object} output - Tool output
   * @param {Object} metadata - Additional metadata
   * @returns {ToolExecutionResult} Success result
   */
  createSuccessResult(output = {}, metadata = {}) {
    return {
      success: true,
      duration: 0, // Will be set by BaseTool
      output,
      errors: [],
      metadata,
    };
  },

  /**
   * Create standardized error result
   * @param {string} message - Error message
   * @param {string} errorType - Error type
   * @returns {ToolExecutionResult} Error result
   */
  createErrorResult(message, errorType = 'ToolError') {
    return {
      success: false,
      duration: 0, // Will be set by BaseTool
      output: null,
      errors: [message],
      metadata: { errorType },
    };
  },

  /**
   * Validate required parameters
   * @param {Object} _params - Parameters object
   * @param {Array<string>} _required - Required parameter names
   * @throws {Error} If required parameters are missing
   */
  validateRequired(_params, _required) {
    const missing = _required.filter((key) => !_params[key]);
    if (missing.length > 0) {
      throw new Error(`Missing required parameters: ${missing.join(', ')}`);
    }
  },
};

module.exports = {
  BaseTool,
  ValidationTool,
  QualityGateTool,
  SecurityTool,
  ToolUtils,
};
