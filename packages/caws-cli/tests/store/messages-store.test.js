'use strict';

/**
 * Unit tests for messages-store (AGENT-MESSAGE-CHANNEL-001).
 *
 * Proves the spec's load-bearing semantics against the REAL .caws/messages.jsonl
 * on disk (no mocks):
 *   A1 — send then poll round-trips exactly, with sender attribution, and a
 *        second poll does not re-deliver (deliver-once).
 *   A2 — a send to a recipient that is not live in the lease registry is refused
 *        with the recipient_not_live rule and writes NO message record.
 *   A3 — messages go to messages.jsonl only; events.jsonl is never touched.
 *   plus: channelId is order-independent; a live lease admits a send; delivered
 *        messages remain in channel history (non-lossy).
 *
 * SUT loaded from dist/. cawsDir per-test under os.tmpdir().
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  sendMessage,
  pollMessage,
  channelHistory,
  isRecipientLive,
  channelId,
} = require('../../dist/store/messages-store');

const NOT_LIVE = 'store.messages.recipient_not_live';
const RECIPIENT_INVALID = 'store.messages.recipient_invalid';

const dirs = [];
function cawsDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-msg-'));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Write a lease file so `to` is a live recipient (status active, fresh heartbeat). */
function makeLive(caws, sessionId) {
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sessionId}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sessionId,
      platform: 'test',
      status: 'active',
      last_active: new Date().toISOString(),
      repo_root: caws,
    })
  );
}

const sender = { kind: 'agent', id: 'sender-1', session_id: 'sender-1', platform: 'test' };

// ─── A1: round-trip + deliver-once ──────────────────────────────────────────

test('A1: send then poll returns the exact text with sender attribution', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  const sent = sendMessage(caws, { actor: sender, to: 'recip-1', text: 'hello recipient' });
  expect(sent.ok).toBe(true);

  const polled = pollMessage(caws, 'recip-1');
  expect(polled.ok).toBe(true);
  expect(polled.value.message).not.toBeNull();
  expect(polled.value.message.text).toBe('hello recipient');
  expect(polled.value.message.actor.session_id).toBe('sender-1');
  expect(polled.value.message.to).toBe('recip-1');
});

test('A1: a delivered message is not re-delivered on a second poll', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'once' });
  const first = pollMessage(caws, 'recip-1');
  expect(first.value.message.text).toBe('once');
  const second = pollMessage(caws, 'recip-1');
  expect(second.ok).toBe(true);
  expect(second.value.message).toBeNull();
});

test('A1: the sender does not receive their own message', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  makeLive(caws, 'sender-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'to recip only' });
  const senderPoll = pollMessage(caws, 'sender-1');
  expect(senderPoll.value.message).toBeNull();
});

// ─── A2: liveness-gated send ─────────────────────────────────────────────────

test('A2: a send to a recipient with no lease is refused and writes no record', () => {
  const caws = cawsDir();
  // no lease for 'ghost'
  const sent = sendMessage(caws, { actor: sender, to: 'ghost', text: 'anyone there?' });
  expect(sent.ok).toBe(false);
  expect(sent.errors[0].rule).toBe(NOT_LIVE);
  // no message file written at all
  expect(fs.existsSync(path.join(caws, 'messages.jsonl'))).toBe(false);
});

test('A2: a send to a STOPPED lease is refused (stopped is not live)', () => {
  const caws = cawsDir();
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, 'stopped-1.json'),
    JSON.stringify({
      lease_version: 1,
      session_id: 'stopped-1',
      platform: 'test',
      status: 'stopped',
      last_active: new Date().toISOString(),
    })
  );
  const sent = sendMessage(caws, { actor: sender, to: 'stopped-1', text: 'hi' });
  expect(sent.ok).toBe(false);
  expect(sent.errors[0].rule).toBe(NOT_LIVE);
});

test('A2: a send to a STALE active lease (old heartbeat) is refused', () => {
  const caws = cawsDir();
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, 'stale-1.json'),
    JSON.stringify({
      lease_version: 1,
      session_id: 'stale-1',
      platform: 'test',
      status: 'active',
      last_active: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 1h ago > 30m TTL
    })
  );
  const live = isRecipientLive(caws, 'stale-1');
  expect(live.ok).toBe(true);
  expect(live.value).toBe(false);
  const sent = sendMessage(caws, { actor: sender, to: 'stale-1', text: 'hi' });
  expect(sent.ok).toBe(false);
});

test('A2: --allow-dead (requireLive:false) bypasses the liveness check', () => {
  const caws = cawsDir();
  const sent = sendMessage(caws, { actor: sender, to: 'ghost', text: 'forced', requireLive: false });
  expect(sent.ok).toBe(true);
});

test('A2: an invalid recipient id is refused with recipient_invalid', () => {
  const caws = cawsDir();
  const sent = sendMessage(caws, { actor: sender, to: 'bad id/with spaces', text: 'x' });
  expect(sent.ok).toBe(false);
  expect(sent.errors[0].rule).toBe(RECIPIENT_INVALID);
});

// ─── A3: separate log; events.jsonl untouched ───────────────────────────────

test('A3: messages write to messages.jsonl and never to events.jsonl', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  // seed an events.jsonl and snapshot it
  const eventsPath = path.join(caws, 'events.jsonl');
  fs.writeFileSync(eventsPath, '{"seq":1,"event":"genesis"}\n');
  const before = fs.readFileSync(eventsPath, 'utf8');

  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'm1' });
  pollMessage(caws, 'recip-1');

  expect(fs.existsSync(path.join(caws, 'messages.jsonl'))).toBe(true);
  // events.jsonl byte-unchanged
  expect(fs.readFileSync(eventsPath, 'utf8')).toBe(before);
});

// ─── channel semantics ──────────────────────────────────────────────────────

test('channelId is order-independent (A::B == B::A)', () => {
  expect(channelId('alice', 'bob')).toBe('alice::bob');
  expect(channelId('bob', 'alice')).toBe('alice::bob');
});

test('delivered messages remain in channel history (non-lossy)', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'kept' });
  pollMessage(caws, 'recip-1'); // consume
  const hist = channelHistory(caws, 'sender-1', 'recip-1');
  expect(hist.ok).toBe(true);
  expect(hist.value.length).toBe(1);
  expect(hist.value[0].text).toBe('kept');
});
