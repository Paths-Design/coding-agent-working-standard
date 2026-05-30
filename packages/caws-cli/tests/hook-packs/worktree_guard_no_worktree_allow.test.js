/**
 * @fileoverview CAWS-GUARD-NO-WORKTREE-NO-BLOCK-001 — the worktree-write-guard
 * protects worktree ISOLATION, so with ZERO active worktrees there is nothing
 * to isolate and a base-branch write is allowed (exit 0), not asked.
 *
 *   A1  zero worktrees, base-branch source write → exit 0, no envelope (allow).
 *   A2  one worktree claiming the file → still hard-blocks (exit 2).
 *   A3  one worktree not claiming the file → still asks.
 *
 * Before this fix a zero-worktree base-branch edit returned ask, and because a
 * PreToolUse ask cannot be pre-approved by auto-mode and re-fires every retry,
 * an agent doing first-run setup (editing on main before creating any worktree)
 * was wedged on an un-dismissable prompt with no worktree to switch into.
 *
 * Same harness shape as worktree_guard_risk_surface.test.js: a real git repo
 * with the guard + lib installed, guard invoked as a subprocess on a base-branch
 * edit from the repo root.
 *
 * @author @darianrosebrook
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code'
);

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-wgnw-'));
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  sh('git', ['config', 'user.name', 'test'], dir);
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(PACK, 'worktree-write-guard.sh'),
    path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')
  );
  fs.copyFileSync(
    path.join(PACK, 'runtime-paths.sh'),
    path.join(dir, '.claude', 'hooks', 'runtime-paths.sh')
  );
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(
      path.join(PACK, 'lib', f),
      path.join(dir, '.claude', 'hooks', 'lib', f)
    );
  }
  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'caws-cli', 'src'), {
    recursive: true,
  });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'init'], dir);
  return dir;
}

function writeRegistry(dir, entries) {
  fs.writeFileSync(
    path.join(dir, '.caws', 'worktrees.json'),
    JSON.stringify(entries, null, 2)
  );
}

function writeSpec(dir, id, { lifecycle = 'active', scopeIn = [] }) {
  const lines = [
    `id: ${id}`,
    `title: '${id} fixture'`,
    'risk_tier: 3',
    'mode: refactor',
    `lifecycle_state: ${lifecycle}`,
    'scope:',
    '  in:',
    ...(scopeIn.length
      ? scopeIn.map((p) => `    - ${p}`)
      : ['    - packages/nothing']),
    '  out:',
  ];
  fs.writeFileSync(
    path.join(dir, '.caws', 'specs', `${id}.yaml`),
    lines.join('\n') + '\n'
  );
}

function registerWorktree(dir, name, specId) {
  const wtPath = path.join(dir, '.caws', 'worktrees', name);
  fs.mkdirSync(wtPath, { recursive: true });
  return { path: wtPath, branch: name, baseBranch: 'main', spec_id: specId };
}

function guard(dir, relFile) {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(dir, relFile) },
    cwd: dir,
    session_id: 'test-session',
  });
  return spawnSync(
    'bash',
    [path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')],
    {
      input,
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    }
  );
}

describe('CAWS-GUARD-NO-WORKTREE-NO-BLOCK-001', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // ── A1: zero worktrees → allow (exit 0, no envelope) ──────────────
  test('A1: base-branch source write with ZERO worktrees → exit 0, no ask/block', () => {
    dir = makeRepo();
    writeRegistry(dir, {}); // no worktrees registered
    const r = guard(dir, 'packages/caws-cli/src/foo.ts');
    expect(r.status).toBe(0);
    // No permissionDecision envelope at all (clean allow, not an ask).
    expect(r.stdout.trim()).toBe('');
  });

  test('A1: even an empty worktrees.json missing entirely → allow', () => {
    dir = makeRepo();
    // Do NOT write a registry at all beyond the {} created by makeRepo? Ensure {}.
    writeRegistry(dir, {});
    const r = guard(dir, 'packages/caws-cli/src/bar.ts');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  // ── A2: one worktree claiming the file → still hard-block (unchanged) ──
  test('A2: with a worktree claiming the file, claimed write still hard-blocks (exit 2)', () => {
    dir = makeRepo();
    writeRegistry(dir, { 'wt-a': registerWorktree(dir, 'wt-a', 'CLAIM-001') });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/target.ts'],
    });
    const r = guard(dir, 'packages/caws-cli/src/target.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/claimed by an active worktree's scope\.in/);
  });

  // ── A3: one worktree not claiming the file → still asks (unchanged) ──
  test('A3: with a worktree present but not claiming, base-branch write still asks', () => {
    dir = makeRepo();
    writeRegistry(dir, { 'wt-a': registerWorktree(dir, 'wt-a', 'CLAIM-001') });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/other.ts'],
    });
    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    expect(r.status).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.hookSpecificOutput.permissionDecision).toBe('ask');
  });
});
