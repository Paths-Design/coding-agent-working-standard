// SESSION-OWNERSHIP-METADATA-001 commit 1 tests
//
// Substrate-only tests. Covers:
//   - A1: existing v1-shape records load with claimed_paths and
//         last_modified_paths absent (undefined).
//   - A8: non-agent top-level keys (`version`, `agents`) are rejected
//         by the isAgentRecord predicate.
//   - bound_spec_id no-regression: a record carrying bound_spec_id
//         continues to expose it through the typed interface (this is
//         the passive A9-withdrawn check; not new functionality).
//
// No writer behavior, no TTL logic, no policy schema, no shell —
// those are commit 2+.

import { isAgentRecord } from '../../src/worktree';
import type { AgentRecord } from '../../src/worktree';

describe('AgentRecord schema (A1 — v1 backward compatibility)', () => {
  it('admits a v1-shape record with the minimum fields', () => {
    const v1: AgentRecord = {
      session_id: 'caws-abc123',
      last_active: '2026-05-23T00:00:00.000Z',
    };
    expect(v1.session_id).toBe('caws-abc123');
    expect(v1.last_active).toBe('2026-05-23T00:00:00.000Z');
    expect(v1.claimed_paths).toBeUndefined();
    expect(v1.last_modified_paths).toBeUndefined();
  });

  it('admits a v1-shape record with all v1 optional fields', () => {
    const v1: AgentRecord = {
      session_id: 'caws-d9bab4d388f3',
      platform: 'darwin',
      last_active: '2026-05-20T06:08:32.139Z',
      bound_worktree: 'eh-v11-surface-wt',
      bound_spec_id: 'ERROR-HANDLER-V11-SURFACE-001',
    };
    expect(v1.bound_spec_id).toBe('ERROR-HANDLER-V11-SURFACE-001');
    expect(v1.claimed_paths).toBeUndefined();
    expect(v1.last_modified_paths).toBeUndefined();
  });

  it('admits a record with the new optional fields populated', () => {
    const v2: AgentRecord = {
      session_id: 'caws-future',
      last_active: '2026-05-23T00:00:00.000Z',
      claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
      last_modified_paths: ['packages/foo/a.ts', 'packages/foo/b.ts'],
    };
    expect(v2.claimed_paths).toEqual(['packages/foo/**', 'tests/foo.test.js']);
    expect(v2.last_modified_paths).toEqual([
      'packages/foo/a.ts',
      'packages/foo/b.ts',
    ]);
  });

  it('bound_spec_id no-regression: a record carrying the field still types correctly', () => {
    // A9 was withdrawn — bound_spec_id was already in AgentRecord at
    // packages/caws-kernel/src/worktree/types.ts:118. This is a passive
    // assertion that commit 1 did not regress that existing declaration.
    const r: AgentRecord = {
      session_id: 'caws-test',
      last_active: '2026-05-23T00:00:00.000Z',
      bound_spec_id: 'SOME-SPEC-001',
    };
    expect(r.bound_spec_id).toBe('SOME-SPEC-001');
  });
});

describe('isAgentRecord (A8 — non-agent top-level keys are rejected)', () => {
  it('admits a record with string session_id and string last_active', () => {
    const value = {
      session_id: 'caws-abc',
      last_active: '2026-05-23T00:00:00.000Z',
    };
    expect(isAgentRecord(value)).toBe(true);
  });

  it('admits a record with v2 optional fields populated', () => {
    const value = {
      session_id: 'caws-abc',
      last_active: '2026-05-23T00:00:00.000Z',
      claimed_paths: ['packages/foo'],
      last_modified_paths: ['packages/foo/a.ts'],
    };
    expect(isAgentRecord(value)).toBe(true);
  });

  it('rejects the literal `version: 1` top-level value', () => {
    // Direct mirror of the actual agents.json drift: `version` sits at
    // the top level as a number, not an object.
    expect(isAgentRecord(1)).toBe(false);
  });

  it('rejects the literal `agents: {}` top-level value', () => {
    // The empty `agents` key in agents.json: an object that has neither
    // session_id nor last_active.
    expect(isAgentRecord({})).toBe(false);
  });

  it('rejects null', () => {
    expect(isAgentRecord(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isAgentRecord(undefined)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isAgentRecord([])).toBe(false);
    expect(isAgentRecord(['caws-abc', '2026-05-23T00:00:00.000Z'])).toBe(false);
  });

  it('rejects a string', () => {
    expect(isAgentRecord('caws-abc')).toBe(false);
  });

  it('rejects a number', () => {
    expect(isAgentRecord(1)).toBe(false);
    expect(isAgentRecord(0)).toBe(false);
  });

  it('rejects a boolean', () => {
    expect(isAgentRecord(true)).toBe(false);
    expect(isAgentRecord(false)).toBe(false);
  });

  it('rejects an object missing session_id', () => {
    const value = {
      last_active: '2026-05-23T00:00:00.000Z',
    };
    expect(isAgentRecord(value)).toBe(false);
  });

  it('rejects an object missing last_active', () => {
    const value = {
      session_id: 'caws-abc',
    };
    expect(isAgentRecord(value)).toBe(false);
  });

  it('rejects an object where session_id is not a string', () => {
    const value = {
      session_id: 123,
      last_active: '2026-05-23T00:00:00.000Z',
    };
    expect(isAgentRecord(value)).toBe(false);
  });

  it('rejects an object where last_active is not a string', () => {
    const value = {
      session_id: 'caws-abc',
      last_active: 1716422400000,
    };
    expect(isAgentRecord(value)).toBe(false);
  });

  it('narrows the type when the predicate is true', () => {
    const unknownValue: unknown = {
      session_id: 'caws-abc',
      last_active: '2026-05-23T00:00:00.000Z',
      claimed_paths: ['packages/foo'],
    };
    if (isAgentRecord(unknownValue)) {
      // TypeScript narrowing: unknownValue is now AgentRecord here.
      // This compiles only if the predicate narrows correctly.
      const id: string = unknownValue.session_id;
      expect(id).toBe('caws-abc');
      expect(unknownValue.claimed_paths).toEqual(['packages/foo']);
    } else {
      throw new Error('expected predicate to admit the value');
    }
  });
});

describe('isAgentRecord — applied to the actual agents.json shape', () => {
  // This block exercises the exact drift in .caws/agents.json: a top-level
  // object with `version: 1`, `agents: {}`, and per-session records all
  // at the same level. The predicate distinguishes records from non-records.
  it('separates real records from version/agents non-records', () => {
    const onDiskShape: Record<string, unknown> = {
      version: 1,
      agents: {},
      'caws-d9bab4d388f3': {
        session_id: 'caws-d9bab4d388f3',
        last_active: '2026-05-20T06:08:32.139Z',
        platform: 'darwin',
        bound_worktree: 'eh-v11-surface-wt',
        bound_spec_id: 'ERROR-HANDLER-V11-SURFACE-001',
      },
    };
    const actualAgentEntries = Object.entries(onDiskShape).filter(([, v]) =>
      isAgentRecord(v)
    );
    expect(actualAgentEntries.length).toBe(1);
    expect(actualAgentEntries[0][0]).toBe('caws-d9bab4d388f3');
    expect(isAgentRecord(onDiskShape.version)).toBe(false);
    expect(isAgentRecord(onDiskShape.agents)).toBe(false);
  });
});
