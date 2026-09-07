/**
 * CAWS-DEFECT-STALE-INSTALLED-GUARD-PLANE-01 —
 * doctor.hooks.installed_pack_version_lag.
 *
 * The guard plane is the CLI's runtime: a repo whose installed .caws/hooks
 * pack lags the shipping SHARED_PACK_VERSION is enforcing with code the repo
 * no longer contains (observed live: v43 installed vs v53 shipped, including
 * a pre-PID-anchor session-id.sh whose removed capsule tier was still live).
 *
 * The rule fires exactly when BOTH observations exist and installed <
 * shipping; matching or newer-installed versions are silent, and either
 * side undefined is unobserved (silent), matching the house convention.
 * DIAGNOSE ONLY: pure kernel function over the snapshot — no I/O, no
 * mutation (deep-frozen input survives inspection).
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

describe('doctor.hooks.installed_pack_version_lag (CAWS-DEFECT-STALE-INSTALLED-GUARD-PLANE-01)', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG).toBe(
      'doctor.hooks.installed_pack_version_lag'
    );
  });

  test('installed below shipping fires the warning with both versions in data', () => {
    const report = inspectProjectState(
      input(fsObs({ installedSharedPackVersion: 43, shippingSharedPackVersion: 53 }))
    );
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({ installed_version: 43, shipping_version: 53 });
    // The repair names the sanctioned refresh path, never a hand-edit.
    expect(finding?.narrowRepair).toContain('caws init');
  });

  test('a ten-version lag (the observed defect) fires exactly as any other lag', () => {
    const report = inspectProjectState(
      input(fsObs({ installedSharedPackVersion: 43, shippingSharedPackVersion: 53 }))
    );
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG
    );
    expect(finding?.data).toMatchObject({ installed_version: 43 });
  });

  test('matching versions stay silent', () => {
    const report = inspectProjectState(
      input(fsObs({ installedSharedPackVersion: 53, shippingSharedPackVersion: 53 }))
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });

  test('system runtime replaces copied pack lag with runtime and residual registration findings', () => {
    const report = inspectProjectState(input(fsObs({
      installedSharedPackVersion: 1, shippingSharedPackVersion: 56,
      systemRuntime: { surfaces: ['codex'], legacySurfaces: ['claude-code'], overrides: ['codex:handlers:custom.sh'], digest: 'a'.repeat(64) },
    })));
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_SYSTEM_RUNTIME);
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_SYSTEM_LEGACY_WIRING);
  });

  test('a broken system runtime is an error even if copied packs match shipping', () => {
    const report = inspectProjectState(input(fsObs({
      installedSharedPackVersion: 56, shippingSharedPackVersion: 56,
      systemRuntime: { surfaces: ['codex'], legacySurfaces: [], overrides: [], error: 'Runtime modified: scope-guard.sh' },
    })));
    expect(report.findings.find(f => f.rule === DOCTOR_RULES.HOOKS_SYSTEM_RUNTIME_INVALID)?.severity).toBe('error');
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_SYSTEM_RUNTIME);
  });

  test('unobserved sides (older snapshot writers) stay silent', () => {
    const onlyInstalled = fsObs({ installedSharedPackVersion: 43 });
    const onlyShipping = fsObs({ shippingSharedPackVersion: 53 });
    const neither = fsObs({});
    for (const fs of [onlyInstalled, onlyShipping, neither]) {
      expect(rules(inspectProjectState(input(fs)))).not.toContain(
        DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG
      );
    }
  });

  test('inspectProjectState performs no I/O and mutates nothing (frozen input)', () => {
    const fs = Object.freeze(
      fsObs(Object.freeze({ installedSharedPackVersion: 43, shippingSharedPackVersion: 53 }))
    );
    const report = inspectProjectState(input(fs));
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });
});
