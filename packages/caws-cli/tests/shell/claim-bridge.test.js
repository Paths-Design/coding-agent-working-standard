'use strict';

/**
 * Command-level contract tests for AUTH-BINDING-BRIDGE-001 — the seven-slot
 * bridge lifecycle through the real `caws claim` and `caws scope` surfaces.
 *
 * A1 acquire + scope admission:  claim --spec BR-901 (active spec, no
 *    worktree) => binding recorded + claim_bridged event; scope show on an
 *    in-scope path => ADMIT with bindingState 'bridged', mode
 *    'authoritative'; out-of-scope path => reject exactly as a worktree
 *    binding would refuse.
 * A2 subordination: spec held by a live worktree binding => bridge acquire
 *    refuses naming the worktree + owner; no state, no event.
 * A3 foreign + takeover: bare foreign acquire refuses (soft-block);
 *    --takeover rewrites + prior_owners audit + bridge_claim_taken_over.
 * A4 release: named removes exactly one + claim_released(scope:named); bare
 *    removes every owned; foreign release refuses.
 * A5 retire: closed-spec bridge confers NO scope authority; claim --spec on
 *    a closed spec refuses with the reopen handoff; worktree prune lists
 *    bridge ghosts (dry-run) and --apply removes (no events).
 * A6 observe: status renders the bridged binding; read-only.
 * A7 concurrency: serialized sequential mutations on the same spec leave
 *    consistent state (refresh semantics), never partial.
 *
 * SUT: dist (npm run build compiles first).
 */

const fs = require('fs');
const path = require('path');

const { runClaimCommand } = require('../../dist/shell/commands/claim');
const { runScopeCommand } = require('../../dist/shell/commands/scope');
const { runWorktreePruneCommand } = require('../../dist/shell/commands/worktree');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { initProject } = require('../../dist/store/init-store');
const { loadEvents } = require('../../dist/store/events-store');
const { makeTempRepo, cleanupAll } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function writeSpec(cawsDir, id, state, scopeIn) {
  const body = `id: ${id}
title: '${id}'
risk_tier: 3
mode: chore
lifecycle_state: ${state}
created_at: '2026-08-24T00:00:00.000Z'
updated_at: '2026-08-24T00:00:00.000Z'
blast_radius:
  modules:
    - tests
  data_migration: false
scope:
  in:
${scopeIn.map((p) => `    - '${p}'`).join('\n')}
  out: []
invariants:
  - 'fixture'
acceptance:
  - id: A1
    given: 'fixture'
    when: 'fixture'
    then: 'fixture'
non_functional: {}
contracts: []
`;
  fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(cawsDir, 'specs', `${id}.yaml`), body);
}

function writeRegistry(cawsDir, entries) {
  fs.writeFileSync(path.join(cawsDir, 'worktrees.json'), JSON.stringify(entries, null, 2) + '\n');
}

function mkRepo() {
  const root = makeTempRepo();
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

function claim(root, opts) {
  const out = [];
  const err = [];
  const code = runClaimCommand({
    cwd: root,
    now: () => new Date('2026-08-24T12:00:00.000Z'),
    env: opts.env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    ...(opts.takeover !== undefined ? { takeover: opts.takeover } : {}),
    ...(opts.spec !== undefined ? { spec: opts.spec } : {}),
    ...(opts.release !== undefined ? { release: opts.release } : {}),
  });
  return { code, out, err };
}

function scopeShow(root, p, env) {
  const out = [];
  const err = [];
  const code = runScopeCommand({
    mode: 'show', path: p, json: true,
    cwd: root,
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  });
  return { code, json: out.length > 0 ? JSON.parse(out.join('')) : null, out, err };
}

function countEvents(cawsDir, kind) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed: ' + JSON.stringify(loaded.errors[0]));
  return loaded.value.events.filter((e) => e.event === kind).length;
}

function readBridges(cawsDir) {
  return JSON.parse(fs.readFileSync(path.join(cawsDir, 'claims', 'bridge.json'), 'utf8'));
}

// Strip platform identity vars so CAWS_SESSION_ID is the resolver's winning
// tier in tests (the live harness sets DSH_SESSION_ID, which outranks it).
function sessEnv(id) {
  const env = { ...process.env };
  for (const k of ['DSH_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'HOOK_SESSION_ID', 'CURSOR_TRACE_ID']) {
    delete env[k];
  }
  env.CAWS_SESSION_ID = id;
  return env;
}
const SESS_A = sessEnv('sess-a');
const SESS_B = sessEnv('sess-b');

describe('AUTH-BINDING-BRIDGE-001 command surface', () => {
  test('A1: acquire records binding + event; scope admits in-scope via bridged authority', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-901', 'active', ['src/**']);

    const r = claim(root, { spec: 'BR-901', env: SESS_A });
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('bridged BR-901');

    const bridges = readBridges(cawsDir);
    expect(bridges['BR-901'].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(1);

    // In-scope path: bridged authority ADMITs.
    const inScope = scopeShow(root, 'src/foo.ts', SESS_A);
    expect(inScope.json.decision).toBe('admit');
    expect(inScope.json.bindingState).toBe('bridged');
    expect(inScope.json.mode).toBe('authoritative');

    // Out-of-scope path: reject exactly as a worktree binding would.
    const outScope = scopeShow(root, 'docs/readme.md', SESS_A);
    expect(outScope.json.decision).toBe('reject');
    expect(outScope.json.bindingState).toBe('bridged');

    // A DIFFERENT session gets no bridge authority (identity-keyed).
    const otherSession = scopeShow(root, 'src/foo.ts', SESS_B);
    expect(otherSession.json.decision).toBe('no_authority');
  });

  test('A2: spec held by a worktree binding refuses the bridge (subordination)', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-902', 'active', ['src/**']);
    const wtPath = path.join(cawsDir, 'worktrees', 'wt-held');
    fs.mkdirSync(wtPath, { recursive: true });
    writeRegistry(cawsDir, {
      'wt-held': {
        branch: 'wt-held', baseBranch: 'main', specId: 'BR-902', path: wtPath,
        owner: { session_id: 'owner-w', platform: 'claude-code' },
      },
    });

    const r = claim(root, { spec: 'BR-902', env: SESS_A });
    expect(r.code).toBe(1);
    const text = r.err.join('\n');
    expect(text).toContain('held by worktree "wt-held"');
    expect(text).toContain('owner-w');
    expect(fs.existsSync(path.join(cawsDir, 'claims', 'bridge.json'))).toBe(false);
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(0);
  });

  test('A3: foreign acquire soft-blocks; --takeover audits and records', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-903', 'active', ['src/**']);
    expect(claim(root, { spec: 'BR-903', env: SESS_A }).code).toBe(0);

    const foreign = claim(root, { spec: 'BR-903', env: SESS_B });
    expect(foreign.code).toBe(1);
    expect(foreign.err.join('\n')).toContain('sess-a');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(1);

    const t = claim(root, { spec: 'BR-903', env: SESS_B, takeover: true });
    expect(t.code).toBe(0);
    const bridges = readBridges(cawsDir);
    expect(bridges['BR-903'].session_id).toBe('sess-b');
    expect(bridges['BR-903'].prior_owners[0].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'bridge_claim_taken_over')).toBe(1);
  });

  test('A4: named and bare release; foreign release refuses', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-904', 'active', ['src/**']);
    writeSpec(cawsDir, 'BR-905', 'active', ['docs/**']);
    expect(claim(root, { spec: 'BR-904', env: SESS_A }).code).toBe(0);
    expect(claim(root, { spec: 'BR-905', env: SESS_A }).code).toBe(0);

    // Foreign named release refuses.
    expect(claim(root, { spec: 'BR-904', env: SESS_B, release: true }).code).toBe(1);

    // Named release by owner.
    const named = claim(root, { spec: 'BR-904', env: SESS_A, release: true });
    expect(named.code).toBe(0);
    expect(named.out.join(' ')).toContain('BR-904');
    expect(readBridges(cawsDir)['BR-904']).toBeUndefined();
    expect(readBridges(cawsDir)['BR-905'].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'claim_released')).toBe(1);

    // Bare release frees the rest.
    const bare = claim(root, { env: SESS_A, release: true });
    expect(bare.code).toBe(0);
    expect(readBridges(cawsDir)['BR-905']).toBeUndefined();
    expect(countEvents(cawsDir, 'claim_released')).toBe(2);

    // Release-of-nothing refuses.
    expect(claim(root, { env: SESS_A, release: true }).code).toBe(1);
  });

  test('A5: retired bridge confers nothing; closed-spec acquire refuses; prune cleans', () => {
    const { root, cawsDir } = mkRepo();
    // Closed-from-birth with the closure fields the schema demands (a bare
    // closed flip is schema-invalid and loadSpecs drops it).
    writeSpec(cawsDir, 'BR-906', 'active', ['src/**']);
    const specFile906 = path.join(cawsDir, 'specs', 'BR-906.yaml');
    fs.writeFileSync(specFile906, fs.readFileSync(specFile906, 'utf8')
      .replace('lifecycle_state: active', "lifecycle_state: closed\nresolution: abandoned\nclosure_notes: 'fixture: closed at birth for the bridge refusal test'"));
    writeSpec(cawsDir, 'BR-907', 'active', ['lib/**']);
    expect(claim(root, { spec: 'BR-907', env: SESS_A }).code).toBe(0);

    // Closed-spec acquire refuses with the reopen handoff.
    const closed = claim(root, { spec: 'BR-906', env: SESS_A });
    expect(closed.code).toBe(1);
    expect(closed.err.join('\n')).toContain('caws specs reopen BR-906');

    // Simulate a retired binding: bridge an active spec, then close it.
    // (Retire is read-side — we flip the YAML lifecycle directly in the
    // fixture to represent a later spec close by another lane.)
    const specFile = path.join(cawsDir, 'specs', 'BR-907.yaml');
    fs.writeFileSync(specFile, fs.readFileSync(specFile, 'utf8').replace('lifecycle_state: active', 'lifecycle_state: closed'));
    const stale = scopeShow(root, 'lib/foo.ts', SESS_A);
    expect(stale.json.decision).toBe('no_authority'); // retired = no authority

    // Prune lists the ghost; --apply removes it; no events.
    const eventsBefore = countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');
    const dry = (() => {
      const out = []; const err = [];
      const code = runWorktreePruneCommand({
        cwd: root, out: (l) => out.push(l), err: (l) => err.push(l), showData: false,
      });
      return { code, text: out.join('\n') };
    })();
    expect(dry.code).toBe(0);
    expect(dry.text).toContain('bridge ghosts (dry-run)');
    expect(dry.text).toContain('BR-907');
    expect(readBridges(cawsDir)['BR-907']).toBeDefined(); // untouched

    const applied = (() => {
      const out = []; const err = [];
      const code = runWorktreePruneCommand({
        cwd: root, apply: true, out: (l) => out.push(l), err: (l) => err.push(l), showData: false,
      });
      return { code, text: out.join('\n') };
    })();
    expect(applied.code).toBe(0);
    expect(readBridges(cawsDir)['BR-907']).toBeUndefined();
    const eventsAfter = countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');
    expect(eventsAfter).toBe(eventsBefore); // eventless hygiene
  });

  test('A6: status surfaces the bridged binding (observe, read-only)', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-910', 'active', ['src/**']);
    expect(claim(root, { spec: 'BR-910', env: SESS_A }).code).toBe(0);

    const out = []; const err = [];
    const code = runStatusCommand({
      cwd: root,
      env: SESS_A,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('bridged');
    expect(text).toContain('BR-910');
  });

  test('A7: sequential same-session mutations stay consistent (refresh, never partial)', () => {
    const { root, cawsDir } = mkRepo();
    writeSpec(cawsDir, 'BR-911', 'active', ['src/**']);
    for (let i = 0; i < 3; i++) {
      const r = claim(root, { spec: 'BR-911', env: SESS_A });
      expect(r.code).toBe(0);
      const bridges = readBridges(cawsDir);
      expect(bridges['BR-911'].session_id).toBe('sess-a');
      expect(bridges['BR-911'].acquired_at).toBe('2026-08-24T12:00:00.000Z'); // preserved
    }
    // Exactly one event per acquire (refresh also audits claim_bridged).
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(3);
  });
});
