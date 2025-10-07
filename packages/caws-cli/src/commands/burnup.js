/**
 * @fileoverview Burn-up Command Handler
 * Generates budget burn-up reports for scope visibility
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');

const { deriveBudget, generateBurnupReport } = require('../budget-derivation');

/**
 * Burn-up command handler
 * @param {string} specFile - Path to spec file
 */
async function burnupCommand(specFile) {
  try {
    let specPath = specFile || path.join('.caws', 'working-spec.yaml');

    if (!fs.existsSync(specPath)) {
      console.error(chalk.red(`❌ Spec file not found: ${specPath}`));
      process.exit(1);
    }

    const specContent = fs.readFileSync(specPath, 'utf8');
    const spec = yaml.load(specContent);

    console.log(chalk.cyan('📊 Generating CAWS budget burn-up report...'));

    // Derive budget
    const derivedBudget = deriveBudget(spec, path.dirname(specPath));

    // Mock current stats - in real implementation this would analyze actual git changes
    const mockStats = {
      files_changed: 50, // This would be calculated from actual changes
      lines_changed: 5000,
      risk_tier: spec.risk_tier,
    };

    // Generate report
    const report = generateBurnupReport(derivedBudget, mockStats);

    console.log(report);

    // Show detailed breakdown
    console.log(chalk.gray('\n📈 Detailed Budget Analysis:'));
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
        `   Current Usage: ${mockStats.files_changed} files, ${mockStats.lines_changed} LOC`
      )
    );

    const filePercent = Math.round(
      (mockStats.files_changed / derivedBudget.effective.max_files) * 100
    );
    const locPercent = Math.round(
      (mockStats.lines_changed / derivedBudget.effective.max_loc) * 100
    );

    if (filePercent > 90 || locPercent > 90) {
      console.log(chalk.yellow('\n⚠️  WARNING: Approaching budget limits'));
    } else {
      console.log(chalk.green('\n✅ Within budget limits'));
    }
  } catch (error) {
    console.error(chalk.red('❌ Error generating burn-up report:'), error.message);
    process.exit(1);
  }
}

module.exports = {
  burnupCommand,
};
