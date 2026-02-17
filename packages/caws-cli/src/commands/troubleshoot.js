/**
 * @fileoverview CAWS CLI Troubleshoot Command
 * Provides detailed troubleshooting guides for common CAWS issues
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const { getTroubleshootingGuide, getAllTroubleshootingGuides } = require('../error-handler');

/**
 * Display a specific troubleshooting guide
 * @param {string} guideKey - Key for the troubleshooting guide
 */
function displayGuide(guideKey) {
  const guide = getTroubleshootingGuide(guideKey);

  if (!guide) {
    console.error(chalk.red(`Troubleshooting guide '${guideKey}' not found.`));
    console.log(chalk.yellow('\nAvailable guides:'));
    const allGuides = getAllTroubleshootingGuides();
    Object.keys(allGuides).forEach((key) => {
      console.log(chalk.yellow(`  ${key}: ${allGuides[key].title}`));
    });
    console.log(chalk.yellow('\nTry: caws troubleshoot --list for all available guides'));
    return;
  }

  console.log(chalk.bold.blue(`${guide.title}`));
  console.log(chalk.gray('═'.repeat(50)));

  if (guide.symptoms && guide.symptoms.length > 0) {
    console.log(chalk.yellow('\nSymptoms:'));
    guide.symptoms.forEach((symptom) => {
      console.log(chalk.gray(`   - ${symptom}`));
    });
  }

  if (guide.rootCauses && guide.rootCauses.length > 0) {
    console.log(chalk.red('\nPossible Root Causes:'));
    guide.rootCauses.forEach((cause) => {
      console.log(chalk.gray(`   - ${cause}`));
    });
  }

  if (guide.solutions && guide.solutions.length > 0) {
    console.log(chalk.green('\nSolutions:'));
    guide.solutions.forEach((solution, index) => {
      console.log(chalk.gray(`   ${index + 1}. ${solution}`));
    });
  }

  if (guide.commands && guide.commands.length > 0) {
    console.log(chalk.cyan('\nTry These Commands:'));
    guide.commands.forEach((command) => {
      console.log(chalk.gray(`   $ ${command}`));
    });
  }

  console.log(chalk.gray('\n═'.repeat(50)));
  console.log(chalk.blue('For more help: caws --help or visit the documentation'));
}

/**
 * List all available troubleshooting guides
 */
function listGuides() {
  console.log(chalk.bold.blue('Available Troubleshooting Guides'));
  console.log(chalk.gray('═'.repeat(50)));

  const allGuides = getAllTroubleshootingGuides();
  Object.entries(allGuides).forEach(([key, guide]) => {
    console.log(chalk.cyan(`${key}:`));
    console.log(chalk.gray(`   ${guide.title}`));
    if (guide.symptoms && guide.symptoms.length > 0) {
      console.log(
        chalk.gray(`   Symptoms: ${guide.symptoms[0]}${guide.symptoms.length > 1 ? '...' : ''}`)
      );
    }
    console.log('');
  });

  console.log(chalk.yellow('Usage: caws troubleshoot <guide-key>'));
  console.log(chalk.yellow('Example: caws troubleshoot coverage-report-not-found'));
}

/**
 * Troubleshoot command handler
 * @param {string} guide - Guide key argument
 * @param {Object} options - Command options
 */
function troubleshootCommand(guide, options) {
  try {
    if (options.list || !guide) {
      listGuides();
    } else {
      displayGuide(guide);
    }
  } catch (error) {
    console.error(chalk.red(`Error: ${error.message}`));
    process.exit(1);
  }
}

module.exports = troubleshootCommand;
