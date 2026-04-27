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
const { gatesCommand } = require('./commands/gates');
const { archiveCommand } = require('./commands/archive');
const { specsCommand } = require('./commands/specs');
const { modeCommand } = require('./commands/mode');
const { tutorialCommand } = require('./commands/tutorial');
const { planCommand } = require('./commands/plan');
const { worktreeCommand } = require('./commands/worktree');
const { sessionCommand } = require('./commands/session');
const { parallelCommand } = require('./commands/parallel');
const { verifyAcsCommand } = require('./commands/verify-acs');
const { sidecarCommand } = require('./commands/sidecar');
const { scopeCommand } = require('./commands/scope');

// Import scaffold functionality
const { scaffoldProject, setScaffoldDependencies } = require('./scaffold');

// Import git hooks functionality
const { scaffoldGitHooks, removeGitHooks, checkGitHooksStatus } = require('./scaffold/git-hooks');

// Import finalization utilities
const {
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
  .option('--mode <mode>', 'CAWS mode (lite, simple, standard, enterprise)')
  .option('--ide <ides>', 'IDE integrations to install (comma-separated: cursor,claude,vscode,intellij,windsurf,copilot,all,none)')
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
  .option('--ide <ides>', 'IDE integrations to install (comma-separated: cursor,claude,vscode,intellij,windsurf,copilot,all,none)')
  .action(scaffoldProject);

// Validate command
program
  .command('validate')
  .alias('verify')
  .description('Validate CAWS spec with suggestions')
  .argument('[spec-file]', 'Path to spec file (optional, uses spec resolution)')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth, FEAT-001)')
  .option('-i, --interactive', 'Interactive spec selection when multiple specs exist', false)
  .option('-q, --quiet', 'Suppress suggestions and warnings', false)
  .option('--auto-fix', 'Automatically fix safe validation issues', false)
  .option('--dry-run', 'Preview auto-fixes without applying them', false)
  .option('--format <format>', 'Output format (text, json)', 'text')
  .action(validateCommand);

// Gates command group (v2 pipeline)
const gatesCmd = program
  .command('gates')
  .description('Run quality gate checks');

gatesCmd
  .command('run')
  .description('Run quality gates against staged files or a specific file')
  .option('--context <context>', 'Execution context (cli, commit, edit)', 'cli')
  .option('--spec-id <id>', 'Target spec ID')
  .option('--file <path>', 'Single file to check (for edit context)')
  .option('--json', 'Output as JSON', false)
  .option('--quiet', 'Minimal output', false)
  .action((options) => gatesCommand(options));

// Quality Gates command (legacy alias — delegates to gates command)
program
  .command('quality-gates')
  .description('Run quality gates (alias for "caws gates run")')
  .option('--ci', 'CI mode - exit with error code if violations found', false)
  .option('--json', 'Output machine-readable JSON to stdout', false)
  .option('--context <context>', 'Execution context: commit, push, ci', 'commit')
  .option('--all-files', 'Check all tracked files (equivalent to --context=ci)', false)
  .option('--spec-id <id>', 'Target spec ID')
  .option('--quiet', 'Minimal output', false)
  .action(async (options) => {
    // Map legacy options to new gates command options
    const gateOpts = {
      context: options.allFiles ? 'ci' : (options.context || 'cli'),
      specId: options.specId,
      json: options.json,
      quiet: options.quiet,
    };
    await gatesCommand(gateOpts);
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
  .option('-s, --spec <path>', 'Path to spec file (explicit override)')
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
  .option('-s, --status <status>', 'Spec status (draft, active, in_progress, completed, closed, archived)')
  .option('--title <title>', 'Spec title')
  .option('--description <desc>', 'Spec description')
  .action((id, options) => specsCommand('update', { id, ...options }));

specsCmd
  .command('delete <id>')
  .description('Delete a spec')
  .action((id) => specsCommand('delete', { id }));

specsCmd
  .command('close <id>')
  .description('Close a completed spec (removes scope enforcement)')
  .action((id) => specsCommand('close', { id }));

specsCmd
  .command('archive <id>')
  .description('Archive a spec — move to .caws/specs/.archive/ and flip status to archived')
  .action((id) => specsCommand('archive', { id }));

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

// Worktree command group
const worktreeCmd = program
  .command('worktree')
  .description('Manage git worktrees for agent scope isolation');

worktreeCmd
  .command('create <name>')
  .description('Create a new isolated worktree')
  .option('--scope <patterns>', 'Sparse checkout patterns (comma-separated, e.g., "src/auth/**")')
  .option('--base-branch <branch>', 'Base branch to create from')
  .option('--spec-id <id>', 'Associated spec ID')
  .action((name, options) => worktreeCommand('create', { name, ...options }));

worktreeCmd
  .command('list')
  .description('List all managed worktrees')
  .action(() => worktreeCommand('list'));

worktreeCmd
  .command('destroy <name>')
  .description('Destroy a worktree')
  .option('--delete-branch', 'Also delete the associated branch', false)
  .option('--force', 'Force removal even if worktree is dirty', false)
  .action((name, options) => worktreeCommand('destroy', { name, ...options }));

worktreeCmd
  .command('merge <name>')
  .description('Merge a worktree branch back to base (destroy + merge + cleanup)')
  .option('--dry-run', 'Preview conflicts without merging', false)
  .option('--message <msg>', 'Custom merge commit message')
  .option('--no-delete-branch', 'Keep the branch after merging')
  .action((name, options) => worktreeCommand('merge', { name, ...options }));

worktreeCmd
  .command('prune')
  .description('Clean up stale worktree entries')
  .option('--max-age <days>', 'Remove entries older than N days', '30')
  .option('--force', 'Allow pruning entries owned by other sessions', false)
  .action((options) => worktreeCommand('prune', options));

worktreeCmd
  .command('repair')
  .description('Reconcile registry with git and filesystem state')
  .option('--dry-run', 'Report only, do not persist changes', false)
  .option('--prune', 'Remove destroyed, stale-merged, and missing entries', false)
  .option('--force', 'Allow pruning entries owned by other sessions', false)
  .action((options) => worktreeCommand('repair', options));

worktreeCmd
  .command('bind <spec-id>')
  .description('Bind a spec to this worktree (fixes mutual reference)')
  .option('--name <name>', 'Worktree name (auto-detected from cwd if omitted)')
  .action((specId, options) => worktreeCommand('bind', { specId, ...options }));

// Scope command group
const scopeCmd = program
  .command('scope')
  .description('Inspect and manage scope boundaries');

scopeCmd
  .command('show')
  .description('Show effective scope for the current context')
  .action(() => scopeCommand('show'));

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

// Parallel command group
const parallelCmd = program
  .command('parallel')
  .description('Orchestrate parallel multi-agent workspaces');

parallelCmd
  .command('setup <plan-file>')
  .description('Create worktrees and sessions from a plan file')
  .option('--base-branch <branch>', 'Base branch for all worktrees')
  .action((planFile, options) => parallelCommand('setup', { planFile, ...options }));

parallelCmd
  .command('status')
  .description('Show all active parallel worktrees and sessions')
  .action(() => parallelCommand('status'));

parallelCmd
  .command('merge')
  .description('Merge all parallel branches back to base')
  .option('--strategy <strategy>', 'Merge strategy: merge or squash', 'merge')
  .option('--dry-run', 'Preview merge without executing', false)
  .option('--force', 'Force merge even with detected conflicts', false)
  .action((options) => parallelCommand('merge', options));

parallelCmd
  .command('teardown')
  .description('Destroy all parallel worktrees')
  .option('--delete-branches', 'Also delete associated branches', false)
  .option('--force', 'Force removal even if worktrees are dirty', false)
  .action((options) => parallelCommand('teardown', options));

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

// Verify Acceptance Criteria command
program
  .command('verify-acs')
  .description('Verify acceptance criteria in specs are backed by test evidence')
  .option('--spec-id <id>', 'Verify only this spec')
  .option('--run', 'Actually run tests (default: collect-only)', false)
  .option('--runner <runner>', 'Force test runner (pytest, jest, vitest, cargo, go)')
  .option('--format <format>', 'Output format (text, json)', 'text')
  .action(verifyAcsCommand);

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

// Burnup command
program
  .command('burnup [spec-file]')
  .description('Generate budget burn-up report for scope visibility')
  .option('--spec-id <id>', 'Feature-specific spec ID (e.g., user-auth)')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action(burnupCommand);

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

waiversCmd
  .command('prune')
  .description('Prune expired waivers (dry-run by default; use --apply to persist)')
  .option('--expired', 'Prune active waivers whose expires_at is in the past')
  .option('--apply', 'Actually transition status (default: dry run)')
  .option('--json', 'Emit machine-readable JSON output')
  .option('-v, --verbose', 'Show detailed error information', false)
  .action((options) => waiversCommand('prune', options));

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

// Provenance command group
const provenanceCmd = program.command('provenance').description('Manage CAWS provenance tracking');

// Subcommands
provenanceCmd
  .command('update')
  .description('Add new commit to provenance chain')
  .requiredOption('-c, --commit <hash>', 'Git commit hash')
  .option('--spec-id <id>', 'Feature-specific spec ID')
  .option('-s, --spec <path>', 'Path to spec file (explicit override)')
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
  .option('--spec-id <id>', 'Feature-specific spec ID')
  .option('-s, --spec <path>', 'Path to spec file (explicit override)')
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
        console.log(`Successfully installed ${result.added} git hooks`);
        if (result.skipped > 0) {
          console.log(`Skipped ${result.skipped} existing hooks`);
        }
      } else {
        console.log('All hooks already configured');
      }
    } catch (error) {
      console.error(`Failed to install git hooks: ${error.message}`);
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
      console.error(`Failed to remove git hooks: ${error.message}`);
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
      console.error(`Failed to check git hooks status: ${error.message}`);
      process.exit(1);
    }
  });

// Error handling
// Custom error event handler for better messages
program.configureHelp({
  // Override error display
  showError: () => {}, // Suppress default error display
});

const VALID_COMMANDS = [
  'init',
  'validate',
  'scaffold',
  'status',
  'archive',
  'specs',
  'sidecar',
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
  'quality-gates',
  'gates',
  'provenance',
  'hooks',
  'burnup',
  'tool',
  'worktree',
  'session',
  'parallel',
  'verify-acs',
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

// Export functions for testing
module.exports = {
  generateWorkingSpec,
  validateGeneratedSpec,
};
