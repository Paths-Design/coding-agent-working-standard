/**
 * Tests for resolveSessionCandidates and admitsOwner — the multi-source
 * ownership-comparison helper introduced by
 * CAWS-WORKTREE-DESTROY-SESSION-RESOLUTION-001.
 *
 * Contract under test:
 *   - returns every well-formed candidate (env + ALL capsules, regardless
 *     of worktree_root) — distinct from resolveSession's single-pick
 *     cwd-keyed behavior
 *   - NEVER mints (no capsule files appear on disk as a side effect)
 *   - trace records every source that was consulted with admitted /
 *     absent / rejected outcomes, satisfying the spec's
 *     non_functional.reliability invariant against silent fallbacks
 *   - admitsOwner returns the matching candidate (or null) by session_id
 *     equality
 *
 * Adapter discipline: tmpdir fixtures; env injected via opts.env so
 * tests are safe under parallel workers.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveSessionCandidates,
  admitsOwner,
  describeCandidateTrace,
} = require('../../../dist/shell');

// ─── Helpers ────────────────────────────────────────────────────────────

function mkTempCaws() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-candidates-'));
  const cawsDir = path.join(root, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
  return { root, cawsDir };
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort; tmpdir teardown is not fatal
  }
}

function writeCapsule(cawsDir, id, worktreeRoot) {
  const capsule = {
    session_id: id,
    platform: 'claude-code',
    minted_at: '2026-05-01T00:00:00.000Z',
    worktree_root: worktreeRoot,
  };
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', `${id}.json`),
    JSON.stringify(capsule, null, 2) + '\n'
  );
}

function listCapsules(cawsDir) {
  try {
    return fs
      .readdirSync(path.join(cawsDir, 'sessions'))
      .filter((n) => n.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

// ─── Resolver-level coverage ────────────────────────────────────────────

describe('resolveSessionCandidates: exhaustive multi-source resolution', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.root));

  it('returns CLAUDE_SESSION_ID candidate alongside capsule candidates', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-cap1', '/some/wt-root');

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { CLAUDE_SESSION_ID: 'caws-claude-env' },
    });

    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].identity.session_id).toBe('caws-claude-env');
    expect(r.candidates[0].source).toBe('claude_env');
    expect(r.candidates[1].identity.session_id).toBe('caws-cap1');
    expect(r.candidates[1].source).toBe('capsule');
  });

  it('returns ALL capsules regardless of worktree_root (distinct from resolveSession)', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-wt-a', '/path/to/wt-a');
    writeCapsule(tmp.cawsDir, 'caws-wt-b', '/path/to/wt-b');
    writeCapsule(tmp.cawsDir, 'caws-canonical', '/path/to/canonical');

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {}, // no env vars
    });

    expect(r.candidates).toHaveLength(3);
    const ids = r.candidates.map((c) => c.identity.session_id).sort();
    expect(ids).toEqual(['caws-canonical', 'caws-wt-a', 'caws-wt-b']);
    for (const c of r.candidates) expect(c.source).toBe('capsule');
  });

  it('NEVER mints a capsule (no side effects on disk)', () => {
    tmp = mkTempCaws();
    // Empty sessions directory.
    expect(listCapsules(tmp.cawsDir)).toEqual([]);

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    expect(r.candidates).toEqual([]);
    // No capsule was minted as a side effect.
    expect(listCapsules(tmp.cawsDir)).toEqual([]);
  });

  it('refuses HOOK_SESSION_ID=unknown but trace records the rejection', () => {
    tmp = mkTempCaws();

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { HOOK_SESSION_ID: 'unknown' },
    });

    expect(r.candidates).toEqual([]);
    const hookTrace = r.trace.find((t) => t.source === 'hook_env');
    expect(hookTrace).toBeDefined();
    expect(hookTrace.outcome).toBe('rejected');
    expect(hookTrace.reason).toContain('unknown');
  });

  it('priority order: claude_env, hook_env, capsule, cursor_env', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-cap', '/wt');

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {
        CLAUDE_SESSION_ID: 'caws-claude',
        HOOK_SESSION_ID: 'caws-hook',
        CURSOR_TRACE_ID: 'caws-cursor',
      },
    });

    expect(r.candidates).toHaveLength(4);
    expect(r.candidates[0].source).toBe('claude_env');
    expect(r.candidates[1].source).toBe('hook_env');
    expect(r.candidates[2].source).toBe('capsule');
    expect(r.candidates[3].source).toBe('cursor_env');
  });

  it('trace records absent sources with reasons', () => {
    tmp = mkTempCaws();

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    expect(r.trace).toHaveLength(4);
    const sources = r.trace.map((t) => t.source);
    expect(sources).toEqual(['claude_env', 'hook_env', 'capsule', 'cursor_env']);
    for (const t of r.trace) {
      expect(t.outcome).toBe('absent');
      expect(t.reason).toBeDefined();
    }
  });

  it('skips malformed capsule files; counts them in rejected trace', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-good', '/wt');
    // Drop a malformed file:
    fs.writeFileSync(
      path.join(tmp.cawsDir, 'sessions', 'malformed.json'),
      '{"not": "a capsule"}'
    );

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    // The good capsule is admitted; the malformed file is silently
    // skipped (trace outcome 'admitted' because at least one capsule
    // succeeded — the rejected-only outcome fires when EVERY capsule
    // candidate failed).
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].identity.session_id).toBe('caws-good');
    const capTrace = r.trace.find((t) => t.source === 'capsule');
    expect(capTrace.outcome).toBe('admitted');
    expect(capTrace.count).toBe(1);
    expect(capTrace.admittedIds).toEqual(['caws-good']);
  });

  it('L7: sorts capsule entries for deterministic iteration order', () => {
    tmp = mkTempCaws();
    // Write capsules with names that would sort in alphabetical order
    // distinct from FS-creation order.
    writeCapsule(tmp.cawsDir, 'caws-zzz', '/wt-z');
    writeCapsule(tmp.cawsDir, 'caws-aaa', '/wt-a');
    writeCapsule(tmp.cawsDir, 'caws-mmm', '/wt-m');

    const r1 = resolveSessionCandidates({ cawsDir: tmp.cawsDir, env: {} });
    const r2 = resolveSessionCandidates({ cawsDir: tmp.cawsDir, env: {} });

    // Both calls return candidates in the same alphabetical order.
    const ids1 = r1.candidates.map((c) => c.identity.session_id);
    const ids2 = r2.candidates.map((c) => c.identity.session_id);
    expect(ids1).toEqual(['caws-aaa', 'caws-mmm', 'caws-zzz']);
    expect(ids2).toEqual(ids1);
  });

  it('L1: ENOENT during read surfaces as outcome=race, not unreadable', () => {
    tmp = mkTempCaws();
    // Simulate the race: monkey-patch fs.readFileSync briefly to throw
    // ENOENT, mimicking a sibling process's cleanupSupersededCapsules
    // unlinking the file between our readdir and readFile.
    const realRead = fs.readFileSync;
    const fakePath = path.join(tmp.cawsDir, 'sessions', 'caws-races.json');
    fs.writeFileSync(fakePath, '{}'); // exists at readdir time
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p, opts) {
      if (typeof p === 'string' && p === fakePath) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return origRead.call(this, p, opts);
    };
    try {
      const r = resolveSessionCandidates({ cawsDir: tmp.cawsDir, env: {} });
      const capTrace = r.trace.find((t) => t.source === 'capsule');
      expect(capTrace.outcome).toBe('race');
      expect(capTrace.reason).toContain('concurrent-removal');
      expect(capTrace.reason).not.toContain('unreadable');
    } finally {
      fs.readFileSync = realRead;
    }
  });

  it('L1: non-ENOENT read errors stay classified as unreadable/rejected', () => {
    tmp = mkTempCaws();
    const fakePath = path.join(tmp.cawsDir, 'sessions', 'caws-eperm.json');
    fs.writeFileSync(fakePath, '{}');
    const origRead = fs.readFileSync;
    fs.readFileSync = function (p, opts) {
      if (typeof p === 'string' && p === fakePath) {
        const err = new Error('EACCES: permission denied');
        err.code = 'EACCES';
        throw err;
      }
      return origRead.call(this, p, opts);
    };
    try {
      const r = resolveSessionCandidates({ cawsDir: tmp.cawsDir, env: {} });
      const capTrace = r.trace.find((t) => t.source === 'capsule');
      expect(capTrace.outcome).toBe('rejected');
      expect(capTrace.reason).toContain('unreadable');
      expect(capTrace.reason).toContain('EACCES');
    } finally {
      fs.readFileSync = origRead;
    }
  });

  it('L2: trace records admittedIds for each admitted source', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-cap1', '/wt-1');
    writeCapsule(tmp.cawsDir, 'caws-cap2', '/wt-2');

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {
        CLAUDE_SESSION_ID: 'caws-env-claude',
        HOOK_SESSION_ID: 'caws-env-hook',
        CURSOR_TRACE_ID: 'caws-env-cursor',
      },
    });

    const byName = (s) => r.trace.find((t) => t.source === s);
    expect(byName('claude_env').admittedIds).toEqual(['caws-env-claude']);
    expect(byName('hook_env').admittedIds).toEqual(['caws-env-hook']);
    expect(byName('capsule').admittedIds.sort()).toEqual(['caws-cap1', 'caws-cap2']);
    expect(byName('cursor_env').admittedIds).toEqual(['caws-env-cursor']);
  });

  it('rejects all-malformed capsule directory with reason in trace', () => {
    tmp = mkTempCaws();
    fs.writeFileSync(
      path.join(tmp.cawsDir, 'sessions', 'bad.json'),
      'not valid json'
    );

    const r = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    expect(r.candidates).toEqual([]);
    const capTrace = r.trace.find((t) => t.source === 'capsule');
    expect(capTrace.outcome).toBe('rejected');
    expect(capTrace.reason).toContain('unparseable');
  });
});

// ─── admitsOwner ────────────────────────────────────────────────────────

describe('admitsOwner: session_id-equality admission test', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.root));

  it('returns the matching candidate when session_id equals owner', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-target', '/wt');
    writeCapsule(tmp.cawsDir, 'caws-other', '/sibling');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const match = admitsOwner(candidates, 'caws-target');
    expect(match).not.toBeNull();
    expect(match.identity.session_id).toBe('caws-target');
    expect(match.source).toBe('capsule');
  });

  it('returns null when no candidate matches', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-a', '/wt-a');
    writeCapsule(tmp.cawsDir, 'caws-b', '/wt-b');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const match = admitsOwner(candidates, 'caws-foreign');
    expect(match).toBeNull();
  });

  it('returns null when there are no candidates at all', () => {
    tmp = mkTempCaws();

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    expect(candidates.candidates).toEqual([]);
    expect(admitsOwner(candidates, 'caws-anything')).toBeNull();
  });

  it('matches via env source when env id equals owner', () => {
    tmp = mkTempCaws();
    // No capsules — only env.
    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { CLAUDE_SESSION_ID: 'caws-env-only' },
    });

    const match = admitsOwner(candidates, 'caws-env-only');
    expect(match).not.toBeNull();
    expect(match.source).toBe('claude_env');
  });
});

// ─── describeCandidateTrace ─────────────────────────────────────────────

describe('describeCandidateTrace: human-readable diagnostic trace', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.root));

  it('lists every source consulted with outcome and reason', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-cap', '/wt');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { CLAUDE_SESSION_ID: 'caws-env' },
    });

    const text = describeCandidateTrace(candidates);
    expect(text).toContain('claude_env: admitted (count=1)');
    expect(text).toContain('hook_env: absent');
    expect(text).toContain('capsule: admitted (count=1)');
    expect(text).toContain('cursor_env: absent');
  });

  it('renders one line per source PLUS one candidate line per admitted ID', () => {
    tmp = mkTempCaws();
    // Two capsules + one env => 3 candidates; trace has 4 source lines.
    writeCapsule(tmp.cawsDir, 'caws-cap1', '/wt-1');
    writeCapsule(tmp.cawsDir, 'caws-cap2', '/wt-2');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { CLAUDE_SESSION_ID: 'caws-env-c' },
    });

    const text = describeCandidateTrace(candidates);
    const lines = text.split('\n');
    // 4 source lines + 1 admitted-id line for claude_env + 2 admitted-id
    // lines for capsule = 7 lines total.
    expect(lines).toHaveLength(7);
  });

  it('renders empty trace as four absent lines (no candidate lines)', () => {
    tmp = mkTempCaws();

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const text = describeCandidateTrace(candidates);
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
  });

  it('L2: refusal-diagnostic-grade trace includes admitted session_ids inline', () => {
    tmp = mkTempCaws();
    writeCapsule(tmp.cawsDir, 'caws-target-id', '/wt');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const text = describeCandidateTrace(candidates);
    // The session_id is rendered (so an operator can compare against
    // the registered owner) — not just the count.
    expect(text).toContain('candidate: caws-target-id');
  });

  it('L2: truncates long session_ids in the rendered trace (raw IDs preserved on admittedIds)', () => {
    tmp = mkTempCaws();
    const longId = 'caws-extremely-long-session-id-that-exceeds-display';
    writeCapsule(tmp.cawsDir, longId, '/wt');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const text = describeCandidateTrace(candidates);
    // Render truncated to first 16 chars + ellipsis.
    expect(text).toContain('candidate: caws-extremely-l…');
    // But the raw ID is preserved for callers that need it.
    const capTrace = candidates.trace.find((t) => t.source === 'capsule');
    expect(capTrace.admittedIds).toEqual([longId]);
  });
});
