/**
 * CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A4 — global-home doctor coverage.
 *
 * The machine global home (~/.caws) is the identity/wedge state layer. Two
 * rules observe it: a missing stamp (info) and foreign entries outside the
 * known structure (warning). Unobserved observations stay silent (house
 * convention). DIAGNOSE ONLY: pure kernel over the snapshot.
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

describe('global-home doctor rules (CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A4)', () => {
  test('rule ids are the stable strings the remediation text names', () => {
    expect(DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE).toBe('doctor.global_home.unmanaged_state');
    expect(DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING).toBe('doctor.global_home.stamp_missing');
  });

  test('a stamped home with only known entries stays silent', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          globalHomeObservation: { stampPresent: true, entries: ['state', 'surfaces', 'lib', 'bin'] },
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE);
    expect(rules(report)).not.toContain(DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING);
  });

  test('a missing stamp fires the info rule', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          globalHomeObservation: { stampPresent: false, entries: ['state', 'lib'] },
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING);
    const finding = report.findings.find((f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING);
    expect(finding?.severity).toBe('info');
  });

  test('foreign entries fire the warning naming them (the pre-v11 residue class)', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          globalHomeObservation: {
            stampPresent: true,
            entries: ['state', 'working-spec.yaml', 'events.jsonl', 'specs'],
          },
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE);
    const finding = report.findings.find((f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE);
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({
      foreign_entries: ['working-spec.yaml', 'events.jsonl', 'specs'],
    });
    // The repair names the archive-with-manifest pattern, never blind-delete.
    expect(finding?.narrowRepair).toContain('Archive');
  });

  test('an unobserved global home stays silent (older snapshot writers)', () => {
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE
    );
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING
    );
  });
});
