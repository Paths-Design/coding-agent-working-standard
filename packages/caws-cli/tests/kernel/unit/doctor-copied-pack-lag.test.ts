/**
 * HOOKPACK-COPIED-PACK-LAG-VISIBILITY-001 —
 * doctor.hooks.installed_pack_version_lag (un-suppressed) and
 * doctor.hooks.pack_body_drift.
 *
 * The execution plane is PER SURFACE. A verified machine runtime does NOT prove
 * the copied .caws/hooks pack is inert: claude-code/codex native configs wire the
 * machine launcher (~/.caws/bin/caws-hook <surface> <event> --system), while the
 * DSH bridge runs <repoRoot>/.caws/hooks/dispatch/<event>.sh directly. The old
 * suppression (`systemRuntime === undefined &&`) therefore asserted a wiring fact
 * doctor cannot observe, and its failure mode was silence about a live, old guard
 * plane — reproduced on this repo: runtime installed, copied pack at v56 while
 * the CLI ships v67, DSH executing the v56 copy, doctor silent.
 *
 * DIAGNOSE ONLY: pure kernel function over the snapshot — no I/O, no mutation
 * (deep-frozen input survives inspection).
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

function findingFor(report: ReturnType<typeof inspectProjectState>, rule: string) {
  return report.findings.find((f) => f.rule === rule);
}

/**
 * CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01: a drift row with NO
 * baseline — the unobserved shape. Under the growth/stale classification this
 * is a STALE row, which is exactly what the pre-classification tests below
 * asserted (warning over every drifted path), so they now double as the
 * unobserved-never-downgrades coverage.
 */
function staleRow(destPath: string) {
  return { destPath, baselinePresent: false, localGrowth: false, upstreamChange: false };
}

const RUNTIME = {
  surfaces: ['codex', 'claude-code'],
  legacySurfaces: [] as string[],
  overrides: [] as string[],
  digest: 'a'.repeat(64),
};

describe('doctor.hooks.installed_pack_version_lag with a machine runtime present', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG).toBe(
      'doctor.hooks.installed_pack_version_lag'
    );
  });

  test('A1: a machine runtime installed does NOT suppress copied-pack lag', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 56,
          shippingSharedPackVersion: 67,
          systemRuntime: RUNTIME,
        })
      )
    );
    const finding = findingFor(report, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({ installed_version: 56, shipping_version: 67 });
    // The repair names the sanctioned reconciliation surfaces, never a hand-edit.
    expect(finding?.narrowRepair).toContain('caws init');
  });

  test('the runtime finding is reported independently alongside the lag', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 56,
          shippingSharedPackVersion: 67,
          systemRuntime: RUNTIME,
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_SYSTEM_RUNTIME);
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });

  test('matching versions stay silent even with a runtime present', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 67,
          systemRuntime: RUNTIME,
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });

  test('unobserved sides (older snapshot writers) stay silent', () => {
    const onlyInstalled = fsObs({ installedSharedPackVersion: 56 });
    const onlyShipping = fsObs({ shippingSharedPackVersion: 67 });
    const neither = fsObs({});
    for (const fs of [onlyInstalled, onlyShipping, neither]) {
      expect(rules(inspectProjectState(input(fs)))).not.toContain(
        DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG
      );
    }
  });
});

describe('doctor.hooks.pack_body_drift', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT).toBe('doctor.hooks.pack_body_drift');
  });

  test('A2: body drift fires while the version lag stays silent', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 67,
          installedSharedPackBodyDrift: [
            staleRow('.caws/hooks/block-dangerous.sh'),
            staleRow('.caws/hooks/classify_command.py'),
          ],
        })
      )
    );
    const finding = findingFor(report, DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT);
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({
      drift_count: 2,
      drift_paths: ['.caws/hooks/block-dangerous.sh', '.caws/hooks/classify_command.py'],
    });
    expect(finding?.narrowRepair).toContain('caws init');
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });

  test('body drift is reported even when a machine runtime is present', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 67,
          systemRuntime: RUNTIME,
          installedSharedPackBodyDrift: [staleRow('.caws/hooks/audit.sh')],
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT);
  });

  test('a message names at most five files and counts the remainder', () => {
    const paths = Array.from({ length: 9 }, (_, i) => `.caws/hooks/guard-${i}.sh`);
    const report = inspectProjectState(
      input(fsObs({ installedSharedPackBodyDrift: paths.map(staleRow) }))
    );
    const finding = findingFor(report, DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT);
    expect(finding?.message).toContain('9');
    expect(finding?.message).toContain('+4 more');
    expect(finding?.data).toMatchObject({ drift_count: 9 });
  });

  test('A3: empty and absent observations are silent', () => {
    const empty = fsObs({
      installedSharedPackVersion: 67,
      shippingSharedPackVersion: 67,
      installedSharedPackBodyDrift: [],
    });
    const absent = fsObs({
      installedSharedPackVersion: 67,
      shippingSharedPackVersion: 67,
    });
    for (const fs of [empty, absent]) {
      expect(rules(inspectProjectState(input(fs)))).not.toContain(
        DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT
      );
    }
  });
});

describe('inspectProjectState stays pure', () => {
  test('A5: deep-frozen input survives inspection and both rules still fire', () => {
    const fs = Object.freeze(
      fsObs(
        Object.freeze({
          installedSharedPackVersion: 56,
          shippingSharedPackVersion: 67,
          systemRuntime: Object.freeze({ ...RUNTIME }),
          installedSharedPackBodyDrift: Object.freeze([staleRow('.caws/hooks/audit.sh')]),
        })
      )
    );
    const report = inspectProjectState(input(fs));
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT);
  });
});
