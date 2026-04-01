/**
 * @fileoverview Gate Feedback Enrichment
 *
 * Post-processes raw gate results into enriched feedback with:
 * - why: human-readable explanation of the failure
 * - category: scope | policy | quality | architectural
 * - recurrence: how many times this gate has failed recently
 * - nextStep: the smallest safe action to resolve
 * - remediation: a CLI command to fix or waive
 *
 * This module sits between the gate pipeline output and the formatter.
 *
 * @author @darianrosebrook
 */

// ---------------------------------------------------------------------------
// Gate → category mapping
// ---------------------------------------------------------------------------

const GATE_CATEGORIES = {
  scope_boundary: 'scope',
  budget_limit: 'policy',
  god_object: 'architectural',
  todo_detection: 'quality',
  spec_completeness: 'quality',
};

// ---------------------------------------------------------------------------
// Per-gate enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a scope_boundary failure.
 * Messages follow: "Out of scope (excluded): FILE" or "Out of scope (not in allowed paths): FILE"
 */
function enrichScopeBoundary(gate, spec) {
  const scopeIn = spec?.scope?.in || [];
  const files = gate.messages
    .filter(m => m.startsWith('Out of scope'))
    .map(m => m.replace(/^Out of scope \([^)]+\): /, ''));

  if (files.length === 0) return null;

  const why = files.length === 1
    ? `${files[0]} is outside scope.in patterns [${scopeIn.join(', ')}]`
    : `${files.length} files are outside scope.in patterns [${scopeIn.join(', ')}]`;

  return {
    why,
    nextStep: files.length === 1
      ? `Add the file's directory to scope.in, or move the change to a separate spec`
      : `Expand scope.in to cover these paths, or split into a separate spec`,
    remediation: 'caws waivers create --gates scope_boundary',
  };
}

/**
 * Enrich a budget_limit failure.
 * Messages follow: violation messages from checkBudgetCompliance.
 */
function enrichBudgetLimit(gate) {
  const why = gate.messages.length > 0
    ? gate.messages[0]
    : 'Change exceeds the budget limits for this risk tier';

  return {
    why,
    nextStep: 'Split this change into smaller commits, or request a waiver',
    remediation: 'caws waivers create --gates budget_limit',
  };
}

/**
 * Enrich a god_object failure.
 * Messages follow: "CRITICAL: FILE has N lines (threshold: T)"
 */
function enrichGodObject(gate) {
  const criticals = gate.messages.filter(m => m.startsWith('CRITICAL'));
  const file = criticals.length > 0
    ? criticals[0].replace(/^CRITICAL[^:]*: /, '').replace(/ has \d+.*/, '')
    : null;

  const why = criticals.length > 0
    ? criticals[0]
    : gate.messages[0] || 'File exceeds line-count threshold';

  return {
    why,
    nextStep: file
      ? `Extract helper modules from ${file} to reduce its size`
      : 'Extract helper modules to reduce file size',
    remediation: 'caws waivers create --gates god_object',
  };
}

/**
 * Enrich a todo_detection failure.
 * Messages follow: "FILE:LINE: MARKER found"
 */
function enrichTodoDetection(gate) {
  const markers = gate.messages.filter(m => m.includes(' found'));
  const why = markers.length > 0
    ? `${markers.length} TODO/FIXME marker(s) detected in staged changes`
    : 'Actionable markers detected';

  return {
    why,
    nextStep: 'Resolve the TODO/FIXME items before committing, or convert to tracked issues',
    remediation: 'caws waivers create --gates todo_detection',
  };
}

/**
 * Enrich a spec_completeness failure.
 */
function enrichSpecCompleteness(gate) {
  return {
    why: gate.messages[0] || 'Working spec does not pass schema validation',
    nextStep: 'Run: caws validate for detailed errors and suggestions',
    remediation: null,
  };
}

/**
 * Generic fallback enrichment.
 */
function enrichGeneric(gate) {
  return {
    why: gate.messages[0] || `Gate "${gate.name}" failed`,
    nextStep: `Investigate the gate failure and resolve the issue`,
    remediation: `caws waivers create --gates ${gate.name}`,
  };
}

// ---------------------------------------------------------------------------
// Enrichment dispatch
// ---------------------------------------------------------------------------

const ENRICHERS = {
  scope_boundary: enrichScopeBoundary,
  budget_limit: enrichBudgetLimit,
  god_object: enrichGodObject,
  todo_detection: enrichTodoDetection,
  spec_completeness: enrichSpecCompleteness,
};

// ---------------------------------------------------------------------------
// Recurrence detection
// ---------------------------------------------------------------------------

/**
 * Check how many recent gate runs had this gate failing.
 * Uses working state history entries where command === 'gates'.
 * @param {string} gateName
 * @param {object|null} state - Working state object
 * @returns {{ count: number, lastSeen: string }|null}
 */
function getRecurrence(gateName, state) {
  if (!state?.history) return null;

  // Look at previous gate run results stored in state.gates
  // History entries only have command + summary, but state.gates.results
  // has the per-gate results from the LAST run. For recurrence we need
  // to check if the current failure matches blockers that existed before.
  // Since we only store the latest gate results, we count consecutive
  // history entries with "blocked" in their summary.
  const gateEntries = state.history.filter(h => h.command === 'gates');
  if (gateEntries.length <= 1) return null; // Only the current run

  let count = 0;
  let lastSeen = null;

  // Count backward from second-to-last (the previous runs, not current)
  for (let i = gateEntries.length - 2; i >= 0; i--) {
    const entry = gateEntries[i];
    // Summary format: "N passed, M blocked, K warned"
    // Must check for non-zero blocked count (not just substring "blocked")
    const blockedMatch = entry.summary && entry.summary.match(/(\d+) blocked/);
    if (blockedMatch && parseInt(blockedMatch[1], 10) > 0) {
      count++;
      if (!lastSeen) lastSeen = entry.timestamp;
    } else {
      break; // Stop at first non-blocked run
    }
  }

  if (count === 0) return null;

  // Format lastSeen as relative time
  const lastSeenRelative = formatTimeSince(lastSeen);

  return { count, lastSeen: lastSeenRelative };
}

/**
 * Format an ISO timestamp as a relative time string.
 * @param {string} isoTimestamp
 * @returns {string}
 */
function formatTimeSince(isoTimestamp) {
  if (!isoTimestamp) return 'unknown';
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  if (isNaN(diff)) return 'unknown';

  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Main enrichment function
// ---------------------------------------------------------------------------

/**
 * Enrich gate results with contextual feedback.
 * @param {object} report - Pipeline report from evaluateGates()
 * @param {object} context
 * @param {object} [context.spec] - Resolved spec
 * @param {object} [context.state] - Working state (from loadState)
 * @returns {Map<string, object>} Map of gate name → enrichment object
 */
function enrichGateResults(report, context = {}) {
  const { spec, state } = context;
  const enrichments = new Map();

  for (const gate of report.gates) {
    // Only enrich failed or warned gates
    if (gate.status === 'pass' || gate.status === 'skipped') continue;
    if (gate.waived) continue;

    const enricher = ENRICHERS[gate.name] || enrichGeneric;
    const result = enricher(gate, spec);
    if (!result) continue;

    const category = GATE_CATEGORIES[gate.name] || 'quality';
    const recurrence = getRecurrence(gate.name, state);

    enrichments.set(gate.name, {
      gate: gate.name,
      category,
      why: result.why,
      recurrence,
      nextStep: result.nextStep,
      remediation: result.remediation,
    });
  }

  return enrichments;
}

module.exports = {
  enrichGateResults,
  getRecurrence,
  formatTimeSince,
  GATE_CATEGORIES,
};
