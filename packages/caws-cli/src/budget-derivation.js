/**
 * @fileoverview Budget Derivation Logic
 * Derives budgets from policy.yaml and applies waivers
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Derive budget for a working spec based on policy and waivers
 * @param {Object} spec - Working spec object
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Derived budget with baseline and effective limits
 */
function deriveBudget(spec, projectRoot = process.cwd()) {
  try {
    // Load policy.yaml
    const policyPath = path.join(projectRoot, '.caws', 'policy.yaml');
    if (!fs.existsSync(policyPath)) {
      throw new Error('Policy file not found: .caws/policy.yaml');
    }

    const policy = yaml.load(fs.readFileSync(policyPath, 'utf8'));

    // Validate policy structure
    if (!policy.risk_tiers || !policy.risk_tiers[spec.risk_tier]) {
      throw new Error(`Risk tier ${spec.risk_tier} not defined in policy.yaml`);
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
 * Load a waiver by ID
 * @param {string} waiverId - Waiver ID (e.g., WV-0001)
 * @param {string} projectRoot - Project root directory
 * @returns {Object|null} Waiver object or null if not found
 */
function loadWaiver(waiverId, projectRoot) {
  try {
    const waiverPath = path.join(projectRoot, '.caws', 'waivers', `${waiverId}.yaml`);
    if (!fs.existsSync(waiverPath)) {
      console.warn(`Waiver file not found: ${waiverPath}`);
      return null;
    }

    const waiver = yaml.load(fs.readFileSync(waiverPath, 'utf8'));
    return waiver;
  } catch (error) {
    console.warn(`Failed to load waiver ${waiverId}: ${error.message}`);
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
};
