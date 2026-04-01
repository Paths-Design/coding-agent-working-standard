/**
 * Working-State Integration Tests
 *
 * Verifies that CLI commands correctly persist results to working state files.
 * Uses real command implementations against temp project directories.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

const { loadState, saveState, initializeState, STATE_DIR } = require('../../src/utils/working-state');
const { recordValidation, recordEvaluation, recordGates, recordACVerification } = require('../../src/utils/working-state');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ws-int-'));
  fs.mkdirSync(path.join(tmpDir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.caws', 'schemas'), { recursive: true });

  // Copy schema from templates
  const templateSchemaDir = path.join(__dirname, '..', '..', 'templates', '.caws', 'schemas');
  if (fs.existsSync(templateSchemaDir)) {
    const schemas = fs.readdirSync(templateSchemaDir);
    for (const schema of schemas) {
      fs.copyFileSync(
        path.join(templateSchemaDir, schema),
        path.join(tmpDir, '.caws', 'schemas', schema)
      );
    }
  }
});

afterEach(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('Working State Integration', () => {
  test('recordValidation persists and loadState reads back correctly', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    recordValidation('INT-001', {
      passed: true,
      compliance_score: 0.85,
      grade: 'B',
      error_count: 0,
      warning_count: 2,
    }, tmpDir);

    const state = loadState('INT-001', tmpDir);
    expect(state).not.toBeNull();
    expect(state.validation).not.toBeNull();
    expect(state.validation.passed).toBe(true);
    expect(state.validation.grade).toBe('B');
    expect(state.phase).toBe('implementation');
    expect(state.history.some(h => h.command === 'validate')).toBe(true);
  });

  test('recordEvaluation persists evaluation result', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    recordEvaluation('INT-001', {
      score: 75,
      max_score: 100,
      percentage: 75,
      grade: 'C',
      checks_passed: 6,
      checks_total: 9,
    }, tmpDir);

    const state = loadState('INT-001', tmpDir);
    expect(state).not.toBeNull();
    expect(state.evaluation).not.toBeNull();
    expect(state.evaluation.score).toBe(75);
    expect(state.evaluation.percentage).toBe(75);
    expect(state.evaluation.grade).toBe('C');
    expect(state.history.some(h => h.command === 'evaluate')).toBe(true);
  });

  test('recordGates persists gate results', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    recordGates('INT-001', {
      passed: false,
      summary: { blocked: 1, warned: 0, passed: 3, skipped: 0, waived: 0 },
      gates: [
        { name: 'scope-boundary', status: 'fail', mode: 'block', messages: ['out of scope'], duration: 5 },
        { name: 'god-object', status: 'pass', mode: 'block', messages: [], duration: 10 },
        { name: 'todo-detection', status: 'pass', mode: 'warn', messages: [], duration: 2 },
      ],
    }, 'commit', tmpDir);

    const state = loadState('INT-001', tmpDir);
    expect(state).not.toBeNull();
    expect(state.gates).not.toBeNull();
    expect(state.gates.passed).toBe(false);
    expect(state.gates.context).toBe('commit');
    expect(state.gates.results.length).toBe(3);
    // Should have a blocker for the failing gate
    expect(state.blockers.some(b => b.gate === 'scope-boundary')).toBe(true);
    expect(state.history.some(h => h.command === 'gates')).toBe(true);
  });

  test('recordACVerification persists AC results', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    recordACVerification('INT-001', {
      total: 5,
      pass: 3,
      fail: 1,
      unchecked: 1,
      results: [
        { id: 'A1', status: 'PASS' },
        { id: 'A2', status: 'PASS' },
        { id: 'A3', status: 'PASS' },
        { id: 'A4', status: 'FAIL' },
        { id: 'A5', status: 'UNCHECKED' },
      ],
    }, tmpDir);

    const state = loadState('INT-001', tmpDir);
    expect(state).not.toBeNull();
    expect(state.acceptance_criteria.total).toBe(5);
    expect(state.acceptance_criteria.pass).toBe(3);
    expect(state.blockers.some(b => b.type === 'ac_failure')).toBe(true);
    expect(state.history.some(h => h.command === 'verify-acs')).toBe(true);
  });

  test('multiple commands accumulate in same state file', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    recordValidation('INT-001', {
      passed: true, compliance_score: 0.9, grade: 'A', error_count: 0, warning_count: 0,
    }, tmpDir);

    recordEvaluation('INT-001', {
      score: 90, max_score: 100, percentage: 90, grade: 'A', checks_passed: 9, checks_total: 9,
    }, tmpDir);

    recordGates('INT-001', {
      passed: true,
      summary: { blocked: 0, warned: 0, passed: 5, skipped: 0, waived: 0 },
      gates: [],
    }, 'cli', tmpDir);

    recordACVerification('INT-001', {
      total: 3, pass: 3, fail: 0, unchecked: 0,
      results: [{ id: 'A1', status: 'PASS' }, { id: 'A2', status: 'PASS' }, { id: 'A3', status: 'PASS' }],
    }, tmpDir);

    const state = loadState('INT-001', tmpDir);
    expect(state).not.toBeNull();

    // All sections populated
    expect(state.validation).not.toBeNull();
    expect(state.evaluation).not.toBeNull();
    expect(state.gates).not.toBeNull();
    expect(state.acceptance_criteria).not.toBeNull();

    // History has all 4 commands
    const commands = state.history.map(h => h.command);
    expect(commands).toContain('validate');
    expect(commands).toContain('evaluate');
    expect(commands).toContain('gates');
    expect(commands).toContain('verify-acs');

    // Phase should be complete (all green, eval >= 90%)
    expect(state.phase).toBe('complete');

    // No blockers
    expect(state.blockers).toEqual([]);

    // Next actions should indicate ready for merge
    expect(state.next_actions[0]).toContain('Ready for merge');
  });

  test('state file is valid JSON with expected schema', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);
    recordValidation('INT-001', {
      passed: true, compliance_score: 0.85, grade: 'B', error_count: 0, warning_count: 1,
    }, tmpDir);

    const statePath = path.join(tmpDir, STATE_DIR, 'INT-001.json');
    expect(fs.existsSync(statePath)).toBe(true);

    // Should be valid JSON
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Should have schema version
    expect(parsed.schema).toBe('caws.state.v1');
    expect(parsed.spec_id).toBe('INT-001');
    expect(parsed.updated_at).toBeDefined();

    // All expected top-level keys present
    const expectedKeys = [
      'schema', 'spec_id', 'updated_at', 'phase',
      'files_touched', 'validation', 'evaluation', 'gates',
      'acceptance_criteria', 'blockers', 'next_actions', 'history',
    ];
    for (const key of expectedKeys) {
      expect(parsed).toHaveProperty(key);
    }
  });

  test('phase transitions correctly through full workflow', () => {
    saveState('INT-001', initializeState('INT-001'), tmpDir);

    // Start: not-started
    let state = loadState('INT-001', tmpDir);
    expect(state.phase).toBe('not-started');

    // Validation fails → spec-authoring
    recordValidation('INT-001', { passed: false, error_count: 3, warning_count: 0 }, tmpDir);
    state = loadState('INT-001', tmpDir);
    expect(state.phase).toBe('spec-authoring');

    // Validation passes → implementation
    recordValidation('INT-001', { passed: true, compliance_score: 0.85, grade: 'B', error_count: 0, warning_count: 0 }, tmpDir);
    state = loadState('INT-001', tmpDir);
    expect(state.phase).toBe('implementation');

    // ACs all pass + gates run → verification
    recordACVerification('INT-001', { total: 2, pass: 2, fail: 0, unchecked: 0, results: [] }, tmpDir);
    recordGates('INT-001', { passed: true, summary: { blocked: 0, warned: 0, passed: 3, skipped: 0, waived: 0 }, gates: [] }, 'cli', tmpDir);
    state = loadState('INT-001', tmpDir);
    expect(state.phase).toBe('verification');

    // Evaluation >= 90% → complete
    recordEvaluation('INT-001', { score: 95, max_score: 100, percentage: 95, grade: 'A', checks_passed: 9, checks_total: 9 }, tmpDir);
    state = loadState('INT-001', tmpDir);
    expect(state.phase).toBe('complete');
  });
});
