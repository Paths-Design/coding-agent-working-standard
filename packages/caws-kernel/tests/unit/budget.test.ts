import { deriveBudget, parseAndValidatePolicy, POLICY_RULES } from '../../src/policy';
import type { Policy, Waiver } from '../../src/policy/types';
import { VALID_MINIMAL_POLICY } from '../fixtures/policy-fixtures';

const NOW = new Date('2026-05-07T12:00:00.000Z');

function loadPolicy(): Policy {
  const r = parseAndValidatePolicy(VALID_MINIMAL_POLICY);
  if (!r.ok) throw new Error('failed to load minimal policy');
  return r.value;
}

const baseWaiver: Waiver = {
  waiver_id: 'WV-0001',
  status: 'active',
  gates: ['budget_limit'],
  delta: { max_files: 5, max_loc: 100 },
  expires_at: '2027-01-01T00:00:00Z',
  approvers: [{ name: 'reviewer-1' }],
};

describe('deriveBudget — baseline only', () => {
  const policy = loadPolicy();

  it('T1 baseline matches policy.risk_tiers["1"]', () => {
    const r = deriveBudget(policy, { risk_tier: 1 }, [], { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 250 });
      expect(r.value.trace.tier).toBe(1);
      expect(r.value.trace.appliedWaivers).toEqual([]);
      expect(r.value.trace.skippedWaivers).toEqual([]);
    }
  });

  it('T2 baseline matches policy.risk_tiers["2"]', () => {
    const r = deriveBudget(policy, { risk_tier: 2 }, [], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
    }
  });

  it('T3 baseline matches policy.risk_tiers["3"]', () => {
    const r = deriveBudget(policy, { risk_tier: 3 }, [], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 500, max_loc: 40000 });
    }
  });

  it('emits BUDGET_TIER_NOT_FOUND when policy is missing the requested tier', () => {
    // Mutate a copy to simulate a missing tier (cannot pass schema, but is
    // possible if construction bypasses validation in another code path).
    const broken = { ...policy, risk_tiers: { ...policy.risk_tiers } } as unknown as Policy;
    delete (broken.risk_tiers as Record<string, unknown>)['2'];
    const r = deriveBudget(broken, { risk_tier: 2 }, [], { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(POLICY_RULES.BUDGET_TIER_NOT_FOUND);
    }
  });
});

describe('deriveBudget — waivers', () => {
  const policy = loadPolicy();

  it('applies an active budget_limit waiver additively', () => {
    const r = deriveBudget(policy, { risk_tier: 2 }, [baseWaiver], { now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 105, max_loc: 10100 });
      expect(r.value.trace.appliedWaivers).toEqual([
        { waiver_id: 'WV-0001', delta: { max_files: 5, max_loc: 100 } },
      ]);
      expect(r.value.trace.skippedWaivers).toEqual([]);
    }
  });

  it('skips a waiver with status=proposed', () => {
    const w: Waiver = { ...baseWaiver, status: 'proposed' };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('status_not_active');
    }
  });

  it('skips a waiver with status=revoked', () => {
    const w: Waiver = { ...baseWaiver, status: 'revoked' };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('status_not_active');
    }
  });

  it('skips an expired waiver and records the reason in trace', () => {
    const w: Waiver = { ...baseWaiver, expires_at: '2026-01-01T00:00:00Z' };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('expired');
    }
  });

  it('skips a waiver that does not cover budget_limit gate', () => {
    const w: Waiver = { ...baseWaiver, gates: ['scope_boundary'] };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('gate_not_covered');
    }
  });

  it('skips a waiver with a negative delta', () => {
    const w: Waiver = { ...baseWaiver, delta: { max_files: -1, max_loc: 0 } };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('negative_delta');
    }
  });

  it('skips a budget-raising waiver when approvers < policy minimum', () => {
    // Corrected policy has min_approvers_for_budget_raise: 2
    const correctedPolicyR = parseAndValidatePolicy(`
version: 1
risk_tiers:
  "1": { max_files: 10, max_loc: 250 }
  "2": { max_files: 100, max_loc: 10000 }
  "3": { max_files: 500, max_loc: 40000 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
waivers:
  min_approvers_for_budget_raise: 2
`);
    if (!correctedPolicyR.ok) throw new Error('policy load failed');
    const w: Waiver = { ...baseWaiver, approvers: [{ name: 'only-one' }] };
    const r = deriveBudget(correctedPolicyR.value, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('insufficient_approvers');
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
    }
  });

  it('does not require approvers when delta is all zero (gate-cover-only waiver)', () => {
    const w: Waiver = {
      ...baseWaiver,
      delta: { max_files: 0, max_loc: 0 },
      approvers: [],
    };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      // Applies (gate covered, expiry valid, deltas 0+0); no skip.
      expect(r.value.trace.appliedWaivers.length).toBe(1);
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
    }
  });

  it('combines multiple active waivers additively', () => {
    const w1: Waiver = { ...baseWaiver, waiver_id: 'WV-0001' };
    const w2: Waiver = {
      ...baseWaiver,
      waiver_id: 'WV-0002',
      delta: { max_files: 3, max_loc: 50 },
    };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w1, w2], { now: NOW });
    if (r.ok) {
      expect(r.value.budget).toEqual({ max_files: 108, max_loc: 10150 });
      expect(r.value.trace.appliedWaivers.length).toBe(2);
    }
  });

  it('records both applied and skipped in a mixed batch', () => {
    const apply: Waiver = { ...baseWaiver, waiver_id: 'WV-0001' };
    const expired: Waiver = {
      ...baseWaiver,
      waiver_id: 'WV-0002',
      expires_at: '2026-01-01T00:00:00Z',
    };
    const wrongGate: Waiver = {
      ...baseWaiver,
      waiver_id: 'WV-0003',
      gates: ['scope_boundary'],
    };
    const r = deriveBudget(policy, { risk_tier: 2 }, [apply, expired, wrongGate], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.appliedWaivers.length).toBe(1);
      expect(r.value.trace.skippedWaivers.length).toBe(2);
      expect(r.value.budget).toEqual({ max_files: 105, max_loc: 10100 });
    }
  });
});

describe('deriveBudget — time injection', () => {
  const policy = loadPolicy();

  it('uses the injected now for expiry comparison', () => {
    const w: Waiver = { ...baseWaiver, expires_at: '2026-06-01T00:00:00Z' };
    // BEFORE expiry — applies
    const before = deriveBudget(policy, { risk_tier: 2 }, [w], {
      now: new Date('2026-05-07T00:00:00Z'),
    });
    if (before.ok) {
      expect(before.value.trace.appliedWaivers.length).toBe(1);
    }
    // AFTER expiry — skipped
    const after = deriveBudget(policy, { risk_tier: 2 }, [w], {
      now: new Date('2026-07-01T00:00:00Z'),
    });
    if (after.ok) {
      expect(after.value.trace.skippedWaivers[0]?.reason).toBe('expired');
    }
  });

  it('treats expires_at exactly equal to now as expired', () => {
    const w: Waiver = { ...baseWaiver, expires_at: NOW.toISOString() };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('expired');
    }
  });

  it('flags a malformed expires_at as malformed (not expired)', () => {
    const w: Waiver = { ...baseWaiver, expires_at: 'not-a-date' };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: NOW });
    if (r.ok) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('malformed');
    }
  });

  it('accepts an ISO string for the now option', () => {
    const w: Waiver = { ...baseWaiver, expires_at: '2026-06-01T00:00:00Z' };
    const r = deriveBudget(policy, { risk_tier: 2 }, [w], { now: '2026-05-07T00:00:00Z' });
    if (r.ok) {
      expect(r.value.trace.appliedWaivers.length).toBe(1);
    }
  });

  it('throws on an invalid now value (programmer error, not Result)', () => {
    expect(() =>
      deriveBudget(policy, { risk_tier: 2 }, [], { now: 'definitely-not-a-date' }),
    ).toThrow();
  });
});

describe('deriveBudget — spec.change_budget cannot leak in', () => {
  const policy = loadPolicy();

  it('signature accepts only risk_tier; an object with stray change_budget is ignored', () => {
    // TypeScript would already reject extra fields via the Pick<>, but the
    // runtime test confirms the function reads ONLY risk_tier.
    const fakeSpec = {
      risk_tier: 2 as const,
      change_budget: { max_files: 99999, max_loc: 99999 },
    };
    const r = deriveBudget(policy, fakeSpec, [], { now: NOW });
    if (r.ok) {
      // Baseline only; change_budget did not leak in.
      expect(r.value.budget).toEqual({ max_files: 100, max_loc: 10000 });
    }
  });
});

describe('deriveBudget — trace shape', () => {
  const policy = loadPolicy();

  it('trace includes tier, baseline, applied, skipped, effective, evaluatedAt', () => {
    const r = deriveBudget(policy, { risk_tier: 3 }, [baseWaiver], { now: NOW });
    if (r.ok) {
      const t = r.value.trace;
      expect(t.tier).toBe(3);
      expect(t.baseline).toEqual({ max_files: 500, max_loc: 40000 });
      expect(t.appliedWaivers.length).toBe(1);
      expect(t.skippedWaivers).toEqual([]);
      expect(t.effective).toEqual({ max_files: 505, max_loc: 40100 });
      expect(t.evaluatedAt).toBe(NOW.toISOString());
    }
  });
});
