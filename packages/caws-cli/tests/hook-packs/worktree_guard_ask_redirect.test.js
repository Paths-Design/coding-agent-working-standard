/**
 * @fileoverview CAWS-GUARD-ASK-ACTIONABLE-REDIRECT-001 — the
 * worktree-write-guard's ask/block reason names a CONCRETE worktree + cd path
 * so a misguided agent self-corrects instead of looping the human on an
 * un-dismissable PreToolUse `ask` (which auto-mode cannot pre-approve and which
 * re-fires on every retry).
 *
 *   A1  non-claimed base-branch write, exactly ONE active worktree →
 *       ask reason names the worktree + `cd .caws/worktrees/<wt>`.
 *   A2  zero / 2+ worktrees → generic `caws worktree list` guidance, no
 *       fabricated single cd path.
 *   A3  claimed:* hard-block → still exit 2, message names `cd .caws/worktrees/<wt>`.
 *   A4  decision model unchanged (exit codes preserved).
 *
 * Reuses the harness shape from worktree_guard_risk_surface.test.js: a real
 * git repo with the guard + lib installed, a .caws control plane, the guard
 * invoked as a subprocess against a base-branch edit from the repo root.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-wgar-'));
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

function askReason(stdout) {
  try {
    const j = JSON.parse(stdout);
    return j?.hookSpecificOutput?.permissionDecision === 'ask'
      ? j.hookSpecificOutput.permissionDecisionReason || ''
      : null;
  } catch {
    return null;
  }
}

describe('CAWS-GUARD-ASK-ACTIONABLE-REDIRECT-001', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // ── A1: one worktree, non-claimed write → ask names the worktree + cd path ──
  test('A1: single-worktree non-claimed ask names the worktree and cd path', () => {
    dir = makeRepo();
    writeRegistry(dir, { 'wt-solo': registerWorktree(dir, 'wt-solo', 'CLAIM-001') });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/other.ts'], // does NOT claim our file
    });

    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    expect(r.status).toBe(0);
    const reason = askReason(r.stdout);
    expect(reason).not.toBeNull();
    expect(reason).toContain('wt-solo');
    expect(reason).toContain('cd .caws/worktrees/wt-solo');
  });

  // ── A2: zero worktrees → generic guidance, no fabricated cd path ──
  test('A2: zero worktrees → generic worktree-list guidance, no specific cd path', () => {
    dir = makeRepo();
    writeRegistry(dir, {}); // no worktrees
    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    const reason = askReason(r.stdout);
    // Either ask (exit 0) — assert it does NOT invent a cd .caws/worktrees/<x> path.
    if (reason !== null) {
      expect(reason).not.toMatch(/cd \.caws\/worktrees\/\S/);
      expect(reason).toMatch(/caws worktree (list|create)/);
    } else {
      // zero-worktree-on-main may degrade to block depending on config; that's
      // an acceptable pre-existing behavior — just assert no fabricated path
      // leaked to stderr.
      expect(r.stderr).not.toMatch(/cd \.caws\/worktrees\/\S/);
    }
  });

  test('A2: two worktrees → generic guidance, no single cd path', () => {
    dir = makeRepo();
    writeRegistry(dir, {
      'wt-a': registerWorktree(dir, 'wt-a', 'CLAIM-001'),
      'wt-b': registerWorktree(dir, 'wt-b', 'CLAIM-002'),
    });
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/x/a.ts'] });
    writeSpec(dir, 'CLAIM-002', { lifecycle: 'active', scopeIn: ['packages/x/b.ts'] });

    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    const reason = askReason(r.stdout);
    expect(reason).not.toBeNull();
    expect(reason).not.toMatch(/cd \.caws\/worktrees\/\S/);
    expect(reason).toMatch(/caws worktree (list|create)/);
  });

  // ── A3: claimed hard-block still exit 2, with cd path ──
  test('A3: claimed write hard-blocks (exit 2) and names cd .caws/worktrees/<wt>', () => {
    dir = makeRepo();
    writeRegistry(dir, { 'wt-claim': registerWorktree(dir, 'wt-claim', 'CLAIM-001') });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/target.ts'],
    });

    const r = guard(dir, 'packages/caws-cli/src/target.ts');
    expect(r.status).toBe(2); // decision model unchanged
    expect(r.stderr).toMatch(/claimed by an active worktree's scope\.in/);
    expect(r.stderr).toContain('cd .caws/worktrees/wt-claim');
  });

  // ── A4: in-worktree write still exits 0 (decision model unchanged) ──
  test('A4: a write from INSIDE the worktree still exits 0', () => {
    dir = makeRepo();
    const entry = registerWorktree(dir, 'wt-inside', 'CLAIM-001');
    writeRegistry(dir, { 'wt-inside': entry });
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/caws-cli/src/target.ts'] });
    // Invoke with cwd INSIDE the worktree dir.
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { file_path: path.join(entry.path, 'src/target.ts') },
      cwd: entry.path,
      session_id: 'test-session',
    });
    const r = spawnSync(
      'bash',
      [path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')],
      { input, encoding: 'utf8', timeout: 15000, env: { ...process.env, CLAUDE_PROJECT_DIR: dir } }
    );
    expect(r.status).toBe(0);
  });
});
