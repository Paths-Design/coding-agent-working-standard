/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001 — doctor.hooks.stale_telemetry_pack
 *
 * When the vendored telemetry rows (agent-heartbeat.sh, agent-stop.sh,
 * session-log.sh, session_log_renderer.py under .caws/hooks/) are present as
 * shared-pack managed files AND an adapter-covered surface pack (dsh) is
 * also installed, the vendored rows are stale dual-writers over the same
 * .caws/sessions/ + .caws/leases/ state the surface's telemetry adapter owns.
 * Doctor fires a WARNING naming the rows and the repair (re-run `caws init`).
 *
 * The honest-observation invariants are the point of this suite:
 *   - rows without an installed adapter pack are the LEGITIMATE non-covered
 *     install -> SILENT;
 *   - no rows (empty array) is absence, never staleness -> SILENT;
 *   - undefined fields are "unobserved" (older snapshot writers) -> SILENT.
 *
 * DIAGNOSE ONLY. inspectProjectState is a pure function over an in-memory
 * DoctorInput — it performs no I/O and mutates nothing; the no-write property
 * is asserted by deep-freezing the input (same harness as doctor-half-state).
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

const ALL_ROWS = [
  '.caws/hooks/agent-heartbeat.sh',
  '.caws/hooks/agent-stop.sh',
  '.caws/hooks/session-log.sh',
  '.caws/hooks/session_log_renderer.py',
];

function input(fs: FsObs): DoctorInput {
  return { now: NOW, specs: [], filesystem: fs };
}

describe('doctor.hooks.stale_telemetry_pack (CAWS-HARNESS-TELEMETRY-ADAPTER-001)', () => {
  test('rule id is the stable string the docs and remediation text name', () => {
    expect(DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK).toBe(
      'doctor.hooks.stale_telemetry_pack'
    );
  });

  test('managed rows + installed dsh marker fires the warning with rows and surfaces in data', () => {
    const fs = Object.freeze(
      fsObs({
        managedTelemetryRowPaths: Object.freeze([...ALL_ROWS]),
        adapterPackSurfaceMarkers: Object.freeze(['dsh']),
      })
    );
    const report = inspectProjectState(input(fs));
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK);

    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK
    );
    expect(finding?.severity).toBe('warning');
    expect(finding?.data).toMatchObject({
      stale_rows: ALL_ROWS,
      adapter_surfaces: ['dsh'],
    });
    // The repair names the sanctioned path, not a hand-edit.
    expect(finding?.narrowRepair).toContain('caws init');
  });

  test('partial stale rows still fire, reporting exactly the managed rows observed', () => {
    const fs = fsObs({
      managedTelemetryRowPaths: ['.caws/hooks/session-log.sh'],
      adapterPackSurfaceMarkers: ['dsh'],
    });
    const report = inspectProjectState(input(fs));
    const finding = report.findings.find(
      (f) => f.rule === DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK
    );
    expect(finding?.data).toMatchObject({
      stale_rows: ['.caws/hooks/session-log.sh'],
    });
  });

  test('rows without an adapter pack are the legitimate non-covered install: silent', () => {
    const fs = fsObs({
      managedTelemetryRowPaths: [...ALL_ROWS],
      adapterPackSurfaceMarkers: [],
    });
    expect(rules(inspectProjectState(input(fs)))).not.toContain(
      DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK
    );
  });

  test('no managed rows (empty) is absence, never staleness: silent', () => {
    const fs = fsObs({
      managedTelemetryRowPaths: [],
      adapterPackSurfaceMarkers: ['dsh'],
    });
    expect(rules(inspectProjectState(input(fs)))).not.toContain(
      DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK
    );
  });

  test('unobserved fields (older snapshot writers) stay silent', () => {
    const onlyRows = fsObs({ managedTelemetryRowPaths: [...ALL_ROWS] });
    const onlyMarkers = fsObs({ adapterPackSurfaceMarkers: ['dsh'] });
    const neither = fsObs({});
    for (const fs of [onlyRows, onlyMarkers, neither]) {
      expect(rules(inspectProjectState(input(fs)))).not.toContain(
        DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK
      );
    }
  });

  test('inspectProjectState performs no I/O and mutates nothing (frozen input)', () => {
    const fs = Object.freeze(
      fsObs({
        managedTelemetryRowPaths: Object.freeze([...ALL_ROWS]),
        adapterPackSurfaceMarkers: Object.freeze(['dsh']),
      })
    );
    const report = inspectProjectState(input(fs));
    // Deep-frozen input survived inspection without throwing (a mutation
    // attempt in strict mode throws) and the finding is still present.
    expect(rules(report)).toContain(DOCTOR_RULES.HOOKS_STALE_TELEMETRY_PACK);
  });
});
