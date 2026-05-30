/**
 * @fileoverview DANGER-LATCH-UX-001 — reset-danger-latch session-id mismatch
 * + single-latch fallback, and the writer/clearer filename agreement.
 *
 * The danger latch is WRITTEN by block-dangerous.sh keyed to the stdin
 * session id, but CLEARED by reset-danger-latch.sh which a HUMAN runs from a
 * shell with no Claude session id in its env. Before this fix, `--current`
 * resolved SESSION_ID to "unknown", computed danger-latch-unknown.json, found
 * nothing, and printed "nothing to clear" while the real sentinel (keyed to
 * the stdin id) kept blocking — a deadlock only `--all` could break.
 *
 * Fix: (1) sanitize_session is shared via lib/caws-state.sh so writer/clearer
 * filenames always agree; (2) `--current` falls back to the SOLE existing
 * latch when its resolved candidate is absent (with 2+ it refuses and points
 * at --session/--all); (3) block-dangerous's replay message recommends
 * `--session <id>` over `--current`.
 *
 * Strategy: copy the shipped scripts + lib into an isolated mktemp dir, run
 * block-dangerous.sh (writer) and reset-danger-latch.sh (clearer) as real
 * subprocesses, assert sentinel filenames + clear behavior. The OS tempdir is
 * used so the harness never shells `rm -rf` on a named path (which would trip
 * the latch on the maintainer's own session).
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

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-latch-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'logs'), { recursive: true });
  for (const f of ['block-dangerous.sh', 'reset-danger-latch.sh', 'classify_command.py']) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  return dir;
}

function block(dir, command, sessionId) {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

function reset(dir, args, { stripSession = true } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  if (stripSession) {
    // Mirror a human shell: no Claude session id present.
    delete env.CLAUDE_SESSION_ID;
    delete env.HOOK_SESSION_ID;
  }
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'reset-danger-latch.sh'), ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env,
  });
}

function latchFiles(dir) {
  const stateDir = path.join(dir, '.claude', 'hooks', 'state');
  if (!fs.existsSync(stateDir)) return [];
  return fs.readdirSync(stateDir).filter((f) => f.startsWith('danger-latch-') && f.endsWith('.json'));
}

describe('DANGER-LATCH-UX-001', () => {
  const SID = 'f2c023e5-c7f2-4cc3-8060-b000390c40c5';

  // DANGER-LATCH-APPROVAL-AND-FEEDBACK-001: the FIRST flagged `ask` now only
  // WARNS (warn-then-latch). These UX-001 tests assert the latch FILENAME +
  // RESET mechanics, not WHEN the latch arms — so they arm the latch directly
  // with a `deny`-class command (mkfs), which latches IMMEDIATELY on the
  // first occurrence (no warn grace). This keeps each test's intent intact
  // under the new escalation model. (`rm -rf /...` classifies `ask` and would
  // now only warn on a single call.)
  const DENY = (p) => `mkfs.ext4 /dev/${p}`;

  it('writer keys the sentinel to the stdin session id', () => {
    const dir = makeProject();
    block(dir, DENY('sda'), SID);
    expect(latchFiles(dir)).toEqual([`danger-latch-${SID}.json`]);
  });

  it('replay message recommends --session <id>, not --current', () => {
    const dir = makeProject();
    block(dir, DENY('sda'), SID); // deny → latch armed immediately
    // The second probe MUST be a mutating command. Read-only commands pass
    // through a sticky latch (CAWS-LATCH-READONLY-AND-WORKTREE-GITIGNORE-001),
    // so they don't surface the replay message; a non-scratch `rm` classifies
    // `ask` and hits the sticky-latch branch.
    const r = block(dir, 'rm -rf /some/other/real/path', SID);
    // The sticky-latch replay branch emits emit_block's flat shape
    // ({decision,reason}), NOT the nested permissionDecision envelope.
    const reason = JSON.parse(r.stdout).reason;
    expect(reason).toContain(`--session ${SID}`);
    expect(reason).toContain('not --current');
  });

  it('--current from a session-less shell clears the SOLE latch (the deadlock fix)', () => {
    const dir = makeProject();
    block(dir, DENY('sda'), SID);
    expect(latchFiles(dir)).toHaveLength(1);
    const r = reset(dir, ['--current', '--reason', 'sole-latch fallback']);
    expect(r.stdout + r.stderr).toMatch(/exactly one latch exists/);
    expect(latchFiles(dir)).toHaveLength(0); // cleared
  });

  it('--current REFUSES when 2+ latches exist (points at --session/--all)', () => {
    const dir = makeProject();
    block(dir, DENY('sda'), 'sessA-1111');
    block(dir, DENY('sdb'), 'sessB-2222');
    expect(latchFiles(dir)).toHaveLength(2);
    const r = reset(dir, ['--current', '--reason', 'ambiguous']);
    expect(r.stdout + r.stderr).toMatch(/cannot|--session|--all/i);
    expect(latchFiles(dir)).toHaveLength(2); // neither cleared — no ambiguous destruction
  });

  it('--session targets one precisely; --all clears the rest', () => {
    const dir = makeProject();
    block(dir, DENY('sda'), 'sessA-1111');
    block(dir, DENY('sdb'), 'sessB-2222');
    reset(dir, ['--session', 'sessA-1111', '--reason', 'precise']);
    expect(latchFiles(dir)).toEqual(['danger-latch-sessB-2222.json']);
    reset(dir, ['--all', '--reason', 'clear rest']);
    expect(latchFiles(dir)).toHaveLength(0);
  });

  it('writer and clearer agree on the sanitized filename for a tricky session id', () => {
    const dir = makeProject();
    const tricky = 'sess/with:weird*chars';
    block(dir, DENY('sda'), tricky);
    const files = latchFiles(dir);
    expect(files).toHaveLength(1);
    // --session with the SAME raw id must resolve to the SAME file and clear it.
    reset(dir, ['--session', tricky, '--reason', 'sanitize agreement']);
    expect(latchFiles(dir)).toHaveLength(0);
  });
});
