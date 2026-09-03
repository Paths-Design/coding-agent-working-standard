'use strict';

/**
 * Store-level contract tests for AUTH-BINDING-BRIDGE-001 — the bridge
 * substrate before the command layer composes it.
 *
 * A1: acquire writes bridge.json + claim_bridged in one transaction; re-acquire
 *     by the owner refreshes last_seen (no second event spam beyond the audit
 *     append).
 * A2: foreign acquire refuses (typed BRIDGE_FOREIGN_OWNER rule); no state, no
 *     event. Takeover rewrites holder, keeps prior_owners audit on the entry,
 *     appends bridge_claim_taken_over with the prior owner. Self-takeover and
 *     takeover-of-nothing refuse.
 * A3: named release removes exactly one binding + claim_released(scope:named);
 *     bare release removes every owned binding + one event each; foreign
 *     release refuses; release-of-nothing refuses.
 * A4: retire/prune — candidates for spec-missing/closed/archived; dry-run
 *     default mutates nothing; --apply removes; no events appended (retired
 *     hygiene; the audit trail is spec_closed/spec_archived).
 * A5: malformed bridge.json fails closed (BRIDGE_FILE_INVALID); absent file is
 *     the empty registry.
 *
 * SUT: dist/store (npm run build compiles first).
 */

const fs = require('fs');
const path = require('path');

const {
  loadBridges,
  acquireBridge,
  takeoverBridge,
  releaseBridge,
  pruneBridgeGhosts,
} = require('../../dist/store/bridge-store');
const { loadEvents } = require('../../dist/store/events-store');
const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  return { root, cawsDir: path.join(root, '.caws') };
}

function bridgeFile(cawsDir) {
  return path.join(cawsDir, 'claims', 'bridge.json');
}

function readBridges(cawsDir) {
  return JSON.parse(fs.readFileSync(bridgeFile(cawsDir), 'utf8'));
}

function countEvents(cawsDir, kind) {
  const loaded = loadEvents(cawsDir);
  if (!loaded.ok) throw new Error('loadEvents failed');
  return loaded.value.events.filter((e) => e.event === kind).length;
}

const ACTOR = { kind: 'agent', id: 'sess-a', session_id: 'sess-a', platform: 'test' };
const ACTOR_B = { kind: 'agent', id: 'sess-b', session_id: 'sess-b', platform: 'test' };
const NOW = () => new Date('2026-08-24T12:00:00.000Z');

describe('bridge-store (AUTH-BINDING-BRIDGE-001)', () => {
  test('A1: acquire pairs bridge.json + claim_bridged; owner re-acquire refreshes', () => {
    const { cawsDir } = mkRepo();
    expect(loadBridges(cawsDir).value.present).toBe(false); // absent = empty

    const r = acquireBridge(cawsDir, {
      specId: 'BR-001', session: { session_id: 'sess-a', platform: 'test' },
      actor: ACTOR, now: NOW(), contextCwd: '/repo',
    });
    expect(r.ok).toBe(true);
    expect(r.value.refreshed).toBe(false);

    const bridges = readBridges(cawsDir);
    expect(bridges['BR-001'].session_id).toBe('sess-a');
    expect(bridges['BR-001'].acquired_at).toBe('2026-08-24T12:00:00.000Z');
    expect(bridges['BR-001'].context_cwd).toBe('/repo');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(1);

    // Owner re-acquire: refresh, not a second holder.
    const r2 = acquireBridge(cawsDir, {
      specId: 'BR-001', session: { session_id: 'sess-a', platform: 'test' },
      actor: ACTOR, now: new Date('2026-08-24T13:00:00.000Z'),
    });
    expect(r2.ok).toBe(true);
    expect(r2.value.refreshed).toBe(true);
    const bridges2 = readBridges(cawsDir);
    expect(bridges2['BR-001'].last_seen).toBe('2026-08-24T13:00:00.000Z');
    expect(bridges2['BR-001'].acquired_at).toBe('2026-08-24T12:00:00.000Z'); // preserved
  });

  test('A2: foreign acquire refuses; takeover audits; self/nothing takeovers refuse', () => {
    const { cawsDir } = mkRepo();
    acquireBridge(cawsDir, {
      specId: 'BR-002', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW(),
    });

    const foreign = acquireBridge(cawsDir, {
      specId: 'BR-002', session: { session_id: 'sess-b' }, actor: ACTOR_B, now: NOW(),
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.errors[0].rule).toBe('store.claims.bridge_foreign_owner');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(1); // unchanged

    const t = takeoverBridge(cawsDir, {
      specId: 'BR-002', session: { session_id: 'sess-b' }, actor: ACTOR_B,
      now: NOW(), reason: 'handoff: A finished scouting',
    });
    expect(t.ok).toBe(true);
    expect(t.value.priorOwnerSessionId).toBe('sess-a');
    const bridges = readBridges(cawsDir);
    expect(bridges['BR-002'].session_id).toBe('sess-b');
    expect(bridges['BR-002'].prior_owners).toHaveLength(1);
    expect(bridges['BR-002'].prior_owners[0].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'bridge_claim_taken_over')).toBe(1);

    const self = takeoverBridge(cawsDir, {
      specId: 'BR-002', session: { session_id: 'sess-b' }, actor: ACTOR_B,
      now: NOW(), reason: 'x',
    });
    expect(self.ok).toBe(false);
    const nothing = takeoverBridge(cawsDir, {
      specId: 'BR-404', session: { session_id: 'sess-b' }, actor: ACTOR_B,
      now: NOW(), reason: 'x',
    });
    expect(nothing.ok).toBe(false);
  });

  test('A3: named and bare release semantics', () => {
    const { cawsDir } = mkRepo();
    acquireBridge(cawsDir, { specId: 'BR-003', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() });
    acquireBridge(cawsDir, { specId: 'BR-004', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() });
    acquireBridge(cawsDir, { specId: 'BR-005', session: { session_id: 'sess-b' }, actor: ACTOR_B, now: NOW() });

    // Foreign named release refuses.
    const foreign = releaseBridge(cawsDir, {
      specId: 'BR-003', session: { session_id: 'sess-b' }, actor: ACTOR_B, now: NOW(),
    });
    expect(foreign.ok).toBe(false);

    // Named release by owner.
    const named = releaseBridge(cawsDir, {
      specId: 'BR-003', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW(),
    });
    expect(named.ok).toBe(true);
    expect(named.value.released).toEqual(['BR-003']);
    expect(readBridges(cawsDir)['BR-003']).toBeUndefined();
    expect(countEvents(cawsDir, 'claim_released')).toBe(1);

    // Bare release frees every OWNED binding (BR-004, not BR-005).
    const bare = releaseBridge(cawsDir, {
      session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW(),
    });
    expect(bare.ok).toBe(true);
    expect(bare.value.released.sort()).toEqual(['BR-004']);
    expect(readBridges(cawsDir)['BR-005'].session_id).toBe('sess-b');
    expect(countEvents(cawsDir, 'claim_released')).toBe(2);

    // Release-of-nothing refuses.
    const none = releaseBridge(cawsDir, {
      session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW(),
    });
    expect(none.ok).toBe(false);
  });

  test('A4: prune — retired bridges are candidates; dry-run default; no events', () => {
    const { cawsDir } = mkRepo();
    // Canonical spec-id pattern (numeric tail) — the events chain enforces it.
    acquireBridge(cawsDir, { specId: 'BR-006', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() }); // closed
    acquireBridge(cawsDir, { specId: 'BR-007', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() }); // missing
    acquireBridge(cawsDir, { specId: 'BR-008', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() }); // archived
    acquireBridge(cawsDir, { specId: 'BR-009', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW() }); // active
    const eventsBefore = countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');

    const specStates = { 'BR-006': 'closed', 'BR-008': 'archived', 'BR-009': 'active' }; // BR-007 missing
    const dry = pruneBridgeGhosts(cawsDir, { activeSpecIds: ['BR-009'], specStates, apply: false });
    expect(dry.ok).toBe(true);
    expect(dry.value.candidates.map((c) => c.specId).sort()).toEqual(['BR-006', 'BR-007', 'BR-008']);
    expect(dry.value.removed).toEqual([]);
    expect(Object.keys(readBridges(cawsDir)).sort()).toEqual(['BR-006', 'BR-007', 'BR-008', 'BR-009']); // untouched

    const applied = pruneBridgeGhosts(cawsDir, { activeSpecIds: ['BR-009'], specStates, apply: true });
    expect(applied.ok).toBe(true);
    expect(applied.value.removed.sort()).toEqual(['BR-006', 'BR-007', 'BR-008']);
    expect(Object.keys(readBridges(cawsDir))).toEqual(['BR-009']);
    const eventsAfter = countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');
    expect(eventsAfter).toBe(eventsBefore); // hygiene appends nothing
  });

  test('A5: malformed bridge.json fails closed; absent is empty', () => {
    const { cawsDir } = mkRepo();
    fs.mkdirSync(path.join(cawsDir, 'claims'), { recursive: true });
    fs.writeFileSync(bridgeFile(cawsDir), '{not json');
    const bad = loadBridges(cawsDir);
    expect(bad.ok).toBe(false);
    expect(bad.errors[0].rule).toBe('store.claims.bridge_file_invalid');
    const acquire = acquireBridge(cawsDir, {
      specId: 'BR-006', session: { session_id: 'sess-a' }, actor: ACTOR, now: NOW(),
    });
    expect(acquire.ok).toBe(false); // fail closed — no mutation off a corrupt store
  });
});
