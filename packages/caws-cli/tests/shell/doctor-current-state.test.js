const { projectDoctorFindings } = require('../../dist/kernel');
const { buildStatusPanelPayload } = require('../../dist/shell/panel-data');
const { renderStatus, renderShortStatus } = require('../../dist/shell/render/status');
const f = (rule, severity = 'info') => ({
  rule,
  severity,
  authority: 'kernel/diagnostics',
  message: rule,
});
const all = [
  f('doctor.hooks.system_runtime'),
  f('doctor.global_home.recognized_legacy_state'),
  f('doctor.hooks.pack_local_growth'),
  f('doctor.worktree.owner_lease_missing', 'warning'),
  f('doctor.hooks.pack_fork_upstream_moved', 'warning'),
  f('doctor.worktree.event_without_control_plane_binding'),
];
test('inventory and owner availability remain inspectable without inflating health counts', () => {
  const view = projectDoctorFindings(all);
  expect(view.findings.map((x) => x.rule)).toEqual([
    'doctor.hooks.pack_fork_upstream_moved',
    'doctor.worktree.event_without_control_plane_binding',
  ]);
  expect(view.inventory).toHaveLength(3);
  expect(view.activity).toHaveLength(1);
  const payload = buildStatusPanelPayload({
    jsonPanels: ['doctor'],
    doctorFindings: all,
    mailSummary: { count: 0, oldestAgeMs: null },
  });
  expect(payload.doctor.findings).toEqual(view.findings);
  expect(payload.doctor.inventory).toEqual(view.inventory);
  expect(payload.doctor.activity).toEqual(view.activity);
  expect(payload.doctor.counts).toEqual({ errors: 0, warnings: 1, infos: 1 });
});
test('a severe or unknown condition is never hidden by the current-state projection', () => {
  const errors = all.map((x) => ({ ...x, severity: 'error' }));
  expect(projectDoctorFindings(errors).findings).toEqual(errors);
  const unknown = f('doctor.new.unrecognized');
  expect(projectDoctorFindings([unknown]).findings).toEqual([unknown]);
});
test('human status and short status use the same actionable projection as JSON', () => {
  const input = {
    specs: [],
    worktrees: {},
    agents: {},
    doctorFindings: all,
    repoRoot: '/repo',
    cawsDir: '/repo/.caws',
    cwd: '/repo',
    policyPresent: true,
    eventCount: 0,
    now: new Date(),
    panels: ['doctor'],
    binding: { binding: { kind: 'unbound' }, cwdRelation: 'main' },
  };
  const human = renderStatus(input);
  expect(human).toContain('0E / 1W / 1I');
  expect(human).toContain('pack_fork_upstream_moved');
  expect(human).not.toContain('recognized_legacy_state');
  expect(human).not.toContain('owner_lease_missing');
  expect(renderShortStatus(input)).toContain('0E / 1W / 1I');
});

test('human status groups hook maintenance without hiding a severe underlying condition', () => {
  const human = renderStatus({
    specs: [],
    worktrees: {},
    agents: {},
    panels: ['doctor'],
    doctorFindings: [
      f('doctor.hooks.pack_body_drift', 'warning'),
      f('doctor.hooks.system_runtime_invalid', 'error'),
    ],
    repoRoot: '/repo',
    cawsDir: '/repo/.caws',
    cwd: '/repo',
    now: new Date(),
  });
  expect(human).toContain('1E / 1W / 0I');
  expect(human).toContain('[ERROR  ] doctor.hooks.maintenance');
  expect(human).toContain('2 diagnostics');
  expect(human).toContain('doctor.hooks.system_runtime_invalid');
});
