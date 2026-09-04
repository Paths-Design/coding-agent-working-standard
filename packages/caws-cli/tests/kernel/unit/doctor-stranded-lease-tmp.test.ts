/**
 * CAWS-DEFECT-LEASE-TMP-STRANDING-01 — doctor.leases.stranded_tmp.
 *
 * A lease write crashed between tmp creation and rename, leaving
 * `<lease>.tmp.<pid>.<counter>` behind. The loader already ignores non-.json
 * names, so the litter is invisible; the fix is visibility (this rule) plus
 * self-healing (the atomic-write sweep). The rule fires when the snapshot
 * observes stranded tmps; clean or unobserved directories stay silent.
 * DIAGNOSE ONLY: pure kernel function — no I/O, no mutation.
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

describe('doctor.leases.stranded_tmp (CAWS-DEFECT-LEASE-TMP-STRANDING-01)', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.LEASES_STRANDED_TMP).toBe('doctor.leases.stranded_tmp');
  });

  test('stranded tmp files fire the warning naming files and ages', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          strandedLeaseTmpFiles: [
            { name: '57dc83ce-9523-4a3d-baa0-8fe9ddd7a48d.json.tmp.47057.0', ageMs: 36 * 24 * 60 * 60 * 1000 },
          ],
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.LEASES_STRANDED_TMP);
    const finding = report.findings.find((f) => f.rule === DOCTOR_RULES.LEASES_STRANDED_TMP);
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({
      stranded: [{ name: '57dc83ce-9523-4a3d-baa0-8fe9ddd7a48d.json.tmp.47057.0', age_ms: 36 * 24 * 60 * 60 * 1000 }],
    });
    // The repair names the automatic sweep, never a manual hand-delete as the
    // primary path.
    expect(finding?.narrowRepair).toContain('next lease write');
  });

  test('an empty observation stays silent', () => {
    const report = inspectProjectState(input(fsObs({ strandedLeaseTmpFiles: [] })));
    expect(rules(report)).not.toContain(DOCTOR_RULES.LEASES_STRANDED_TMP);
  });

  test('an unobserved field (older snapshot writers) stays silent', () => {
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.LEASES_STRANDED_TMP
    );
  });
});
