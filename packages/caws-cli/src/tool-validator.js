#!/usr/bin/env node

/**
 * @fileoverview CAWS Tool Validator - Security validation for dynamically loaded tools
 * Validates tools against allowlists, scans for security violations, and ensures safe execution
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Tool Validator - Security validation and allowlist enforcement
 */
class ToolValidator {
  constructor(options = {}) {
    // Check new location first, fall back to legacy location
    const newAllowlistPath = path.join(process.cwd(), '.caws/tools-allow.json');
    const legacyAllowlistPath = path.join(process.cwd(), 'apps/tools/caws/tools-allow.json');
    const defaultAllowlistPath = fs.existsSync(newAllowlistPath)
      ? newAllowlistPath
      : legacyAllowlistPath;

    this.options = {
      allowlistPath: options.allowlistPath || defaultAllowlistPath,
      strictMode: options.strictMode !== false,
      maxFileSize: options.maxFileSize || 1024 * 1024, // 1MB
      ...options,
    };

    this.allowlist = null;
    this.validationCache = new Map();
  }

  /**
   * Load and parse the tools allowlist
   * @returns {Promise<Array<string>>} Array of allowed commands/patterns
   */
  async loadAllowlist() {
    if (this.allowlist) return this.allowlist;

    try {
      if (!fs.existsSync(this.options.allowlistPath)) {
        throw new Error(`Allowlist file not found: ${this.options.allowlistPath}`);
      }

      const content = await fs.promises.readFile(this.options.allowlistPath, 'utf8');
      this.allowlist = JSON.parse(content);

      if (!Array.isArray(this.allowlist)) {
        throw new Error('Allowlist must be an array of strings');
      }

      return this.allowlist;
    } catch (error) {
      throw new Error(`Failed to load allowlist: ${error.message}`);
    }
  }

  /**
   * Validate a tool against security requirements
   * @param {Object} tool - Tool object with module and metadata
   * @returns {Promise<Object>} Validation result
   */
  async validateTool(tool) {
    const toolId = tool.metadata?.id || path.basename(tool.path, '.js');
    const cacheKey = crypto
      .createHash('md5')
      .update(toolId + tool.loadedAt)
      .digest('hex');

    // Check cache first
    if (this.validationCache.has(cacheKey)) {
      return this.validationCache.get(cacheKey);
    }

    const result = {
      valid: true,
      checks: [],
      warnings: [],
      errors: [],
      score: 100,
    };

    try {
      // Load allowlist if not loaded
      await this.loadAllowlist();

      // Run all validation checks
      const checks = await Promise.allSettled([
        this.checkFileSecurity(tool),
        this.checkCodeSecurity(tool),
        this.checkInterfaceCompliance(tool),
        this.checkMetadataValidity(tool),
        this.checkDependencySafety(tool),
      ]);

      // Process check results
      checks.forEach((check, index) => {
        const checkName = [
          'fileSecurity',
          'codeSecurity',
          'interfaceCompliance',
          'metadataValidity',
          'dependencySafety',
        ][index];

        if (check.status === 'fulfilled') {
          const checkResult = check.value;
          result.checks.push({
            name: checkName,
            passed: checkResult.passed,
            message: checkResult.message,
            severity: checkResult.severity || 'info',
          });

          if (!checkResult.passed) {
            result.valid = false;
            if (checkResult.severity === 'error') {
              result.errors.push(checkResult.message);
              result.score -= 20;
            } else {
              result.warnings.push(checkResult.message);
              result.score -= 5;
            }
          }
        } else {
          result.checks.push({
            name: checkName,
            passed: false,
            message: `Check failed: ${check.reason.message}`,
            severity: 'error',
          });
          result.valid = false;
          result.errors.push(check.reason.message);
          result.score -= 20;
        }
      });

      // Cache result
      this.validationCache.set(cacheKey, result);
    } catch (error) {
      result.valid = false;
      result.errors.push(`Validation failed: ${error.message}`);
      result.score = 0;
    }

    return result;
  }

  /**
   * Check file-level security
   * @private
   * @param {Object} tool - Tool object
   */
  async checkFileSecurity(tool) {
    const issues = [];

    try {
      const stats = await fs.promises.stat(tool.path);

      // Check file size
      if (stats.size > this.options.maxFileSize) {
        issues.push(`File too large: ${stats.size} bytes > ${this.options.maxFileSize} bytes`);
      }

      // Check file permissions (should be readable)
      const mode = stats.mode;
      if (!(mode & parseInt('0444', 8))) {
        // Owner, group, others can read
        issues.push('File permissions too restrictive');
      }

      // Check if file is executable (should not be)
      if (mode & parseInt('0111', 8)) {
        // Execute permissions
        issues.push('Tool file should not have execute permissions');
      }
    } catch (error) {
      issues.push(`File access error: ${error.message}`);
    }

    return {
      passed: issues.length === 0,
      message: issues.length > 0 ? issues.join('; ') : 'File security check passed',
      severity: issues.length > 0 ? 'error' : 'info',
    };
  }

  /**
   * Check code-level security
   * @private
   * @param {Object} tool - Tool object
   */
  async checkCodeSecurity(tool) {
    const issues = [];

    try {
      const content = await fs.promises.readFile(tool.path, 'utf8');

      // Check for dangerous patterns
      const dangerousPatterns = [
        { pattern: /require\(['"`]child_process['"`]\)/g, message: 'Direct child_process usage' },
        { pattern: /require\(['"`]fs['"`]\)\.writeFileSync/g, message: 'Synchronous file writing' },
        { pattern: /process\.exit\(/g, message: 'Process termination' },
        { pattern: /eval\(/g, message: 'Code evaluation' },
        { pattern: /Function\(['"`]/g, message: 'Dynamic function creation' },
        { pattern: /require\(['"`]\.\./g, message: 'Directory traversal in require' },
      ];

      dangerousPatterns.forEach(({ pattern, message }) => {
        const matches = content.match(pattern);
        if (matches) {
          issues.push(`${message} (${matches.length} occurrences)`);
        }
      });

      // Check for secrets (basic pattern matching)
      const secretPatterns = [
        /password\s*[=:]\s*['"`][^'"]{8,}['"`]/gi,
        /token\s*[=:]\s*['"`][^'"]{20,}['"`]/gi,
        /key\s*[=:]\s*['"`][^'"]{16,}['"`]/gi,
        /secret\s*[=:]\s*['"`][^'"]{16,}['"`]/gi,
      ];

      secretPatterns.forEach((pattern) => {
        if (content.match(pattern)) {
          issues.push('Potential hardcoded secrets detected');
        }
      });
    } catch (error) {
      issues.push(`Code analysis error: ${error.message}`);
    }

    return {
      passed: issues.length === 0,
      message:
        issues.length > 0 ? `Security issues: ${issues.join('; ')}` : 'Code security check passed',
      severity: issues.length > 0 ? 'error' : 'info',
    };
  }

  /**
   * Check interface compliance
   * @private
   * @param {Object} tool - Tool object
   */
  async checkInterfaceCompliance(tool) {
    const requiredMethods = ['execute', 'getMetadata'];
    const missingMethods = [];

    requiredMethods.forEach((method) => {
      if (typeof tool.module[method] !== 'function') {
        missingMethods.push(method);
      }
    });

    return {
      passed: missingMethods.length === 0,
      message:
        missingMethods.length > 0
          ? `Missing required methods: ${missingMethods.join(', ')}`
          : 'Interface compliance check passed',
      severity: missingMethods.length > 0 ? 'error' : 'info',
    };
  }

  /**
   * Check metadata validity
   * @private
   * @param {Object} tool - Tool object
   */
  async checkMetadataValidity(tool) {
    const metadata = tool.metadata || {};
    const requiredFields = ['id', 'name', 'version'];
    const missingFields = [];
    const invalidFields = [];

    // Check required fields
    requiredFields.forEach((field) => {
      if (!metadata[field]) {
        missingFields.push(field);
      }
    });

    // Validate field types and formats
    if (metadata.id && typeof metadata.id !== 'string') {
      invalidFields.push('id must be string');
    }
    if (metadata.name && typeof metadata.name !== 'string') {
      invalidFields.push('name must be string');
    }
    if (metadata.version && typeof metadata.version !== 'string') {
      invalidFields.push('version must be string');
    }
    if (metadata.capabilities && !Array.isArray(metadata.capabilities)) {
      invalidFields.push('capabilities must be array');
    }

    const issues = [...missingFields.map((f) => `missing ${f}`), ...invalidFields];

    return {
      passed: issues.length === 0,
      message:
        issues.length > 0
          ? `Metadata issues: ${issues.join(', ')}`
          : 'Metadata validity check passed',
      severity: issues.length > 0 ? 'error' : 'info',
    };
  }

  /**
   * Check dependency safety
   * @private
   * @param {Object} tool - Tool object
   */
  async checkDependencySafety(tool) {
    const metadata = tool.metadata || {};
    const issues = [];

    if (metadata.dependencies) {
      if (!Array.isArray(metadata.dependencies)) {
        issues.push('dependencies must be array');
      } else {
        // Check for potentially unsafe dependencies
        const unsafeDeps = ['child_process', 'fs-extra', 'execa', 'shelljs'];
        const foundUnsafe = metadata.dependencies.filter((dep) =>
          unsafeDeps.some((unsafe) => dep.includes(unsafe))
        );

        if (foundUnsafe.length > 0) {
          issues.push(`Potentially unsafe dependencies: ${foundUnsafe.join(', ')}`);
        }
      }
    }

    return {
      passed: issues.length === 0,
      message:
        issues.length > 0
          ? `Dependency issues: ${issues.join('; ')}`
          : 'Dependency safety check passed',
      severity: issues.length > 0 ? 'warning' : 'info',
    };
  }

  /**
   * Validate a command against the allowlist
   * @param {string} command - Command to validate
   * @returns {boolean} True if command is allowed
   */
  async validateCommand(command) {
    const allowlist = await this.loadAllowlist();

    // Check exact matches first
    if (allowlist.includes(command)) {
      return true;
    }

    // Check pattern matches
    return allowlist.some((allowed) => {
      if (allowed.includes('*')) {
        // Simple wildcard matching
        const regex = new RegExp(allowed.replace(/\*/g, '.*'));
        return regex.test(command);
      }
      return false;
    });
  }

  /**
   * Clear validation cache
   */
  clearCache() {
    this.validationCache.clear();
  }

  /**
   * Get validator statistics
   * @returns {Object} Statistics object
   */
  getStats() {
    return {
      allowlistLoaded: this.allowlist !== null,
      allowlistSize: this.allowlist?.length || 0,
      cacheSize: this.validationCache.size,
      strictMode: this.options.strictMode,
    };
  }
}

module.exports = ToolValidator;
