/**
 * Unit tests for deriveBudget + the waiver-applicability decision (A5).
 *
 * CAWS-TEST-KERNEL-PURE-001. deriveBudget is the pure budget engine:
 *   effective = baseline(tier) + sum(applicable budget_limit waiver deltas)
 * Tests pin the ACTUAL derived numbers and EACH waiver-skip reason, so a
 * mutation that flips a skip condition (e.g. expired <= becomes <, or drops the
 * approver gate) is killed. `now` is injected -> deterministic (the kernel
 * purity invariant; omitting `now` THROWS, no wall-clock fallback).
 *
 * Governed-path doctrine: spec.change_budget is NEVER consulted — the signature
 * accepts only spec.risk_tier, so a stray change_budget cannot leak in. This is
 * the CLAUDE.md governed-path rule (budgets derive from policy, waivers raise
 * them; you do not hand-edit change_budget).
 */

import { deriveBudget } from '../../src/policy/derive-budget';
import { POLICY_RULES } from '../../src/policy/rules';
import { isOk, isErr } from '../../src/result/construct';
import type { Policy, Waiver } from '../../src/policy/types';

const NOW = '2026-06-13T12:00:00.000Z';

/** Policy with real, distinct per-tier baselines so tier selection is provable. */
function policy(overrides: Partial<Policy> = {}): Policy {
  const gate = { mode: 'block' } as Policy['gates']['budget_limit'];
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 10, max_loc: 100 },
      '2': { max_files: 20, max_loc: 200 },
      '3': { max_files: 30, max_loc: 300 },
    },
    gates: { budget_limit: gate, spec_completeness: gate, scope_boundary: gate },
    ...overrides,
  };
}

/** A budget-raising, active, approved waiver by default; override to break each rule. */
function waiver(overrides: Partial<Waiver> = {}): Waiver {
  return {
    waiver_id: 'W-1',
    status: 'active',
    gates: ['budget_limit'],
    delta: { max_files: 5, max_loc: 50 },
    expires_at: '2026-12-31T00:00:00.000Z',
    approvers: [{ name: 'reviewer' }],
    ...overrides,
  };
}

describe('deriveBudget: baseline selection by tier', () => {
  test('tier 1 baseline with no waivers', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.budget).toEqual({ max_files: 10, max_loc: 100 });
  });

  test('tier 2 and tier 3 select their OWN baselines (not tier 1)', () => {
    const t2 = deriveBudget(policy(), { risk_tier: 2 }, [], { now: NOW });
    const t3 = deriveBudget(policy(), { risk_tier: 3 }, [], { now: NOW });
    if (isOk(t2)) expect(t2.value.budget).toEqual({ max_files: 20, max_loc: 200 });
    if (isOk(t3)) expect(t3.value.budget).toEqual({ max_files: 30, max_loc: 300 });
  });

  test('missing tier baseline -> Err budget.tier_not_found', () => {
    const p = policy();
    // Remove tier 1 to force the not-found path.
    delete (p.risk_tiers as Record<string, unknown>)['1'];
    const r = deriveBudget(p, { risk_tier: 1 }, [], { now: NOW });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(POLICY_RULES.BUDGET_TIER_NOT_FOUND);
  });
});

describe('deriveBudget: purity invariant (now is REQUIRED)', () => {
  test('omitting now THROWS (no wall-clock fallback)', () => {
    // @ts-expect-error deliberately omitting required `now`
    expect(() => deriveBudget(policy(), { risk_tier: 1 }, [], {})).toThrow(/now.*required/i);
  });

  test('an unparseable now THROWS (deterministic input conversion only)', () => {
    expect(() => deriveBudget(policy(), { risk_tier: 1 }, [], { now: 'not-a-date' })).toThrow(
      /invalid now/i
    );
  });
});

describe('deriveBudget: an applicable waiver RAISES the budget by its delta', () => {
  test('active + budget_limit + approved + unexpired -> delta added', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver()], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // baseline 10/100 + delta 5/50 = 15/150
      expect(r.value.budget).toEqual({ max_files: 15, max_loc: 150 });
      expect(r.value.trace.appliedWaivers.map((w) => w.waiver_id)).toEqual(['W-1']);
    }
  });

  test('two applicable waivers sum their deltas', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ waiver_id: 'W-1' }), waiver({ waiver_id: 'W-2', delta: { max_files: 3, max_loc: 30 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.budget).toEqual({ max_files: 18, max_loc: 180 });
  });
});

describe('deriveBudget: each waiver-skip reason is enforced (mutation-rich decision fn)', () => {
  const base = () => policy();

  function skippedReason(w: Waiver, now = NOW): string | undefined {
    const r = deriveBudget(base(), { risk_tier: 1 }, [w], { now });
    if (!isOk(r)) throw new Error('expected ok with a skipped waiver');
    return r.value.trace.skippedWaivers[0]?.reason;
  }

  test('non-active status is skipped (status_not_active), budget stays baseline', () => {
    const r = deriveBudget(base(), { risk_tier: 1 }, [waiver({ status: 'revoked' })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 100 });
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('status_not_active');
    }
  });

  test('waiver not covering budget_limit is skipped (gate_not_covered)', () => {
    expect(skippedReason(waiver({ gates: ['scope_boundary'] }))).toBe('gate_not_covered');
  });

  test('expired waiver is skipped (expired) — expires_at <= now means expired', () => {
    // expires exactly AT now -> expired (boundary: <= now).
    expect(skippedReason(waiver({ expires_at: NOW }))).toBe('expired');
    // expires before now -> expired.
    expect(skippedReason(waiver({ expires_at: '2020-01-01T00:00:00.000Z' }))).toBe('expired');
  });

  test('a waiver expiring strictly AFTER now is NOT expired (boundary check)', () => {
    const r = deriveBudget(base(), { risk_tier: 1 }, [waiver({ expires_at: '2026-06-13T12:00:00.001Z' })], {
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.trace.appliedWaivers).toHaveLength(1);
  });

  test('malformed expires_at is skipped (malformed)', () => {
    expect(skippedReason(waiver({ expires_at: 'garbage' }))).toBe('malformed');
  });

  test('negative delta is skipped (negative_delta) — a waiver can never LOWER budget', () => {
    expect(skippedReason(waiver({ delta: { max_files: -1, max_loc: 0 } }))).toBe('negative_delta');
  });

  test('insufficient approvers skipped ONLY when the waiver actually raises budget', () => {
    // raising waiver with 0 approvers -> skipped.
    expect(skippedReason(waiver({ approvers: [] }))).toBe('insufficient_approvers');
  });

  test('a ZERO-delta waiver with no approvers is APPLIED (approver gate only matters when raising)', () => {
    const r = deriveBudget(base(), { risk_tier: 1 }, [waiver({ delta: { max_files: 0, max_loc: 0 }, approvers: [] })], {
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // No skip for approvers because delta does not raise budget.
      expect(r.value.trace.appliedWaivers).toHaveLength(1);
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 100 });
    }
  });

  test('min_approvers_for_budget_raise from policy is honored', () => {
    const p = policy({ waivers: { min_approvers_for_budget_raise: 2 } });
    // One approver < required 2 -> skipped.
    const r = deriveBudget(p, { risk_tier: 1 }, [waiver({ approvers: [{ name: 'a' }] })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.trace.skippedWaivers[0]?.reason).toBe('insufficient_approvers');
  });
});

describe('deriveBudget: trace records baseline, applied, skipped, effective', () => {
  test('the trace is a complete derivation audit', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 2 },
      [waiver(), waiver({ waiver_id: 'W-skip', status: 'revoked' })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const t = r.value.trace;
      expect(t.tier).toBe(2);
      expect(t.baseline).toEqual({ max_files: 20, max_loc: 200 });
      expect(t.appliedWaivers.map((w) => w.waiver_id)).toEqual(['W-1']);
      expect(t.skippedWaivers.map((w) => w.waiver_id)).toEqual(['W-skip']);
      expect(t.effective).toEqual({ max_files: 25, max_loc: 250 });
      expect(t.evaluatedAt).toBe(NOW);
    }
  });
});

describe('deriveBudget: diagnostic fields for tier-not-found error (L59-64 StringLiteral/ObjectLiteral)', () => {
  test('err diagnostic has exact authority, message, subject, location pointer, narrowRepair', () => {
    const p = policy();
    delete (p.risk_tiers as Record<string, unknown>)['2'];
    const r = deriveBudget(p, { risk_tier: 2 }, [], { now: NOW });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors[0]!;
      expect(d.rule).toBe(POLICY_RULES.BUDGET_TIER_NOT_FOUND);
      expect(d.authority).toBe('kernel/policy');
      expect(d.message).toBe('Policy has no risk_tiers entry for tier 2.');
      expect(d.subject).toBe('.caws/policy.yaml');
      // location is an object with a pointer field — not {}
      expect((d as any).location).toEqual({ pointer: '/risk_tiers/2' });
      expect((d as any).narrowRepair).toBe('Add risk_tiers["2"] with max_files and max_loc.');
    }
  });

  test('err diagnostic message encodes the tier key correctly for tier 3', () => {
    const p = policy();
    delete (p.risk_tiers as Record<string, unknown>)['3'];
    const r = deriveBudget(p, { risk_tier: 3 }, [], { now: NOW });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors[0]!;
      expect(d.message).toBe('Policy has no risk_tiers entry for tier 3.');
      expect((d as any).location).toEqual({ pointer: '/risk_tiers/3' });
      expect((d as any).narrowRepair).toBe('Add risk_tiers["3"] with max_files and max_loc.');
    }
  });
});

describe('deriveBudget: skipped waiver detail field presence/absence (L83 ConditionalExpression/ObjectLiteral)', () => {
  // The spread `...(decision.detail !== undefined && { detail: decision.detail })`
  // means: detail is PRESENT when the skip reason provides one, ABSENT otherwise.
  // We need to assert the EXACT detail string to kill StringLiteral mutants too.

  test('status_not_active skip: detail field is present with exact status value', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver({ status: 'revoked' })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('status_not_active');
      expect(skipped.detail).toBe('status=revoked');
    }
  });

  test('status_not_active skip: detail encodes the actual status (expired_license)', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver({ status: 'expired' as any })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.detail).toBe('status=expired');
    }
  });

  test('gate_not_covered skip: detail is present with exact string', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver({ gates: ['scope_boundary'] })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('gate_not_covered');
      expect(skipped.detail).toBe('budget_limit not in waiver.gates');
    }
  });

  test('malformed expires_at skip: detail encodes the bad value', () => {
    const badDate = 'totally-unparseable';
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver({ expires_at: badDate })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('malformed');
      expect(skipped.detail).toBe(`unparseable expires_at=${badDate}`);
    }
  });

  test('expired skip: detail encodes the expires_at timestamp', () => {
    const exp = '2024-01-01T00:00:00.000Z';
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver({ expires_at: exp })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('expired');
      expect(skipped.detail).toBe(`expired_at=${exp}`);
    }
  });

  test('negative_delta skip: detail encodes the actual file and loc counts', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: -3, max_loc: 0 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('negative_delta');
      expect(skipped.detail).toBe('delta files=-3 loc=0');
    }
  });

  test('insufficient_approvers skip: detail encodes counts as "N < required M"', () => {
    const p = policy({ waivers: { min_approvers_for_budget_raise: 3 } });
    const r = deriveBudget(p, { risk_tier: 1 }, [waiver({ approvers: [{ name: 'a' }] })], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('insufficient_approvers');
      expect(skipped.detail).toBe('1 < required 3');
    }
  });

  test('applied waiver has NO detail field (detail is absent, not undefined)', () => {
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver()], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // Applied entry has no detail — the skippedWaivers list is empty
      expect(r.value.trace.skippedWaivers).toHaveLength(0);
      const applied = r.value.trace.appliedWaivers[0]!;
      // Applied entries do not have a detail field
      expect('detail' in applied).toBe(false);
    }
  });
});

describe('deriveBudget: optional chaining — delta and approvers may be undefined (L133, L134, L142)', () => {
  test('waiver with no delta field (undefined) -> treated as 0/0 -> applied (no crash)', () => {
    const w = waiver({ delta: undefined as any });
    const r = deriveBudget(policy(), { risk_tier: 1 }, [w], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // dFiles=0, dLoc=0 -> zero-delta waiver applied (approver gate skipped for zero delta)
      expect(r.value.trace.appliedWaivers).toHaveLength(1);
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 100 });
    }
  });

  test('waiver with no approvers field (undefined) and delta=0 -> applied (no crash on ?.length)', () => {
    const w = waiver({ delta: { max_files: 0, max_loc: 0 }, approvers: undefined as any });
    const r = deriveBudget(policy(), { risk_tier: 1 }, [w], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // zero delta -> approver gate skipped entirely -> applied
      expect(r.value.trace.appliedWaivers).toHaveLength(1);
    }
  });

  test('waiver with no approvers field (undefined) but positive delta -> insufficient_approvers', () => {
    // approvers is undefined -> ?.length ?? 0 = 0 < minApprovers(1) -> skip
    const w = waiver({ approvers: undefined as any });
    const r = deriveBudget(policy(), { risk_tier: 1 }, [w], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('insufficient_approvers');
      expect(skipped.detail).toBe('0 < required 1');
    }
  });
});

describe('deriveBudget: approver-gate dFiles>0||dLoc>0 boundary (L141 LogicalOperator)', () => {
  // The guard is `dFiles > 0 || dLoc > 0` — mutant flips to `&&`.
  // If only ONE side is positive, the || fires but && would not.

  test('only dFiles > 0, dLoc = 0 -> approver gate activates (proves || not &&)', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: 5, max_loc: 0 }, approvers: [] })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      // With 0 approvers and a raising-files-only waiver, must be skipped
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('insufficient_approvers');
    }
  });

  test('only dLoc > 0, dFiles = 0 -> approver gate activates (proves || not &&)', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: 0, max_loc: 50 }, approvers: [] })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('insufficient_approvers');
    }
  });

  test('only dFiles > 0, dLoc = 0 -> applying with sufficient approvers raises files only', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: 7, max_loc: 0 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.budget).toEqual({ max_files: 17, max_loc: 100 });
    }
  });

  test('only dLoc > 0, dFiles = 0 -> applying with sufficient approvers raises loc only', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: 0, max_loc: 75 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 175 });
    }
  });
});

describe('deriveBudget: expires_at absent branch (L123 ConditionalExpression)', () => {
  test('waiver with no expires_at field -> expiry check skipped -> waiver applied', () => {
    // If ConditionalExpression mutant forces "true", the absent-expires_at case
    // would enter the expiry block and hit parseDate(undefined) or crash.
    const w = waiver({ expires_at: undefined as any });
    const r = deriveBudget(policy(), { risk_tier: 1 }, [w], { now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.trace.appliedWaivers).toHaveLength(1);
      expect(r.value.budget).toEqual({ max_files: 15, max_loc: 150 });
    }
  });
});

describe('deriveBudget: negative_delta both-sides branch (L136 ConditionalExpression)', () => {
  test('dLoc negative only -> negative_delta skip', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: 0, max_loc: -10 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('negative_delta');
      expect(skipped.detail).toBe('delta files=0 loc=-10');
    }
  });

  test('both dFiles and dLoc negative -> negative_delta skip with exact detail', () => {
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ delta: { max_files: -2, max_loc: -20 } })],
      { now: NOW }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const skipped = r.value.trace.skippedWaivers[0]!;
      expect(skipped.reason).toBe('negative_delta');
      expect(skipped.detail).toBe('delta files=-2 loc=-20');
    }
  });
});

describe('deriveBudget: resolveNow accepts Date object (L163 ConditionalExpression)', () => {
  test('passing a Date object works (not just ISO string)', () => {
    const nowDate = new Date(NOW);
    const r = deriveBudget(policy(), { risk_tier: 1 }, [], { now: nowDate });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.budget).toEqual({ max_files: 10, max_loc: 100 });
      expect(r.value.trace.evaluatedAt).toBe(NOW);
    }
  });

  test('Date object used for expiry comparison (active waiver with Date-form now)', () => {
    const nowDate = new Date(NOW);
    const r = deriveBudget(policy(), { risk_tier: 1 }, [waiver()], { now: nowDate });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.trace.appliedWaivers).toHaveLength(1);
      expect(r.value.budget).toEqual({ max_files: 15, max_loc: 150 });
    }
  });

  test('Date object: expired waiver correctly skipped', () => {
    const nowDate = new Date(NOW);
    const r = deriveBudget(
      policy(),
      { risk_tier: 1 },
      [waiver({ expires_at: '2025-01-01T00:00:00.000Z' })],
      { now: nowDate }
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.trace.skippedWaivers[0]?.reason).toBe('expired');
    }
  });
});
