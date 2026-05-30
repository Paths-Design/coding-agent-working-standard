/**
 * CAWS-SPECS-CREATE-SCOPE-IN-001 — shell-level --scope-in wiring.
 *
 * Drives runSpecsCreateCommand in-process (the same entry register.ts invokes)
 * and asserts on the captured stdout + the on-disk spec YAML:
 *   - --scope-in paths land in scope.in at creation time (A1)
 *   - the post-create guidance branches: populated → confirm + amend-scope;
 *     omitted → route scope-setting through amend-scope, NOT a YAML hand-edit (A4)
 *   - repeated --scope-in de-duplicates (A3)
 *
 * These exercise the shell parse + guidance surface that the store-layer test
 * (tests/store/specs-create-scope-in.test.js) does not cover.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runSpecsCreateCommand } = require('../../dist/shell');
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

describe('caws specs create --scope-in (CAWS-SPECS-CREATE-SCOPE-IN-001)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-scopein-')); });
  afterEach(() => rmrf(repoRoot));

  // A1: --scope-in writes scope.in at creation time.
  it('populates scope.in from repeated --scope-in flags', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-101',
      title: 'render slice',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['src/render.js', 'tests/render.test.js'],
    });
    expect(r.code).toBe(0);

    const content = fs.readFileSync(
      path.join(cawsDir, 'specs/FEAT-101.yaml'),
      'utf8'
    );
    expect(content).toMatch(/^ {4}- 'src\/render\.js'$/m);
    expect(content).toMatch(/^ {4}- 'tests\/render\.test\.js'$/m);
    // scaffold sentinel must be gone when paths are supplied
    expect(content).not.toMatch(/list the file\(s\) or directories/);
  });

  // A4 (populated branch): guidance confirms scope is set and points at
  // amend-scope for later widening — never a raw hand-edit.
  it('guidance confirms scope.in is set and points at amend-scope (populated)', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-102',
      title: 'with scope',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['src/a.js'],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/scope\.in is set from --scope-in/);
    expect(r.stdout).toMatch(/caws specs amend-scope FEAT-102 --add/);
    // Must NOT instruct a raw YAML hand-edit of scope.in.
    expect(r.stdout).not.toMatch(/open the spec and replace/);
  });

  // A4 (omitted branch): guidance routes scope-setting through amend-scope
  // (governed), not a YAML hand-edit.
  it('guidance routes through amend-scope when --scope-in omitted', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-103',
      title: 'no scope',
      mode: 'feature',
      riskTier: 3,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/caws specs amend-scope FEAT-103 --add/);
    expect(r.stdout).toMatch(/governed mutation, not a raw YAML edit/);
    // The spec still ships with the scaffold line in scope.in (unchanged).
    const content = fs.readFileSync(
      path.join(cawsDir, 'specs/FEAT-103.yaml'),
      'utf8'
    );
    expect(content).toMatch(/list the file\(s\) or directories/);
  });

  // A3: duplicates collapse to first-seen order in the written YAML.
  it('de-duplicates repeated --scope-in paths in the written spec', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-104',
      title: 'dup scope',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['x.js', 'y.js', 'x.js'],
    });
    expect(r.code).toBe(0);
    const content = fs.readFileSync(
      path.join(cawsDir, 'specs/FEAT-104.yaml'),
      'utf8'
    );
    const inLines = content
      .split('\n')
      .filter((l) => /^ {4}- '(x|y)\.js'$/.test(l));
    expect(inLines).toEqual(["    - 'x.js'", "    - 'y.js'"]);
  });
});
