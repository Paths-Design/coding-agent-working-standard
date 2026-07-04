'use strict';

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runStatusCommand } = require('../../dist/shell/commands/status');
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

function writeSpec(cawsDir, id, lifecycleState, opts = {}) {
  const worktree = opts.worktree !== undefined ? `worktree: ${opts.worktree}\n` : '';
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${lifecycleState}
${worktree}created_at: '2026-06-01T00:00:00.000Z'
updated_at: '2026-07-03T00:00:00.000Z'
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

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function runStatus(root, opts) {
  const out = [];
  const err = [];
  const code = runStatusCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    now: () => new Date('2026-07-04T00:00:00.000Z'),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('caws status focused filters', () => {
  test('renders only requested human panels and leaves default dashboard intact', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'STATUS-FILTER-001', 'active', { worktree: 'wt-status' });
    writeRegistry(caws, {
      'wt-status': {
        specId: 'STATUS-FILTER-001',
        branch: 'status-filter',
        baseBranch: 'main',
        path: path.join(caws, 'worktrees', 'wt-status'),
      },
    });

    const focused = runStatus(root, { specs: true, worktrees: true });
    expect(focused.code).toBe(0);
    expect(focused.out).toContain('CAWS Status');
    expect(focused.out).toContain('Specs');
    expect(focused.out).toContain('STATUS-FILTER-001');
    expect(focused.out).toContain('Worktrees');
    expect(focused.out).toContain('wt-status');
    expect(focused.out).not.toContain('Current context');
    expect(focused.out).not.toContain('Doctor');

    const full = runStatus(root, {});
    expect(full.code).toBe(0);
    expect(full.out).toContain('Project');
    expect(full.out).toContain('Current context');
    expect(full.out).toContain('Doctor');
  });

  test('emits selected panels as read-only JSON', () => {
    const { root, caws } = mkRepo();
    writeSpec(caws, 'STATUS-FILTER-001', 'active');
    const beforeSpec = fs.readFileSync(path.join(caws, 'specs', 'STATUS-FILTER-001.yaml'), 'utf8');
    const beforeEvents = fs.existsSync(path.join(caws, 'events.jsonl'));

    const result = runStatus(root, { specs: true, doctor: true, json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      panels: ['specs', 'doctor'],
    });
    expect(payload.specs.count).toBe(1);
    expect(payload.specs.items[0]).toMatchObject({
      id: 'STATUS-FILTER-001',
      lifecycle_state: 'active',
    });
    expect(payload.doctor.counts.warnings).toBeGreaterThanOrEqual(1);
    expect(payload.worktrees).toBeUndefined();
    expect(payload.agents).toBeUndefined();
    expect(fs.readFileSync(path.join(caws, 'specs', 'STATUS-FILTER-001.yaml'), 'utf8')).toBe(beforeSpec);
    expect(fs.existsSync(path.join(caws, 'events.jsonl'))).toBe(beforeEvents);
  });
});
