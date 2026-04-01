/**
 * @fileoverview Report formatters for quality gate results
 * Provides human-readable text and machine-readable JSON output.
 * @author @darianrosebrook
 */

const STATUS_ICONS = {
  pass: '\u2713',   // checkmark
  fail: '\u2717',   // X mark
  warn: '\u26A0',   // warning triangle
  skipped: '\u2014', // em dash
};

/**
 * Format gate report as human-readable text for terminal output
 * @param {Object} report - Report from evaluateGates()
 * @returns {string} Formatted text output
 */
function formatText(report) {
  const lines = [];

  lines.push('Quality Gates Report');
  lines.push('====================');
  lines.push('');

  for (const gate of report.gates) {
    const icon = STATUS_ICONS[gate.status] || '?';
    const modeLabel = gate.mode === 'block' ? '[BLOCK]' : gate.mode === 'warn' ? '[WARN]' : `[${gate.mode.toUpperCase()}]`;
    const waiverNote = gate.waived ? ' (waived)' : '';

    lines.push(`  ${icon} ${gate.name} ${modeLabel}${waiverNote} (${gate.duration}ms)`);

    if (gate.messages && gate.messages.length > 0) {
      for (const msg of gate.messages) {
        lines.push(`      ${msg}`);
      }
    }
  }

  lines.push('');
  lines.push('--------------------');

  const { summary } = report;
  const parts = [];
  if (summary.passed > 0) parts.push(`${summary.passed} passed`);
  if (summary.warned > 0) parts.push(`${summary.warned} warned`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.waived > 0) parts.push(`${summary.waived} waived`);

  lines.push(`Summary: ${parts.join(', ')}`);

  if (report.warnings && report.warnings.length > 0) {
    for (const w of report.warnings) {
      lines.push(`WARNING: ${w}`);
    }
  }

  if (report.passed) {
    // Only say "all passed" if every enabled gate actually ran and passed
    const enabledGates = report.gates.filter(g => g.status !== 'skipped');
    const allRanAndPassed = enabledGates.length > 0 && enabledGates.every(g => g.status === 'pass');
    if (allRanAndPassed) {
      lines.push('Result: All enabled gates passed.');
    } else {
      lines.push('Result: No blocking failures.');
    }
  } else {
    lines.push('Result: Commit blocked by failing gates.');
  }

  return lines.join('\n');
}

/**
 * Format gate report as JSON for CI/hooks consumption
 * @param {Object} report - Report from evaluateGates()
 * @returns {string} JSON string
 */
function formatJson(report) {
  return JSON.stringify({
    passed: report.passed,
    summary: report.summary,
    gates: report.gates.map(g => ({
      name: g.name,
      mode: g.mode,
      status: g.status,
      waived: g.waived,
      waiverId: g.waiverId || null,
      messages: g.messages,
      duration: g.duration,
    })),
    warnings: report.warnings || [],
    timestamp: new Date().toISOString(),
  }, null, 2);
}

/**
 * Format gate report with enriched feedback for failed/warned gates.
 * Falls back to standard format for gates without enrichment.
 * @param {Object} report - Report from evaluateGates()
 * @param {Map<string, Object>} enrichments - Map of gate name → enrichment from feedback.js
 * @returns {string} Formatted text output
 */
function formatEnrichedText(report, enrichments) {
  const lines = [];

  lines.push('Quality Gates Report');
  lines.push('====================');
  lines.push('');

  for (const gate of report.gates) {
    const icon = STATUS_ICONS[gate.status] || '?';
    const modeLabel = gate.mode === 'block' ? '[BLOCK]' : gate.mode === 'warn' ? '[WARN]' : `[${gate.mode.toUpperCase()}]`;
    const waiverNote = gate.waived ? ' (waived)' : '';
    const enrichment = enrichments.get(gate.name);
    const categoryTag = enrichment ? ` [${enrichment.category}]` : '';

    lines.push(`  ${icon} ${gate.name} ${modeLabel}${categoryTag}${waiverNote} (${gate.duration}ms)`);

    // Raw messages first
    if (gate.messages && gate.messages.length > 0) {
      for (const msg of gate.messages) {
        lines.push(`      ${msg}`);
      }
    }

    // Enrichment details for failed/warned gates
    if (enrichment) {
      if (enrichment.why) {
        lines.push(`      Why: ${enrichment.why}`);
      }
      if (enrichment.recurrence) {
        lines.push(`      Recurring: failed ${enrichment.recurrence.count} time(s) (last: ${enrichment.recurrence.lastSeen})`);
      }
      if (enrichment.nextStep) {
        lines.push(`      Next step: ${enrichment.nextStep}`);
      }
      if (enrichment.remediation) {
        lines.push(`      Fix: ${enrichment.remediation}`);
      }
    }
  }

  lines.push('');
  lines.push('--------------------');

  const { summary } = report;
  const parts = [];
  if (summary.passed > 0) parts.push(`${summary.passed} passed`);
  if (summary.warned > 0) parts.push(`${summary.warned} warned`);
  if (summary.blocked > 0) parts.push(`${summary.blocked} blocked`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.waived > 0) parts.push(`${summary.waived} waived`);

  lines.push(`Summary: ${parts.join(', ')}`);

  if (report.warnings && report.warnings.length > 0) {
    for (const w of report.warnings) {
      lines.push(`WARNING: ${w}`);
    }
  }

  if (report.passed) {
    const enabledGates = report.gates.filter(g => g.status !== 'skipped');
    const allRanAndPassed = enabledGates.length > 0 && enabledGates.every(g => g.status === 'pass');
    if (allRanAndPassed) {
      lines.push('Result: All enabled gates passed.');
    } else {
      lines.push('Result: No blocking failures.');
    }
  } else {
    lines.push('Result: Commit blocked by failing gates.');
  }

  return lines.join('\n');
}

module.exports = { formatText, formatJson, formatEnrichedText };
