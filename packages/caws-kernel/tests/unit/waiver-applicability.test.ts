/**
 * Tests for effectiveWaiversForGate + waiverEffectiveness.
 */

import {
  effectiveWaiversForGate,
  waiverEffectiveness,
  type Waiver,
} from '../../src/waiver';

const NOW = new Date('2026-05-14T12:00:00.000Z');

const ACTIVE: Waiver = {
  id: 'WAIV-001',
  title: 'Active waiver',
  status: 'active',
  gates: ['todo_detection'],
  reason: 'migration',
  approved_by: 'darian',
  created_at: '2026-05-01T00:00:00.000Z',
  expires_at: '2026-06-01T00:00:00.000Z',
};

const REVOKED: Waiver = {
  ...ACTIVE,
  id: 'WAIV-002',
  status: 'revoked',
  revocation: { revoked_at: '2026-05-10T00:00:00.000Z' },
};

const EXPIRED: Waiver = {
  ...ACTIVE,
  id: 'WAIV-003',
  expires_at: '2026-05-13T00:00:00.000Z', // 24h before NOW
};

const SCOPED: Waiver = {
  ...ACTIVE,
  id: 'WAIV-004',
  scope: { spec_id: 'FOO-1' },
};

describe('waiverEffectiveness', () => {
  it('classifies an active in-window waiver as active', () => {
    expect(waiverEffectiveness(ACTIVE, NOW)).toBe('active');
  });

  it('classifies a revoked waiver as revoked even if not expired', () => {
    expect(waiverEffectiveness(REVOKED, NOW)).toBe('revoked');
  });

  it('classifies an active expired waiver as expired (derived, not stored)', () => {
    expect(waiverEffectiveness(EXPIRED, NOW)).toBe('expired');
  });
});

describe('effectiveWaiversForGate', () => {
  it('returns active waivers covering the gate', () => {
    const r = effectiveWaiversForGate({
      waivers: [ACTIVE, REVOKED, EXPIRED],
      gate: 'todo_detection',
      now: NOW,
    });
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('WAIV-001');
  });

  it('excludes waivers whose gates do not include the target gate', () => {
    const r = effectiveWaiversForGate({
      waivers: [ACTIVE],
      gate: 'budget_limit',
      now: NOW,
    });
    expect(r).toEqual([]);
  });

  it('excludes scoped waivers when spec id does not match', () => {
    const r = effectiveWaiversForGate({
      waivers: [SCOPED],
      gate: 'todo_detection',
      specId: 'BAR-2',
      now: NOW,
    });
    expect(r).toEqual([]);
  });

  it('includes scoped waivers when spec id matches', () => {
    const r = effectiveWaiversForGate({
      waivers: [SCOPED],
      gate: 'todo_detection',
      specId: 'FOO-1',
      now: NOW,
    });
    expect(r).toHaveLength(1);
  });

  it('excludes scoped waivers when no spec id is supplied', () => {
    const r = effectiveWaiversForGate({
      waivers: [SCOPED],
      gate: 'todo_detection',
      now: NOW,
    });
    expect(r).toEqual([]);
  });

  it('includes project-wide (no-scope) waivers regardless of spec id', () => {
    const r = effectiveWaiversForGate({
      waivers: [ACTIVE],
      gate: 'todo_detection',
      specId: 'FOO-1',
      now: NOW,
    });
    expect(r).toHaveLength(1);
  });
});
