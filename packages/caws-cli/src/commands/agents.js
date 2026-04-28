/**
 * @fileoverview CAWSFIX-31 — caws agents command.
 *
 * Surfaces the agent registry (`.caws/agents.json`) so operators and
 * other agents can see who is currently registered, what they are
 * working on, and where their session logs live. Reads only — write
 * paths are owned by the session-log hook and the lifecycle ops in
 * specs/worktree.
 *
 * Subcommands:
 *   - list                — table of all live entries (no platform filter)
 *   - show <session-id>   — full detail for one entry, including session-log pointer
 *
 * @author @darianrosebrook
 */

const chalk = require('chalk');

const { findProjectRoot } = require('../utils/detection');
const {
  loadAgentRegistry,
  findSessionLogs,
} = require('../utils/agent-session');
const {
  formatAgentRef,
  formatHeartbeatAge,
  formatSessionLogPointer,
} = require('../utils/agent-display');

/**
 * Top-level dispatcher.
 * @param {string} subcommand
 * @param {Object} options
 */
function agentsCommand(subcommand, options = {}) {
  switch (subcommand) {
    case 'list':
      return handleList(options);
    case 'show':
      return handleShow(options);
    default:
      console.error(chalk.red(`Unknown agents subcommand: ${subcommand}`));
      console.log(chalk.blue('Available: list, show'));
      process.exit(1);
  }
}

function handleList() {
  const root = findProjectRoot();
  const registry = loadAgentRegistry(root);
  const entries = Object.values(registry.agents || {});

  console.log(chalk.bold.cyan('CAWS Agents'));
  console.log(chalk.cyan('='.repeat(80)));

  if (entries.length === 0) {
    console.log(chalk.gray('No active agents.'));
    return;
  }

  // Sort by lastSeen desc so most recent appears first.
  entries.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));

  for (const entry of entries) {
    const ref = formatAgentRef(entry.sessionId, entry.platform);
    const age = formatHeartbeatAge(entry.lastSeen);
    console.log(chalk.bold(ref));
    console.log(chalk.gray(`   Heartbeat: ${entry.lastSeen || 'unknown'} (${age})`));
    if (entry.specId) {
      console.log(chalk.gray(`   Spec:      ${entry.specId}`));
    }
    if (entry.worktree) {
      console.log(chalk.gray(`   Worktree:  ${entry.worktree}`));
    }
    if (entry.model) {
      console.log(chalk.gray(`   Model:     ${entry.model}`));
    }
    console.log('');
  }
}

function handleShow(options) {
  const id = options.id;
  if (!id) {
    console.error(chalk.red('Session ID is required'));
    console.log(chalk.blue('Usage: caws agents show <session-id>'));
    process.exit(1);
  }

  const root = findProjectRoot();
  const registry = loadAgentRegistry(root);
  const entry = registry.agents[id];
  if (!entry) {
    console.error(chalk.red(`No agent registered with session id: ${id}`));
    console.log(
      chalk.blue('Run `caws agents list` to see active sessions, or `tmp/<id>/.meta.json` for archived ones.')
    );
    process.exit(1);
  }

  const ref = formatAgentRef(entry.sessionId, entry.platform);
  console.log(chalk.bold.cyan(ref));
  console.log(chalk.cyan('='.repeat(70)));
  console.log(chalk.gray(`First seen: ${entry.firstSeen || 'unknown'}`));
  console.log(
    chalk.gray(`Last seen:  ${entry.lastSeen || 'unknown'} (${formatHeartbeatAge(entry.lastSeen)})`)
  );
  if (entry.specId) console.log(chalk.gray(`Spec:       ${entry.specId}`));
  if (entry.worktree) console.log(chalk.gray(`Worktree:   ${entry.worktree}`));
  if (entry.model) console.log(chalk.gray(`Model:      ${entry.model}`));
  if (entry.ttl) console.log(chalk.gray(`TTL:        ${Math.round(entry.ttl / 1000 / 60)} min`));

  // Surface any session-log pointers for this id.
  const logs = findSessionLogs(root, { sessionId: id });
  if (logs.length > 0) {
    console.log('');
    console.log(chalk.bold('Session logs:'));
    for (const log of logs) {
      console.log(formatSessionLogPointer(log, root));
    }
  }
}

module.exports = { agentsCommand };
