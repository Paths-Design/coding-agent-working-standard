/**
 * Tests for the contracts-warning behavior on `caws specs create`
 * (CAWS-SPECS-CONTRACTS-WARNING-PORT-001).
 *
 * Coverage:
 *   A1  --mode feature emits a stderr warning naming the spec id and
 *       suggesting `caws specs update <id>`. Exit code is 0; the spec
 *       file is created on disk with mode=feature and contracts=[].
 *   A2  --mode chore does NOT emit a contracts warning.
 *   A3  None of the non-feature modes (refactor, fix, doc, chore) emit
 *       the warning.
 *   A4  The warning never includes an on-disk path (.caws/specs/...);
 *       it carries only the spec id and the suggested update command.
 *
 * The warning fires through the bound `err()` writer (stderr by
 * convention), so it is asserted on `r.stderr`. The legacy
 * tests/specs-contracts-warning.test.js continues to assert the same
 * behavior on the legacy src/commands/specs.js path; both surfaces are
 * independent and both warnings are correct.
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
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
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
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('CAWS-SPECS-CONTRACTS-WARNING-PORT-001: runSpecsCreateCommand contracts warning', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-contracts-warn-')); });
  afterEach(() => rmrf(repoRoot));

  it('A1: --mode feature emits stderr warning, succeeds, writes spec with contracts=[]', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEATCONTR-01',
      title: 'feature with no contracts',
      mode: 'feature',
      riskTier: 2,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('FEATCONTR-01');
    expect(r.stderr).toContain('caws specs update');
    expect(r.stderr).toMatch(/mode=feature/);
    expect(r.stderr).toMatch(/no contracts/i);

    const filePath = path.join(cawsDir, 'specs/FEATCONTR-01.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^mode: feature/m);
    expect(content).toMatch(/^contracts: \[\]/m);
  });

  it('A2: --mode chore does NOT emit a contracts warning', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'CHORENOWARN-01',
      title: 'chore quiet',
      mode: 'chore',
      riskTier: 2,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/contracts/i);
    expect(r.stderr).not.toMatch(/caws specs update/);
    expect(r.stdout).not.toMatch(/contracts/i);
    expect(r.stdout).not.toMatch(/caws specs update/);
  });

  it('A3: no non-feature mode emits the contracts warning', () => {
    const modes = ['refactor', 'fix', 'doc', 'chore'];
    for (const mode of modes) {
      const id = `NOWARN-${mode.toUpperCase()}-1`;
      const r = capture(runSpecsCreateCommand, {
        cwd: repoRoot,
        id,
        title: `${mode} probe`,
        mode,
        riskTier: 3,
      });
      expect(r.code).toBe(0);
      expect(r.stderr).not.toMatch(/no contracts/i);
      expect(r.stderr).not.toMatch(/caws specs update/);
    }
  });

  it('A4: warning does NOT include an on-disk path or absolute filesystem location', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'NOPATH-01',
      title: 'path-portable warning',
      mode: 'feature',
      riskTier: 2,
    });
    expect(r.code).toBe(0);

    // The warning line itself (not other stderr lines) must not contain
    // ".caws/specs/" or any absolute path. Grep for it explicitly.
    const warningLine = r.stderr
      .split('\n')
      .find((line) => /no contracts/i.test(line));
    expect(warningLine).toBeDefined();
    expect(warningLine).not.toMatch(/\.caws\/specs\//);
    expect(warningLine).not.toMatch(/^\//); // no absolute paths
    expect(warningLine).not.toMatch(/\/tmp\//);
    expect(warningLine).not.toMatch(repoRoot);
  });
});
