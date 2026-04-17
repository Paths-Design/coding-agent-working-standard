/**
 * Event Log Parity Integration Test (EVLOG-001 Phase 1)
 *
 * Asserts that the fields iterate/status/sidecar/gates consume from
 * `loadState(specId)` are byte-equivalent to `renderSpecState(readEvents(), specId)`
 * after the same logical operations are applied to both paths.
 *
 * This is the load-bearing verification for the Phase 1 dual-write migration.
 * If it breaks, something has diverged between the state layer and the
 * event-log renderer in a way that would break downstream consumers.
 *
 * Deliberately chooses direct recorder invocation over full command
 * invocation: the goal here is renderer↔state-layer parity, not CLI
 * wiring. Wiring is covered by the call-site edits in validate/evaluate/
 * verify-acs/gates/specs/session-manager and is exercised indirectly by
 * the full jest suite.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  recordValidation,
  recordEvaluation,
  recordGates,
  recordACVerification,
  mergeFilesTouched,
  loadState,
} = require('../../src/utils/working-state');

const { appendEvent, appendEventSync, readEvents } = require('../../src/utils/event-log');
const { renderSpecState } = require('../../src/utils/event-renderer');

let tmpDir;
let originalCwd;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-parity-test-'));
  fs.mkdirSync(path.join(tmpDir, '.caws'), { recursive: true });
  // Pin cwd so loadState's findRoot walk resolves to our tmpdir.
  process.chdir(tmpDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fields that must match between loadState and renderSpecState.
//
// Excluded from parity (deliberate Phase 1 divergences, documented in
// EVENTS_LOG_MIGRATION.md §8 and EVLOG-001 invariants):
//   - updated_at: empty view is null, loadState seeds it at initializeState
//     time. We don't compare it because they're computed from different
//     clocks (recorder call time vs event emission time).
//   - history[]: working-state writes a bounded ring buffer at update time.
//     The renderer derives its history from the event stream. Entry
//     semantics are the same but timestamps and ordering can differ.
//   - schema: both use "caws.state.v1" so this would match, but it's
//     implementation-detail and not a field consumers care about.
//
// These fields ARE compared — they're what iterate/status/sidecar/gates
// actually read from loadState:
// ---------------------------------------------------------------------------
const PARITY_FIELDS = [
  'phase',
  'validation',
  'evaluation',
  'gates',
  'acceptance_criteria',
  'blockers',
  'next_actions',
  'files_touched',
];

/**
 * Normalize a state object for comparison: drop fields we don't claim parity
 * on, and normalize the `last_run` timestamps on sub-objects since those are
 * stamped independently in each path.
 */
function normalize(state) {
  if (!state) return null;
  const clone = JSON.parse(JSON.stringify(state));
  const result = {};
  for (const field of PARITY_FIELDS) {
    let value = clone[field];
    // Drop last_run — it's a wall-clock that differs between paths.
    if (value && typeof value === 'object' && 'last_run' in value) {
      const { last_run: _last_run, ...rest } = value;
      value = rest;
    }
    // Blockers carry a `since` timestamp we also need to drop.
    if (Array.isArray(value)) {
      value = value.map((item) => {
        if (item && typeof item === 'object' && 'since' in item) {
          const { since: _since, ...rest } = item;
          return rest;
        }
        return item;
      });
    }
    result[field] = value;
  }
  return result;
}

/**
 * Emit an event via appendEvent AND the matching recordX call so both
 * paths reflect the same logical operation. Caller passes the payload;
 * we fan it out.
 */
async function dualWrite(specId, kind, payload, context) {
  switch (kind) {
    case 'validation':
      recordValidation(specId, payload);
      await appendEvent({
        actor: 'cli',
        event: 'validation_completed',
        spec_id: specId,
        data: payload,
      });
      break;
    case 'evaluation':
      recordEvaluation(specId, payload);
      await appendEvent({
        actor: 'cli',
        event: 'evaluation_completed',
        spec_id: specId,
        data: payload,
      });
      break;
    case 'gates':
      recordGates(specId, payload, context || 'cli');
      await appendEvent({
        actor: 'cli',
        event: 'gates_evaluated',
        spec_id: specId,
        data: {
          context: context || 'cli',
          passed: payload.passed,
          summary: payload.summary || {},
          gates: (payload.gates || []).map((g) => ({
            name: g.name,
            status: g.status,
            mode: g.mode,
          })),
        },
      });
      break;
    case 'verify_acs':
      recordACVerification(specId, payload);
      await appendEvent({
        actor: 'cli',
        event: 'verify_acs_completed',
        spec_id: specId,
        data: payload,
      });
      break;
    case 'files':
      mergeFilesTouched(specId, payload);
      appendEventSync({
        actor: 'session',
        event: 'session_ended',
        data: { session_id: 's-test', spec_id: specId, files_touched: payload, outcome: 'success' },
      });
      break;
    default:
      throw new Error(`dualWrite: unknown kind ${kind}`);
  }
}

/**
 * Run a full comparison between loadState and renderSpecState for the
 * given specId. Throws (via jest matchers) on any divergence in the
 * parity fields.
 */
function assertParity(specId) {
  const fromState = loadState(specId);
  const events = readEvents();
  const fromEvents = renderSpecState(events, specId);
  expect(normalize(fromEvents)).toEqual(normalize(fromState));
}

// ---------------------------------------------------------------------------
// Scenario 1: Validation only
// ---------------------------------------------------------------------------

describe('parity: validation only', () => {
  test('passing validation → implementation phase in both paths', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      compliance_score: 95,
      grade: 'A',
      error_count: 0,
      warning_count: 1,
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.phase).toBe('implementation');
    expect(fromState.validation.grade).toBe('A');
  });

  test('failing validation → spec-authoring phase and validation_failure blocker', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: false,
      compliance_score: 45,
      grade: 'F',
      error_count: 5,
      warning_count: 2,
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.phase).toBe('spec-authoring');
    expect(fromState.blockers).toHaveLength(1);
    expect(fromState.blockers[0].type).toBe('validation_failure');
  });

  test('replace-merge: second validation overwrites first in both paths', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: false,
      error_count: 3,
      warning_count: 0,
    });
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      grade: 'A',
      compliance_score: 95,
      error_count: 0,
      warning_count: 0,
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.validation.passed).toBe(true);
    expect(fromState.validation.error_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Evaluation
// ---------------------------------------------------------------------------

describe('parity: evaluation only', () => {
  test('90% evaluation + passing validation → parity with A grade', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      grade: 'A',
      error_count: 0,
      warning_count: 0,
    });
    await dualWrite('TEST-001', 'evaluation', {
      score: 90,
      max_score: 100,
      percentage: 90,
      grade: 'A',
      checks_passed: 9,
      checks_total: 10,
    });
    assertParity('TEST-001');
  });

  test('60% evaluation → spec-authoring regardless of passing validation', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      grade: 'A',
      error_count: 0,
      warning_count: 0,
    });
    await dualWrite('TEST-001', 'evaluation', {
      score: 60,
      max_score: 100,
      percentage: 60,
      grade: 'D',
      checks_passed: 6,
      checks_total: 10,
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.phase).toBe('spec-authoring');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Gates
// ---------------------------------------------------------------------------

describe('parity: gates', () => {
  test('all gates passing', async () => {
    await dualWrite('TEST-001', 'gates', {
      passed: true,
      summary: { passed: 3, blocked: 0, warned: 0 },
      gates: [
        { name: 'coverage', status: 'pass', mode: 'block' },
        { name: 'mutation', status: 'pass', mode: 'block' },
        { name: 'budget', status: 'pass', mode: 'warn' },
      ],
    });
    assertParity('TEST-001');
  });

  test('blocking gate failure produces a gate_failure blocker in both paths', async () => {
    await dualWrite('TEST-001', 'gates', {
      passed: false,
      summary: { passed: 1, blocked: 1, warned: 0 },
      gates: [
        { name: 'coverage', status: 'pass', mode: 'block' },
        { name: 'mutation', status: 'fail', mode: 'block' },
      ],
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    const gateBlockers = fromState.blockers.filter((b) => b.type === 'gate_failure');
    expect(gateBlockers).toHaveLength(1);
    expect(gateBlockers[0].gate).toBe('mutation');
  });

  test('warn-mode gate failure does NOT produce a blocker (parity on sensitivity)', async () => {
    await dualWrite('TEST-001', 'gates', {
      passed: true,
      summary: { passed: 1, blocked: 0, warned: 1 },
      gates: [
        { name: 'coverage', status: 'pass', mode: 'block' },
        { name: 'budget', status: 'fail', mode: 'warn' },
      ],
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    const gateBlockers = fromState.blockers.filter((b) => b.type === 'gate_failure');
    expect(gateBlockers).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Acceptance criteria
// ---------------------------------------------------------------------------

describe('parity: verify_acs', () => {
  test('all ACs passing', async () => {
    await dualWrite('TEST-001', 'verify_acs', {
      total: 3,
      pass: 3,
      fail: 0,
      unchecked: 0,
      results: [
        { id: 'A1', status: 'PASS' },
        { id: 'A2', status: 'PASS' },
        { id: 'A3', status: 'PASS' },
      ],
    });
    assertParity('TEST-001');
  });

  test('mixed pass/fail/unchecked', async () => {
    await dualWrite('TEST-001', 'verify_acs', {
      total: 4,
      pass: 2,
      fail: 1,
      unchecked: 1,
      results: [
        { id: 'A1', status: 'PASS' },
        { id: 'A2', status: 'FAIL' },
        { id: 'A3', status: 'PASS' },
        { id: 'A4', status: 'UNCHECKED' },
      ],
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    const acBlockers = fromState.blockers.filter((b) => b.type === 'ac_failure');
    expect(acBlockers).toHaveLength(1);
    expect(acBlockers[0].message).toContain('A2');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: Files touched
// ---------------------------------------------------------------------------

describe('parity: files_touched', () => {
  test('single file list merges into both paths', async () => {
    await dualWrite('TEST-001', 'files', ['src/a.js', 'src/b.js']);
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.files_touched).toEqual(['src/a.js', 'src/b.js']);
  });

  test('repeated merges dedupe across both paths', async () => {
    await dualWrite('TEST-001', 'files', ['src/a.js', 'src/b.js']);
    await dualWrite('TEST-001', 'files', ['src/b.js', 'src/c.js']);
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(new Set(fromState.files_touched)).toEqual(
      new Set(['src/a.js', 'src/b.js', 'src/c.js'])
    );
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: Full happy path — every recorder type in one spec
// ---------------------------------------------------------------------------

describe('parity: full happy path', () => {
  test('validate → evaluate → verify_acs → gates → complete phase in both paths', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      compliance_score: 95,
      grade: 'A',
      error_count: 0,
      warning_count: 0,
    });
    await dualWrite('TEST-001', 'evaluation', {
      score: 95,
      max_score: 100,
      percentage: 95,
      grade: 'A',
      checks_passed: 10,
      checks_total: 10,
    });
    await dualWrite('TEST-001', 'verify_acs', {
      total: 3,
      pass: 3,
      fail: 0,
      unchecked: 0,
      results: [
        { id: 'A1', status: 'PASS' },
        { id: 'A2', status: 'PASS' },
        { id: 'A3', status: 'PASS' },
      ],
    });
    await dualWrite('TEST-001', 'gates', {
      passed: true,
      summary: { passed: 3, blocked: 0, warned: 0 },
      gates: [
        { name: 'coverage', status: 'pass', mode: 'block' },
        { name: 'mutation', status: 'pass', mode: 'block' },
        { name: 'budget', status: 'pass', mode: 'warn' },
      ],
    });
    assertParity('TEST-001');

    const fromState = loadState('TEST-001');
    expect(fromState.phase).toBe('complete');
    expect(fromState.blockers).toEqual([]);
  });

  test('partial progress reaches verification phase', async () => {
    await dualWrite('TEST-001', 'validation', {
      passed: true,
      grade: 'A',
      error_count: 0,
      warning_count: 0,
    });
    await dualWrite('TEST-001', 'verify_acs', {
      total: 2,
      pass: 2,
      fail: 0,
      unchecked: 0,
      results: [
        { id: 'A1', status: 'PASS' },
        { id: 'A2', status: 'PASS' },
      ],
    });
    await dualWrite('TEST-001', 'gates', {
      passed: true,
      summary: { passed: 2, blocked: 0, warned: 0 },
      gates: [{ name: 'coverage', status: 'pass', mode: 'block' }],
    });
    assertParity('TEST-001');

    // No evaluation yet, so phase is verification, not complete.
    const fromState = loadState('TEST-001');
    expect(fromState.phase).toBe('verification');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: Multi-spec isolation
// ---------------------------------------------------------------------------

describe('parity: multi-spec isolation', () => {
  test('two specs folded independently, no cross-contamination', async () => {
    await dualWrite('SPEC-001', 'validation', {
      passed: true,
      grade: 'A',
      error_count: 0,
      warning_count: 0,
    });
    await dualWrite('SPEC-002', 'validation', {
      passed: false,
      error_count: 2,
      warning_count: 0,
    });
    assertParity('SPEC-001');
    assertParity('SPEC-002');

    const s1 = loadState('SPEC-001');
    const s2 = loadState('SPEC-002');
    expect(s1.phase).toBe('implementation');
    expect(s2.phase).toBe('spec-authoring');
  });
});
