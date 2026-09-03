'use strict';

/**
 * CAWS-HARNESS-TELEMETRY-ADAPTER-001 — the stale-telemetry advisory
 * (doctor.hooks.stale_telemetry_pack rendered on `caws status`).
 *
 * The advisory is render-only and fail-open: it derives ONLY from doctor
 * findings the caller already has; an absent finding produces an empty
 * string, so the host command's output stays byte-identical to baseline.
 * These tests pin the render contract, the data-shape leniency (a finding
 * whose data is malformed renders nothing rather than crashing), the bound
 * on named rows, and the wiring rule that the repair names the sanctioned
 * path (`caws init`), never a hand-edit of installed hooks.
 */

const {
  renderStaleTelemetryAdvisory,
  emitStaleTelemetryAdvisory,
  STALE_TELEMETRY_RULE,
  STALE_TELEMETRY_MAX_ROWS,
} = require('../../dist/shell/render/stale-telemetry-advisory');

const ALL_ROWS = [
  '.caws/hooks/agent-heartbeat.sh',
  '.caws/hooks/agent-stop.sh',
  '.caws/hooks/session-log.sh',
  '.caws/hooks/session_log_renderer.py',
];

function staleFinding(data) {
  return { rule: STALE_TELEMETRY_RULE, severity: 'warning', data };
}

describe('stale-telemetry advisory: render contract', () => {
  test('no stale-telemetry finding => empty string (byte-identical baseline)', () => {
    expect(renderStaleTelemetryAdvisory([])).toBe('');
    expect(
      renderStaleTelemetryAdvisory([
        { rule: 'doctor.canonical.mis_parked_head', severity: 'warning' },
      ])
    ).toBe('');
  });

  test('finding with rows + surfaces renders the block naming rows, surfaces, and the caws init repair', () => {
    const block = renderStaleTelemetryAdvisory([
      staleFinding({ stale_rows: ALL_ROWS, adapter_surfaces: ['dsh'] }),
    ]);
    expect(block).not.toBe('');
    for (const row of ALL_ROWS) expect(block).toContain(row);
    expect(block).toContain('dsh');
    expect(block).toContain('caws init');
    // Renders the sanctioned path only — never a hand-edit instruction.
    expect(block).not.toMatch(/hand-edit/i);
  });

  test('malformed data (missing/empty arrays) renders nothing instead of crashing', () => {
    expect(renderStaleTelemetryAdvisory([staleFinding(undefined)])).toBe('');
    expect(renderStaleTelemetryAdvisory([staleFinding({})])).toBe('');
    expect(
      renderStaleTelemetryAdvisory([staleFinding({ stale_rows: [], adapter_surfaces: ['dsh'] })])
    ).toBe('');
    expect(
      renderStaleTelemetryAdvisory([
        staleFinding({ stale_rows: ALL_ROWS, adapter_surfaces: [] }),
      ])
    ).toBe('');
    // Non-string entries in the arrays are filtered, not trusted.
    expect(
      renderStaleTelemetryAdvisory([
        staleFinding({ stale_rows: [42, null], adapter_surfaces: ['dsh'] }),
      ])
    ).toBe('');
  });

  test('row list is bounded at STALE_TELEMETRY_MAX_ROWS with an overflow line', () => {
    expect(STALE_TELEMETRY_MAX_ROWS).toBe(4);
    const manyRows = [
      '.caws/hooks/a.sh',
      '.caws/hooks/b.sh',
      '.caws/hooks/c.sh',
      '.caws/hooks/d.sh',
      '.caws/hooks/e.sh',
      '.caws/hooks/f.sh',
    ];
    const block = renderStaleTelemetryAdvisory([
      staleFinding({ stale_rows: manyRows, adapter_surfaces: ['dsh'] }),
    ]);
    expect(block).toContain('.caws/hooks/d.sh');
    expect(block).not.toContain('.caws/hooks/e.sh');
    expect(block).toContain('... and 2 more');
  });

  test('emit helper writes the block when non-empty and stays silent otherwise', () => {
    const lines = [];
    emitStaleTelemetryAdvisory(
      [staleFinding({ stale_rows: ALL_ROWS, adapter_surfaces: ['dsh'] })],
      (l) => lines.push(l)
    );
    expect(lines).toHaveLength(1);

    const silent = [];
    emitStaleTelemetryAdvisory([], (l) => silent.push(l));
    expect(silent).toHaveLength(0);
  });
});
