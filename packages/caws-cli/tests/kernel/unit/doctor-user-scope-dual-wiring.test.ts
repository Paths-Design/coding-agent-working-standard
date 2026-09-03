/**
 * CAWS-GATED-SURFACE-SCOPE-GUARD-001 A4 — doctor.hooks.user_scope_dual_wiring.
 *
 * The rule fires exactly when a trust-gated surface (qwen-code, zcode)
 * appears in BOTH observations: user-scope CAWS wiring on the machine and
 * CAWS hook entries in the project-scope config. One-sided wiring is the
 * CORRECT state for gated surfaces (user-only is the recommended posture;
 * project-only is the pre-guard install) — never a finding. Undefined
 * observations are unobserved (silent), matching the hookPackInstalled
 * convention. The store-side observation itself (observeGatedSurfaceWiring)
 * is covered by the init suite's detection tests.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput } from '../../../src/kernel/doctor/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');

type FsObs = NonNullable<DoctorInput['filesystem']>;
function fsObs(partial: Record<string, unknown>): FsObs {
  return partial as unknown as FsObs;
}

function rules(report: ReturnType<typeof inspectProjectState>): string[] {
  return report.findings.map((f) => f.rule);
}

function input(fs: FsObs): DoctorInput {
  return { now: NOW, specs: [], filesystem: fs };
}

describe('doctor.hooks.user_scope_dual_wiring (CAWS-GATED-SURFACE-SCOPE-GUARD-001)', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING).toBe(
      'doctor.hooks.user_scope_dual_wiring'
    );
  });

  test('same surface in BOTH observations fires the warning with both lists in data', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          userScopeCawsWiringBySurface: ['qwen-code'],
          gatedProjectHookEntriesBySurface: ['qwen-code'],
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING);
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({ dual_wired_surfaces: ['qwen-code'] });
    // The repair names the one-scope posture, never a blind delete.
    expect(finding?.narrowRepair).toContain('user-scope');
  });

  test('fires per overlapping surface; disjoint surfaces do not fire it', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          // qwen dual-wired; zcode only user-scope (correct posture).
          userScopeCawsWiringBySurface: ['qwen-code', 'zcode'],
          gatedProjectHookEntriesBySurface: ['qwen-code'],
        })
      )
    );
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING
    );
    expect(finding?.data).toMatchObject({ dual_wired_surfaces: ['qwen-code'] });
  });

  test('user-scope only (the recommended posture) stays silent', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          userScopeCawsWiringBySurface: ['qwen-code', 'zcode'],
          gatedProjectHookEntriesBySurface: [],
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING);
  });

  test('project-scope only (pre-guard install) stays silent', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          userScopeCawsWiringBySurface: [],
          gatedProjectHookEntriesBySurface: ['qwen-code'],
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING);
  });

  test('unobserved sides (older snapshot writers) stay silent', () => {
    const onlyUser = fsObs({ userScopeCawsWiringBySurface: ['qwen-code'] });
    const onlyProject = fsObs({ gatedProjectHookEntriesBySurface: ['qwen-code'] });
    const neither = fsObs({});
    for (const fs of [onlyUser, onlyProject, neither]) {
      expect(rules(inspectProjectState(input(fs)))).not.toContain(
        DOCTOR_RULES.HOOKS_USER_SCOPE_DUAL_WIRING
      );
    }
  });
});
