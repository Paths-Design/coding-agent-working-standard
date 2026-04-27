/**
 * @fileoverview CAWSFIX-31 — agent claim display formatters.
 *
 * Single-purpose helpers for rendering agent / claim information so the
 * format ("<sessionId>:<platform>", claim panels, soft-block warnings)
 * is consistent across `caws status`, `caws agents`, and the
 * worktree-manager soft-block surface.
 *
 * Display only — no I/O of its own beyond the small loaders it needs.
 *
 * @author @darianrosebrook
 */

const path = require('path');
const fs = require('fs');

const {
  loadAgentRegistry,
  findSessionLogs,
} = require('./agent-session');

/**
 * Composite identifier used in every visible reference to an agent.
 * Format: `<sessionId>:<platform>`. Lets readers trace provenance to
 * platform-specific transcript directories.
 *
 * @param {string} sessionId
 * @param {string} platform - 'claude-code' | 'cursor' | 'unknown'
 * @returns {string}
 */
function formatAgentRef(sessionId, platform) {
  const sid = sessionId || 'unknown';
  const plat = platform || 'unknown';
  return `${sid}:${plat}`;
}

/**
 * Compute a short human-readable age for a heartbeat timestamp.
 * @param {string|null} iso
 * @returns {string}
 */
function formatHeartbeatAge(iso) {
  if (!iso) return 'unknown';
  const t = Date.parse(iso);
  if (isNaN(t)) return 'unknown';
  const ms = Date.now() - t;
  if (ms < 0) return 'in the future';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  return `${days}d ago`;
}

/**
 * Format a single session-log pointer for inclusion in a warning.
 * Path is project-relative when possible.
 *
 * @param {object} log - Result from findSessionLogs
 * @param {string} root - Project root (for relative path)
 * @returns {string}
 */
function formatSessionLogPointer(log, root) {
  const rel = path.relative(root, log.path) || log.path;
  const parts = [`tmp/${path.basename(log.path)}`, `${log.turnCount} turns`];
  if (log.lastTurn) parts.push(`last turn ${log.lastTurn}`);
  return `   Session log: ${rel}\n                ${parts.join(', ')}`;
}

/**
 * Build the structured warning printed when a foreign claim is
 * detected on a worktree (for `assertWorktreeOwnership` soft-block,
 * `caws worktree claim` read-only mode, etc.).
 *
 * @param {object} args
 * @param {string} args.worktree - Worktree name
 * @param {object|null} args.priorOwnerEntry - The agents.json entry for the
 *   prior owner, or null when TTL-pruned.
 * @param {string} args.priorOwnerSessionId - Sid from worktrees.json:owner
 * @param {Array} args.sessionLogs - findSessionLogs() result
 * @param {string} args.root - Project root for relative paths
 * @param {string} args.takeoverCommand - Exact command to suggest
 * @returns {string}
 */
function formatClaimNotice(args) {
  const {
    worktree,
    priorOwnerEntry,
    priorOwnerSessionId,
    sessionLogs = [],
    root,
    takeoverCommand,
  } = args;

  const platform = priorOwnerEntry ? priorOwnerEntry.platform : 'unknown';
  const ref = formatAgentRef(priorOwnerSessionId, platform);

  const lines = [
    `Worktree '${worktree}' is claimed by ${ref}`,
  ];

  if (priorOwnerEntry) {
    const age = formatHeartbeatAge(priorOwnerEntry.lastSeen);
    lines.push(`   Last heartbeat: ${priorOwnerEntry.lastSeen} (${age})`);
  } else {
    lines.push(`   Last heartbeat: no live agent registry entry (pruned or stale)`);
  }

  for (const log of sessionLogs) {
    lines.push(formatSessionLogPointer(log, root));
  }

  if (takeoverCommand) {
    lines.push(`   To proceed:    ${takeoverCommand}`);
  }

  return lines.join('\n');
}

/**
 * Build a softer hint when a worktree has no CAWS-tracked owner but a
 * matching session-log directory exists (the "may still be active"
 * scenario from AC A8).
 *
 * @param {object} args
 * @param {string} args.worktree
 * @param {Array} args.sessionLogs
 * @param {string} args.root
 * @returns {string}
 */
function formatOrphanLogHint(args) {
  const { worktree, sessionLogs = [], root } = args;
  const lines = [
    `No active CAWS claim on worktree '${worktree}', but a session log exists.`,
    `   The previous session may still be active — read for context before continuing:`,
  ];
  for (const log of sessionLogs) {
    lines.push(formatSessionLogPointer(log, root));
  }
  return lines.join('\n');
}

/**
 * Render the Claim panel that `caws status` includes when cwd is
 * inside a worktree. Returns a multi-line string (caller prints it).
 *
 * @param {string} root - Project root
 * @param {string} worktreeName - Worktree to inspect
 * @returns {string}
 */
function renderClaimPanel(root, worktreeName) {
  let entry = null;
  try {
    const wtRegistryPath = path.join(root, '.caws', 'worktrees.json');
    if (fs.existsSync(wtRegistryPath)) {
      const reg = JSON.parse(fs.readFileSync(wtRegistryPath, 'utf8'));
      entry = reg.worktrees && reg.worktrees[worktreeName];
    }
  } catch {
    // Best-effort.
  }

  if (!entry || !entry.owner) {
    return `Claim: no active claim on worktree '${worktreeName}'`;
  }

  const agentRegistry = loadAgentRegistry(root);
  const ownerEntry = agentRegistry.agents[entry.owner] || null;
  const platform = ownerEntry ? ownerEntry.platform : 'unknown';
  const ref = formatAgentRef(entry.owner, platform);

  const lines = [`Claim: worktree '${worktreeName}' owned by ${ref}`];
  if (ownerEntry) {
    lines.push(
      `   Last heartbeat: ${ownerEntry.lastSeen} (${formatHeartbeatAge(ownerEntry.lastSeen)})`
    );
    if (ownerEntry.specId) {
      lines.push(`   Spec:           ${ownerEntry.specId}`);
    }
  } else {
    lines.push(`   Last heartbeat: no live agent registry entry (pruned)`);
  }

  // Surface session-log pointers if present (filter by branch when known).
  const branch = entry.branch || null;
  const logs = findSessionLogs(root, { sessionId: entry.owner }).concat(
    branch ? findSessionLogs(root, { branch }) : []
  );
  // Dedupe by path
  const seen = new Set();
  for (const log of logs) {
    if (seen.has(log.path)) continue;
    seen.add(log.path);
    lines.push(formatSessionLogPointer(log, root));
  }

  return lines.join('\n');
}

module.exports = {
  formatAgentRef,
  formatHeartbeatAge,
  formatSessionLogPointer,
  formatClaimNotice,
  formatOrphanLogHint,
  renderClaimPanel,
};
