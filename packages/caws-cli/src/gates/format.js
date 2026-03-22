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
    timestamp: new Date().toISOString(),
  }, null, 2);
}

module.exports = { formatText, formatJson };
