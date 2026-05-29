// caws specs activate — shell command tests.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runSpecsActivateCommand, runSpecsCloseCommand, runSpecsCreateCommand } = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const initResult = initProject(root);
  if (!initResult.ok) throw new Error('initProject failed');
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

function capture(fn, opts) {
  const out = [];
  const err = [];
  const code = fn({ ...opts, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

function commitAll(repoRoot, msg) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', msg]);
}

function seedDraft(repoRoot, cawsDir, id) {
  const yaml = [
    `id: ${id}`,
    `title: '${id}'`,
    'risk_tier: 3',
    'mode: chore',
    'lifecycle_state: draft',
    "created_at: '2026-05-29T09:00:00.000Z'",
    "updated_at: '2026-05-29T09:00:00.000Z'",
    'blast_radius:',
    '  modules:',
    '    - packages/x',
    '  data_migration: false',
    'operational_rollback_slo: 5m',
    'scope:',
    '  in:',
    `    - .caws/specs/${id}.yaml`,
    '  out: []',
    'invariants:',
    '  - x',
    'acceptance:',
    '  - id: A1',
    '    given: g',
    '    when: w',
    '    then: t',
    'non_functional: {}',
    'contracts: []',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), yaml);
  commitAll(repoRoot, `add draft ${id}`);
}

describe('caws specs activate', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ root: repoRoot, cawsDir } = mkRepo('specs-activate-shell-')); });
  afterEach(() => rmrf(repoRoot));

  it('activates a draft and prints success', () => {
    seedDraft(repoRoot, cawsDir, 'DR-001');

    const r = capture(runSpecsActivateCommand, { cwd: repoRoot, id: 'DR-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/activated DR-001/);
    expect(fs.readFileSync(path.join(cawsDir, 'specs/DR-001.yaml'), 'utf8'))
      .toMatch(/^lifecycle_state: active$/m);
  });

  it('refuses active and closed specs with state diagnostics', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'AC-001', title: 't', mode: 'chore', riskTier: 3,
    });
    commitAll(repoRoot, 'add active AC-001');

    const active = capture(runSpecsActivateCommand, { cwd: repoRoot, id: 'AC-001' });
    expect(active.code).toBe(1);
    expect(active.stderr).toMatch(/activate: failed/);
    expect(active.stderr).toMatch(/lifecycle_state "active"/);

    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'AC-001', resolution: 'completed',
    });
    commitAll(repoRoot, 'close AC-001');
    const closed = capture(runSpecsActivateCommand, { cwd: repoRoot, id: 'AC-001' });
    expect(closed.code).toBe(1);
    expect(closed.stderr).toMatch(/lifecycle_state "closed"/);
  });
});
