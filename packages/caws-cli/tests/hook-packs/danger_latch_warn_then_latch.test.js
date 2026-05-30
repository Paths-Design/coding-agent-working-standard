/**
 * @fileoverview DANGER-LATCH-APPROVAL-AND-FEEDBACK-001 — warn-then-latch.
 *
 * The FIRST flagged `ask`-class command in a session WARNS (writes a per-
 * session warn marker, NOT the sticky latch) and emits explicit stop-now
 * guidance. The SECOND flagged ask (warn marker present) arms the sticky
 * latch. A `deny`-class command latches IMMEDIATELY (no warn grace). The
 * reset clears BOTH the latch and the warn marker. Every flag-time message
 * tells the agent to STOP, names the latch state, and says only the user
 * can reset.
 *
 * Strategy: copy the shipped scripts + lib into an isolated mktemp project,
 * drive block-dangerous.sh + reset-danger-latch.sh as real subprocesses,
 * assert on-disk sentinels (danger-latch-*.json / danger-warn-*.json) and
 * the emitted reason strings. The OS tempdir is used so the harness never
 * shells a destructive command on a named path.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-warn-latch-'));
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

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Drive block-dangerous.sh as a real subprocess; return {stdout,...}. */
function block(dir, command, sessionId) {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

function reset(dir, args) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete env.CLAUDE_SESSION_ID;
  delete env.HOOK_SESSION_ID;
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'reset-danger-latch.sh'), ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env,
  });
}

/**
 * Extract the human-facing reason from a block-dangerous.sh stdout envelope.
 * The pack emits {hookSpecificOutput:{permissionDecisionReason}}; older/raw
 * shapes used a flat {reason}. Tolerate both.
 */
function reasonOf(r) {
  let out;
  try { out = JSON.parse(r.stdout); } catch { return ''; }
  return (
    (out.hookSpecificOutput && out.hookSpecificOutput.permissionDecisionReason) ||
    out.reason ||
    ''
  );
}

const stateDir = (dir) => path.join(dir, '.claude', 'hooks', 'state');
const latchPath = (dir, sid) => path.join(stateDir(dir), `danger-latch-${sid}.json`);
const warnPath = (dir, sid) => path.join(stateDir(dir), `danger-warn-${sid}.json`);

// An `ask`-class command (git rebase). A `deny`-class command (mkfs).
// These are CLASSIFIER INPUTS only — block-dangerous.sh returns its decision
// without ever executing them.
const ASK_CMD = 'git rebase main';
const ASK_CMD_2 = 'git cherry-pick deadbeef';
const DENY_CMD = 'mkfs.ext4 /dev/sdb';

describe('DANGER-LATCH-APPROVAL-AND-FEEDBACK-001: warn-then-latch', () => {
  const SID = 'aaaa1111-bbbb-2222-cccc-333344445555';
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = undefined; });

  // --- A1: first ask warns, does NOT latch -------------------------------
  it('A1: first flagged ask writes a warn marker, NOT the sticky latch', () => {
    dir = makeProject();
    const r = block(dir, ASK_CMD, SID);

    // Warn marker present; latch ABSENT.
    expect(fs.existsSync(warnPath(dir, SID))).toBe(true);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);

    // Decision is still `ask` (Claude Code pauses for approval) ...
    const reason = reasonOf(r);
    // ... and the message says a latch is NOT yet armed but WILL arm next.
    expect(reason).toMatch(/latch is NOT yet armed|ONE warning|NEXT flagged command WILL arm/i);
  });

  it('A1: a read-only command after a first-strike warn is NOT blocked (no latch)', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID); // first strike → warn only
    const r = block(dir, 'git status', SID); // read-only
    // git status classifies `allow` → exit 0, no block envelope.
    expect(r.status).toBe(0);
    // Still no latch on disk.
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
  });

  // --- A2: second ask latches --------------------------------------------
  it('A2: second flagged ask (warn marker present) arms the sticky latch', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);       // strike 1 → warn
    const r = block(dir, ASK_CMD_2, SID); // strike 2 → latch

    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    const reason = reasonOf(r);
    expect(reason).toMatch(/latch is NOW ARMED|SECOND flagged command/i);
  });

  it('A2: after the latch arms, a subsequent mutating command is blocked', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);
    block(dir, ASK_CMD_2, SID); // latch now armed
    const r = block(dir, 'git push --force origin main', SID);
    const reason = reasonOf(r);
    // The sticky-latch branch fires; message names the latch + the reset.
    expect(reason).toMatch(/latch/i);
    expect(reason).toContain(`--session ${SID}`);
  });

  // --- A3: deny latches immediately --------------------------------------
  it('A3: a deny-class command latches on the FIRST occurrence (no warn grace)', () => {
    dir = makeProject();
    const r = block(dir, DENY_CMD, SID);

    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    const reason = reasonOf(r);
    expect(reason).toMatch(/HARD BLOCK|latch is NOW ARMED/i);
  });

  it('A3: deny does NOT first write a warn marker (no grace)', () => {
    dir = makeProject();
    block(dir, DENY_CMD, SID);
    // The latch exists; a warn marker for this session must not be the gate.
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
  });

  // --- A4: stop-now feedback at flag time --------------------------------
  it('A4: warn message tells the agent to STOP and that only the user can reset', () => {
    dir = makeProject();
    const r = block(dir, ASK_CMD, SID);
    const reason = reasonOf(r);
    expect(reason).toMatch(/STOP/);
    expect(reason).toMatch(/reset/i);
  });

  it('A4: second-strike latch message tells the agent to STOP and names the reset command', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);
    const r = block(dir, ASK_CMD_2, SID);
    const reason = reasonOf(r);
    expect(reason).toMatch(/STOP/);
    expect(reason).toContain('reset-danger-latch.sh');
    expect(reason).toContain(`--session ${SID}`);
  });

  it('A4: deny message tells the agent to STOP and names the reset command', () => {
    dir = makeProject();
    const r = block(dir, DENY_CMD, SID);
    const reason = reasonOf(r);
    expect(reason).toMatch(/STOP/);
    expect(reason).toContain('reset-danger-latch.sh');
  });

  // --- A6: reset clears BOTH sentinels -----------------------------------
  it('A6: reset --session clears both the latch and the warn marker', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);       // warn
    block(dir, ASK_CMD_2, SID);     // latch
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    expect(fs.existsSync(warnPath(dir, SID))).toBe(true);

    const r = reset(dir, ['--session', SID, '--reason', 'test']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
    expect(fs.existsSync(warnPath(dir, SID))).toBe(false);
  });

  it('A6: reset clears a warn marker even when no latch exists (grace resets)', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID); // first strike → warn only, no latch
    expect(fs.existsSync(warnPath(dir, SID))).toBe(true);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);

    const r = reset(dir, ['--session', SID, '--reason', 'reset grace']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(warnPath(dir, SID))).toBe(false);
    // After the reset, the NEXT ask warns again (grace was reset).
    block(dir, ASK_CMD, SID);
    expect(fs.existsSync(warnPath(dir, SID))).toBe(true);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
  });

  it('A6: reset --all sweeps every warn marker too', () => {
    dir = makeProject();
    block(dir, ASK_CMD, 'sess-one');
    block(dir, ASK_CMD, 'sess-two');
    expect(fs.existsSync(warnPath(dir, 'sess-one'))).toBe(true);
    expect(fs.existsSync(warnPath(dir, 'sess-two'))).toBe(true);

    reset(dir, ['--all', '--reason', 'sweep']);
    expect(fs.existsSync(warnPath(dir, 'sess-one'))).toBe(false);
    expect(fs.existsSync(warnPath(dir, 'sess-two'))).toBe(false);
  });

  // --- warn + latch resolve to the SAME session by construction ----------
  it('warn marker and latch use the same sanitize_session transform (same suffix)', () => {
    dir = makeProject();
    // A session id with a char that sanitize_session rewrites (slash).
    const messy = 'sess/with:weird*chars';
    block(dir, ASK_CMD, messy);  // warn
    block(dir, ASK_CMD_2, messy); // latch
    const files = fs.readdirSync(stateDir(dir));
    const warn = files.find((f) => f.startsWith('danger-warn-'));
    const latch = files.find((f) => f.startsWith('danger-latch-'));
    expect(warn).toBeDefined();
    expect(latch).toBeDefined();
    // Same suffix → warn and latch agree on the session by construction.
    expect(warn.replace('danger-warn-', '')).toBe(latch.replace('danger-latch-', ''));
  });
});
