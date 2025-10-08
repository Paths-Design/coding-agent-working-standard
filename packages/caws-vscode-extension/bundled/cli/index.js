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

// Import git hooks functionality
const { scaffoldGitHooks, removeGitHooks, checkGitHooksStatus } = require('./scaffold/git-hooks');

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

// Provenance command group
const provenanceCmd = program
  .command('provenance')
  .description('Manage CAWS provenance tracking and audit trails');

// Subcommands
provenanceCmd
  .command('update')
  .description('Add new commit to provenance chain')
  .requiredOption('-c, --commit <hash>', 'Git commit hash')
  .option('-m, --message <msg>', 'Commit message')
  .option('-a, --author <info>', 'Author information')
  .option('-q, --quiet', 'Suppress output')
  .option('-o, --output <path>', 'Output path for provenance files', '.caws/provenance')
  .action(async (options) => {
    await provenanceCommand('update', options);
  });

provenanceCmd
  .command('show')
  .description('Display current provenance history')
  .option('-o, --output <path>', 'Output path for provenance files', '.caws/provenance')
  .option('--format <type>', 'Output format: text, json, dashboard', 'text')
  .action(async (options) => {
    await provenanceCommand('show', options);
  });

provenanceCmd
  .command('verify')
  .description('Validate provenance chain integrity')
  .option('-o, --output <path>', 'Output path for provenance files', '.caws/provenance')
  .action(async (options) => {
    await provenanceCommand('verify', options);
  });

provenanceCmd
  .command('analyze-ai')
  .description('Analyze AI-assisted development patterns')
  .option('-o, --output <path>', 'Output path for provenance files', '.caws/provenance')
  .action(async (options) => {
    await provenanceCommand('analyze-ai', options);
  });

provenanceCmd
  .command('init')
  .description('Initialize provenance tracking for the project')
  .option('-o, --output <path>', 'Output path for provenance files', '.caws/provenance')
  .option('--cursor-api <url>', 'Cursor tracking API endpoint')
  .option('--cursor-key <key>', 'Cursor API key')
  .action(async (options) => {
    await provenanceCommand('init', options);
  });

// Git hooks command
const hooksCmd = program
  .command('hooks')
  .description('Manage CAWS git hooks for provenance tracking');

hooksCmd
  .command('install')
  .description('Install CAWS git hooks')
  .option('--no-provenance', 'Skip provenance tracking hooks')
  .option('--no-validation', 'Skip validation hooks')
  .option('--no-quality-gates', 'Skip quality gate hooks')
  .option('--force', 'Overwrite existing hooks')
  .option('--backup', 'Backup existing hooks before replacing')
  .action(async (options) => {
    const hookOptions = {
      provenance: options.provenance !== false,
      validation: options.validation !== false,
      qualityGates: options.qualityGates !== false,
      force: options.force,
      backup: options.backup,
    };

    try {
      const result = await scaffoldGitHooks(process.cwd(), hookOptions);
      if (result.added > 0) {
        console.log(`✅ Successfully installed ${result.added} git hooks`);
        if (result.skipped > 0) {
          console.log(`⏭️  Skipped ${result.skipped} existing hooks`);
        }
      } else {
        console.log('ℹ️  All hooks already configured');
      }
    } catch (error) {
      console.error(`❌ Failed to install git hooks: ${error.message}`);
      process.exit(1);
    }
  });

hooksCmd
  .command('remove')
  .description('Remove CAWS git hooks')
  .action(async () => {
    try {
      await removeGitHooks(process.cwd());
    } catch (error) {
      console.error(`❌ Failed to remove git hooks: ${error.message}`);
      process.exit(1);
    }
  });

hooksCmd
  .command('status')
  .description('Check git hooks status')
  .action(async () => {
    try {
      await checkGitHooksStatus(process.cwd());
    } catch (error) {
      console.error(`❌ Failed to check git hooks status: ${error.message}`);
      process.exit(1);
    }
  });

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
