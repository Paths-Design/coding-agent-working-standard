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

// CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001: CLAUDE_CODE_SESSION_ID is the
// harness UUID Claude Code exports into every tool subprocess (including
// agent-Bash, where HOOK_SESSION_ID does NOT propagate). Adding it as
// authority tier 1.5 resolves the agent-Bash write path deterministically
// to the true caller instead of falling through to the racy
// tmp/.caller-session.json pointer that misattributed worktree ownership.
describe('resolveSession — CLAUDE_CODE_SESSION_ID (tier 1.5)', () => {
  let cawsDir;
  let worktreeRoot;
  let repoRoot;
  afterEach(() => {
    for (const d of [cawsDir, worktreeRoot, repoRoot]) {
      if (d) fs.rmSync(d, { recursive: true, force: true });
    }
    cawsDir = worktreeRoot = repoRoot = undefined;
  });

  function setup() {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ccsid-repo-'));
    cawsDir = path.join(repoRoot, '.caws');
    fs.mkdirSync(cawsDir, { recursive: true });
    worktreeRoot = repoRoot;
  }

  // Write a fresh durable envelope at <repoRoot>/tmp/<id>/.session-envelope.json
  function writeEnvelope(id, nowIso) {
    const dir = path.join(repoRoot, 'tmp', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.session-envelope.json'),
      JSON.stringify({
        session_id: id,
        repo_root: repoRoot,
        created_at: nowIso,
        last_seen_at: nowIso,
        hook_event: 'PreToolUse',
      }) + '\n'
    );
  }

  it('CLAUDE_CODE_SESSION_ID resolves identity when set', () => {
    setup();
    const r = resolveSession({
      env: { CLAUDE_CODE_SESSION_ID: 'cc-sid-7afd0e73' },
      cawsDir,
      worktreeRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('claude_code_env');
    expect(r.value.identity.session_id).toBe('cc-sid-7afd0e73');
    expect(r.value.identity.platform).toBe('claude-code');
  });

  it('operator override (CLAUDE_SESSION_ID) still wins over CLAUDE_CODE_SESSION_ID', () => {
    setup();
    const r = resolveSession({
      env: {
        CLAUDE_SESSION_ID: 'operator-pin',
        CLAUDE_CODE_SESSION_ID: 'cc-harness-id',
      },
      cawsDir,
      worktreeRoot,
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('claude_env');
    expect(r.value.identity.session_id).toBe('operator-pin');
  });

  it('literal "unknown" and empty are refused (falls through)', () => {
    setup();
    const r = resolveSession({
      env: { CLAUDE_CODE_SESSION_ID: 'unknown' },
      cawsDir,
      worktreeRoot,
    });
    // No other source → read-only default returns the no-identity error.
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(SHELL_RULES.SESSION_NO_STABLE_IDENTITY);
  });

  it('REGRESSION: with >=2 fresh durable envelopes (the race condition), CLAUDE_CODE_SESSION_ID resolves the true caller deterministically — not whichever envelope the racy fallback would pick', () => {
    setup();
    const now = new Date('2026-05-29T02:00:00.000Z');
    const nowIso = now.toISOString();
    // Two concurrent sessions' fresh envelopes — pre-fix, this drove the
    // resolver into the .caller-session.json last-writer-wins disambiguator.
    writeEnvelope('14132976-sibling', nowIso);
    writeEnvelope('7afd0e73-me', nowIso);
    const r = resolveSession({
      // HOOK_SESSION_ID intentionally absent (the agent-Bash condition).
      // CLAUDE_CODE_SESSION_ID names the real caller and is now tier 1.5,
      // resolved BEFORE the ambiguous envelope scan.
      env: { CLAUDE_CODE_SESSION_ID: '7afd0e73-me' },
      cawsDir,
      worktreeRoot,
      now: () => now,
    });
    expect(r.ok).toBe(true);
    expect(r.value.source).toBe('claude_code_env');
    expect(r.value.identity.session_id).toBe('7afd0e73-me');
  });
});
