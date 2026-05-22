/**
 * Tests for rotateEvents — CAWS-MIGRATE-V10-EVENTS-001 A5/A6/A7/A8.
 *
 * Covers:
 *   A6  happy path: rotation against a 3-line v10-shape events.jsonl
 *       produces a 1-line new chain (chain_rotated genesis) and an
 *       archive file containing the original 3 lines byte-for-byte.
 *   A7  refusal: empty / missing events.jsonl returns
 *       EVENTS_ROTATE_NOTHING_TO_ROTATE; no archive created.
 *   A8  refusal: clean v11 chain without allowClean returns
 *       EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN; admitted with
 *       allowClean: true.
 *   Doctrine: rotateEvents goes through prepareAppend(null, body) and
 *       therefore through validateEventBody. Proven by injecting a
 *       (deliberately) impossible reason value and asserting the kernel
 *       diagnostic surfaces under EVENTS_PREPARE_APPEND_REJECTED.
 *   Atomicity: the lock file does not persist after the function
 *       returns; the new genesis line is fsynced before lock release
 *       (asserted by happy-path file content + lock absence).
 *
 * The test imports from ../../dist/store, matching the established
 * convention in tests/store/events-store.test.js. Prerequisite: the CLI
 * dist must be built before this test runs.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  appendEvent,
  loadEvents,
  rotateEvents,
  STORE_RULES,
} = require('../../dist/store');

function mkTempCawsDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-events-rotate-'));
}

const ACTOR = { kind: 'agent', id: 'darian', session_id: 'sess-rotate-test' };
const FIXED_DATE = new Date('2026-05-22T23:15:00.000Z');

function readArchiveFiles(cawsDir) {
  return fs
    .readdirSync(cawsDir)
    .filter((f) => f.startsWith('events.jsonl.archive-'));
}

function sha256OfFile(filePath) {
  return (
    'sha256:' +
    crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  );
}

// ──────────────────────────────────────────────────────────────────────
// A6 — happy path
// ──────────────────────────────────────────────────────────────────────

describe('rotateEvents — A6 happy path against v10-shape events.jsonl', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('produces archive + 1-line new chain with the full chain_rotated payload', () => {
    cawsDir = mkTempCawsDir();
    const eventsPath = path.join(cawsDir, 'events.jsonl');

    // Hand-author a 3-line v10-shape events.jsonl (actor as string).
    // The lines do NOT need to chain-verify — rotateEvents uses a
    // tolerant scan, not validateChainedEvent.
    const v10Line = (seq, prev) =>
      JSON.stringify({
        seq,
        ts: '2026-04-11T01:00:00.000Z',
        session_id: 'standalone',
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'X-1',
        data: { passed: true },
        prev_hash: prev,
        event_hash: 'sha256:' + String(seq).padStart(64, '0'),
      });
    const lines = [
      v10Line(1, ''),
      v10Line(2, 'sha256:' + '1'.padStart(64, '0')),
      v10Line(3, 'sha256:' + '2'.padStart(64, '0')),
    ];
    const originalBytes = lines.join('\n') + '\n';
    fs.writeFileSync(eventsPath, originalBytes);
    const originalSha = sha256OfFile(eventsPath);

    const r = rotateEvents(cawsDir, {
      reason: 'v10 to v11 migration smoke',
      actor: ACTOR,
      now: FIXED_DATE,
    });

    expect(r.ok).toBe(true);
    expect(r.errors).toBeUndefined();

    // The new events.jsonl is the genesis chain_rotated event, exactly
    // one line.
    const newContent = fs.readFileSync(eventsPath, 'utf8');
    const newLines = newContent.split('\n').filter((l) => l.length > 0);
    expect(newLines).toHaveLength(1);
    const genesis = JSON.parse(newLines[0]);
    expect(genesis.event).toBe('chain_rotated');
    expect(genesis.seq).toBe(1);
    // Genesis events have prev_hash === null per the kernel's prepareAppend
    // contract (prepare.ts:59-61: null prev → seq=1, prevHash=null).
    expect(genesis.prev_hash).toBeNull();
    expect(genesis.actor).toEqual(ACTOR);

    // Archive exists, byte-equals original.
    const archives = readArchiveFiles(cawsDir);
    expect(archives).toHaveLength(1);
    const archivePath = path.join(cawsDir, archives[0]);
    expect(sha256OfFile(archivePath)).toBe(originalSha);
    expect(fs.readFileSync(archivePath).equals(Buffer.from(originalBytes))).toBe(
      true
    );

    // chain_rotated payload reflects the actual rotation.
    const data = genesis.data;
    expect(data.prior_line_count).toBe(3);
    expect(data.prior_chain_status).toBe('parseable_unverified');
    expect(data.actor_shape_stats).toEqual({
      v10_string_actor: 3,
      v11_object_actor: 0,
      unparseable: 0,
    });
    expect(data.prior_file_path).toBe(archives[0]);
    expect(data.prior_file_digest).toBe(originalSha);
    expect(data.migration_reason).toBe('v10 to v11 migration smoke');
    expect(data.prior_tail_hash).toBe(
      'sha256:' + String(3).padStart(64, '0')
    );
    expect(data.prior_seq).toBe(3);

    // Archive name uses windows-safe ISO (no colons or dots in the
    // timestamp portion). FIXED_DATE = 2026-05-22T23:15:00.000Z →
    // 2026-05-22T23-15-00-000Z
    expect(archives[0]).toBe(
      'events.jsonl.archive-2026-05-22T23-15-00-000Z'
    );

    // Lock file does not persist.
    expect(fs.existsSync(eventsPath + '.lock')).toBe(false);
  });

  it('the new chain is appendable — loadEvents + appendEvent work normally', () => {
    cawsDir = mkTempCawsDir();
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    fs.writeFileSync(
      eventsPath,
      JSON.stringify({
        seq: 1,
        ts: '2026-04-11T01:00:00.000Z',
        session_id: 'standalone',
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'X-1',
        data: { passed: true },
        prev_hash: '',
        event_hash: 'sha256:' + '0'.padStart(64, '0'),
      }) + '\n'
    );

    const rotated = rotateEvents(cawsDir, {
      reason: 'smoke',
      actor: ACTOR,
      now: FIXED_DATE,
    });
    expect(rotated.ok).toBe(true);

    // loadEvents now sees a clean chain (the genesis chain_rotated event).
    const loaded = loadEvents(cawsDir);
    expect(loaded.ok).toBe(true);
    expect(loaded.value.events).toHaveLength(1);
    expect(loaded.value.events[0].event).toBe('chain_rotated');

    // appendEvent works against the new chain.
    const appended = appendEvent(cawsDir, {
      event: 'spec_created',
      ts: '2026-05-22T23:20:00.000Z',
      actor: ACTOR,
      spec_id: 'NEW-1',
      data: {
        title: 'After-rotation test',
        risk_tier: 3,
        mode: 'chore',
        lifecycle_state: 'draft',
      },
    });
    expect(appended.ok).toBe(true);
    expect(appended.value.seq).toBe(2);
    expect(appended.value.prev_hash).toBe(rotated.value.event_hash);
  });
});

// ──────────────────────────────────────────────────────────────────────
// A7 — refusal: nothing to rotate
// ──────────────────────────────────────────────────────────────────────

describe('rotateEvents — A7 refusal: nothing to rotate', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('refuses when events.jsonl does not exist', () => {
    cawsDir = mkTempCawsDir();
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    expect(fs.existsSync(eventsPath)).toBe(false);

    const r = rotateEvents(cawsDir, { reason: 'noop', actor: ACTOR });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.EVENTS_ROTATE_NOTHING_TO_ROTATE);
    expect(r.errors[0].data.code).toBe('ENOENT');

    // No archive created.
    expect(readArchiveFiles(cawsDir)).toEqual([]);
    expect(fs.existsSync(eventsPath + '.lock')).toBe(false);
  });

  it('refuses when events.jsonl is empty', () => {
    cawsDir = mkTempCawsDir();
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    fs.writeFileSync(eventsPath, '');

    const r = rotateEvents(cawsDir, { reason: 'noop', actor: ACTOR });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(STORE_RULES.EVENTS_ROTATE_NOTHING_TO_ROTATE);
    expect(r.errors[0].data.size).toBe(0);

    // File is unchanged, no archive created.
    expect(fs.readFileSync(eventsPath, 'utf8')).toBe('');
    expect(readArchiveFiles(cawsDir)).toEqual([]);
    expect(fs.existsSync(eventsPath + '.lock')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// A8 — refusal: clean v11 chain without allowClean
// ──────────────────────────────────────────────────────────────────────

describe('rotateEvents — A8 friction flag for clean v11 chain', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  function appendCleanV11Chain(cawsDir) {
    const events = [];
    for (let i = 0; i < 2; i++) {
      const r = appendEvent(cawsDir, {
        event: 'spec_created',
        ts: `2026-05-22T10:0${i}:00.000Z`,
        actor: ACTOR,
        spec_id: `X-${i + 1}`,
        data: {
          title: `clean v11 ${i}`,
          risk_tier: 3,
          mode: 'chore',
          lifecycle_state: 'draft',
        },
      });
      expect(r.ok).toBe(true);
      events.push(r.value);
    }
    return events;
  }

  it('refuses a clean v11 chain when allowClean is omitted', () => {
    cawsDir = mkTempCawsDir();
    appendCleanV11Chain(cawsDir);

    const r = rotateEvents(cawsDir, { reason: 'casual', actor: ACTOR });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(
      STORE_RULES.EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN
    );
    expect(r.errors[0].data.actor_shape_stats).toEqual({
      v10_string_actor: 0,
      v11_object_actor: 2,
      unparseable: 0,
    });

    // No archive created; events.jsonl untouched.
    expect(readArchiveFiles(cawsDir)).toEqual([]);
    const stillThere = loadEvents(cawsDir);
    expect(stillThere.ok).toBe(true);
    expect(stillThere.value.events).toHaveLength(2);
  });

  it('refuses a clean v11 chain when allowClean is explicitly false', () => {
    cawsDir = mkTempCawsDir();
    appendCleanV11Chain(cawsDir);

    const r = rotateEvents(cawsDir, {
      reason: 'casual',
      actor: ACTOR,
      allowClean: false,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe(
      STORE_RULES.EVENTS_ROTATE_CLEAN_CHAIN_REQUIRES_ALLOW_CLEAN
    );
  });

  it('admits a clean v11 chain when allowClean: true is passed', () => {
    cawsDir = mkTempCawsDir();
    const original = appendCleanV11Chain(cawsDir);

    const r = rotateEvents(cawsDir, {
      reason: 'operator chose to rotate clean chain',
      actor: ACTOR,
      allowClean: true,
      now: FIXED_DATE,
    });
    expect(r.ok).toBe(true);
    expect(r.value.event).toBe('chain_rotated');
    expect(r.value.data.actor_shape_stats).toEqual({
      v10_string_actor: 0,
      v11_object_actor: 2,
      unparseable: 0,
    });
    expect(r.value.data.prior_chain_status).toBe('parseable_unverified');
    expect(r.value.data.prior_tail_hash).toBe(original[1].event_hash);

    // Archive exists.
    expect(readArchiveFiles(cawsDir)).toHaveLength(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// Doctrine: rotateEvents validates through the kernel pipeline
// ──────────────────────────────────────────────────────────────────────

describe('rotateEvents — doctrine: validates via prepareAppend → validateEventBody', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('returns EVENTS_PREPARE_APPEND_REJECTED when the body would be malformed', () => {
    // The function constructs migration_reason from opts.reason verbatim.
    // The chain_rotated schema requires migration_reason: string, minLength 1.
    // Passing reason: '' triggers a kernel-layer schema rejection, NOT an
    // ad-hoc store check. This proves the body actually flows through
    // prepareAppend → validateEventBody (doctrine compliance for
    // invariant 14: rotateEvents validates via the kernel pipeline,
    // not via hand-built diagnostics).
    cawsDir = mkTempCawsDir();
    const eventsPath = path.join(cawsDir, 'events.jsonl');
    fs.writeFileSync(
      eventsPath,
      JSON.stringify({
        seq: 1,
        ts: '2026-04-11T01:00:00.000Z',
        session_id: 'standalone',
        actor: 'cli',
        event: 'validation_completed',
        spec_id: 'X-1',
        data: { passed: true },
        prev_hash: '',
        event_hash: 'sha256:' + '0'.padStart(64, '0'),
      }) + '\n'
    );

    const r = rotateEvents(cawsDir, { reason: '', actor: ACTOR });
    expect(r.ok).toBe(false);
    // Wrapped by the store under EVENTS_PREPARE_APPEND_REJECTED; the
    // original kernel rule is preserved in data.source_rule.
    const rules = r.errors.map((e) => e.rule);
    expect(rules).toContain(STORE_RULES.EVENTS_PREPARE_APPEND_REJECTED);
    const sourceRules = r.errors
      .map((e) => e.data && e.data.source_rule)
      .filter(Boolean);
    expect(sourceRules.length).toBeGreaterThan(0);
    // The source rule is from the kernel evidence module.
    expect(sourceRules.some((s) => s.startsWith('evidence.'))).toBe(true);

    // CRITICAL: no archive was created. The doctrine point is that
    // kernel validation happens BEFORE any filesystem mutation.
    expect(readArchiveFiles(cawsDir)).toEqual([]);
    // events.jsonl is unchanged (the original line is still there).
    const stillRaw = fs.readFileSync(eventsPath, 'utf8');
    expect(stillRaw.includes('validation_completed')).toBe(true);
    expect(fs.existsSync(eventsPath + '.lock')).toBe(false);
  });
});
