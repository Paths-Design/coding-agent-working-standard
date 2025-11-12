/**
 * @fileoverview Budget Derivation Logic
 * Derives budgets from policy.yaml and applies waivers
 * Enhanced with PolicyManager for caching and improved performance
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { defaultPolicyManager } = require('./policy/PolicyManager');

/**
 * Validate policy structure and content
 * @param {Object} policy - Policy object from policy.yaml
 * @throws {Error} If policy is invalid
 */
function validatePolicy(policy) {
  // Validate version
  if (!policy.version) {
    throw new Error(
      'Policy missing version field\n' +
        'Add "version: 1" to .caws/policy.yaml\n' +
        'Run "caws init" to regenerate policy.yaml'
    );
  }

  // Validate risk_tiers exists
  if (!policy.risk_tiers) {
    throw new Error(
      'Policy missing risk_tiers configuration\n' +
        'Policy must define risk tiers 1, 2, and 3\n' +
        'Run "caws init" to regenerate policy.yaml'
    );
  }

  // Validate each required tier
  for (const tier of [1, 2, 3]) {
    if (!policy.risk_tiers[tier]) {
      throw new Error(
        `Policy missing configuration for risk tier ${tier}\n` +
          `Add risk_tiers.${tier} with max_files and max_loc to .caws/policy.yaml\n` +
          'Run "caws init" to regenerate policy.yaml'
      );
    }

    const tierConfig = policy.risk_tiers[tier];

    // Validate max_files
    if (!tierConfig.max_files || tierConfig.max_files <= 0) {
      throw new Error(
        `Invalid max_files for tier ${tier}: ${tierConfig.max_files}\n` +
          `max_files must be a positive integer\n` +
          `Fix in .caws/policy.yaml under risk_tiers.${tier}.max_files`
      );
    }

    // Validate max_loc
    if (!tierConfig.max_loc || tierConfig.max_loc <= 0) {
      throw new Error(
        `Invalid max_loc for tier ${tier}: ${tierConfig.max_loc}\n` +
          `max_loc must be a positive integer\n` +
          `Fix in .caws/policy.yaml under risk_tiers.${tier}.max_loc`
      );
    }

    // Validate thresholds if present
    if (
      tierConfig.coverage_threshold !== undefined &&
      (tierConfig.coverage_threshold < 0 || tierConfig.coverage_threshold > 100)
    ) {
      throw new Error(
        `Invalid coverage_threshold for tier ${tier}: ${tierConfig.coverage_threshold}\n` +
          `coverage_threshold must be between 0 and 100\n` +
          `Fix in .caws/policy.yaml under risk_tiers.${tier}.coverage_threshold`
      );
    }

    if (
      tierConfig.mutation_threshold !== undefined &&
      (tierConfig.mutation_threshold < 0 || tierConfig.mutation_threshold > 100)
    ) {
      throw new Error(
        `Invalid mutation_threshold for tier ${tier}: ${tierConfig.mutation_threshold}\n` +
          `mutation_threshold must be between 0 and 100\n` +
          `Fix in .caws/policy.yaml under risk_tiers.${tier}.mutation_threshold`
      );
    }
  }

  // Validate waiver_approval if present
  if (policy.waiver_approval) {
    if (
      policy.waiver_approval.required_approvers !== undefined &&
      policy.waiver_approval.required_approvers < 0
    ) {
      throw new Error(
        `Invalid waiver_approval.required_approvers: ${policy.waiver_approval.required_approvers}\n` +
          'required_approvers must be a non-negative integer'
      );
    }

    if (
      policy.waiver_approval.max_duration_days !== undefined &&
      policy.waiver_approval.max_duration_days <= 0
    ) {
      throw new Error(
        `Invalid waiver_approval.max_duration_days: ${policy.waiver_approval.max_duration_days}\n` +
          'max_duration_days must be a positive integer'
      );
    }
  }
}

/**
 * Get default policy as fallback
 * @returns {Object} Default CAWS policy
 */
function getDefaultPolicy() {
  return {
    version: 1,
    risk_tiers: {
      1: {
        max_files: 25,
        max_loc: 1000,
        coverage_threshold: 90,
        mutation_threshold: 70,
        contracts_required: true,
        manual_review_required: true,
        description: 'Critical changes requiring manual review',
      },
      2: {
        max_files: 50,
        max_loc: 2000,
        coverage_threshold: 80,
        mutation_threshold: 50,
        contracts_required: true,
        manual_review_required: false,
        description: 'Standard features with automated gates',
      },
      3: {
        max_files: 100,
        max_loc: 5000,
        coverage_threshold: 70,
        mutation_threshold: 30,
        contracts_required: false,
        manual_review_required: false,
        description: 'Low-risk changes with minimal oversight',
      },
    },
    waiver_approval: {
      required_approvers: 1,
      max_duration_days: 90,
      auto_revoke_expired: true,
    },
  };
}

/**
 * Derive budget for a working spec based on policy and waivers
 * Enhanced to use PolicyManager for caching
 * @param {Object} spec - Working spec object
 * @param {string} projectRoot - Project root directory
 * @param {Object} options - Derivation options
 * @param {boolean} options.useCache - Use cached policy (default: true)
 * @returns {Object} Derived budget with baseline and effective limits
 */
async function deriveBudget(spec, projectRoot = process.cwd(), options = {}) {
  try {
    // Load policy using PolicyManager (with caching)
    const policyResult = await defaultPolicyManager.loadPolicy(projectRoot, {
      useCache: options.useCache !== false,
    });

    const policy = policyResult;

    // Check if using default policy
    if (policy._isDefault) {
      const expectedPath = path.join(projectRoot, '.caws', 'policy.yaml');
      const policyExists = fs.existsSync(expectedPath);

      if (policyExists) {
        console.error(
          '⚠️  Policy file exists but not loaded: ' +
            expectedPath +
            '\n' +
            '   Current working directory: ' +
            process.cwd() +
            '\n' +
            '   Project root: ' +
            projectRoot +
            '\n' +
            '   Cache status: ' +
            (policy._cacheHit ? 'HIT (may be stale)' : 'MISS') +
            '\n' +
            '   This may be a path resolution or caching issue\n'
        );
      } else {
        // Policy.yaml is optional - defaults work fine, so don't warn unnecessarily
        // Only show info message if user explicitly wants to see it
        if (options.showPolicyInfo !== false) {
          // Silent by default - policy.yaml is optional
        }
      }
    }

    // Check if risk tier exists in policy
    if (!policy.risk_tiers[spec.risk_tier]) {
      throw new Error(
        `Risk tier ${spec.risk_tier} not defined in policy.yaml\n` +
          `Policy only defines tiers: ${Object.keys(policy.risk_tiers).join(', ')}\n` +
          `Valid tiers are: 1 (critical), 2 (standard), 3 (low-risk)`
      );
    }

    const tierBudget = policy.risk_tiers[spec.risk_tier];
    const baseline = {
      max_files: tierBudget.max_files,
      max_loc: tierBudget.max_loc,
    };

    // Start with baseline budget
    let effectiveBudget = { ...baseline };

    // Apply waivers if any
    if (spec.waiver_ids && Array.isArray(spec.waiver_ids)) {
      for (const waiverId of spec.waiver_ids) {
        const waiver = loadWaiver(waiverId, projectRoot);
        if (waiver && waiver.status === 'active' && isWaiverValid(waiver)) {
          // Validate waiver covers budget_limit gate
          if (!waiver.gates || !waiver.gates.includes('budget_limit')) {
            console.warn(
              `\n⚠️  Waiver ${waiverId} does not cover 'budget_limit' gate\n` +
                `   Current gates: [${waiver.gates ? waiver.gates.join(', ') : 'none'}]\n` +
                `   Add 'budget_limit' to gates array to apply to budget violations\n`
            );
            continue;
          }

          // Apply additive deltas
          if (waiver.delta) {
            if (waiver.delta.max_files) {
              effectiveBudget.max_files += waiver.delta.max_files;
            }
            if (waiver.delta.max_loc) {
              effectiveBudget.max_loc += waiver.delta.max_loc;
            }
          }
        }
      }
    }

    return {
      baseline,
      effective: effectiveBudget,
      waivers_applied: spec.waiver_ids || [],
      derived_at: new Date().toISOString(),
    };
  } catch (error) {
    throw new Error(`Budget derivation failed: ${error.message}`);
  }
}

/**
 * Validate waiver document structure
 * @param {Object} waiver - Waiver document to validate
 * @throws {Error} If waiver structure is invalid
 */
function validateWaiverStructure(waiver) {
  const requiredFields = ['id', 'title', 'reason', 'status', 'gates', 'expires_at', 'approvers'];

  // Check all required fields present
  for (const field of requiredFields) {
    if (!(field in waiver)) {
      throw new Error(
        `Waiver missing required field: ${field}\n` +
          `Required fields: ${requiredFields.join(', ')}\n` +
          `Fix the waiver file at .caws/waivers/${waiver.id || 'unknown'}.yaml`
      );
    }
  }

  // Validate ID format (WV-XXXX)
  if (!/^WV-\d{4}$/.test(waiver.id)) {
    throw new Error(
      `Invalid waiver ID format: ${waiver.id}\n` +
        'Waiver IDs must follow the format: WV-XXXX (e.g., WV-0001)\n' +
        'Where XXXX is a 4-digit number\n' +
        `Fix the id field in .caws/waivers/${waiver.id}.yaml`
    );
  }

  // Validate status
  const validStatuses = ['active', 'expired', 'revoked'];
  if (!validStatuses.includes(waiver.status)) {
    throw new Error(
      `Invalid waiver status: ${waiver.status}\n` +
        `Status must be one of: ${validStatuses.join(', ')}\n` +
        `Fix the status field in .caws/waivers/${waiver.id}.yaml`
    );
  }

  // Validate gates is array
  if (!Array.isArray(waiver.gates) || waiver.gates.length === 0) {
    throw new Error(
      `Invalid waiver gates: ${JSON.stringify(waiver.gates)}\n` +
        'gates must be a non-empty array of gate names\n' +
        `Example: gates: ["budget_limit", "coverage_threshold"]\n` +
        `Fix the gates field in .caws/waivers/${waiver.id}.yaml`
    );
  }

  // Validate approvers is array
  if (!Array.isArray(waiver.approvers) || waiver.approvers.length === 0) {
    throw new Error(
      `Invalid waiver approvers: ${JSON.stringify(waiver.approvers)}\n` +
        'approvers must be a non-empty array of approver names/emails\n' +
        'Example: approvers: ["tech-lead@company.com"]\n' +
        `Fix the approvers field in .caws/waivers/${waiver.id}.yaml`
    );
  }

  // Validate expires_at is valid date string
  const expiryDate = new Date(waiver.expires_at);
  if (isNaN(expiryDate.getTime())) {
    throw new Error(
      `Invalid waiver expiry date: ${waiver.expires_at}\n` +
        'expires_at must be a valid ISO 8601 date string\n' +
        'Example: expires_at: "2025-12-31T23:59:59Z"\n' +
        `Fix the expires_at field in .caws/waivers/${waiver.id}.yaml`
    );
  }

  // Validate delta if present
  if (waiver.delta) {
    if (waiver.delta.max_files !== undefined && waiver.delta.max_files < 0) {
      throw new Error(
        `Invalid waiver delta.max_files: ${waiver.delta.max_files}\n` +
          'delta.max_files must be a non-negative integer\n' +
          `Fix the delta field in .caws/waivers/${waiver.id}.yaml`
      );
    }

    if (waiver.delta.max_loc !== undefined && waiver.delta.max_loc < 0) {
      throw new Error(
        `Invalid waiver delta.max_loc: ${waiver.delta.max_loc}\n` +
          'delta.max_loc must be a non-negative integer\n' +
          `Fix the delta field in .caws/waivers/${waiver.id}.yaml`
      );
    }
  }
}

/**
 * Load a waiver by ID
 * Enhanced with structure validation and detailed error reporting
 * @param {string} waiverId - Waiver ID (e.g., WV-0001)
 * @param {string} projectRoot - Project root directory
 * @returns {Object|null} Waiver object or null if not found
 */
function loadWaiver(waiverId, projectRoot) {
  try {
    // Validate ID format before attempting to load
    if (!/^WV-\d{4}$/.test(waiverId)) {
      console.error(
        `\n❌ Invalid waiver ID format: ${waiverId}\n` +
          `   Waiver IDs must be exactly 4 digits: WV-0001 through WV-9999\n` +
          `   Fix waiver_ids in .caws/working-spec.yaml\n`
      );
      return null;
    }

    const waiverPath = path.join(projectRoot, '.caws', 'waivers', `${waiverId}.yaml`);
    if (!fs.existsSync(waiverPath)) {
      console.error(
        `\n❌ Waiver file not found: ${waiverId}\n` +
          `   Expected location: ${waiverPath}\n` +
          `   Create waiver with: caws waiver create\n`
      );
      return null;
    }

    const waiver = yaml.load(fs.readFileSync(waiverPath, 'utf8'));

    // Validate waiver structure
    try {
      validateWaiverStructure(waiver);
    } catch (error) {
      console.error(`\n❌ Invalid waiver ${waiverId}: ${error.message}\n`);
      return null;
    }

    return waiver;
  } catch (error) {
    console.error(`\n❌ Failed to load waiver ${waiverId}: ${error.message}\n`);
    return null;
  }
}

/**
 * Check if a waiver is currently valid
 * Enhanced with proper expiry and approval validation
 * @param {Object} waiver - Waiver object
 * @param {Object} policy - Policy configuration (optional)
 * @returns {boolean} Whether waiver is valid and active
 */
function isWaiverValid(waiver, policy = null) {
  try {
    // Check status first
    if (waiver.status !== 'active') {
      console.warn(`Waiver ${waiver.id} has status: ${waiver.status}`);
      return false;
    }

    // Check if expired
    if (waiver.expires_at) {
      const expiryDate = new Date(waiver.expires_at);
      const now = new Date();
      if (now > expiryDate) {
        console.warn(`Waiver ${waiver.id} expired on ${waiver.expires_at}`);
        return false;
      }
    }

    // Check required approvals
    if (!waiver.approvers || waiver.approvers.length === 0) {
      console.warn(`Waiver ${waiver.id} has no approvers`);
      return false;
    }

    // Validate minimum approvers if policy provided
    if (policy && policy.waiver_approval && policy.waiver_approval.required_approvers) {
      const minApprovers = policy.waiver_approval.required_approvers;
      if (waiver.approvers.length < minApprovers) {
        console.warn(
          `Waiver ${waiver.id} has ${waiver.approvers.length} approvers, needs ${minApprovers}`
        );
        return false;
      }
    }

    // Check required fields
    if (!waiver.id || !waiver.title || !waiver.gates) {
      console.warn(`Waiver ${waiver.id || 'unknown'} missing required fields`);
      return false;
    }

    return true;
  } catch (error) {
    console.warn(`Waiver validation error: ${error.message}`);
    return false;
  }
}

/**
 * Check if current changes exceed derived budget
 * @param {Object} derivedBudget - Budget from deriveBudget()
 * @param {Object} currentStats - Current change statistics
 * @returns {Object} Budget check result
 */
function checkBudgetCompliance(derivedBudget, currentStats) {
  const violations = [];

  if (currentStats.files_changed > derivedBudget.effective.max_files) {
    violations.push({
      gate: 'budget_limit',
      type: 'max_files',
      current: currentStats.files_changed,
      limit: derivedBudget.effective.max_files,
      baseline: derivedBudget.baseline.max_files,
      message: `File count (${currentStats.files_changed}) exceeds budget (${derivedBudget.effective.max_files})`,
    });
  }

  if (currentStats.lines_changed > derivedBudget.effective.max_loc) {
    violations.push({
      gate: 'budget_limit',
      type: 'max_loc',
      current: currentStats.lines_changed,
      limit: derivedBudget.effective.max_loc,
      baseline: derivedBudget.baseline.max_loc,
      message: `Lines of code (${currentStats.lines_changed}) exceed budget (${derivedBudget.effective.max_loc})`,
    });
  }

  return {
    compliant: violations.length === 0,
    violations,
    budget: derivedBudget,
  };
}

/**
 * Calculate budget utilization percentages
 * @param {Object} budgetCompliance - Budget compliance result
 * @returns {Object} Utilization percentages
 */
function calculateBudgetUtilization(budgetCompliance) {
  const filesPercent =
    budgetCompliance.budget.effective.max_files > 0
      ? (budgetCompliance.budget.baseline.max_files / budgetCompliance.budget.effective.max_files) *
        100
      : 0;

  const locPercent =
    budgetCompliance.budget.effective.max_loc > 0
      ? (budgetCompliance.budget.baseline.max_loc / budgetCompliance.budget.effective.max_loc) * 100
      : 0;

  return {
    files: Math.round(filesPercent),
    loc: Math.round(locPercent),
    overall: Math.round(Math.max(filesPercent, locPercent)),
  };
}

/**
 * Check if changes are approaching budget limit
 * @param {Object} budgetCompliance - Budget compliance result
 * @param {number} threshold - Warning threshold (default 80)
 * @returns {boolean} Whether approaching limit
 */
function isApproachingBudgetLimit(budgetCompliance, threshold = 80) {
  const utilization = calculateBudgetUtilization(budgetCompliance);
  return utilization.overall >= threshold;
}

/**
 * Generate burn-up report for scope visibility
 * Enhanced with utilization metrics and warnings
 * @param {Object} derivedBudget - Budget from deriveBudget()
 * @param {Object} currentStats - Current change statistics
 * @returns {string} Human-readable burn-up report
 */
function generateBurnupReport(derivedBudget, currentStats) {
  const report = [
    '📊 CAWS Budget Burn-up Report',
    '===============================',
    '',
    `Risk Tier: ${currentStats.risk_tier}`,
    `Baseline: ${derivedBudget.baseline.max_files} files, ${derivedBudget.baseline.max_loc} LOC`,
    `Current: ${currentStats.files_changed} files, ${currentStats.lines_changed} LOC`,
  ];

  if (derivedBudget.waivers_applied.length > 0) {
    report.push('');
    report.push(`Waivers Applied: ${derivedBudget.waivers_applied.join(', ')}`);
    report.push(
      `Effective Budget: ${derivedBudget.effective.max_files} files, ${derivedBudget.effective.max_loc} LOC`
    );
  }

  const filePercent = Math.round(
    (currentStats.files_changed / derivedBudget.effective.max_files) * 100
  );
  const locPercent = Math.round(
    (currentStats.lines_changed / derivedBudget.effective.max_loc) * 100
  );

  report.push('');
  report.push(
    `File Usage: ${filePercent}% (${currentStats.files_changed}/${derivedBudget.effective.max_files})`
  );
  report.push(
    `LOC Usage: ${locPercent}% (${currentStats.lines_changed}/${derivedBudget.effective.max_loc})`
  );

  // Add warnings at different thresholds
  const overall = Math.max(filePercent, locPercent);
  if (overall >= 95) {
    report.push('', '🚫 CRITICAL: Budget nearly exhausted!');
  } else if (overall >= 90) {
    report.push('', '⚠️  WARNING: Approaching budget limits');
  } else if (overall >= 80) {
    report.push('', '⚠️  Notice: 80% of budget used');
  }

  return report.join('\n');
}

module.exports = {
  deriveBudget,
  loadWaiver,
  isWaiverValid,
  checkBudgetCompliance,
  generateBurnupReport,
  calculateBudgetUtilization,
  isApproachingBudgetLimit,
  validatePolicy,
  getDefaultPolicy,
  validateWaiverStructure,
};
