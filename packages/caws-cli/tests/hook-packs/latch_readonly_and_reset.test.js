/**
 * @fileoverview CAWS-LATCH-READONLY-AND-WORKTREE-GITIGNORE-001 (A1-A4) —
 * the danger-latch no longer wedges the whole session.
 *
 * Two carve-outs in block-dangerous.sh's sticky-latch branch:
 *   A1  a read-only command (classifier 'allow') runs even while latched,
 *       and the latch sentinel is NOT cleared by it.
 *   A2  a mutating command (classifier 'ask'/'deny') stays blocked while latched.
 *   A3  the reset-danger-latch.sh escape hatch is not blocked by its own latch.
 *   A4  classifier-unavailable → fail closed (no read-only bypass).
 *
 * Strategy mirrors danger_latch_ux.test.js: copy the shipped scripts + lib
 * into an isolated mktemp dir and run block-dangerous.sh as a real subprocess.
 * The OS tempdir is used so the harness never shells rm -rf on a named path.
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

function makeProject({ withClassifier = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-latch-ro-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'logs'), { recursive: true });
  const scripts = ['block-dangerous.sh', 'reset-danger-latch.sh'];
  if (withClassifier) scripts.push('classify_command.py');
  for (const f of scripts) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(
      path.join(PACK, 'lib', f),
      path.join(dir, '.claude', 'hooks', 'lib', f)
    );
  }
  return dir;
}

function block(dir, command, sessionId) {
  return spawnSync(
    'bash',
    [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')],
    {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command },
        session_id: sessionId,
      }),
      encoding: 'utf8',
      timeout: 8000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    }
  );
}

function latchFiles(dir) {
  const stateDir = path.join(dir, '.claude', 'hooks', 'state');
  if (!fs.existsSync(stateDir)) return [];
  return fs
    .readdirSync(stateDir)
    .filter((f) => f.startsWith('danger-latch-') && f.endsWith('.json'));
}

/** A hook decision is "block" iff the emitted JSON carries a block/deny
 *  permission decision. A passed-through command emits nothing (empty stdout)
 *  and exits 0. */
function isBlocked(result) {
  if (!result.stdout || result.stdout.trim() === '') return false;
  try {
    const j = JSON.parse(result.stdout);
    const d =
      j?.hookSpecificOutput?.permissionDecision ?? j?.decision ?? j?.permission;
    return d === 'deny' || d === 'block' || d === 'ask';
  } catch {
    return false;
  }
}

/**
 * Arm the sticky latch in ONE call. DANGER-LATCH-APPROVAL-AND-FEEDBACK-001
 * made the FIRST flagged `ask` warn-only, so a single `rm -rf` no longer
 * latches. A `deny`-class command (mkfs) latches IMMEDIATELY on the first
 * occurrence (no warn grace), which is the right way to put a project into
 * the latched state for the carve-out tests below.
 */
function armLatch(dir, sessionId) {
  return block(dir, 'mkfs.ext4 /dev/sda', sessionId);
}

describe('CAWS-LATCH-READONLY-AND-WORKTREE-GITIGNORE-001 — latch carve-outs', () => {
  const SID = 'aa11bb22-cc33-dd44-ee55-ff6677889900';

  // ── A1: read-only Bash survives a sticky latch ─────────────────────
  it('A1: a read-only command runs while latched, and does not clear the latch', () => {
    const dir = makeProject();
    armLatch(dir, SID); // engage the latch (deny → immediate)
    expect(latchFiles(dir)).toHaveLength(1);

    const r = block(dir, 'git log --oneline -3', SID); // read-only
    expect(isBlocked(r)).toBe(false); // permitted
    // Latch is sticky for mutating commands — not cleared by the read-only one.
    expect(latchFiles(dir)).toHaveLength(1);
  });

  // ── A2: mutating Bash stays blocked while latched ──────────────────
  it('A2: a mutating command remains blocked while latched', () => {
    const dir = makeProject();
    armLatch(dir, SID); // latch armed (deny → immediate)
    const r = block(dir, 'rm -rf /another/real/path', SID);
    expect(isBlocked(r)).toBe(true);
  });

  // ── A3: the reset escape hatch is not blocked by its own latch ─────
  it('A3: a reset-danger-latch.sh invocation is not blocked while latched', () => {
    const dir = makeProject();
    armLatch(dir, SID);
    const r = block(
      dir,
      `bash .claude/hooks/reset-danger-latch.sh --session ${SID} --reason "safe"`,
      SID
    );
    expect(isBlocked(r)).toBe(false); // the documented escape reaches the shell
  });

  it('A3: a mutating command that merely NAMES the script as an operand is NOT exempted', () => {
    const dir = makeProject();
    armLatch(dir, SID);
    // `rm -rf /etc/reset-danger-latch.sh` deletes a file named like the script
    // — it is NOT an invocation of the escape hatch. The reset-exemption matcher
    // requires invocation position (first token, or after bash/sh/.), so this
    // mutating /etc delete (classifier rates `ask`) stays blocked by the latch.
    const r = block(dir, 'rm -rf /etc/reset-danger-latch.sh', SID);
    expect(isBlocked(r)).toBe(true); // operand mention → not exempted → still blocked
  });

  it('A3: a trailing-comment mention does not exempt a mutating command', () => {
    const dir = makeProject();
    armLatch(dir, SID);
    // The string in a comment must not smuggle a mutating command past the latch.
    const r = block(dir, 'rm -rf /etc/foo # reset-danger-latch.sh', SID);
    expect(isBlocked(r)).toBe(true);
  });

  // ── A4: classifier unavailable → fail closed ───────────────────────
  it('A4: with no classifier, a read-only command does NOT bypass the latch', () => {
    const dir = makeProject({ withClassifier: false });
    block(dir, 'rm -rf /some/real/path', SID);
    const r = block(dir, 'git log --oneline -3', SID);
    // Fail-closed: without the classifier we cannot prove read-only, so the
    // latch still blocks (conservative pre-existing behavior).
    expect(isBlocked(r)).toBe(true);
  });
});
