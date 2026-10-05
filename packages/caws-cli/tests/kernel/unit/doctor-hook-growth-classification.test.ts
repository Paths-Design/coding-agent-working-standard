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
    // Baseline-clean drift is AMBIGUOUS (a port under 12.0.0/12.1.0 absorbed
    // growth into the baseline — proven live on sterling's post_tool_use.sh),
    // so the warning must never offer refresh as unconditionally safe.
    expect(drift?.message).toContain('AMBIGUOUS');
    expect(drift?.narrowRepair).toContain('READ the deltas');
    // The ambiguity is HISTORICAL, not a standing property of port. Stating it
    // in the present tense outlives its truth and turns a resolved caveat into
    // a permanent brake on a safe refresh.
    expect(drift?.message).toContain('12.0.0');
    expect(drift?.message).not.toMatch(/the port path re-baselines/);
    // A refusal that names only the destructive exit is the defect this rule
    // participates in: `--overwrite --force` discards local content, so the
    // repair must also name the discharge that keeps both sides.
    expect(drift?.narrowRepair).toContain('caws init port <path> --from <staging-file>');
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
          // PURE growth: no row's upstream has moved. The upstream-moved case
          // is a different obligation with its own rule and its own warning —
          // see A6 — so keeping it out of this fixture lets the assertions
          // below mean exactly what this test's name says.
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/bash-write-guard.sh'),
            growthRow('.caws/hooks/agent-register.sh'),
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

  test('A6: a fork whose upstream moved raises its own warning, with a PORT remediation', () => {
    // The sterling shape: every drifted row is deliberate growth, so the
    // version lag stays info — but the templates those forks were taken from
    // have since moved, which is an outstanding obligation nothing reported.
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 81,
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/scope-guard.sh', true),
            growthRow('.caws/hooks/lib/write-allowlist.sh', true),
            growthRow('.caws/hooks/audit.sh'),
          ],
        })
      )
    );

    const fork = findingFor(report, DOCTOR_RULES.HOOKS_PACK_FORK_UPSTREAM_MOVED);
    expect(fork?.severity).toBe('warning');
    expect(fork?.data).toMatchObject({
      fork_count: 2,
      fork_paths: ['.caws/hooks/scope-guard.sh', '.caws/hooks/lib/write-allowlist.sh'],
    });
    // The remediation must name the non-destructive discharge, and must name
    // the destructive refresh ONLY to prohibit it — silence would leave the
    // operator free to reach for the command that deletes the fork.
    expect(fork?.narrowRepair).toContain('caws init port');
    expect(fork?.narrowRepair).toMatch(/Do NOT run `caws init --overwrite --force`/);

    // The lag rule keeps its own, narrower meaning: refresh is still unsafe
    // here, so it must stay info rather than absorbing the fork obligation.
    expect(findingFor(report, DOCTOR_RULES.HOOKS_INSTALLED_PACK_VERSION_LAG)?.severity).toBe(
      'info'
    );
  });

  test('A6b: growth whose upstream has NOT moved raises no fork warning', () => {
    // The discrimination control. Identical shape to A6 except upstreamChange;
    // without this, A6 would pass for any growth row at all.
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 81,
          installedSharedPackBodyDrift: [
            growthRow('.caws/hooks/scope-guard.sh'),
            growthRow('.caws/hooks/lib/write-allowlist.sh'),
          ],
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_PACK_FORK_UPSTREAM_MOVED);
    expect(report.summary.warnings).toBe(0);
  });

  test('A6c: a moved upstream on a row that is NOT growth is drift, not a fork', () => {
    // cleanBaselineRow carries upstreamChange=true with localGrowth=false —
    // an un-edited stale copy. That is the body-drift/refresh class, and must
    // not be reported as a fork owing a port.
    const report = inspectProjectState(
      input(
        fsObs({
          installedSharedPackVersion: 67,
          shippingSharedPackVersion: 81,
          installedSharedPackBodyDrift: [cleanBaselineRow('.caws/hooks/validate-spec.sh')],
        })
      )
    );
    expect(rules(report)).not.toContain(DOCTOR_RULES.HOOKS_PACK_FORK_UPSTREAM_MOVED);
    expect(findingFor(report, DOCTOR_RULES.HOOKS_PACK_BODY_DRIFT)?.severity).toBe('warning');
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
