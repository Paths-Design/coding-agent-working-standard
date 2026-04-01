/**
 * @fileoverview Provenance Summarization Sidecar
 * Compact summary of all work performed on a spec: files touched,
 * commands run, validation/evaluation progression, gate results over time.
 * Used for merge readiness assessment or handoff.
 * @author @darianrosebrook
 */

const path = require('path');
const { createSidecarOutput, createNoStateOutput } = require('./schema');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Group file paths by their top-level directory.
 * e.g. "src/auth/login.js" -> "src/", "README.md" -> "./"
 * @param {string[]} files
 * @returns {Object<string, number>}
 */
function groupByDirectory(files) {
  const groups = {};
  for (const f of files) {
    const dir = path.dirname(f);
    const topLevel = dir === '.' ? './' : dir.split(path.sep)[0] + '/';
    groups[topLevel] = (groups[topLevel] || 0) + 1;
  }
  return groups;
}

/**
 * Count commands from history entries.
 * @param {Array<{command: string}>} history
 * @returns {Object<string, number>}
 */
function countCommands(history) {
  const counts = {};
  for (const entry of history) {
    if (entry.command) {
      counts[entry.command] = (counts[entry.command] || 0) + 1;
    }
  }
  return counts;
}

/**
 * Parse evaluation summary strings like "85/100 (85%) Grade B".
 * @param {string} summary
 * @returns {{ percentage: number, grade: string } | null}
 */
function parseEvalSummary(summary) {
  if (!summary) return null;
  const m = summary.match(/(\d+)\/\d+ \((\d+)%\) Grade (\w+)/);
  if (!m) return null;
  return { percentage: Number(m[2]), grade: m[3] };
}

/**
 * Parse validation summary — "passed" or "failed with N errors".
 * @param {string} summary
 * @returns {{ passed: boolean } | null}
 */
function parseValidationSummary(summary) {
  if (!summary) return null;
  const lower = summary.toLowerCase();
  if (lower.startsWith('passed') || lower === 'pass') return { passed: true };
  if (lower.startsWith('failed') || lower === 'fail') return { passed: false };
  return null;
}

/**
 * Parse gates summary — "5 passed, 2 blocked".
 * @param {string} summary
 * @returns {{ blocked: number } | null}
 */
function parseGatesSummary(summary) {
  if (!summary) return null;
  const m = summary.match(/(\d+)\s+passed,\s+(\d+)\s+blocked/);
  if (!m) return null;
  return { blocked: Number(m[2]) };
}

/**
 * Extract progression arrays from history entries.
 * @param {Array<{command: string, summary: string, timestamp: string}>} history
 * @returns {object}
 */
function extractProgression(history) {
  const validation = [];
  const evaluation = [];
  const gates = [];

  for (const entry of history) {
    const ts = entry.timestamp;
    if (entry.command === 'validate') {
      const parsed = parseValidationSummary(entry.summary);
      if (parsed) validation.push({ timestamp: ts, ...parsed });
    } else if (entry.command === 'evaluate') {
      const parsed = parseEvalSummary(entry.summary);
      if (parsed) evaluation.push({ timestamp: ts, ...parsed });
    } else if (entry.command === 'gates') {
      const parsed = parseGatesSummary(entry.summary);
      if (parsed) gates.push({ timestamp: ts, ...parsed });
    }
  }

  return { validation, evaluation, gates };
}

/**
 * Build the current status snapshot from top-level state fields.
 * @param {object} state
 * @returns {object}
 */
function buildCurrentStatus(state) {
  const status = {};
  if (state.validation) {
    status.validation = {
      passed: !!state.validation.passed,
      grade: state.validation.grade || null,
      compliance_score: state.validation.compliance_score != null ? state.validation.compliance_score : null,
    };
  }
  if (state.evaluation) {
    status.evaluation = {
      percentage: state.evaluation.percentage != null ? state.evaluation.percentage : null,
      grade: state.evaluation.grade || null,
    };
  }
  if (state.gates) {
    status.gates = {
      passed: !!state.gates.passed,
      blocked_count: state.gates.blocked_count != null ? state.gates.blocked_count : 0,
    };
  }
  if (state.acceptance_criteria) {
    const ac = state.acceptance_criteria;
    status.acceptance_criteria = {
      total: ac.total || 0,
      pass: ac.pass || 0,
      fail: ac.fail || 0,
      unchecked: ac.unchecked || 0,
    };
  }
  return status;
}

/**
 * Compute merge readiness and list of missing items.
 * @param {object} state
 * @returns {{ ready: boolean, missing: string[] }}
 */
function computeMergeReadiness(state) {
  const missing = [];

  if (!state.validation || !state.validation.passed) {
    missing.push('Validation not passing');
  }

  const evalPct = state.evaluation ? state.evaluation.percentage : null;
  if (evalPct == null || evalPct < 90) {
    missing.push(evalPct != null ? `Evaluation at ${evalPct}% (need 90%)` : 'No evaluation run');
  }

  if (state.acceptance_criteria) {
    if (state.acceptance_criteria.fail > 0) {
      missing.push(`${state.acceptance_criteria.fail} ACs failing`);
    }
    if (state.acceptance_criteria.unchecked > 0) {
      missing.push(`${state.acceptance_criteria.unchecked} ACs unchecked`);
    }
  } else {
    missing.push('No AC verification run');
  }

  if (!state.gates || !state.gates.passed) {
    missing.push('Gates not passing');
  }

  const ready = state.phase === 'complete' && missing.length === 0;
  return { ready, missing };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Summarize provenance for a spec's working state.
 * @param {object|null} state - Working state from loadState()
 * @param {object} [spec] - The resolved spec (for id/title)
 * @returns {object} Sidecar output envelope
 */
function summarizeProvenance(state, spec) {
  if (!state) {
    return createNoStateOutput('provenance', (spec && spec.id) || 'unknown');
  }

  const specId = (spec && spec.id) || state.spec_id || 'unknown';
  const specTitle = (spec && spec.title) || '';
  const files = state.files_touched || [];
  const history = state.history || [];

  const filesTouched = {
    total: files.length,
    by_directory: groupByDirectory(files),
  };

  const commandHistory = countCommands(history);
  const progression = extractProgression(history);
  const currentStatus = buildCurrentStatus(state);
  const mergeReadiness = computeMergeReadiness(state);

  const totalCommands = history.length;
  const evalPct = state.evaluation ? state.evaluation.percentage : null;
  const summaryParts = [`${files.length} files touched`, `${totalCommands} commands run`];
  if (evalPct != null) summaryParts.push(`evaluation at ${evalPct}%`);
  if (mergeReadiness.missing.length > 0) {
    summaryParts.push(mergeReadiness.missing[0].toLowerCase());
  }

  const data = {
    spec_id: specId,
    spec_title: specTitle,
    phase: state.phase || 'unknown',
    files_touched: filesTouched,
    command_history: commandHistory,
    progression,
    current_status: currentStatus,
    merge_readiness: mergeReadiness,
    summary: summaryParts.join(', '),
  };

  return createSidecarOutput('provenance', specId, data);
}

module.exports = { summarizeProvenance };
