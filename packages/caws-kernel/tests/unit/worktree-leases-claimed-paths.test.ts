// SESSION-OWNERSHIP-METADATA-001 (lease-substrate amendment 2026-05-28)
// — kernel type-substrate tests for the additive AgentLease extension.
//
// Commit 1 (redone) scope:
//   - AgentLease gains optional readonly claimed_paths: readonly string[]
//   - AgentLease gains optional readonly last_modified_paths: readonly string[]
//   - No lease_version bump; addition is additive on optional properties only.
//   - No predicate added at the kernel layer (the lease substrate is one-
//     file-one-record; the mixed-key problem that motivated isAgentRecord
//     on the agents.json substrate does not exist here).
//
// Subsequent commits land the store-write path (LeasePatch extension +
// leases-store.ts), the CLI surface (caws claim --paths), and the policy
// schema key. None of those are touched here.

import type { AgentLease } from '../../src/worktree/leases';

// ─── A1: existing lease shapes load under the widened interface ──────

describe('SESSION-OWNERSHIP-METADATA-001 A1: existing AgentLease shapes remain valid', () => {
  it('accepts a minimum-required-fields lease with no new fields', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-min',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'session_start',
    };
    expect(lease.claimed_paths).toBeUndefined();
    expect(lease.last_modified_paths).toBeUndefined();
  });

  it('accepts a full pre-amendment lease shape (all optional v1.1.x fields) with no new fields', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-full',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T01:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo/.caws/worktrees/wt-foo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git/worktrees/wt-foo',
      branch: 'caws/wt-foo',
      bound_worktree: 'wt-foo',
      bound_spec_id: 'SPEC-FOO-001',
      pid: 12345,
      hostname: 'example.local',
      session_log_path: '/tmp/repo/tmp/sess-full/session.log',
      hook_pack_version: 4,
      last_seen_reason: 'pre_tool_use',
    };
    // None of the optional v1 fields were touched; the new optional
    // fields are absent.
    expect(lease.bound_spec_id).toBe('SPEC-FOO-001');
    expect(lease.claimed_paths).toBeUndefined();
    expect(lease.last_modified_paths).toBeUndefined();
  });
});

// ─── A2/A3 shape: leases carry the new optional fields ───────────────

describe('SESSION-OWNERSHIP-METADATA-001: AgentLease carries optional ownership metadata', () => {
  it('accepts a lease with claimed_paths populated (A2 shape)', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-claim',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'claim',
      claimed_paths: ['packages/foo/**', 'tests/foo.test.js'],
    };
    expect(lease.claimed_paths).toEqual(['packages/foo/**', 'tests/foo.test.js']);
  });

  it('accepts a lease with last_modified_paths populated (A3 shape)', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-mod',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'pre_tool_use',
      last_modified_paths: ['packages/foo/src/index.ts', 'tests/foo.test.js'],
    };
    expect(lease.last_modified_paths).toEqual([
      'packages/foo/src/index.ts',
      'tests/foo.test.js',
    ]);
  });

  it('accepts a lease with both new fields populated alongside v1 fields', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-both',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      bound_worktree: 'wt-foo',
      bound_spec_id: 'SPEC-FOO-001',
      last_seen_reason: 'claim',
      claimed_paths: ['packages/foo/**'],
      last_modified_paths: ['packages/foo/src/index.ts'],
    };
    expect(lease.claimed_paths).toEqual(['packages/foo/**']);
    expect(lease.last_modified_paths).toEqual([
      'packages/foo/src/index.ts',
    ]);
    expect(lease.bound_spec_id).toBe('SPEC-FOO-001');
  });

  it('accepts an empty claimed_paths array', () => {
    // Empty array is a valid declared state — "I have no claims" is
    // distinguishable from "I haven't declared yet" (undefined).
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-empty',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'claim',
      claimed_paths: [],
    };
    expect(lease.claimed_paths).toEqual([]);
    expect(Array.isArray(lease.claimed_paths)).toBe(true);
  });

  it('accepts an empty last_modified_paths array', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-empty-mod',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'pre_tool_use',
      last_modified_paths: [],
    };
    expect(lease.last_modified_paths).toEqual([]);
  });
});

// ─── A9 (WITHDRAWN) — bound_spec_id no-regression ────────────────────

describe('SESSION-OWNERSHIP-METADATA-001 A9 (WITHDRAWN): AgentLease.bound_spec_id is unchanged', () => {
  // A9 was originally drafted to retrofit bound_spec_id into the
  // legacy AgentRecord. Pre-implementation inspection showed
  // bound_spec_id is already declared in BOTH AgentRecord (now
  // out-of-scope) AND AgentLease (in-scope here at leases.ts:91).
  // A9 is WITHDRAWN; this passive no-regression assertion confirms
  // AgentLease still exposes the field as optional readonly string.

  it('AgentLease exposes bound_spec_id as an optional readonly string', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-bound',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'session_start',
      bound_spec_id: 'SPEC-FOO-001',
    };
    expect(lease.bound_spec_id).toBe('SPEC-FOO-001');
  });

  it('AgentLease without bound_spec_id remains valid', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-unbound',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'session_start',
    };
    expect(lease.bound_spec_id).toBeUndefined();
  });
});

// ─── lease_version discriminator no-regression ───────────────────────

describe('SESSION-OWNERSHIP-METADATA-001: lease_version remains 1 (no bump)', () => {
  // The amendment is additive on optional properties only. The
  // discriminator stays at lease_version: 1 so existing readers,
  // load paths, and the closed MULTI-AGENT-ACTIVITY-REGISTRY-001
  // negative-invariant (lease independence from agents.json)
  // remain valid.

  it('lease_version is the literal 1 (TypeScript-enforced narrow type)', () => {
    const lease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-version',
      platform: 'claude-code',
      status: 'active',
      started_at: '2026-05-22T00:00:00.000Z',
      last_active: '2026-05-22T00:00:00.000Z',
      repo_root: '/tmp/repo',
      cwd: '/tmp/repo',
      git_common_dir: '/tmp/repo/.git',
      git_dir: '/tmp/repo/.git',
      last_seen_reason: 'session_start',
    };
    expect(lease.lease_version).toBe(1);
  });
});
