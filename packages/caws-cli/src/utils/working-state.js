/**
 * @fileoverview Working-State Layer
 *
 * Runtime companion to specs that tracks what an agent is currently doing.
 * Persists current phase, touched files, gate results, blockers, and
 * next actions to `.caws/state/<spec-id>.json`.
 *
 * All writes are non-fatal — if state cannot be persisted the calling
 * command continues normally.
 *
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');

const STATE_DIR = '.caws/state';
const STATE_SCHEMA_VERSION = 'caws.state.v1';
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the project root by walking up to the nearest .caws/ directory.
 * Falls back to cwd if nothing found.
 * @param {string} [startDir]
 * @returns {string}
 */
function findRoot(startDir) {
  let dir = startDir || process.cwd();
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.caws'))) return dir;
    dir = path.dirname(dir);
  }
  return startDir || process.cwd();
}

/**
 * Resolve the absolute path for a spec's state file.
 * @param {string} specId
 * @param {string} [projectRoot]
 * @returns {string}
 */
function getStatePath(specId, projectRoot) {
  const root = projectRoot || findRoot();
  return path.join(root, STATE_DIR, `${specId}.json`);
}

// ---------------------------------------------------------------------------
// Core CRUD
// ---------------------------------------------------------------------------

/**
 * Build an empty default state for a new spec.
 * @param {string} specId
 * @returns {object}
 */
function initializeState(specId) {
  return {
    schema: STATE_SCHEMA_VERSION,
    spec_id: specId,
    updated_at: new Date().toISOString(),
    phase: 'not-started',
    files_touched: [],
    validation: null,
    evaluation: null,
    gates: null,
    acceptance_criteria: null,
    blockers: [],
    next_actions: [],
    history: [],
  };
}

/**
 * Load state from disk. Returns null if file does not exist.
 * @param {string} specId
 * @param {string} [projectRoot]
 * @returns {object|null}
 */
function loadState(specId, projectRoot) {
  const filePath = getStatePath(specId, projectRoot);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Save state atomically (write-then-rename).
 * @param {string} specId
 * @param {object} state
 * @param {string} [projectRoot]
 */
function saveState(specId, state, projectRoot) {
  const filePath = getStatePath(specId, projectRoot);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Delete state file for a spec.
 * @param {string} specId
 * @param {string} [projectRoot]
 */
function deleteState(specId, projectRoot) {
  const filePath = getStatePath(specId, projectRoot);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Load → patch → recompute derived fields → save.
 * @param {string} specId
 * @param {object} patch - Partial state to merge
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @param {object} [options.spec] - Spec object for derived-field computation
 * @param {string} [options.command] - Command name for history entry
 * @param {string} [options.summary] - Summary for history entry
 * @returns {object} Updated state
 */
function updateState(specId, patch, options = {}) {
  const { projectRoot, spec, command, summary } = options;
  let state = loadState(specId, projectRoot) || initializeState(specId);

  // Merge top-level sections (replace, not deep-merge)
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'files_touched' && Array.isArray(value)) {
      // Merge file lists with dedup
      const merged = new Set([...(state.files_touched || []), ...value]);
      state.files_touched = [...merged];
    } else {
      state[key] = value;
    }
  }

  // Append history
  if (command) {
    state.history = state.history || [];
    state.history.push({
      timestamp: new Date().toISOString(),
      command,
      summary: summary || '',
    });
    // Cap at MAX_HISTORY
    if (state.history.length > MAX_HISTORY) {
      state.history = state.history.slice(-MAX_HISTORY);
    }
  }

  // Recompute derived fields
  state.blockers = computeBlockers(state);
  state.next_actions = computeNextActions(state, spec);
  state.phase = computePhase(state, spec);
  state.updated_at = new Date().toISOString();

  saveState(specId, state, projectRoot);
  return state;
}

// ---------------------------------------------------------------------------
// Record helpers — called by individual commands
// ---------------------------------------------------------------------------

/**
 * Record validation result.
 * @param {string} specId
 * @param {object} result
 * @param {boolean} result.passed
 * @param {number} [result.compliance_score]
 * @param {string} [result.grade]
 * @param {number} [result.error_count]
 * @param {number} [result.warning_count]
 * @param {string} [projectRoot]
 */
function recordValidation(specId, result, projectRoot) {
  const validation = {
    last_run: new Date().toISOString(),
    passed: result.passed,
    compliance_score: result.compliance_score ?? null,
    grade: result.grade ?? null,
    error_count: result.error_count ?? 0,
    warning_count: result.warning_count ?? 0,
  };
  const summaryText = result.passed
    ? `Passed (Grade ${validation.grade || '?'})`
    : `Failed — ${validation.error_count} error(s)`;
  updateState(specId, { validation }, {
    projectRoot,
    command: 'validate',
    summary: summaryText,
  });
}

/**
 * Record evaluation result.
 * @param {string} specId
 * @param {object} result
 * @param {number} result.score
 * @param {number} result.max_score
 * @param {number} result.percentage
 * @param {string} result.grade
 * @param {number} result.checks_passed
 * @param {number} result.checks_total
 * @param {string} [projectRoot]
 */
function recordEvaluation(specId, result, projectRoot) {
  const evaluation = {
    last_run: new Date().toISOString(),
    score: result.score,
    max_score: result.max_score,
    percentage: result.percentage,
    grade: result.grade,
    checks_passed: result.checks_passed,
    checks_total: result.checks_total,
  };
  updateState(specId, { evaluation }, {
    projectRoot,
    command: 'evaluate',
    summary: `${result.score}/${result.max_score} (${result.percentage}%) Grade ${result.grade}`,
  });
}

/**
 * Record gate evaluation results.
 * @param {string} specId
 * @param {object} report - Report from evaluateGates()
 * @param {boolean} report.passed
 * @param {object} report.summary
 * @param {object[]} report.gates - Individual gate results
 * @param {string} [context] - Execution context (cli, commit, edit)
 * @param {string} [projectRoot]
 */
function recordGates(specId, report, context, projectRoot) {
  const gates = {
    last_run: new Date().toISOString(),
    context: context || 'cli',
    passed: report.passed,
    summary: report.summary,
    results: (report.gates || []).map(g => ({
      name: g.name,
      status: g.status,
      mode: g.mode,
    })),
  };
  const { blocked, warned, passed } = report.summary || {};
  const summaryText = `${passed || 0} passed, ${blocked || 0} blocked, ${warned || 0} warned`;
  updateState(specId, { gates }, {
    projectRoot,
    command: 'gates',
    summary: summaryText,
  });
}

/**
 * Record acceptance-criteria verification results.
 * @param {string} specId
 * @param {object} result
 * @param {number} result.total
 * @param {number} result.pass
 * @param {number} result.fail
 * @param {number} result.unchecked
 * @param {object[]} [result.results] - Per-AC results
 * @param {string} [projectRoot]
 */
function recordACVerification(specId, result, projectRoot) {
  const acceptance_criteria = {
    last_run: new Date().toISOString(),
    total: result.total,
    pass: result.pass,
    fail: result.fail,
    unchecked: result.unchecked,
    results: (result.results || []).map(r => ({
      id: r.id,
      status: r.status,
    })),
  };
  const summaryText = `${result.pass}/${result.total} pass, ${result.fail} fail, ${result.unchecked} unchecked`;
  updateState(specId, { acceptance_criteria }, {
    projectRoot,
    command: 'verify-acs',
    summary: summaryText,
  });
}

/**
 * Merge touched files into state (additive, deduped).
 * @param {string} specId
 * @param {string[]} files
 * @param {string} [projectRoot]
 */
function mergeFilesTouched(specId, files, projectRoot) {
  if (!files || files.length === 0) return;
  updateState(specId, { files_touched: files }, {
    projectRoot,
    command: 'session',
    summary: `+${files.length} file(s) touched`,
  });
}

// ---------------------------------------------------------------------------
// Derived-field computation
// ---------------------------------------------------------------------------

/**
 * Derive the current workflow phase from state evidence.
 * @param {object} state
 * @param {object} [spec] - Spec object (for AC count)
 * @returns {string}
 */
function computePhase(state, _spec) {
  const v = state.validation;
  const e = state.evaluation;
  const g = state.gates;
  const ac = state.acceptance_criteria;

  // Nothing has run yet
  if (!v && !e && !g && !ac) return 'not-started';

  // Validation failed or evaluation below 70% → still authoring the spec
  if (v && !v.passed) return 'spec-authoring';
  if (e && e.percentage < 70) return 'spec-authoring';

  // All ACs pass, all gates pass, evaluation >= 90% → complete
  if (ac && ac.total > 0 && ac.fail === 0 && ac.unchecked === 0
    && g && g.passed
    && e && e.percentage >= 90) {
    return 'complete';
  }

  // All ACs pass, gates have been run → verification phase
  if (ac && ac.total > 0 && ac.fail === 0 && ac.unchecked === 0 && g) {
    return 'verification';
  }

  // Otherwise: implementation
  return 'implementation';
}

/**
 * Extract active blockers from state.
 * @param {object} state
 * @returns {object[]}
 */
function computeBlockers(state) {
  const blockers = [];
  const now = new Date().toISOString();

  // Validation failure
  if (state.validation && !state.validation.passed) {
    blockers.push({
      type: 'validation_failure',
      message: `Validation failed with ${state.validation.error_count} error(s)`,
      since: state.validation.last_run || now,
    });
  }

  // Gate failures (block-mode only)
  if (state.gates && state.gates.results) {
    for (const g of state.gates.results) {
      if (g.status === 'fail' && g.mode === 'block') {
        blockers.push({
          type: 'gate_failure',
          gate: g.name,
          message: `Gate "${g.name}" is blocking`,
          since: state.gates.last_run || now,
        });
      }
    }
  }

  // AC failures
  if (state.acceptance_criteria && state.acceptance_criteria.fail > 0) {
    const failingIds = (state.acceptance_criteria.results || [])
      .filter(r => r.status === 'FAIL')
      .map(r => r.id);
    blockers.push({
      type: 'ac_failure',
      message: `${state.acceptance_criteria.fail} acceptance criteria failing${failingIds.length ? ': ' + failingIds.join(', ') : ''}`,
      since: state.acceptance_criteria.last_run || new Date().toISOString(),
    });
  }

  return blockers;
}

/**
 * Compute ordered next actions based on current state.
 * @param {object} state
 * @param {object} [spec]
 * @returns {string[]}
 */
function computeNextActions(state, _spec) {
  const actions = [];

  // Validation failed → fix first
  if (state.validation && !state.validation.passed) {
    actions.push('Fix validation errors, then run: caws validate');
  }

  // Gate blockers
  if (state.gates && state.gates.results) {
    for (const g of state.gates.results) {
      if (g.status === 'fail' && g.mode === 'block') {
        actions.push(`Fix gate violation: ${g.name}`);
      }
    }
  }

  // Failing ACs
  if (state.acceptance_criteria) {
    const failing = (state.acceptance_criteria.results || [])
      .filter(r => r.status === 'FAIL')
      .map(r => r.id);
    if (failing.length > 0) {
      actions.push(`Fix failing acceptance criteria: ${failing.join(', ')}`);
    }

    const unchecked = state.acceptance_criteria.unchecked || 0;
    if (unchecked > 0) {
      actions.push(`Add tests for ${unchecked} unchecked acceptance criteria`);
    }
  }

  // Low evaluation
  if (state.evaluation && state.evaluation.percentage < 80) {
    actions.push(`Improve spec quality (currently ${state.evaluation.percentage}%), run: caws evaluate`);
  }

  // No validation yet
  if (!state.validation) {
    actions.push('Run: caws validate');
  }

  // No evaluation yet
  if (!state.evaluation) {
    actions.push('Run: caws evaluate');
  }

  // No AC verification yet
  if (!state.acceptance_criteria) {
    actions.push('Run: caws verify-acs');
  }

  // Everything green
  if (actions.length === 0) {
    actions.push('All checks passing. Ready for merge. Run: caws verify-acs --run for final verification.');
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core
  loadState,
  saveState,
  deleteState,
  updateState,
  initializeState,
  getStatePath,

  // Recorders
  recordValidation,
  recordEvaluation,
  recordGates,
  recordACVerification,
  mergeFilesTouched,

  // Derived fields
  computePhase,
  computeBlockers,
  computeNextActions,

  // Constants
  STATE_DIR,
  STATE_SCHEMA_VERSION,
  MAX_HISTORY,
};
