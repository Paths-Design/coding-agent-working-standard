/**
 * Event Renderer Unit Tests (EVLOG-001 Phase 1)
 *
 * Exercises the pure fold from an event stream into a per-spec view.
 * The critical parity against working-state.loadState is covered in
 * tests/integration/event-log-parity.test.js; this file covers the
 * renderer in isolation.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  renderSpecState,
  renderAllSpecStates,
  loadStateFromEvents,
  emptyView,
  _internal,
} = require('../src/utils/event-renderer');

const { appendEvent } = require('../src/utils/event-log');

const { applyEvent, computePhase, computeBlockers, computeNextActions, isEventForSpec } =
  _internal;

/**
 * Build a minimal event with the fields the renderer cares about.
 * `seq` is irrelevant to the fold (order is by array position).
 */
function ev(type, { spec_id, data, ts = '2026-04-10T12:00:00.000Z' } = {}) {
  const e = { seq: 1, ts, actor: 'cli', event: type };
  if (spec_id !== undefined) e.spec_id = spec_id;
  if (data !== undefined) e.data = data;
  return e;
}

// ---------------------------------------------------------------------------
// emptyView — matches working-state.initializeState shape
// ---------------------------------------------------------------------------

describe('emptyView', () => {
  test('has every field loadState returns, in not-started phase', () => {
    const v = emptyView('TEST-001');
    expect(v).toMatchObject({
      schema: 'caws.state.v1',
      spec_id: 'TEST-001',
      phase: 'not-started',
      files_touched: [],
      validation: null,
      evaluation: null,
      gates: null,
      acceptance_criteria: null,
      blockers: [],
      next_actions: [],
      history: [],
    });
    expect(v.updated_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderSpecState — fold correctness
// ---------------------------------------------------------------------------

describe('renderSpecState', () => {
  test('returns empty view when there are no matching events', () => {
    const view = renderSpecState([], 'TEST-001');
    expect(view.phase).toBe('not-started');
    expect(view.validation).toBeNull();
  });

  test('ignores events scoped to other specs', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'OTHER-002',
        data: { passed: true, grade: 'A', compliance_score: 100 },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.validation).toBeNull();
    expect(view.phase).toBe('not-started');
  });

  test('folds a validation_completed event into view.validation', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: {
          passed: true,
          compliance_score: 95,
          grade: 'A',
          error_count: 0,
          warning_count: 2,
        },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.validation).toEqual({
      last_run: '2026-04-10T12:00:00.000Z',
      passed: true,
      compliance_score: 95,
      grade: 'A',
      error_count: 0,
      warning_count: 2,
    });
    // Phase starts at implementation (validation passed, nothing else run yet).
    expect(view.phase).toBe('implementation');
  });

  test('latest validation_completed wins (replace-merge, not accumulate)', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        ts: '2026-04-10T10:00:00.000Z',
        data: { passed: false, error_count: 3, grade: 'D' },
      }),
      ev('validation_completed', {
        spec_id: 'TEST-001',
        ts: '2026-04-10T11:00:00.000Z',
        data: { passed: true, error_count: 0, grade: 'A' },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.validation.passed).toBe(true);
    expect(view.validation.error_count).toBe(0);
    expect(view.validation.grade).toBe('A');
  });

  test('failing validation surfaces as blocker and drives phase to spec-authoring', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: { passed: false, error_count: 3 },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.phase).toBe('spec-authoring');
    expect(view.blockers).toEqual([
      {
        type: 'validation_failure',
        message: 'Validation failed with 3 error(s)',
        since: '2026-04-10T12:00:00.000Z',
      },
    ]);
    expect(view.next_actions[0]).toMatch(/Fix validation errors/);
  });

  test('evaluation below 70% drives phase to spec-authoring even if validation passed', () => {
    const events = [
      ev('validation_completed', { spec_id: 'TEST-001', data: { passed: true, grade: 'A' } }),
      ev('evaluation_completed', {
        spec_id: 'TEST-001',
        data: { score: 60, max_score: 100, percentage: 60, grade: 'D', checks_passed: 6, checks_total: 10 },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.phase).toBe('spec-authoring');
  });

  test('full happy path folds into complete phase', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: { passed: true, grade: 'A', compliance_score: 95 },
      }),
      ev('evaluation_completed', {
        spec_id: 'TEST-001',
        data: { score: 95, max_score: 100, percentage: 95, grade: 'A', checks_passed: 10, checks_total: 10 },
      }),
      ev('verify_acs_completed', {
        spec_id: 'TEST-001',
        data: {
          total: 3,
          pass: 3,
          fail: 0,
          unchecked: 0,
          results: [
            { id: 'A1', status: 'PASS' },
            { id: 'A2', status: 'PASS' },
            { id: 'A3', status: 'PASS' },
          ],
        },
      }),
      ev('gates_evaluated', {
        spec_id: 'TEST-001',
        data: {
          context: 'cli',
          passed: true,
          summary: { passed: 5, blocked: 0, warned: 0 },
          gates: [{ name: 'coverage', status: 'pass', mode: 'block' }],
        },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.phase).toBe('complete');
    expect(view.blockers).toEqual([]);
    expect(view.next_actions).toEqual([
      'All checks passing. Ready for merge. Run: caws verify-acs --run for final verification.',
    ]);
  });

  test('failing gate with mode=block produces a gate_failure blocker', () => {
    const events = [
      ev('gates_evaluated', {
        spec_id: 'TEST-001',
        data: {
          context: 'cli',
          passed: false,
          summary: { passed: 1, blocked: 1, warned: 0 },
          gates: [
            { name: 'coverage', status: 'pass', mode: 'block' },
            { name: 'mutation', status: 'fail', mode: 'block' },
          ],
        },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    const gateBlockers = view.blockers.filter((b) => b.type === 'gate_failure');
    expect(gateBlockers).toHaveLength(1);
    expect(gateBlockers[0].gate).toBe('mutation');
    expect(view.next_actions).toContain('Fix gate violation: mutation');
  });

  test('failing acceptance criteria surface as ac_failure blocker with IDs', () => {
    const events = [
      ev('verify_acs_completed', {
        spec_id: 'TEST-001',
        data: {
          total: 3,
          pass: 1,
          fail: 2,
          unchecked: 0,
          results: [
            { id: 'A1', status: 'PASS' },
            { id: 'A2', status: 'FAIL' },
            { id: 'A3', status: 'FAIL' },
          ],
        },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    const acBlockers = view.blockers.filter((b) => b.type === 'ac_failure');
    expect(acBlockers).toHaveLength(1);
    expect(acBlockers[0].message).toContain('A2');
    expect(acBlockers[0].message).toContain('A3');
    expect(view.next_actions).toContain('Fix failing acceptance criteria: A2, A3');
  });

  test('spec_closed drives phase to closed and clears blockers/next_actions', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: { passed: false, error_count: 1 },
      }),
      ev('spec_closed', {
        spec_id: 'TEST-001',
        data: { id: 'TEST-001', prior_status: 'active' },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    expect(view.phase).toBe('closed');
    expect(view.blockers).toEqual([]);
    expect(view.next_actions).toEqual([]);
  });

  test('session_ended merges files_touched into the spec view (set-union)', () => {
    const events = [
      ev('session_ended', {
        data: {
          session_id: 's1',
          spec_id: 'TEST-001',
          files_touched: ['src/a.js', 'src/b.js'],
          outcome: 'success',
        },
      }),
      ev('session_ended', {
        data: {
          session_id: 's2',
          spec_id: 'TEST-001',
          files_touched: ['src/b.js', 'src/c.js'],
          outcome: 'success',
        },
      }),
    ];
    const view = renderSpecState(events, 'TEST-001');
    // Set-union with no duplicates, order preserved from insertion
    expect(view.files_touched).toEqual(['src/a.js', 'src/b.js', 'src/c.js']);
  });

  test('history is capped at MAX_HISTORY (20) entries', () => {
    const events = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        ev('validation_completed', {
          spec_id: 'TEST-001',
          ts: `2026-04-10T12:${String(i).padStart(2, '0')}:00.000Z`,
          data: { passed: true, grade: 'A', error_count: 0, iter: i },
        })
      );
    }
    const view = renderSpecState(events, 'TEST-001');
    expect(view.history).toHaveLength(20);
    // Last 20 means indices 10..29 — check the last entry's timestamp.
    expect(view.history[19].timestamp).toBe('2026-04-10T12:29:00.000Z');
  });

  test('throws on missing specId', () => {
    expect(() => renderSpecState([], '')).toThrow(/specId is required/);
    expect(() => renderSpecState([], null)).toThrow(/specId is required/);
    expect(() => renderSpecState([], undefined)).toThrow(/specId is required/);
  });
});

// ---------------------------------------------------------------------------
// renderAllSpecStates — multi-spec grouping
// ---------------------------------------------------------------------------

describe('renderAllSpecStates', () => {
  test('groups events by spec and returns a Map', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'A-001',
        data: { passed: true, grade: 'A' },
      }),
      ev('validation_completed', {
        spec_id: 'B-002',
        data: { passed: false, error_count: 2 },
      }),
      ev('evaluation_completed', {
        spec_id: 'A-001',
        data: { score: 90, max_score: 100, percentage: 90, grade: 'A', checks_passed: 9, checks_total: 10 },
      }),
    ];
    const views = renderAllSpecStates(events);
    expect(views.size).toBe(2);
    expect(views.get('A-001').validation.passed).toBe(true);
    expect(views.get('A-001').evaluation.percentage).toBe(90);
    expect(views.get('B-002').validation.passed).toBe(false);
    expect(views.get('B-002').phase).toBe('spec-authoring');
  });

  test('skips events with no spec_id', () => {
    const events = [
      ev('session_started', { data: { session_id: 's1' } }),
      ev('validation_completed', { spec_id: 'A-001', data: { passed: true, grade: 'A' } }),
    ];
    const views = renderAllSpecStates(events);
    expect(views.size).toBe(1);
    expect(views.has('A-001')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Derived-field parity with working-state.js
// ---------------------------------------------------------------------------

describe('computePhase — parity with working-state', () => {
  test('not-started when nothing has run', () => {
    expect(computePhase(emptyView('X'))).toBe('not-started');
  });

  test('closed is sticky (stays closed regardless of artifacts)', () => {
    const view = emptyView('X');
    view.phase = 'closed';
    view.validation = { passed: true, grade: 'A' };
    expect(computePhase(view)).toBe('closed');
  });

  test('spec-authoring on failing validation', () => {
    const view = emptyView('X');
    view.validation = { passed: false, error_count: 1 };
    expect(computePhase(view)).toBe('spec-authoring');
  });

  test('implementation on passing validation, nothing else', () => {
    const view = emptyView('X');
    view.validation = { passed: true, grade: 'A' };
    expect(computePhase(view)).toBe('implementation');
  });

  test('verification when ACs pass and gates have run', () => {
    const view = emptyView('X');
    view.validation = { passed: true };
    view.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0, results: [] };
    view.gates = { passed: true, results: [], context: 'cli' };
    expect(computePhase(view)).toBe('verification');
  });

  test('complete only when eval >= 90%', () => {
    const view = emptyView('X');
    view.validation = { passed: true };
    view.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0, results: [] };
    view.gates = { passed: true, results: [], context: 'cli' };
    view.evaluation = { percentage: 90, grade: 'A' };
    expect(computePhase(view)).toBe('complete');
  });

  test('evaluation 89% is not complete (boundary)', () => {
    const view = emptyView('X');
    view.validation = { passed: true };
    view.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0, results: [] };
    view.gates = { passed: true, results: [], context: 'cli' };
    view.evaluation = { percentage: 89, grade: 'B' };
    expect(computePhase(view)).toBe('verification');
  });
});

describe('computeBlockers — parity with working-state', () => {
  test('empty when state is clean', () => {
    expect(computeBlockers(emptyView('X'))).toEqual([]);
  });

  test('surfaces only gates with mode=block (not mode=warn)', () => {
    const view = emptyView('X');
    view.gates = {
      results: [
        { name: 'coverage', status: 'fail', mode: 'warn' },
        { name: 'mutation', status: 'fail', mode: 'block' },
      ],
      last_run: '2026-04-10T12:00:00.000Z',
    };
    const blockers = computeBlockers(view);
    expect(blockers).toHaveLength(1);
    expect(blockers[0].gate).toBe('mutation');
  });
});

describe('computeNextActions — parity with working-state', () => {
  test('prompts for missing verifications in order', () => {
    const actions = computeNextActions(emptyView('X'));
    expect(actions).toEqual([
      'Run: caws validate',
      'Run: caws evaluate',
      'Run: caws verify-acs',
    ]);
  });

  test('returns empty for a closed spec', () => {
    const view = emptyView('X');
    view.phase = 'closed';
    expect(computeNextActions(view)).toEqual([]);
  });

  test('all-green fallback message when nothing is blocking', () => {
    const view = emptyView('X');
    view.validation = { passed: true };
    view.evaluation = { percentage: 95 };
    view.acceptance_criteria = { total: 1, pass: 1, fail: 0, unchecked: 0, results: [] };
    view.gates = { passed: true, results: [] };
    const actions = computeNextActions(view);
    expect(actions).toEqual([
      'All checks passing. Ready for merge. Run: caws verify-acs --run for final verification.',
    ]);
  });
});

describe('isEventForSpec', () => {
  test('matches top-level spec_id', () => {
    expect(isEventForSpec({ spec_id: 'X-001', event: 'validation_completed' }, 'X-001')).toBe(
      true
    );
    expect(isEventForSpec({ spec_id: 'Y-002', event: 'validation_completed' }, 'X-001')).toBe(
      false
    );
  });

  test('matches session_ended events via data.spec_id', () => {
    expect(
      isEventForSpec(
        { event: 'session_ended', data: { spec_id: 'X-001' } },
        'X-001'
      )
    ).toBe(true);
  });

  test('does not match session_started via data.spec_id (only session_ended carries file merges)', () => {
    expect(
      isEventForSpec(
        { event: 'session_started', data: { spec_id: 'X-001' } },
        'X-001'
      )
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Purity: renderSpecState must not touch the input events array
// ---------------------------------------------------------------------------

describe('renderSpecState — purity', () => {
  test('does not mutate the input events array or its event objects', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: { passed: true, grade: 'A' },
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(events));
    renderSpecState(events, 'TEST-001');
    expect(events).toEqual(snapshot);
  });

  test('two sequential calls on the same input produce equivalent output', () => {
    const events = [
      ev('validation_completed', {
        spec_id: 'TEST-001',
        data: { passed: true, grade: 'A' },
      }),
      ev('evaluation_completed', {
        spec_id: 'TEST-001',
        data: { score: 90, max_score: 100, percentage: 90, grade: 'A', checks_passed: 9, checks_total: 10 },
      }),
    ];
    const a = renderSpecState(events, 'TEST-001');
    const b = renderSpecState(events, 'TEST-001');
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// applyEvent — unknown event types are inert
// ---------------------------------------------------------------------------

describe('applyEvent — unknown event tolerance', () => {
  test('unknown event types do not mutate the view except derived fields', () => {
    const view = emptyView('X');
    const before = JSON.parse(JSON.stringify(view));
    applyEvent(view, { event: 'future_event_type', spec_id: 'X', data: { whatever: 1 } });
    // The fold still recomputes derived fields, so updated_at will have been set.
    // Everything else should be unchanged.
    expect(view.validation).toEqual(before.validation);
    expect(view.evaluation).toEqual(before.evaluation);
    expect(view.gates).toEqual(before.gates);
    expect(view.acceptance_criteria).toEqual(before.acceptance_criteria);
    expect(view.files_touched).toEqual(before.files_touched);
    expect(view.history).toEqual(before.history);
  });
});

// ---------------------------------------------------------------------------
// loadStateFromEvents — filesystem-reading convenience wrapper
//
// Contract: must match working-state.loadState exactly — return null when
// there are zero events for the spec, return a view object otherwise.
// This is load-bearing for Phase 2 read flips (EVLOG-002). The existing
// call sites all check `workingState && ...` or `loadState(id) || null`,
// so flipping from loadState to loadStateFromEvents only preserves
// semantics if the "untouched spec" case returns null.
// ---------------------------------------------------------------------------

describe('loadStateFromEvents — null contract parity with loadState', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-evlog-render-'));
    fs.mkdirSync(path.join(tmpDir, '.caws'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('returns null when events.jsonl does not exist (matches loadState(missing-file))', () => {
    const result = loadStateFromEvents('TEST-001', { projectRoot: tmpDir });
    expect(result).toBeNull();
  });

  test('returns null when events.jsonl is empty', () => {
    fs.writeFileSync(path.join(tmpDir, '.caws', 'events.jsonl'), '');
    const result = loadStateFromEvents('TEST-001', { projectRoot: tmpDir });
    expect(result).toBeNull();
  });

  test('returns null when events exist but none match the requested spec', async () => {
    await appendEvent(
      {
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'OTHER-001',
        data: { passed: true, grade: 'A' },
      },
      { projectRoot: tmpDir }
    );
    const result = loadStateFromEvents('TEST-001', { projectRoot: tmpDir });
    expect(result).toBeNull();
  });

  test('returns a view when at least one event matches the spec', async () => {
    await appendEvent(
      {
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'TEST-001',
        data: { passed: true, grade: 'A', score: 95 },
      },
      { projectRoot: tmpDir }
    );
    const result = loadStateFromEvents('TEST-001', { projectRoot: tmpDir });
    expect(result).not.toBeNull();
    expect(result.spec_id).toBe('TEST-001');
    expect(result.validation).toMatchObject({ passed: true, grade: 'A' });
  });

  test('multi-spec log returns null for untouched specs and views for touched ones', async () => {
    await appendEvent(
      {
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'A-001',
        data: { passed: true, grade: 'A' },
      },
      { projectRoot: tmpDir }
    );
    await appendEvent(
      {
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'B-002',
        data: { passed: false, grade: 'F' },
      },
      { projectRoot: tmpDir }
    );

    expect(loadStateFromEvents('A-001', { projectRoot: tmpDir })).not.toBeNull();
    expect(loadStateFromEvents('B-002', { projectRoot: tmpDir })).not.toBeNull();
    expect(loadStateFromEvents('C-003', { projectRoot: tmpDir })).toBeNull();
  });

  test('`null &&` guard idiom used by iterate/status call sites works under the event-log path', async () => {
    // Simulates: `let ws = null; try { ws = loadStateFromEvents(id); } catch {}`
    // then `if (ws && ws.phase !== 'not-started') { ... }`.
    // With the null contract, untouched specs never enter the branch.
    const untouched = loadStateFromEvents('UNTOUCHED-001', { projectRoot: tmpDir });
    const enteredBranch = untouched && untouched.phase !== 'not-started';
    expect(enteredBranch).toBeFalsy();
  });
});
