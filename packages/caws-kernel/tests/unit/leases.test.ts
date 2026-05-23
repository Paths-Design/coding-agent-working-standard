// Unit tests for the pure agent-lease kernel module.
//
// MULTI-AGENT-ACTIVITY-REGISTRY-001 acceptance A1–A4.
//
// These tests exercise the transformer directly with parsed object inputs.
// The store layer's read-then-transform pipeline and shell layer's
// context-composition are exercised in the CLI test suite; this file
// proves the kernel is pure, deterministic, and time-injected.

import {
  LEASE_RULES,
  registerAgentSession,
  heartbeatAgentSession,
  stopAgentSession,
  summarizeActiveAgents,
  type ActivitySummary,
  type AgentLease,
  type LeaseContext,
  type LeasePatch,
  type LeaseRegistry,
} from '../../src/worktree/leases';
import { isOk } from '../../src/result';
import type { SessionIdentity } from '../../src/worktree/types';

// ─── helpers ──────────────────────────────────────────────────────────────

const NOW_T0 = new Date('2026-05-23T10:00:00.000Z');
const NOW_T1 = new Date('2026-05-23T10:00:30.000Z'); // 30s after T0
const NOW_T2 = new Date('2026-05-23T10:05:00.000Z'); // 5m after T0

function session(id: string, platform = 'claude-code'): SessionIdentity {
  return { session_id: id, platform };
}

function fullContext(overrides: Partial<LeaseContext> = {}): LeaseContext {
  return {
    repo_root: '/test/repo',
    cwd: '/test/repo/.caws/worktrees/test-wt',
    git_common_dir: '/test/repo/.git',
    git_dir: '/test/repo/.git/worktrees/test-wt',
    branch: 'test-branch',
    bound_worktree: 'test-wt',
    bound_spec_id: 'TEST-SPEC-001',
    pid: 12345,
    hostname: 'test-host',
    hook_pack_version: 3,
    ...overrides,
  };
}

function expectLease(
  patch: LeasePatch
): asserts patch is Extract<LeasePatch, { kind: 'write_lease' }> {
  if (patch.kind !== 'write_lease') {
    throw new Error(`expected write_lease patch, got '${patch.kind}'`);
  }
}

function expectStopped(
  patch: LeasePatch
): asserts patch is Extract<LeasePatch, { kind: 'mark_stopped' }> {
  if (patch.kind !== 'mark_stopped') {
    throw new Error(`expected mark_stopped patch, got '${patch.kind}'`);
  }
}

// ─── A1: kernel surface invariants ────────────────────────────────────────

describe('leases module surface (A1)', () => {
  it('exposes the documented public functions', () => {
    expect(typeof registerAgentSession).toBe('function');
    expect(typeof heartbeatAgentSession).toBe('function');
    expect(typeof stopAgentSession).toBe('function');
    expect(typeof summarizeActiveAgents).toBe('function');
  });

  it('exposes LEASE_RULES constants', () => {
    expect(LEASE_RULES.SESSION_INVALID).toBe('kernel.lease.session_invalid');
    expect(LEASE_RULES.CONTEXT_INVALID).toBe('kernel.lease.context_invalid');
    expect(LEASE_RULES.STATUS_UNEXPECTED).toBe('kernel.lease.status_unexpected');
  });

  it('purity: leases module source contains no fs / process / net imports', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'worktree', 'leases.ts'),
      'utf8'
    );
    // Allow type imports from kernel internals; block fs/net/process imports.
    expect(source).not.toMatch(/from\s+['"]fs['"]/);
    expect(source).not.toMatch(/from\s+['"]node:fs['"]/);
    expect(source).not.toMatch(/require\(['"]fs['"]\)/);
    expect(source).not.toMatch(/from\s+['"]child_process['"]/);
    expect(source).not.toMatch(/from\s+['"]node:child_process['"]/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/process\.cwd/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/from\s+['"]https?['"]/);
    expect(source).not.toMatch(/from\s+['"]node:https?['"]/);
  });

  it('LeasePatch is a separate type from RegistryPatch (no shared union)', () => {
    // Static evidence: the leases module file does NOT IMPORT RegistryPatch
    // and does NOT extend or alias it. The worktree/types.ts file does NOT
    // mention LeasePatch at all. References to "RegistryPatch" in DOC
    // COMMENTS within leases.ts are permitted (and encouraged — they
    // document the boundary).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const leasesSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'worktree', 'leases.ts'),
      'utf8'
    );
    const typesSource = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'worktree', 'types.ts'),
      'utf8'
    );
    // 1. leases.ts MUST NOT import RegistryPatch.
    expect(leasesSource).not.toMatch(/import\s+[^;]*RegistryPatch/);
    expect(leasesSource).not.toMatch(/import\s*type\s+[^;]*RegistryPatch/);
    // 2. leases.ts MUST NOT extend or alias RegistryPatch as a type.
    expect(leasesSource).not.toMatch(/extends\s+RegistryPatch/);
    expect(leasesSource).not.toMatch(/=\s*RegistryPatch/);
    // 3. types.ts (canonical RegistryPatch home) MUST NOT mention LeasePatch.
    expect(typesSource).not.toMatch(/LeasePatch/);
  });
});

// ─── A1: AgentLease shape invariants ──────────────────────────────────────

describe('AgentLease shape (A1)', () => {
  it('lease_version is the literal 1', () => {
    const r = registerAgentSession({}, session('sess-1'), fullContext(), NOW_T0, 'session_start');
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectLease(r.value);
    expect(r.value.lease.lease_version).toBe(1);
  });

  it('status is strictly active|stopping|stopped — never stale on disk', () => {
    const r = registerAgentSession({}, session('sess-1'), fullContext(), NOW_T0, 'session_start');
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectLease(r.value);
    // Type-level: TS would refuse anything outside the enum, but we also
    // assert at runtime that 'stale' is never written.
    expect(['active', 'stopping', 'stopped']).toContain(r.value.lease.status);
    expect(r.value.lease.status).not.toBe('stale');
  });

  it('platform falls back to "unknown" when session.platform is omitted', () => {
    const r = registerAgentSession(
      {},
      { session_id: 'sess-1' },
      fullContext(),
      NOW_T0,
      'session_start'
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectLease(r.value);
    expect(r.value.lease.platform).toBe('unknown');
  });
});

// ─── A2: registerAgentSession upsert semantics ────────────────────────────

describe('registerAgentSession (A2)', () => {
  it('first registration creates lease with started_at = now', () => {
    const r = registerAgentSession({}, session('sess-A'), fullContext(), NOW_T0, 'session_start');
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectLease(r.value);
    expect(r.value.lease.started_at).toBe(NOW_T0.toISOString());
    expect(r.value.lease.last_active).toBe(NOW_T0.toISOString());
    expect(r.value.lease.status).toBe('active');
    expect(r.value.session_id).toBe('sess-A');
  });

  it('re-registration preserves started_at, updates last_active', () => {
    const initial = registerAgentSession(
      {},
      session('sess-A'),
      fullContext(),
      NOW_T0,
      'session_start'
    );
    if (!isOk(initial)) throw new Error('initial register failed');
    expectLease(initial.value);
    const existing: LeaseRegistry = { 'sess-A': initial.value.lease };

    // Second registration at T1 — different context (new cwd, branch).
    const second = registerAgentSession(
      existing,
      session('sess-A'),
      fullContext({ cwd: '/test/repo/other-cwd', branch: 'new-branch' }),
      NOW_T1,
      'session_start'
    );
    expect(isOk(second)).toBe(true);
    if (!isOk(second)) return;
    expectLease(second.value);
    expect(second.value.lease.started_at).toBe(NOW_T0.toISOString()); // PRESERVED
    expect(second.value.lease.last_active).toBe(NOW_T1.toISOString()); // UPDATED
    expect(second.value.lease.cwd).toBe('/test/repo/other-cwd'); // UPDATED
    expect(second.value.lease.branch).toBe('new-branch'); // UPDATED
    expect(second.value.lease.status).toBe('active');
  });

  it('input registry is not mutated', () => {
    const initial = registerAgentSession(
      {},
      session('sess-A'),
      fullContext(),
      NOW_T0,
      'session_start'
    );
    if (!isOk(initial)) throw new Error('initial register failed');
    expectLease(initial.value);
    const registry: LeaseRegistry = { 'sess-A': initial.value.lease };
    const snapshot = JSON.parse(JSON.stringify(registry)) as LeaseRegistry;

    registerAgentSession(registry, session('sess-A'), fullContext(), NOW_T1, 'pre_tool_use');
    expect(registry).toEqual(snapshot);
  });

  it('rejects invalid session identity', () => {
    const r = registerAgentSession({}, { session_id: '' }, fullContext(), NOW_T0, 'session_start');
    expect(isOk(r)).toBe(false);
  });

  it('rejects invalid context (empty git_common_dir)', () => {
    const r = registerAgentSession(
      {},
      session('sess-A'),
      fullContext({ git_common_dir: '' }),
      NOW_T0,
      'session_start'
    );
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.errors[0]?.rule).toBe(LEASE_RULES.CONTEXT_INVALID);
  });

  it('rejects invalid context (missing git_dir)', () => {
    const r = registerAgentSession(
      {},
      session('sess-A'),
      fullContext({ git_dir: '' }),
      NOW_T0,
      'session_start'
    );
    expect(isOk(r)).toBe(false);
    if (isOk(r)) return;
    expect(r.errors[0]?.rule).toBe(LEASE_RULES.CONTEXT_INVALID);
  });

  it('omits optional fields when context omits them', () => {
    const r = registerAgentSession(
      {},
      session('sess-A'),
      {
        repo_root: '/test/repo',
        cwd: '/test/repo',
        git_common_dir: '/test/repo/.git',
        git_dir: '/test/repo/.git',
        // branch, bound_*, pid, hostname, etc. omitted
      },
      NOW_T0,
      'session_start'
    );
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectLease(r.value);
    expect('branch' in r.value.lease).toBe(false);
    expect('bound_worktree' in r.value.lease).toBe(false);
    expect('bound_spec_id' in r.value.lease).toBe(false);
    expect('pid' in r.value.lease).toBe(false);
    expect('hostname' in r.value.lease).toBe(false);
    expect('hook_pack_version' in r.value.lease).toBe(false);
  });
});

// ─── A3: heartbeat + stop semantics ───────────────────────────────────────

describe('heartbeatAgentSession (A3)', () => {
  it('behaves identically to register for first call', () => {
    const reg = registerAgentSession({}, session('sess-A'), fullContext(), NOW_T0, 'session_start');
    const hb = heartbeatAgentSession({}, session('sess-A'), fullContext(), NOW_T0, 'session_start');
    expect(isOk(reg)).toBe(true);
    expect(isOk(hb)).toBe(true);
    if (!isOk(reg) || !isOk(hb)) return;
    expect(JSON.stringify(reg.value)).toEqual(JSON.stringify(hb.value));
  });

  it('preserves started_at across heartbeats', () => {
    const initial = registerAgentSession(
      {},
      session('sess-A'),
      fullContext(),
      NOW_T0,
      'session_start'
    );
    if (!isOk(initial)) throw new Error('initial register failed');
    expectLease(initial.value);
    const existing: LeaseRegistry = { 'sess-A': initial.value.lease };

    const hb = heartbeatAgentSession(
      existing,
      session('sess-A'),
      fullContext(),
      NOW_T1,
      'pre_tool_use'
    );
    expect(isOk(hb)).toBe(true);
    if (!isOk(hb)) return;
    expectLease(hb.value);
    expect(hb.value.lease.started_at).toBe(NOW_T0.toISOString());
    expect(hb.value.lease.last_active).toBe(NOW_T1.toISOString());
    expect(hb.value.lease.last_seen_reason).toBe('pre_tool_use');
    expect(hb.value.lease.status).toBe('active');
  });

  it('reactivates a previously-stopped lease (status → active)', () => {
    const stoppedLease: AgentLease = {
      lease_version: 1,
      session_id: 'sess-A',
      platform: 'claude-code',
      status: 'stopped',
      started_at: NOW_T0.toISOString(),
      last_active: NOW_T0.toISOString(),
      stopped_at: NOW_T1.toISOString(),
      repo_root: '/test/repo',
      cwd: '/test/repo',
      git_common_dir: '/test/repo/.git',
      git_dir: '/test/repo/.git',
      last_seen_reason: 'session_stop',
    };
    const existing: LeaseRegistry = { 'sess-A': stoppedLease };

    const hb = heartbeatAgentSession(
      existing,
      session('sess-A'),
      fullContext(),
      NOW_T2,
      'pre_tool_use'
    );
    expect(isOk(hb)).toBe(true);
    if (!isOk(hb)) return;
    expectLease(hb.value);
    expect(hb.value.lease.status).toBe('active'); // reactivated
    expect(hb.value.lease.started_at).toBe(NOW_T0.toISOString()); // preserved
  });
});

describe('stopAgentSession (A3)', () => {
  it('returns a mark_stopped patch with transitioned_at', () => {
    const r = stopAgentSession({}, session('sess-A'), NOW_T2);
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expectStopped(r.value);
    expect(r.value.session_id).toBe('sess-A');
    expect(r.value.transitioned_at).toBe(NOW_T2.toISOString());
  });

  it('does NOT emit a write_lease patch — store interprets mark_stopped', () => {
    const r = stopAgentSession({}, session('sess-A'), NOW_T2);
    if (!isOk(r)) return;
    // The kernel returns mark_stopped, NOT write_lease. The store layer
    // is responsible for materializing the differential update.
    expect(r.value.kind).toBe('mark_stopped');
    expect(r.value.kind).not.toBe('write_lease');
  });

  it('rejects invalid session identity', () => {
    const r = stopAgentSession({}, { session_id: '' }, NOW_T2);
    expect(isOk(r)).toBe(false);
  });
});

// ─── A4: summarizeActiveAgents bucketing ──────────────────────────────────

describe('summarizeActiveAgents (A4)', () => {
  function lease(overrides: Partial<AgentLease> & Pick<AgentLease, 'session_id'>): AgentLease {
    return {
      lease_version: 1,
      platform: 'claude-code',
      status: 'active',
      started_at: NOW_T0.toISOString(),
      last_active: NOW_T0.toISOString(),
      repo_root: '/test/repo',
      cwd: '/test/repo',
      git_common_dir: '/test/repo/.git',
      git_dir: '/test/repo/.git',
      last_seen_reason: 'session_start',
      ...overrides,
    } as AgentLease;
  }

  it('classifies active / stale / stopped according to TTL', () => {
    const TEN_SECONDS = 10_000;
    const FIVE_MINUTES = 5 * 60 * 1000;
    const ONE_MINUTE = 60_000;

    const NOW = new Date(NOW_T0.getTime() + FIVE_MINUTES + ONE_MINUTE); // T0 + 6m

    const registry: LeaseRegistry = {
      A: lease({
        session_id: 'A',
        status: 'active',
        last_active: new Date(NOW.getTime() - TEN_SECONDS).toISOString(),
      }),
      B: lease({
        session_id: 'B',
        status: 'active',
        last_active: new Date(NOW.getTime() - FIVE_MINUTES).toISOString(),
      }),
      C: lease({
        session_id: 'C',
        status: 'stopped',
        last_active: NOW_T0.toISOString(),
      }),
    };

    const summary = summarizeActiveAgents(registry, NOW, ONE_MINUTE);
    expect(summary.total).toBe(3);
    expect(summary.active.map((l) => l.session_id)).toEqual(['A']);
    expect(summary.stale.map((l) => l.session_id)).toEqual(['B']);
    expect(summary.stopped.map((l) => l.session_id)).toEqual(['C']);
  });

  it('returns the same result for identical inputs across calls (deterministic)', () => {
    const registry: LeaseRegistry = {
      A: lease({ session_id: 'A', status: 'active', last_active: NOW_T0.toISOString() }),
    };
    const s1 = summarizeActiveAgents(registry, NOW_T1, 60_000);
    const s2 = summarizeActiveAgents(registry, NOW_T1, 60_000);
    expect(JSON.stringify(s1)).toEqual(JSON.stringify(s2));
  });

  it('does NOT mutate the input registry (no write side effect)', () => {
    const registry: LeaseRegistry = {
      A: lease({ session_id: 'A', status: 'active', last_active: NOW_T0.toISOString() }),
      B: lease({ session_id: 'B', status: 'active', last_active: NOW_T0.toISOString() }),
    };
    const snapshot = JSON.parse(JSON.stringify(registry)) as LeaseRegistry;

    // Far-future now — both would be stale.
    summarizeActiveAgents(registry, new Date('2030-01-01T00:00:00.000Z'), 60_000);

    expect(registry).toEqual(snapshot);
  });

  it('treats unparseable last_active as stale (does not crash)', () => {
    const bad: AgentLease = {
      lease_version: 1,
      session_id: 'BAD',
      platform: 'claude-code',
      status: 'active',
      started_at: NOW_T0.toISOString(),
      last_active: 'not a real ISO date',
      repo_root: '/test/repo',
      cwd: '/test/repo',
      git_common_dir: '/test/repo/.git',
      git_dir: '/test/repo/.git',
      last_seen_reason: 'session_start',
    };
    const summary = summarizeActiveAgents({ BAD: bad }, NOW_T1, 60_000);
    expect(summary.stale.map((l) => l.session_id)).toEqual(['BAD']);
    expect(summary.total).toBe(1);
  });

  it('classifies stopping leases identically to active for TTL bucketing', () => {
    // 'stopping' is an in-flight transition; if heartbeating, treat as
    // active; if stale, treat as stale. Only 'stopped' is terminal.
    const registry: LeaseRegistry = {
      A: {
        lease_version: 1,
        session_id: 'A',
        platform: 'claude-code',
        status: 'stopping',
        started_at: NOW_T0.toISOString(),
        last_active: NOW_T0.toISOString(),
        repo_root: '/test/repo',
        cwd: '/test/repo',
        git_common_dir: '/test/repo/.git',
        git_dir: '/test/repo/.git',
        last_seen_reason: 'session_stop',
      },
    };
    // Recent → active.
    const recent = summarizeActiveAgents(
      registry,
      new Date(NOW_T0.getTime() + 1000),
      60_000
    );
    expect(recent.active.length).toBe(1);
    expect(recent.stopped.length).toBe(0);
    // Old → stale.
    const old = summarizeActiveAgents(
      registry,
      new Date(NOW_T0.getTime() + 120_000),
      60_000
    );
    expect(old.stale.length).toBe(1);
    expect(old.stopped.length).toBe(0);
  });

  it('handles empty registry', () => {
    const s = summarizeActiveAgents({}, NOW_T1, 60_000);
    expect(s.total).toBe(0);
    expect(s.active).toEqual([]);
    expect(s.stale).toEqual([]);
    expect(s.stopped).toEqual([]);
  });
});

// ─── apply-patch.ts isolation invariant (LeasePatch ≠ RegistryPatch) ─────

describe('LeasePatch / RegistryPatch separation (A5 prep)', () => {
  it('apply-patch.ts in CLI store does NOT handle LeasePatch kinds', () => {
    // This is a static-evidence test: the CLI's apply-patch.ts file MUST
    // NOT contain any of the LeasePatch kind strings. The CLI store layer
    // owns LeasePatch via leases-store.ts (separate apply path).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const applyPatchPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'caws-cli',
      'src',
      'store',
      'apply-patch.ts'
    );
    // If the CLI store file doesn't exist (shouldn't happen in this
    // monorepo), skip the assertion — the test exists to catch
    // accidental coupling, not to require the file's presence.
    if (!fs.existsSync(applyPatchPath)) return;
    const source = fs.readFileSync(applyPatchPath, 'utf8');
    expect(source).not.toMatch(/['"]write_lease['"]/);
    expect(source).not.toMatch(/['"]mark_stopped['"]/);
    expect(source).not.toMatch(/['"]delete_lease['"]/);
  });
});
