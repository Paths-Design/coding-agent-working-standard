/**
 * Lifecycle Events Unit Tests
 *
 * Tests the governance lifecycle event system: singleton identity,
 * event emission, synchronous delivery, and payload shapes.
 */

const { lifecycle, EVENTS } = require('../src/utils/lifecycle-events');

afterEach(() => {
  lifecycle.removeAllListeners();
});

describe('lifecycle singleton', () => {
  test('exports the same instance across requires', () => {
    const { lifecycle: l2 } = require('../src/utils/lifecycle-events');
    expect(l2).toBe(lifecycle);
  });

  test('is an EventEmitter', () => {
    expect(typeof lifecycle.on).toBe('function');
    expect(typeof lifecycle.emit).toBe('function');
    expect(typeof lifecycle.removeAllListeners).toBe('function');
  });
});

describe('EVENTS constants', () => {
  test('all expected events are defined', () => {
    expect(EVENTS.GATES_BLOCKED).toBe('gates:blocked');
    expect(EVENTS.GATES_PASSED).toBe('gates:passed');
    expect(EVENTS.VALIDATION_FAILED).toBe('validation:failed');
    expect(EVENTS.VALIDATION_PASSED).toBe('validation:passed');
    expect(EVENTS.BUDGET_PRESSURE).toBe('budget:pressure');
    expect(EVENTS.PHASE_TRANSITION).toBe('phase:transition');
    expect(EVENTS.MERGE_PRE).toBe('merge:pre');
    expect(EVENTS.MERGE_POST).toBe('merge:post');
  });
});

describe('event emission', () => {
  test('gates:blocked fires synchronously with payload', () => {
    let received = null;
    lifecycle.on(EVENTS.GATES_BLOCKED, (payload) => { received = payload; });

    lifecycle.emit(EVENTS.GATES_BLOCKED, {
      specId: 'FEAT-001',
      gateName: 'scope_boundary',
      mode: 'block',
      messages: ['Out of scope'],
      context: 'commit',
      timestamp: '2026-04-01T00:00:00Z',
    });

    // Synchronous — received is set before emit returns
    expect(received).not.toBeNull();
    expect(received.specId).toBe('FEAT-001');
    expect(received.gateName).toBe('scope_boundary');
    expect(received.context).toBe('commit');
  });

  test('gates:passed fires with summary', () => {
    let received = null;
    lifecycle.on(EVENTS.GATES_PASSED, (payload) => { received = payload; });

    lifecycle.emit(EVENTS.GATES_PASSED, {
      specId: 'FEAT-001',
      summary: { blocked: 0, warned: 0, passed: 5, skipped: 0, waived: 0 },
      context: 'cli',
      timestamp: '2026-04-01T00:00:00Z',
    });

    expect(received.summary.passed).toBe(5);
  });

  test('validation:failed fires with errors', () => {
    let received = null;
    lifecycle.on(EVENTS.VALIDATION_FAILED, (payload) => { received = payload; });

    lifecycle.emit(EVENTS.VALIDATION_FAILED, {
      specId: 'FEAT-001',
      errors: [{ message: 'Missing title' }],
      errorCount: 1,
      warningCount: 0,
      timestamp: '2026-04-01T00:00:00Z',
    });

    expect(received.errorCount).toBe(1);
  });

  test('phase:transition fires with old and new phase', () => {
    let received = null;
    lifecycle.on(EVENTS.PHASE_TRANSITION, (payload) => { received = payload; });

    lifecycle.emit(EVENTS.PHASE_TRANSITION, {
      specId: 'FEAT-001',
      oldPhase: 'implementation',
      newPhase: 'verification',
      timestamp: '2026-04-01T00:00:00Z',
    });

    expect(received.oldPhase).toBe('implementation');
    expect(received.newPhase).toBe('verification');
  });

  test('multiple listeners receive the same event', () => {
    const results = [];
    lifecycle.on(EVENTS.GATES_PASSED, () => { results.push('a'); });
    lifecycle.on(EVENTS.GATES_PASSED, () => { results.push('b'); });

    lifecycle.emit(EVENTS.GATES_PASSED, { specId: null, summary: {}, context: 'cli', timestamp: '' });

    expect(results).toEqual(['a', 'b']);
  });

  test('removeAllListeners clears subscriptions', () => {
    let called = false;
    lifecycle.on(EVENTS.GATES_BLOCKED, () => { called = true; });
    lifecycle.removeAllListeners();

    lifecycle.emit(EVENTS.GATES_BLOCKED, {});
    expect(called).toBe(false);
  });
});
