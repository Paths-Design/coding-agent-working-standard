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
const { qualityGatesCommand } = require('./commands/quality-gates');
const { troubleshootCommand } = require('./commands/troubleshoot');
const { archiveCommand } = require('./commands/archive');
const { specsCommand } = require('./commands/specs');
const { modeCommand } = require('./commands/mode');
const { tutorialCommand } = require('./commands/tutorial');
const { planCommand } = require('./commands/plan');

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
  .option('--with-quality-gates', 'Install quality gates package and scripts', false)
  .action(scaffoldProject);

// Validate command
program
  .command('validate')
  .description('Validate CAWS spec with suggestions')
  .argument('[spec-file]', 'Path to spec file (optional, uses spec resolution)')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth, FEAT-001)')
  .option('-i, --interactive', 'Interactive spec selection when multiple specs exist', false)
  .option('-q, --quiet', 'Suppress suggestions and warnings', false)
  .option('--auto-fix', 'Automatically fix safe validation issues', false)
  .option('--dry-run', 'Preview auto-fixes without applying them', false)
  .option('--format <format>', 'Output format (text, json)', 'text')
  .action(validateCommand);

// Quality Gates command
program
  .command('quality-gates')
  .description('Run comprehensive quality gates (naming, duplication, god objects, documentation)')
  .option('--ci', 'CI mode - exit with error code if violations found', false)
  .option('--json', 'Output machine-readable JSON to stdout', false)
  .option(
    '--gates <gates>',
    'Run only specific gates (comma-separated: naming,code_freeze,duplication,god_objects,documentation)',
    ''
  )
  .option('--fix', 'Attempt automatic fixes (experimental)', false)
  .option('--help', 'Show detailed help and usage examples', false)
  .action(async (options) => {
    // Handle --help flag
    if (options.help) {
      console.log(`
CAWS Quality Gates - Enterprise Code Quality Enforcement

USAGE:
  caws quality-gates [options]

DESCRIPTION:
  Runs comprehensive quality gates to maintain code quality standards.
  Supports selective gate execution, JSON output, and CI/CD integration.

OPTIONS:
  --ci              CI mode - exit with error code if violations found
  --json            Output machine-readable JSON to stdout
  --gates=<gates>   Run only specific gates (comma-separated)
  --fix             Attempt automatic fixes (experimental)
  --help            Show this help message

VALID GATES:
  naming           Check naming conventions and banned modifiers
  code_freeze      Enforce code freeze compliance
  duplication      Detect functional duplication
  god_objects      Prevent oversized files
  documentation    Check documentation quality

EXAMPLES:
  # Run all gates in development mode
  caws quality-gates

  # Run only specific gates
  caws quality-gates --gates=naming,duplication

  # CI mode with JSON output
  caws quality-gates --ci --json

  # Show detailed help
  caws quality-gates --help

OUTPUT:
  - Console: Human-readable results with enforcement levels
  - JSON: Machine-readable structured data (--json flag)
  - Artifacts: docs-status/quality-gates-report.json
  - GitHub Actions: Automatic step summaries when GITHUB_STEP_SUMMARY is set

For more information, see: packages/quality-gates/README.md
`);
      process.exit(0);
    }

    // Call the actual quality gates runner
    await qualityGatesCommand(options);
  });

// Status command
program
  .command('status')
  .description('Show project health overview')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('-s, --spec <path>', 'Path to spec file (explicit override)')
  .option('--visual', 'Enhanced visual output with progress bars', false)
  .option('--json', 'Output in JSON format for automation', false)
  .action(statusCommand);

// Archive command
program
  .command('archive <change-id>')
  .description('Archive completed change')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('-f, --force', 'Force archive even if criteria not met', false)
  .option('--dry-run', 'Preview archive without performing it', false)
  .action(archiveCommand);

// Specs command group
const specsCmd = program.command('specs').description('Manage multiple CAWS spec files');

// Specs subcommands
specsCmd
  .command('list')
  .description('List all available specs')
  .action(() => specsCommand('list', {}));

specsCmd
  .command('create <id>')
  .description('Create a new spec (with conflict resolution)')
  .option('-t, --type <type>', 'Spec type (feature, fix, refactor, chore, docs)', 'feature')
  .option('--title <title>', 'Spec title')
  .option('--tier <tier>', 'Risk tier (T1, T2, T3)', 'T3')
  .option('--mode <mode>', 'Development mode', 'development')
  .option('-f, --force', 'Override existing specs without confirmation', false)
  .option('-i, --interactive', 'Ask for confirmation on conflicts', false)
  .action((id, options) => specsCommand('create', { id, ...options }));

specsCmd
  .command('show <id>')
  .description('Show detailed spec information')
  .action((id) => specsCommand('show', { id }));

specsCmd
  .command('update <id>')
  .description('Update spec properties')
  .option('-s, --status <status>', 'Spec status (draft, active, completed)')
  .option('--title <title>', 'Spec title')
  .option('--description <desc>', 'Spec description')
  .action((id, options) => specsCommand('update', { id, ...options }));

specsCmd
  .command('delete <id>')
  .description('Delete a spec')
  .action((id) => specsCommand('delete', { id }));

specsCmd
  .command('conflicts')
  .description('Check for scope conflicts between specs')
  .action(() => specsCommand('conflicts', {}));

specsCmd
  .command('migrate')
  .description('Migrate from legacy working-spec.yaml to feature-specific specs')
  .option('-i, --interactive', 'Interactive feature selection', false)
  .option('-f, --features <features>', 'Comma-separated list of features to migrate', (value) =>
    value.split(',')
  )
  .action((options) => specsCommand('migrate', options));

specsCmd
  .command('types')
  .description('Show available spec types')
  .action(() => specsCommand('types', {}));

// Mode command group
const modeCmd = program.command('mode').description('Manage CAWS complexity tiers');

// Mode subcommands
modeCmd
  .command('current')
  .description('Show current CAWS mode')
  .action(() => modeCommand('current', {}));

modeCmd
  .command('set <mode>')
  .description('Set CAWS complexity tier')
  .action((mode) => modeCommand('set', { mode }));

modeCmd
  .command('set')
  .description('Set CAWS complexity tier (interactive)')
  .option('-i, --interactive', 'Interactive mode selection', false)
  .option('-m, --mode <mode>', 'Specific mode to set')
  .action((options) => modeCommand('set', options));

modeCmd
  .command('compare')
  .description('Compare all available tiers')
  .action(() => modeCommand('compare', {}));

modeCmd
  .command('recommend')
  .description('Get tier recommendation for your project')
  .option('--size <size>', 'Project size (small, medium, large)', 'medium')
  .option('--team-size <size>', 'Team size (number)', '1')
  .option('--compliance <required>', 'Compliance requirements (true/false)', 'false')
  .option('--audit <required>', 'Audit requirements (true/false)', 'false')
  .option('--details', 'Show detailed recommendation', false)
  .action((options) => modeCommand('recommend', options));

modeCmd
  .command('details <mode>')
  .description('Show detailed information about a specific tier')
  .action((mode) => modeCommand('details', { mode }));

// Tutorial command
program
  .command('tutorial [type]')
  .description('Interactive guided learning for CAWS')
  .action(tutorialCommand);

// Plan command
program
  .command('plan <action>')
  .description('Generate implementation plans')
  .option('--spec-id <id>', 'Spec ID to generate plan for')
  .option('--spec <id>', 'Alias for --spec-id')
  .option('--output <path>', 'Output file path for the plan')
  .action((action, options) => planCommand(action, options));

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
  .option('--spec-id <id>', 'Feature-specific spec ID')
  .option('--fix', 'Apply automatic fixes', false)
  .action(diagnoseCommand);

// Evaluate command
program
  .command('evaluate [spec-file]')
  .description('Evaluate work against CAWS quality standards')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(evaluateCommand);

// Iterate command
program
  .command('iterate [spec-file]')
  .description('Get iterative development guidance')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('--current-state <json>', 'Current implementation state as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(iterateCommand);

// Waivers command group
const waiversCmd = program.command('waivers').description('Manage CAWS quality gate waivers');

// Waivers subcommands
waiversCmd
  .command('create')
  .description('Create a new quality gate waiver')
  .requiredOption('--title <title>', 'Waiver title')
  .requiredOption(
    '--reason <reason>',
    'Reason for waiver (emergency_hotfix, legacy_integration, etc.)'
  )
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
  .description('Get workflow-specific guidance')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('--step <number>', 'Current step in workflow', '1')
  .option('--current-state <json>', 'Current implementation state as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((type, options) => workflowCommand(type, options));

// Quality Monitor command
program
  .command('quality-monitor <action>')
  .description('Monitor code quality impact in real-time')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('--files <files>', 'Files affected (comma-separated)')
  .option('--context <json>', 'Additional context as JSON', '{}')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(qualityMonitorCommand);

// Troubleshoot command - temporarily disabled due to registration issue
// program
//   .command('troubleshoot [guide]')
//   .description('Display troubleshooting guides for common CAWS issues')
//   .option('-l, --list', 'List all available troubleshooting guides', false)
//   .action(troubleshootCommand);

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
  .description('Statistical analysis for budget prediction')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .action(testAnalysisCommand);

// Provenance command group
const provenanceCmd = program.command('provenance').description('Manage CAWS provenance tracking');

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
      'archive',
      'specs',
      'mode',
      'tutorial',
      'plan',
      'templates',
      'diagnose',
      'evaluate',
      'iterate',
      'waivers',
      'workflow',
      'quality-monitor',
      'troubleshoot',
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
        'status',
        'archive',
        'specs',
        'mode',
        'tutorial',
        'plan',
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
