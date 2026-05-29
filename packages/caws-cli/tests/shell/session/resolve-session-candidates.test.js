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

// Durable hook-session envelope fixture
// (CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-UNRESOLVABLE-001). The scanner
// looks under `<repoRoot>/tmp/<id>/.session-envelope.json` where repoRoot is
// path.dirname(cawsDir) — i.e. the temp `root`. repo_root inside the envelope
// is realpath-compared against the scan's repoRoot, so write the real path to
// defeat macOS /tmp vs /private/tmp. lastSeenAt controls the freshness gate.
function writeEnvelope(root, id, lastSeenAt, repoRootOverride) {
  const realRoot = (() => {
    try {
      return fs.realpathSync(root);
    } catch {
      return root;
    }
  })();
  const dir = path.join(root, 'tmp', id);
  fs.mkdirSync(dir, { recursive: true });
  const envelope = {
    session_id: id,
    repo_root: repoRootOverride !== undefined ? repoRootOverride : realRoot,
    created_at: lastSeenAt,
    last_seen_at: lastSeenAt,
    hook_event: 'PostToolUse',
  };
  fs.writeFileSync(
    path.join(dir, '.session-envelope.json'),
    JSON.stringify(envelope, null, 2) + '\n'
  );
}

// A fixed clock so envelope freshness is deterministic. Envelopes stamped
// at FIXED_NOW are fresh; stamped >24h before are stale.
const FIXED_NOW_ISO = '2026-05-28T12:00:00.000Z';
const fixedNow = () => new Date(FIXED_NOW_ISO);
const hoursAgoIso = (h) =>
  new Date(new Date(FIXED_NOW_ISO).getTime() - h * 60 * 60 * 1000).toISOString();

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

    // Six sources are now consulted. durable_hook_envelope was added by
    // CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-UNRESOLVABLE-001 (between
    // hook_env and capsule); claude_code_env (tier 1.5) was added by
    // CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001 (between claude_env and
    // hook_env). Both mirror resolveSession's source chain.
    expect(r.trace).toHaveLength(6);
    const sources = r.trace.map((t) => t.source);
    expect(sources).toEqual([
      'claude_env',
      'claude_code_env',
      'hook_env',
      'durable_hook_envelope',
      'capsule',
      'cursor_env',
    ]);
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
    // Two capsules + one env => 3 candidates; trace has 6 source lines.
    // claude_code_env (CAWS-SESSION-ID-AGENT-BASH-PROPAGATION-001) and
    // durable_hook_envelope (CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-
    // UNRESOLVABLE-001) are both absent here, so each contributes a source
    // line but no candidate line.
    writeCapsule(tmp.cawsDir, 'caws-cap1', '/wt-1');
    writeCapsule(tmp.cawsDir, 'caws-cap2', '/wt-2');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { CLAUDE_SESSION_ID: 'caws-env-c' },
    });

    const text = describeCandidateTrace(candidates);
    const lines = text.split('\n');
    // 6 source lines + 1 admitted-id line for claude_env + 2 admitted-id
    // lines for capsule = 9 lines total.
    expect(lines).toHaveLength(9);
  });

  it('renders empty trace as six absent lines (no candidate lines)', () => {
    tmp = mkTempCaws();

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
    });

    const text = describeCandidateTrace(candidates);
    const lines = text.split('\n');
    // Six sources: claude_env, claude_code_env, hook_env,
    // durable_hook_envelope, capsule, cursor_env — all absent, no
    // candidate lines.
    expect(lines).toHaveLength(6);
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

// ─── durable_hook_envelope source ───────────────────────────────────────
//
// CAWS-WORKTREE-DESTROY-GHOST-ENTRY-OWNER-UNRESOLVABLE-001.
//
// The exhaustive ownership-comparison resolver previously omitted the
// durable-hook-envelope source that the singular resolveSession() (and thus
// `caws status`) consults at step 2.5. That omission meant a ghost worktree
// entry owned by a claude-code UUID session — resolvable as "self" by status
// via the envelope, but invisible to destroy's candidate set in agent-Bash
// (HOOK_SESSION_ID absent, no capsule carrying the UUID) — could not be
// destroyed by its legitimate owner, and the only doctor-suggested repair was
// a forbidden hand-edit of worktrees.json. These tests prove the source is
// now consulted, that ALL fresh envelopes are admitted (deliberate divergence
// from resolveSession's >=2 refusal), and that foreign-ownership protection
// is preserved (A4).

describe('resolveSessionCandidates: durable_hook_envelope source', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.root));

  it('A1: admits a fresh durable envelope as a candidate; admitsOwner matches its UUID', () => {
    tmp = mkTempCaws();
    const uuid = '5dfee16a-176b-4f0a-a721-1cb06ee288dd';
    writeEnvelope(tmp.root, uuid, FIXED_NOW_ISO);

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {}, // agent-Bash: no CLAUDE_SESSION_ID / HOOK_SESSION_ID
      now: fixedNow,
    });

    const envCand = candidates.candidates.find(
      (c) => c.source === 'durable_hook_envelope'
    );
    expect(envCand).toBeDefined();
    expect(envCand.identity.session_id).toBe(uuid);
    expect(envCand.identity.platform).toBe('claude-code');
    expect(typeof envCand.envelopePath).toBe('string');

    // The ghost-clear core: the registered owner (a claude-code UUID) is now
    // matched by the candidate set, so destroy's admitsOwner check admits.
    const match = admitsOwner(candidates, uuid);
    expect(match).not.toBeNull();
    expect(match.source).toBe('durable_hook_envelope');

    // Trace records the source as admitted with the UUID.
    const t = candidates.trace.find((x) => x.source === 'durable_hook_envelope');
    expect(t.outcome).toBe('admitted');
    expect(t.count).toBe(1);
    expect(t.admittedIds).toEqual([uuid]);
  });

  it('A3: admits ALL fresh envelopes (divergence from resolveSession >=2 refusal)', () => {
    tmp = mkTempCaws();
    const a = 'aaaaaaaa-1111-4111-8111-111111111111';
    const b = 'bbbbbbbb-2222-4222-8222-222222222222';
    writeEnvelope(tmp.root, a, FIXED_NOW_ISO);
    writeEnvelope(tmp.root, b, FIXED_NOW_ISO);

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
      now: fixedNow,
    });

    const envCands = candidates.candidates.filter(
      (c) => c.source === 'durable_hook_envelope'
    );
    expect(envCands.length).toBe(2);
    const ids = envCands.map((c) => c.identity.session_id).sort();
    expect(ids).toEqual([a, b]);

    // Either owner can be matched — the comparison set answers "can I speak
    // for this owner?" for both.
    expect(admitsOwner(candidates, a)).not.toBeNull();
    expect(admitsOwner(candidates, b)).not.toBeNull();

    const t = candidates.trace.find((x) => x.source === 'durable_hook_envelope');
    expect(t.outcome).toBe('admitted');
    expect(t.count).toBe(2);
  });

  it('A4 (negative lock): a foreign owner whose envelope is NOT on disk is never matched', () => {
    tmp = mkTempCaws();
    // The caller has their OWN fresh envelope...
    const mine = 'cccccccc-3333-4333-8333-333333333333';
    writeEnvelope(tmp.root, mine, FIXED_NOW_ISO);

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
      now: fixedNow,
    });

    // ...but a DIFFERENT session owns the live worktree. No envelope, no
    // capsule, no env id carries that owner's id, so the candidate set has
    // no match — destroy's refusal still fires.
    const foreignOwner = 'dddddddd-4444-4444-8444-444444444444';
    expect(admitsOwner(candidates, foreignOwner)).toBeNull();
    // The caller's own id still matches (sanity: the source works at all).
    expect(admitsOwner(candidates, mine)).not.toBeNull();
  });

  it('does NOT admit a stale (>24h) envelope; trace reports absent', () => {
    tmp = mkTempCaws();
    const stale = 'eeeeeeee-5555-4555-8555-555555555555';
    writeEnvelope(tmp.root, stale, hoursAgoIso(25)); // 25h ago → stale

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
      now: fixedNow,
    });

    expect(
      candidates.candidates.find((c) => c.source === 'durable_hook_envelope')
    ).toBeUndefined();
    expect(admitsOwner(candidates, stale)).toBeNull();
    const t = candidates.trace.find((x) => x.source === 'durable_hook_envelope');
    expect(t.outcome).toBe('absent');
  });

  it('skips an envelope whose repo_root is a different repo', () => {
    tmp = mkTempCaws();
    const otherRepoId = 'ffffffff-6666-4666-8666-666666666666';
    // Fresh envelope, but repo_root points elsewhere — must be skipped.
    writeEnvelope(tmp.root, otherRepoId, FIXED_NOW_ISO, '/some/other/repo');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: {},
      now: fixedNow,
    });

    expect(
      candidates.candidates.find((c) => c.source === 'durable_hook_envelope')
    ).toBeUndefined();
    expect(admitsOwner(candidates, otherRepoId)).toBeNull();
  });

  it('orders the envelope source between hook_env and capsule in the trace', () => {
    tmp = mkTempCaws();
    writeEnvelope(tmp.root, 'aaaaaaaa-1111-4111-8111-111111111111', FIXED_NOW_ISO);
    writeCapsule(tmp.cawsDir, 'caws-cap', '/wt');

    const candidates = resolveSessionCandidates({
      cawsDir: tmp.cawsDir,
      env: { HOOK_SESSION_ID: 'caws-hook' },
      now: fixedNow,
    });

    const sources = candidates.trace.map((t) => t.source);
    expect(sources).toEqual([
      'claude_env',
      'claude_code_env',
      'hook_env',
      'durable_hook_envelope',
      'capsule',
      'cursor_env',
    ]);
  });
});
