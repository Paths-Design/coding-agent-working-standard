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
    expect(DOCTOR_RULES.GLOBAL_HOME_RECOGNIZED_LEGACY_STATE).toBe(
      'doctor.global_home.recognized_legacy_state'
    );
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

// =========================================================================
// CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01 — recognized legacy entries.
// `sessions` at the global-home root is pre-v11 session-log output the
// current CLI no longer writes (session logs are repo-local). Warning on it
// demanded a review no governed command could perform and buried genuinely
// unknown entries. It now renders as a distinct INFO finding; the warning is
// reserved for entries with unknown provenance.
// =========================================================================

describe('global-home recognized legacy entries (CAWS-DEFECT-DOCTOR-NO-DISCHARGE-WARNINGS-01)', () => {
  function homeWith(entries: readonly string[]) {
    return input(
      fsObs({
        globalHomeObservation: {
          kind: 'present',
          root: '/fixture/machine',
          stampPresent: true,
          entries,
          runtime: { status: 'verified', digest: 'a'.repeat(64) },
        },
      })
    );
  }

  test('A5: a home with sessions AND an unknown entry warns only on the unknown one and infos the legacy one', () => {
    const report = inspectProjectState(homeWith(['state', 'sessions', 'mystery-dir']));
    const unmanaged = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE
    );
    expect(unmanaged?.severity).toBe('warning');
    expect(unmanaged?.data).toMatchObject({ foreign_entries: ['mystery-dir'] });
    expect(unmanaged?.message).not.toContain('sessions');

    const legacy = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_RECOGNIZED_LEGACY_STATE
    );
    expect(legacy?.severity).toBe('info');
    expect(legacy?.data).toMatchObject({ legacy_entries: ['sessions'] });
    expect(legacy?.message).toContain('prior CLI generation');
  });

  test('A6: a home whose only extra entry is sessions does not warn', () => {
    const report = inspectProjectState(homeWith(['state', 'sessions']));
    expect(rules(report)).not.toContain(DOCTOR_RULES.GLOBAL_HOME_UNMANAGED_STATE);
    const legacy = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_RECOGNIZED_LEGACY_STATE
    );
    expect(legacy?.severity).toBe('info');
    expect(report.summary.warnings).toBe(0);
  });

  test('the legacy finding names no command (informational provenance, not a remedy)', () => {
    const report = inspectProjectState(homeWith(['sessions']));
    const legacy = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.GLOBAL_HOME_RECOGNIZED_LEGACY_STATE
    );
    expect(legacy?.narrowRepair ?? '').not.toMatch(/\bcaws\s+\w|\bgit\s+\w/);
  });
});
