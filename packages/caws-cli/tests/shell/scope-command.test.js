/**
 * Tests for `runScopeCommand` — covers the pinned exit-code table:
 *
 *   | command       | 0                  | 1                            | 2              |
 *   |---------------|--------------------|------------------------------|----------------|
 *   | scope show    | always             | (never)                      | composition err|
 *   | scope check   | admit only         | reject / no_auth / invalid   | composition err|
 *
 * The two modes share one decision path; only the exit-code policy
 * differs. The renderer uses the shell's `ResolvedBinding` to color the
 * `unbound` no-authority case.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runScopeCommand } = require('../../dist/shell');

const VALID_SPEC = (id, worktree) => `id: ${id}
title: A reasonably long title for the feature being shipped
risk_tier: 3
mode: feature
lifecycle_state: active
${worktree !== undefined ? `worktree: ${worktree}\n` : ''}blast_radius:
  modules:
    - src/test
scope:
  in:
    - "src/**"
  out:
    - "src/forbidden/"
invariants:
  - "Some invariant."
acceptance:
  - id: A1
    given: a precondition
    when: an action
    then: an outcome
non_functional: {}
contracts: []
`;

const VALID_POLICY = `version: 1
risk_tiers:
  "1": { max_files: 5, max_loc: 200 }
  "2": { max_files: 15, max_loc: 600 }
  "3": { max_files: 30, max_loc: 1500 }
gates:
  budget_limit: { enabled: true, mode: block }
  spec_completeness: { enabled: true, mode: block }
  scope_boundary: { enabled: true, mode: block }
  god_object: { enabled: true, mode: warn }
  todo_detection: { enabled: true, mode: warn }
`;

function mkTempGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function captureRun(cwd, p, mode) {
  const outLines = [];
  const errLines = [];
  const code = runScopeCommand({
    cwd,
    path: p,
    mode,
    out: (s) => outLines.push(s),
    err: (s) => errLines.push(s),
  });
  return { code, stdout: outLines.join('\n'), stderr: errLines.join('\n') };
}

describe('runScopeCommand — exit 2 composition errors', () => {
  const dirs = [];
  afterEach(() => {
    while (dirs.length > 0) {
      const d = dirs.pop();
      rmrf(d);
    }
  });

  it('show: cwd outside a git repo → exit 2', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scope-nogit-'));
    dirs.push(nonGitDir);
    const r = captureRun(nonGitDir, 'src/x.ts', 'show');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed to resolve repo root/);
  });

  it('check: cwd outside a git repo → exit 2', () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scope-nogit-'));
    dirs.push(nonGitDir);
    const r = captureRun(nonGitDir, 'src/x.ts', 'check');
    expect(r.code).toBe(2);
  });

  it('show: no policy.yaml → exit 2 with clear message', () => {
    const noPolicyRepo = mkTempGitRepo('caws-scope-nopol-');
    dirs.push(noPolicyRepo);
    const r = captureRun(noPolicyRepo, 'src/x.ts', 'show');
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/no policy\.yaml loaded/);
    expect(r.stderr).toMatch(/caws doctor/);
  });
});

describe('runScopeCommand — unbound: scope show always 0, scope check 1', () => {
  let repoRoot;
  afterEach(() => rmrf(repoRoot));

  it('show: unbound + outside any worktree → exit 0, renders "outside any worktree"', () => {
    repoRoot = mkTempGitRepo('caws-scope-unbound-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, 'src/x.ts', 'show');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('scope.no_authority.unbound');
    expect(r.stdout).toMatch(/outside any CAWS-tracked worktree/);
  });

  it('check: unbound + outside any worktree → exit 1', () => {
    repoRoot = mkTempGitRepo('caws-scope-unbound-chk-');
    fs.writeFileSync(path.join(repoRoot, '.caws', 'policy.yaml'), VALID_POLICY);
    const r = captureRun(repoRoot, 'src/x.ts', 'check');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('scope.no_authority.unbound');
  });
});

describe('runScopeCommand — bound worktree admit / reject', () => {
  let mainRoot;
  let worktreeRoot;
  let worktreeBranch;

  beforeAll(() => {
    mainRoot = mkTempGitRepo('caws-scope-main-');
    // Seed the main repo with a valid spec bound to a worktree named
    // "wt-foo". Then create the actual git worktree at a known path.
    fs.writeFileSync(
      path.join(mainRoot, '.caws', 'policy.yaml'),
      VALID_POLICY
    );
    fs.writeFileSync(
      path.join(mainRoot, '.caws', 'specs', 'FOO-1.yaml'),
      VALID_SPEC('FOO-1', 'wt-foo')
    );

    worktreeBranch = 'scope-test-wt';
    worktreeRoot = path.join(
      os.tmpdir(),
      `caws-scope-wt-${process.pid}-${Date.now()}`
    );
    execFileSync('git', [
      '-C', mainRoot, 'worktree', 'add', '-b', worktreeBranch, worktreeRoot,
    ]);

    // Now the worktrees.json must point at the worktreeRoot AND name it
    // "wt-foo" so bidirectional binding holds (spec.worktree === "wt-foo").
    fs.writeFileSync(
      path.join(mainRoot, '.caws', 'worktrees.json'),
      JSON.stringify({
        'wt-foo': { specId: 'FOO-1', path: worktreeRoot },
      })
    );
  });

  afterAll(() => {
    try {
      execFileSync('git', [
        '-C', mainRoot, 'worktree', 'remove', '--force', worktreeRoot,
      ]);
    } catch {
      /* ignore */
    }
    rmrf(mainRoot);
    rmrf(worktreeRoot);
  });

  it('show inside worktree, path in scope.in → ADMIT, exit 0', () => {
    const r = captureRun(worktreeRoot, 'src/foo.ts', 'show');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ADMIT');
    expect(r.stdout).toContain('binding: bound');
  });

  it('check inside worktree, path in scope.in → ADMIT, exit 0', () => {
    const r = captureRun(worktreeRoot, 'src/foo.ts', 'check');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ADMIT');
  });

  it('check inside worktree, path in scope.out → REJECT, exit 1', () => {
    const r = captureRun(worktreeRoot, 'src/forbidden/x.ts', 'check');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('REJECT');
  });

  it('show inside worktree, path in scope.out → REJECT, but still exit 0', () => {
    const r = captureRun(worktreeRoot, 'src/forbidden/x.ts', 'show');
    expect(r.code).toBe(0); // show always exits 0 after rendering
    expect(r.stdout).toContain('REJECT');
  });

  it('check with invalid (absolute) path → INVALID, exit 1', () => {
    const r = captureRun(worktreeRoot, '/absolute/x.ts', 'check');
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('INVALID');
  });
});
