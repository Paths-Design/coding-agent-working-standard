/**
 * @fileoverview CAWS Session Capsule Manager
 * Manages session lifecycle and capsule persistence for multi-agent coordination.
 * Each session produces a structured capsule that captures baseline state on entry
 * and work summary + verification evidence on exit.
 * @author @darianrosebrook
 */

const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const { mergeFilesTouched } = require('../utils/working-state');

const SESSIONS_DIR = '.caws/sessions';
const REGISTRY_FILE = '.caws/sessions.json';
const CAPSULE_SCHEMA_VERSION = 'caws.capsule.v1';

/**
 * Get the git repository root
 * @returns {string} Absolute path to repo root
 */
function getRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Get current HEAD revision (short hash)
 * @param {string} cwd - Working directory
 * @returns {string}
 */
function getHeadRev(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      cwd,
    }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Get current branch name
 * @param {string} cwd - Working directory
 * @returns {string}
 */
function getCurrentBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      cwd,
    }).trim();
  } catch {
    return 'detached';
  }
}

/**
 * Get dirty files in working tree
 * @param {string} cwd - Working directory
 * @returns {{ paths: string[], dirty: boolean }}
 */
function getWorkspaceFingerprint(cwd) {
  try {
    const output = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf8',
      cwd,
    });
    const paths = output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.substring(3).trim());
    return { paths_touched: paths, dirty: paths.length > 0 };
  } catch {
    return { paths_touched: [], dirty: false };
  }
}

/**
 * Load the best available spec synchronously (feature specs first, then legacy).
 * @param {string} root - Repository root
 * @param {string} [specId] - Optional specific spec ID
 * @returns {object|null} Parsed spec object or null
 */
function loadBestSpecSync(root, specId) {
  const yaml = require('js-yaml');

  // If a specific spec ID is requested, load it directly
  if (specId) {
    for (const ext of ['.yaml', '.yml']) {
      const p = path.join(root, '.caws/specs', `${specId}${ext}`);
      if (fs.existsSync(p)) {
        try { return yaml.load(fs.readFileSync(p, 'utf8')); } catch { /* skip */ }
      }
    }
  }

  // Check registry for active feature specs
  const registryPath = path.join(root, '.caws/specs/registry.json');
  if (fs.existsSync(registryPath)) {
    try {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const specs = registry.specs || {};
      const activeIds = Object.keys(specs).filter(
        id => specs[id].status !== 'closed' && specs[id].status !== 'archived'
      );
      for (const id of activeIds) {
        const specEntry = specs[id];
        const p = path.join(root, '.caws/specs', specEntry.path || `${id}.yaml`);
        if (fs.existsSync(p)) {
          try { return yaml.load(fs.readFileSync(p, 'utf8')); } catch { /* skip */ }
        }
      }
    } catch { /* fall through */ }
  }

  // Legacy fallback
  const legacyPath = path.join(root, '.caws/working-spec.yaml');
  if (fs.existsSync(legacyPath)) {
    try { return yaml.load(fs.readFileSync(legacyPath, 'utf8')); } catch { /* skip */ }
  }

  return null;
}

/**
 * Get project name from best available spec or directory
 * @param {string} root - Repository root
 * @param {string} [specId] - Optional specific spec ID
 * @returns {string}
 */
function getProjectName(root, specId) {
  try {
    const spec = loadBestSpecSync(root, specId);
    if (spec) {
      return spec.title || spec.id || path.basename(root);
    }
  } catch {
    // Fall through
  }
  return path.basename(root);
}

/**
 * Get skein ID from best available spec
 * @param {string} root - Repository root
 * @param {string} [specId] - Optional specific spec ID
 * @returns {string}
 */
function getSkeinId(root, specId) {
  try {
    const spec = loadBestSpecSync(root, specId);
    if (spec) {
      return spec.id || 'unknown';
    }
  } catch {
    // Fall through
  }
  return 'unknown';
}

/**
 * Load the session registry
 * @param {string} root - Repository root
 * @returns {Object} Registry object
 */
function loadRegistry(root) {
  const registryPath = path.join(root, REGISTRY_FILE);
  try {
    if (fs.existsSync(registryPath)) {
      return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }
  } catch {
    // Corrupted registry, start fresh
  }
  return { version: 1, sessions: {} };
}

/**
 * Save the session registry
 * @param {string} root - Repository root
 * @param {Object} registry - Registry object
 */
function saveRegistry(root, registry) {
  const registryPath = path.join(root, REGISTRY_FILE);
  fs.ensureDirSync(path.dirname(registryPath));
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Generate a deterministic session ID
 * @returns {string}
 */
function generateSessionId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${timestamp}__${suffix}`;
}

/**
 * Start a new session, creating the initial capsule with baseline state
 * @param {Object} options - Session options
 * @param {string} [options.role] - Agent role (worker, integrator, qa)
 * @param {string} [options.specId] - Associated feature spec ID
 * @param {string[]} [options.allowedGlobs] - Allowed file patterns
 * @param {string[]} [options.forbiddenGlobs] - Forbidden file patterns
 * @param {string} [options.intent] - What this session intends to accomplish
 * @returns {Object} Created capsule
 */
function startSession(options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const sessionId = generateSessionId();

  const {
    role = 'worker',
    specId,
    allowedGlobs = [],
    forbiddenGlobs = [],
    intent = '',
  } = options;

  // Build scope from spec if available and no explicit globs provided
  let scope = {
    allowed_globs: allowedGlobs,
    forbidden_globs: forbiddenGlobs,
  };

  if (specId && allowedGlobs.length === 0) {
    try {
      const yaml = require('js-yaml');
      const specPath = path.join(root, `.caws/specs/${specId}.yaml`);
      if (fs.existsSync(specPath)) {
        const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
        if (spec.scope) {
          scope.allowed_globs = spec.scope.in || [];
          scope.forbidden_globs = spec.scope.out || [];
        }
      }
    } catch {
      // Non-fatal: scope stays as provided
    }
  }

  const capsule = {
    schema: CAPSULE_SCHEMA_VERSION,
    project: getProjectName(root, specId),
    skein_id: getSkeinId(root, specId),
    session_id: sessionId,
    role,
    spec_id: specId || null,
    scope,
    base_state: {
      head_rev: getHeadRev(root),
      branch: getCurrentBranch(root),
      workspace_fingerprint: getWorkspaceFingerprint(root),
    },
    started_at: new Date().toISOString(),
    ended_at: null,
    work_summary: {
      intent: intent || '',
      paths_touched: [],
      artifacts_written: [],
      commits: [],
    },
    verification: {
      tests_run: [],
      determinism_checks: [],
    },
    known_issues: [],
    handoff: {
      next_actions: [],
      risk_notes: [],
    },
  };

  // Persist capsule
  const sessionsDir = path.join(root, SESSIONS_DIR);
  fs.ensureDirSync(sessionsDir);
  const capsulePath = path.join(sessionsDir, `${sessionId}.json`);
  fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2));

  // Update registry
  registry.sessions[sessionId] = {
    path: `${sessionId}.json`,
    role,
    spec_id: specId || null,
    status: 'active',
    started_at: capsule.started_at,
    ended_at: null,
    head_rev: capsule.base_state.head_rev,
    branch: capsule.base_state.branch,
  };
  saveRegistry(root, registry);

  return capsule;
}

/**
 * Add a checkpoint to the current (most recent active) session
 * @param {Object} data - Checkpoint data
 * @param {string} [data.sessionId] - Specific session ID (uses latest active if omitted)
 * @param {string[]} [data.pathsTouched] - Files changed
 * @param {string[]} [data.artifactsWritten] - Generated artifacts
 * @param {Object[]} [data.testsRun] - Test results { name, status, evidence }
 * @param {Object[]} [data.determinismChecks] - Determinism checks { name, status, total }
 * @param {Object[]} [data.knownIssues] - Issues discovered { type, description }
 * @param {string} [data.intent] - Updated intent description
 * @returns {Object} Updated capsule
 */
function checkpointSession(data = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);

  // Find session
  const sessionId = data.sessionId || findActiveSession(registry);
  if (!sessionId) {
    throw new Error('No active session found. Start one with: caws session start');
  }

  const capsulePath = path.join(root, SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(capsulePath)) {
    throw new Error(`Session capsule not found: ${sessionId}`);
  }

  const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));

  // Merge checkpoint data
  if (data.intent) {
    capsule.work_summary.intent = data.intent;
  }
  if (data.pathsTouched) {
    const existing = new Set(capsule.work_summary.paths_touched);
    for (const p of data.pathsTouched) existing.add(p);
    capsule.work_summary.paths_touched = [...existing];
  }
  if (data.artifactsWritten) {
    const existing = new Set(capsule.work_summary.artifacts_written);
    for (const a of data.artifactsWritten) existing.add(a);
    capsule.work_summary.artifacts_written = [...existing];
  }
  if (data.testsRun) {
    capsule.verification.tests_run.push(...data.testsRun);
  }
  if (data.determinismChecks) {
    capsule.verification.determinism_checks.push(...data.determinismChecks);
  }
  if (data.knownIssues) {
    capsule.known_issues.push(...data.knownIssues);
  }

  // Record current commit as a checkpoint
  const currentRev = getHeadRev(root);
  if (currentRev !== capsule.base_state.head_rev) {
    capsule.work_summary.commits.push({
      rev: currentRev,
      checkpoint_at: new Date().toISOString(),
    });
  }

  // Write updated capsule
  fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2));

  // Bridge to working state (per-spec)
  if (capsule.spec_id && capsule.work_summary.paths_touched.length > 0) {
    try { mergeFilesTouched(capsule.spec_id, capsule.work_summary.paths_touched, root); } catch { /* non-fatal */ }
  }

  return capsule;
}

/**
 * End a session, finalizing the capsule with handoff information
 * @param {Object} data - End session data
 * @param {string} [data.sessionId] - Specific session ID (uses latest active if omitted)
 * @param {string[]} [data.nextActions] - What the next session should do
 * @param {string[]} [data.riskNotes] - Risk notes for handoff
 * @returns {Object} Finalized capsule
 */
function endSession(data = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);

  const sessionId = data.sessionId || findActiveSession(registry);
  if (!sessionId) {
    throw new Error('No active session found.');
  }

  const capsulePath = path.join(root, SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(capsulePath)) {
    throw new Error(`Session capsule not found: ${sessionId}`);
  }

  const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));

  // Finalize
  capsule.ended_at = new Date().toISOString();

  // Capture final workspace state
  const fingerprint = getWorkspaceFingerprint(root);
  capsule.work_summary.paths_touched = [
    ...new Set([...capsule.work_summary.paths_touched, ...fingerprint.paths_touched]),
  ];

  // Record final commit
  const finalRev = getHeadRev(root);
  if (
    finalRev !== capsule.base_state.head_rev &&
    !capsule.work_summary.commits.some((c) => c.rev === finalRev)
  ) {
    capsule.work_summary.commits.push({
      rev: finalRev,
      checkpoint_at: new Date().toISOString(),
    });
  }

  // Handoff
  if (data.nextActions) {
    capsule.handoff.next_actions = data.nextActions;
  }
  if (data.riskNotes) {
    capsule.handoff.risk_notes = data.riskNotes;
  }

  // Flag if dirty
  if (fingerprint.dirty) {
    capsule.known_issues.push({
      type: 'warning',
      description: `Session ended with ${fingerprint.paths_touched.length} uncommitted file(s).`,
    });
  }

  // Write finalized capsule
  fs.writeFileSync(capsulePath, JSON.stringify(capsule, null, 2));

  // Bridge to working state (per-spec)
  if (capsule.spec_id && capsule.work_summary.paths_touched.length > 0) {
    try { mergeFilesTouched(capsule.spec_id, capsule.work_summary.paths_touched, root); } catch { /* non-fatal */ }
  }

  // Update registry
  registry.sessions[sessionId].status = 'completed';
  registry.sessions[sessionId].ended_at = capsule.ended_at;
  saveRegistry(root, registry);

  return capsule;
}

/**
 * List all sessions
 * @param {Object} [options] - List options
 * @param {string} [options.status] - Filter by status (active, completed)
 * @param {number} [options.limit] - Max entries to return
 * @returns {Object[]} Session entries
 */
function listSessions(options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);

  let entries = Object.entries(registry.sessions).map(([id, meta]) => ({
    id,
    ...meta,
  }));

  if (options.status) {
    entries = entries.filter((e) => e.status === options.status);
  }

  // Sort by started_at descending (most recent first)
  entries.sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  if (options.limit) {
    entries = entries.slice(0, options.limit);
  }

  return entries;
}

/**
 * Show a specific session's full capsule
 * @param {string} sessionId - Session ID (or "latest" for most recent)
 * @returns {Object} Full capsule
 */
function showSession(sessionId) {
  const root = getRepoRoot();

  if (sessionId === 'latest') {
    const registry = loadRegistry(root);
    const active = findActiveSession(registry);
    if (active) {
      sessionId = active;
    } else {
      // Find most recent completed
      const entries = Object.entries(registry.sessions).sort(
        (a, b) => new Date(b[1].started_at) - new Date(a[1].started_at)
      );
      if (entries.length === 0) throw new Error('No sessions found.');
      sessionId = entries[0][0];
    }
  }

  const capsulePath = path.join(root, SESSIONS_DIR, `${sessionId}.json`);
  if (!fs.existsSync(capsulePath)) {
    throw new Error(`Session capsule not found: ${sessionId}`);
  }

  return JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
}

/**
 * Briefing output for session start hooks - returns structured text
 * @returns {string} Briefing text
 */
function getBriefing() {
  const root = getRepoRoot();
  const registry = loadRegistry(root);

  const lines = [];
  lines.push('--- CAWS Session Briefing ---');

  // Git baseline
  const headRev = getHeadRev(root);
  const branch = getCurrentBranch(root);
  const fingerprint = getWorkspaceFingerprint(root);
  lines.push(`Git: ${branch} @ ${headRev} (${fingerprint.paths_touched.length} dirty files)`);

  if (fingerprint.dirty) {
    lines.push('WARNING: Working tree has uncommitted changes from a prior session.');
  }

  // Active sessions
  const activeSessions = Object.entries(registry.sessions)
    .filter(([, meta]) => meta.status === 'active')
    .map(([id, meta]) => ({ id, ...meta }));

  if (activeSessions.length > 0) {
    lines.push(`Active sessions: ${activeSessions.length}`);
    for (const s of activeSessions) {
      lines.push(`  - ${s.id} (${s.role}, spec: ${s.spec_id || 'none'})`);
    }
  }

  // Last completed session handoff
  const completedSessions = Object.entries(registry.sessions)
    .filter(([, meta]) => meta.status === 'completed')
    .sort((a, b) => new Date(b[1].ended_at) - new Date(a[1].ended_at));

  if (completedSessions.length > 0) {
    const [lastId] = completedSessions[0];
    try {
      const capsule = showSession(lastId);
      if (capsule.handoff.next_actions.length > 0) {
        lines.push('Handoff from prior session:');
        for (const action of capsule.handoff.next_actions) {
          lines.push(`  - ${action}`);
        }
      }
      if (capsule.known_issues.length > 0) {
        lines.push('Known issues from prior session:');
        for (const issue of capsule.known_issues) {
          lines.push(`  - [${issue.type}] ${issue.description}`);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  lines.push('---');
  lines.push("Run 'caws session start' to begin a tracked session.");
  lines.push('--- End CAWS Briefing ---');

  return lines.join('\n');
}

/**
 * Find the most recent active session
 * @param {Object} registry - Session registry
 * @returns {string|null} Session ID or null
 */
function findActiveSession(registry) {
  const active = Object.entries(registry.sessions)
    .filter(([, meta]) => meta.status === 'active')
    .sort((a, b) => new Date(b[1].started_at) - new Date(a[1].started_at));

  return active.length > 0 ? active[0][0] : null;
}

/**
 * Find all active sessions on a specific branch
 * @param {string} branch - Branch name to search
 * @returns {Object[]} Active sessions on that branch with id and metadata
 */
function findActiveSessionsOnBranch(branch) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  return Object.entries(registry.sessions)
    .filter(([, meta]) => meta.status === 'active' && meta.branch === branch)
    .map(([id, meta]) => ({ id, ...meta }));
}

module.exports = {
  startSession,
  checkpointSession,
  endSession,
  listSessions,
  showSession,
  getBriefing,
  loadRegistry,
  getRepoRoot,
  SESSIONS_DIR,
  REGISTRY_FILE,
  CAPSULE_SCHEMA_VERSION,
  findActiveSessionsOnBranch,
};
