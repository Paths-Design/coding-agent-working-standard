#!/usr/bin/env node

/**
 * @fileoverview CAWS CLI - Scaffolding tool for Coding Agent Working Standard
 * Provides commands to initialize new projects and scaffold existing ones with CAWS.
 * Includes spec management, quality gates, and AI-assisted development workflows.
 * @author @darianrosebrook
 */

const { Command } = require('commander');
const chalk = require('chalk');

if (
  process.argv.includes('--json') ||
  process.argv.includes('--quiet') ||
  process.argv.includes('-q')
) {
  process.env.CAWS_QUIET = '1';
}

// Import configuration and utilities
const { CLI_VERSION } = require('./config');

// Import error handling
const { handleCliError, findSimilarCommand } = require('./error-handler');

// v11.0.0 entrypoint. The CLI surface is registered exclusively
// through `registerShellCommands(program)` further down. All legacy
// command groups, imports, public exports, and startup side effects
// were removed in slices 8a3.1–8a3.5. See
// docs/architecture/caws-vnext-command-surface.md for the doctrine,
// removal table, and the canonical v11 surface.
//
// What v11 ships: init, doctor, status, scope, claim, gates,
// evidence, waiver. Nothing else.

// Initialize global configuration
const program = new Command();

program
  .name('caws')
  .description('CAWS - Coding Agent Working Standard CLI')
  .version(CLI_VERSION)
  .showHelpAfterError(false);

program.configureHelp({
  showError: () => {},
});

// v11.0.0 surface: exactly the 8 vNext command groups registered by
// `registerShellCommands(program)`. Used by `findSimilarCommand` for
// unknown-command suggestions. Must match `node dist/index.js --help`
// output (excluding Commander's auto-generated `help` row).
//
// Slice 8a3.5 reconciliation: dropped 24 legacy entries removed in
// 8a3.1–8a3.4 plus the stale `'quality-gates'` alias (alias was
// removed in slice 6c but the suggester entry was never cleaned).
// Added the 5 vNext groups that were missing from the suggester:
// 'agents' (now removed), 'claim', 'doctor', 'evidence',
// 'test-analysis' (now removed). Final list is exactly the 8 vNext
// groups currently registered.
const VALID_COMMANDS = [
  'claim',
  'doctor',
  'evidence',
  'gates',
  'init',
  'scope',
  'status',
  'waiver',
];

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
    const similar = findSimilarCommand(commandName, VALID_COMMANDS);

    console.error(chalk.red(`\nUnknown command: ${commandName}`));

    if (similar) {
      console.error(chalk.yellow(`\nDid you mean: caws ${similar}?`));
    }

    console.error(chalk.yellow('Run: caws --help for the full command list'));
    console.error(chalk.yellow('Try: caws --help for full command list'));
    console.error(
      chalk.blue(
        '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
      )
    );

    process.exit(1);
  }

  // Check for unknown option
  if (err.code === 'commander.unknownOption' || err.message.includes('unknown option')) {
    const optionMatch = err.message.match(/unknown option ['"]([^'"]+)['"]/i);
    const option = optionMatch ? optionMatch[1] : '';

    console.error(chalk.red(`\nUnknown option: ${option}`));
    console.error(chalk.yellow(`\nTry: caws ${commandName || ''} --help for available options`));

    console.error(
      chalk.blue(
        '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
      )
    );

    process.exit(1);
  }

  // Generic Commander error
  console.error(chalk.red('\nError:'), err.message);
  console.error(chalk.yellow('\nTry: caws --help for usage information'));
  console.error(
    chalk.blue(
      '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/agents/full-guide.md'
    )
  );
  process.exit(1);
});

// Register vNext shell commands. This is the only registration block
// in v11; all command groups are in src/shell/. The legacy registration
// blocks above this line were removed in slices 8a3.1–8a3.4 as part of
// the v11.0.0 cutover.
const { registerShellCommands } = require('./shell');
registerShellCommands(program);

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
      const similar = findSimilarCommand(commandName, VALID_COMMANDS);

      console.error(chalk.red(`\nUnknown command: ${commandName}`));

      if (similar) {
        console.error(chalk.yellow(`\nDid you mean: caws ${similar}?`));
      }

      console.error(chalk.yellow('Run: caws --help for the full command list'));
      console.error(chalk.yellow('Try: caws --help for full command list'));
      console.error(
        chalk.blue(
          '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
        )
      );

      process.exit(1);
    }

    // Check for unknown option
    if (error.code === 'commander.unknownOption' || error.message.includes('unknown option')) {
      const optionMatch = error.message.match(/unknown option ['"]([^'"]+)['"]/i);
      const option = optionMatch ? optionMatch[1] : '';

      console.error(chalk.red(`\nUnknown option: ${option}`));
      console.error(
        chalk.yellow(`\nTry: caws ${commandName || ''} --help for available options`)
      );

      console.error(
        chalk.blue(
          '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
        )
      );

      process.exit(1);
    }

    // Generic error with enhanced handling
    handleCliError(error, context, true);
  }
}

// Public API surface removed in slice 8a3 (v11.0.0 cutover). The
// legacy `generateWorkingSpec` / `validateGeneratedSpec` helpers were
// part of v10.x's exported API; v11 ships only the binary entry point
// and exposes no JS exports from this module. Programmatic consumers
// should depend on `@paths.design/caws-kernel` (pure logic) or the
// `dist/shell` / `dist/store` modules directly.
module.exports = {};
