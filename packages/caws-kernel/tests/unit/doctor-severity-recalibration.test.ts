/**
 * CAWS-DOCTOR-SEVERITY-RECALIBRATION-001
 *
 * Lifecycle-aware severity for doctor.binding.spec_missing_registry.
 *
 * Positive locks (A1, A8): active spec with stale worktree binding
 * remains ERROR. The canonical SESSION-OWNERSHIP-METADATA-001 case
 * is in this class and must continue to surface as ERROR.
 *
 * Negative locks (A2, A3): closed and archived specs with stale
 * worktree bindings emit INFO, not ERROR. The binding residue is
 * dormant and surfaces only as observable state.
 *
 * Fail-safe lock: unknown lifecycle_state values default to ERROR
 * (treat unknown as governance-relevant). This is enforced by the
 * conditional shape — only 'closed' and 'archived' downgrade.
 */

import { DOCTOR_RULES, inspectProjectState } from '../../src/doctor';
import type { DoctorInput } from '../../src/doctor';
import type { Spec } from '../../src/spec/types';
import type { Policy } from '../../src/policy/types';
import type { WorktreeRegistry } from '../../src/worktree';

const NOW = new Date('2026-05-27T22:00:00.000Z');

function makeSpec(overrides: Partial<Spec> = {}): Spec {
  return {
    id: 'TEST-1',
    title: 'Test spec',
    risk_tier: 3,
    mode: 'fix',
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

function makePolicy(): Policy {
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 5, max_loc: 200 },
      '2': { max_files: 15, max_loc: 600 },
      '3': { max_files: 30, max_loc: 1500 },
    },
    gates: {
      budget_limit: { enabled: true, mode: 'block' },
      spec_completeness: { enabled: true, mode: 'block' },
      scope_boundary: { enabled: true, mode: 'block' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
    },
  };
}

function baseInput(specs: readonly Spec[], registry: WorktreeRegistry = {}): DoctorInput {
  return {
    specs,
    policy: makePolicy(),
    worktreeRegistry: registry,
    now: NOW,
  };
}

function findMissingRegistry(findings: ReadonlyArray<{ rule: string; severity: string; subject?: string }>, specId: string) {
  return findings.find(
    (f) => f.rule === DOCTOR_RULES.BINDING_SPEC_MISSING_REGISTRY && f.subject === specId,
  );
}

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A1: active spec → ERROR (positive lock)', () => {
  it('emits binding_spec_missing_registry with severity error for an active spec with stale worktree field', () => {
    const spec = makeSpec({
      id: 'ACTIVE-1',
      lifecycle_state: 'active',
      worktree: 'destroyed-worktree',
    });
    const report = inspectProjectState(baseInput([spec]));

    const f = findMissingRegistry(report.findings, 'ACTIVE-1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A2: closed spec → INFO (negative lock)', () => {
  it('emits binding_spec_missing_registry with severity info for a closed spec with stale worktree field', () => {
    const spec = makeSpec({
      id: 'CLOSED-1',
      lifecycle_state: 'closed',
      worktree: 'destroyed-worktree',
      resolution: 'completed',
    });
    const report = inspectProjectState(baseInput([spec]));

    const f = findMissingRegistry(report.findings, 'CLOSED-1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A3: archived spec → INFO (negative lock)', () => {
  it('emits binding_spec_missing_registry with severity info for an archived spec with stale worktree field', () => {
    const spec = makeSpec({
      id: 'ARCHIVED-1',
      lifecycle_state: 'archived',
      worktree: 'destroyed-worktree',
      resolution: 'completed',
    });
    const report = inspectProjectState(baseInput([spec]));

    const f = findMissingRegistry(report.findings, 'ARCHIVED-1');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('info');
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A1+A8: canonical-class case preservation', () => {
  it('the canonical-class case (active spec, stale binding, missing registry) is ERROR', () => {
    // Mirrors the canonical SESSION-OWNERSHIP-METADATA-001 shape:
    // active spec, worktree field set to a destroyed worktree name,
    // registry has no entry for that name.
    const spec = makeSpec({
      id: 'SESSION-OWNERSHIP-METADATA-001',
      lifecycle_state: 'active',
      worktree: 'session-ownership-metadata',
    });
    const report = inspectProjectState(baseInput([spec]));

    const f = findMissingRegistry(report.findings, 'SESSION-OWNERSHIP-METADATA-001');
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
    // ERROR count must include this finding.
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A7: unchanged sibling rules', () => {
  it('binding_one_sided severity is unchanged (still error) for active spec → registry without specId', () => {
    const spec = makeSpec({
      id: 'ONESIDED-1',
      lifecycle_state: 'active',
      worktree: 'one-sided-wt',
    });
    const registry: WorktreeRegistry = {
      'one-sided-wt': {
        name: 'one-sided-wt',
        path: '/tmp/one-sided-wt',
        branch: 'one-sided-wt',
        // no specId — this triggers BINDING_ONE_SIDED
      },
    };
    const report = inspectProjectState(baseInput([spec], registry));

    const f = report.findings.find(
      (x) => x.rule === DOCTOR_RULES.BINDING_ONE_SIDED && x.subject === 'ONESIDED-1',
    );
    expect(f).toBeDefined();
    expect(f!.severity).toBe('error');
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001: data block includes lifecycle_state', () => {
  it('binding_spec_missing_registry data block carries lifecycle_state for downstream observers', () => {
    const spec = makeSpec({
      id: 'DATA-CHECK-1',
      lifecycle_state: 'closed',
      worktree: 'destroyed-wt',
      resolution: 'completed',
    });
    const report = inspectProjectState(baseInput([spec]));

    const f = findMissingRegistry(report.findings, 'DATA-CHECK-1');
    expect(f).toBeDefined();
    const data = (f as { data?: Record<string, unknown> }).data ?? {};
    expect(data.lifecycle_state).toBe('closed');
    expect(data.spec_id).toBe('DATA-CHECK-1');
    expect(data.worktree_name).toBe('destroyed-wt');
  });
});
