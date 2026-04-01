/**
 * @fileoverview Burn-up Command Handler
 * Generates budget burn-up reports for scope visibility
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { execSync } = require('child_process');

const { deriveBudget, generateBurnupReport } = require('../budget-derivation');
const { resolveSpec } = require('../utils/spec-resolver');

/**
 * Get actual git change statistics from the repository
 * Analyzes changes since the last tag or initial commit
 * @param {string} specDir - Directory containing the spec file
 * @returns {Object} Stats with files_changed, lines_added, lines_removed, lines_changed
 */
function getGitChangeStats(specDir) {
  try {
    const cwd = specDir || process.cwd();

    // Find the base reference - prefer last tag, fall back to first commit
    let baseRef;
    try {
      baseRef = execSync('git describe --tags --abbrev=0 2>/dev/null', {
        cwd,
        encoding: 'utf8',
      }).trim();
    } catch {
      // No tags, use first commit
      try {
        baseRef = execSync('git rev-list --max-parents=0 HEAD', {
          cwd,
          encoding: 'utf8',
        }).trim();
      } catch {
        // Not a git repo or no commits
        return null;
      }
    }

    // Get file change count
    const filesOutput = execSync(`git diff --name-only ${baseRef}..HEAD`, {
      cwd,
      encoding: 'utf8',
    });
    const filesChanged = filesOutput.trim().split('\n').filter(Boolean).length;

    // Get line statistics using --numstat
    const numstatOutput = execSync(`git diff --numstat ${baseRef}..HEAD`, {
      cwd,
      encoding: 'utf8',
    });

    let linesAdded = 0;
    let linesRemoved = 0;

    numstatOutput
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach((line) => {
        const [added, removed] = line.split('\t');
        // Skip binary files (shown as '-')
        if (added !== '-' && removed !== '-') {
          linesAdded += parseInt(added, 10) || 0;
          linesRemoved += parseInt(removed, 10) || 0;
        }
      });

    return {
      files_changed: filesChanged,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      lines_changed: linesAdded + linesRemoved,
      base_ref: baseRef,
    };
  } catch (error) {
    // Return null if git analysis fails
    return null;
  }
}

/**
 * Burn-up command handler
 * @param {string} specFile - Path to spec file (positional, optional)
 * @param {object} options - Command options including --spec-id
 */
async function burnupCommand(specFile, options = {}) {
  try {
    let specPath;
    let spec;

    // Resolve spec: explicit file > --spec-id > resolver default
    if (specFile) {
      specPath = specFile;
      if (!fs.existsSync(specPath)) {
        console.error(chalk.red(`Spec file not found: ${specPath}`));
        process.exit(1);
      }
      spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
    } else {
      const resolved = await resolveSpec({ specId: options.specId });
      specPath = resolved.specPath;
      spec = resolved.spec;
    }

    console.log(chalk.cyan('Generating CAWS budget burn-up report...'));

    // Derive budget
    const derivedBudget = deriveBudget(spec, path.dirname(specPath));

    // Get actual git change statistics
    const gitStats = getGitChangeStats(path.dirname(specPath));

    let currentStats;
    if (gitStats) {
      currentStats = {
        files_changed: gitStats.files_changed,
        lines_changed: gitStats.lines_changed,
        lines_added: gitStats.lines_added,
        lines_removed: gitStats.lines_removed,
        risk_tier: spec.risk_tier,
        base_ref: gitStats.base_ref,
      };
      console.log(chalk.gray(`   Analyzing changes since: ${gitStats.base_ref}`));
    } else {
      // Fallback if git analysis fails (not in a repo or no commits)
      console.log(chalk.yellow('   Could not analyze git history, using zero values'));
      currentStats = {
        files_changed: 0,
        lines_changed: 0,
        lines_added: 0,
        lines_removed: 0,
        risk_tier: spec.risk_tier,
      };
    }

    // Generate report
    const report = generateBurnupReport(derivedBudget, currentStats);

    console.log(report);

    // Show detailed breakdown
    console.log(chalk.gray('\nDetailed Budget Analysis:'));
    console.log(
      chalk.gray(
        `   Baseline (Tier ${spec.risk_tier}): ${derivedBudget.baseline.max_files} files, ${derivedBudget.baseline.max_loc} LOC`
      )
    );
    console.log(
      chalk.gray(
        `   Effective Budget: ${derivedBudget.effective.max_files} files, ${derivedBudget.effective.max_loc} LOC`
      )
    );

    if (derivedBudget.waivers_applied.length > 0) {
      console.log(chalk.yellow(`   Waivers Applied: ${derivedBudget.waivers_applied.join(', ')}`));
    }

    console.log(
      chalk.gray(
        `   Current Usage: ${currentStats.files_changed} files, ${currentStats.lines_changed} LOC`
      )
    );
    if (currentStats.lines_added !== undefined) {
      console.log(
        chalk.gray(
          `   Breakdown: +${currentStats.lines_added} added, -${currentStats.lines_removed} removed`
        )
      );
    }

    const filePercent = Math.round(
      (currentStats.files_changed / derivedBudget.effective.max_files) * 100
    );
    const locPercent = Math.round(
      (currentStats.lines_changed / derivedBudget.effective.max_loc) * 100
    );

    if (filePercent > 90 || locPercent > 90) {
      console.log(chalk.yellow('\nWARNING: Approaching budget limits'));
    } else {
      console.log(chalk.green('\nWithin budget limits'));
    }
  } catch (error) {
    console.error(chalk.red('Error generating burn-up report:'), error.message);
    process.exit(1);
  }
}

module.exports = {
  burnupCommand,
};
