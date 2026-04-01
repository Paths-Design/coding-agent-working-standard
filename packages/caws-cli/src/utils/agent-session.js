/**
 * Agent Session Identity
 *
 * Provides a unified way to identify the current agent session across
 * Claude Code, Cursor, and other IDE agent environments.
 *
 * Sources checked (first match wins):
 *   1. CLAUDE_SESSION_ID  — set by Claude Code automatically
 *   2. .caws/agents.json  — written by Cursor session-log hook (conversation_id)
 *   3. CURSOR_TRACE_ID    — set by Cursor (per-request, not stable, last resort)
 *
 * The agent registry (.caws/agents.json) also tracks active agents for
 * multi-agent coordination. Entries expire after a configurable TTL.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

const AGENTS_REGISTRY = '.caws/agents.json';
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Get the current agent's session ID from the best available source.
 * @param {string} [projectRoot] - Project root (for reading agent registry)
 * @returns {string|null} Session ID or null if not in an agent context
 */
function getAgentSessionId(projectRoot) {
  // 1. Claude Code — most reliable, set automatically
  if (process.env.CLAUDE_SESSION_ID) {
    return process.env.CLAUDE_SESSION_ID;
  }

  // 2. Agent registry — written by Cursor session-log hook
  if (projectRoot) {
    const registry = loadAgentRegistry(projectRoot);
    const active = findActiveAgent(registry);
    if (active) {
      return active.sessionId;
    }
  }

  // 3. Cursor trace ID — per-request, not stable, but better than nothing
  if (process.env.CURSOR_TRACE_ID) {
    return `cursor:${process.env.CURSOR_TRACE_ID}`;
  }

  return null;
}

/**
 * Get the agent platform name.
 * @returns {string} 'claude-code' | 'cursor' | 'unknown'
 */
function getAgentPlatform() {
  if (process.env.CLAUDE_SESSION_ID) return 'claude-code';
  if (process.env.CURSOR_TRACE_ID) return 'cursor';
  return 'unknown';
}

/**
 * Load the agent registry, pruning stale entries.
 * @param {string} root - Project root
 * @returns {object} Registry with { agents: { [sessionId]: entry } }
 */
function loadAgentRegistry(root) {
  const registryPath = path.join(root, AGENTS_REGISTRY);
  let registry = { version: 1, agents: {} };

  if (fs.existsSync(registryPath)) {
    try {
      registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    } catch {
      // Corrupt file — start fresh
      registry = { version: 1, agents: {} };
    }
  }

  // Prune stale entries on every read
  const now = Date.now();
  let pruned = false;
  for (const [id, entry] of Object.entries(registry.agents || {})) {
    const ttl = entry.ttl || DEFAULT_TTL_MS;
    const lastSeen = new Date(entry.lastSeen).getTime();
    if (now - lastSeen > ttl) {
      delete registry.agents[id];
      pruned = true;
    }
  }

  if (pruned) {
    saveAgentRegistry(root, registry);
  }

  return registry;
}

/**
 * Save the agent registry.
 * @param {string} root - Project root
 * @param {object} registry - Registry object
 */
function saveAgentRegistry(root, registry) {
  const registryPath = path.join(root, AGENTS_REGISTRY);
  const dir = path.dirname(registryPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Register or heartbeat an agent session.
 * Called by session-log hooks to keep entries fresh.
 * @param {string} root - Project root
 * @param {object} agent - Agent info
 * @param {string} agent.sessionId - Unique session/conversation ID
 * @param {string} agent.platform - 'claude-code' | 'cursor' | 'unknown'
 * @param {string} [agent.model] - Model name if known
 * @param {string} [agent.specId] - Active spec ID if known
 * @param {number} [agent.ttl] - Custom TTL in ms (default 30 min)
 */
function heartbeatAgent(root, agent) {
  const registry = loadAgentRegistry(root);
  const existing = registry.agents[agent.sessionId] || {};

  registry.agents[agent.sessionId] = {
    ...existing,
    sessionId: agent.sessionId,
    platform: agent.platform || existing.platform || 'unknown',
    model: agent.model || existing.model || null,
    specId: agent.specId || existing.specId || null,
    ttl: agent.ttl || existing.ttl || DEFAULT_TTL_MS,
    firstSeen: existing.firstSeen || new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };

  saveAgentRegistry(root, registry);
}

/**
 * Remove an agent session from the registry.
 * Called on session stop.
 * @param {string} root - Project root
 * @param {string} sessionId - Session to remove
 */
function removeAgent(root, sessionId) {
  const registry = loadAgentRegistry(root);
  delete registry.agents[sessionId];
  saveAgentRegistry(root, registry);
}

/**
 * Find the most recently active agent for this terminal/process.
 * Prefers agents that match the current environment.
 * @param {object} registry - Loaded registry
 * @returns {object|null} Agent entry or null
 */
function findActiveAgent(registry) {
  const agents = Object.values(registry.agents || {});
  if (agents.length === 0) return null;

  // If we're in Cursor, prefer cursor agents
  const isCursor = !!process.env.CURSOR_TRACE_ID;
  const preferred = agents.filter(a => {
    if (isCursor) return a.platform === 'cursor';
    return a.platform === 'claude-code';
  });

  const pool = preferred.length > 0 ? preferred : agents;

  // Return most recently seen
  pool.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
  return pool[0];
}

/**
 * List all currently active (non-expired) agents.
 * @param {string} root - Project root
 * @returns {object[]} Array of agent entries
 */
function listActiveAgents(root) {
  const registry = loadAgentRegistry(root);
  return Object.values(registry.agents || {});
}

module.exports = {
  getAgentSessionId,
  getAgentPlatform,
  loadAgentRegistry,
  saveAgentRegistry,
  heartbeatAgent,
  removeAgent,
  findActiveAgent,
  listActiveAgents,
  AGENTS_REGISTRY,
  DEFAULT_TTL_MS,
};
