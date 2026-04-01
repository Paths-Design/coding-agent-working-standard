/**
 * Working-State Layer Unit Tests
 *
 * Tests the core working-state module: load/save/update/record/compute functions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadState,
  saveState,
  deleteState,
  updateState,
  initializeState,
  getStatePath,
  recordValidation,
  recordEvaluation,
  recordGates,
  recordACVerification,
  mergeFilesTouched,
  computePhase,
  computeBlockers,
  computeNextActions,
  STATE_DIR,
  STATE_SCHEMA_VERSION,
  MAX_HISTORY,
} = require('../src/utils/working-state');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ws-test-'));
  fs.mkdirSync(path.join(tmpDir, '.caws'), { recursive: true });
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================
// Core CRUD
// ============================================================

describe('loadState', () => {
  test('returns null for missing file', () => {
    expect(loadState('nonexistent', tmpDir)).toBeNull();
  });

  test('returns parsed JSON for existing file', () => {
    const state = initializeState('test-spec');
    saveState('test-spec', state, tmpDir);
    const loaded = loadState('test-spec', tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded.spec_id).toBe('test-spec');
    expect(loaded.schema).toBe(STATE_SCHEMA_VERSION);
  });

  test('returns null for corrupt JSON', () => {
    const dir = path.join(tmpDir, STATE_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not valid json');
    expect(loadState('bad', tmpDir)).toBeNull();
  });
});

describe('saveState', () => {
  test('creates state directory if missing', () => {
    const state = initializeState('new-spec');
    saveState('new-spec', state, tmpDir);
    expect(fs.existsSync(path.join(tmpDir, STATE_DIR, 'new-spec.json'))).toBe(true);
  });

  test('writes atomically (no leftover tmp files)', () => {
    const state = initializeState('atomic-spec');
    saveState('atomic-spec', state, tmpDir);
    const files = fs.readdirSync(path.join(tmpDir, STATE_DIR));
    const tmpFiles = files.filter(f => f.includes('.tmp.'));
    expect(tmpFiles.length).toBe(0);
  });

  test('round-trips correctly', () => {
    const state = initializeState('round-trip');
    state.phase = 'implementation';
    state.files_touched = ['a.js', 'b.js'];
    saveState('round-trip', state, tmpDir);
    const loaded = loadState('round-trip', tmpDir);
    expect(loaded.phase).toBe('implementation');
    expect(loaded.files_touched).toEqual(['a.js', 'b.js']);
  });
});

describe('deleteState', () => {
  test('removes state file', () => {
    const state = initializeState('delete-me');
    saveState('delete-me', state, tmpDir);
    expect(loadState('delete-me', tmpDir)).not.toBeNull();
    deleteState('delete-me', tmpDir);
    expect(loadState('delete-me', tmpDir)).toBeNull();
  });

  test('no-op for missing file', () => {
    expect(() => deleteState('nonexistent', tmpDir)).not.toThrow();
  });
});

describe('initializeState', () => {
  test('produces correct default shape', () => {
    const state = initializeState('FEAT-001');
    expect(state.schema).toBe(STATE_SCHEMA_VERSION);
    expect(state.spec_id).toBe('FEAT-001');
    expect(state.phase).toBe('not-started');
    expect(state.files_touched).toEqual([]);
    expect(state.validation).toBeNull();
    expect(state.evaluation).toBeNull();
    expect(state.gates).toBeNull();
    expect(state.acceptance_criteria).toBeNull();
    expect(state.blockers).toEqual([]);
    expect(state.next_actions).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.updated_at).toBeDefined();
  });
});

describe('getStatePath', () => {
  test('returns correct path', () => {
    const p = getStatePath('my-spec', '/some/root');
    expect(p).toBe(path.join('/some/root', STATE_DIR, 'my-spec.json'));
  });
});

// ============================================================
// updateState
// ============================================================

describe('updateState', () => {
  test('creates state file if missing', () => {
    const result = updateState('new-spec', {
      validation: { last_run: new Date().toISOString(), passed: true, error_count: 0, warning_count: 0 },
    }, { projectRoot: tmpDir });
    // Phase is derived: validation passed + nothing else = implementation
    expect(result.phase).toBe('implementation');
    expect(loadState('new-spec', tmpDir)).not.toBeNull();
  });

  test('merges files_touched with dedup', () => {
    saveState('merge-test', initializeState('merge-test'), tmpDir);
    updateState('merge-test', { files_touched: ['a.js', 'b.js'] }, { projectRoot: tmpDir });
    updateState('merge-test', { files_touched: ['b.js', 'c.js'] }, { projectRoot: tmpDir });
    const state = loadState('merge-test', tmpDir);
    expect(state.files_touched.sort()).toEqual(['a.js', 'b.js', 'c.js']);
  });

  test('appends to history', () => {
    saveState('hist', initializeState('hist'), tmpDir);
    updateState('hist', {}, { projectRoot: tmpDir, command: 'validate', summary: 'Passed' });
    updateState('hist', {}, { projectRoot: tmpDir, command: 'gates', summary: '5 passed' });
    const state = loadState('hist', tmpDir);
    expect(state.history.length).toBe(2);
    expect(state.history[0].command).toBe('validate');
    expect(state.history[1].command).toBe('gates');
  });

  test('caps history at MAX_HISTORY', () => {
    saveState('cap', initializeState('cap'), tmpDir);
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      updateState('cap', {}, { projectRoot: tmpDir, command: 'test', summary: `run ${i}` });
    }
    const state = loadState('cap', tmpDir);
    expect(state.history.length).toBe(MAX_HISTORY);
    // Should have the latest entries
    expect(state.history[MAX_HISTORY - 1].summary).toBe(`run ${MAX_HISTORY + 4}`);
  });

  test('recomputes derived fields', () => {
    saveState('derive', initializeState('derive'), tmpDir);
    updateState('derive', {
      validation: { last_run: new Date().toISOString(), passed: false, error_count: 2, warning_count: 0 },
    }, { projectRoot: tmpDir });
    const state = loadState('derive', tmpDir);
    expect(state.phase).toBe('spec-authoring');
    expect(state.blockers.length).toBeGreaterThan(0);
    expect(state.blockers[0].type).toBe('validation_failure');
  });
});

// ============================================================
// Record helpers
// ============================================================

describe('recordValidation', () => {
  test('records validation result', () => {
    saveState('rv', initializeState('rv'), tmpDir);
    recordValidation('rv', {
      passed: true,
      compliance_score: 0.85,
      grade: 'B',
      error_count: 0,
      warning_count: 2,
    }, tmpDir);
    const state = loadState('rv', tmpDir);
    expect(state.validation.passed).toBe(true);
    expect(state.validation.compliance_score).toBe(0.85);
    expect(state.validation.grade).toBe('B');
    expect(state.validation.error_count).toBe(0);
    expect(state.validation.warning_count).toBe(2);
    expect(state.history.length).toBe(1);
    expect(state.history[0].command).toBe('validate');
  });
});

describe('recordEvaluation', () => {
  test('records evaluation result', () => {
    saveState('re', initializeState('re'), tmpDir);
    recordEvaluation('re', {
      score: 75,
      max_score: 100,
      percentage: 75,
      grade: 'C',
      checks_passed: 6,
      checks_total: 9,
    }, tmpDir);
    const state = loadState('re', tmpDir);
    expect(state.evaluation.score).toBe(75);
    expect(state.evaluation.percentage).toBe(75);
    expect(state.evaluation.grade).toBe('C');
    expect(state.evaluation.checks_passed).toBe(6);
    expect(state.evaluation.checks_total).toBe(9);
  });
});

describe('recordGates', () => {
  test('records gate results', () => {
    saveState('rg', initializeState('rg'), tmpDir);
    recordGates('rg', {
      passed: true,
      summary: { blocked: 0, warned: 1, passed: 4, skipped: 0, waived: 0 },
      gates: [
        { name: 'god-object', status: 'pass', mode: 'block', messages: [], duration: 10 },
        { name: 'scope-boundary', status: 'warn', mode: 'warn', messages: ['some warning'], duration: 5 },
      ],
    }, 'commit', tmpDir);
    const state = loadState('rg', tmpDir);
    expect(state.gates.passed).toBe(true);
    expect(state.gates.context).toBe('commit');
    expect(state.gates.results.length).toBe(2);
    expect(state.gates.results[0].name).toBe('god-object');
    // Should not include messages or duration (compact)
    expect(state.gates.results[0].messages).toBeUndefined();
    expect(state.gates.results[0].duration).toBeUndefined();
  });
});

describe('recordACVerification', () => {
  test('records AC verification results', () => {
    saveState('rac', initializeState('rac'), tmpDir);
    recordACVerification('rac', {
      total: 5,
      pass: 3,
      fail: 1,
      unchecked: 1,
      results: [
        { id: 'AC-1', status: 'PASS', method: 'test_nodeids' },
        { id: 'AC-2', status: 'FAIL', method: 'test_command' },
        { id: 'AC-3', status: 'UNCHECKED' },
      ],
    }, tmpDir);
    const state = loadState('rac', tmpDir);
    expect(state.acceptance_criteria.total).toBe(5);
    expect(state.acceptance_criteria.pass).toBe(3);
    expect(state.acceptance_criteria.fail).toBe(1);
    expect(state.acceptance_criteria.results.length).toBe(3);
    // Should only include id and status (compact)
    expect(state.acceptance_criteria.results[0].method).toBeUndefined();
  });
});

describe('mergeFilesTouched', () => {
  test('merges files additively', () => {
    saveState('mft', initializeState('mft'), tmpDir);
    mergeFilesTouched('mft', ['a.js', 'b.js'], tmpDir);
    mergeFilesTouched('mft', ['b.js', 'c.js'], tmpDir);
    const state = loadState('mft', tmpDir);
    expect(state.files_touched.sort()).toEqual(['a.js', 'b.js', 'c.js']);
  });

  test('no-op for empty array', () => {
    saveState('mft-empty', initializeState('mft-empty'), tmpDir);
    mergeFilesTouched('mft-empty', [], tmpDir);
    const state = loadState('mft-empty', tmpDir);
    expect(state.files_touched).toEqual([]);
    // Should not add a history entry
    expect(state.history.length).toBe(0);
  });
});

// ============================================================
// Derived fields
// ============================================================

describe('computePhase', () => {
  test('not-started when nothing has run', () => {
    const state = initializeState('p');
    expect(computePhase(state)).toBe('not-started');
  });

  test('spec-authoring when validation failed', () => {
    const state = initializeState('p');
    state.validation = { passed: false, error_count: 2 };
    expect(computePhase(state)).toBe('spec-authoring');
  });

  test('spec-authoring when evaluation below 70%', () => {
    const state = initializeState('p');
    state.evaluation = { percentage: 60 };
    expect(computePhase(state)).toBe('spec-authoring');
  });

  test('implementation when validation passes but ACs incomplete', () => {
    const state = initializeState('p');
    state.validation = { passed: true };
    state.acceptance_criteria = { total: 3, pass: 1, fail: 1, unchecked: 1 };
    expect(computePhase(state)).toBe('implementation');
  });

  test('verification when all ACs pass and gates have run', () => {
    const state = initializeState('p');
    state.validation = { passed: true };
    state.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0 };
    state.gates = { passed: false, results: [{ name: 'x', status: 'warn', mode: 'warn' }] };
    expect(computePhase(state)).toBe('verification');
  });

  test('complete when all green', () => {
    const state = initializeState('p');
    state.validation = { passed: true };
    state.evaluation = { percentage: 95, grade: 'A' };
    state.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0 };
    state.gates = { passed: true, results: [] };
    expect(computePhase(state)).toBe('complete');
  });

  test('implementation when only validation has run', () => {
    const state = initializeState('p');
    state.validation = { passed: true };
    expect(computePhase(state)).toBe('implementation');
  });
});

describe('computeBlockers', () => {
  test('empty when no failures', () => {
    const state = initializeState('b');
    state.validation = { passed: true };
    state.gates = { passed: true, results: [] };
    expect(computeBlockers(state)).toEqual([]);
  });

  test('includes validation failure', () => {
    const state = initializeState('b');
    state.validation = { passed: false, error_count: 3, last_run: '2026-01-01T00:00:00Z' };
    const blockers = computeBlockers(state);
    expect(blockers.length).toBe(1);
    expect(blockers[0].type).toBe('validation_failure');
  });

  test('includes gate blockers (block mode only)', () => {
    const state = initializeState('b');
    state.gates = {
      passed: false,
      last_run: '2026-01-01T00:00:00Z',
      results: [
        { name: 'scope-boundary', status: 'fail', mode: 'block' },
        { name: 'todo-detection', status: 'fail', mode: 'warn' },
      ],
    };
    const blockers = computeBlockers(state);
    expect(blockers.length).toBe(1);
    expect(blockers[0].gate).toBe('scope-boundary');
  });

  test('includes AC failures', () => {
    const state = initializeState('b');
    state.acceptance_criteria = {
      total: 3, pass: 1, fail: 2, unchecked: 0,
      last_run: '2026-01-01T00:00:00Z',
      results: [
        { id: 'AC-1', status: 'PASS' },
        { id: 'AC-2', status: 'FAIL' },
        { id: 'AC-3', status: 'FAIL' },
      ],
    };
    const blockers = computeBlockers(state);
    expect(blockers.length).toBe(1);
    expect(blockers[0].type).toBe('ac_failure');
    expect(blockers[0].message).toContain('AC-2');
    expect(blockers[0].message).toContain('AC-3');
  });
});

describe('computeNextActions', () => {
  test('suggests validate when nothing has run', () => {
    const state = initializeState('na');
    const actions = computeNextActions(state);
    expect(actions.some(a => a.includes('caws validate'))).toBe(true);
  });

  test('suggests fix validation when it failed', () => {
    const state = initializeState('na');
    state.validation = { passed: false, error_count: 2 };
    const actions = computeNextActions(state);
    expect(actions[0]).toContain('Fix validation errors');
  });

  test('suggests fix gate when blocking', () => {
    const state = initializeState('na');
    state.validation = { passed: true };
    state.gates = {
      results: [{ name: 'scope-boundary', status: 'fail', mode: 'block' }],
    };
    const actions = computeNextActions(state);
    expect(actions.some(a => a.includes('scope-boundary'))).toBe(true);
  });

  test('suggests ready for merge when all green', () => {
    const state = initializeState('na');
    state.validation = { passed: true };
    state.evaluation = { percentage: 95 };
    state.gates = { passed: true, results: [] };
    state.acceptance_criteria = { total: 3, pass: 3, fail: 0, unchecked: 0, results: [] };
    const actions = computeNextActions(state);
    expect(actions[0]).toContain('Ready for merge');
  });
});
