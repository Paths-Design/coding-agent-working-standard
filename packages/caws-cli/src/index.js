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

// Single authority for the registered v11 command groups (replaces the
// stale hand-maintained VALID_COMMANDS list) and the legacy-command
// diagnostic surface (CAWS-REMOVED-COMMAND-DIAGNOSTICS-001).
const { REGISTERED_COMMAND_GROUPS } = require('./shell/registered-command-groups');
const {
  classifyLegacyCommand,
  formatLegacyDiagnostic,
} = require('./shell/legacy-command-map');

// v11.0.0 entrypoint. The CLI surface is registered exclusively
// through `registerShellCommands(program)` further down. All legacy
// command groups, imports, public exports, and startup side effects
// were removed in slices 8a3.1–8a3.5. See
// docs/architecture/caws-vnext-command-surface.md for the doctrine,
// removal table, and the canonical v11 surface.
//
// What v11.1 ships: the twelve registered command groups — init,
// doctor, status, scope, claim, gates, evidence, events, waiver, specs,
// worktree, agents. The authoritative list is REGISTERED_COMMAND_GROUPS
// (./shell/registered-command-groups), consumed by both register.ts and
// the unknown-command suggester below. (The original v11.0.0 governed
// core was eight groups; specs + worktree were restored in v11.1, and
// events + agents shipped ahead of the broader v11.2 multi-agent plan.)

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

// The unknown-command fuzzy suggester reads REGISTERED_COMMAND_GROUPS
// (imported above from ./shell/registered-command-groups), the single
// authority for the registered v11 surface. The previous hand-maintained
// 8-entry VALID_COMMANDS array was removed in
// CAWS-REMOVED-COMMAND-DIAGNOSTICS-001: it had drifted to 8 entries while
// register.ts registers 12 groups, so suggestions never fired for events,
// specs, worktree, or agents.

// Shared unknown-command handler. First classifies the argv against the
// legacy v10.2 command map (longest-prefix); if it matches, prints typed
// migration guidance and exits 1 WITHOUT executing any v11 command (no
// alias, no shim, no dispatch). If no legacy match, falls back to the
// fuzzy suggester over REGISTERED_COMMAND_GROUPS for genuine typos.
function reportUnknownCommand(commandName) {
  const legacy = classifyLegacyCommand(process.argv.slice(2));
  if (legacy) {
    console.error(chalk.red(`\nUnknown command: ${commandName}`));
    const lines = formatLegacyDiagnostic(legacy);
    for (const line of lines) {
      console.error(chalk.yellow(line));
    }
    process.exit(1);
  }

  const similar = findSimilarCommand(commandName, REGISTERED_COMMAND_GROUPS);
  console.error(chalk.red(`\nUnknown command: ${commandName}`));
  if (similar) {
    console.error(chalk.yellow(`\nDid you mean: caws ${similar}?`));
  }
  console.error(chalk.yellow('Run: caws --help for the full command list'));
  console.error(
    chalk.blue(
      '\nDocumentation: https://github.com/Paths-Design/coding-agent-working-standard/blob/main/docs/api/cli.md'
    )
  );
  process.exit(1);
}

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
    reportUnknownCommand(commandName);
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
      reportUnknownCommand(commandName);
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
