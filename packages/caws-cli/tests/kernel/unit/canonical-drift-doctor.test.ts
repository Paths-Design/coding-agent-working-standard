/**
 * CANONICAL-DRIFT-GUARDS-001 — the pure mis-parked-head doctor finding
 * (A1 fire / A2 suppress), kernel-side. The store wiring + command
 * behavior (doctor e2e, create refusal, relocate) live in
 * tests/shell/canonical-drift.test.js.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import type { DoctorInput } from '../../../src/kernel/doctor/types';

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    specs: [],
    now: new Date('2026-08-24T12:00:00.000Z'),
    ...overrides,
  } as DoctorInput;
}

const REGISTRY_WITH_WORKTREE = {
  'wt-demo': {
    branch: 'wt-demo',
    baseBranch: 'main',
    specId: 'SPEC-001',
    path: '/repo/.caws/worktrees/wt-demo',
  },
};

describe('doctor.canonical.mis_parked_head (CANONICAL-DRIFT-GUARDS-001)', () => {
  test('A1: parked HEAD + active worktree => WARN finding naming both branches + repair', () => {
    const findings = inspectProjectState(input({
      worktrees: REGISTRY_WITH_WORKTREE,
      canonicalBranchObservation: { currentBranch: 'feat/other', baseBranch: 'main' },
    })).findings;

    const hit = findings.find((f) => f.rule === 'doctor.canonical.mis_parked_head');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('warning');
    expect(hit!.message).toContain('feat/other');
    expect(hit!.message).toContain('main');
    expect((hit!.data as Record<string, unknown>).current_branch).toBe('feat/other');
    expect((hit!.data as Record<string, unknown>).base_branch).toBe('main');
    expect(hit!.narrowRepair).toContain('caws specs relocate <id> --to-base');
    expect(hit!.narrowRepair).toContain('--allow-foreign-branch');
  });

  test('A2a: zero worktrees => no finding (idle repo parked anywhere is not drift)', () => {
    const findings = inspectProjectState(input({
      worktrees: {},
      canonicalBranchObservation: { currentBranch: 'feat/other', baseBranch: 'main' },
    })).findings;
    expect(findings.find((f) => f.rule === 'doctor.canonical.mis_parked_head')).toBeUndefined();
  });

  test('A2b: HEAD on base => no finding (healthy state)', () => {
    const findings = inspectProjectState(input({
      worktrees: REGISTRY_WITH_WORKTREE,
      canonicalBranchObservation: { currentBranch: 'main', baseBranch: 'main' },
    })).findings;
    expect(findings.find((f) => f.rule === 'doctor.canonical.mis_parked_head')).toBeUndefined();
  });

  test('A2c: observation absent => no finding (missing != malformed; kernel skips)', () => {
    const findings = inspectProjectState(input({
      worktrees: REGISTRY_WITH_WORKTREE,
    })).findings;
    expect(findings.find((f) => f.rule === 'doctor.canonical.mis_parked_head')).toBeUndefined();
  });
});
