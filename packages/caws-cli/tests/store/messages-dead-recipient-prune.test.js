'use strict';

/**
 * CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01 — store-level selector
 * semantics for `caws message prune --status undelivered-to-dead-session`.
 *
 * Proves against the REAL ledger + lease files (no mocks):
 *   A1 — no-lease and stale-heartbeat recipients, past the floor, are
 *        candidates (reason recipient-dead); the plan reports the floor.
 *   A2 — live and idle (stopped + fresh heartbeat) recipients are never
 *        selected (deliver-once holds for anyone who could consume).
 *   A3 — the retention floor skips newer messages; an explicit --older-than-ms
 *        (including 0) overrides it.
 *   A4 — a message reserved by an unexpired offer is skipped (offer-pending).
 *   A5 — apply archives lines with a selector-bearing marker BEFORE the
 *        rewrite, removes exactly the candidates, preserves every other line
 *        byte-identically, and removes fully-pruned offers.
 *   A7 — a lease-registry load failure fails the plan closed.
 *   A8 — a delivered message to a dead recipient is never selected here
 *        (reason delivered; that is the delivered selector's subject).
 *
 * SUT loaded from dist/. cawsDir per-test under os.tmpdir().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pruneMessages, channelId } = require('../../dist/store/messages-store');

const DAY_MS = 24 * 60 * 60 * 1000;
const FLOOR_7D = 7 * DAY_MS;

const dirs = [];
function cawsDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-msg-dead-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Write a lease with the given status and heartbeat age. */
function makeLease(caws, sessionId, status, ageMs) {
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sessionId,
      platform: 'test',
      status,
      last_active: new Date(Date.now() - ageMs).toISOString(),
      repo_root: caws,
    })
  );
}

const sender = { kind: 'agent', id: 'sender-1', session_id: 'sender-1', platform: 'test' };

/** Append a message record with a controlled age (default: 10d, past the floor). */
function writeMessage(caws, { id, to, ageDays = 10, text = id }) {
  const line = {
    record: 'message',
    id,
    actor: sender,
    to,
    channel: channelId('sender-1', to),
    text,
    ts: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
  };
  fs.appendFileSync(path.join(caws, 'messages.jsonl'), JSON.stringify(line) + '\n');
  return line;
}

/** Append an unexpired auto-offer reserving `ids` for `recipient`. */
function writeOffer(caws, { offerId, recipient, ids, ttlMs = 60_000 }) {
  const now = Date.now();
  const line = {
    record: 'offer',
    offer_id: offerId,
    recipient,
    deliver_ids: ids,
    ts: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    mode: 'auto',
  };
  fs.appendFileSync(path.join(caws, 'messages.jsonl'), JSON.stringify(line) + '\n');
  return line;
}

function appendDelivery(caws, deliverId) {
  fs.appendFileSync(
    path.join(caws, 'messages.jsonl'),
    JSON.stringify({
      record: 'delivery',
      deliver_id: deliverId,
      receipt: 'poll',
      ts: new Date().toISOString(),
    }) + '\n'
  );
}

function liveLines(caws) {
  return fs.readFileSync(path.join(caws, 'messages.jsonl'), 'utf8').split('\n').filter(Boolean);
}

function plan(caws, extra = {}) {
  const options = {
    status: 'undelivered-to-dead-session',
    ...extra,
  };
  const ledger = path.join(caws, 'messages.jsonl');
  const before = fs.readFileSync(ledger);
  const result = pruneMessages(caws, options);
  if (process.env.CAWS_TEST_ARTIFACT_DIR) {
    const parent = path.resolve(process.env.CAWS_TEST_ARTIFACT_DIR);
    fs.mkdirSync(parent, { recursive: true });
    const artifact = fs.mkdtempSync(path.join(parent, 'dead-recipient-prune-'));
    fs.writeFileSync(path.join(artifact, 'input.json'), JSON.stringify(options, null, 2));
    fs.writeFileSync(path.join(artifact, 'result.json'), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(artifact, 'before.jsonl'), before);
    fs.copyFileSync(ledger, path.join(artifact, 'after.jsonl'));
    const archive = path.join(caws, 'messages.jsonl.archive');
    const archiveExists = fs.existsSync(archive);
    const archiveIsFile = archiveExists && fs.statSync(archive).isFile();
    fs.writeFileSync(
      path.join(artifact, 'state.json'),
      JSON.stringify({ archiveExists, archiveIsFile })
    );
    if (archiveIsFile) fs.copyFileSync(archive, path.join(artifact, 'archive.jsonl'));
    const leases = path.join(caws, 'leases');
    if (fs.existsSync(leases))
      fs.cpSync(leases, path.join(artifact, 'leases'), { recursive: true });
  }
  return result;
}

describe('dead-recipient prune selector (CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01)', () => {
  test('A1: no-lease and stale-heartbeat recipients past the floor are candidates; the floor is reported', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-no-lease', to: 'ghost-session' });
    makeLease(caws, 'stale-session', 'active', 2 * DAY_MS); // heartbeat >> 30m TTL
    writeMessage(caws, { id: 'm-stale', to: 'stale-session' });

    const result = plan(caws);
    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(false);
    expect(result.value.dead_recipient_floor_ms).toBe(FLOOR_7D);
    expect(result.value.selector_required_for_apply).toBe(false);
    expect(result.value.candidates.map((c) => [c.id, c.reason])).toEqual([
      ['m-no-lease', 'recipient-dead'],
      ['m-stale', 'recipient-dead'],
    ]);
  });

  test('A2: live and idle (stopped + fresh heartbeat) recipients are never selected', () => {
    const caws = cawsDir();
    makeLease(caws, 'live-session', 'active', 60_000);
    makeLease(caws, 'idle-session', 'stopped', 2 * 60_000);
    writeMessage(caws, { id: 'm-live', to: 'live-session' });
    writeMessage(caws, { id: 'm-idle', to: 'idle-session' });

    const result = plan(caws);
    expect(result.ok).toBe(true);
    expect(result.value.candidates).toEqual([]);
    expect(result.value.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['m-live', 'recipient-live'],
      ['m-idle', 'recipient-idle'],
    ]);
  });

  test('A3: the floor skips newer messages; an explicit --older-than-ms (including 0) overrides it', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-old', to: 'ghost-session', ageDays: 9 });
    writeMessage(caws, { id: 'm-new', to: 'ghost-session', ageDays: 1 });

    const defaultFloor = plan(caws);
    expect(defaultFloor.value.candidates.map((c) => c.id)).toEqual(['m-old']);
    expect(defaultFloor.value.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['m-new', 'newer-than-floor'],
    ]);

    const immediate = plan(caws, { olderThanMs: 0 });
    expect(immediate.value.dead_recipient_floor_ms).toBe(0);
    expect(immediate.value.candidates.map((c) => c.id)).toEqual(['m-old', 'm-new']);
  });

  test('A4: a message reserved by an unexpired offer is skipped (offer-pending)', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-offered', to: 'ghost-session' });
    writeOffer(caws, { offerId: 'offer-1', recipient: 'ghost-session', ids: ['m-offered'] });

    const result = plan(caws);
    expect(result.value.candidates).toEqual([]);
    expect(result.value.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['m-offered', 'offer-pending'],
    ]);
  });

  test('A5: apply archives with a selector marker before the rewrite, removes exactly the candidates, preserves other lines byte-identically', () => {
    const caws = cawsDir();
    const keptDead = writeMessage(caws, { id: 'm-kept-dead', to: 'ghost-session' });
    writeOffer(caws, { offerId: 'offer-keep', recipient: 'ghost-session', ids: ['m-kept-dead'] });
    makeLease(caws, 'live-session', 'active', 60_000);
    const keptLive = writeMessage(caws, { id: 'm-kept-live', to: 'live-session' });
    const pruned = writeMessage(caws, { id: 'm-pruned', to: 'ghost-session' });
    // An EXPIRED unsettled offer: it no longer reserves m-pruned (the adapter
    // is gone), so the message is prunable and the dead offer record archives
    // with it via the fully-pruned-offers path.
    const offerLine = writeOffer(caws, {
      offerId: 'offer-gone',
      recipient: 'ghost-session',
      ids: ['m-pruned'],
      ttlMs: -1000,
    });
    const before = liveLines(caws);

    const result = plan(caws, { apply: true, exclude: ['m-kept-dead'] });
    expect(result.ok).toBe(true);
    expect(result.value.applied).toBe(true);
    expect(result.value.pruned_messages).toBe(1);
    expect(result.value.candidates.map((c) => c.id)).toEqual(['m-pruned']);

    const after = liveLines(caws);
    // The pruned message and its fully-pruned offer are gone; every other
    // line survives byte-identically.
    expect(after).not.toContain(JSON.stringify(pruned));
    expect(after).not.toContain(JSON.stringify(offerLine));
    for (const line of [JSON.stringify(keptDead), JSON.stringify(keptLive)]) {
      expect(after).toContain(line);
    }
    expect(after.length).toBe(before.length - 2);

    // Archive-first: the pruned lines plus a selector-bearing marker landed
    // in the archive (telemetry), proving nothing was silently dropped.
    const archive = fs.readFileSync(path.join(caws, 'messages.jsonl.archive'), 'utf8');
    expect(archive).toContain(JSON.stringify(pruned));
    expect(archive).toContain(JSON.stringify(offerLine));
    const marker = archive
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((r) => r.record === 'prune');
    expect(marker).toMatchObject({
      record: 'prune',
      selector: 'undelivered-to-dead-session',
      ids: ['m-pruned'],
    });
  });

  test('A6: archive append failure preserves the exact dead-recipient ledger bytes', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-preserve-on-archive-failure', to: 'ghost-session' });
    fs.mkdirSync(path.join(caws, 'messages.jsonl.archive'));
    const ledger = path.join(caws, 'messages.jsonl');
    const before = fs.readFileSync(ledger);

    const result = plan(caws, { apply: true });
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.messages.archive_append_failed');
    expect(fs.readFileSync(ledger)).toEqual(before);
    expect(fs.statSync(path.join(caws, 'messages.jsonl.archive')).isDirectory()).toBe(true);
  });

  test('A7: a lease-registry load failure fails the plan closed and the ledger is untouched', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-1', to: 'ghost-session' });
    // A FILE where the leases directory belongs makes the registry unloadable.
    fs.writeFileSync(path.join(caws, 'leases'), 'not a directory');
    const before = liveLines(caws);

    const result = plan(caws, { apply: true });
    expect(result.ok).toBe(false);
    expect(liveLines(caws)).toEqual(before);
    expect(fs.existsSync(path.join(caws, 'messages.jsonl.archive'))).toBe(false);
  });

  test('A8: a delivered message to a dead recipient is skipped here (the delivered selector owns it)', () => {
    const caws = cawsDir();
    writeMessage(caws, { id: 'm-delivered', to: 'ghost-session' });
    appendDelivery(caws, 'm-delivered');

    const result = plan(caws);
    expect(result.value.candidates).toEqual([]);
    expect(result.value.skipped.map((s) => [s.id, s.reason])).toEqual([
      ['m-delivered', 'delivered'],
    ]);
  });
});
