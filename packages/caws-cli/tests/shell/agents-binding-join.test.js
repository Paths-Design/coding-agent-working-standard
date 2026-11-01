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
const { loadSpecs } = require('../../dist/store/specs-store');

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

function writeBridgeSpec(root, id, { state = 'active', worktree } = {}) {
  fs.writeFileSync(
    path.join(root, '.caws', 'specs', `${id}.yaml`),
    `id: ${id}
title: 'Bridge visibility fixture'
mode: fix
lifecycle_state: ${state}
${state === 'closed' ? 'resolution: completed\n' : ''}${worktree === undefined ? '' : `worktree: ${worktree}\n`}created_at: '2026-07-04T00:00:00.000Z'
updated_at: '2026-07-04T00:00:00.000Z'
blast_radius:
  modules: [tests]
  data_migration: false
operational_rollback_slo: 5m
scope:
  in: [tests]
  out: []
invariants: ['fixture']
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`
  );
}

function writeBridges(root, bridges) {
  const dir = path.join(root, '.caws', 'claims');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify(bridges));
}

function bridge(owner) {
  return { session_id: owner, acquired_at: '2026-07-04T00:00:00.000Z' };
}

function authorityBytes(root) {
  const result = {};
  function visit(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const key = prefix + entry.name;
      if (entry.isDirectory()) visit(file, key + '/');
      else result[key] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(path.join(root, '.caws'), '');
  return result;
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

describe('agents list session bridge visibility', () => {
  test('active bridge IDs are sorted, owner-specific and separate from worktree bindings', () => {
    const root = mkRepo();
    for (const owner of ['bridge-owner', 'other-owner', 'empty-owner']) register(root, owner);
    for (const id of [
      'BRIDGE-Z-001',
      'BRIDGE-A-001',
      'BRIDGE-OTHER-001',
      'BRIDGE-REG-001',
      'BRIDGE-OWNERLESS-001',
      'BRIDGE-ABSENT-001',
    ]) {
      writeBridgeSpec(root, id);
    }
    writeBridgeSpec(root, 'BRIDGE-TREE-001', { worktree: 'missing-tree' });
    writeBridgeSpec(root, 'BRIDGE-CLOSED-001', { state: 'closed' });
    writeBridgeSpec(root, 'BRIDGE-DRAFT-001', { state: 'draft' });
    writeRegistry(root, {
      'wt-other-spec': ownedBy('bridge-owner', 'WORKTREE-001'),
      'wt-subordinate': ownedBy('other-owner', 'BRIDGE-REG-001'),
      'wt-ownerless': { path: '/tmp/ownerless-fixture', specId: 'BRIDGE-OWNERLESS-001' },
    });
    patchLease(root, 'bridge-owner', {
      bound_worktree: 'cache-ghost',
      bound_spec_id: 'CACHE-GHOST',
    });
    writeBridges(root, {
      'BRIDGE-Z-001': bridge('bridge-owner'),
      'BRIDGE-A-001': bridge('bridge-owner'),
      'BRIDGE-OTHER-001': bridge('other-owner'),
      'BRIDGE-REG-001': bridge('bridge-owner'),
      'BRIDGE-OWNERLESS-001': bridge('bridge-owner'),
      'BRIDGE-TREE-001': bridge('bridge-owner'),
      'BRIDGE-CLOSED-001': bridge('bridge-owner'),
      'BRIDGE-DRAFT-001': bridge('bridge-owner'),
      'BRIDGE-MISSING-001': bridge('bridge-owner'),
      'BRIDGE-ABSENT-001': bridge('absent-lease-owner'),
    });
    expect(
      loadSpecs(path.join(root, '.caws')).diagnostics.filter(
        (diagnostic) => diagnostic.severity === 'error'
      )
    ).toEqual([]);
    const before = authorityBytes(root);
    const text = list(root);
    const { code, payload } = listJson(root);
    expect(code).toBe(0);
    expect(payload.sources.bridge_binding).toBe('.caws/claims/bridge.json');
    expect(payload.bridge_bindings).toEqual({
      sources: {
        claims: '.caws/claims/bridge.json',
        specs: '.caws/specs/',
        worktrees: '.caws/worktrees.json',
      },
      resolution: 'resolved',
      by_session: {
        'bridge-owner': ['BRIDGE-A-001', 'BRIDGE-Z-001'],
        'other-owner': ['BRIDGE-OTHER-001'],
        'empty-owner': [],
      },
    });
    expect(payload.worktree_bindings.by_session['bridge-owner']).toEqual([
      { worktree: 'wt-other-spec', spec_id: 'WORKTREE-001' },
    ]);
    expect(payload.active.map((lease) => lease.session_id).sort()).toEqual([
      'bridge-owner',
      'empty-owner',
      'other-owner',
    ]);
    expect(lineFor(text, 'bridge-owner')).toContain('bridges=BRIDGE-A-001,BRIDGE-Z-001');
    expect(lineFor(text, 'other-owner')).toContain('bridges=BRIDGE-OTHER-001');
    expect(lineFor(text, 'empty-owner')).toContain('bridges=(none)');
    expect(text.text).toContain('bridge-source: .caws/claims/bridge.json');
    expect(text.text).not.toContain('cache-ghost');
    expect(authorityBytes(root)).toEqual(before);
  });

  test('a missing claims file is a resolved empty bridge set', () => {
    const root = mkRepo();
    register(root, 'unclaimed-owner');
    writeBridgeSpec(root, 'BRIDGE-001');
    fs.rmSync(path.join(root, '.caws', 'claims', 'bridge.json'), { force: true });
    const before = authorityBytes(root);
    const { payload } = listJson(root);
    expect(payload.bridge_bindings.resolution).toBe('resolved');
    expect(payload.bridge_bindings.by_session).toEqual({ 'unclaimed-owner': [] });
    expect(lineFor(list(root), 'unclaimed-owner')).toContain('bridges=(none)');
    expect(authorityBytes(root)).toEqual(before);
  });

  test.each([
    null,
    [],
    'bridge-owner',
    {},
    { session_id: '' },
    { session_id: '   ' },
    { session_id: 12 },
    { session_id: ' bridge-owner ' },
  ])('a malformed or differently named owner %j is not attributed to a lease session', (entry) => {
    const root = mkRepo();
    register(root, 'bridge-owner');
    writeBridgeSpec(root, 'BRIDGE-001');
    writeBridges(root, { 'BRIDGE-001': entry });
    const before = authorityBytes(root);
    const { payload } = listJson(root);
    expect(payload.bridge_bindings.resolution).toBe('resolved');
    expect(payload.bridge_bindings.by_session['bridge-owner']).toEqual([]);
    expect(lineFor(list(root), 'bridge-owner')).toContain('bridges=(none)');
    expect(authorityBytes(root)).toEqual(before);
  });

  test.each(['claims-json', 'claims-read', 'specs', 'worktrees'])(
    'unreadable %s input makes bridge data unknown without hiding the lease row',
    (kind) => {
      const root = mkRepo();
      register(root, 'bridge-owner');
      writeBridgeSpec(root, 'BRIDGE-001');
      writeBridges(root, { 'BRIDGE-001': bridge('bridge-owner') });
      let failedPath;
      if (kind === 'claims-json') {
        failedPath = path.join(root, '.caws', 'claims', 'bridge.json');
        fs.writeFileSync(failedPath, '{broken');
      } else if (kind === 'claims-read') {
        failedPath = path.join(root, '.caws', 'claims', 'bridge.json');
        fs.unlinkSync(failedPath);
        fs.mkdirSync(failedPath);
      } else if (kind === 'specs') {
        failedPath = path.join(root, '.caws', 'specs');
        fs.rmSync(failedPath, { recursive: true });
        fs.writeFileSync(failedPath, 'not a directory');
      } else {
        failedPath = path.join(root, '.caws', 'worktrees.json');
        fs.writeFileSync(failedPath, '{broken');
      }
      const before = authorityBytes(root);
      const text = list(root);
      const { code, payload } = listJson(root);
      expect(code).toBe(0);
      expect(payload.active.map((lease) => lease.session_id)).toEqual(['bridge-owner']);
      expect(payload.sources.bridge_binding).toBeNull();
      expect(payload.bridge_bindings.resolution).toBe('unreadable');
      expect(payload.bridge_bindings.by_session).toBeUndefined();
      expect(payload.worktree_bindings.resolution).toBe(
        kind === 'worktrees' ? 'unreadable' : 'resolved'
      );
      expect(payload.bridge_bindings.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ subject: fs.realpathSync(failedPath), severity: 'error' }),
        ])
      );
      expect(lineFor(text, 'bridge-owner')).toContain('bridges=unknown');
      expect(lineFor(text, 'bridge-owner')).not.toContain('bridges=(none)');
      expect(text.text).toContain('bridge-source: unavailable');
      expect(authorityBytes(root)).toEqual(before);
    }
  );

  test('a malformed claimed spec is unknown rather than an asserted absence', () => {
    const root = mkRepo();
    register(root, 'bridge-owner');
    writeBridgeSpec(root, 'BRIDGE-001');
    writeBridges(root, { 'BRIDGE-001': bridge('bridge-owner') });
    const file = path.join(root, '.caws', 'specs', 'BRIDGE-001.yaml');
    fs.writeFileSync(file, 'id: [');
    const before = authorityBytes(root);
    const { payload } = listJson(root);
    expect(payload.bridge_bindings.resolution).toBe('unreadable');
    expect(payload.bridge_bindings.by_session).toBeUndefined();
    expect(payload.bridge_bindings.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: fs.realpathSync(file), severity: 'error' }),
      ])
    );
    expect(authorityBytes(root)).toEqual(before);
  });

  test('lease visibility flags filter rows without revoking their bridges', () => {
    const root = mkRepo();
    const owners = ['live-owner', 'stale-owner', 'stopped-owner'];
    const claims = {};
    for (const [index, owner] of owners.entries()) {
      register(root, owner);
      patchLease(root, owner, {
        started_at: '2026-10-28T00:00:00.000Z',
        last_active:
          owner === 'stale-owner' ? '2026-10-29T00:00:00.000Z' : '2026-10-31T23:59:00.000Z',
        status: owner === 'stopped-owner' ? 'stopped' : 'active',
      });
      const id = `BRIDGE-${index}-001`;
      writeBridgeSpec(root, id);
      claims[id] = bridge(owner);
    }
    writeBridges(root, claims);
    const now = () => new Date('2026-11-01T00:00:00.000Z');
    const before = authorityBytes(root);
    const normal = listJson(root, { now });
    expect(normal.payload.bridge_bindings.by_session).toEqual({ 'live-owner': ['BRIDGE-0-001'] });
    const options = { now, includeStale: true, includeStopped: true };
    const all = listJson(root, options);
    expect(all.payload.bridge_bindings.by_session).toEqual({
      'live-owner': ['BRIDGE-0-001'],
      'stale-owner': ['BRIDGE-1-001'],
      'stopped-owner': ['BRIDGE-2-001'],
    });
    const text = list(root, options);
    for (const [index, owner] of owners.entries()) {
      expect(lineFor(text, owner)).toContain(`bridges=BRIDGE-${index}-001`);
    }
    const activeOnly = listJson(root, { ...options, activeOnly: true });
    expect(activeOnly.payload.bridge_bindings.by_session).toEqual(
      normal.payload.bridge_bindings.by_session
    );
    expect(activeOnly.payload.visibility.hidden).toEqual([
      { bucket: 'stale', count: 1, flag: '--include-stale', suppressed_by: '--active' },
      { bucket: 'stopped', count: 1, flag: '--include-stopped', suppressed_by: '--active' },
    ]);
    expect(authorityBytes(root)).toEqual(before);
  });

  test('worktree columns and bridge precedence share the same worktree observation', () => {
    const root = mkRepo();
    register(root, 'bridge-owner');
    writeBridgeSpec(root, 'BRIDGE-001');
    writeBridges(root, { 'BRIDGE-001': bridge('bridge-owner') });
    const initial = { 'wt-one': ownedBy('bridge-owner', 'BRIDGE-001') };
    writeRegistry(root, initial);
    const file = fs.realpathSync(path.join(root, '.caws', 'worktrees.json'));
    const before = authorityBytes(root);
    const readFileSync = fs.readFileSync;
    let reads = 0;
    const spy = jest.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (target === file) return JSON.stringify(++reads === 1 ? initial : {});
      return readFileSync(target, ...args);
    });
    let result;
    try {
      result = listJson(root);
    } finally {
      spy.mockRestore();
    }
    expect(reads).toBe(1);
    expect(result.payload.worktree_bindings.by_session['bridge-owner']).toEqual([
      { worktree: 'wt-one', spec_id: 'BRIDGE-001' },
    ]);
    expect(result.payload.bridge_bindings.by_session['bridge-owner']).toEqual([]);
    expect(authorityBytes(root)).toEqual(before);
  });
});
