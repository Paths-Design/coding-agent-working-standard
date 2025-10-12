/**
 * @fileoverview Policy Manager with Intelligent Caching
 * Manages policy.yaml loading with caching, default fallback, and waiver validation.
 * Ported from agent-agency v2 CAWS integration patterns.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Policy Manager - Handles policy loading with intelligent caching
 *
 * Features:
 * - TTL-based caching for performance
 * - Graceful fallback to defaults when policy.yaml missing
 * - Cache inspection and management API
 * - Waiver validation and delta application
 */
class PolicyManager {
  constructor(options = {}) {
    this.enableCaching = options.enableCaching ?? true;
    this.cacheTTL = options.cacheTTL ?? 300000; // 5 minutes default
    this.policyCache = new Map(); // projectRoot -> { policy, cachedAt, ttl }
  }

  /**
   * Load CAWS policy from policy.yaml with caching
   *
   * @param {string} projectRoot - Project root directory
   * @param {Object} options - Loading options
   * @param {boolean} options.useCache - Use cache if available (default: true)
   * @param {number} options.cacheTTL - Cache TTL override in milliseconds
   * @returns {Promise<Object>} Policy object
   */
  async loadPolicy(projectRoot, options = {}) {
    const useCache = options.useCache ?? this.enableCaching;
    const cacheTTL = options.cacheTTL ?? this.cacheTTL;
    const startTime = Date.now();

    try {
      // Check cache first
      if (useCache && this.policyCache.has(projectRoot)) {
        const cached = this.policyCache.get(projectRoot);
        const cacheAge = Date.now() - cached.cachedAt;

        if (cacheAge < cacheTTL) {
          return {
            ...cached.policy,
            _cacheHit: true,
            _loadDuration: Date.now() - startTime,
          };
        }
      }

      // Load from file
      const policyPath = path.join(projectRoot, '.caws', 'policy.yaml');

      try {
        const content = await fs.readFile(policyPath, 'utf-8');
        const policy = yaml.load(content);

        // Validate policy structure
        this.validatePolicy(policy);

        // Update cache
        if (this.enableCaching) {
          this.policyCache.set(projectRoot, {
            policy,
            cachedAt: Date.now(),
            ttl: cacheTTL,
          });
        }

        return {
          ...policy,
          _cacheHit: false,
          _loadDuration: Date.now() - startTime,
        };
      } catch (error) {
        if (error.code === 'ENOENT') {
          // Policy file doesn't exist - use default
          const defaultPolicy = this.getDefaultPolicy();

          if (this.enableCaching) {
            this.policyCache.set(projectRoot, {
              policy: defaultPolicy,
              cachedAt: Date.now(),
              ttl: cacheTTL,
            });
          }

          return {
            ...defaultPolicy,
            _isDefault: true,
            _cacheHit: false,
            _loadDuration: Date.now() - startTime,
          };
        }
        throw error;
      }
    } catch (error) {
      throw new Error(`Policy load failed: ${error.message}`);
    }
  }

  /**
   * Load a waiver document by ID
   *
   * @param {string} waiverId - Waiver ID (e.g., WV-0001)
   * @param {string} projectRoot - Project root directory
   * @returns {Promise<Object|null>} Waiver document or null if not found
   */
  async loadWaiver(waiverId, projectRoot) {
    try {
      const waiverPath = path.join(projectRoot, '.caws', 'waivers', `${waiverId}.yaml`);

      const content = await fs.readFile(waiverPath, 'utf-8');
      return yaml.load(content);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return null;
      }
      throw new Error(`Failed to load waiver ${waiverId}: ${error.message}`);
    }
  }

  /**
   * Check if a waiver is currently valid
   *
   * @param {Object} waiver - Waiver document
   * @returns {boolean} True if waiver is valid and active
   */
  isWaiverValid(waiver) {
    if (!waiver) {
      return false;
    }

    // Check status
    if (waiver.status !== 'active') {
      return false;
    }

    // Check expiry
    if (waiver.expires_at) {
      const expiryDate = new Date(waiver.expires_at);
      const now = new Date();
      if (now > expiryDate) {
        return false;
      }
    }

    // Check if it has required approvals
    if (!waiver.approvers || waiver.approvers.length === 0) {
      return false;
    }

    return true;
  }

  /**
   * Apply waivers to baseline budget
   *
   * @param {Object} baseline - Baseline budget from policy
   * @param {string[]} waiverIds - Array of waiver IDs to apply
   * @param {string} projectRoot - Project root directory
   * @returns {Promise<Object>} Effective budget with waivers applied
   */
  async applyWaivers(baseline, waiverIds, projectRoot) {
    const effective = { ...baseline };
    const applied = [];

    for (const waiverId of waiverIds) {
      const waiver = await this.loadWaiver(waiverId, projectRoot);

      if (waiver && this.isWaiverValid(waiver)) {
        // Apply additive delta
        if (waiver.delta) {
          if (waiver.delta.max_files) {
            effective.max_files += waiver.delta.max_files;
          }
          if (waiver.delta.max_loc) {
            effective.max_loc += waiver.delta.max_loc;
          }
        }
        applied.push(waiverId);
      }
    }

    return {
      effective,
      applied,
    };
  }

  /**
   * Validate policy structure
   *
   * @param {Object} policy - Policy to validate
   * @throws {Error} If policy is invalid
   */
  validatePolicy(policy) {
    if (!policy.version) {
      throw new Error('Policy missing version field');
    }

    if (!policy.risk_tiers) {
      throw new Error('Policy missing risk_tiers configuration');
    }

    // Validate all tiers have required fields
    for (const tier of [1, 2, 3]) {
      const budget = policy.risk_tiers[tier];
      if (!budget) {
        throw new Error(`Policy missing risk tier ${tier} configuration`);
      }

      if (typeof budget.max_files !== 'number' || typeof budget.max_loc !== 'number') {
        throw new Error(`Risk tier ${tier} missing or invalid budget limits`);
      }
    }

    // Validate edit rules if present
    if (policy.edit_rules) {
      if (typeof policy.edit_rules.policy_and_code_same_pr !== 'boolean') {
        throw new Error('edit_rules.policy_and_code_same_pr must be boolean');
      }
      if (typeof policy.edit_rules.min_approvers_for_budget_raise !== 'number') {
        throw new Error('edit_rules.min_approvers_for_budget_raise must be number');
      }
    }
  }

  /**
   * Get default CAWS policy
   *
   * Returns sensible defaults when policy.yaml doesn't exist.
   *
   * @returns {Object} Default policy configuration
   */
  getDefaultPolicy() {
    return {
      version: 1,
      risk_tiers: {
        1: {
          max_files: 25,
          max_loc: 1000,
          description: 'Critical changes requiring manual review',
        },
        2: {
          max_files: 50,
          max_loc: 2000,
          description: 'Standard features with automated gates',
        },
        3: {
          max_files: 100,
          max_loc: 5000,
          description: 'Low-risk changes with minimal oversight',
        },
      },
      edit_rules: {
        policy_and_code_same_pr: false,
        min_approvers_for_budget_raise: 2,
        require_signed_commits: true,
      },
      gates: {
        budget_limit: {
          enabled: true,
          description: 'Enforce change budget limits',
        },
        spec_completeness: {
          enabled: true,
          description: 'Require complete working specifications',
        },
        contract_compliance: {
          enabled: true,
          description: 'Validate API contracts',
        },
        coverage_threshold: {
          enabled: true,
          description: 'Maintain test coverage requirements',
        },
        mutation_threshold: {
          enabled: true,
          description: 'Require mutation testing for T1/T2 changes',
        },
        security_scan: {
          enabled: true,
          description: 'Run security vulnerability scans',
        },
      },
    };
  }

  /**
   * Clear policy cache
   *
   * @param {string} [projectRoot] - Specific project to clear, or all if omitted
   */
  clearCache(projectRoot) {
    if (projectRoot) {
      this.policyCache.delete(projectRoot);
    } else {
      this.policyCache.clear();
    }
  }

  /**
   * Get cache status for a project
   *
   * @param {string} projectRoot - Project root directory
   * @returns {Object} Cache status information
   */
  getCacheStatus(projectRoot) {
    const cached = this.policyCache.get(projectRoot);

    if (!cached) {
      return {
        cached: false,
        ttl: this.cacheTTL,
      };
    }

    return {
      cached: true,
      age: Date.now() - cached.cachedAt,
      ttl: cached.ttl,
      remainingTTL: Math.max(0, cached.ttl - (Date.now() - cached.cachedAt)),
    };
  }

  /**
   * Reload policy from disk (bypassing cache)
   *
   * @param {string} projectRoot - Project root directory
   * @returns {Promise<Object>} Fresh policy
   */
  async reloadPolicy(projectRoot) {
    this.clearCache(projectRoot);
    return this.loadPolicy(projectRoot, { useCache: false });
  }

  /**
   * Get all cached projects
   *
   * @returns {string[]} Array of project roots with cached policies
   */
  getCachedProjects() {
    return Array.from(this.policyCache.keys());
  }

  /**
   * Get cache statistics
   *
   * @returns {Object} Cache statistics
   */
  getCacheStats() {
    const projects = this.getCachedProjects();
    const now = Date.now();

    const stats = {
      totalCached: projects.length,
      validCaches: 0,
      expiredCaches: 0,
      totalAge: 0,
    };

    for (const project of projects) {
      const cached = this.policyCache.get(project);
      const age = now - cached.cachedAt;

      stats.totalAge += age;

      if (age < cached.ttl) {
        stats.validCaches++;
      } else {
        stats.expiredCaches++;
      }
    }

    stats.averageAge = projects.length > 0 ? stats.totalAge / projects.length : 0;

    return stats;
  }
}

// Export singleton instance with default configuration
const defaultPolicyManager = new PolicyManager();

module.exports = {
  PolicyManager,
  defaultPolicyManager,

  // Convenience exports for backward compatibility
  loadPolicy: (projectRoot, options) => defaultPolicyManager.loadPolicy(projectRoot, options),
  clearCache: (projectRoot) => defaultPolicyManager.clearCache(projectRoot),
  getCacheStatus: (projectRoot) => defaultPolicyManager.getCacheStatus(projectRoot),
};
