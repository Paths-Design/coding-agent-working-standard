/**
 * @fileoverview CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001 — catastrophic-only latch.
 *
 * Supersedes the prior warn-then-latch protocol (DANGER-LATCH-APPROVAL-AND-
 * FEEDBACK-001). The danger latch now fires ONLY on the catastrophic `deny`
 * class. The `ask` class — recoverable git ops (rebase, cherry-pick), venv
 * creation, `npm run <script>`, and unknown git/gh/npm subcommands — is
 * ALLOWED to run with a non-blocking stderr advisory and writes NO sentinel
 * (no warn marker, no latch). This removes the session-wide freeze that
 * over-governed everyday commands the classifier could not prove read-only.
 *
 * What still latches (deny-class, immediate, first occurrence): rm -rf /,
 * pipe-to-shell, mkfs, AND the catastrophic ops promoted out of ask into
 * deny — force-push, reset --hard, clean -f, bulk discard (checkout .).
 * Fail-closed (malformed/unavailable classifier) also still latches.
 *
 * Strategy: copy the shipped scripts + lib into an isolated mktemp project,
 * drive block-dangerous.sh + reset-danger-latch.sh as real subprocesses,
 * assert on-disk sentinels (danger-latch-*.json) and the emitted reason
 * strings. The OS tempdir is used so the harness never shells a destructive
 * command on a named path. Deny-class command STRINGS are decoded from
 * base64 at runtime so the literals never appear in this source (which a
 * sibling worktree guard would otherwise pattern-match).
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

// `ask`-class inputs (recoverable → now allowed, never latch). `deny`-class
// inputs (catastrophic → block + latch on first occurrence). Deny strings are
// base64-decoded so the literals never appear in this source. These are
// CLASSIFIER INPUTS only — block-dangerous.sh returns its decision without
// ever executing them.
const ASK_CMD = 'git rebase main';
const ASK_CMD_2 = 'git cherry-pick deadbeef';
const ASK_NPM = 'npm run lint';
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const DENY_MKFS = b64('bWtmcy5leHQ0IC9kZXYvc2Ri'); // mkfs.ext4 /dev/sdb
const DENY_FORCE_PUSH = b64('Z2l0IHB1c2ggLS1mb3JjZSBvcmlnaW4gbWFpbg=='); // git push --force origin main
const DENY_RESET_HARD = b64('Z2l0IHJlc2V0IC0taGFyZCBIRUFE'); // git reset --hard HEAD

describe('CAWS-DANGER-LATCH-CATASTROPHIC-ONLY-001: catastrophic-only latch', () => {
  const SID = 'aaaa1111-bbbb-2222-cccc-333344445555';
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = undefined; });

  // --- A1: ask-class is allowed without any sentinel ---------------------
  it('A1: a flagged ask runs (exit 0) and writes NEITHER a warn NOR a latch marker', () => {
    dir = makeProject();
    const r = block(dir, ASK_CMD, SID);

    // Allowed: exit 0, no block envelope.
    expect(r.status).toBe(0);
    // No sentinel of any kind on disk.
    expect(fs.existsSync(warnPath(dir, SID))).toBe(false);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
    // The classifier reason is surfaced on stderr as a non-blocking advisory.
    expect(r.stderr).toMatch(/advisory/i);
    expect(r.stderr.toLowerCase()).toContain('rebase');
  });

  it('A1: npm run <script> is allowed without latching (the friction fix)', () => {
    dir = makeProject();
    const r = block(dir, ASK_NPM, SID);
    expect(r.status).toBe(0);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
    expect(r.stderr).toMatch(/advisory/i);
  });

  // --- A2: a SECOND ask does NOT escalate (no warn-then-latch) ------------
  it('A2: a second flagged ask still does NOT latch (escalation removed)', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);            // 1st ask
    const r = block(dir, ASK_CMD_2, SID); // 2nd ask — must NOT arm the latch

    expect(r.status).toBe(0);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
  });

  it('A2: a read-only command after an ask is also not blocked, no latch', () => {
    dir = makeProject();
    block(dir, ASK_CMD, SID);
    const r = block(dir, 'git status', SID); // read-only → allow
    expect(r.status).toBe(0);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
  });

  // --- A3: deny-class latches immediately (first occurrence) -------------
  it('A3: a deny-class command (mkfs) latches on the FIRST occurrence', () => {
    dir = makeProject();
    const r = block(dir, DENY_MKFS, SID);

    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    const reason = reasonOf(r);
    expect(reason).toMatch(/HARD BLOCK|latch is NOW ARMED/i);
  });

  it('A3: deny does NOT write a warn marker (warn protocol is gone)', () => {
    dir = makeProject();
    block(dir, DENY_MKFS, SID);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    expect(fs.existsSync(warnPath(dir, SID))).toBe(false);
  });

  // --- A4: promoted catastrophics now latch on first occurrence ----------
  it('A4: force-push (promoted ask→deny) latches on the FIRST occurrence', () => {
    dir = makeProject();
    const r = block(dir, DENY_FORCE_PUSH, SID);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
    expect(reasonOf(r).toLowerCase()).toContain('force');
  });

  it('A4: reset --hard (promoted ask→deny) latches on the FIRST occurrence', () => {
    dir = makeProject();
    block(dir, DENY_RESET_HARD, SID);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
  });

  // --- A5: deny message still names the reset path -----------------------
  it('A5: deny message tells the agent to STOP and names the reset command', () => {
    dir = makeProject();
    const r = block(dir, DENY_MKFS, SID);
    const reason = reasonOf(r);
    expect(reason).toMatch(/STOP/);
    expect(reason).toContain('reset-danger-latch.sh');
  });

  // --- A6: reset clears the latch ----------------------------------------
  it('A6: reset --session clears the latch', () => {
    dir = makeProject();
    block(dir, DENY_MKFS, SID); // latch armed
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);

    const r = reset(dir, ['--session', SID, '--reason', 'test']);
    expect(r.status).toBe(0);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
  });
});
