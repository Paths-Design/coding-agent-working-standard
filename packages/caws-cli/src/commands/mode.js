/**
 * @fileoverview CAWS Mode Command
 * Manage CAWS complexity tiers and switch between modes
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const { safeAsync, outputResult } = require('../error-handler');

const {
  getTier,
  getAvailableTiers,
  getCurrentMode,
  setCurrentMode,
  displayTierComparison,
  getTierRecommendation,
} = require('../config/modes');

/**
 * Display current mode status
 */
function displayCurrentMode() {
  console.log(chalk.bold.cyan('\n🔧 CAWS Current Mode'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // This will be implemented when we load the current mode
  console.log(chalk.yellow('Mode display will be implemented...'));
  console.log('');
}

/**
 * Display mode details
 * @param {string} mode - Mode to display
 */
function displayModeDetails(mode) {
  const tier = getTier(mode);
  const tierColor = tier.color;
  const icon = tier.icon;

  console.log(chalk.bold.cyan(`\n📋 ${icon} ${tierColor(tier.name)} Mode Details`));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`${tierColor(tier.name)} - ${tier.description}\n`);

  // Quality Requirements
  console.log(chalk.bold('Quality Requirements:'));
  console.log(chalk.gray(`   Test Coverage: ${tier.qualityRequirements.testCoverage}%`));
  console.log(chalk.gray(`   Mutation Score: ${tier.qualityRequirements.mutationScore}%`));
  console.log(chalk.gray(`   Contracts: ${tier.qualityRequirements.contracts}\n`));

  // Supported Risk Tiers
  console.log(chalk.bold('Supported Risk Tiers:'));
  tier.riskTiers.forEach((riskTier) => {
    const riskColor =
      riskTier === 'T1' ? chalk.red : riskTier === 'T2' ? chalk.yellow : chalk.green;
    console.log(chalk.gray(`   ${riskColor(riskTier)}`));
  });
  console.log('');

  // Available Commands
  console.log(chalk.bold('Available Commands:'));
  Object.entries(tier.commands)
    .filter(([, available]) => available)
    .forEach(([command]) => {
      console.log(chalk.gray(`   ✅ caws ${command}`));
    });

  const disabledCommands = Object.entries(tier.commands)
    .filter(([, available]) => !available)
    .map(([command]) => command);

  if (disabledCommands.length > 0) {
    console.log(chalk.bold('\nDisabled Commands:'));
    disabledCommands.forEach((command) => {
      console.log(chalk.gray(`   ❌ caws ${command}`));
    });
  }

  console.log('');
}

/**
 * Interactive mode selection
 * @returns {Promise<string>} Selected mode
 */
async function interactiveModeSelection() {
  const readline = require('readline');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log(chalk.bold.cyan('\n🔧 Select CAWS Complexity Tier'));
    console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

    const tiers = getAvailableTiers();
    tiers.forEach((tier, index) => {
      const tierConfig = getTier(tier);
      const tierColor = tierConfig.color;
      const icon = tierConfig.icon;
      console.log(`${index + 1}. ${icon} ${tierColor(tier)} - ${tierConfig.description}`);
    });

    console.log('\nEnter your choice (1-3): ');

    rl.on('line', (input) => {
      const choice = parseInt(input.trim());
      if (choice >= 1 && choice <= tiers.length) {
        rl.close();
        resolve(tiers[choice - 1]);
      } else {
        console.log(chalk.red('Invalid choice. Please enter 1-3:'));
      }
    });
  });
}

/**
 * Mode command handler
 * @param {string} action - Action to perform (current, set, compare, recommend)
 * @param {Object} options - Command options
 */
async function modeCommand(action, options = {}) {
  return safeAsync(
    async () => {
      switch (action) {
        case 'current':
          const currentMode = await getCurrentMode();
          displayCurrentMode();

          const tier = getTier(currentMode);
          console.log(chalk.bold(`Current Mode: ${tier.icon} ${tier.color(currentMode)}`));
          console.log(chalk.gray(`Description: ${tier.description}`));
          console.log(
            chalk.gray(
              `Quality: ${tier.qualityRequirements.testCoverage}% coverage, ${tier.qualityRequirements.mutationScore}% mutation`
            )
          );

          return outputResult({
            command: 'mode current',
            mode: currentMode,
            tier: tier,
          });

        case 'set':
          let targetMode;

          if (options.mode) {
            targetMode = options.mode;
          } else if (options.interactive) {
            targetMode = await interactiveModeSelection();
          } else {
            throw new Error('Mode not specified. Use --mode <mode> or --interactive');
          }

          if (!getAvailableTiers().includes(targetMode)) {
            throw new Error(
              `Invalid mode: ${targetMode}. Available: ${getAvailableTiers().join(', ')}`
            );
          }

          const success = await setCurrentMode(targetMode);
          if (!success) {
            throw new Error(`Failed to set mode to ${targetMode}`);
          }

          console.log(
            chalk.green(
              `✅ Successfully switched to ${getTier(targetMode).icon} ${getTier(targetMode).color(targetMode)} mode`
            )
          );

          return outputResult({
            command: 'mode set',
            mode: targetMode,
          });

        case 'compare':
          displayTierComparison();

          return outputResult({
            command: 'mode compare',
            tiers: getAvailableTiers(),
          });

        case 'recommend':
          const projectInfo = {};

          if (options.size) projectInfo.size = options.size;
          if (options.teamSize) projectInfo.teamSize = parseInt(options.teamSize);
          if (options.compliance) projectInfo.compliance = options.compliance === 'true';
          if (options.audit) projectInfo.auditRequired = options.audit === 'true';

          const recommendation = getTierRecommendation(projectInfo);
          const recommendedTier = getTier(recommendation);

          console.log(chalk.bold.cyan('\n🎯 Recommended CAWS Tier'));
          console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

          console.log(
            `${recommendedTier.icon} ${recommendedTier.color(recommendedTier.name)} - ${recommendedTier.description}`
          );
          console.log(
            chalk.gray(
              `Quality: ${recommendedTier.qualityRequirements.testCoverage}% coverage, ${recommendedTier.qualityRequirements.mutationScore}% mutation`
            )
          );

          if (options.details) {
            console.log('');
            displayModeDetails(recommendation);
          }

          return outputResult({
            command: 'mode recommend',
            recommendation,
            tier: recommendedTier,
            projectInfo,
          });

        case 'details':
          if (!options.mode) {
            throw new Error('Mode not specified. Use --mode <mode>');
          }

          displayModeDetails(options.mode);

          return outputResult({
            command: 'mode details',
            mode: options.mode,
          });

        default:
          throw new Error(
            `Unknown mode action: ${action}. Use: current, set, compare, recommend, details`
          );
      }
    },
    `mode ${action}`,
    true
  );
}

module.exports = {
  modeCommand,
  getCurrentMode,
  setCurrentMode,
  displayCurrentMode,
  displayModeDetails,
  interactiveModeSelection,
};
