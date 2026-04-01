/**
 * Quality-Gap Diagnosis Sidecar Tests
 *
 * Tests the gap detection logic that identifies what prevents
 * phase advancement through the CAWS workflow.
 */

const { diagnoseQualityGaps } = require('../../src/sidecars/quality-gaps');

// ============================================================
// Fixtures
// ============================================================

function makeSpec(overrides = {}) {
  return { id: 'test-spec', title: 'Test Spec', ...overrides };
}

function makeState(overrides = {}) {
  return {
    validation: { passed: true, error_count: 0, last_run: '2026-04-01T00:00:00Z' },
    evaluation: { percentage: 95, last_run: '2026-04-01T00:00:00Z' },
    gates: { passed: true, results: [], last_run: '2026-04-01T00:00:00Z' },
    acceptance_criteria: { total: 5, pass: 5, fail: 0, unchecked: 0 },
    ...overrides,
  };
}

// ============================================================
// Null / edge cases
// ============================================================

describe('diagnoseQualityGaps', () => {
  test('null state returns no-state envelope', () => {
    const result = diagnoseQualityGaps(null, makeSpec());
    expect(result.type).toBe('sidecar:gaps');
    expect(result.status).toBe('no-state');
    expect(result.specId).toBe('test-spec');
  });

  test('null state with no spec uses "unknown" specId', () => {
    const result = diagnoseQualityGaps(null, null);
    expect(result.specId).toBe('unknown');
    expect(result.status).toBe('no-state');
  });

  // ============================================================
  // Complete phase — no gaps
  // ============================================================

  test('no gaps when everything passes (phase is complete)', () => {
    const state = makeState();
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.current_phase).toBe('complete');
    expect(result.data.next_phase).toBeNull();
    expect(result.data.gaps).toEqual([]);
    expect(result.data.summary).toContain('No gaps');
  });

  // ============================================================
  // Validation failure
  // ============================================================

  test('validation failure produces blocker gap', () => {
    const state = makeState({
      validation: { passed: false, error_count: 3 },
      evaluation: null,
      gates: null,
      acceptance_criteria: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.current_phase).toBe('spec-authoring');
    expect(result.data.next_phase).toBe('implementation');

    const valGap = result.data.gaps.find(g => g.category === 'validation_failure');
    expect(valGap).toBeDefined();
    expect(valGap.severity).toBe('blocker');
    expect(valGap.message).toContain('3');
    expect(valGap.remediation).toBe('caws validate');
  });

  // ============================================================
  // Low evaluation
  // ============================================================

  test('low evaluation score (<70%) produces blocker gap for spec-authoring -> implementation', () => {
    const state = makeState({
      validation: { passed: true, error_count: 0 },
      evaluation: { percentage: 50 },
      gates: null,
      acceptance_criteria: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    // computePhase returns spec-authoring when evaluation < 70
    expect(result.data.current_phase).toBe('spec-authoring');
    expect(result.data.next_phase).toBe('implementation');

    const evalGap = result.data.gaps.find(g => g.category === 'low_evaluation');
    expect(evalGap).toBeDefined();
    expect(evalGap.severity).toBe('blocker');
    expect(evalGap.message).toContain('50%');
    expect(evalGap.message).toContain('70%');
  });

  // ============================================================
  // Failing ACs
  // ============================================================

  test('failing ACs produce blocker gaps', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 3, fail: 2, unchecked: 0 },
      gates: null,
    });
    // With validation passed, eval >= 70, but ACs failing and no gates -> implementation
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.current_phase).toBe('implementation');
    expect(result.data.next_phase).toBe('verification');

    const acGap = result.data.gaps.find(g => g.category === 'ac_failure');
    expect(acGap).toBeDefined();
    expect(acGap.severity).toBe('blocker');
    expect(acGap.message).toContain('2');
  });

  // ============================================================
  // Unchecked ACs
  // ============================================================

  test('unchecked ACs produce warning gaps', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 3, fail: 0, unchecked: 2 },
      gates: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.current_phase).toBe('implementation');

    const ucGap = result.data.gaps.find(g => g.category === 'ac_unchecked');
    expect(ucGap).toBeDefined();
    expect(ucGap.severity).toBe('warning');
    expect(ucGap.message).toContain('2');
  });

  // ============================================================
  // Missing gates
  // ============================================================

  test('missing gate runs produce warning gaps', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 3, fail: 2, unchecked: 0 },
      gates: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());

    const gateGap = result.data.gaps.find(g => g.category === 'no_gates');
    expect(gateGap).toBeDefined();
    expect(gateGap.severity).toBe('warning');
    expect(gateGap.remediation).toBe('caws gates');
  });

  // ============================================================
  // Phase requirements object
  // ============================================================

  test('phase requirements object is correct', () => {
    const state = makeState({
      evaluation: { percentage: 85 },
      gates: { passed: false, results: [] },
      acceptance_criteria: { total: 5, pass: 5, fail: 0, unchecked: 0 },
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    const reqs = result.data.phase_requirements;

    expect(reqs.validation_passed).toBe(true);
    expect(reqs.evaluation_pct).toBe(85);
    expect(reqs.all_acs_pass).toBe(true);
    expect(reqs.gates_run).toBe(true);
    expect(reqs.gates_passed).toBe(false);
  });

  // ============================================================
  // Summary string
  // ============================================================

  test('summary string reflects gap count and target phase', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 3, fail: 2, unchecked: 0 },
      gates: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.summary).toMatch(/2 gaps/);
    expect(result.data.summary).toContain('verification');
  });

  // ============================================================
  // Implementation phase next_phase
  // ============================================================

  test('implementation phase shows correct next_phase (verification)', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 3, fail: 2, unchecked: 0 },
      gates: { passed: false, results: [] },
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    expect(result.data.current_phase).toBe('implementation');
    expect(result.data.next_phase).toBe('verification');
  });

  // ============================================================
  // Multiple gaps sorted by severity
  // ============================================================

  test('multiple simultaneous gaps sorted by severity (blockers first)', () => {
    const state = makeState({
      acceptance_criteria: { total: 5, pass: 2, fail: 1, unchecked: 2 },
      gates: null,
    });
    const result = diagnoseQualityGaps(state, makeSpec());
    const gaps = result.data.gaps;

    expect(gaps.length).toBeGreaterThan(1);
    // First gap should be a blocker, last should be a warning
    const blockerIdx = gaps.findIndex(g => g.severity === 'blocker');
    const warningIdx = gaps.findIndex(g => g.severity === 'warning');
    expect(blockerIdx).toBeLessThan(warningIdx);
  });
});
