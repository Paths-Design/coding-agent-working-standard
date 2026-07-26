'use strict';

/**
 * CAWS-REPRIEVE-SURFACE-DETECTION-001 — the vendor dir comes from the LEASE of
 * the session being granted for, not from VENDOR_DIRS array order.
 *
 * The old detectVendorDir returned the FIRST array entry with a hooks/state
 * substrate. In a repo with several vendor dirs (sterling has four: .claude,
 * .codex, .zcode, .opencode) .claude always won regardless of who was running,
 * so a codex session's grant landed in .claude while the codex dispatcher read
 * .codex. The command printed success and the reprieve was inert.
 *
 * Env cannot be the authority here: CAWS-REPRIEVE-NO-SELF-GRANT-001 refuses any
 * grant made with an agent-session var set, so on the grant path the running
 * shell is always a human whose env names no harness. The lease is CAWS-owned
 * state naming the dispatcher that will actually consult the record.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
  runReprieveGrantCommand,
  vendorDirFromLease,
  vendorDirFromPlatform,
  vendorDirFromEnv,
  resolveVendorDir,
} = require('../../dist/shell/commands/reprieve');

const SESSION = 'sess-surface';
const NOW = new Date('2026-07-26T02:00:00.000Z');

/** The exact sterling shape that produced the split-brain reprieve. */
const STERLING_DIRS = ['.claude', '.codex', '.zcode', '.opencode'];

/**
 * Build a repo with hooks/state substrates and optionally a lease recording
 * `platform` for a session.
 */
function makeRepoRoot(vendorDirs, lease) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-surface-'));
  execSync(
    'git init -q -b main && git config user.email t@t && git config user.name t && git commit -q --allow-empty -m root',
    { cwd: repoRoot }
  );
  for (const v of vendorDirs) {
    fs.mkdirSync(path.join(repoRoot, v, 'hooks', 'state'), { recursive: true });
  }
  fs.mkdirSync(path.join(repoRoot, '.caws', 'leases'), { recursive: true });
  if (lease) {
    fs.writeFileSync(
      path.join(repoRoot, '.caws', 'leases', `${lease.session_id}.json`),
      JSON.stringify({
        lease_version: 1,
        status: 'active',
        started_at: '2026-07-26T01:00:00.000Z',
        last_active: '2026-07-26T01:59:00.000Z',
        repo_root: repoRoot,
        ...lease,
      })
    );
  }
  return repoRoot;
}

/** A human shell — the only env a legitimate grant ever runs under. */
const HUMAN_ENV = Object.freeze({ PATH: process.env.PATH });

function grant(repoRoot, extra = {}, env = HUMAN_ENV) {
  const out = [];
  const err = [];
  const code = runReprieveGrantCommand({
    cwd: repoRoot,
    now: () => NOW,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    handlers: 'protected-paths.sh',
    reason: 'test',
    approvedBy: '@tester',
    for: '30m',
    session: SESSION,
    env,
    ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function recordExistsIn(repoRoot, vendorDir) {
  return fs.existsSync(
    path.join(repoRoot, vendorDir, 'hooks', 'state', `guard-reprieve-${SESSION}.json`)
  );
}

describe('CAWS-REPRIEVE-SURFACE-DETECTION-001: the lease decides (A1, A2)', () => {
  it('writes a codex-platform session to .codex even though .claude is first in VENDOR_DIRS', () => {
    // THE regression test. Against first-match-wins this lands in .claude and
    // the codex dispatcher never sees it.
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: SESSION,
      platform: 'codex',
    });
    const r = grant(repoRoot);

    expect(r.code).toBe(0);
    expect(recordExistsIn(repoRoot, '.codex')).toBe(true);
    expect(recordExistsIn(repoRoot, '.claude')).toBe(false);
  });

  it.each([
    ['claude-code', '.claude'],
    ['codex', '.codex'],
    ['zcode', '.zcode'],
    ['cursor', '.cursor'],
    ['windsurf', '.windsurf'],
    ['opencode', '.opencode'],
  ])('platform %s maps to %s', (platform, expectedDir) => {
    const repoRoot = makeRepoRoot(STERLING_DIRS, { session_id: SESSION, platform });
    expect(vendorDirFromLease(path.join(repoRoot, '.caws'), SESSION)).toEqual({
      kind: 'found',
      vendorDir: expectedDir,
      platform,
    });
    expect(vendorDirFromPlatform(platform)).toBe(expectedDir);
  });

  it('routes each platform to its own dir from the same four-substrate repo', () => {
    // Same on-disk shape, different lease: proves the lease is what varies the
    // outcome, not anything about the directory layout.
    for (const [platform, dir] of [
      ['zcode', '.zcode'],
      ['opencode', '.opencode'],
    ]) {
      const repoRoot = makeRepoRoot(STERLING_DIRS, { session_id: SESSION, platform });
      const r = grant(repoRoot);
      expect(r.code).toBe(0);
      expect(recordExistsIn(repoRoot, dir)).toBe(true);
      expect(recordExistsIn(repoRoot, '.claude')).toBe(false);
    }
  });
});

describe('CAWS-REPRIEVE-SURFACE-DETECTION-001: no lease means no grant (A5)', () => {
  it('refuses a session with no lease rather than guessing a vendor dir', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS); // no lease written
    const r = grant(repoRoot);

    expect(r.code).toBe(1);
    expect(r.err).toContain('has no lease');
    expect(r.err).toContain('never registered through governed channels');
    // The remedy must be actionable: how to check the id, and how to override.
    expect(r.err).toContain('caws agents list');
    expect(r.err).toContain('--surface');
    for (const v of STERLING_DIRS) {
      expect(recordExistsIn(repoRoot, v)).toBe(false);
    }
  });

  it('refuses when the lease exists but records an unknown platform', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: SESSION,
      platform: 'some-future-harness',
    });
    const r = grant(repoRoot);

    expect(r.code).toBe(1);
    expect(r.err).toContain('some-future-harness');
    expect(r.err).toContain('--surface');
  });

  it('refuses when the lease belongs to a DIFFERENT session', () => {
    // A lease for another session says nothing about this one.
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: 'some-other-session',
      platform: 'codex',
    });
    const r = grant(repoRoot);

    expect(r.code).toBe(1);
    expect(r.err).toContain('has no lease');
    expect(recordExistsIn(repoRoot, '.codex')).toBe(false);
  });

  it('vendorDirFromLease reports unregistered for a missing lease dir', () => {
    const repoRoot = makeRepoRoot([]);
    expect(vendorDirFromLease(path.join(repoRoot, '.caws'), 'nobody')).toEqual({
      kind: 'unregistered',
    });
  });
});

describe('CAWS-REPRIEVE-SURFACE-DETECTION-001: --surface still wins (A4)', () => {
  it('overrides the lease when the operator names a surface', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: SESSION,
      platform: 'codex',
    });
    const r = grant(repoRoot, { surface: 'zcode' });

    expect(r.code).toBe(0);
    expect(recordExistsIn(repoRoot, '.zcode')).toBe(true);
    expect(recordExistsIn(repoRoot, '.codex')).toBe(false);
  });

  it('lets --surface rescue a session that has no lease', () => {
    // The refusal is not a dead end: naming the surface is the stated remedy.
    const repoRoot = makeRepoRoot(STERLING_DIRS);
    const r = grant(repoRoot, { surface: 'codex' });

    expect(r.code).toBe(0);
    expect(recordExistsIn(repoRoot, '.codex')).toBe(true);
  });
});

describe('CAWS-REPRIEVE-SURFACE-DETECTION-001: env corroborates, never decides (A6)', () => {
  it('vendorDirFromEnv still maps harness vars for the read-only paths', () => {
    expect(vendorDirFromEnv({ CODEX_THREAD_ID: 'x' })).toBe('.codex');
    expect(vendorDirFromEnv({ CLAUDE_CODE_SESSION_ID: 'x' })).toBe('.claude');
    // Harness-agnostic vars imply no surface.
    expect(vendorDirFromEnv({ CAWS_SESSION_ID: 'x' })).toBeNull();
    expect(vendorDirFromEnv({ HOOK_SESSION_ID: 'x' })).toBeNull();
  });

  it('resolveVendorDir refuses ambiguity for the read-only paths', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS);
    const resolution = resolveVendorDir(repoRoot, {});
    expect(resolution.ok).toBe(false);
    expect(resolution.candidates).toEqual(STERLING_DIRS);
  });
});

describe('CAWS-REPRIEVE-SURFACE-DETECTION-001: success names the surface (A7)', () => {
  it('states the vendor dir, its provenance, and which dispatcher consults it', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: SESSION,
      platform: 'codex',
    });
    const r = grant(repoRoot);

    expect(r.out).toContain('surface:  .codex');
    expect(r.out).toContain('Only the .codex dispatcher consults this reprieve');
    // Provenance is what lets an operator audit a wrong-dir grant from the
    // success message alone — the sterling case went unnoticed for 7 minutes.
    expect(r.out).toContain('the lease for session');
    expect(r.out).toContain('platform codex');
  });

  it('reports the vendor dir and its source in --json output', () => {
    const repoRoot = makeRepoRoot(STERLING_DIRS, {
      session_id: SESSION,
      platform: 'codex',
    });
    const r = grant(repoRoot, { json: true });
    const payload = JSON.parse(r.out);
    expect(payload.vendor_dir).toBe('.codex');
    expect(payload.vendor_dir_source).toContain('lease');
  });
});
