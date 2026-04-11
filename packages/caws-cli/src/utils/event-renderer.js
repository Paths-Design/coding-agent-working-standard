/**
 * @fileoverview Event Renderer — pure fold over the event log
 *
 * Replays `.caws/events.jsonl` into the same view shape that
 * `working-state.loadState(specId)` produces today. This module is
 * a pure function: same events in → same view out, no filesystem
 * side effects, no writes.
 *
 * The fold logic is a verbatim port of the three pure helpers in
 * `working-state.js` (`computePhase`, `computeBlockers`,
 * `computeNextActions`) — they already operated on a state object,
 * so we simply apply them to the rolling fold result after each event.
 *
 * Phase 1 reads the event log *in addition to* the state layer, not
 * instead of it. The parity test in
 * `tests/integration/event-log-parity.test.js` asserts the two paths
 * produce equivalent views for the fields iterate/status/sidecar/gates
 * actually consume.
 *
 * @author @darianrosebrook
 */

const { readEvents } = require('./event-log');

// Must match working-state.js for parity.
const STATE_SCHEMA_VERSION = 'caws.state.v1';
const MAX_HISTORY = 20;

// ---------------------------------------------------------------------------
// Shape: empty state (mirrors working-state.initializeState)
// ---------------------------------------------------------------------------

/**
 * Build an empty default view for a spec that has no events yet.
 * @param {string} specId
 * @returns {object}
 */
function emptyView(specId) {
  return {
    schema: STATE_SCHEMA_VERSION,
    spec_id: specId,
    updated_at: null,
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

// ---------------------------------------------------------------------------
// Derived-field computation (verbatim port from working-state.js:334-474)
//
// These functions operate on the fold result, not on persisted state.
// They must stay byte-equivalent to the originals until Phase 3 removes
// the state layer entirely.
// ---------------------------------------------------------------------------

/**
 * Derive the current workflow phase from the folded state.
 * Identical semantics to `working-state.computePhase`.
 * @param {object} state
 * @returns {string}
 */
function computePhase(state) {
  const v = state.validation;
  const e = state.evaluation;
  const g = state.gates;
  const ac = state.acceptance_criteria;

  // Closed specs stay closed regardless of prior artifacts.
  if (state.phase === 'closed') return 'closed';

  // Nothing has run yet
  if (!v && !e && !g && !ac) return 'not-started';

  // Validation failed or evaluation below 70% → still authoring the spec
  if (v && !v.passed) return 'spec-authoring';
  if (e && e.percentage < 70) return 'spec-authoring';

  // All ACs pass, all gates pass, evaluation >= 90% → complete
  if (
    ac && ac.total > 0 && ac.fail === 0 && ac.unchecked === 0 &&
    g && g.passed &&
    e && e.percentage >= 90
  ) {
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
 * Extract active blockers from the folded state.
 * Identical semantics to `working-state.computeBlockers`.
 * @param {object} state
 * @returns {object[]}
 */
function computeBlockers(state) {
  // Closed specs have no active blockers. This is a Phase 1 divergence
  // from working-state.computeBlockers, which predates the spec_closed
  // event. See EVLOG-001 acceptance criterion A5 and design doc §8.2:
  // closed specs must render with phase=closed and no blockers, without
  // touching the filesystem.
  if (state.phase === 'closed') return [];

  const blockers = [];
  const now = new Date().toISOString();

  if (state.validation && !state.validation.passed) {
    blockers.push({
      type: 'validation_failure',
      message: `Validation failed with ${state.validation.error_count} error(s)`,
      since: state.validation.last_run || now,
    });
  }

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

  if (state.acceptance_criteria && state.acceptance_criteria.fail > 0) {
    const failingIds = (state.acceptance_criteria.results || [])
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id);
    blockers.push({
      type: 'ac_failure',
      message: `${state.acceptance_criteria.fail} acceptance criteria failing${failingIds.length ? ': ' + failingIds.join(', ') : ''}`,
      since: state.acceptance_criteria.last_run || now,
    });
  }

  return blockers;
}

/**
 * Compute ordered next actions from the folded state.
 * Identical semantics to `working-state.computeNextActions`.
 * @param {object} state
 * @returns {string[]}
 */
function computeNextActions(state) {
  const actions = [];

  // Closed specs have no next actions.
  if (state.phase === 'closed') return [];

  if (state.validation && !state.validation.passed) {
    actions.push('Fix validation errors, then run: caws validate');
  }

  if (state.gates && state.gates.results) {
    for (const g of state.gates.results) {
      if (g.status === 'fail' && g.mode === 'block') {
        actions.push(`Fix gate violation: ${g.name}`);
      }
    }
  }

  if (state.acceptance_criteria) {
    const failing = (state.acceptance_criteria.results || [])
      .filter((r) => r.status === 'FAIL')
      .map((r) => r.id);
    if (failing.length > 0) {
      actions.push(`Fix failing acceptance criteria: ${failing.join(', ')}`);
    }

    const unchecked = state.acceptance_criteria.unchecked || 0;
    if (unchecked > 0) {
      actions.push(`Add tests for ${unchecked} unchecked acceptance criteria`);
    }
  }

  if (state.evaluation && state.evaluation.percentage < 80) {
    actions.push(
      `Improve spec quality (currently ${state.evaluation.percentage}%), run: caws evaluate`
    );
  }

  if (!state.validation) {
    actions.push('Run: caws validate');
  }

  if (!state.evaluation) {
    actions.push('Run: caws evaluate');
  }

  if (!state.acceptance_criteria) {
    actions.push('Run: caws verify-acs');
  }

  if (actions.length === 0) {
    actions.push(
      'All checks passing. Ready for merge. Run: caws verify-acs --run for final verification.'
    );
  }

  return actions;
}

// ---------------------------------------------------------------------------
// Fold: apply a single event to a per-spec view
// ---------------------------------------------------------------------------

/**
 * Apply one event to the given per-spec view. Mutates and returns the view.
 * This mirrors the merge semantics of `working-state.updateState`:
 *   - replace-merge for validation/evaluation/gates/acceptance_criteria
 *   - set-union merge for files_touched
 *   - append-then-cap history
 *
 * @param {object} view
 * @param {object} event
 * @returns {object} The mutated view (returned for chaining)
 */
function applyEvent(view, event) {
  const { event: type, data = {}, ts } = event;

  switch (type) {
    case 'spec_created': {
      // No state fields to set here; the spec registry is the source of truth
      // for type/title/risk_tier/mode. We record it in history so the renderer
      // can distinguish "never touched" from "created but not yet worked".
      view.history.push({
        timestamp: ts,
        command: 'specs.create',
        summary: `Created ${data.type || 'spec'}: ${data.title || data.id || view.spec_id}`,
      });
      break;
    }

    case 'spec_closed': {
      view.phase = 'closed';
      view.blockers = [];
      view.next_actions = [];
      view.history.push({
        timestamp: ts,
        command: 'specs.close',
        summary: `Closed (prior status: ${data.prior_status || 'unknown'})`,
      });
      break;
    }

    case 'spec_deleted': {
      // A deleted spec shouldn't typically be rendered; if we do see it,
      // mark the view as terminal but leave a trace in history.
      view.phase = 'closed';
      view.history.push({
        timestamp: ts,
        command: 'specs.delete',
        summary: 'Deleted',
      });
      break;
    }

    case 'validation_completed': {
      view.validation = {
        last_run: ts,
        passed: !!data.passed,
        compliance_score: data.compliance_score ?? null,
        grade: data.grade ?? null,
        error_count: data.error_count ?? 0,
        warning_count: data.warning_count ?? 0,
      };
      const summaryText = data.passed
        ? `Passed (Grade ${view.validation.grade || '?'})`
        : `Failed — ${view.validation.error_count} error(s)`;
      view.history.push({
        timestamp: ts,
        command: 'validate',
        summary: summaryText,
      });
      break;
    }

    case 'evaluation_completed': {
      view.evaluation = {
        last_run: ts,
        score: data.score,
        max_score: data.max_score,
        percentage: data.percentage,
        grade: data.grade,
        checks_passed: data.checks_passed,
        checks_total: data.checks_total,
      };
      view.history.push({
        timestamp: ts,
        command: 'evaluate',
        summary: `${data.score}/${data.max_score} (${data.percentage}%) Grade ${data.grade}`,
      });
      break;
    }

    case 'gates_evaluated': {
      view.gates = {
        last_run: ts,
        context: data.context || 'cli',
        passed: !!data.passed,
        summary: data.summary || {},
        results: (data.gates || []).map((g) => ({
          name: g.name,
          status: g.status,
          mode: g.mode,
        })),
      };
      const { blocked = 0, warned = 0, passed = 0 } = data.summary || {};
      view.history.push({
        timestamp: ts,
        command: 'gates',
        summary: `${passed} passed, ${blocked} blocked, ${warned} warned`,
      });
      break;
    }

    case 'verify_acs_completed': {
      view.acceptance_criteria = {
        last_run: ts,
        total: data.total,
        pass: data.pass,
        fail: data.fail,
        unchecked: data.unchecked,
        results: (data.results || []).map((r) => ({
          id: r.id,
          status: r.status,
        })),
      };
      view.history.push({
        timestamp: ts,
        command: 'verify-acs',
        summary: `${data.pass}/${data.total} pass, ${data.fail} fail, ${data.unchecked} unchecked`,
      });
      break;
    }

    case 'session_ended': {
      // A session can touch files without calling any spec-scoped command.
      // When the session ends, merge its file list into this spec's view.
      // Only applies if the event carries our spec_id (the caller filters).
      if (Array.isArray(data.files_touched) && data.files_touched.length > 0) {
        const merged = new Set([...view.files_touched, ...data.files_touched]);
        view.files_touched = [...merged];
        view.history.push({
          timestamp: ts,
          command: 'session',
          summary: `+${data.files_touched.length} file(s) touched`,
        });
      }
      break;
    }

    default:
      // Unknown or non-spec-scoped event type — ignore for this fold.
      break;
  }

  // Derived fields recomputed on every applicable event.
  view.blockers = computeBlockers(view);
  view.next_actions = computeNextActions(view);
  view.phase = computePhase(view);
  view.updated_at = ts;

  // Cap history at MAX_HISTORY (matches working-state.updateState).
  if (view.history.length > MAX_HISTORY) {
    view.history = view.history.slice(-MAX_HISTORY);
  }

  return view;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fold an event stream into the view for a single spec.
 *
 * Pure function: the same events + specId always produce the same view.
 * No filesystem access. No writes.
 *
 * Events are filtered to those that are either scoped to this spec via
 * `spec_id`, or session-level events whose `data.spec_id` matches.
 *
 * @param {object[]} events — the full event stream (from readEvents)
 * @param {string} specId
 * @returns {object} view matching the shape of working-state.loadState
 */
function renderSpecState(events, specId) {
  if (!specId || typeof specId !== 'string') {
    throw new Error('event-renderer.renderSpecState: specId is required');
  }
  const view = emptyView(specId);
  for (const event of events) {
    if (!isEventForSpec(event, specId)) continue;
    applyEvent(view, event);
  }
  return view;
}

/**
 * Fold an event stream into a Map of specId → view for every spec that
 * has at least one event in the stream.
 *
 * @param {object[]} events
 * @returns {Map<string, object>}
 */
function renderAllSpecStates(events) {
  const views = new Map();
  for (const event of events) {
    const specId = getEventSpecId(event);
    if (!specId) continue;
    if (!views.has(specId)) {
      views.set(specId, emptyView(specId));
    }
    applyEvent(views.get(specId), event);
  }
  return views;
}

/**
 * Convenience: read the event log and render a single spec's view.
 * Equivalent to calling `loadState(specId)` but backed by the event log.
 *
 * **Contract parity with `working-state.loadState`**: returns `null` when
 * there are zero events for this spec, matching `loadState`'s behavior of
 * returning `null` when the state file does not exist. This is load-bearing
 * for Phase 2 read flips — call sites like `status.js`'s
 * `loadState(id) || null` coalesce depend on it, and `iterate.js`'s
 * `if (workingState) { ... }` guard would otherwise always be truthy under
 * the event-log path even for untouched specs.
 *
 * `renderSpecState` itself stays pure and always returns a view object
 * (possibly empty). The null translation only happens here, at the
 * `loadState`-compatible boundary.
 *
 * @param {string} specId
 * @param {object} [options]
 * @param {string} [options.projectRoot]
 * @returns {object|null}
 */
function loadStateFromEvents(specId, options = {}) {
  const events = readEvents(options);
  // If no events match this spec, return null to match loadState's contract.
  let hasMatch = false;
  for (const event of events) {
    if (isEventForSpec(event, specId)) {
      hasMatch = true;
      break;
    }
  }
  if (!hasMatch) return null;
  return renderSpecState(events, specId);
}

/**
 * Determine whether an event is scoped to a given spec.
 * @param {object} event
 * @param {string} specId
 * @returns {boolean}
 */
function isEventForSpec(event, specId) {
  if (event.spec_id === specId) return true;
  // Session events may carry their own spec_id inside data.
  if (event.event === 'session_ended' && event.data && event.data.spec_id === specId) {
    return true;
  }
  return false;
}

/**
 * Extract the spec_id an event refers to, if any. Used by
 * renderAllSpecStates to group events by spec.
 * @param {object} event
 * @returns {string|null}
 */
function getEventSpecId(event) {
  if (event.spec_id) return event.spec_id;
  if (event.data && event.data.spec_id) return event.data.spec_id;
  return null;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  renderSpecState,
  renderAllSpecStates,
  loadStateFromEvents,
  emptyView,

  // Exposed for tests only.
  _internal: {
    applyEvent,
    computePhase,
    computeBlockers,
    computeNextActions,
    isEventForSpec,
    getEventSpecId,
    STATE_SCHEMA_VERSION,
    MAX_HISTORY,
  },
};
