// AGENT-LIVENESS-DOCTOR-001 (D10) — doctor lease/worktree liveness drift.
//
// Doctor now reads .caws/leases/ (passed in as input.leases by the store) and
// surfaces:
//   - WORKTREE_OWNER_LEASE_MISSING: a registry owner with no live lease.
//   - AGENT_PID_ORACLE_UNRELIABLE: all running leases fresh + pid-stamped.
//   - the loosened ghost rule: fires on worktreeDirByName alone (no git obs).
// Plus the structural agent-lease predicate (a non-lease top-level key must NOT
// become a fake agent finding).
//
// Doctor stays pure: no fs/path/Date.now. Inputs are hand-built. Every lease
// finding is DIAGNOSTIC — its narrowRepair never asserts ownership authority.

import { DOCTOR_RULES, DOCTOR_RULE_PREFIXES, inspectProjectState } from '../../src/doctor';
import type { DoctorInput } from '../../src/doctor';
import type { Spec } from '../../src/spec/types';
import type { WorktreeRegistry } from '../../src/worktree';
import type { LeaseRegistry } from '../../src/worktree';

const NOW = new Date('2026-06-01T10:00:00.000Z');
const STALE_TTL = 24 * 60 * 60 * 1000; // default doctor staleAgentTtlMs

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 'TEST-1',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'feature',
    lifecycle_state: 'active',
    blast_radius: { modules: ['src/test'] },
    scope: { in: ['src/**'] },
    invariants: ['none'],
    acceptance: [{ id: 'A1', given: 'g', when: 'w', then: 't' }],
    non_functional: {},
    contracts: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return { specs: [], now: NOW, ...overrides };
}

function lease(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    lease_version: 1,
    platform: 'claude-code',
    status: 'active',
    started_at: '2026-06-01T09:00:00.000Z',
    last_active: '2026-06-01T09:58:00.000Z', // 2m before NOW → fresh
    repo_root: '/repo',
    cwd: '/repo',
    hostname: 'h',
    ...overrides,
  };
}

function leasesOf(...records: Array<Record<string, unknown>>): LeaseRegistry {
  const map: Record<string, unknown> = {};
  for (const r of records) map[r.session_id as string] = r;
  return map as unknown as LeaseRegistry;
}

function registryOf(entries: Record<string, unknown>): WorktreeRegistry {
  return entries as unknown as WorktreeRegistry;
}

describe('AGENT-LIVENESS-DOCTOR-001 D10 — rule registry', () => {
  test('new rule ids are registered under existing prefixes', () => {
    expect(DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING).toBe(
      'doctor.worktree.owner_lease_missing'
    );
    expect(DOCTOR_RULES.AGENT_PID_ORACLE_UNRELIABLE).toBe(
      'doctor.agent.pid_oracle_unreliable'
    );
    expect(DOCTOR_RULE_PREFIXES).toContain('doctor.worktree.');
    expect(DOCTOR_RULE_PREFIXES).toContain('doctor.agent.');
  });
});

describe('D10 — owner without live lease', () => {
  test('fires WORKTREE_OWNER_LEASE_MISSING when owner has NO lease at all', () => {
    const input = makeInput({
      worktrees: registryOf({
        'wt-a': { specId: 'TEST-1', path: '/repo/.caws/worktrees/wt-a', owner: { session_id: 'owner-AAA' } },
      }),
      leases: leasesOf(), // empty
    });
    const r = inspectProjectState(input);
    const f = r.findings.find((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING);
    expect(f).toBeDefined();
    expect(f!.subject).toBe('wt-a');
    expect(f!.message).toContain('owner-AAA');
    // Diagnostic only — repair must NOT claim cleanup/ownership authority.
    expect(f!.narrowRepair).toMatch(/still authoritative/i);
  });

  test('fires when owner lease is STALE (older than TTL)', () => {
    const input = makeInput({
      worktrees: registryOf({
        'wt-a': { specId: 'TEST-1', owner: { session_id: 'owner-AAA' } },
      }),
      leases: leasesOf(
        lease({ session_id: 'owner-AAA', status: 'active', last_active: '2026-05-30T09:00:00.000Z' }) // 2 days old
      ),
    });
    const r = inspectProjectState(input);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toBe(true);
  });

  test('does NOT fire when owner has a fresh, active lease', () => {
    const input = makeInput({
      worktrees: registryOf({
        'wt-a': { specId: 'TEST-1', owner: { session_id: 'owner-AAA' } },
      }),
      leases: leasesOf(lease({ session_id: 'owner-AAA', status: 'active' })),
    });
    const r = inspectProjectState(input);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toBe(false);
  });

  test('fires when owner lease is STOPPED', () => {
    const input = makeInput({
      worktrees: registryOf({ 'wt-a': { specId: 'TEST-1', owner: { session_id: 'owner-AAA' } } }),
      leases: leasesOf(lease({ session_id: 'owner-AAA', status: 'stopped' })),
    });
    const r = inspectProjectState(input);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toBe(true);
  });
});

describe('D10 — structural agent-lease predicate', () => {
  test('a non-lease top-level key does NOT become a fake agent finding', () => {
    // A metadata sibling (number) + a malformed object lacking session_id/status.
    const leasesWithJunk = {
      version: 1,
      'not-a-lease': { foo: 'bar' },
      'real-AAA': lease({ session_id: 'real-AAA', status: 'active' }),
    } as unknown as LeaseRegistry;
    const input = makeInput({
      worktrees: registryOf({ 'wt-a': { specId: 'TEST-1', owner: { session_id: 'real-AAA' } } }),
      leases: leasesWithJunk,
    });
    const r = inspectProjectState(input);
    // real-AAA is fresh → no owner-lease-missing; and the junk keys produced no
    // findings of their own (they were excluded by the structural predicate).
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toBe(false);
    // No finding should name 'version' or 'not-a-lease' as a subject.
    expect(r.findings.some((x) => x.subject === 'version' || x.subject === 'not-a-lease')).toBe(false);
  });
});

describe('D10 — PID-oracle-unreliable diagnostic', () => {
  test('fires AGENT_PID_ORACLE_UNRELIABLE when all running leases are fresh + pid-stamped', () => {
    const input = makeInput({
      leases: leasesOf(
        lease({ session_id: 's1', status: 'active', pid: 4242 }),
        lease({ session_id: 's2', status: 'active', pid: 5151 })
      ),
    });
    const r = inspectProjectState(input);
    const f = r.findings.find((x) => x.rule === DOCTOR_RULES.AGENT_PID_ORACLE_UNRELIABLE);
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
    expect(f!.narrowRepair).toMatch(/recency-primary/i);
  });

  test('does NOT fire when a running lease is stale (the oracle is not uniformly fresh)', () => {
    const input = makeInput({
      leases: leasesOf(
        lease({ session_id: 's1', status: 'active', pid: 4242 }),
        lease({ session_id: 's2', status: 'active', pid: 5151, last_active: '2026-05-30T09:00:00.000Z' })
      ),
    });
    const r = inspectProjectState(input);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.AGENT_PID_ORACLE_UNRELIABLE)).toBe(false);
  });
});

describe('D10 — loosened ghost rule (fires without git observation)', () => {
  test('WORKTREE_GHOST_REGISTRY_ENTRY fires on worktreeDirByName alone when gitWorktrees is undefined', () => {
    const spec = makeSpec({ id: 'GHOST-1' });
    const input = makeInput({
      specs: [spec],
      worktrees: registryOf({ 'wt-ghost': { specId: 'GHOST-1' } }),
      // dir is gone; NO git observation available (the case that previously
      // silently skipped the check → doctor reported clean on a drifted repo).
      filesystem: {
        cawsDirExists: true,
        specsDirExists: true,
        waiversDirExists: true,
        policyYamlExists: true,
        worktreesJsonExists: true,
        agentsJsonExists: true,
        eventsJsonlExists: true,
        worktreeDirByName: { 'wt-ghost': false },
      },
      // gitWorktrees intentionally undefined
    });
    const r = inspectProjectState(input);
    const f = r.findings.find((x) => x.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY);
    expect(f).toBeDefined();
    expect(f!.subject).toBe('wt-ghost');
    expect(f!.data?.git_worktree_listed).toBeNull(); // git refinement could not run
  });

  test('the drifted shape does NOT report clean (0 findings) — the defect D10 closes', () => {
    const spec = makeSpec({ id: 'GHOST-1' });
    const input = makeInput({
      specs: [spec],
      worktrees: registryOf({
        'wt-ghost': { specId: 'GHOST-1', owner: { session_id: 'gone-AAA' } },
      }),
      leases: leasesOf(), // owner has no lease
      filesystem: {
        cawsDirExists: true, specsDirExists: true, waiversDirExists: true,
        policyYamlExists: true, worktreesJsonExists: true, agentsJsonExists: true,
        eventsJsonlExists: true, worktreeDirByName: { 'wt-ghost': false },
      },
    });
    const r = inspectProjectState(input);
    // Both the ghost entry AND the owner-without-lease fire — not 0E/0W/0I.
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_GHOST_REGISTRY_ENTRY)).toBe(true);
    expect(r.findings.some((x) => x.rule === DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toBe(true);
  });
});
