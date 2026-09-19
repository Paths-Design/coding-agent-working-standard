'use strict';

/**
 * Contract tests for CAWS-AGENTS-LIST-BINDING-JOIN-01.
 *
 * `caws agents list` used to read `bound_worktree` / `bound_spec_id` off the
 * lease and print `(no worktree)` / `(no spec)` whenever they were absent.
 * Those two lease fields have only incidental writers (`caws status`,
 * `caws claim`) — the hook-driven register/heartbeat path never populates
 * them — so the renderer printed a true-sounding negative it could not
 * source. `.caws/worktrees.json` is the authority for worktree ownership;
 * the lease is operational cache.
 *
 * These tests pin the joined behavior and the three outcomes that must never
 * collapse into each other:
 *
 *   registry unreadable            -> unknown          (cannot source)
 *   registry read, owns nothing    -> (no worktree)    (observed absence)
 *   registry read, owns n >= 1     -> every name       (never truncated)
 *
 * Harness pattern follows agents-work-state.test.js: real command surfaces
 * against an on-disk git+caws repo with injected sinks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runAgentsRegisterCommand,
  runAgentsListCommand,
} = require('../../dist/shell/commands/agents');
const { initProject } = require('../../dist/store/init-store');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-bjoin-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function register(root, sid) {
  const s = sinks();
  const code = runAgentsRegisterCommand({
    sessionId: sid,
    platform: 'test',
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error('register failed: ' + s.err.join('\n'));
}

/** Overwrite a lease field directly — models an incidental writer such as
 *  `caws status` having cached a binding into the lease earlier. */
function patchLease(root, sid, patch) {
  const p = path.join(root, '.caws', 'leases', `${sid}.json`);
  const lease = JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.writeFileSync(p, JSON.stringify({ ...lease, ...patch }, null, 2));
}

function writeRegistry(root, payload) {
  const p = path.join(root, '.caws', 'worktrees.json');
  fs.writeFileSync(p, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
}

function ownedBy(sid, specId) {
  return {
    path: `/tmp/does-not-need-to-exist/${sid}`,
    branch: `caws/${sid}`,
    ...(specId !== undefined ? { specId } : {}),
    owner: { session_id: sid, platform: 'test' },
  };
}

function list(root, extra = {}) {
  const s = sinks();
  const code = runAgentsListCommand({
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
    ...extra,
  });
  return { code, out: s.out, err: s.err, text: s.out.join('\n') };
}

function listJson(root, extra = {}) {
  const r = list(root, { ...extra, json: true });
  return { ...r, payload: JSON.parse(r.out.join('\n')) };
}

function lineFor(r, sid) {
  return r.out.find((l) => l.startsWith(`  ${sid}`));
}

describe('CAWS-AGENTS-LIST-BINDING-JOIN-01', () => {
  // ── A1: a session owning two worktrees shows BOTH ──────────────────────
  test('A1: two worktrees owned by one session render both names and both spec ids', () => {
    const root = mkRepo();
    register(root, 'sess-two');
    writeRegistry(root, {
      'wt-a': ownedBy('sess-two', 'SPEC-A'),
      'wt-b': ownedBy('sess-two', 'SPEC-B'),
    });

    const r = list(root);
    expect(r.code).toBe(0);
    const line = lineFor(r, 'sess-two');
    // Both names, comma-joined, with their spec ids column-aligned by index.
    expect(line).toMatch(/sess-two\s+wt-a,wt-b\s+SPEC-A,SPEC-B/);
  });

  test('A1b: a second owner is not attributed the first owner’s worktrees', () => {
    const root = mkRepo();
    register(root, 'sess-one');
    register(root, 'sess-other');
    writeRegistry(root, {
      'wt-mine': ownedBy('sess-one', 'SPEC-MINE'),
      'wt-theirs': ownedBy('sess-other', 'SPEC-THEIRS'),
    });

    const r = list(root);
    expect(lineFor(r, 'sess-one')).toMatch(/wt-mine\s+SPEC-MINE/);
    expect(lineFor(r, 'sess-one')).not.toContain('wt-theirs');
    expect(lineFor(r, 'sess-other')).toMatch(/wt-theirs\s+SPEC-THEIRS/);
    expect(lineFor(r, 'sess-other')).not.toContain('wt-mine');
  });

  test('A1c: an owned worktree with no specId renders the name and (no spec) in the spec column', () => {
    const root = mkRepo();
    register(root, 'sess-nospec');
    writeRegistry(root, { 'wt-unbound': ownedBy('sess-nospec') });

    const line = lineFor(list(root), 'sess-nospec');
    expect(line).toMatch(/wt-unbound\s+\(no spec\)/);
  });

  // ── A2: readable registry + owns nothing = OBSERVED absence ────────────
  test('A2: a readable registry in which the session owns nothing states the absence', () => {
    const root = mkRepo();
    register(root, 'sess-none');
    writeRegistry(root, { 'wt-someone-else': ownedBy('sess-elsewhere', 'SPEC-E') });

    const r = list(root);
    expect(r.code).toBe(0);
    expect(lineFor(r, 'sess-none')).toMatch(/sess-none\s+\(no worktree\)\s+\(no spec\)/);
  });

  test('A2b: an empty registry is readable, so absence is still observed, not unknown', () => {
    const root = mkRepo();
    register(root, 'sess-empty-reg');
    writeRegistry(root, {});

    const line = lineFor(list(root), 'sess-empty-reg');
    expect(line).toMatch(/\(no worktree\)\s+\(no spec\)/);
    expect(line).not.toContain('unknown');
  });

  // ── A3: unreadable registry = unknown, never a manufactured absence ────
  test('A3: malformed worktrees.json renders unknown, still lists the session, exits 0', () => {
    const root = mkRepo();
    register(root, 'sess-malformed');
    writeRegistry(root, '{ this is not json');

    const r = list(root);
    expect(r.code).toBe(0);
    const line = lineFor(r, 'sess-malformed');
    expect(line).toMatch(/sess-malformed\s+unknown\s+unknown/);
    // The load-bearing negative: it must NOT claim an absence it cannot source.
    expect(line).not.toContain('(no worktree)');
    expect(line).not.toContain('(no spec)');
  });

  test('A3b: a registry that is valid JSON but not an object also renders unknown', () => {
    const root = mkRepo();
    register(root, 'sess-array-reg');
    writeRegistry(root, '["wt-a"]');

    const line = lineFor(list(root), 'sess-array-reg');
    expect(line).toMatch(/unknown\s+unknown/);
  });

  // ── Authority beats cache ──────────────────────────────────────────────
  test('a stale bound_worktree cached on the lease never overrides the registry', () => {
    const root = mkRepo();
    register(root, 'sess-stale-cache');
    // The lease remembers a worktree the authority does not attribute to it.
    patchLease(root, 'sess-stale-cache', {
      bound_worktree: 'wt-ghost',
      bound_spec_id: 'SPEC-GHOST',
    });
    writeRegistry(root, {});

    const line = lineFor(list(root), 'sess-stale-cache');
    expect(line).not.toContain('wt-ghost');
    expect(line).not.toContain('SPEC-GHOST');
    expect(line).toMatch(/\(no worktree\)\s+\(no spec\)/);
  });

  test('the registry supplies a binding the lease never cached', () => {
    const root = mkRepo();
    register(root, 'sess-uncached');
    // register() writes no bound_worktree; the pre-join renderer therefore
    // printed "(no worktree)" for a session that demonstrably owns one.
    writeRegistry(root, { 'wt-real': ownedBy('sess-uncached', 'SPEC-REAL') });

    const line = lineFor(list(root), 'sess-uncached');
    expect(line).toMatch(/wt-real\s+SPEC-REAL/);
  });

  // ── A4: JSON parity ────────────────────────────────────────────────────
  test('A4: --json carries the same binding facts as the text rendering', () => {
    const root = mkRepo();
    register(root, 'sess-json');
    register(root, 'sess-json-none');
    writeRegistry(root, {
      'wt-j1': ownedBy('sess-json', 'SPEC-J1'),
      'wt-j2': ownedBy('sess-json'),
    });

    const { code, payload } = listJson(root);
    expect(code).toBe(0);
    expect(payload.worktree_bindings.resolution).toBe('resolved');
    expect(payload.worktree_bindings.source).toBe('.caws/worktrees.json');
    expect(payload.worktree_bindings.by_session['sess-json']).toEqual([
      { worktree: 'wt-j1', spec_id: 'SPEC-J1' },
      { worktree: 'wt-j2', spec_id: null },
    ]);
    // Observed absence is explicit in the payload, not inferred from a
    // missing key.
    expect(payload.worktree_bindings.by_session['sess-json-none']).toEqual([]);
  });

  test('A4b: --json reports resolution unreadable and omits by_session when the registry cannot be read', () => {
    const root = mkRepo();
    register(root, 'sess-json-unknown');
    writeRegistry(root, 'not json at all');

    const { code, payload } = listJson(root);
    expect(code).toBe(0);
    expect(payload.worktree_bindings.resolution).toBe('unreadable');
    // Absent rather than `{}` — an empty map would assert that every listed
    // session owns nothing, which is the claim we could not source.
    expect(payload.worktree_bindings.by_session).toBeUndefined();
    expect(payload.active.length).toBe(1);
  });

  test('A4c: stale and stopped sessions get by_session entries only when they are emitted', () => {
    const root = mkRepo();
    register(root, 'sess-active-only');
    writeRegistry(root, { 'wt-ao': ownedBy('sess-active-only', 'SPEC-AO') });

    const withStale = listJson(root, { includeStale: true });
    expect(withStale.payload.worktree_bindings.by_session['sess-active-only']).toEqual([
      { worktree: 'wt-ao', spec_id: 'SPEC-AO' },
    ]);
    // Nothing is stale in a fresh repo, so the stale bucket adds no keys.
    expect(Object.keys(withStale.payload.worktree_bindings.by_session)).toEqual([
      'sess-active-only',
    ]);
  });
});
