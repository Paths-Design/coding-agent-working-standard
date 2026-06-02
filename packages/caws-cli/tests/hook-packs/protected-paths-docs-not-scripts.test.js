/**
 * CAWS-PROTECTED-PATHS-DOCS-NOT-SCRIPTS-001 — protected-paths.sh must guard
 * hook SCRIPTS and strike-state, NOT documentation under .claude/hooks/.
 *
 * The over-match defect: the matcher keyed on the directory glob
 * "*-slash-.claude/hooks/*" and so refused Write/Edit of
 * .claude/hooks/README.md and .claude/hooks/CLAUDE.md — neither of which is a
 * guard artifact. CLAUDE.md is in fact installer-managed (manifest-claude-code.ts
 * ships and re-writes it), so
 * the guard forbade editing the very file `caws init` owns. Refusing a
 * legitimate doc edit pushes the agent toward a bypass — the exact failure mode
 * CAWS exists to prevent (release stance).
 *
 * These drive protected-paths.sh as a real subprocess and assert on its exit
 * code + stderr. The tool_input.file_path is a CLASSIFIER INPUT ONLY;
 * protected-paths.sh never touches the file on disk.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-protected-docs-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.copyFileSync(
    path.join(PACK, 'protected-paths.sh'),
    path.join(dir, '.claude', 'hooks', 'protected-paths.sh')
  );
  // protected-paths.sh sources lib/parse-input.sh, which in turn sources
  // ../runtime-paths.sh — both must exist or `set -e` aborts before the
  // matcher runs.
  fs.copyFileSync(
    path.join(PACK, 'lib', 'parse-input.sh'),
    path.join(dir, '.claude', 'hooks', 'lib', 'parse-input.sh')
  );
  fs.copyFileSync(
    path.join(PACK, 'runtime-paths.sh'),
    path.join(dir, '.claude', 'hooks', 'runtime-paths.sh')
  );
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function runGuard(dir, filePath, toolName = 'Write') {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'protected-paths.sh')], {
    input: JSON.stringify({
      tool_name: toolName,
      tool_input: { file_path: filePath },
      session_id: 'aaaa1111-bbbb-2222-cccc-333344445555',
    }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

describe('CAWS-PROTECTED-PATHS-DOCS-NOT-SCRIPTS-001: docs admitted, scripts + strike-state blocked', () => {
  let dir;
  beforeEach(() => {
    dir = makeProject();
  });
  afterEach(() => {
    if (dir) cleanup(dir);
    dir = undefined;
  });

  // --- A1: docs under .claude/hooks/ are ADMITTED (exit 0, no BLOCKED) -------
  it.each([
    ['README.md', '/tmp/proj/.claude/hooks/README.md'],
    ['CLAUDE.md', '/tmp/proj/.claude/hooks/CLAUDE.md'],
  ])('A1: Write of .claude/hooks/%s is admitted (exit 0, no block)', (_label, fp) => {
    const r = runGuard(dir, fp, 'Write');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BLOCKED/);
  });

  it('A1: Edit of .claude/hooks/CLAUDE.md is admitted (exit 0)', () => {
    const r = runGuard(dir, '/tmp/proj/.claude/hooks/CLAUDE.md', 'Edit');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BLOCKED/);
  });

  // --- A2: hook SCRIPTS under .claude/hooks/ are BLOCKED (exit 1) ------------
  it.each([
    ['scope-guard.sh', '/tmp/proj/.claude/hooks/scope-guard.sh'],
    ['classify_command.py', '/tmp/proj/.claude/hooks/classify_command.py'],
    ['lib/parse-input.sh', '/tmp/proj/.claude/hooks/lib/parse-input.sh'],
    ['lib/worktree-claim-oracle.cjs', '/tmp/proj/.claude/hooks/lib/worktree-claim-oracle.cjs'],
    ['caws_dispatch/pre_tool_use.sh', '/tmp/proj/.claude/hooks/caws_dispatch/pre_tool_use.sh'],
  ])('A2: Write of %s is blocked (exit 1, hook-script message)', (_label, fp) => {
    const r = runGuard(dir, fp, 'Write');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BLOCKED: .* is protected\./);
    expect(r.stderr).toMatch(/hook scripts/i);
  });

  // Fail-closed: an unrecognized extension under hooks/ is still protected.
  it('A2: an unrecognized extension under .claude/hooks/ stays blocked (fail closed)', () => {
    const r = runGuard(dir, '/tmp/proj/.claude/hooks/mystery.bin', 'Write');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/BLOCKED/);
  });

  // --- A3: strike-state file is hard-blocked (exit 2) -----------------------
  it('A3: Write of .claude/logs/guard-strikes-<id>.json is hard-blocked (exit 2, reset guidance)', () => {
    const r = runGuard(dir, '/tmp/proj/.claude/logs/guard-strikes-abc.json', 'Write');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protected guard state/);
    expect(r.stderr).toMatch(/reset-strikes\.sh --current/);
  });

  // --- control: a file outside the protected sets is admitted ---------------
  it('control: an ordinary source file is admitted (exit 0)', () => {
    const r = runGuard(dir, '/tmp/proj/src/index.ts', 'Write');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BLOCKED/);
  });

  // --- control: non-Write/Edit tool is a no-op ------------------------------
  it('control: a Bash tool call is a no-op (exit 0) even targeting a hook script', () => {
    const r = runGuard(dir, '/tmp/proj/.claude/hooks/scope-guard.sh', 'Bash');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toMatch(/BLOCKED/);
  });
});
