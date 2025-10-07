#!/usr/bin/env node

/**
 * @fileoverview CAWS CLI - Scaffolding tool for Coding Agent Workflow System
 * Provides commands to initialize new projects and scaffold existing ones with CAWS
 * @author @darianrosebrook
 */

const { Command } = require('commander');
// eslint-disable-next-line no-unused-vars
const fs = require('fs-extra');
// eslint-disable-next-line no-unused-vars
const path = require('path');
// eslint-disable-next-line no-unused-vars
const yaml = require('js-yaml');
const chalk = require('chalk');

// Import configuration and utilities
const {
  CLI_VERSION,
  initializeGlobalSetup,
  loadProvenanceTools,
  initializeLanguageSupport,
} = require('./config');

// Import command handlers
const { initProject } = require('./commands/init');
const { validateCommand } = require('./commands/validate');
const { burnupCommand } = require('./commands/burnup');
const { testAnalysisCommand } = require('./test-analysis');
const { provenanceCommand } = require('./commands/provenance');
const { executeTool } = require('./commands/tool');

// Import scaffold functionality
const { scaffoldProject, setScaffoldDependencies } = require('./scaffold');

// Import validation functionality
// eslint-disable-next-line no-unused-vars
const { validateWorkingSpecWithSuggestions } = require('./validation/spec-validation');

// Import finalization utilities
const {
  // eslint-disable-next-line no-unused-vars
  finalizeProject,
  // eslint-disable-next-line no-unused-vars
  continueToSuccess,
  setFinalizationDependencies,
} = require('./utils/finalization');

// Import generators
const { generateWorkingSpec, validateGeneratedSpec } = require('./generators/working-spec');

// Initialize global configuration
const program = new Command();

// Initialize global state
const cawsSetup = initializeGlobalSetup();
const languageSupport = initializeLanguageSupport();

// Set up dependencies for modules that need them
setScaffoldDependencies({
  cawsSetup,
  loadProvenanceTools,
});

setFinalizationDependencies({
  languageSupport,
  loadProvenanceTools,
});

// Setup CLI program
program.name('caws').description('CAWS - Coding Agent Workflow System CLI').version(CLI_VERSION);

// Init command
program
  .command('init')
  .description('Initialize a new project with CAWS')
  .argument('[project-name]', 'Name of the project to create (use "." for current directory)')
  .option('-i, --interactive', 'Run interactive setup wizard', true)
  .option('--non-interactive', 'Skip interactive prompts (use defaults)', false)
  .option('--template <template>', 'Use specific project template')
  .action(initProject);

// Scaffold command
program
  .command('scaffold')
  .description('Add CAWS components to existing project')
  .option('-f, --force', 'Overwrite existing files', false)
  .option('--minimal', 'Only essential components', false)
  .option('--with-codemods', 'Include codemod scripts', false)
  .option('--with-oidc', 'Include OIDC trusted publisher setup', false)
  .action(scaffoldProject);

// Validate command
program
  .command('validate')
  .description('Validate CAWS working spec with suggestions')
  .argument('[spec-file]', 'Path to working spec file (default: .caws/working-spec.yaml)')
  .option('-q, --quiet', 'Suppress suggestions and warnings', false)
  .option('--auto-fix', 'Automatically fix safe validation issues', false)
  .action(validateCommand);

// Tool command
program
  .command('tool')
  .description('Execute CAWS tools programmatically')
  .argument('<tool-id>', 'ID of the tool to execute')
  .option('-p, --params <json>', 'Parameters as JSON string', '{}')
  .option('-t, --timeout <ms>', 'Execution timeout in milliseconds', parseInt, 30000)
  .action(executeTool);

// Test Analysis command
program
  .command('test-analysis <subcommand> [options...]')
  .description('Statistical analysis for budget prediction and test optimization')
  .action(testAnalysisCommand);

// Provenance command
program
  .command('provenance')
  .description('Manage CAWS provenance tracking and audit trails')
  .argument('<subcommand>', 'Command: update, show, verify, analyze-ai')
  .option('-c, --commit <hash>', 'Git commit hash')
  .option('-m, --message <msg>', 'Commit message')
  .option('-a, --author <info>', 'Author information')
  .option('-q, --quiet', 'Suppress output')
  .option('-o, --output <path>', 'Output path for provenance files')
  .action(provenanceCommand);

// Error handling
program.exitOverride((err) => {
  if (
    err.code === 'commander.help' ||
    err.code === 'commander.version' ||
    err.message.includes('outputHelp')
  ) {
    process.exit(0);
  }
  console.error(chalk.red('❌ Error:'), err.message);
  process.exit(1);
});

// Parse and run
if (require.main === module) {
  try {
    program.parse();
  } catch (error) {
    if (
      error.code === 'commander.help' ||
      error.code === 'commander.version' ||
      error.message.includes('outputHelp')
    ) {
      process.exit(0);
    } else {
      console.error(chalk.red('❌ Error:'), error.message);
      process.exit(1);
    }
  }
}

// Export functions for testing
module.exports = {
  generateWorkingSpec,
  validateGeneratedSpec,
};
