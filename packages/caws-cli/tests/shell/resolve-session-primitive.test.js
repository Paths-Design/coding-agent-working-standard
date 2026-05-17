/**
 * Primitive 5c.4a regression test for resolveSession.
 *
 * Locks: read-only callers (allowMint default false) get Err when no
 * stable identity exists; write-class callers (allowMint: true) mint a
 * capsule and Ok. agents.json last-active is NEVER consulted.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveSession, SHELL_RULES } = require('../../dist/shell');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-session-'));
}

describe('resolveSession — mint discipline', () => {
  let cawsDir;
  let worktreeRoot;
  afterEach(() => {
    if (cawsDir) fs.rmSync(cawsDir, { recursive: true, force: true });
    if (worktreeRoot) fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('read-only default (no allowMint): no env, no capsule → Err SESSION_NO_STABLE_IDENTITY', () => {
    cawsDir = mkTempCawsDir();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    const r = resolveSession({
      env: {}, // no CLAUDE_SESSION_ID, no CURSOR_TRACE_ID
      cawsDir,
      worktreeRoot,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(SHELL_RULES.SESSION_NO_STABLE_IDENTITY);
    // Confirm the read-only call did NOT write a sessions/ directory.
    expect(fs.existsSync(path.join(cawsDir, 'sessions'))).toBe(false);
  });

  it('allowMint=true with no env, no capsule → mints and writes capsule', () => {
    cawsDir = mkTempCawsDir();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    const r = resolveSession({
      env: {},
      cawsDir,
      worktreeRoot,
      allowMint: true,
      mintIdSuffix: () => 'deadbeefcafe',
      platform: 'test-platform',
      now: () => new Date('2026-05-12T12:00:00.000Z'),
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('minted');
    expect(r.value.identity.session_id).toBe('caws-deadbeefcafe');
    expect(r.value.identity.platform).toBe('test-platform');
    const capsulePath = path.join(
      cawsDir,
      'sessions',
      'caws-deadbeefcafe.json'
    );
    expect(fs.existsSync(capsulePath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
    expect(onDisk.session_id).toBe('caws-deadbeefcafe');
    expect(onDisk.platform).toBe('test-platform');
    expect(onDisk.minted_at).toBe('2026-05-12T12:00:00.000Z');
    expect(onDisk.worktree_root).toBe(worktreeRoot);
  });

  it('CLAUDE_SESSION_ID env trumps capsule and trumps mint', () => {
    cawsDir = mkTempCawsDir();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    const r = resolveSession({
      env: { CLAUDE_SESSION_ID: 'sess-from-env' },
      cawsDir,
      worktreeRoot,
      allowMint: true, // mint allowed, but env should win
      mintIdSuffix: () => 'should-not-mint',
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('claude_env');
    expect(r.value.identity.session_id).toBe('sess-from-env');
    expect(r.value.identity.platform).toBe('claude-code');
    // No capsule was written even though allowMint=true.
    expect(fs.existsSync(path.join(cawsDir, 'sessions'))).toBe(false);
  });

  it('CURSOR_TRACE_ID is consulted only AFTER capsule lookup', () => {
    cawsDir = mkTempCawsDir();
    worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-wt-'));
    // Pre-write a capsule for this worktree.
    const sessionsDir = path.join(cawsDir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, 'caws-from-capsule.json'),
      JSON.stringify({
        session_id: 'caws-from-capsule',
        platform: 'cap-platform',
        minted_at: '2026-05-01T00:00:00.000Z',
        worktree_root: worktreeRoot,
      })
    );
    const r = resolveSession({
      env: { CURSOR_TRACE_ID: 'cursor-id' }, // should be ignored, capsule wins
      cawsDir,
      worktreeRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('capsule');
    expect(r.value.identity.session_id).toBe('caws-from-capsule');
  });
});
