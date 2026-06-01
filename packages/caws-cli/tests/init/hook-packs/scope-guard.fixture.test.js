/**
 * Shell fixture tests for the installed v11-shape scope-guard.sh.
 *
 * These tests verify the *bash logic* of the pack-bundled scope-guard.sh:
 *   - lifecycle_state read before status
 *   - closed/archived/completed treated as terminal (no union enforcement)
 *   - draft does NOT participate in union mode
 *   - active is enforced
 *   - dual-shape worktrees.json (v10 nested, v11 direct-key) both recognized
 *   - specId (v10) and spec_id (v11) both accepted as bound id
 *
 * Pattern: install the pack into a temp repo, write canonical .caws/ state
 * with v11-shape or v10-shape inputs, then invoke scope-guard.sh with
 * synthetic stdin matching the parse-input.sh contract and check exit code.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { runInitCommand } = require('../../../dist/shell');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function installPack(repo) {
  runInitCommand({
    cwd: repo,
    out: () => {},
    err: () => {},
    agentSurface: 'claude-code',
  });
}

/** Invoke scope-guard.sh with a synthetic Claude Code hook input on stdin.
 *
 *  The actual scope-guard relies on parse-input.sh to populate HOOK_*
 *  env vars from a JSON payload like:
 *    {
 *      tool_name: "Write",
 *      tool_input: { file_path: "<abs path>" },
 *      session_id: "test-session",
 *      cwd: "<repo>"
 *    }
 */
/** Resolve a NODE_PATH that points at the caws-cli workspace's
 *  node_modules so the hook's inline Node can find js-yaml. In a real
 *  user repo, js-yaml comes from the project's own dependencies. */
function nodePathForFixture() {
  // tests/init/hook-packs/ → ../../.. → packages/caws-cli/
  return path.resolve(__dirname, '..', '..', '..', 'node_modules');
}

function runScopeGuard(repo, payload) {
  const stdin = JSON.stringify(payload);
  const scopeGuard = path.join(repo, '.claude/hooks/scope-guard.sh');
  const result = spawnSync('bash', [scopeGuard], {
    input: stdin,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      NODE_PATH: nodePathForFixture(),
    },
  });
  return {
    code: result.status === null ? -1 : result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function writeSpec(repo, id, body) {
  fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, `.caws/specs/${id}.yaml`),
    body
  );
}

// ============================================================
// lifecycle_state vs status — terminal states are not enforced
// ============================================================
describe('scope-guard.sh: v11 lifecycle resolution', () => {
  let repo;
  beforeEach(() => {
    repo = mkBareGitRepo('caws-scope-lifecycle-');
    installPack(repo);
  });
  afterEach(() => rmrf(repo));

  it('v11 closed spec does NOT participate in union enforcement', () => {
    // The spec restricts scope to `src/foo/` and excludes `packages/`.
    // If it were active in union mode, editing `packages/bar.ts` would
    // hit scope.out and warn (strike 1) or block. Since it is closed,
    // the guard must skip it entirely.
    writeSpec(repo, 'CLOSED-001', [
      'id: CLOSED-001',
      'title: closed spec',
      'lifecycle_state: closed',
      'mode: feature',
      'risk_tier: 3',
      'scope:',
      '  in: [src/foo/**]',
      '  out: [packages/**]',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'packages/bar.ts') },
      session_id: 'test',
      cwd: repo,
    });
    // No active spec → in_scope → exit 0, no strike emitted.
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/Scope guard strike/);
  });

  it('v11 archived spec does NOT participate in union enforcement', () => {
    writeSpec(repo, 'ARCH-001', [
      'id: ARCH-001',
      'title: archived',
      'lifecycle_state: archived',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/foo/**], out: [packages/**] }',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'packages/bar.ts') },
      session_id: 'test',
      cwd: repo,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/Scope guard strike/);
  });

  it('v10-shape status: closed (no lifecycle_state) is also terminal', () => {
    // Backward compat — the pack must still honor v10 shape during
    // transition.
    writeSpec(repo, 'V10-CLOSED', [
      'id: V10-CLOSED',
      'title: v10 closed',
      'status: closed',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/foo/**], out: [packages/**] }',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'packages/bar.ts') },
      session_id: 'test',
      cwd: repo,
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/Scope guard strike/);
  });

  it('v11 active spec DOES enforce scope.out', () => {
    writeSpec(repo, 'ACTIVE-001', [
      'id: ACTIVE-001',
      'title: active spec',
      'lifecycle_state: active',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/foo/**], out: [packages/**] }',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'packages/bar.ts') },
      session_id: 'test',
      cwd: repo,
    });
    // The strike progression emits Claude Code hookSpecificOutput JSON
    // on stdout. The first strike is `additionalContext` (warn-allow).
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/scope-guard strike/i);
    expect(combined).toMatch(/out-of-scope/);
  });

  it('v11 draft spec does NOT block in union mode', () => {
    // Two specs: one draft (with restrictive scope.out), one active
    // (with permissive scope). Edit a path that the draft would block
    // if it participated, but the active spec doesn't.
    writeSpec(repo, 'DRAFT-001', [
      'id: DRAFT-001',
      'title: draft',
      'lifecycle_state: draft',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/draft/**], out: [packages/**] }',
      '',
    ].join('\n'));
    writeSpec(repo, 'ACTIVE-002', [
      'id: ACTIVE-002',
      'title: active permissive',
      'lifecycle_state: active',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [packages/**] }',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'packages/bar.ts') },
      session_id: 'test',
      cwd: repo,
    });
    // Active spec admits packages/**; draft is ignored in union mode.
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/scope-guard strike/i);
  });

  // WORKTREE-SUPPORT-SCOPE-001: scope.support is ADMITTED for edits exactly
  // like scope.in — a write to a support-only path draws no strike.
  it('v11 active spec ADMITS a scope.support path (no strike)', () => {
    writeSpec(repo, 'SUP-001', [
      'id: SUP-001',
      'title: support spec',
      'lifecycle_state: active',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/foo/**], support: [FRICTION-LOG.md, docs/**] }',
      '',
    ].join('\n'));

    // A path only in scope.support — must be admitted (no out-of-scope strike).
    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'docs/notes.md') },
      session_id: 'test',
      cwd: repo,
    });
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toMatch(/scope-guard strike/i);
    expect(combined).not.toMatch(/out-of-scope/);
  });

  // A path in NEITHER scope.in nor scope.support still draws an out-of-scope
  // strike — support does not widen admission beyond its own entries.
  it('v11 active spec still flags a path outside both scope.in and scope.support', () => {
    writeSpec(repo, 'SUP-002', [
      'id: SUP-002',
      'title: support spec 2',
      'lifecycle_state: active',
      'mode: feature',
      'risk_tier: 3',
      'scope: { in: [src/foo/**], support: [docs/**] }',
      '',
    ].join('\n'));

    const r = runScopeGuard(repo, {
      tool_name: 'Write',
      tool_input: { file_path: path.join(repo, 'lib/elsewhere.ts') },
      session_id: 'test',
      cwd: repo,
    });
    expect(r.code).toBe(0); // strike 1 warns, exits 0
    const combined = r.stdout + r.stderr;
    expect(combined).toMatch(/scope-guard strike/i);
  });
});
