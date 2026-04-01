/**
 * @fileoverview Budget enforcement gate
 * Checks changes against tier budget limits from policy.
 * Context-aware: commit context counts staged changes, cli context skips (budget is per-change, not per-repo).
 * @author @darianrosebrook
 */

const { deriveBudget, checkBudgetCompliance } = require('../budget-derivation');
const { execSync } = require('child_process');

const name = 'budget_limit';

/**
 * Count staged files and lines of code from git diff
 * @param {string[]} stagedFiles - List of staged file paths
 * @param {string} projectRoot - Project root directory
 * @returns {Object} Stats with files_changed and lines_changed
 */
function getStagedStats(stagedFiles, projectRoot) {
  const filesChanged = stagedFiles.length;
  let linesChanged = 0;

  try {
    const numstat = execSync('git diff --cached --numstat', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const line of numstat.trim().split('\n').filter(Boolean)) {
      const [added, removed] = line.split('\t');
      const addedNum = added === '-' ? 0 : parseInt(added, 10) || 0;
      const removedNum = removed === '-' ? 0 : parseInt(removed, 10) || 0;
      linesChanged += addedNum + removedNum;
    }
  } catch (err) {
    // Fail-closed: if git fails, we cannot verify budget compliance
    return {
      files_changed: filesChanged,
      lines_changed: -1,
      error: `Cannot count staged line changes: ${err.message}`,
    };
  }

  return { files_changed: filesChanged, lines_changed: linesChanged };
}

/**
 * Run the budget limit gate
 * @param {Object} params - Gate parameters
 * @param {string[]} params.stagedFiles - Staged file paths
 * @param {Object} params.spec - Working spec
 * @param {Object} params.policy - Policy configuration
 * @param {string} params.projectRoot - Project root
 * @param {number} params.riskTier - Risk tier number
 * @param {string} [params.context] - Execution context (commit, cli, edit)
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, spec, _policy, projectRoot, riskTier, context }) {
  const messages = [];

  // Budget limits apply to changes, not to the entire repo.
  // In cli context with all tracked files, budget check is meaningless.
  if (context === 'cli') {
    return { status: 'pass', messages: ['Budget check skipped in CLI context (budget applies to changes, not full repo)'] };
  }

  // Build a minimal spec for deriveBudget
  const specForBudget = {
    risk_tier: riskTier,
    waiver_ids: spec?.waiver_ids || [],
  };

  try {
    const budget = await deriveBudget(specForBudget, projectRoot, { useCache: true });
    const stats = getStagedStats(stagedFiles, projectRoot);

    // Fail-closed: if git stats errored, report it
    if (stats.error) {
      messages.push(stats.error);
      return { status: 'fail', messages };
    }

    const compliance = checkBudgetCompliance(budget, stats);

    if (!compliance.compliant) {
      for (const violation of compliance.violations) {
        messages.push(violation.message);
      }
      return { status: 'fail', messages };
    }

    return { status: 'pass', messages };
  } catch (err) {
    return { status: 'fail', messages: [`Budget check error: ${err.message}`] };
  }
}

module.exports = { name, run };
