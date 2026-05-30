/**
 * @fileoverview WORKTREE-GUARD-RISK-SURFACE-001 — worktree-write-guard's
 * base-branch block→ask decision model.
 *
 * The guard previously HARD-BLOCKED every Write/Edit on the base branch while
 * ANY worktree registry entry existed (status != destroyed/missing), matching
 * scope.in AND scope.out, with no dir-existence or lifecycle check. That is
 * the same over-broad-authority class as the caws "scope.out from any spec
 * makes paths hostile regardless of binding" bug: registry presence alone
 * conferred hostility, so an orphaned (dir-gone) entry walled every write.
 *
 * New model (this slice):
 *   - HARD BLOCK (exit 2) ONLY when an ACTIVE bound spec's scope.IN claims the
 *     file (SPEC_CONTENTION_CHECK=claimed:*). Draft/closed bindings, scope.out
 *     matches, and orphaned entries do NOT block.
 *   - Every other base-branch case → permissionDecision:ask (exit 0) with a
 *     risk reason, UNLESS the harness can't ask (CAWS_GUARD_NO_ASK=1) → degrade
 *     to a hard block (exit 2), never a silent allow.
 *   - A dir-gone registry entry never counts as an active worktree.
 *
 * Strategy: build an isolated git repo with .claude/hooks (guard + lib) and a
 * .caws/ control plane (worktrees.json + specs), invoke worktree-write-guard.sh
 * as a real subprocess against a base-branch ("main") edit, assert exit code +
 * envelope. We run the agent from the repo ROOT (not inside a worktree dir) so
 * the base-branch enforcement path is exercised.
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
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

/**
 * Build a git repo with the guard + lib installed and a .caws/ control plane.
 * Returns the repo dir. The repo's default branch is "main".
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-wgrs-'));
  // git init + a commit so HEAD/branch resolve.
  sh('git', ['init', '-q', '-b', 'main'], dir);
  sh('git', ['config', 'user.email', 'test@example.com'], dir);
  sh('git', ['config', 'user.name', 'test'], dir);

  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(PACK, 'worktree-write-guard.sh'),
    path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')
  );
  // runtime-paths.sh lives at the pack root (sibling of lib/) and is sourced
  // by lib/parse-input.sh via "$lib/../runtime-paths.sh".
  fs.copyFileSync(
    path.join(PACK, 'runtime-paths.sh'),
    path.join(dir, '.claude', 'hooks', 'runtime-paths.sh')
  );
  for (const f of ['parse-input.sh', 'caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }

  fs.mkdirSync(path.join(dir, '.caws', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'packages', 'caws-cli', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  sh('git', ['add', '-A'], dir);
  sh('git', ['commit', '-qm', 'init'], dir);
  return dir;
}

/** Write a worktrees.json (v11 direct-key shape) into the repo. */
function writeRegistry(dir, entries) {
  fs.writeFileSync(
    path.join(dir, '.caws', 'worktrees.json'),
    JSON.stringify(entries, null, 2)
  );
}

/** Write a spec YAML with the given lifecycle_state + scope. */
function writeSpec(dir, id, { lifecycle = 'active', scopeIn = [], scopeOut = [] }) {
  const lines = [
    `id: ${id}`,
    `title: '${id} fixture'`,
    'risk_tier: 3',
    'mode: refactor',
    `lifecycle_state: ${lifecycle}`,
    'scope:',
    '  in:',
    ...(scopeIn.length ? scopeIn.map((p) => `    - ${p}`) : ['    - packages/nothing']),
    '  out:',
    ...(scopeOut.length ? scopeOut.map((p) => `    - ${p}`) : []),
  ];
  fs.writeFileSync(path.join(dir, '.caws', 'specs', `${id}.yaml`), lines.join('\n') + '\n');
}

/**
 * Invoke the guard for an Edit of `relFile` from the repo root (base branch).
 * Returns the spawnSync result.
 */
function guard(dir, relFile, extraEnv = {}) {
  const input = JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: path.join(dir, relFile) },
    cwd: dir,
    session_id: 'test-session',
  });
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...extraEnv },
  });
}

/** Does the stdout carry a permissionDecision:ask envelope? */
function isAsk(stdout) {
  try {
    const j = JSON.parse(stdout);
    return j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision === 'ask';
  } catch (_) {
    return false;
  }
}

describe('WORKTREE-GUARD-RISK-SURFACE-001: base-branch block→ask', () => {
  let dir;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // A1: active bound spec's scope.in claims the file → HARD BLOCK (exit 2).
  test('A1 active-bound-spec scope.in claim → block (exit 2)', () => {
    dir = makeRepo();
    const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(dir, {
      'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'CLAIM-001' },
    });
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/caws-cli/src/target.ts'] });

    const r = guard(dir, 'packages/caws-cli/src/target.ts');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/claimed by an active worktree's scope\.in/);
    expect(r.stderr).toMatch(/claimed:wt-a/);
  });

  // A2 (clear): worktree active but no spec claims the file → ASK (exit 0).
  test('A2 no scope claim (clear) → ask, not block', () => {
    dir = makeRepo();
    const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(dir, {
      'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'CLAIM-001' },
    });
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/caws-cli/src/other.ts'] });

    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
  });

  // A2 (scope.out): the file matches a spec's scope.OUT only → ASK, never block.
  test('A2 scope.out-only match → ask, never block', () => {
    dir = makeRepo();
    const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(dir, {
      'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'CLAIM-001' },
    });
    writeSpec(dir, 'CLAIM-001', {
      lifecycle: 'active',
      scopeIn: ['packages/caws-cli/src/mine.ts'],
      scopeOut: ['packages/caws-cli/src/forbidden.ts'],
    });

    const r = guard(dir, 'packages/caws-cli/src/forbidden.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
  });

  // Draft bound spec claiming the file → ASK (only ACTIVE specs block).
  test('draft bound spec scope.in claim → ask, not block', () => {
    dir = makeRepo();
    const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(dir, {
      'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'DRAFT-001' },
    });
    writeSpec(dir, 'DRAFT-001', { lifecycle: 'draft', scopeIn: ['packages/caws-cli/src/target.ts'] });

    const r = guard(dir, 'packages/caws-cli/src/target.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
  });

  // A3: an orphaned (dir-gone) registry entry claiming the file does NOT block.
  test('A3 dir-gone ghost entry never counts active → ask, not block', () => {
    dir = makeRepo();
    // Registry references a worktree path that does not exist on disk.
    writeRegistry(dir, {
      ghost: {
        path: path.join(dir, '.caws', 'worktrees', 'ghost-gone'),
        branch: 'ghost',
        baseBranch: 'main',
        spec_id: 'CLAIM-001',
      },
    });
    // Even though the spec is active and its scope.in matches, the ghost dir is
    // gone so it must not contribute a block.
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/caws-cli/src/target.ts'] });

    const r = guard(dir, 'packages/caws-cli/src/target.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
  });

  // No worktree at all on main → ASK (not the old unconditional block).
  test('no worktree present on main → ask, not block', () => {
    dir = makeRepo();
    writeRegistry(dir, {});
    const r = guard(dir, 'packages/caws-cli/src/anything.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
  });

  // A4: CAWS_GUARD_NO_ASK=1 → degrade a would-be ask to a hard block (exit 2).
  test('A4 CAWS_GUARD_NO_ASK=1 degrades ask → hard block', () => {
    dir = makeRepo();
    writeRegistry(dir, {});
    const r = guard(dir, 'packages/caws-cli/src/anything.ts', { CAWS_GUARD_NO_ASK: '1' });
    expect(r.status).toBe(2);
    expect(isAsk(r.stdout)).toBe(false);
    expect(r.stderr).toMatch(/ask-incapable harness/);
  });

  // A7: the ask reason carries the composite risk signal (dir/spec/agents).
  // The fixture has one active worktree+spec, so the risk line names an
  // active spec; the target dir exists (packages/caws-cli/src created by
  // makeRepo). We assert the structured risk token is present.
  test('A7 ask reason carries the composite risk signal', () => {
    dir = makeRepo();
    const wtPath = path.join(dir, '.caws', 'worktrees', 'wt-a');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(dir, {
      'wt-a': { path: wtPath, branch: 'wt-a', baseBranch: 'main', spec_id: 'CLAIM-001' },
    });
    writeSpec(dir, 'CLAIM-001', { lifecycle: 'active', scopeIn: ['packages/caws-cli/src/other.ts'] });

    // Edit an unclaimed but real-dir file → ask, reason should embed risk[...].
    const r = guard(dir, 'packages/caws-cli/src/unclaimed.ts');
    expect(r.status).toBe(0);
    expect(isAsk(r.stdout)).toBe(true);
    const reason = JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/risk\[/);
    // The active bound spec is surfaced in the risk signal.
    expect(reason).toMatch(/active-specs:1\(CLAIM-001\)/);
    // The target dir exists (makeRepo created packages/caws-cli/src).
    expect(reason).toMatch(/dir:exists/);
  });

  // Happy path preserved: an allowlisted path (.caws/) is allowed (exit 0, no ask).
  test('allowlisted .caws/ path is allowed (exit 0, no envelope)', () => {
    dir = makeRepo();
    writeRegistry(dir, {});
    const r = guard(dir, '.caws/specs/SOMETHING.yaml');
    expect(r.status).toBe(0);
    // Allowlist exits 0 silently — not via an ask envelope.
    expect(isAsk(r.stdout)).toBe(false);
  });
});
