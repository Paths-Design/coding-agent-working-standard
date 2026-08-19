'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runDoctorCommand } = require('../../dist/shell/commands/doctor');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) {
    throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  }
  return { root, caws: path.join(root, '.caws') };
}

function writeSpec(cawsDir, id, updatedAt) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: active
created_at: '2026-06-01T00:00:00.000Z'
updated_at: '${updatedAt}'
blast_radius:
  modules:
    - tests
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - tests
  out: []
invariants:
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function runDoctor(root, opts) {
  const out = [];
  const err = [];
  const code = runDoctorCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: new Date('2026-07-04T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws doctor repair-plan', () => {
  test('emits an empty read-only plan for a clean initialized project', () => {
    const { root } = mkRepo();

    const result = runDoctor(root, { repairPlan: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
      counts: { findings: 0, errors: 0, warnings: 0, infos: 0 },
      counts_by_state: {},
      items: [],
    });
  });

  test('plans active unbound spec findings without mutating caws state', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DOCTOR-PLAN-STALE-001', '2026-07-03T00:00:00.000Z');
    const specPath = path.join(caws, 'specs', 'DOCTOR-PLAN-STALE-001.yaml');
    const beforeSpec = fs.readFileSync(specPath, 'utf8');
    const beforeEventsExists = fs.existsSync(path.join(caws, 'events.jsonl'));

    const result = runDoctor(root, { repairPlan: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: true,
      read_only: true,
    });
    expect(payload.counts.findings).toBeGreaterThanOrEqual(1);
    expect(payload.counts.warnings).toBeGreaterThanOrEqual(1);
    const item = payload.items.find((entry) => entry.subject === 'DOCTOR-PLAN-STALE-001');
    expect(item).toMatchObject({
      subject: 'DOCTOR-PLAN-STALE-001',
      state_class: 'active-spec-unbound',
      source_rule: 'doctor.spec.unbound_active_stale',
      severity: 'warning',
      allowed_mutation: null,
      next_command: 'caws worktree create <name> --spec DOCTOR-PLAN-STALE-001',
    });
    expect(item.refusal_reason).toContain('choose whether to bind work');
    expect(fs.readFileSync(specPath, 'utf8')).toBe(beforeSpec);
    expect(fs.existsSync(path.join(caws, 'events.jsonl'))).toBe(beforeEventsExists);
  });

  test('renders a human repair plan and preserves default doctor output when not requested', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'DOCTOR-PLAN-STALE-001', '2026-07-03T00:00:00.000Z');

    const plan = runDoctor(root, { repairPlan: true });
    expect(plan.code).toBe(0);
    expect(plan.out).toContain('caws doctor repair-plan:');
    expect(plan.out).toContain('- active-spec-unbound DOCTOR-PLAN-STALE-001');
    expect(plan.out).toContain('next: caws worktree create <name> --spec DOCTOR-PLAN-STALE-001');

    const normal = runDoctor(root, {});
    expect(normal.code).toBe(0);
    expect(normal.out).toContain('Store load diagnostics:');
    expect(normal.out).toContain('Doctor findings:');
    expect(normal.out).not.toContain('caws doctor repair-plan');
  });
});
