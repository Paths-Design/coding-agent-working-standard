// SESSION-OWNERSHIP-METADATA-001 — kernel type-substrate tests.
//
// Commit 1 scope: AgentRecord interface extension (claimed_paths,
// last_modified_paths as optional readonly string[]) + isAgentRecord
// structural disambiguation predicate. No store-write path tested
// here; no CLI surface tested here; no policy schema tested here.
// Those land in subsequent commits per the spec's slice plan.

import { isAgentRecord } from '../../src/worktree';
import type { AgentRecord } from '../../src/worktree';

// ─── A1: v1-shape records remain valid under v2 interface ────────────

describe('SESSION-OWNERSHIP-METADATA-001 A1: v1 AgentRecord shapes load under v2', () => {
  it('accepts a v1-shape record with no new fields', () => {
    const v1: AgentRecord = {
      session_id: 'sess-v1',
      platform: 'claude-code',
      last_active: '2026-05-22T00:00:00.000Z',
      bound_worktree: 'wt-foo',
      bound_spec_id: 'SPEC-FOO-001',
    };
    // The new fields are optional; absence is valid.
    expect(v1.claimed_paths).toBeUndefined();
    expect(v1.last_modified_paths).toBeUndefined();
    expect(isAgentRecord(v1)).toBe(true);
  });

  it('accepts a v1-shape record with only the required fields', () => {
    const v1Min: AgentRecord = {
      session_id: 'sess-min',
      last_active: '2026-05-22T00:00:00.000Z',
    };
    expect(isAgentRecord(v1Min)).toBe(true);
  });
});

// ─── A2/A3 shape: v2 records carry the new optional fields ───────────

describe('SESSION-OWNERSHIP-METADATA-001: v2 AgentRecord carries optional ownership metadata', () => {
  it('accepts a v2-shape record with claimed_paths populated', () => {
    const v2: AgentRecord = {
      session_id: 'sess-v2',
      last_active: '2026-05-22T00:00:00.000Z',
      claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
    };
    expect(v2.claimed_paths).toEqual(['packages/foo/**', 'tests/foo.test.js']);
    expect(isAgentRecord(v2)).toBe(true);
  });

  it('accepts a v2-shape record with last_modified_paths populated', () => {
    const v2: AgentRecord = {
      session_id: 'sess-v2',
      last_active: '2026-05-22T00:00:00.000Z',
      last_modified_paths: ['packages/foo/src/index.ts'],
    };
    expect(v2.last_modified_paths).toEqual(['packages/foo/src/index.ts']);
    expect(isAgentRecord(v2)).toBe(true);
  });

  it('accepts a v2-shape record with both new fields and v1 fields', () => {
    const v2Full: AgentRecord = {
      session_id: 'sess-full',
      platform: 'claude-code',
      last_active: '2026-05-22T00:00:00.000Z',
      bound_worktree: 'wt-foo',
      bound_spec_id: 'SPEC-FOO-001',
      claimed_paths: ['packages/foo/**'],
      last_modified_paths: ['packages/foo/src/index.ts', 'tests/foo.test.js'],
    };
    expect(isAgentRecord(v2Full)).toBe(true);
  });
});

// ─── A8: structural disambiguation predicate ─────────────────────────

describe('SESSION-OWNERSHIP-METADATA-001 A8: isAgentRecord disambiguates non-agent top-level keys', () => {
  it('accepts a value with string session_id AND string last_active', () => {
    expect(
      isAgentRecord({
        session_id: 'sess-1',
        last_active: '2026-05-22T00:00:00.000Z',
      })
    ).toBe(true);
  });

  it('rejects the top-level `version: 1` metadata key', () => {
    // The on-disk `version: 1` field is a number, not an object —
    // the predicate must filter it before consumers enumerate records.
    expect(isAgentRecord(1)).toBe(false);
  });

  it('rejects the top-level `agents: {}` metadata key', () => {
    // An empty object lacks session_id and last_active.
    expect(isAgentRecord({})).toBe(false);
  });

  it('rejects an object missing session_id', () => {
    expect(
      isAgentRecord({ last_active: '2026-05-22T00:00:00.000Z' })
    ).toBe(false);
  });

  it('rejects an object missing last_active', () => {
    expect(isAgentRecord({ session_id: 'sess-1' })).toBe(false);
  });

  it('rejects an object whose session_id is not a string', () => {
    expect(
      isAgentRecord({
        session_id: 123,
        last_active: '2026-05-22T00:00:00.000Z',
      })
    ).toBe(false);
  });

  it('rejects an object whose last_active is not a string', () => {
    expect(
      isAgentRecord({
        session_id: 'sess-1',
        last_active: 1700000000000,
      })
    ).toBe(false);
  });

  it('rejects null', () => {
    expect(isAgentRecord(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAgentRecord(undefined)).toBe(false);
  });

  it('rejects arrays even if they look object-like', () => {
    expect(isAgentRecord([])).toBe(false);
    expect(
      isAgentRecord([
        { session_id: 'sess-1', last_active: '2026-05-22T00:00:00.000Z' },
      ])
    ).toBe(false);
  });

  it('rejects primitive scalars', () => {
    expect(isAgentRecord('sess-string')).toBe(false);
    expect(isAgentRecord(true)).toBe(false);
    expect(isAgentRecord(false)).toBe(false);
  });

  it('does NOT validate optional fields (claimed_paths/last_modified_paths shape is not checked here)', () => {
    // The predicate is intentionally minimal — downstream validation
    // handles malformed optional fields. A record with a malformed
    // claimed_paths (e.g., a string instead of an array) still passes
    // the predicate if the required fields are well-typed.
    expect(
      isAgentRecord({
        session_id: 'sess-malformed',
        last_active: '2026-05-22T00:00:00.000Z',
        claimed_paths: 'not-an-array',
      })
    ).toBe(true);
  });

  it('filters a mixed registry object correctly when applied to its values', () => {
    // Simulate the on-disk shape: top-level `version` and `agents`
    // keys mixed with per-session records.
    const onDisk: Record<string, unknown> = {
      version: 1,
      agents: {},
      'sess-real-1': {
        session_id: 'sess-real-1',
        last_active: '2026-05-22T00:00:00.000Z',
      },
      'sess-real-2': {
        session_id: 'sess-real-2',
        last_active: '2026-05-22T01:00:00.000Z',
        bound_worktree: 'wt-foo',
      },
    };

    const records = Object.values(onDisk).filter(isAgentRecord);

    expect(records).toHaveLength(2);
    expect(records.map((r) => r.session_id).sort()).toEqual([
      'sess-real-1',
      'sess-real-2',
    ]);
  });
});

// ─── A9 (WITHDRAWN): bound_spec_id no-regression hardening ───────────

describe('SESSION-OWNERSHIP-METADATA-001 A9 (WITHDRAWN): bound_spec_id is unchanged', () => {
  // A9 was originally drafted to retrofit bound_spec_id into
  // AgentRecord. Pre-implementation source inspection showed the field
  // was already declared. A9 is WITHDRAWN; this passive no-regression
  // assertion confirms the existing field is exposed through the typed
  // interface and the predicate path doesn't filter it out.

  it('AgentRecord exposes bound_spec_id as an optional readonly string', () => {
    const rec: AgentRecord = {
      session_id: 'sess-bound',
      last_active: '2026-05-22T00:00:00.000Z',
      bound_spec_id: 'SPEC-FOO-001',
    };
    expect(rec.bound_spec_id).toBe('SPEC-FOO-001');
    expect(isAgentRecord(rec)).toBe(true);
  });

  it('AgentRecord without bound_spec_id remains valid', () => {
    const rec: AgentRecord = {
      session_id: 'sess-unbound',
      last_active: '2026-05-22T00:00:00.000Z',
    };
    expect(rec.bound_spec_id).toBeUndefined();
    expect(isAgentRecord(rec)).toBe(true);
  });
});
