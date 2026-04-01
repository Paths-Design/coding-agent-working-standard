/**
 * Spec Drift Analysis Sidecar Tests
 *
 * Tests drift detection by comparing implementation evidence against spec scope
 * and acceptance criteria. Uses inline fixtures following the gate-feedback test pattern.
 */

const { analyzeSpecDrift } = require('../../src/sidecars/spec-drift');

// ============================================================
// Fixtures
// ============================================================

function makeSpec(overrides = {}) {
  return {
    id: 'SPEC-TEST',
    scope: { in: ['src/**'], out: ['src/vendor/**'] },
    acceptance: [
      { id: 'AC-1', description: 'Core feature works' },
      { id: 'AC-2', description: 'Edge cases handled' },
      { id: 'AC-3', description: 'Tests pass' },
    ],
    ...overrides,
  };
}

function makeState(overrides = {}) {
  return {
    files_touched: ['src/app.js', 'src/utils.js'],
    acceptance_criteria: {
      results: [
        { id: 'AC-1', status: 'PASS', description: 'Core feature works', files: ['src/app.js'] },
        { id: 'AC-2', status: 'PASS', description: 'Edge cases handled', files: ['src/utils.js'] },
        { id: 'AC-3', status: 'PASS', description: 'Tests pass' },
      ],
    },
    history: [],
    ...overrides,
  };
}

// ============================================================
// Null state
// ============================================================

describe('analyzeSpecDrift', () => {
  test('null state returns no-state output', () => {
    const spec = makeSpec();
    const result = analyzeSpecDrift(null, spec);

    expect(result.type).toBe('sidecar:drift');
    expect(result.specId).toBe('SPEC-TEST');
    expect(result.status).toBe('no-state');
    expect(result.data.message).toMatch(/no working state/i);
  });

  // ============================================================
  // No drift (clean state)
  // ============================================================

  test('no drift when all files in scope and all ACs pass', () => {
    const spec = makeSpec();
    const state = makeState();
    const result = analyzeSpecDrift(state, spec);

    expect(result.status).toBe('ok');
    expect(result.data.drift_detected).toBe(false);
    expect(result.data.out_of_scope_files).toEqual([]);
    expect(result.data.failing_criteria).toEqual([]);
    expect(result.data.missing_evidence).toEqual([]);
    expect(result.data.summary).toContain('No drift');
  });

  test('drift_detected is false when everything is clean', () => {
    const spec = makeSpec();
    const state = makeState();
    const result = analyzeSpecDrift(state, spec);
    expect(result.data.drift_detected).toBe(false);
  });

  // ============================================================
  // Out-of-scope detection
  // ============================================================

  test('detects files outside scope.in', () => {
    const spec = makeSpec();
    const state = makeState({
      files_touched: ['src/app.js', 'docs/readme.md'],
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.drift_detected).toBe(true);
    expect(result.data.out_of_scope_files).toContain('docs/readme.md');
    expect(result.data.out_of_scope_files).not.toContain('src/app.js');
  });

  test('detects files matching scope.out', () => {
    const spec = makeSpec();
    const state = makeState({
      files_touched: ['src/app.js', 'src/vendor/lib.js'],
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.drift_detected).toBe(true);
    expect(result.data.out_of_scope_files).toContain('src/vendor/lib.js');
    expect(result.data.out_of_scope_files).not.toContain('src/app.js');
  });

  // ============================================================
  // AC evidence detection
  // ============================================================

  test('detects ACs with no evidence (unchecked)', () => {
    const spec = makeSpec();
    const state = makeState({
      acceptance_criteria: {
        results: [
          { id: 'AC-1', status: 'PASS', description: 'Core feature works' },
          { id: 'AC-2', status: 'UNCHECKED', description: 'Edge cases handled' },
          // AC-3 missing entirely
        ],
      },
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.drift_detected).toBe(true);
    expect(result.data.missing_evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'AC-2' }),
        expect.objectContaining({ id: 'AC-3' }),
      ]),
    );
    expect(result.data.missing_evidence).toHaveLength(2);
  });

  test('detects failing ACs', () => {
    const spec = makeSpec();
    const state = makeState({
      acceptance_criteria: {
        results: [
          { id: 'AC-1', status: 'FAIL', description: 'Core feature works' },
          { id: 'AC-2', status: 'PASS', description: 'Edge cases handled' },
          { id: 'AC-3', status: 'PASS', description: 'Tests pass' },
        ],
      },
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.drift_detected).toBe(true);
    expect(result.data.failing_criteria).toEqual([
      expect.objectContaining({ id: 'AC-1', description: 'Core feature works' }),
    ]);
  });

  // ============================================================
  // Gate corroboration
  // ============================================================

  test('gate corroboration from history', () => {
    const spec = makeSpec();
    const state = makeState({
      history: [
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: new Date(Date.now() - 600000).toISOString() },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: new Date(Date.now() - 300000).toISOString() },
        { command: 'gates', summary: '4 passed, 0 blocked', timestamp: new Date().toISOString() },
      ],
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.gate_corroboration.scope_failures).toBe(2);
    expect(result.data.gate_corroboration.last_failure).toBeTruthy();
  });

  test('gate corroboration is zero when no blocked runs', () => {
    const spec = makeSpec();
    const state = makeState({
      history: [
        { command: 'gates', summary: '4 passed, 0 blocked', timestamp: new Date().toISOString() },
      ],
    });
    const result = analyzeSpecDrift(state, spec);
    expect(result.data.gate_corroboration.scope_failures).toBe(0);
  });

  // ============================================================
  // Summary
  // ============================================================

  test('summary string reflects findings', () => {
    const spec = makeSpec();
    const state = makeState({
      files_touched: ['src/app.js', 'docs/readme.md'],
      acceptance_criteria: {
        results: [
          { id: 'AC-1', status: 'FAIL', description: 'Core feature works' },
          { id: 'AC-2', status: 'PASS', description: 'Edge cases handled' },
          // AC-3 missing
        ],
      },
    });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.summary).toContain('outside scope');
    expect(result.data.summary).toContain('AC failing');
    expect(result.data.summary).toContain('AC unchecked');
  });

  // ============================================================
  // Edge cases
  // ============================================================

  test('handles spec with no scope patterns gracefully', () => {
    const spec = makeSpec({ scope: { in: [], out: [] } });
    const state = makeState({
      files_touched: ['anywhere/file.js'],
    });
    const result = analyzeSpecDrift(state, spec);

    // Empty scope.in means everything is allowed
    expect(result.data.out_of_scope_files).toEqual([]);
  });

  test('handles spec with no acceptance criteria', () => {
    const spec = makeSpec({ acceptance: [] });
    const state = makeState();
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.missing_evidence).toEqual([]);
    expect(result.data.failing_criteria).toEqual([]);
  });

  test('handles state with no files_touched', () => {
    const spec = makeSpec();
    const state = makeState({ files_touched: [] });
    const result = analyzeSpecDrift(state, spec);

    expect(result.data.out_of_scope_files).toEqual([]);
    expect(result.data.scope_creep_files).toEqual([]);
  });
});
