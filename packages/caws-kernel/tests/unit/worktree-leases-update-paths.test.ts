// SESSION-OWNERSHIP-METADATA-001 (lease-substrate amendment) commit 2 —
// kernel-side tests for updateAgentLeasePaths + validateLeasePathMetadata
// + new LEASE_RULES (LEASE_PATH_EMPTY, LEASE_PATH_NULL_BYTE,
// LEASE_NOT_FOUND).
//
// Coverage:
//   - A1 backward-compat (proven in commit 1 via type-shape test;
//     here we assert the patch path leaves other lease fields alone).
//   - A2: explicit claimed_paths produces an update_lease_paths patch
//         that names the field verbatim, in caller order.
//   - A3: last_modified_paths > 1000 truncates to final 1000 in caller
//         order; non-string/empty/null-byte entries fail closed with
//         no partial patch.
//   - A4 (kernel slice): missing target lease returns LEASE_NOT_FOUND.
//   - lease-fabrication negative lock: updateAgentLeasePaths is NOT a
//     lease-creation route.
//   - A9 (WITHDRAWN): bound_spec_id not modified by this path.

import {
  LAST_MODIFIED_PATHS_MAX_ENTRIES,
  LEASE_RULES,
  updateAgentLeasePaths,
  validateLeasePathMetadata,
} from '../../src/worktree/leases';
import type {
  AgentLease,
  LeasePatch,
  LeaseRegistry,
} from '../../src/worktree/leases';
import { isErr, isOk } from '../../src/result';
import { WORKTREE_RULES } from '../../src/worktree/rules';
import type { SessionIdentity } from '../../src/worktree/types';

const SESSION: SessionIdentity = {
  session_id: 'sess-test',
  platform: 'claude-code',
};

const BASE_LEASE: AgentLease = {
  lease_version: 1,
  session_id: 'sess-test',
  platform: 'claude-code',
  status: 'active',
  started_at: '2026-05-28T00:00:00.000Z',
  last_active: '2026-05-28T01:00:00.000Z',
  repo_root: '/tmp/repo',
  cwd: '/tmp/repo',
  git_common_dir: '/tmp/repo/.git',
  git_dir: '/tmp/repo/.git',
  last_seen_reason: 'session_start',
  bound_worktree: 'wt-foo',
  bound_spec_id: 'SPEC-FOO-001',
};

function registry(...leases: AgentLease[]): LeaseRegistry {
  const r: Record<string, AgentLease> = {};
  for (const l of leases) r[l.session_id] = l;
  return r;
}

// ─── validateLeasePathMetadata ─────────────────────────────────────────

describe('SESSION-OWNERSHIP-METADATA-001 A3: validateLeasePathMetadata', () => {
  it('admits both fields undefined (returns empty validated object)', () => {
    const r = validateLeasePathMetadata({});
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.claimed_paths).toBeUndefined();
      expect(r.value.last_modified_paths).toBeUndefined();
    }
  });

  it('admits empty claimed_paths array (valid "no claims" declaration)', () => {
    const r = validateLeasePathMetadata({ claimed_paths: [] });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.claimed_paths).toEqual([]);
  });

  it('admits empty last_modified_paths array', () => {
    const r = validateLeasePathMetadata({ last_modified_paths: [] });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.last_modified_paths).toEqual([]);
  });

  it('preserves caller order verbatim for claimed_paths', () => {
    const input = ['packages/foo/**', 'tests/foo.test.js', 'docs/foo.md'];
    const r = validateLeasePathMetadata({ claimed_paths: input });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.claimed_paths).toEqual(input);
      // Returns a copy (not the same reference) but equal content.
      expect(r.value.claimed_paths).not.toBe(input);
    }
  });

  it('preserves caller order verbatim for last_modified_paths under the limit', () => {
    const input = ['a.ts', 'b.ts', 'c.ts'];
    const r = validateLeasePathMetadata({ last_modified_paths: input });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.last_modified_paths).toEqual(input);
  });

  it('truncates last_modified_paths over 1000 entries to the final 1000 (FIFO drop)', () => {
    const input = Array.from({ length: 1500 }, (_, i) => `path-${i}.ts`);
    const r = validateLeasePathMetadata({ last_modified_paths: input });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.last_modified_paths).toHaveLength(LAST_MODIFIED_PATHS_MAX_ENTRIES);
      expect(r.value.last_modified_paths![0]).toBe('path-500.ts');
      expect(r.value.last_modified_paths![999]).toBe('path-1499.ts');
    }
  });

  it('does NOT truncate claimed_paths over 1000 entries (claims are explicit)', () => {
    const input = Array.from({ length: 1500 }, (_, i) => `glob-${i}/**`);
    const r = validateLeasePathMetadata({ claimed_paths: input });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.claimed_paths).toHaveLength(1500);
  });

  it('rejects non-string entries with LEASE_PATH_EMPTY', () => {
    const r = validateLeasePathMetadata({
      claimed_paths: ['valid.ts', 42 as unknown as string],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.some((e) => e.rule === LEASE_RULES.LEASE_PATH_EMPTY)).toBe(true);
    }
  });

  it('rejects empty-string entries with LEASE_PATH_EMPTY', () => {
    const r = validateLeasePathMetadata({ last_modified_paths: ['valid.ts', ''] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.some((e) => e.rule === LEASE_RULES.LEASE_PATH_EMPTY)).toBe(true);
    }
  });

  it('rejects entries containing a null byte with LEASE_PATH_NULL_BYTE', () => {
    const r = validateLeasePathMetadata({
      claimed_paths: ['valid.ts', 'has\0null.ts'],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.some((e) => e.rule === LEASE_RULES.LEASE_PATH_NULL_BYTE)).toBe(true);
    }
  });

  it('aggregates errors across both fields', () => {
    const r = validateLeasePathMetadata({
      claimed_paths: [''],
      last_modified_paths: ['bad\0one'],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rules = new Set(r.errors.map((e) => e.rule));
      expect(rules.has(LEASE_RULES.LEASE_PATH_EMPTY)).toBe(true);
      expect(rules.has(LEASE_RULES.LEASE_PATH_NULL_BYTE)).toBe(true);
    }
  });
});

// ─── updateAgentLeasePaths ─────────────────────────────────────────────

describe('SESSION-OWNERSHIP-METADATA-001 A2/A4: updateAgentLeasePaths', () => {
  it('returns an update_lease_paths patch for an existing lease (A2)', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(leases, SESSION, {
      claimed_paths: ['packages/foo/**'],
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const patch = r.value;
      expect(patch.kind).toBe('update_lease_paths');
      if (patch.kind === 'update_lease_paths') {
        expect(patch.session_id).toBe('sess-test');
        expect(patch.claimed_paths).toEqual(['packages/foo/**']);
        expect(patch.last_modified_paths).toBeUndefined();
      }
    }
  });

  it('omits an undefined field from the patch shape (leave-alone semantic)', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(leases, SESSION, {
      last_modified_paths: ['a.ts'],
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'update_lease_paths') {
      expect(r.value.last_modified_paths).toEqual(['a.ts']);
      // claimed_paths key MUST NOT appear when undefined was passed.
      expect(Object.prototype.hasOwnProperty.call(r.value, 'claimed_paths')).toBe(false);
    }
  });

  it('admits both fields in a single patch', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(leases, SESSION, {
      claimed_paths: ['packages/foo/**'],
      last_modified_paths: ['packages/foo/src/index.ts'],
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'update_lease_paths') {
      expect(r.value.claimed_paths).toEqual(['packages/foo/**']);
      expect(r.value.last_modified_paths).toEqual(['packages/foo/src/index.ts']);
    }
  });

  it('truncates last_modified_paths inside the patch (deterministic normalization)', () => {
    const leases = registry(BASE_LEASE);
    const input = Array.from({ length: 1234 }, (_, i) => `p-${i}.ts`);
    const r = updateAgentLeasePaths(leases, SESSION, { last_modified_paths: input });
    expect(isOk(r)).toBe(true);
    if (isOk(r) && r.value.kind === 'update_lease_paths') {
      expect(r.value.last_modified_paths).toHaveLength(LAST_MODIFIED_PATHS_MAX_ENTRIES);
      expect(r.value.last_modified_paths![0]).toBe('p-234.ts');
    }
  });

  it('refuses with LEASE_NOT_FOUND when no lease exists for the session (A4 / no fabrication)', () => {
    const leases = registry(); // empty
    const r = updateAgentLeasePaths(leases, SESSION, { claimed_paths: ['a'] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors[0]!.rule).toBe(LEASE_RULES.LEASE_NOT_FOUND);
    }
  });

  it('refuses with LEASE_NOT_FOUND when the registry has OTHER sessions but not ours', () => {
    const other: AgentLease = { ...BASE_LEASE, session_id: 'sess-other' };
    const leases = registry(other);
    const r = updateAgentLeasePaths(leases, SESSION, { claimed_paths: ['a'] });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(LEASE_RULES.LEASE_NOT_FOUND);
  });

  it('refuses on validation failure (does not return a partial patch)', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(leases, SESSION, {
      claimed_paths: ['valid.ts', ''],
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.some((e) => e.rule === LEASE_RULES.LEASE_PATH_EMPTY)).toBe(true);
    }
  });

  it('refuses on invalid session identity before checking lease existence', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(
      leases,
      { session_id: '' } as unknown as SessionIdentity,
      { claimed_paths: ['a'] }
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Identity error fires first via validateSessionIdentity (emits
      // WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY). lease-not-found
      // never runs. The shared identity-validation surface owns the
      // identity-rule namespace; this slice does not duplicate it under
      // a LEASE_RULES.SESSION_INVALID branch.
      expect(
        r.errors.some((e) => e.rule === WORKTREE_RULES.IDENTITY_SESSION_ID_EMPTY)
      ).toBe(true);
      expect(r.errors.some((e) => e.rule === LEASE_RULES.LEASE_NOT_FOUND)).toBe(false);
    }
  });

  it('patch never mutates last_active/status/etc. (negative lock — patch shape only)', () => {
    const leases = registry(BASE_LEASE);
    const r = updateAgentLeasePaths(leases, SESSION, { claimed_paths: ['a'] });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const patch = r.value as LeasePatch;
      // Patch is union-discriminated; on this branch only the
      // documented keys must appear. session_id + kind are required;
      // claimed_paths / last_modified_paths are conditional.
      if (patch.kind === 'update_lease_paths') {
        const keys = Object.keys(patch);
        for (const k of keys) {
          expect(['kind', 'session_id', 'claimed_paths', 'last_modified_paths']).toContain(k);
        }
      }
    }
  });
});
