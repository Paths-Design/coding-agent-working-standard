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
const { testAnalysisCommand } = require('./test-analysis');
// Legacy `caws provenance` removed in slice 8a3.1 (v11.0.0 cutover).
// The hash-chained audit trail moves to `.caws/events.jsonl` written
// only by the vNext store. No compatibility alias.
const { executeTool } = require('./commands/tool');
// Legacy `caws status` replaced by the vNext shell command registered
// via registerShellCommands() below. See packages/caws-cli/src/shell/.
const { templatesCommand } = require('./commands/templates');
// Legacy `caws waivers` replaced by the vNext shell group `caws waiver`
// registered via registerShellCommands() below. The legacy file is no
// longer referenced from this entry point.
const { workflowCommand } = require('./commands/workflow');
const { qualityMonitorCommand } = require('./commands/quality-monitor');
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
const { modeCommand } = require('./commands/mode');
const { tutorialCommand } = require('./commands/tutorial');
const { planCommand } = require('./commands/plan');
const { sessionCommand } = require('./commands/session');
const { sidecarCommand } = require('./commands/sidecar');
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

// Sidecar command group
const sidecarCmd = program.command('sidecar').description('Advisory analysis tools (drift, gaps, waivers, provenance)');

sidecarCmd
  .command('drift')
  .description('Analyze spec drift vs implementation evidence')
  .option('--spec-id <id>', 'Target spec ID')
  .option('--json', 'Output as JSON', false)
  .action((options) => sidecarCommand('drift', options));

sidecarCmd
  .command('gaps')
  .description('Diagnose quality gaps preventing phase advancement')
  .option('--spec-id <id>', 'Target spec ID')
  .option('--json', 'Output as JSON', false)
  .action((options) => sidecarCommand('gaps', options));

sidecarCmd
  .command('waiver-draft')
  .description('Generate pre-filled waiver templates from gate failures')
  .option('--spec-id <id>', 'Target spec ID')
  .option('--gate <gate>', 'Specific gate to draft waiver for')
  .option('--json', 'Output as JSON', false)
  .action((options) => sidecarCommand('waiver-draft', options));

sidecarCmd
  .command('provenance')
  .description('Summarize work provenance for merge readiness')
  .option('--spec-id <id>', 'Target spec ID')
  .option('--json', 'Output as JSON', false)
  .action((options) => sidecarCommand('provenance', options));

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

// Legacy `caws worktree` group removed in slice 8a3.2.
// Lifecycle gap; binding overlap with vNext `caws claim`. v11.1 will
// reintroduce vNext worktree lifecycle.

// Agents command group
const { agentsCommand } = require('./commands/agents');
const agentsCmd = program
  .command('agents')
  .description('Inspect the agent registry and session-log pointers');

agentsCmd
  .command('list')
  .description('List active CAWS-registered agent sessions')
  .action(() => agentsCommand('list', {}));

agentsCmd
  .command('show <session-id>')
  .description('Show details for a specific agent session, including session-log pointer')
  .action((id) => agentsCommand('show', { id }));

// Scope command group is registered via registerShellCommands() below.
// The legacy no-arg `scope show` has been removed; see src/shell/register.ts.

// Session command group
const sessionCmd = program
  .command('session')
  .description('Manage session lifecycle and capsules for multi-agent coordination');

sessionCmd
  .command('start')
  .description('Start a new tracked session with baseline checkpoint')
  .option('--role <role>', 'Agent role (worker, integrator, qa)', 'worker')
  .option('--spec-id <id>', 'Associated feature spec ID')
  .option('--scope <patterns>', 'Allowed file patterns (comma-separated)')
  .option('--intent <text>', 'What this session intends to accomplish')
  .action((options) => sessionCommand('start', options));

sessionCmd
  .command('checkpoint')
  .description('Record a checkpoint in the current session')
  .option('--session-id <id>', 'Specific session ID (uses latest active if omitted)')
  .option('--intent <text>', 'Updated intent description')
  .option('--paths <paths>', 'Files changed (comma-separated)')
  .option('--tests <json>', 'Test results as JSON array [{name, status, evidence}]')
  .option('--issues <json>', 'Known issues as JSON array [{type, description}]')
  .action((options) => sessionCommand('checkpoint', options));

sessionCmd
  .command('end')
  .description('End the current session with handoff information')
  .option('--session-id <id>', 'Specific session ID (uses latest active if omitted)')
  .option('--next-actions <actions>', 'Handoff actions (pipe-separated)')
  .option('--risk-notes <notes>', 'Risk notes (pipe-separated)')
  .action((options) => sessionCommand('end', options));

sessionCmd
  .command('list')
  .description('List all sessions')
  .option('--status <status>', 'Filter by status (active, completed)')
  .option('--limit <n>', 'Max entries to show')
  .action((options) => sessionCommand('list', options));

sessionCmd
  .command('show [id]')
  .description('Show session capsule details (default: latest)')
  .option('--json', 'Output as raw JSON', false)
  .action((id, options) => sessionCommand('show', { ...options, id: id || 'latest' }));

sessionCmd
  .command('briefing')
  .description('Show session briefing for hooks/startup')
  .action(() => sessionCommand('briefing'));

// Legacy `caws parallel` group removed in slice 8a3.2.
// Lifecycle gap; orchestrates worktrees + sessions which are also
// removed. v11.1 may reintroduce vNext multi-agent orchestration.

// Templates command
program
  .command('templates [subcommand]')
  .description('Discover and manage project templates')
  .option('-n, --name <template>', 'Template name (for info subcommand)')
  .action(templatesCommand);

// Legacy `caws diagnose`, `caws verify-acs`, `caws evaluate`,
// `caws iterate`, `caws burnup` removed in slice 8a3.3.
// All authority-conflict commands using legacy spec-resolver / event
// log. v11 spec health surfaces via `caws doctor`.

// Legacy plural `waivers` command group was removed in slice 7a.4.
// The vNext singular `caws waiver` group (create | list | show | revoke)
// is registered via shell.registerShellCommands. No compatibility alias.

// Workflow command group
program
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

// Troubleshoot command available via: caws diagnose --troubleshoot <guide>
// The standalone command was consolidated into the diagnose command.

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
  .action((subcommand, optionArgs, command) => {
    testAnalysisCommand(subcommand, optionArgs, command.opts());
  });

// Legacy `caws provenance` group removed in slice 8a3 (v11.0.0 cutover).
// `.caws/events.jsonl` (vNext store) is the v11 audit chain. Old
// `.caws/provenance/` is treated as legacy residue.

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
  'sidecar',
  'mode',
  'tutorial',
  'plan',
  'templates',
  'waiver',
  'workflow',
  'quality-monitor',
  'quality-gates',
  'gates',
  'tool',
  'session',
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

// Register sidecar lifecycle listeners (non-fatal hints)
try {
  const { registerSidecarListeners } = require('./sidecars/listeners');
  registerSidecarListeners();
} catch { /* sidecars module not available — non-fatal */ }

// Register vNext shell commands (doctor, scope show/check, evidence record).
// These REPLACE the legacy scope group above (no env-var flag, no alias).
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
