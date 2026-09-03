'use strict';

/**
 * Command-level contract tests for CANONICAL-DRIFT-GUARDS-001 —
 * prevention (A3/A4), inertness (A6), and relocation recovery (A5).
 *
 * The kernel finding itself (A1/A2) is covered in
 * tests/kernel/canonical-drift-doctor.test.js; this suite proves the
 * store-observation wiring end-to-end via `caws doctor` too.
 *
 * SUT: dist (npm run build compiles first).
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsRelocateCommand,
} = require('../../dist/shell/commands/specs');
const { runDoctorCommand } = require('../../dist/shell/commands/doctor');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const { resolveGitBinary } = require('../../dist/store');

afterAll(() => {
  cleanupAll();
});

function git(root, args) {
  return execFileSync(resolveGitBinary(), ['-C', root, ...args], { encoding: 'utf8' }).toString().trim();
}

function mkRepo() {
  const root = makeTempRepo();
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

/** A parked canonical: branch feat/other off main, one registered worktree on main. */
function parkCanonical(root, cawsDir) {
  git(root, ['checkout', '-q', '-b', 'feat/other']);
  const wtPath = path.join(cawsDir, 'worktrees', 'wt-demo');
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify({
    'wt-demo': {
      branch: 'wt-demo', baseBranch: 'main', specId: 'SPEC-001', path: wtPath,
    },
  }, null, 2) + '\n');
}

function create(root, extra = {}) {
  const out = []; const err = [];
  const code = runSpecsCreateCommand({
    id: 'CD-001',
    title: 'Canonical drift test spec',
    mode: 'chore',
    riskTier: 3,
    scopeIn: ['tests'],
    module: ['tests'],
    invariant: ['fixture'],
    cwd: root,
    env: { ...process.env },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...extra,
  });
  return { code, out, err };
}

describe('CANONICAL-DRIFT-GUARDS-001 command surface', () => {
  test('A1/A2 (e2e): doctor fires on parked canonical via store observation; silent when un-parked', () => {
    const { root, cawsDir } = mkRepo();
    parkCanonical(root, cawsDir);

    const out1 = []; const err1 = [];
    runDoctorCommand({ cwd: root, out: (l) => out1.push(l), err: (l) => err1.push(l) });
    const text1 = [...out1, ...err1].join('\n');
    expect(text1).toContain('doctor.canonical.mis_parked_head');
    expect(text1).toContain('feat/other');

    // Un-park: back on main => no finding.
    git(root, ['checkout', '-q', 'main']);
    const out2 = []; const err2 = [];
    runDoctorCommand({ cwd: root, out: (l) => out2.push(l), err: (l) => err2.push(l) });
    expect([...out2, ...err2].join('\n')).not.toContain('doctor.canonical.mis_parked_head');
  });

  test('A3: lifecycle create REFUSES pre-write on a parked canonical; nothing lands', () => {
    const { root, cawsDir } = mkRepo();
    parkCanonical(root, cawsDir);
    const eventsBefore = fs.existsSync(path.join(cawsDir, 'events.jsonl'));

    const r = create(root);
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('feat/other');
    expect(text).toContain('--allow-foreign-branch');
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'CD-001.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(cawsDir, 'events.jsonl'))).toBe(eventsBefore);
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/other'); // untouched
  });

  test('A4: --allow-foreign-branch proceeds (operator deliberately authors on the parked branch)', () => {
    const { root, cawsDir } = mkRepo();
    parkCanonical(root, cawsDir);
    const r = create(root, { allowForeignBranch: true });
    expect(r.code).toBe(0);
    // The spec landed on the parked branch.
    expect(git(root, ['ls-tree', '--name-only', 'HEAD', '--', '.caws/specs/CD-001.yaml'])).toContain('CD-001.yaml');
  });

  test('A5: relocate dry-run then apply — object plumbing only, base CAS lands', () => {
    const { root, cawsDir } = mkRepo();
    parkCanonical(root, cawsDir);
    // A spec committed on the parked branch (via the sanctioned escape).
    expect(create(root, { allowForeignBranch: true, id: 'CD-002' }).code).toBe(0);

    // Dry-run: names source/target, mutates nothing.
    const dry = (() => {
      const out = []; const err = [];
      const code = runSpecsRelocateCommand({
        id: 'CD-002', cwd: root,
        out: (l) => out.push(l), err: (l) => err.push(l),
      });
      return { code, text: out.join('\n') + err.join('\n') };
    })();
    expect(dry.code).toBe(0);
    expect(dry.text).toContain('dry-run');
    expect(dry.text).toContain('feat/other');
    expect(dry.text).toContain('main');
    expect(git(root, ['rev-parse', 'main'])).toBeDefined();

    const mainBefore = git(root, ['rev-parse', 'main']);
    const applied = (() => {
      const out = []; const err = [];
      const code = runSpecsRelocateCommand({
        id: 'CD-002', apply: true, cwd: root,
        out: (l) => out.push(l), err: (l) => err.push(l),
      });
      return { code, text: out.join('\n') + err.join('\n') };
    })();
    expect(applied.code).toBe(0);
    expect(applied.text).toContain('relocated onto main');

    // Base advanced and now carries the spec; canonical working tree untouched.
    expect(git(root, ['rev-parse', 'main'])).not.toBe(mainBefore);
    expect(git(root, ['ls-tree', '--name-only', 'main', '--', '.caws/specs/CD-002.yaml'])).toContain('CD-002.yaml');
    expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('feat/other');
    expect(fs.existsSync(path.join(cawsDir, 'specs', 'CD-002.yaml'))).toBe(true);
    // No temp index residue under .git.
    expect(fs.readdirSync(path.join(root, '.git')).filter((f) => f.startsWith('caws-relocate-'))).toEqual([]);
  });

  test('A5b: relocate on-base is the healthy no-op', () => {
    const { root } = mkRepo();
    const cawsDir = path.join(root, '.caws');
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-demo');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify({
      'wt-demo': { branch: 'wt-demo', baseBranch: 'main', specId: 'SPEC-001', path: wtPath },
    }, null, 2) + '\n');
    // canonical stays on main
    const r = (() => {
      const out = []; const err = [];
      const code = runSpecsRelocateCommand({
        id: 'CD-003', cwd: root, out: (l) => out.push(l), err: (l) => err.push(l),
      });
      return { code, text: out.join('\n') + err.join('\n') };
    })();
    expect(r.code).toBe(0);
    expect(r.text).toContain('already sits on the base branch');
  });

  test('A6: lifecycle create on a HEALTHY canonical is byte-inert (no refusal)', () => {
    const { root, cawsDir } = mkRepo();
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-demo');
    fs.mkdirSync(wtPath, { recursive: true });
    fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify({
      'wt-demo': { branch: 'wt-demo', baseBranch: 'main', specId: 'SPEC-001', path: wtPath },
    }, null, 2) + '\n');
    const r = create(root);
    expect(r.code).toBe(0);
    expect(r.err.join('\n')).not.toContain('--allow-foreign-branch');
  });
});
