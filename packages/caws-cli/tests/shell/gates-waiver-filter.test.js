'use strict';

/**
 * Unit tests for waiver filtering (A3) + the kernel waiver-applicability it
 * rests on (backfills slice-1 A5: waiver/validate + applicability).
 *
 * CAWS-TEST-CLI-SHELL-001. Governed-path doctrine: waivers FILTER violations;
 * they do NOT change gate mode. filterWaivedViolations suppresses only
 * violations covered by an EFFECTIVE waiver (active && not expired && gate
 * matches && spec matches); expired/revoked/non-matching waivers do not
 * suppress. Tests assert the surviving violation set + the per-gate evidence,
 * so a mutation that suppresses an expired waiver's gate is killed.
 *
 * Both SUTs loaded from dist/ (shell filter) and src-compiled-into-dist
 * (kernel applicability via the package export).
 */

const { filterWaivedViolations } = require('../../dist/shell/gates/waiver-filter');
const {
  effectiveWaiversForGate,
  waiverEffectiveness,
} = require('@paths.design/caws-kernel');

const NOW = new Date('2026-06-13T12:00:00.000Z');
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function waiver(over = {}) {
  return {
    id: 'W-1',
    title: 'a waiver',
    status: 'active',
    gates: ['budget_limit'],
    reason: 'because',
    approved_by: 'reviewer',
    created_at: '2026-01-01T00:00:00.000Z',
    expires_at: FUTURE,
    ...over,
  };
}

function report(violations) {
  return {
    timestamp: '2026-06-13T12:00:00.000Z',
    context: 'test',
    files_scoped: 1,
    warnings: [],
    violations,
  };
}
const v = (g) => ({ gate: g, message: `${g} violated` });

// ---------------------------------------------------------------------------
// kernel waiver applicability (slice-1 A5 backfill)
// ---------------------------------------------------------------------------

describe('kernel waiverEffectiveness: active / expired / revoked', () => {
  test('active + future expiry -> active', () => {
    expect(waiverEffectiveness(waiver(), NOW)).toBe('active');
  });

  test('status revoked -> revoked (regardless of expiry)', () => {
    expect(waiverEffectiveness(waiver({ status: 'revoked' }), NOW)).toBe('revoked');
  });

  test('expires_at in the past -> expired (derived; stored status stays active)', () => {
    expect(waiverEffectiveness(waiver({ expires_at: PAST }), NOW)).toBe('expired');
  });

  test('expires_at EXACTLY at now -> expired (boundary: <= now)', () => {
    expect(waiverEffectiveness(waiver({ expires_at: NOW.toISOString() }), NOW)).toBe('expired');
  });

  test('unparseable expires_at -> expired (not silently active)', () => {
    expect(waiverEffectiveness(waiver({ expires_at: 'garbage' }), NOW)).toBe('expired');
  });
});

describe('kernel effectiveWaiversForGate: gate + spec scoping', () => {
  test('returns a waiver whose gates include the gate', () => {
    const out = effectiveWaiversForGate({ waivers: [waiver()], gate: 'budget_limit', now: NOW });
    expect(out.map((w) => w.id)).toEqual(['W-1']);
  });

  test('a waiver NOT covering the gate is excluded', () => {
    const out = effectiveWaiversForGate({
      waivers: [waiver({ gates: ['scope_boundary'] })],
      gate: 'budget_limit',
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  test('an expired waiver is excluded even if it covers the gate', () => {
    const out = effectiveWaiversForGate({
      waivers: [waiver({ expires_at: PAST })],
      gate: 'budget_limit',
      now: NOW,
    });
    expect(out).toEqual([]);
  });

  test('a spec-scoped waiver applies only to the matching spec id', () => {
    const scoped = waiver({ scope: { spec_id: 'SPEC-1' } });
    expect(
      effectiveWaiversForGate({ waivers: [scoped], gate: 'budget_limit', specId: 'SPEC-1', now: NOW })
    ).toHaveLength(1);
    expect(
      effectiveWaiversForGate({ waivers: [scoped], gate: 'budget_limit', specId: 'SPEC-2', now: NOW })
    ).toHaveLength(0);
  });

  test('a project-wide waiver (no scope.spec_id) applies regardless of specId', () => {
    const out = effectiveWaiversForGate({
      waivers: [waiver()],
      gate: 'budget_limit',
      specId: 'ANY-SPEC',
      now: NOW,
    });
    expect(out).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// shell waiver-filter (A3)
// ---------------------------------------------------------------------------

describe('filterWaivedViolations: suppresses only effectively-waived violations', () => {
  test('an effective waiver suppresses its gate violation; evidence records it', () => {
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [waiver()],
      specId: 'SPEC-1',
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(0);
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(1);
    expect(result.waivedByGate['budget_limit'].waiver_ids).toEqual(['W-1']);
  });

  test('an EXPIRED waiver does NOT suppress (violation survives)', () => {
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [waiver({ expires_at: PAST })],
      specId: 'SPEC-1',
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(1);
    expect(result.waivedByGate).toEqual({});
  });

  test('a violation on a DIFFERENT gate than the waiver survives', () => {
    const result = filterWaivedViolations({
      report: report([v('scope_boundary')]),
      waivers: [waiver()], // covers budget_limit only
      specId: 'SPEC-1',
      now: NOW,
      policyGateIds: ['budget_limit', 'scope_boundary'],
    });
    expect(result.reportForDisposition.violations.map((x) => x.gate)).toEqual(['scope_boundary']);
  });

  test('a violation on a NON-policy gate passes through unfiltered (waivers do not touch it)', () => {
    const result = filterWaivedViolations({
      report: report([v('not_a_policy_gate')]),
      // even a waiver naming that gate cannot suppress it: policyGateIds scopes filtering.
      waivers: [waiver({ gates: ['not_a_policy_gate'] })],
      specId: 'SPEC-1',
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(1);
  });

  test('waiver-filter passes through report metadata unchanged (only violations are reduced)', () => {
    const original = report([v('budget_limit')]);
    const result = filterWaivedViolations({
      report: original,
      waivers: [waiver()],
      specId: 'SPEC-1',
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.timestamp).toBe(original.timestamp);
    expect(result.reportForDisposition.context).toBe(original.context);
    expect(result.reportForDisposition.files_scoped).toBe(original.files_scoped);
  });
});

// ---------------------------------------------------------------------------
// When policyGateIds is omitted, the policy-set guard is skipped; an effective
// waiver can suppress any gate (including non-policy ones). When policyGateIds
// is provided, only policy gates are suppressible.
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: policyGateIds undefined path', () => {
  test('when policyGateIds is undefined, policy scoping is skipped; waiver still suppresses', () => {
    const result = filterWaivedViolations({
      report: report([v('custom_gate')]),
      waivers: [waiver({ gates: ['custom_gate'] })],
      now: NOW,
      // policyGateIds intentionally omitted
    });
    expect(result.reportForDisposition.violations).toHaveLength(0);
    expect(result.waivedByGate['custom_gate']).toBeDefined();
    expect(result.waivedByGate['custom_gate'].waived_count).toBe(1);
  });

  test('when policyGateIds is provided, non-policy gates bypass waivers', () => {
    const result = filterWaivedViolations({
      report: report([v('custom_gate')]),
      waivers: [waiver({ gates: ['custom_gate'] })],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(1);
    expect(result.reportForDisposition.violations[0].gate).toBe('custom_gate');
    expect(result.waivedByGate).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The policyGateSet.has check distinguishes policy gates (suppressible) from
// non-policy gates (not suppressible even with a matching waiver).
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: policyGateSet.has check', () => {
  test('a violation on a policy gate IS suppressed by an effective waiver', () => {
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [waiver({ gates: ['budget_limit'] })],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(0);
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(1);
  });

  test('a violation on a NON-policy gate is NOT suppressed even with matching waiver', () => {
    const result = filterWaivedViolations({
      report: report([v('non_policy_gate')]),
      waivers: [waiver({ gates: ['non_policy_gate'] })],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(1);
    expect(result.waivedByGate).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The memoization cache ensures consistent waiver lookup across multiple
// violations on the same gate.
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: cache path', () => {
  test('two violations on the same gate are both suppressed by one waiver', () => {
    const v1 = { gate: 'budget_limit', message: 'first' };
    const v2 = { gate: 'budget_limit', message: 'second' };
    const result = filterWaivedViolations({
      report: report([v1, v2]),
      waivers: [waiver()],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(0);
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(2);
    expect(result.waivedByGate['budget_limit'].waiver_ids).toEqual(['W-1']);
  });

  test('with no effective waivers, cache never pollutes subsequent calls', () => {
    // First violation: gate with effective waiver. Second: different gate, no waiver.
    const result = filterWaivedViolations({
      report: report([v('budget_limit'), v('scope_boundary')]),
      waivers: [waiver({ gates: ['budget_limit'] })],
      now: NOW,
      policyGateIds: ['budget_limit', 'scope_boundary'],
    });
    expect(result.reportForDisposition.violations).toHaveLength(1);
    expect(result.reportForDisposition.violations[0].gate).toBe('scope_boundary');
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(1);
    expect(result.waivedByGate['scope_boundary']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The evidence bucket for a gate is created on first use and accumulates
// waiver ids and counts across multiple suppressed violations.
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: evidence bucket', () => {
  test('suppressed violation records the waiver id in waivedByGate', () => {
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [waiver({ id: 'W-99' })],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.waivedByGate['budget_limit']).toBeDefined();
    expect(result.waivedByGate['budget_limit'].waiver_ids).toEqual(['W-99']);
  });

  test('two waivers covering the same gate are both recorded in waiver_ids', () => {
    const w1 = waiver({ id: 'W-A', gates: ['budget_limit'] });
    const w2 = waiver({ id: 'W-B', gates: ['budget_limit'] });
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [w1, w2],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.waivedByGate['budget_limit'].waiver_ids.sort()).toEqual(['W-A', 'W-B']);
  });

  test('first violation creates bucket; second violation on same gate accumulates', () => {
    const v1 = { gate: 'budget_limit', message: 'first' };
    const v2 = { gate: 'budget_limit', message: 'second' };
    const result = filterWaivedViolations({
      report: report([v1, v2]),
      waivers: [waiver({ id: 'W-C' })],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(2);
    // Deduplication: same waiver id credited only once in the Set.
    expect(result.waivedByGate['budget_limit'].waiver_ids).toEqual(['W-C']);
  });
});

// ---------------------------------------------------------------------------
// waiver_ids must be sorted regardless of insertion order.
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: waiver_ids are sorted', () => {
  test('waiver_ids are returned in sorted order regardless of insertion order', () => {
    const w1 = waiver({ id: 'W-Z', gates: ['budget_limit'] });
    const w2 = waiver({ id: 'W-A', gates: ['budget_limit'] });
    const w3 = waiver({ id: 'W-M', gates: ['budget_limit'] });
    const result = filterWaivedViolations({
      report: report([v('budget_limit')]),
      waivers: [w1, w2, w3],
      now: NOW,
      policyGateIds: ['budget_limit'],
    });
    expect(result.waivedByGate['budget_limit'].waiver_ids).toEqual(['W-A', 'W-M', 'W-Z']);
  });
});

// ---------------------------------------------------------------------------
// waived_count must be the exact number of violations suppressed for that
// specific gate; violations on other gates must not be counted.
// ---------------------------------------------------------------------------
describe('filterWaivedViolations: waived_count is per-gate and exact', () => {
  test('waived_count equals exactly the number of violations suppressed on that gate', () => {
    const result = filterWaivedViolations({
      report: report([v('budget_limit'), v('budget_limit'), v('scope_boundary')]),
      waivers: [waiver({ gates: ['budget_limit'] })],
      now: NOW,
      policyGateIds: ['budget_limit', 'scope_boundary'],
    });
    // 2 budget_limit violations suppressed; scope_boundary violation survives.
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(2);
    expect(result.waivedByGate['scope_boundary']).toBeUndefined();
    expect(result.reportForDisposition.violations).toHaveLength(1);
    expect(result.reportForDisposition.violations[0].gate).toBe('scope_boundary');
  });

  test('waived_count does NOT count violations from a different gate', () => {
    // Two gates, each with one waiver covering ONLY that gate, each with 1 violation.
    const wA = waiver({ id: 'W-A', gates: ['budget_limit'] });
    const wB = waiver({ id: 'W-B', gates: ['scope_boundary'] });
    const result = filterWaivedViolations({
      report: report([v('budget_limit'), v('scope_boundary')]),
      waivers: [wA, wB],
      now: NOW,
      policyGateIds: ['budget_limit', 'scope_boundary'],
    });
    expect(result.waivedByGate['budget_limit'].waived_count).toBe(1);
    expect(result.waivedByGate['scope_boundary'].waived_count).toBe(1);
    expect(result.reportForDisposition.violations).toHaveLength(0);
  });

  test('effectiveFor(v.gate).length > 0 must be true to count as waived', () => {
    // A violation with no effective waivers must not be counted as waived.
    const result = filterWaivedViolations({
      report: report([v('scope_boundary')]),
      waivers: [waiver({ gates: ['budget_limit'] })], // waiver covers budget_limit, NOT scope_boundary
      now: NOW,
      policyGateIds: ['budget_limit', 'scope_boundary'],
    });
    expect(result.waivedByGate['scope_boundary']).toBeUndefined();
    expect(result.reportForDisposition.violations).toHaveLength(1);
  });
});
