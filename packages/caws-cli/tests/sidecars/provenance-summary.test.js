/**
 * Provenance Summary Sidecar Tests
 *
 * Tests the summarization logic that condenses working state into
 * a compact provenance report for merge readiness or handoff.
 */

const { summarizeProvenance } = require('../../src/sidecars/provenance-summary');

// ============================================================
// Null / empty state
// ============================================================

describe('summarizeProvenance', () => {
  test('null state returns no-state output', () => {
    const result = summarizeProvenance(null, { id: 'FEAT-001' });
    expect(result.type).toBe('sidecar:provenance');
    expect(result.specId).toBe('FEAT-001');
    expect(result.status).toBe('no-state');
    expect(result.data.message).toContain('No working state');
  });

  test('null state with null spec uses "unknown" specId', () => {
    const result = summarizeProvenance(null, null);
    expect(result.specId).toBe('unknown');
    expect(result.status).toBe('no-state');
  });

  test('empty state produces zeroed output', () => {
    const result = summarizeProvenance({}, { id: 'FEAT-002', title: 'Empty' });
    expect(result.status).toBe('ok');
    expect(result.data.files_touched.total).toBe(0);
    expect(result.data.files_touched.by_directory).toEqual({});
    expect(result.data.command_history).toEqual({});
    expect(result.data.progression.validation).toEqual([]);
    expect(result.data.progression.evaluation).toEqual([]);
    expect(result.data.progression.gates).toEqual([]);
    expect(result.data.current_status).toEqual({});
    expect(result.data.phase).toBe('unknown');
  });

  // ============================================================
  // Files touched — directory grouping
  // ============================================================

  test('files categorized by top-level directory', () => {
    const state = {
      files_touched: [
        'src/auth/login.js',
        'src/auth/logout.js',
        'src/index.js',
        'test/foo.js',
        'test/bar.js',
        'README.md',
        'CHANGELOG.md',
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-003' });
    const byDir = result.data.files_touched.by_directory;
    expect(result.data.files_touched.total).toBe(7);
    expect(byDir['src/']).toBe(3);
    expect(byDir['test/']).toBe(2);
    expect(byDir['./']).toBe(2);
  });

  // ============================================================
  // Command history grouping
  // ============================================================

  test('command history groups entries by command name', () => {
    const state = {
      history: [
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T00:01:00Z' },
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T00:02:00Z' },
        { command: 'evaluate', summary: '80/100 (80%) Grade B', timestamp: '2026-04-01T00:03:00Z' },
        { command: 'gates', summary: '5 passed, 0 blocked', timestamp: '2026-04-01T00:04:00Z' },
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-004' });
    expect(result.data.command_history).toEqual({ validate: 3, evaluate: 1, gates: 1 });
  });

  // ============================================================
  // Progression parsing
  // ============================================================

  test('evaluation progression parsed from summary strings', () => {
    const state = {
      history: [
        { command: 'evaluate', summary: '70/100 (70%) Grade C', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'evaluate', summary: '85/100 (85%) Grade B', timestamp: '2026-04-01T01:00:00Z' },
        { command: 'evaluate', summary: '95/100 (95%) Grade A', timestamp: '2026-04-01T02:00:00Z' },
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-005' });
    const evalProg = result.data.progression.evaluation;
    expect(evalProg).toHaveLength(3);
    expect(evalProg[0]).toEqual({ timestamp: '2026-04-01T00:00:00Z', percentage: 70, grade: 'C' });
    expect(evalProg[1]).toEqual({ timestamp: '2026-04-01T01:00:00Z', percentage: 85, grade: 'B' });
    expect(evalProg[2]).toEqual({ timestamp: '2026-04-01T02:00:00Z', percentage: 95, grade: 'A' });
  });

  test('validation progression parsed from summary strings', () => {
    const state = {
      history: [
        { command: 'validate', summary: 'failed with 3 errors', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T01:00:00Z' },
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-006' });
    const valProg = result.data.progression.validation;
    expect(valProg).toHaveLength(2);
    expect(valProg[0]).toEqual({ timestamp: '2026-04-01T00:00:00Z', passed: false });
    expect(valProg[1]).toEqual({ timestamp: '2026-04-01T01:00:00Z', passed: true });
  });

  test('gates progression parsed from summary strings', () => {
    const state = {
      history: [
        { command: 'gates', summary: '3 passed, 2 blocked', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'gates', summary: '5 passed, 0 blocked', timestamp: '2026-04-01T01:00:00Z' },
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-007' });
    const gatesProg = result.data.progression.gates;
    expect(gatesProg).toHaveLength(2);
    expect(gatesProg[0]).toEqual({ timestamp: '2026-04-01T00:00:00Z', blocked: 2 });
    expect(gatesProg[1]).toEqual({ timestamp: '2026-04-01T01:00:00Z', blocked: 0 });
  });

  test('unparseable summary strings are skipped gracefully', () => {
    const state = {
      history: [
        { command: 'evaluate', summary: 'something weird', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'validate', summary: '', timestamp: '2026-04-01T00:01:00Z' },
        { command: 'gates', summary: 'no match here', timestamp: '2026-04-01T00:02:00Z' },
        { command: 'evaluate', summary: null, timestamp: '2026-04-01T00:03:00Z' },
      ],
    };
    const result = summarizeProvenance(state, { id: 'FEAT-008' });
    expect(result.data.progression.evaluation).toEqual([]);
    expect(result.data.progression.validation).toEqual([]);
    expect(result.data.progression.gates).toEqual([]);
    // Counts still present even though parse failed
    expect(result.data.command_history.evaluate).toBe(2);
    expect(result.data.command_history.validate).toBe(1);
    expect(result.data.command_history.gates).toBe(1);
  });

  // ============================================================
  // Current status snapshot
  // ============================================================

  test('current status populated from state fields', () => {
    const state = {
      validation: { passed: true, grade: 'A', compliance_score: 100 },
      evaluation: { percentage: 92, grade: 'A' },
      gates: { passed: true, blocked_count: 0 },
      acceptance_criteria: { total: 5, pass: 5, fail: 0, unchecked: 0 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-009' });
    const cs = result.data.current_status;
    expect(cs.validation).toEqual({ passed: true, grade: 'A', compliance_score: 100 });
    expect(cs.evaluation).toEqual({ percentage: 92, grade: 'A' });
    expect(cs.gates).toEqual({ passed: true, blocked_count: 0 });
    expect(cs.acceptance_criteria).toEqual({ total: 5, pass: 5, fail: 0, unchecked: 0 });
  });

  test('current status omits sections not present in state', () => {
    const state = { validation: { passed: false, grade: 'F' } };
    const result = summarizeProvenance(state, { id: 'FEAT-010' });
    expect(result.data.current_status.validation).toBeDefined();
    expect(result.data.current_status.evaluation).toBeUndefined();
    expect(result.data.current_status.gates).toBeUndefined();
    expect(result.data.current_status.acceptance_criteria).toBeUndefined();
  });

  // ============================================================
  // Merge readiness
  // ============================================================

  test('merge readiness: ready=true when phase is complete and all checks pass', () => {
    const state = {
      phase: 'complete',
      validation: { passed: true },
      evaluation: { percentage: 95 },
      gates: { passed: true },
      acceptance_criteria: { total: 3, pass: 3, fail: 0, unchecked: 0 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-011' });
    expect(result.data.merge_readiness.ready).toBe(true);
    expect(result.data.merge_readiness.missing).toEqual([]);
  });

  test('merge readiness: not ready when phase is not complete', () => {
    const state = {
      phase: 'implementation',
      validation: { passed: true },
      evaluation: { percentage: 95 },
      gates: { passed: true },
      acceptance_criteria: { total: 3, pass: 3, fail: 0, unchecked: 0 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-012' });
    // All checks pass but phase != complete, so missing is empty but ready is false
    expect(result.data.merge_readiness.ready).toBe(false);
    expect(result.data.merge_readiness.missing).toEqual([]);
  });

  test('merge readiness: missing lists specific gaps', () => {
    const state = {
      phase: 'implementation',
      validation: { passed: false },
      evaluation: { percentage: 72 },
      gates: { passed: false },
      acceptance_criteria: { total: 5, pass: 2, fail: 1, unchecked: 2 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-013' });
    const missing = result.data.merge_readiness.missing;
    expect(missing).toContain('Validation not passing');
    expect(missing).toContain('Evaluation at 72% (need 90%)');
    expect(missing).toContain('1 ACs failing');
    expect(missing).toContain('2 ACs unchecked');
    expect(missing).toContain('Gates not passing');
    expect(result.data.merge_readiness.ready).toBe(false);
  });

  test('merge readiness: missing "No AC verification run" when no AC data', () => {
    const state = {
      phase: 'implementation',
      validation: { passed: true },
      evaluation: { percentage: 95 },
      gates: { passed: true },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-014' });
    expect(result.data.merge_readiness.missing).toContain('No AC verification run');
  });

  test('merge readiness: missing "No evaluation run" when no eval data', () => {
    const state = {
      phase: 'implementation',
      validation: { passed: true },
      gates: { passed: true },
      acceptance_criteria: { total: 3, pass: 3, fail: 0, unchecked: 0 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-015' });
    expect(result.data.merge_readiness.missing).toContain('No evaluation run');
  });

  // ============================================================
  // Summary string
  // ============================================================

  test('summary string includes file count, command count, and eval percentage', () => {
    const state = {
      files_touched: ['a.js', 'b.js', 'c.js'],
      history: [
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'evaluate', summary: '88/100 (88%) Grade B', timestamp: '2026-04-01T00:01:00Z' },
      ],
      evaluation: { percentage: 88 },
      validation: { passed: true },
      gates: { passed: true },
      acceptance_criteria: { total: 2, pass: 2, fail: 0, unchecked: 0 },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-016' });
    expect(result.data.summary).toContain('3 files touched');
    expect(result.data.summary).toContain('2 commands run');
    expect(result.data.summary).toContain('evaluation at 88%');
  });

  test('summary string includes first missing item when not ready', () => {
    const state = {
      files_touched: ['x.js'],
      history: [],
      validation: { passed: false },
    };
    const result = summarizeProvenance(state, { id: 'FEAT-017' });
    expect(result.data.summary).toContain('validation not passing');
  });

  // ============================================================
  // Full comprehensive state
  // ============================================================

  test('full state with all fields produces comprehensive output', () => {
    const state = {
      spec_id: 'FEAT-100',
      phase: 'complete',
      files_touched: [
        'src/auth/login.js',
        'src/auth/logout.js',
        'src/auth/token.js',
        'src/index.js',
        'tests/auth.test.js',
        'tests/token.test.js',
        'docs/auth.md',
        'package.json',
      ],
      history: [
        { command: 'validate', summary: 'failed with 2 errors', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'validate', summary: 'passed', timestamp: '2026-04-01T00:10:00Z' },
        { command: 'evaluate', summary: '70/100 (70%) Grade C', timestamp: '2026-04-01T00:20:00Z' },
        { command: 'gates', summary: '4 passed, 1 blocked', timestamp: '2026-04-01T00:30:00Z' },
        { command: 'gates', summary: '5 passed, 0 blocked', timestamp: '2026-04-01T00:40:00Z' },
        { command: 'evaluate', summary: '92/100 (92%) Grade A', timestamp: '2026-04-01T00:50:00Z' },
      ],
      validation: { passed: true, grade: 'A', compliance_score: 98 },
      evaluation: { percentage: 92, grade: 'A' },
      gates: { passed: true, blocked_count: 0 },
      acceptance_criteria: { total: 5, pass: 5, fail: 0, unchecked: 0 },
    };
    const spec = { id: 'FEAT-100', title: 'Auth Feature' };
    const result = summarizeProvenance(state, spec);

    // Envelope
    expect(result.type).toBe('sidecar:provenance');
    expect(result.specId).toBe('FEAT-100');
    expect(result.status).toBe('ok');

    // Data
    const d = result.data;
    expect(d.spec_id).toBe('FEAT-100');
    expect(d.spec_title).toBe('Auth Feature');
    expect(d.phase).toBe('complete');

    // Files
    expect(d.files_touched.total).toBe(8);
    expect(d.files_touched.by_directory['src/']).toBe(4);
    expect(d.files_touched.by_directory['tests/']).toBe(2);
    expect(d.files_touched.by_directory['docs/']).toBe(1);
    expect(d.files_touched.by_directory['./']).toBe(1);

    // Command counts
    expect(d.command_history.validate).toBe(2);
    expect(d.command_history.evaluate).toBe(2);
    expect(d.command_history.gates).toBe(2);

    // Progression
    expect(d.progression.validation).toHaveLength(2);
    expect(d.progression.validation[0].passed).toBe(false);
    expect(d.progression.validation[1].passed).toBe(true);
    expect(d.progression.evaluation).toHaveLength(2);
    expect(d.progression.evaluation[0].percentage).toBe(70);
    expect(d.progression.evaluation[1].percentage).toBe(92);
    expect(d.progression.gates).toHaveLength(2);
    expect(d.progression.gates[0].blocked).toBe(1);
    expect(d.progression.gates[1].blocked).toBe(0);

    // Current status
    expect(d.current_status.validation.passed).toBe(true);
    expect(d.current_status.evaluation.percentage).toBe(92);
    expect(d.current_status.gates.passed).toBe(true);
    expect(d.current_status.acceptance_criteria.total).toBe(5);

    // Merge readiness
    expect(d.merge_readiness.ready).toBe(true);
    expect(d.merge_readiness.missing).toEqual([]);

    // Summary
    expect(d.summary).toContain('8 files touched');
    expect(d.summary).toContain('6 commands run');
    expect(d.summary).toContain('evaluation at 92%');
  });
});
