/**
 * @fileoverview WORKTREE-ISOLATION-HARDENING-001 (Fix 5) — worktree-guard.sh
 * closes the git-restore synonym gap.
 *
 * `git restore <path>`, `git checkout -- <path>`, and `git clean` all DISCARD
 * working-tree content by path — the same work-loss hazard as `git reset
 * --hard` — yet were matched nowhere in worktree-guard (only a bare
 * `git restore .` was a classifier deny). With worktrees active they must block
 * (exit 2), worded by the actual operation (a path restore is NOT a branch
 * switch). With NO worktrees active the guard early-exits (exit 0) and these
 * commands are unaffected.
 *
 * Real-subprocess harness: a git repo with worktree-guard.sh + lib installed,
 * a worktrees.json with one active entry, the guard invoked on a Bash command.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-wgrestore-'));
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  sh('git', ['config', 'user.name', 'test'], dir);
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(PACK, 'worktree-guard.sh'), path.join(dir, '.claude', 'hooks', 'worktree-guard.sh'));
  fs.copyFileSync(path.join(PACK, 'runtime-paths.sh'), path.join(dir, '.claude', 'hooks', 'runtime-paths.sh'));
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'init'], dir);
  return dir;
}

function activateWorktree(dir) {
  const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
  fs.mkdirSync(wtPath, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.caws', 'worktrees.json'),
    JSON.stringify({ 'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'X-001' } }, null, 2)
  );
}

function guard(dir, command) {
  const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: dir, session_id: 'sess' });
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'worktree-guard.sh')], {
    input, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

describe('WORKTREE-ISOLATION-HARDENING-001 Fix 5: git restore synonym gap', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('git restore <path> with worktrees active -> BLOCK (exit 2), worded as path restore', () => {
    dir = makeRepo();
    activateWorktree(dir);
    const r = guard(dir, 'git restore src/x.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/git restore/);
    expect(r.stderr).toMatch(/NOT a branch switch/);
  });

  test('git checkout -- <path> with worktrees active -> BLOCK (exit 2)', () => {
    dir = makeRepo();
    activateWorktree(dir);
    const r = guard(dir, 'git checkout -- src/x.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/working-tree discard/);
  });

  test('git clean with worktrees active -> BLOCK (exit 2)', () => {
    dir = makeRepo();
    activateWorktree(dir);
    const r = guard(dir, 'git clean -fd');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/git clean/);
  });

  test('git restore with NO worktrees active -> PASS (exit 0)', () => {
    dir = makeRepo();
    // no worktrees.json => guard early-exits before the dangerous-op section.
    const r = guard(dir, 'git restore src/x.ts');
    expect(r.status).toBe(0);
  });

  test('read-only git (status) with worktrees active -> PASS (exit 0)', () => {
    dir = makeRepo();
    activateWorktree(dir);
    const r = guard(dir, 'git status');
    expect(r.status).toBe(0);
  });
});
