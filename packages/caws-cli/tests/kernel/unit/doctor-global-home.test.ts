/**
 * CAWS-DESIGN-GLOBAL-IDENTITY-HOME-001 A4 — global-home doctor coverage.
 *
 * Pure diagnostics over explicit missing, unreadable, and present states.
 * Verified runtime bytes do not establish native activation or authority.
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput } from '../../../src/kernel/doctor/types';

const NOW = new Date('2026-06-15T12:00:00.000Z');

type FsObs = NonNullable<DoctorInput['filesystem']>;
function fsObs(partial: Partial<FsObs>): FsObs {
  return {
    cawsDirExists: true,
    specsDirExists: true,
    waiversDirExists: true,
    policyYamlExists: true,
    worktreesJsonExists: true,
    agentsJsonExists: true,
    eventsJsonlExists: false,
    ...partial,
  };
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
          globalHomeObservation: {
            kind: 'present',
            root: '/fixture/machine',
            runtime: { status: 'absent' },
            stampPresent: true,
            entries: ['state', 'surfaces', 'lib', 'bin'],
          },
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
          globalHomeObservation: {
            kind: 'present',
            root: '/fixture/machine',
            runtime: { status: 'absent' },
            stampPresent: false,
            entries: ['state', 'lib'],
          },
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
            kind: 'present',
            root: '/fixture/machine',
            runtime: { status: 'absent' },
            stampPresent: true,
            entries: ['state', 'working-spec.yaml', 'events.jsonl', 'specs'],
          },
        })
      )
    );
    expect(rules(report)).toContain(DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE);
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({
      foreign_entries: ['working-spec.yaml', 'events.jsonl', 'specs'],
    });
    expect(finding?.narrowRepair).toContain('preserve');
  });

  test('an unobserved global home stays silent (older snapshot writers)', () => {
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE
    );
    expect(rules(inspectProjectState(input(fsObs({}))))).not.toContain(
      DOCTOR_RULES.GLOBAL_HOME_STAMP_MISSING
    );
  });

  test.each([
    { kind: 'absent', root: '/fixture/machine' } as const,
    {
      kind: 'present',
      root: '/fixture/machine',
      stampPresent: false,
      entries: ['lib', 'state'],
      runtime: { status: 'verified', digest: 'a'.repeat(64) },
    } as const,
  ])(
    'absence and verified installation do not request a migration stamp: %j',
    (globalHomeObservation) => {
      const report = inspectProjectState(input(fsObs({ globalHomeObservation })));
      expect(report.findings.filter((f) => f.rule.startsWith('doctor.global_home.'))).toEqual([]);
    }
  );

  test('an unreadable path reports the failure and exact root without an initialization finding', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          globalHomeObservation: {
            kind: 'unreadable',
            root: '/fixture/inaccessible',
            error: { code: 'EACCES', message: 'denied' },
          },
        })
      )
    );
    expect(report.findings.filter((f) => f.rule.startsWith('doctor.global_home.'))).toEqual([
      expect.objectContaining({
        rule: DOCTOR_RULES.GLOBAL_HOME_UNREADABLE,
        severity: 'error',
        subject: '/fixture/inaccessible',
        data: { code: 'EACCES' },
      }),
    ]);
  });

  test('a legacy stamp cannot hide an invalid runtime', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          globalHomeObservation: {
            kind: 'present',
            root: '/fixture/machine',
            stampPresent: true,
            entries: ['lib', 'state'],
            runtime: { status: 'invalid', error: 'modified launcher' },
          },
        })
      )
    );
    expect(report.findings.filter((f) => f.rule.startsWith('doctor.global_home.'))).toEqual([
      expect.objectContaining({
        rule: DOCTOR_RULES.GLOBAL_HOME_RUNTIME_INVALID,
        severity: 'error',
        message: expect.stringContaining('modified launcher'),
      }),
    ]);
  });
});
