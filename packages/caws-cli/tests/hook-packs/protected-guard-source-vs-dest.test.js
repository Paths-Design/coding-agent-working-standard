/**
 * DANGER-LATCH-TRIGGER-DISCRIMINATION-001 — the protected-guard self-mod
 * pre-check in block-dangerous.sh must latch on protected-guard DESTINATION
 * mutation, NOT on the guard appearing only as a read/copy SOURCE.
 *
 * Exhibit B (the run-002 false positive): copying the protected guard OUT to an
 * isolated fixture latched because the source path is protected, regardless of
 * the destination. That armed the sticky latch on benign diagnostic setup.
 *
 * These drive block-dangerous.sh as a real subprocess and assert on the on-disk
 * danger-latch sentinel — the same harness shape as danger_latch_warn_then_latch.
 * The commands are CLASSIFIER INPUTS ONLY; block-dangerous.sh returns its
 * decision without ever executing them.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const PACK = path.join(REPO_ROOT, 'packages', 'caws-cli', 'templates', 'hook-packs', 'claude-code');
const GUARD_REL = '.claude/hooks/worktree-write-guard.sh';

function makeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-latch-discrim-'));
  fs.mkdirSync(path.join(dir, '.claude', 'hooks', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.claude', 'logs'), { recursive: true });
  for (const f of ['block-dangerous.sh', 'reset-danger-latch.sh', 'classify_command.py']) {
    fs.copyFileSync(path.join(PACK, f), path.join(dir, '.claude', 'hooks', f));
  }
  for (const f of ['caws-state.sh', 'emit.sh']) {
    fs.copyFileSync(path.join(PACK, 'lib', f), path.join(dir, '.claude', 'hooks', 'lib', f));
  }
  // Materialize the protected guard so the path is real in the fixture.
  fs.copyFileSync(
    path.join(PACK, 'worktree-write-guard.sh'),
    path.join(dir, '.claude', 'hooks', 'worktree-write-guard.sh')
  );
  return dir;
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function block(dir, command, sessionId) {
  return spawnSync('bash', [path.join(dir, '.claude', 'hooks', 'block-dangerous.sh')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, session_id: sessionId }),
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
}

const stateDir = (dir) => path.join(dir, '.claude', 'hooks', 'state');
const latchPath = (dir, sid) => path.join(stateDir(dir), `danger-latch-${sid}.json`);

function latchReason(dir, sid) {
  const p = latchPath(dir, sid);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return { _unparsed: true }; }
}

describe('DANGER-LATCH-TRIGGER-DISCRIMINATION-001: guard source vs destination', () => {
  const SID = 'dddd9999-eeee-8888-ffff-777766665555';
  let dir;
  afterEach(() => { if (dir) cleanup(dir); dir = undefined; });

  // --- A2: guard as COPY SOURCE to an isolated destination → NO latch -------
  it('A2: cp <guard> <tempdir-fixture> does NOT arm the latch (guard is a source)', () => {
    dir = makeProject();
    const r = block(dir, `cp ${GUARD_REL} /tmp/fixture-copy.sh`, SID);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
    // Not silent-allow: it asks (guard referenced but not as destination).
    expect(r.stderr + r.stdout).toMatch(/does not appear to write INTO it|copy source|did NOT arm/i);
  });

  it('A2: node -e copyFileSync(<guard>, dest) does NOT arm the latch (interpreter / opaque source)', () => {
    dir = makeProject();
    // The Exhibit-B shape: an interpreter command that names the guard as a copy source.
    const cmd = `node -e "require('fs').copyFileSync('${GUARD_REL}','/tmp/g.sh')"`;
    const r = block(dir, cmd, SID);
    expect(fs.existsSync(latchPath(dir, SID))).toBe(false);
    expect(r.stderr + r.stdout).toMatch(/does not appear to write INTO it|interpreter|did NOT arm/i);
  });

  // --- A3: guard as DESTINATION of a mutation → LATCH + cites predicate ------
  it('A3a: redirect INTO the guard arms the latch and cites the destination predicate', () => {
    dir = makeProject();
    const r = block(dir, `echo pwned > ${GUARD_REL}`, SID);
    expect(r.status).toBe(0); // block envelope is emitted on stdout, exit 0
    const latch = latchReason(dir, SID);
    expect(latch).not.toBeNull();
    expect(JSON.stringify(latch)).toMatch(/redirect into protected guard \(destination\)/);
  });

  it('A3b: sed -i on the guard arms the latch (in-place sed/perl)', () => {
    // HOOK-CAPABILITY-ENGINE-003 split sed/perl into their own in-place arm
    // (latch only with -i/-pi/--in-place) so read-only `sed -n` no longer
    // latches; the reason label became "in-place sed/perl".
    dir = makeProject();
    const r = block(dir, `sed -i 's/x/y/' ${GUARD_REL}`, SID);
    expect(r.status).toBe(0);
    const latch = latchReason(dir, SID);
    expect(latch).not.toBeNull();
    expect(JSON.stringify(latch)).toMatch(/in-place sed\/perl/);
  });

  it('A3d: sed -n print of the guard (READ) does NOT latch', () => {
    dir = makeProject();
    const r = block(dir, `sed -n 1,5p ${GUARD_REL}`, SID);
    expect(r.status).toBe(0);
    expect(latchReason(dir, SID)).toBeNull();
  });

  it('A3c: cp <src> <guard> (guard is DESTINATION) arms the latch', () => {
    dir = makeProject();
    const r = block(dir, `cp /tmp/evil.sh ${GUARD_REL}`, SID);
    expect(r.status).toBe(0);
    const latch = latchReason(dir, SID);
    expect(latch).not.toBeNull();
    expect(JSON.stringify(latch)).toMatch(/copy\/move destination/);
  });

  // --- A4: pipe-to-shell remains catastrophic-deny + latch (true positive) --
  it('A4: pipe-to-shell still arms the latch (true positive, unchanged)', () => {
    dir = makeProject();
    // A benign-looking echo piped into a shell interpreter is still pipe-to-shell.
    block(dir, 'echo echo hi | bash', SID);
    // The catastrophic-deny / classifier path arms the latch.
    expect(fs.existsSync(latchPath(dir, SID))).toBe(true);
  });
});
