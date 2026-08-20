/**
 * CAWS-DEFECT-DOCTOR-FROZEN-AGENTS-LIVENESS-01 — agents.json is not liveness.
 *
 * `.caws/agents.json` is frozen compatibility metadata under
 * MULTI-AGENT-ACTIVITY-REGISTRY-001; store/agents-store.ts states it plainly:
 * "No new code reads or writes this file", with loadAgents() surviving only
 * for the legacy claim path and for `caws status` display WHEN NO LEASES EXIST.
 * Doctor read it anyway and emitted one `doctor.agent.stale_display_only`
 * warning per record — findings whose own repair text was "No automatic
 * action."
 *
 * On this repo that was 13 of 21 warnings, and because `caws agents prune`
 * reads `.caws/leases/`, nine of them named sessions that no command in the
 * surface could reach. Un-dischargeable by construction.
 *
 * This is the same burial dynamic already pinned in
 * doctor-unbound-active-backlog.test.ts: findings nobody can act on hide the
 * ones somebody must.
 *
 * Agent liveness is derived from `.caws/leases/` by the structural lease
 * predicate in inspect.ts §3b, which distinguishes `stopped` (a deliberate
 * terminal state) from `stale` (TTL lapse) — a distinction the agents.json
 * loop never made, which is why it called every stopped session stale.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput } from '../../../src/kernel/doctor/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');
/** Two weeks before NOW — past any plausible agent stale TTL. */
const LONG_STALE = '2026-06-01T00:00:00.000Z';
/** One minute before NOW — comfortably inside the TTL. */
const FRESH = '2026-06-15T11:59:00.000Z';

/**
 * Matched as a string literal rather than through DOCTOR_RULES: this slice
 * removes the constant, and the pin must outlive that removal so it keeps
 * meaning "doctor emits no finding carrying this id" rather than failing to
 * compile.
 */
const STALE_DISPLAY_ONLY = 'doctor.agent.stale_display_only';

function lease(
  sessionId: string,
  status: 'active' | 'stopping' | 'stopped',
  lastActive: string
) {
  return {
    lease_version: 1,
    session_id: sessionId,
    platform: 'claude-code',
    status,
    started_at: lastActive,
    last_active: lastActive,
    repo_root: '/repo',
    cwd: '/repo',
    git_common_dir: '/repo/.git',
    git_dir: '/repo/.git',
    last_seen_reason: 'session_start',
  };
}

function report(input: Partial<DoctorInput> = {}) {
  return inspectProjectState({
    now: NOW,
    worktrees: {},
    specs: [],
    ...input,
  } as DoctorInput);
}

function findings(r: ReturnType<typeof inspectProjectState>, rule: string) {
  return r.findings.filter((f) => f.rule === rule);
}

describe('CAWS-DEFECT-DOCTOR-FROZEN-AGENTS-LIVENESS-01 — agents.json sources no finding', () => {
  test('A1: long-stale agents.json records produce no stale_display_only finding', () => {
    const r = report({
      agents: {
        'sess-a': { session_id: 'sess-a', last_active: LONG_STALE },
        'sess-b': { session_id: 'sess-b', last_active: LONG_STALE },
        'sess-c': { session_id: 'sess-c', last_active: LONG_STALE },
      } as unknown as DoctorInput['agents'],
      leases: {
        'sess-live': lease('sess-live', 'active', FRESH),
      } as unknown as DoctorInput['leases'],
    });

    expect(findings(r, STALE_DISPLAY_ONLY)).toEqual([]);
    // Nothing anywhere in the report may name an agents.json-only session.
    expect(r.findings.map((f) => f.subject)).not.toContain('sess-a');
  });

  test('A1 non-vacuous: the same timestamp IS past the TTL on the lease path', () => {
    // Guards against A1 passing merely because LONG_STALE drifted inside the
    // TTL. The identical value, carried by a lease backing a worktree owner,
    // must still be classified as not-live.
    const r = report({
      worktrees: {
        'wt-a': { owner: { session_id: 'sess-owner' } },
      } as unknown as DoctorInput['worktrees'],
      leases: {
        'sess-owner': lease('sess-owner', 'active', LONG_STALE),
      } as unknown as DoctorInput['leases'],
    });

    expect(findings(r, DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toHaveLength(1);
  });

  test('A2: lease-sourced owner diagnostics are unchanged — a live owner is not flagged', () => {
    const r = report({
      worktrees: {
        'wt-a': { owner: { session_id: 'sess-owner' } },
      } as unknown as DoctorInput['worktrees'],
      leases: {
        'sess-owner': lease('sess-owner', 'active', FRESH),
      } as unknown as DoctorInput['leases'],
    });

    expect(findings(r, DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toEqual([]);
  });

  test('A2: a stopped owner lease is still flagged, and stopped is not called stale', () => {
    const r = report({
      worktrees: {
        'wt-a': { owner: { session_id: 'sess-owner' } },
      } as unknown as DoctorInput['worktrees'],
      leases: {
        // Fresh heartbeat but deliberately stopped: the agents.json loop had
        // no way to tell these apart and would have called it stale.
        'sess-owner': lease('sess-owner', 'stopped', FRESH),
      } as unknown as DoctorInput['leases'],
    });

    expect(findings(r, DOCTOR_RULES.WORKTREE_OWNER_LEASE_MISSING)).toHaveLength(1);
    expect(findings(r, STALE_DISPLAY_ONLY)).toEqual([]);
  });
});
