/**
 * CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01 — growth/stale
 * classification over baseline-classified drift rows (sterling
 * tmp/caws_cli_defects.md Defect 4, fix path 1).
 *
 * The pristine baseline the installer writes is the authority for
 * deliberateness: localGrowth rows are repo-owned surface awaiting the
 * retrofit (INFO — refresh would destroy them); growth-free rows are stale
 * copies (WARN — refresh loses nothing); baseline-less rows are unobserved
 * and never downgrade. The version-lag rule downgrades to INFO exactly when
 * drift exists and every row is growth.
 *
 * DIAGNOSE ONLY: pure kernel function over the snapshot — no I/O, no
 * mutation (deep-frozen input survives inspection).
 */

import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { DoctorInput, SharedPackDriftRow } from '../../../src/kernel/doctor/types';

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

function growthRow(destPath: string, upstreamChange = false): SharedPackDriftRow {
  return { destPath, baselinePresent: true, localGrowth: true, upstreamChange };
}

function staleRow(destPath: string): SharedPackDriftRow {
  return { destPath, baselinePresent: false, localGrowth: false, upstreamChange: false };
}

/** A baseline-present row with NO local edit — an old template copy, refreshable. */
function cleanBaselineRow(destPath: string): SharedPackDriftRow {
  return { destPath, baselinePresent: true, localGrowth: false, upstreamChange: true };
}

describe('doctor.hooks.pack_local_growth (CAWS-DEFECT-HOOK-DRIFT-NO-NONDESTRUCTIVE-DISCHARGE-01)', () => {
  test('rule id is the stable string the remediation text names', () => {
    expect(DOCTOR_RULES.HOOKS_PACK_LOCAL_GROWTH).toBe('doctor.hooks.pack_local_growth');
  });

  test('A2: growth rows render as info; stale rows keep the body-drift warning naming only themselves', () => {
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/bash-write-guard.sh'),
            growthRow('.caws/hooks/dispatch/session_start.sh', true),
            staleRow('.caws/hooks/audit.sh'),
            cleanBaselineRow('.caws/hooks/validate-spec.sh'),
          ],
        })
      )
    );

    const growth = findingFor(report, DOCTOR_RULES.HOOKS_PACK_LOCAL_GROWTH);
    expect(growth?.severity).toBe('info');
    expect(growth?.data).toMatchObject({
      growth_count: 2,
      growth_paths: ['.caws/hooks/bash-write-guard.sh', '.caws/hooks/dispatch/session_start.sh'],
      upstream_changed_paths: ['.caws/hooks/dispatch/session_start.sh'],
    });
    expect(growth?.message).toContain('upstream template changes');
    // The retrofit framing, never a refresh demand.
    expect(growth?.narrowRepair).toContain('No refresh required');

    const drift = findingFor(report, DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT);
    expect(drift?.severity).toBe('warning');
    expect(drift?.data).toMatchObject({
      drift_count: 2,
      drift_paths: ['.caws/hooks/audit.sh', '.caws/hooks/validate-spec.sh'],
    });
    // Baseline-clean drift is AMBIGUOUS (a port can absorb growth into the
    // baseline — proven live on sterling's post_tool_use.sh), so the warning
    // must never offer refresh as unconditionally safe.
    expect(drift?.message).toContain('AMBIGUOUS');
    expect(drift?.narrowRepair).toContain('READ the deltas');
    // Mixed rows: the lag is NOT fully explained -> stays a warning.
    expect(findingFor(report, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG)?.severity).toBe(
      'warning'
    );
  });

  test('A3: version lag downgrades to info only when every drift row is growth', () => {
    const allGrowth = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/bash-write-guard.sh'),
            growthRow('.caws/hooks/agent-register.sh', true),
          ],
        })
      )
    );
    const lag = findingFor(allGrowth, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
    expect(lag?.severity).toBe('info');
    expect(lag?.data).toMatchObject({ growth_rows: 2, stale_rows: 0 });
    expect(lag?.message).toContain('deliberate local growth');
    expect(allGrowth.summary.warnings).toBe(0);

    // A baseline-less row among growth rows keeps the lag a warning.
    const withUnobserved = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/audit.sh'),
            staleRow('.caws/hooks/stop.sh'),
          ],
        })
      )
    );
    expect(
      findingFor(withUnobserved, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG)?.severity
    ).toBe('warning');

    // Zero drift rows: pure stamp lag — refreshable, stays a warning.
    const stampOnly = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: [],
        })
      )
    );
    expect(findingFor(stampOnly, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG)?.severity).toBe(
      'warning'
    );
  });

  test('A4: a growth row with a readable baseline but unreadable template never downgrades anything', () => {
    // baselinePresent=true with both flags false models the observer's
    // unreadable-template shape: NOT growth, so it counts as stale for both
    // the drift warning and the lag condition.
    const row: SharedPackDriftRow = {
      destPath: '.caws/hooks/audit.sh',
      baselinePresent: true,
      localGrowth: false,
      upstreamChange: false,
    };
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: [row],
        })
      )
    );
    expect(findingFor(report, DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT)?.severity).toBe('warning');
    expect(findingFor(report, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG)?.severity).toBe(
      'warning'
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_PACK_LOCAL_GROWTH);
  });

  test('A5: deep-frozen classified rows survive inspection unmutated', () => {
    const fs = Object.freeze(
      fsObs(
        Object.freeze({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 68,
          installedSharedPackBodyDrift: Object.freeze([growthRow('.caws/hooks/audit.sh')]),
        })
      )
    );
    const report = inspectProjectState(input(fs));
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_PACK_LOCAL_GROWTH);
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG);
  });
});
