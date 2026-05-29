// caws specs retire-draft — shell command tests.
// CAWS-SPECS-RETIRE-DRAFT-001 A7 (shell layer). Fixture repos only.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsCloseCommand,
  runSpecsRetireDraftCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return root;
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function setup(prefix) {
  const repoRoot = mkBareGitRepo(prefix);
  const initResult = initProject(repoRoot);
  if (!initResult.ok) throw new Error('initProject failed');
  return { repoRoot, cawsDir: path.join(repoRoot, '.caws') };
}
function capture(fn, opts) {
  const out = []; const err = [];
  const code = fn({ ...opts, out: (s) => out.push(s), err: (s) => err.push(s) });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}
function commitAll(repoRoot, msg) {
  execFileSync('git', ['-C', repoRoot, 'add', '-A']);
  execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', msg]);
}

// `caws specs create` always makes ACTIVE specs (v11 design). To seed a
// genuine DRAFT, write the yaml directly. Committed so it is tracked at HEAD.
function seedCommittedDraft(repoRoot, cawsDir, id) {
  const yaml = [
    `id: ${id}`,
    `title: '${id}'`,
    'risk_tier: 3',
    'mode: chore',
    'lifecycle_state: draft',
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

describe('caws specs retire-draft (shell)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-retire-shell-')); });
  afterEach(() => rmrf(repoRoot));

  it('A1: retires a committed draft, exit 0, file gone, recovery hint shown', () => {
    seedCommittedDraft(repoRoot, cawsDir, 'DR-001');
    const specPath = path.join(cawsDir, 'specs/DR-001.yaml');
    expect(fs.existsSync(specPath)).toBe(true);

    const r = capture(runSpecsRetireDraftCommand, { cwd: repoRoot, id: 'DR-001' });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/retired draft DR-001/);
    expect(r.stdout).toMatch(/--archived/); // recovery hint
    expect(fs.existsSync(specPath)).toBe(false);
  });

  it('A2: refuses an ACTIVE spec (exit 1), pointing at close', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'AC-001', title: 't', mode: 'chore', riskTier: 3,
      initialState: 'active',
    });
    commitAll(repoRoot, 'add active AC-001');

    const r = capture(runSpecsRetireDraftCommand, { cwd: repoRoot, id: 'AC-001' });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/retire-draft: failed/);
    expect(r.stderr).toMatch(/lifecycle_state "active"/);
    expect(r.stderr).toMatch(/caws specs close/);
    // Not deleted.
    expect(fs.existsSync(path.join(cawsDir, 'specs/AC-001.yaml'))).toBe(true);
  });

  it('A2: refuses a CLOSED spec (exit 1), pointing at archive', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CL-001', title: 't', mode: 'chore', riskTier: 3,
      initialState: 'active',
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CL-001', resolution: 'completed',
    });
    commitAll(repoRoot, 'add closed CL-001');

    const r = capture(runSpecsRetireDraftCommand, { cwd: repoRoot, id: 'CL-001' });

    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/lifecycle_state "closed"/);
    expect(r.stderr).toMatch(/caws specs archive/);
  });

  it('refuses a missing id (exit 1)', () => {
    const r = capture(runSpecsRetireDraftCommand, { cwd: repoRoot, id: 'NOPE-001' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not found/);
  });
});
