/**
 * @fileoverview Shared output schema for governance sidecars.
 * All sidecars return a consistent envelope with type, specId, timestamp,
 * status, data (sidecar-specific), and meta.
 * @author @darianrosebrook
 */

const chalk = require('chalk');

// ---------------------------------------------------------------------------
// Envelope constructors
// ---------------------------------------------------------------------------

/**
 * Create a sidecar output envelope.
 * If data contains a `status` field, it is hoisted to the top-level status.
 * @param {string} type - Sidecar type (e.g. 'drift', 'gaps')
 * @param {string} specId - The spec this output relates to
 * @param {object} data - Sidecar-specific payload
 * @param {object} [meta={}] - Additional metadata
 * @returns {object} Sidecar output envelope
 */
function createSidecarOutput(type, specId, data, meta = {}) {
  const status = data && data.status ? data.status : 'ok';
  const cleanData = { ...data };
  delete cleanData.status;

  return {
    type: `sidecar:${type}`,
    specId,
    timestamp: new Date().toISOString(),
    status,
    data: cleanData,
    meta: { duration_ms: 0, ...meta },
  };
}

/**
 * Shorthand for when the sidecar has no working state to analyze.
 * @param {string} type - Sidecar type
 * @param {string} specId - The spec id
 * @returns {object} Sidecar output envelope with status 'no-state'
 */
function createNoStateOutput(type, specId) {
  return createSidecarOutput(type, specId, {
    status: 'no-state',
    message: 'No working state found for this spec',
  });
}

// ---------------------------------------------------------------------------
// Per-type text formatters
// ---------------------------------------------------------------------------

function formatDrift(data) {
  const lines = [];
  lines.push(chalk.bold('Drift Analysis'));
  lines.push(`  Drift detected: ${data.drift_detected ? chalk.red('yes') : chalk.green('no')}`);
  if (data.out_of_scope_files && data.out_of_scope_files.length > 0) {
    lines.push(chalk.yellow(`  Out-of-scope files (${data.out_of_scope_files.length}):`));
    data.out_of_scope_files.forEach(f => lines.push(`    - ${f}`));
  }
  if (data.missing_evidence && data.missing_evidence.length > 0) {
    lines.push(chalk.yellow(`  Missing AC evidence (${data.missing_evidence.length}):`));
    data.missing_evidence.forEach(ac => lines.push(`    - ${ac.id}: ${ac.description}`));
  }
  if (data.failing_criteria && data.failing_criteria.length > 0) {
    lines.push(chalk.red(`  Failing criteria (${data.failing_criteria.length}):`));
    data.failing_criteria.forEach(ac => lines.push(`    - ${ac.id}: ${ac.description}`));
  }
  if (data.scope_creep_files && data.scope_creep_files.length > 0) {
    lines.push(chalk.yellow(`  Unmatched files (${data.scope_creep_files.length}):`));
    data.scope_creep_files.forEach(f => lines.push(`    - ${f}`));
  }
  if (data.summary) lines.push(`  ${data.summary}`);
  return lines.join('\n');
}

function formatGaps(data) {
  const lines = [];
  lines.push(chalk.bold('Phase Gaps'));
  if (data.current_phase) lines.push(`  Current phase: ${data.current_phase}`);
  if (data.target_phase) lines.push(`  Target phase:  ${data.target_phase}`);
  if (data.gaps && data.gaps.length > 0) {
    data.gaps.forEach(g => {
      const sev = g.severity === 'blocker' ? chalk.red(g.severity) : chalk.yellow(g.severity);
      lines.push(`  - [${sev}] ${g.message || g.category}`);
      if (g.remediation) lines.push(`    Fix: ${g.remediation}`);
    });
  }
  return lines.join('\n');
}

function formatWaiverDraft(data) {
  const lines = [];
  lines.push(chalk.bold('Waiver Drafts'));
  if (data.drafts && data.drafts.length > 0) {
    data.drafts.forEach(d => {
      lines.push(`  ${chalk.cyan(d.gate || d.id)}:`);
      if (d.yaml) lines.push(`    ${chalk.dim(d.yaml.replace(/\n/g, '\n    '))}`);
    });
  }
  return lines.join('\n');
}

function formatProvenance(data) {
  const lines = [];
  lines.push(chalk.bold('Provenance'));
  if (data.file_stats) lines.push(`  Files: ${data.file_stats.total || 0} touched`);
  if (data.command_history) lines.push(`  Commands: ${data.command_history.length || 0} recorded`);
  if (data.progression) lines.push(`  Progression: ${data.progression}`);
  if (data.merge_readiness != null) {
    const ready = data.merge_readiness ? chalk.green('ready') : chalk.red('not ready');
    lines.push(`  Merge readiness: ${ready}`);
  }
  return lines.join('\n');
}

const TYPE_FORMATTERS = {
  'sidecar:drift': formatDrift,
  'sidecar:gaps': formatGaps,
  'sidecar:waiver-draft': formatWaiverDraft,
  'sidecar:provenance': formatProvenance,
};

// ---------------------------------------------------------------------------
// Main text formatter
// ---------------------------------------------------------------------------

/**
 * Render any sidecar output envelope as human-readable text.
 * Dispatches to per-type formatters; falls back to JSON dump for unknown types.
 * @param {object} output - Sidecar output envelope
 * @returns {string} Formatted text
 */
function formatSidecarText(output) {
  if (output.status === 'no-state') {
    return chalk.dim(output.data.message || 'No working state found');
  }
  const formatter = TYPE_FORMATTERS[output.type];
  if (formatter) return formatter(output.data);
  return JSON.stringify(output.data, null, 2);
}

module.exports = {
  createSidecarOutput,
  createNoStateOutput,
  formatSidecarText,
};
