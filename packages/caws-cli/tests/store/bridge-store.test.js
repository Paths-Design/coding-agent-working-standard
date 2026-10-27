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
const { Worker } = require('node:worker_threads');

const {
  loadBridges,
  acquireBridge,
  takeoverBridge,
  releaseBridge,
  pruneBridgeGhosts,
} = require('../../dist/store/bridge-store');
const eventsStore = require('../../dist/store/events-store');
const { loadEvents } = eventsStore;
const atomicWrite = require('../../dist/store/atomic-write');
const { initProject } = require('../../dist/store/init-store');
const { acquireLifecycleLock, releaseLifecycleLock } = require('../../dist/store/lifecycle-lock');
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

function bridgeInput(specId, sessionId = 'sess-a') {
  return {
    ...(specId === undefined ? {} : { specId }),
    session: { session_id: sessionId },
    actor: { kind: 'agent', id: sessionId, session_id: sessionId, platform: 'test' },
    now: NOW(),
    reason: 'explicit test handoff',
  };
}

function eventBytes(cawsDir) {
  return fs.readFileSync(path.join(cawsDir, 'events.jsonl'));
}

// Pause real store calls at filesystem boundaries to force an overlap. The
// first caller has read bridge.json; the second pauses before its first lock
// attempt. A caller that reads before locking will therefore use stale bytes.
// Calls without a lock finish early and are also exposed by the final state.
function bridgeWorker(cawsDir, operation, input, pauseAt) {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `
      const { parentPort, workerData } = require('node:worker_threads');
      const fs = require('node:fs');
      const path = require('node:path');
      const gate = new Int32Array(workerData.gate);
      const bridgePath = path.join(workerData.cawsDir, 'claims', 'bridge.json');
      const lockPath = path.join(workerData.cawsDir, 'state.lock');
      let paused = false;
      function pause() {
        if (paused) return;
        paused = true;
        parentPort.postMessage({ kind: 'paused' });
        if (Atomics.wait(gate, 0, 0, 10000) === 'timed-out') {
          throw new Error('bridge interleaving barrier timed out');
        }
      }
      const read = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        const value = read.call(this, file, ...args);
        if (workerData.pauseAt === 'read' && file === bridgePath) pause();
        return value;
      };
      const open = fs.openSync;
      fs.openSync = function(file, flags, ...args) {
        if (workerData.pauseAt === 'lock' && file === lockPath && flags === 'wx') pause();
        return open.call(this, file, flags, ...args);
      };
      const store = require(workerData.store);
      const input = workerData.input;
      if (input.now !== undefined) input.now = new Date(input.now);
      const result = store[workerData.operation](workerData.cawsDir, input);
      parentPort.postMessage({ kind: 'result', result });
    `,
    {
      eval: true,
      workerData: {
        cawsDir,
        store: require.resolve('../../dist/store/bridge-store'),
        operation,
        input,
        pauseAt,
        gate: gate.buffer,
      },
    }
  );
  let phaseResolve;
  let phaseReject;
  let doneResolve;
  let doneReject;
  const phase = new Promise((resolve, reject) => {
    phaseResolve = resolve;
    phaseReject = reject;
  });
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    doneReject = reject;
  });
  // The caller awaits phase before done; preserve errors without an unhandled
  // rejection during that interval.
  done.catch(() => {});
  let receivedResult = false;
  worker.on('message', (message) => {
    phaseResolve(message.kind);
    if (message.kind === 'result') {
      receivedResult = true;
      doneResolve(message.result);
    }
  });
  worker.on('error', (error) => {
    phaseReject(error);
    doneReject(error);
  });
  worker.on('exit', (code) => {
    if (!receivedResult) {
      const error = new Error(`bridge worker exited ${code} without a result`);
      phaseReject(error);
      doneReject(error);
    }
  });
  return {
    phase,
    done,
    resume() {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
    },
    stop: () => worker.terminate(),
  };
}

async function interleaveBridges(cawsDir, first, second) {
  const a = bridgeWorker(cawsDir, first.operation, first.input, 'read');
  let b;
  try {
    expect(await a.phase).toBe('paused');
    b = bridgeWorker(cawsDir, second.operation, second.input, 'lock');
    await b.phase;
    a.resume();
    const firstResult = await a.done;
    b.resume();
    return [firstResult, await b.done];
  } finally {
    a.resume();
    if (b) b.resume();
    await Promise.all([a.stop(), ...(b ? [b.stop()] : [])]);
  }
}

describe('bridge lifecycle serialization', () => {
  test('concurrent distinct claims preserve both entries and both audit events', async () => {
    const { cawsDir } = mkRepo();
    expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
    const results = await interleaveBridges(
      cawsDir,
      { operation: 'acquireBridge', input: bridgeInput('BR-101') },
      { operation: 'acquireBridge', input: bridgeInput('BR-102', 'sess-b') }
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(Object.keys(readBridges(cawsDir)).sort()).toEqual(['BR-100', 'BR-101', 'BR-102']);
    expect(readBridges(cawsDir)['BR-102'].session_id).toBe('sess-b');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(3);
  });

  test('competing claims read the owner after lock acquisition', async () => {
    const { cawsDir } = mkRepo();
    expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
    const [a, b] = await interleaveBridges(
      cawsDir,
      { operation: 'acquireBridge', input: bridgeInput('BR-101') },
      { operation: 'acquireBridge', input: bridgeInput('BR-101', 'sess-b') }
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(false);
    expect(b.errors[0].rule).toBe('store.claims.bridge_foreign_owner');
    expect(readBridges(cawsDir)['BR-101'].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(2);
  });

  test.each(['named', 'bare'])(
    'a %s release cannot act on ownership predating takeover',
    async (kind) => {
      const { cawsDir } = mkRepo();
      expect(acquireBridge(cawsDir, bridgeInput('BR-101')).ok).toBe(true);
      const [a, b] = await interleaveBridges(
        cawsDir,
        { operation: 'takeoverBridge', input: bridgeInput('BR-101', 'sess-b') },
        { operation: 'releaseBridge', input: bridgeInput(kind === 'named' ? 'BR-101' : undefined) }
      );
      expect(a.ok).toBe(true);
      expect(b.ok).toBe(false);
      expect(b.errors[0].rule).toBe(
        kind === 'named' ? 'store.claims.bridge_foreign_owner' : 'store.lifecycle.plan_rejected'
      );
      expect(readBridges(cawsDir)['BR-101'].session_id).toBe('sess-b');
      expect(countEvents(cawsDir, 'claim_released')).toBe(0);
      expect(countEvents(cawsDir, 'bridge_claim_taken_over')).toBe(1);
    }
  );

  test('competing takeovers preserve the actual prior-owner chain', async () => {
    const { cawsDir } = mkRepo();
    expect(acquireBridge(cawsDir, bridgeInput('BR-101')).ok).toBe(true);
    const [a, b] = await interleaveBridges(
      cawsDir,
      { operation: 'takeoverBridge', input: bridgeInput('BR-101', 'sess-b') },
      { operation: 'takeoverBridge', input: bridgeInput('BR-101', 'sess-c') }
    );
    expect(a).toEqual({ ok: true, value: { priorOwnerSessionId: 'sess-a' } });
    expect(b).toEqual({ ok: true, value: { priorOwnerSessionId: 'sess-b' } });
    const entry = readBridges(cawsDir)['BR-101'];
    expect(entry.session_id).toBe('sess-c');
    expect(entry.prior_owners.map((p) => p.session_id)).toEqual(['sess-a', 'sess-b']);
    expect(countEvents(cawsDir, 'bridge_claim_taken_over')).toBe(2);
  });

  test.each([true, false])(
    'applied pruning and claiming preserve each other (prune first: %s)',
    async (pruneFirst) => {
      const { cawsDir } = mkRepo();
      expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
      const prune = {
        operation: 'pruneBridgeGhosts',
        input: {
          apply: true,
          activeSpecIds: ['BR-101'],
          specStates: { 'BR-100': 'closed', 'BR-101': 'active' },
        },
      };
      const claim = { operation: 'acquireBridge', input: bridgeInput('BR-101', 'sess-b') };
      const results = await interleaveBridges(
        cawsDir,
        ...(pruneFirst ? [prune, claim] : [claim, prune])
      );
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(Object.keys(readBridges(cawsDir))).toEqual(['BR-101']);
      expect(readBridges(cawsDir)['BR-101'].session_id).toBe('sess-b');
      expect(countEvents(cawsDir, 'claim_bridged')).toBe(2);
      expect(countEvents(cawsDir, 'claim_released')).toBe(0);
    }
  );

  test.each(['acquire', 'refresh', 'takeover', 'named release', 'bare release', 'prune'])(
    '%s refuses while the lifecycle lock is held, then succeeds after release',
    (kind) => {
      const { cawsDir } = mkRepo();
      expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
      const calls = {
        acquire: () => acquireBridge(cawsDir, bridgeInput('BR-101')),
        refresh: () => acquireBridge(cawsDir, bridgeInput('BR-100')),
        takeover: () => takeoverBridge(cawsDir, bridgeInput('BR-100', 'sess-b')),
        'named release': () => releaseBridge(cawsDir, bridgeInput('BR-100')),
        'bare release': () => releaseBridge(cawsDir, bridgeInput(undefined)),
        prune: () => pruneBridgeGhosts(cawsDir, { apply: true, activeSpecIds: [], specStates: {} }),
      };
      const beforeBridge = fs.readFileSync(bridgeFile(cawsDir));
      const beforeEvents = eventBytes(cawsDir);
      const held = acquireLifecycleLock(cawsDir);
      expect(held.ok).toBe(true);
      try {
        const result = calls[kind]();
        expect(result.ok).toBe(false);
        expect(result.errors[0].rule).toBe('store.lifecycle.lock_contention');
        expect(fs.readFileSync(bridgeFile(cawsDir))).toEqual(beforeBridge);
        expect(eventBytes(cawsDir)).toEqual(beforeEvents);
      } finally {
        releaseLifecycleLock(held.value);
      }
      expect(calls[kind]().ok).toBe(true);
      expect(fs.existsSync(path.join(cawsDir, 'state.lock'))).toBe(false);
    }
  );

  test('prune preview remains read-only while a lifecycle lock is held', () => {
    const { cawsDir } = mkRepo();
    expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
    const beforeBridge = fs.readFileSync(bridgeFile(cawsDir));
    const beforeEvents = eventBytes(cawsDir);
    const held = acquireLifecycleLock(cawsDir);
    expect(held.ok).toBe(true);
    try {
      const preview = pruneBridgeGhosts(cawsDir, {
        apply: false,
        activeSpecIds: [],
        specStates: {},
      });
      expect(preview.ok).toBe(true);
      expect(preview.value.candidates).toEqual([
        { specId: 'BR-100', holderSessionId: 'sess-a', reason: 'spec-missing' },
      ]);
      expect(preview.value.removed).toEqual([]);
      expect(fs.readFileSync(bridgeFile(cawsDir))).toEqual(beforeBridge);
      expect(eventBytes(cawsDir)).toEqual(beforeEvents);
      expect(fs.existsSync(held.value.lockPath)).toBe(true);
    } finally {
      releaseLifecycleLock(held.value);
    }
  });

  test.each(['acquireBridge', 'takeoverBridge', 'releaseBridge'])(
    '%s reports recovered event failure without publishing success or retaining the lock',
    (operation) => {
      const { cawsDir } = mkRepo();
      expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
      const beforeBridge = fs.readFileSync(bridgeFile(cawsDir));
      const beforeEvents = eventBytes(cawsDir);
      const event = {
        acquireBridge: 'claim_bridged',
        takeoverBridge: 'bridge_claim_taken_over',
        releaseBridge: 'claim_released',
      }[operation];
      const input =
        operation === 'acquireBridge'
          ? bridgeInput('BR-101')
          : bridgeInput('BR-100', operation === 'takeoverBridge' ? 'sess-b' : 'sess-a');
      const store = { acquireBridge, takeoverBridge, releaseBridge };
      const previous = process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT;
      const write = atomicWrite.writeFileAtomic;
      const lockDuringWrites = [];
      const writeSpy = jest
        .spyOn(atomicWrite, 'writeFileAtomic')
        .mockImplementation((file, ...args) => {
          if (file === bridgeFile(cawsDir)) {
            lockDuringWrites.push(fs.existsSync(path.join(cawsDir, 'state.lock')));
          }
          return write(file, ...args);
        });
      process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT = JSON.stringify({
        eventMatch: event,
        cause: 'bridge test append failure',
      });
      try {
        const result = store[operation](cawsDir, input);
        expect(result.ok).toBe(false);
        expect(result.errors[0].message).toContain('bridge test append failure');
        expect(fs.readFileSync(bridgeFile(cawsDir))).toEqual(beforeBridge);
        expect(eventBytes(cawsDir)).toEqual(beforeEvents);
        expect(lockDuringWrites).toEqual([true, true]); // mutation and rollback
        expect(fs.existsSync(path.join(cawsDir, 'state.lock'))).toBe(false);
      } finally {
        writeSpy.mockRestore();
        if (previous === undefined) delete process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT;
        else process.env.CAWS_TEST_INJECT_LIFECYCLE_FAULT = previous;
      }
      expect(store[operation](cawsDir, input).ok).toBe(true);
    }
  );

  test('bare release reports partial audit failure and restores registry bytes under the lock', () => {
    const { cawsDir } = mkRepo();
    expect(acquireBridge(cawsDir, bridgeInput('BR-100')).ok).toBe(true);
    expect(acquireBridge(cawsDir, bridgeInput('BR-101')).ok).toBe(true);
    const beforeBridge = fs.readFileSync(bridgeFile(cawsDir));
    const append = eventsStore.appendEvent;
    let releases = 0;
    const appendSpy = jest
      .spyOn(eventsStore, 'appendEvent')
      .mockImplementation((dir, event, ...args) => {
        if (event.event === 'claim_released' && ++releases === 2) {
          return {
            ok: false,
            errors: [
              {
                severity: 'error',
                rule: 'store.events.append_failed',
                message: 'second release event failed',
              },
            ],
          };
        }
        return append(dir, event, ...args);
      });
    try {
      const result = releaseBridge(cawsDir, bridgeInput(undefined));
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.lifecycle.partial_failure_unrecovered');
      expect(result.errors[0].data.already_appended).toHaveLength(1);
      expect(result.errors[0].data.rolled_back).toEqual([bridgeFile(cawsDir)]);
      expect(result.errors[0].data.rollback_failed).toEqual([]);
      expect(fs.readFileSync(bridgeFile(cawsDir))).toEqual(beforeBridge);
      expect(countEvents(cawsDir, 'claim_released')).toBe(1);
      expect(fs.existsSync(path.join(cawsDir, 'state.lock'))).toBe(false);
    } finally {
      appendSpy.mockRestore();
    }
  });
});

describe('bridge-store (AUTH-BINDING-BRIDGE-001)', () => {
  test('A1: acquire pairs bridge.json + claim_bridged; owner re-acquire refreshes', () => {
    const { cawsDir } = mkRepo();
    expect(loadBridges(cawsDir).value.present).toBe(false); // absent = empty

    const r = acquireBridge(cawsDir, {
      specId: 'BR-001',
      session: { session_id: 'sess-a', platform: 'test' },
      actor: ACTOR,
      now: NOW(),
      contextCwd: '/repo',
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
      specId: 'BR-001',
      session: { session_id: 'sess-a', platform: 'test' },
      actor: ACTOR,
      now: new Date('2026-08-24T13:00:00.000Z'),
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
      specId: 'BR-002',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });

    const foreign = acquireBridge(cawsDir, {
      specId: 'BR-002',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.errors[0].rule).toBe('store.claims.bridge_foreign_owner');
    expect(countEvents(cawsDir, 'claim_bridged')).toBe(1); // unchanged

    const t = takeoverBridge(cawsDir, {
      specId: 'BR-002',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
      reason: 'handoff: A finished scouting',
    });
    expect(t.ok).toBe(true);
    expect(t.value.priorOwnerSessionId).toBe('sess-a');
    const bridges = readBridges(cawsDir);
    expect(bridges['BR-002'].session_id).toBe('sess-b');
    expect(bridges['BR-002'].prior_owners).toHaveLength(1);
    expect(bridges['BR-002'].prior_owners[0].session_id).toBe('sess-a');
    expect(countEvents(cawsDir, 'bridge_claim_taken_over')).toBe(1);

    const self = takeoverBridge(cawsDir, {
      specId: 'BR-002',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
      reason: 'x',
    });
    expect(self.ok).toBe(false);
    const nothing = takeoverBridge(cawsDir, {
      specId: 'BR-404',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
      reason: 'x',
    });
    expect(nothing.ok).toBe(false);
  });

  test('A3: named and bare release semantics', () => {
    const { cawsDir } = mkRepo();
    acquireBridge(cawsDir, {
      specId: 'BR-003',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    acquireBridge(cawsDir, {
      specId: 'BR-004',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    acquireBridge(cawsDir, {
      specId: 'BR-005',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
    });

    // Foreign named release refuses.
    const foreign = releaseBridge(cawsDir, {
      specId: 'BR-003',
      session: { session_id: 'sess-b' },
      actor: ACTOR_B,
      now: NOW(),
    });
    expect(foreign.ok).toBe(false);

    // Named release by owner.
    const named = releaseBridge(cawsDir, {
      specId: 'BR-003',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    expect(named.ok).toBe(true);
    expect(named.value.released).toEqual(['BR-003']);
    expect(readBridges(cawsDir)['BR-003']).toBeUndefined();
    expect(countEvents(cawsDir, 'claim_released')).toBe(1);

    // Bare release frees every OWNED binding (BR-004, not BR-005).
    const bare = releaseBridge(cawsDir, {
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    expect(bare.ok).toBe(true);
    expect(bare.value.released.sort()).toEqual(['BR-004']);
    expect(readBridges(cawsDir)['BR-005'].session_id).toBe('sess-b');
    expect(countEvents(cawsDir, 'claim_released')).toBe(2);

    // Release-of-nothing refuses.
    const none = releaseBridge(cawsDir, {
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    expect(none.ok).toBe(false);
  });

  test('A4: prune — retired bridges are candidates; dry-run default; no events', () => {
    const { cawsDir } = mkRepo();
    // Canonical spec-id pattern (numeric tail) — the events chain enforces it.
    acquireBridge(cawsDir, {
      specId: 'BR-006',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    }); // closed
    acquireBridge(cawsDir, {
      specId: 'BR-007',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    }); // missing
    acquireBridge(cawsDir, {
      specId: 'BR-008',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    }); // archived
    acquireBridge(cawsDir, {
      specId: 'BR-009',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    }); // active
    const eventsBefore =
      countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');

    const specStates = { 'BR-006': 'closed', 'BR-008': 'archived', 'BR-009': 'active' }; // BR-007 missing
    const dry = pruneBridgeGhosts(cawsDir, { activeSpecIds: ['BR-009'], specStates, apply: false });
    expect(dry.ok).toBe(true);
    expect(dry.value.candidates.map((c) => c.specId).sort()).toEqual([
      'BR-006',
      'BR-007',
      'BR-008',
    ]);
    expect(dry.value.removed).toEqual([]);
    expect(Object.keys(readBridges(cawsDir)).sort()).toEqual([
      'BR-006',
      'BR-007',
      'BR-008',
      'BR-009',
    ]); // untouched

    const applied = pruneBridgeGhosts(cawsDir, {
      activeSpecIds: ['BR-009'],
      specStates,
      apply: true,
    });
    expect(applied.ok).toBe(true);
    expect(applied.value.removed.sort()).toEqual(['BR-006', 'BR-007', 'BR-008']);
    expect(Object.keys(readBridges(cawsDir))).toEqual(['BR-009']);
    const eventsAfter =
      countEvents(cawsDir, 'claim_released') + countEvents(cawsDir, 'claim_bridged');
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
      specId: 'BR-006',
      session: { session_id: 'sess-a' },
      actor: ACTOR,
      now: NOW(),
    });
    expect(acquire.ok).toBe(false); // fail closed — no mutation off a corrupt store
  });
});
