#!/usr/bin/env node

/**
 * @fileoverview CAWS CLI - Scaffolding tool for Coding Agent Workflow System
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

// Import command handlers
// Legacy top-level `caws init` replaced by the vNext shell command
// registered via registerShellCommands() below. The legacy file
// (./commands/init.js) is left on disk; it's no longer referenced
// here. The `provenance init` subcommand is unrelated and unaffected.
// Legacy `caws validate`, `caws verify-acs`, `caws evaluate`,
// `caws iterate`, `caws diagnose`, `caws burnup` removed in slice
// 8a3.3 (v11.0.0 cutover). All authority-conflict commands:
//   - validate / verify-acs / evaluate use legacy spec-resolver
//     (working-spec.yaml fallback) and write via legacy appendEvent.
//   - diagnose advertises removed commands ("caws validate, caws
//     quality-gates, caws provenance") as "core" in its fix guidance.
//   - iterate / burnup are advisory but pull through the same legacy
//     spec-resolver chain.
// Spec health surfaces in v11 via `caws doctor`; gate evaluation via
// `caws gates run`. v11.1 will add explicit validation flow.
// Legacy `caws provenance` removed in slice 8a3.1 (v11.0.0 cutover).
// The hash-chained audit trail moves to `.caws/events.jsonl` written
// only by the vNext store. No compatibility alias.
//
// Legacy peripherals (`caws sidecar`, `mode`, `tutorial`, `plan`,
// `templates`, `workflow`, `quality-monitor`, `tool`, `test-analysis`,
// `agents`, `session`) removed in slice 8a3.4 — none are part of the
// governed core under A1.
//
// Legacy `caws status` replaced by the vNext shell command registered
// via registerShellCommands() below. See packages/caws-cli/src/shell/.
// Legacy `caws waivers` replaced by the vNext shell group `caws waiver`
// registered via registerShellCommands() below. The legacy file is no
// longer referenced from this entry point.
// Legacy `caws gates` and `caws quality-gates` replaced by the vNext
// shell group registered via registerShellCommands() below.
// Legacy `caws archive`, `caws specs`, `caws worktree`, `caws parallel`
// removed in slice 8a3.2 (v11.0.0 cutover). Reason categories:
//   - archive: PE+LG (writes .caws/provenance/chain.json; lifecycle gap)
//   - specs:   LG+AC (lifecycle gap; appendEvent on legacy log; legacy
//              spec-resolver fallback to working-spec.yaml)
//   - worktree: LG (lifecycle gap; binding overlap with vNext claim)
//   - parallel: LG (lifecycle gap; orchestrates multiple worktrees)
// vNext lifecycle returns in v11.1; pin to caws-cli@^10.2.x for the
// legacy lifecycle CLI.
// Legacy scope command replaced by the vNext shell group registered
// via registerShellCommands() below. See packages/caws-cli/src/shell/.

// Legacy `caws scaffold` and `caws hooks` removed in slice 8a3
// (v11.0.0 cutover). Both installed legacy regime artifacts (templates
// referencing removed commands; git hooks calling `caws validate` /
// `caws provenance update`). v11 ships only the governed core; users
// hand-wire any project tooling against vNext surfaces.
//
// Legacy `generateWorkingSpec` / `validateGeneratedSpec` (legacy single-
// spec generator) also removed — these were exported from this module's
// public API in v10.x; the v11 cutover is a breaking change consistent
// with A1 (no compatibility for legacy-spec generation).

// Initialize global configuration
const program = new Command();

// Setup CLI program
program
  .name('caws')
  .description('CAWS - Coding Agent Workflow System CLI')
  .version(CLI_VERSION)
  .showHelpAfterError(false); // We'll show better suggestions instead

// Legacy top-level `caws init` was removed in slice 7b. The vNext
// `caws init` is registered via shell.registerShellCommands. No
// compatibility alias, no feature flag. The unrelated `provenance init`
// subcommand below is untouched.

// Legacy `caws validate` (and `verify` alias) removed in slice 8a3.3.
// Used legacy spec-resolver (working-spec.yaml fallback) and wrote
// gate_evaluated events via legacy appendEvent on a parallel chain.
// Spec health surfaces in v11 via `caws doctor`.

// `caws gates run` is registered via registerShellCommands() below
// (vNext policy-driven gate runner). The legacy `gates` group and the
// `quality-gates` alias were removed in Slice 6c — no env-var flag,
// no compatibility alias.

// Status command
// `caws status` is registered via registerShellCommands() below
// (vNext read-only dashboard). The legacy registration was removed in
// Slice 6b — no env-var flag, no alias.

// Legacy `caws archive` and `caws specs` removed in slice 8a3.2.
// archive: writes .caws/provenance/chain.json (PE conflict).
// specs: appendEvent on legacy log; spec-resolver legacy fallback.
// vNext lifecycle returns in v11.1.

// Legacy peripherals removed in slice 8a3.4 (v11.0.0 cutover):
//   sidecar, mode, tutorial, plan, agents, session, templates,
//   workflow, quality-monitor, tool, test-analysis
// None are part of the governed core under A1. Where overlap with
// vNext exists (e.g. `agents` overlaps with `caws status`/`caws claim`
// panels), use the vNext surface. Source files left on disk for
// archaeology; deleted in 8e.

// Legacy `caws hooks` group removed in slice 8a3 (v11.0.0 cutover).
// Generated hooks called removed commands (`caws validate`, `caws
// provenance update`); v11 does not ship git-hook installation. Users
// wire their own hooks against vNext surfaces (`caws doctor`, `caws
// gates run`) if desired.

// Error handling
// Custom error event handler for better messages
program.configureHelp({
  // Override error display
  showError: () => {}, // Suppress default error display
});

const VALID_COMMANDS = [
  'init',
  'status',
  'waiver',
  'quality-gates',
  'gates',
  'scope',
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

    // Provide specific suggestions for common mistakes
    if (option === '--suggestions' || option === '--suggest') {
      console.error(chalk.yellow('Note: Validation includes suggestions by default'));
      console.error(chalk.yellow('   Just run: caws validate'));
    }

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

      // Provide specific suggestions for common mistakes
      if (option === '--suggestions' || option === '--suggest') {
        console.error(chalk.yellow('Note: Validation includes suggestions by default'));
        console.error(chalk.yellow('   Just run: caws validate'));
      }

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
