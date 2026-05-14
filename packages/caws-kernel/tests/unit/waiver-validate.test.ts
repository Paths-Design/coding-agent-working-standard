/**
 * Tests for validateWaiver — kernel-pure waiver schema validation.
 */

import { validateWaiver, WAIVER_RULES } from '../../src/waiver';

const VALID_WAIVER = {
  id: 'WAIV-001',
  title: 'Allow legacy todo entries during migration',
  status: 'active',
  gates: ['todo_detection'],
  reason: 'Migration in progress; todo cleanup tracked separately',
  approved_by: 'darian',
  created_at: '2026-05-14T12:00:00.000Z',
  expires_at: '2026-06-14T12:00:00.000Z',
};

describe('validateWaiver — happy path', () => {
  it('accepts a minimal valid waiver', () => {
    const r = validateWaiver(VALID_WAIVER);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe('WAIV-001');
      expect(r.value.gates).toEqual(['todo_detection']);
    }
  });

  it('accepts scope.spec_id', () => {
    const r = validateWaiver({
      ...VALID_WAIVER,
      scope: { spec_id: 'FOO-1' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.scope?.spec_id).toBe('FOO-1');
    }
  });

  it('accepts a revoked waiver with a revocation record', () => {
    const r = validateWaiver({
      ...VALID_WAIVER,
      status: 'revoked',
      revocation: {
        revoked_at: '2026-05-15T00:00:00.000Z',
        revoked_by: 'darian',
        reason: 'No longer needed',
      },
    });
    expect(r.ok).toBe(true);
  });
});

describe('validateWaiver — rejections', () => {
  it('rejects non-object input', () => {
    const r = validateWaiver('not an object');
    expect(r.ok).toBe(false);
  });

  it('rejects an invalid id', () => {
    const r = validateWaiver({ ...VALID_WAIVER, id: 'lowercase-id' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_INVALID_ID);
  });

  it('rejects unknown status', () => {
    const r = validateWaiver({ ...VALID_WAIVER, status: 'expired' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_INVALID_STATUS);
  });

  it('rejects empty gates array', () => {
    const r = validateWaiver({ ...VALID_WAIVER, gates: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_INVALID_GATES);
  });

  it('rejects revoked status without revocation record', () => {
    const r = validateWaiver({ ...VALID_WAIVER, status: 'revoked' });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_REVOKED_WITHOUT_RECORD);
  });

  it('rejects active status that carries a revocation record', () => {
    const r = validateWaiver({
      ...VALID_WAIVER,
      revocation: { revoked_at: '2026-05-15T00:00:00.000Z' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_ACTIVE_WITH_REVOCATION);
  });

  it('rejects non-ISO expires_at', () => {
    const r = validateWaiver({ ...VALID_WAIVER, expires_at: '2026-06-14' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].rule).toBe(WAIVER_RULES.WAIVER_INVALID_EXPIRY);
  });
});
