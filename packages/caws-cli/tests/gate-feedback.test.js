/**
 * Gate Feedback Enrichment Tests
 *
 * Tests the enrichment logic that transforms raw gate results
 * into contextual feedback with why/category/recurrence/nextStep/remediation.
 */

const {
  enrichGateResults,
  getRecurrence,
  formatTimeSince,
  GATE_CATEGORIES,
} = require('../src/gates/feedback');

// ============================================================
// Category mapping
// ============================================================

describe('GATE_CATEGORIES', () => {
  test('maps known gates to categories', () => {
    expect(GATE_CATEGORIES.scope_boundary).toBe('scope');
    expect(GATE_CATEGORIES.budget_limit).toBe('policy');
    expect(GATE_CATEGORIES.god_object).toBe('architectural');
    expect(GATE_CATEGORIES.todo_detection).toBe('quality');
    expect(GATE_CATEGORIES.spec_completeness).toBe('quality');
  });
});

// ============================================================
// Recurrence detection
// ============================================================

describe('getRecurrence', () => {
  test('returns null when no state', () => {
    expect(getRecurrence('scope_boundary', null)).toBeNull();
  });

  test('returns null when no history', () => {
    expect(getRecurrence('scope_boundary', { history: [] })).toBeNull();
  });

  test('returns null with only one gate run', () => {
    const state = {
      history: [{ command: 'gates', summary: '0 passed, 1 blocked', timestamp: '2026-04-01T00:00:00Z' }],
    };
    expect(getRecurrence('scope_boundary', state)).toBeNull();
  });

  test('detects consecutive blocked runs', () => {
    const state = {
      history: [
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:05:00Z' },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:10:00Z' },
      ],
    };
    const result = getRecurrence('scope_boundary', state);
    expect(result).not.toBeNull();
    expect(result.count).toBe(2); // 2 previous blocked runs (excludes current)
  });

  test('stops counting at first non-blocked run', () => {
    const state = {
      history: [
        { command: 'gates', summary: '5 passed, 0 blocked', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:05:00Z' },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:10:00Z' },
      ],
    };
    const result = getRecurrence('scope_boundary', state);
    expect(result).not.toBeNull();
    expect(result.count).toBe(1); // Only the middle run, stopped at first non-blocked
  });

  test('skips non-gate history entries', () => {
    const state = {
      history: [
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:00:00Z' },
        { command: 'validate', summary: 'Passed', timestamp: '2026-04-01T00:02:00Z' },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: '2026-04-01T00:05:00Z' },
      ],
    };
    const result = getRecurrence('scope_boundary', state);
    expect(result).not.toBeNull();
    expect(result.count).toBe(1);
  });
});

describe('formatTimeSince', () => {
  test('returns "just now" for recent timestamps', () => {
    const now = new Date().toISOString();
    expect(formatTimeSince(now)).toBe('just now');
  });

  test('returns "unknown" for null', () => {
    expect(formatTimeSince(null)).toBe('unknown');
  });

  test('returns "unknown" for invalid date', () => {
    expect(formatTimeSince('not-a-date')).toBe('unknown');
  });

  test('formats minutes', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60000).toISOString();
    expect(formatTimeSince(fiveMinAgo)).toBe('5 min ago');
  });

  test('formats hours', () => {
    const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
    expect(formatTimeSince(twoHoursAgo)).toBe('2h ago');
  });
});

// ============================================================
// enrichGateResults
// ============================================================

describe('enrichGateResults', () => {
  test('returns empty map when all gates pass', () => {
    const report = {
      passed: true,
      gates: [
        { name: 'scope_boundary', status: 'pass', mode: 'block', messages: [], duration: 5 },
      ],
      summary: { blocked: 0, warned: 0, passed: 1, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});
    expect(enrichments.size).toBe(0);
  });

  test('enriches scope_boundary failure', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'scope_boundary', status: 'fail', mode: 'block', waived: false, duration: 5,
          messages: [
            '1 file(s) outside spec scope boundaries',
            'Out of scope (not in allowed paths): src/payments/api.js',
          ],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const spec = { scope: { in: ['src/auth/**'], out: [] } };
    const enrichments = enrichGateResults(report, { spec });

    expect(enrichments.has('scope_boundary')).toBe(true);
    const e = enrichments.get('scope_boundary');
    expect(e.category).toBe('scope');
    expect(e.why).toContain('src/payments/api.js');
    expect(e.why).toContain('src/auth/**');
    expect(e.nextStep).toBeTruthy();
    expect(e.remediation).toContain('waivers create');
  });

  test('enriches god_object failure', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'god_object', status: 'fail', mode: 'block', waived: false, duration: 10,
          messages: ['CRITICAL: src/big-file.js has 2500 lines (threshold: 2000)'],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});

    const e = enrichments.get('god_object');
    expect(e.category).toBe('architectural');
    expect(e.why).toContain('2500 lines');
    expect(e.nextStep).toContain('Extract helper modules');
  });

  test('enriches todo_detection warning', () => {
    const report = {
      passed: true,
      gates: [
        {
          name: 'todo_detection', status: 'warn', mode: 'warn', waived: false, duration: 3,
          messages: ['src/app.js:42: TODO found', 'src/util.js:10: FIXME found'],
        },
      ],
      summary: { blocked: 0, warned: 1, passed: 0, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});

    const e = enrichments.get('todo_detection');
    expect(e.category).toBe('quality');
    expect(e.why).toContain('2 TODO/FIXME marker(s)');
  });

  test('enriches budget_limit failure', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'budget_limit', status: 'fail', mode: 'block', waived: false, duration: 8,
          messages: ['Files changed (15) exceeds budget limit (10)'],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});

    const e = enrichments.get('budget_limit');
    expect(e.category).toBe('policy');
    expect(e.nextStep).toContain('Split');
  });

  test('enriches spec_completeness failure', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'spec_completeness', status: 'fail', mode: 'block', waived: false, duration: 2,
          messages: ['No working-spec.yaml found. Create one with: caws init or caws specs create <id>'],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});

    const e = enrichments.get('spec_completeness');
    expect(e.category).toBe('quality');
    expect(e.nextStep).toContain('caws validate');
    expect(e.remediation).toBeNull();
  });

  test('handles unknown gate with generic enrichment', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'custom_gate', status: 'fail', mode: 'block', waived: false, duration: 1,
          messages: ['Something went wrong'],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const enrichments = enrichGateResults(report, {});

    expect(enrichments.has('custom_gate')).toBe(true);
    const e = enrichments.get('custom_gate');
    expect(e.category).toBe('quality'); // fallback
    expect(e.why).toContain('Something went wrong');
  });

  test('skips waived gates', () => {
    const report = {
      passed: true,
      gates: [
        {
          name: 'scope_boundary', status: 'pass', mode: 'block', waived: true, duration: 0,
          messages: ['Waived: emergency fix'],
        },
      ],
      summary: { blocked: 0, warned: 0, passed: 1, skipped: 0, waived: 1 },
    };
    const enrichments = enrichGateResults(report, {});
    expect(enrichments.size).toBe(0);
  });

  test('includes recurrence from state history', () => {
    const report = {
      passed: false,
      gates: [
        {
          name: 'scope_boundary', status: 'fail', mode: 'block', waived: false, duration: 5,
          messages: ['Out of scope (not in allowed paths): src/x.js'],
        },
      ],
      summary: { blocked: 1, warned: 0, passed: 0, skipped: 0, waived: 0 },
    };
    const state = {
      history: [
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: new Date(Date.now() - 300000).toISOString() },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: new Date(Date.now() - 120000).toISOString() },
        { command: 'gates', summary: '3 passed, 1 blocked', timestamp: new Date().toISOString() },
      ],
    };
    const enrichments = enrichGateResults(report, { spec: { scope: { in: ['src/y/'] } }, state });
    const e = enrichments.get('scope_boundary');
    expect(e.recurrence).not.toBeNull();
    expect(e.recurrence.count).toBe(2);
  });

  test('gracefully handles null state', () => {
    const report = {
      passed: false,
      gates: [
        { name: 'scope_boundary', status: 'fail', mode: 'block', waived: false, duration: 5, messages: ['Out of scope (not in allowed paths): x.js'] },
      ],
      summary: { blocked: 1 },
    };
    const enrichments = enrichGateResults(report, { spec: null, state: null });
    expect(enrichments.has('scope_boundary')).toBe(true);
    expect(enrichments.get('scope_boundary').recurrence).toBeNull();
  });
});
