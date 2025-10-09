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

// Import error handling
const { handleCliError, findSimilarCommand } = require('./error-handler');

// Import command handlers
const { initProject } = require('./commands/init');
const { validateCommand } = require('./commands/validate');
const { burnupCommand } = require('./commands/burnup');
const { testAnalysisCommand } = require('./test-analysis');
const { provenanceCommand } = require('./commands/provenance');
const { executeTool } = require('./commands/tool');
const { statusCommand } = require('./commands/status');
const { templatesCommand } = require('./commands/templates');
const { diagnoseCommand } = require('./commands/diagnose');
const { evaluateCommand } = require('./commands/evaluate');
const { iterateCommand } = require('./commands/iterate');
const { waiversCommand } = require('./commands/waivers');
const { workflowCommand } = require('./commands/workflow');
const { qualityMonitorCommand } = require('./commands/quality-monitor');

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
program
  .name('caws')
  .description('CAWS - Coding Agent Workflow System CLI')
  .version(CLI_VERSION)
  .showHelpAfterError(false); // We'll show better suggestions instead

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

// Status command
program
  .command('status')
  .description('Show project health overview')
  .option('-s, --spec <path>', 'Path to working spec file', '.caws/working-spec.yaml')
  .action(statusCommand);

// Templates command
program
  .command('templates [subcommand]')
  .description('Discover and manage project templates')
  .option('-n, --name <template>', 'Template name (for info subcommand)')
  .action(templatesCommand);

// Diagnose command
program
  .command('diagnose')
  .description('Run health checks and suggest fixes')
  .option('--fix', 'Apply automatic fixes', false)
  .action(diagnoseCommand);

// Evaluate command
program
  .command('evaluate [spec-file]')
  .description('Evaluate work against CAWS quality standards')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(evaluateCommand);

// Iterate command
program
  .command('iterate [spec-file]')
  .description('Get iterative development guidance based on current progress')
  .option('--current-state <json>', 'Current implementation state as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(iterateCommand);

// Waivers command group
const waiversCmd = program
  .command('waivers')
  .description('Manage CAWS quality gate waivers');

// Waivers subcommands
waiversCmd
  .command('create')
  .description('Create a new quality gate waiver')
  .requiredOption('--title <title>', 'Waiver title')
  .requiredOption('--reason <reason>', 'Reason for waiver (emergency_hotfix, legacy_integration, etc.)')
  .requiredOption('--description <description>', 'Detailed description')
  .requiredOption('--gates <gates>', 'Comma-separated list of gates to waive')
  .requiredOption('--expires-at <date>', 'Expiration date (ISO 8601)')
  .requiredOption('--approved-by <approver>', 'Approver name')
  .requiredOption('--impact-level <level>', 'Impact level (low, medium, high, critical)')
  .requiredOption('--mitigation-plan <plan>', 'Risk mitigation plan')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((options) => waiversCommand('create', options));

waiversCmd
  .command('list')
  .description('List all waivers')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((options) => waiversCommand('list', options));

waiversCmd
  .command('show <id>')
  .description('Show waiver details')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((id, options) => waiversCommand('show', { ...options, id }));

waiversCmd
  .command('revoke <id>')
  .description('Revoke a waiver')
  .option('--revoked-by <name>', 'Person revoking the waiver')
  .option('--reason <reason>', 'Revocation reason')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((id, options) => waiversCommand('revoke', { ...options, id }));

// Workflow command group
const workflowCmd = program
  .command('workflow <type>')
  .description('Get workflow-specific guidance for development tasks')
  .option('--step <number>', 'Current step in workflow', '1')
  .option('--current-state <json>', 'Current implementation state as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((type, options) => workflowCommand(type, options));

// Quality Monitor command
program
  .command('quality-monitor <action>')
  .description('Monitor code quality impact in real-time')
  .option('--files <files>', 'Files affected (comma-separated)')
  .option('--context <json>', 'Additional context as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(qualityMonitorCommand);

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
// Custom error event handler for better messages
program.configureHelp({
  // Override error display
  showError: () => {}, // Suppress default error display
});

program.exitOverride((err) => {
  // Handle help and version requests gracefully
  if (
    err.code === 'commander.help' ||
    err.code === 'commander.version' ||
    err.message.includes('outputHelp')
  ) {
    process.exit(0);
  }

  const commandName = process.argv[2];

  // Check for unknown command
  if (err.code === 'commander.unknownCommand') {
    const validCommands = [
      'init',
      'validate',
      'scaffold',
      'status',
      'templates',
      'provenance',
      'hooks',
      'burnup',
      'tool',
    ];
    const similar = findSimilarCommand(commandName, validCommands);

    console.error(chalk.red(`\n❌ Unknown command: ${commandName}`));

    if (similar) {
      console.error(chalk.yellow(`\n💡 Did you mean: caws ${similar}?`));
    }

    console.error(
      chalk.yellow('💡 Available commands: init, validate, scaffold, provenance, hooks')
    );
    console.error(chalk.yellow('💡 Try: caws --help for full command list'));
    console.error(
      chalk.blue(
        '\n📚 Documentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
      )
    );

    process.exit(1);
  }

  // Check for unknown option
  if (err.code === 'commander.unknownOption' || err.message.includes('unknown option')) {
    const optionMatch = err.message.match(/unknown option ['"]([^'"]+)['"]/i);
    const option = optionMatch ? optionMatch[1] : '';

    console.error(chalk.red(`\n❌ Unknown option: ${option}`));
    console.error(chalk.yellow(`\n💡 Try: caws ${commandName || ''} --help for available options`));

    // Provide specific suggestions for common mistakes
    if (option === '--suggestions' || option === '--suggest') {
      console.error(chalk.yellow('💡 Note: Validation includes suggestions by default'));
      console.error(chalk.yellow('   Just run: caws validate'));
    }

    console.error(
      chalk.blue(
        '\n📚 Documentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
      )
    );

    process.exit(1);
  }

  // Generic Commander error
  console.error(chalk.red('\n❌ Error:'), err.message);
  console.error(chalk.yellow('\n💡 Try: caws --help for usage information'));
  console.error(
    chalk.blue(
      '\n📚 Documentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/agents/full-guide.md'
    )
  );
  process.exit(1);
});

// Parse and run
if (require.main === module) {
  try {
    program.parse();
  } catch (error) {
    // Handle help and version requests gracefully
    if (
      error.code === 'commander.help' ||
      error.code === 'commander.version' ||
      error.message.includes('outputHelp')
    ) {
      process.exit(0);
    }

    // Enhanced error handling for Commander.js errors
    const commandName = process.argv[2];
    const context = {
      command: commandName,
      option: process.argv[3],
    };

    // Check for unknown command
    if (error.code === 'commander.unknownCommand') {
      const validCommands = [
        'init',
        'validate',
        'scaffold',
        'provenance',
        'hooks',
        'burnup',
        'tool',
      ];
      const similar = findSimilarCommand(commandName, validCommands);

      console.error(chalk.red(`\n❌ Unknown command: ${commandName}`));

      if (similar) {
        console.error(chalk.yellow(`\n💡 Did you mean: caws ${similar}?`));
      }

      console.error(
        chalk.yellow('💡 Available commands: init, validate, scaffold, provenance, hooks')
      );
      console.error(chalk.yellow('💡 Try: caws --help for full command list'));
      console.error(
        chalk.blue(
          '\n📚 Documentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
        )
      );

      process.exit(1);
    }

    // Check for unknown option
    if (error.code === 'commander.unknownOption' || error.message.includes('unknown option')) {
      const optionMatch = error.message.match(/unknown option ['"]([^'"]+)['"]/i);
      const option = optionMatch ? optionMatch[1] : '';

      console.error(chalk.red(`\n❌ Unknown option: ${option}`));
      console.error(
        chalk.yellow(`\n💡 Try: caws ${commandName || ''} --help for available options`)
      );

      // Provide specific suggestions for common mistakes
      if (option === '--suggestions' || option === '--suggest') {
        console.error(chalk.yellow('💡 Note: Validation includes suggestions by default'));
        console.error(chalk.yellow('   Just run: caws validate'));
      }

      console.error(
        chalk.blue(
          '\n📚 Documentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
        )
      );

      process.exit(1);
    }

    // Generic error with enhanced handling
    handleCliError(error, context, true);
  }
}

// Export functions for testing
module.exports = {
  generateWorkingSpec,
  validateGeneratedSpec,
};
