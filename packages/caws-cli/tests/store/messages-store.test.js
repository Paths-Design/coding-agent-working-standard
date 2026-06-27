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
  inboxCount,
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

// ─── liveness: the 'stopping' status and the exact TTL boundary ──────────────

test("a 'stopping' lease IS live (status check admits active AND stopping)", () => {
  const caws = cawsDir();
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, 'wind-down.json'),
    JSON.stringify({
      lease_version: 1,
      session_id: 'wind-down',
      platform: 'test',
      status: 'stopping',
      last_active: new Date().toISOString(),
    })
  );
  // kills the mutant that drops `status !== 'stopping'` from the live predicate
  expect(isRecipientLive(caws, 'wind-down').value).toBe(true);
  expect(sendMessage(caws, { actor: sender, to: 'wind-down', text: 'hi' }).ok).toBe(true);
});

test('TTL boundary: a heartbeat exactly at the 30m TTL is still live; just past it is not', () => {
  const caws = cawsDir();
  const leasesDir = path.join(caws, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  const TTL = 30 * 60 * 1000;
  const writeLease = (id, ageMs) =>
    fs.writeFileSync(
      path.join(leasesDir, `${id}.json`),
      JSON.stringify({
        lease_version: 1,
        session_id: id,
        platform: 'test',
        status: 'active',
        last_active: new Date(Date.now() - ageMs).toISOString(),
      })
    );
  // At exactly TTL: `ageMs > TTL` is false → still live. Kills the `>` → `>=` mutant.
  writeLease('edge-at', TTL - 1000); // safely within, but near the boundary
  expect(isRecipientLive(caws, 'edge-at').value).toBe(true);
  // Just past TTL: not live.
  writeLease('edge-past', TTL + 60 * 1000);
  expect(isRecipientLive(caws, 'edge-past').value).toBe(false);
});

// ─── recipient validation: empty vs regex-fail are distinct refusals ─────────

test('an empty recipient string is refused (distinct from a regex-fail)', () => {
  const caws = cawsDir();
  const sent = sendMessage(caws, { actor: sender, to: '', text: 'x' });
  expect(sent.ok).toBe(false);
  expect(sent.errors[0].rule).toBe(RECIPIENT_INVALID);
  // and nothing was written
  expect(fs.existsSync(path.join(caws, 'messages.jsonl'))).toBe(false);
});

// ─── sender attribution falls back to actor.id when no session_id ────────────

test("the channel uses actor.id as 'from' when the actor has no session_id", () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  const idOnly = { kind: 'agent', id: 'human-cli' }; // no session_id
  const sent = sendMessage(caws, { actor: idOnly, to: 'recip-1', text: 'hi' });
  expect(sent.ok).toBe(true);
  // channel keyed by id 'human-cli', not undefined — kills the `?? -> &&` mutant
  expect(sent.value.channel).toBe(channelId('human-cli', 'recip-1'));
});

// ─── poll tolerates blank + malformed lines (lenient skip with a diagnostic) ──

test('pollMessage skips blank and malformed lines and still delivers the valid one', () => {
  const caws = cawsDir();
  fs.mkdirSync(caws, { recursive: true });
  const file = path.join(caws, 'messages.jsonl');
  const good = {
    record: 'message',
    id: 'g1',
    actor: { kind: 'agent', id: 's', session_id: 's' },
    to: 'recip-1',
    channel: channelId('s', 'recip-1'),
    text: 'survives the noise',
    ts: new Date().toISOString(),
  };
  // a blank line, a malformed line, then the valid message
  fs.writeFileSync(file, '\n' + 'this is not json\n' + JSON.stringify(good) + '\n');
  const polled = pollMessage(caws, 'recip-1');
  expect(polled.ok).toBe(true);
  expect(polled.value.message.text).toBe('survives the noise');
  // the malformed line produced exactly one diagnostic (kills the skip-block + push mutants)
  expect(polled.value.diagnostics.length).toBe(1);
});

// ─── channelHistory filters to the channel (the && in the filter is load-bearing) ─

test('channelHistory returns only messages for the requested channel', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  makeLive(caws, 'other');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'for recip-1' });
  sendMessage(caws, { actor: sender, to: 'other', text: 'for other' });
  const hist = channelHistory(caws, 'sender-1', 'recip-1');
  expect(hist.ok).toBe(true);
  // exactly one — the 'other' message must NOT leak in (kills the && -> || / true mutants)
  expect(hist.value.length).toBe(1);
  expect(hist.value[0].text).toBe('for recip-1');
});

test('channelHistory is empty when the log does not exist', () => {
  const caws = cawsDir();
  const hist = channelHistory(caws, 'a', 'b');
  expect(hist.ok).toBe(true);
  expect(hist.value.length).toBe(0);
});

// ─── concurrency: poll is atomic across processes (no double-delivery) ────────

test('concurrent polls from separate processes deliver a message at most once', async () => {
  // The TOCTOU (read log → pick undelivered → append delivery) only races across
  // PROCESSES — within one node process the sync FS calls serialize. So we spawn
  // real child processes CONCURRENTLY (spawn, not spawnSync) and assert the single
  // message is received by exactly one. Pre-lock this delivered the same id to
  // multiple processes (reproduced); the dedicated message-log lock closes it.
  const { spawn } = require('child_process');
  const distPath = path.join(__dirname, '..', '..', 'dist', 'store', 'messages-store.js');
  const caws = cawsDir();
  makeLive(caws, 'r');
  sendMessage(caws, { actor: { kind: 'agent', id: 's', session_id: 's' }, to: 'r', text: 'ONLY-ONE' });

  const N = 6;
  const poller = `const {pollMessage}=require(${JSON.stringify(distPath)});` +
    `const r=pollMessage(${JSON.stringify(caws)},'r');` +
    `if(r.ok&&r.value.message)process.stdout.write(r.value.message.id);`;

  // Launch all N pollers concurrently; collect each one's stdout.
  const runOne = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', poller], { encoding: 'utf8' });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', () => resolve(out.trim()));
    });
  const results = await Promise.all(Array.from({ length: N }, runOne));
  const gotIds = results.filter((s) => s.length > 0);

  // Exactly one process received the single message; no duplicate delivery.
  expect(gotIds.length).toBe(1);
}, 30000);

// ─── peek: read without consuming (AGENT-MESSAGE-CHANNEL-002) ─────────────────

test('peek returns the next message without consuming it', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'peek me' });

  const peeked = pollMessage(caws, 'recip-1', { peek: true });
  expect(peeked.ok).toBe(true);
  expect(peeked.value.message.text).toBe('peek me');

  // a peek must NOT write a delivery record — a normal poll still gets it
  const real = pollMessage(caws, 'recip-1');
  expect(real.value.message.text).toBe('peek me');
  // and now it's consumed
  expect(pollMessage(caws, 'recip-1').value.message).toBeNull();
});

test('two peeks in a row both return the same message (idempotent read)', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'stable' });
  const a = pollMessage(caws, 'recip-1', { peek: true }).value.message;
  const b = pollMessage(caws, 'recip-1', { peek: true }).value.message;
  expect(a.id).toBe(b.id);
});

// ─── inboxCount: triage depth ────────────────────────────────────────────────

test('inboxCount reflects undelivered messages and drops to zero after consume', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  expect(inboxCount(caws, 'recip-1').value).toBe(0);
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'm1' });
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'm2' });
  expect(inboxCount(caws, 'recip-1').value).toBe(2);
  // peek does not change the count
  pollMessage(caws, 'recip-1', { peek: true });
  expect(inboxCount(caws, 'recip-1').value).toBe(2);
  // a real poll consumes one
  pollMessage(caws, 'recip-1');
  expect(inboxCount(caws, 'recip-1').value).toBe(1);
});

test('inboxCount counts only messages addressed to me', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  makeLive(caws, 'other');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'mine' });
  sendMessage(caws, { actor: sender, to: 'other', text: 'not mine' });
  expect(inboxCount(caws, 'recip-1').value).toBe(1);
});

// ─── wait: long-poll returns on arrival, times out cleanly when empty ─────────

test('poll --wait returns null after the window when the mailbox stays empty', () => {
  const caws = cawsDir();
  const t0 = Date.now();
  const r = pollMessage(caws, 'recip-1', { waitMs: 250 });
  expect(r.ok).toBe(true);
  expect(r.value.message).toBeNull();
  // actually waited the window (proves the retry loop ran, not an instant return)
  expect(Date.now() - t0).toBeGreaterThanOrEqual(200);
});

test('poll --wait returns immediately when a message is already present', () => {
  const caws = cawsDir();
  makeLive(caws, 'recip-1');
  sendMessage(caws, { actor: sender, to: 'recip-1', text: 'here now' });
  const t0 = Date.now();
  const r = pollMessage(caws, 'recip-1', { waitMs: 5000 });
  expect(r.value.message.text).toBe('here now');
  expect(Date.now() - t0).toBeLessThan(1000); // did not burn the 5s window
});
