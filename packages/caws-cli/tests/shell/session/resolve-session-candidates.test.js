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
  } catch {}
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

  it('produces a multi-line string with one line per source', () => {
    tmp = mkTempCaws();

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const text = describeCandidateTrace(candidates);
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
  });
});
