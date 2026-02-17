/**
 * @fileoverview CAWS Session CLI Command
 * Manages session lifecycle and capsule persistence for multi-agent coordination.
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const {
  startSession,
  checkpointSession,
  endSession,
  listSessions,
  showSession,
  getBriefing,
} = require('../session/session-manager');

/**
 * Handle session subcommands
 * @param {string} subcommand - Subcommand name
 * @param {Object} options - Command options
 */
async function sessionCommand(subcommand, options = {}) {
  try {
    switch (subcommand) {
      case 'start':
        return handleStart(options);
      case 'checkpoint':
        return handleCheckpoint(options);
      case 'end':
        return handleEnd(options);
      case 'list':
        return handleList(options);
      case 'show':
        return handleShow(options);
      case 'briefing':
        return handleBriefing();
      default:
        console.error(chalk.red(`Unknown session subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: start, checkpoint, end, list, show, briefing'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(error.message));
    process.exit(1);
  }
}

function handleStart(options) {
  const { role, specId, scope, intent } = options;

  let allowedGlobs = [];
  let forbiddenGlobs = [];
  if (scope) {
    allowedGlobs = scope.split(',').map((s) => s.trim());
  }

  console.log(chalk.cyan('Starting CAWS session...'));

  const capsule = startSession({
    role,
    specId,
    allowedGlobs,
    forbiddenGlobs,
    intent,
  });

  console.log(chalk.green('Session started'));
  console.log(chalk.gray(`   ID:       ${capsule.session_id}`));
  console.log(chalk.gray(`   Role:     ${capsule.role}`));
  console.log(chalk.gray(`   Baseline: ${capsule.base_state.branch} @ ${capsule.base_state.head_rev}`));
  if (capsule.spec_id) console.log(chalk.gray(`   Spec:     ${capsule.spec_id}`));
  if (capsule.base_state.workspace_fingerprint.dirty) {
    console.log(
      chalk.yellow(
        `   Warning: Dirty tree: ${capsule.base_state.workspace_fingerprint.paths_touched.length} file(s) uncommitted`
      )
    );
  }
  if (capsule.work_summary.intent) {
    console.log(chalk.gray(`   Intent:   ${capsule.work_summary.intent}`));
  }
}

function handleCheckpoint(options) {
  const { sessionId, intent } = options;

  // Parse JSON fields if provided
  let testsRun = [];
  let knownIssues = [];
  let pathsTouched = [];

  if (options.tests) {
    try {
      testsRun = JSON.parse(options.tests);
    } catch {
      console.error(chalk.red('--tests must be valid JSON array'));
      process.exit(1);
    }
  }

  if (options.issues) {
    try {
      knownIssues = JSON.parse(options.issues);
    } catch {
      console.error(chalk.red('--issues must be valid JSON array'));
      process.exit(1);
    }
  }

  if (options.paths) {
    pathsTouched = options.paths.split(',').map((p) => p.trim());
  }

  const capsule = checkpointSession({
    sessionId,
    intent,
    pathsTouched: pathsTouched.length > 0 ? pathsTouched : undefined,
    testsRun: testsRun.length > 0 ? testsRun : undefined,
    knownIssues: knownIssues.length > 0 ? knownIssues : undefined,
  });

  console.log(chalk.green('Checkpoint recorded'));
  console.log(chalk.gray(`   Session:  ${capsule.session_id}`));
  console.log(chalk.gray(`   Commits:  ${capsule.work_summary.commits.length}`));
  console.log(chalk.gray(`   Files:    ${capsule.work_summary.paths_touched.length}`));
  console.log(chalk.gray(`   Tests:    ${capsule.verification.tests_run.length} recorded`));
}

function handleEnd(options) {
  const { sessionId } = options;

  let nextActions = [];
  let riskNotes = [];

  if (options.nextActions) {
    nextActions = options.nextActions.split('|').map((a) => a.trim());
  }
  if (options.riskNotes) {
    riskNotes = options.riskNotes.split('|').map((r) => r.trim());
  }

  const capsule = endSession({
    sessionId,
    nextActions: nextActions.length > 0 ? nextActions : undefined,
    riskNotes: riskNotes.length > 0 ? riskNotes : undefined,
  });

  console.log(chalk.green('Session ended'));
  console.log(chalk.gray(`   ID:       ${capsule.session_id}`));
  console.log(chalk.gray(`   Duration: ${formatDuration(capsule.started_at, capsule.ended_at)}`));
  console.log(chalk.gray(`   Commits:  ${capsule.work_summary.commits.length}`));
  console.log(chalk.gray(`   Files:    ${capsule.work_summary.paths_touched.length}`));

  if (capsule.handoff.next_actions.length > 0) {
    console.log(chalk.cyan('\n   Handoff:'));
    for (const action of capsule.handoff.next_actions) {
      console.log(chalk.gray(`     - ${action}`));
    }
  }

  if (capsule.known_issues.length > 0) {
    console.log(chalk.yellow('\n   Known issues:'));
    for (const issue of capsule.known_issues) {
      console.log(chalk.gray(`     [${issue.type}] ${issue.description}`));
    }
  }
}

function handleList(options) {
  const entries = listSessions({
    status: options.status,
    limit: options.limit ? parseInt(options.limit, 10) : undefined,
  });

  if (entries.length === 0) {
    console.log(chalk.gray('No sessions found.'));
    console.log(chalk.blue('Start one with: caws session start'));
    return;
  }

  console.log(chalk.bold.cyan('CAWS Sessions'));
  console.log(chalk.cyan('='.repeat(90)));
  console.log(
    chalk.bold(
      'Status'.padEnd(12) +
        'Role'.padEnd(12) +
        'Branch'.padEnd(16) +
        'Rev'.padEnd(10) +
        'Spec'.padEnd(14) +
        'Started'
    )
  );
  console.log(chalk.gray('-'.repeat(90)));

  for (const entry of entries) {
    const statusColor =
      entry.status === 'active' ? chalk.green : chalk.gray;

    const started = new Date(entry.started_at).toLocaleString();

    console.log(
      statusColor(entry.status.padEnd(12)) +
        (entry.role || 'worker').padEnd(12) +
        (entry.branch || '-').padEnd(16) +
        (entry.head_rev || '-').padEnd(10) +
        (entry.spec_id || '-').padEnd(14) +
        started
    );
  }
  console.log('');
}

function handleShow(options) {
  const sessionId = options.id || 'latest';
  const capsule = showSession(sessionId);

  if (options.json) {
    console.log(JSON.stringify(capsule, null, 2));
    return;
  }

  console.log(chalk.bold.cyan(`Session: ${capsule.session_id}`));
  console.log(chalk.cyan('='.repeat(70)));

  // Identity
  console.log(chalk.bold('\nIdentity'));
  console.log(chalk.gray(`  Project:  ${capsule.project}`));
  console.log(chalk.gray(`  Skein:    ${capsule.skein_id}`));
  console.log(chalk.gray(`  Role:     ${capsule.role}`));
  if (capsule.spec_id) console.log(chalk.gray(`  Spec:     ${capsule.spec_id}`));

  // Base state
  console.log(chalk.bold('\nBaseline'));
  console.log(chalk.gray(`  Rev:      ${capsule.base_state.head_rev}`));
  console.log(chalk.gray(`  Branch:   ${capsule.base_state.branch}`));
  console.log(
    chalk.gray(
      `  Dirty:    ${capsule.base_state.workspace_fingerprint.dirty ? 'yes' : 'no'} (${capsule.base_state.workspace_fingerprint.paths_touched.length} files)`
    )
  );

  // Work summary
  console.log(chalk.bold('\nWork Summary'));
  if (capsule.work_summary.intent) {
    console.log(chalk.gray(`  Intent:   ${capsule.work_summary.intent}`));
  }
  console.log(chalk.gray(`  Files:    ${capsule.work_summary.paths_touched.length}`));
  console.log(chalk.gray(`  Commits:  ${capsule.work_summary.commits.length}`));
  if (capsule.work_summary.commits.length > 0) {
    for (const c of capsule.work_summary.commits) {
      console.log(chalk.gray(`    ${c.rev} @ ${c.checkpoint_at}`));
    }
  }

  // Verification
  if (capsule.verification.tests_run.length > 0) {
    console.log(chalk.bold('\nVerification'));
    for (const t of capsule.verification.tests_run) {
      const icon = t.status === 'pass' ? '[PASS]' : '[FAIL]';
      console.log(chalk.gray(`  ${icon} ${t.name}: ${t.status}`));
    }
  }

  // Known issues
  if (capsule.known_issues.length > 0) {
    console.log(chalk.bold('\nKnown Issues'));
    for (const issue of capsule.known_issues) {
      console.log(chalk.yellow(`  [${issue.type}] ${issue.description}`));
    }
  }

  // Handoff
  if (capsule.handoff.next_actions.length > 0 || capsule.handoff.risk_notes.length > 0) {
    console.log(chalk.bold('\nHandoff'));
    for (const action of capsule.handoff.next_actions) {
      console.log(chalk.cyan(`  - ${action}`));
    }
    for (const note of capsule.handoff.risk_notes) {
      console.log(chalk.yellow(`  Warning: ${note}`));
    }
  }

  // Timing
  console.log(chalk.bold('\nTiming'));
  console.log(chalk.gray(`  Started:  ${capsule.started_at}`));
  if (capsule.ended_at) {
    console.log(chalk.gray(`  Ended:    ${capsule.ended_at}`));
    console.log(chalk.gray(`  Duration: ${formatDuration(capsule.started_at, capsule.ended_at)}`));
  } else {
    console.log(chalk.green('  Status:   ACTIVE'));
  }

  console.log('');
}

function handleBriefing() {
  console.log(getBriefing());
}

/**
 * Format duration between two ISO timestamps
 */
function formatDuration(start, end) {
  const ms = new Date(end) - new Date(start);
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

module.exports = { sessionCommand };
