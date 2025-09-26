#!/usr/bin/env node

/**
 * @fileoverview Minimal CAWS CLI to test Chalk functionality
 * @author @darianrosebrook
 */

const { Command } = require('commander');
const chalk = require('chalk');

const program = new Command();

// Configuration
const CLI_VERSION = require('../package.json').version;

/**
 * Show version information
 */
function showVersion() {
  console.log(chalk.bold(`CAWS CLI v${CLI_VERSION}`));
  console.log(chalk.cyan('Coding Agent Workflow System - Scaffolding Tool'));
  console.log(chalk.gray('Author: @darianrosebrook'));
  console.log(chalk.gray('License: MIT'));
}

/**
 * Initialize a new project
 */
async function initProject(projectName, _options) {
  console.log(chalk.cyan(`🚀 Initializing new CAWS project: ${projectName}`));

  try {
    if (!projectName || projectName.trim() === '') {
      console.error(chalk.red('❌ Project name is required'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      process.exit(1);
    }

    console.log(chalk.green('✅ Project initialization started'));
    console.log(chalk.bold('\n📋 Configuration Summary:'));
    console.log(`   ${chalk.cyan('Project')}: ${projectName}`);
    console.log(`   ${chalk.cyan('Status')}: Initialized`);

    console.log(chalk.green('\n🎉 Project initialized successfully!'));
    console.log(chalk.blue('\nFor help: caws --help'));
  } catch (error) {
    console.error(chalk.red('❌ Error during project initialization:'), error.message);
    process.exit(1);
  }
}

// CLI Commands
program
  .name('caws')
  .description('CAWS - Coding Agent Workflow System CLI')
  .version(CLI_VERSION, '-v, --version', 'Show version information');

program
  .command('init')
  .alias('i')
  .description('Initialize a new project with CAWS')
  .argument('<project-name>', 'Name of the new project')
  .action(initProject);

program.command('version').alias('v').description('Show version information').action(showVersion);

// Error handling
program.exitOverride((err) => {
  if (err.code === 'commander.help') {
    process.exit(0);
  }
  console.error(chalk.red('❌ Error:'), err.message);
  process.exit(1);
});

// Parse and run
try {
  program.parse();
} catch (error) {
  if (error.code === 'commander.help' || error.code === 'commander.version') {
    process.exit(0);
  } else {
    console.error(chalk.red('❌ Error:'), error.message);
    process.exit(1);
  }
}
