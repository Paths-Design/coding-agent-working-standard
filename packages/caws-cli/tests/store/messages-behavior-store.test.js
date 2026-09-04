'use strict';

/**
 * Direct store witnesses for message read models added after the original
 * message mutation corpus. CLI rendering is tested separately; these tests
 * pin filtering, ordering, age, diagnostics, and platform attribution at the
 * store boundary where the mutation target lives.
 *
 * [CAWS-MESSAGE-BEHAVIOR-001]
 * [CAWS-MESSAGE-LEDGER-COMPLETENESS-001]
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  channelHistory,
  describeRecipientLiveness,
  formatAge,
  getMessageDeliveryState,
  inboxAllMessages,
  inboxCount,
  inboxMessages,
  isRecipientLive,
  mineQueued,
  platformEngagement,
  pollMessage,
  pruneMessages,
  resolveRecipient,
  sendMessage,
} = require('../../dist/store/messages-store');

const dirs = [];
const NOW = Date.parse('2026-09-04T12:00:00.000Z');

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function cawsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-message-read-model-'));
  dirs.push(dir);
  return dir;
}

function message(id, from, to, ts, options = {}) {
  return {
    record: 'message',
    id,
    actor: {
      kind: 'agent',
      id: options.actorId ?? from,
      ...(options.withoutSession ? {} : { session_id: from }),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    },
    to,
    channel: [from, to].sort().join('::'),
    text: id,
    ts,
  };
}

function delivery(id, ts = '2026-09-04T11:30:00.000Z') {
  return { record: 'delivery', deliver_id: id, ts, mode: 'poll' };
}

function writeLedger(dir, entries) {
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n'
  );
}

function writeLease(dir, sessionId, platform) {
  writeLeaseRecord(dir, sessionId, { platform });
}

function writeLeaseRecord(dir, sessionId, overrides = {}) {
  const leases = path.join(dir, 'leases');
  fs.mkdirSync(leases, { recursive: true });
  fs.writeFileSync(
    path.join(leases, `${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      status: 'active',
      last_active: '2026-09-04T11:59:00.000Z',
      ...overrides,
    })
  );
}

function readLedger(dir, filename = 'messages.jsonl') {
  const raw = fs.readFileSync(path.join(dir, filename), 'utf8');
  if (raw.length === 0) return [];
  return raw.trim().split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

describe('formatAge', () => {
  test.each([
    [0, '0s ago'],
    [59_999, '59s ago'],
    [60_000, '1 min ago'],
    [3_599_999, '59 min ago'],
    [3_600_000, '1h ago'],
    [86_399_999, '23h ago'],
    [86_400_000, '1d ago'],
    [172_800_000, '2d ago'],
  ])('formats %i ms at the correct unit boundary', (ageMs, expected) => {
    expect(formatAge(ageMs)).toBe(expected);
  });
});

describe('module-level message contracts', () => {
  test('fresh loading exposes filename, endpoint, TTL, and alias constant mutations', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    jest.resetModules();
    const fresh = require('../../dist/store/messages-store');
    const dir = cawsDir();
    writeLeaseRecord(dir, 'valid.peer:1', {
      platform: 'test',
      last_active: new Date(NOW - 60_000).toISOString(),
      bound_worktree: 'lane',
      bound_spec_id: 'SPEC-1',
    });

    expect(fresh.describeRecipientLiveness(dir, 'valid.peer:1')).toEqual({
      ok: true,
      value: { live: true, status: 'active' },
    });
    const sent = fresh.sendMessage(dir, {
      actor: { kind: 'agent', id: 'sender' },
      to: 'valid.peer:1',
      text: 'constant witness',
    });
    expect(sent.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'messages.jsonl'))).toBe(true);
    expect(fresh.sendMessage(dir, {
      actor: { kind: 'agent', id: 'sender' },
      to: '!leading-invalid',
      text: 'no',
      requireLive: false,
    }).ok).toBe(false);
    expect(fresh.sendMessage(dir, {
      actor: { kind: 'agent', id: 'sender' },
      to: 'trailing-invalid!',
      text: 'no',
      requireLive: false,
    }).ok).toBe(false);
    expect(fresh.resolveRecipient(dir, 'wt:lane')).toEqual({
      ok: true,
      value: { sessionId: 'valid.peer:1', alias: 'wt:lane' },
    });
    expect(fresh.resolveRecipient(dir, 'spec:SPEC-1')).toEqual({
      ok: true,
      value: { sessionId: 'valid.peer:1', alias: 'spec:SPEC-1' },
    });

    expect(fresh.pollMessage(dir, 'valid.peer:1').value.message.id).toBe(sent.value.message.id);
    expect(fresh.pruneMessages(dir, {
      status: 'delivered',
      include: [sent.value.message.id],
      apply: true,
    }).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'messages.jsonl.archive'))).toBe(true);

    writeLeaseRecord(dir, 'stale', {
      last_active: new Date(NOW - 31 * 60_000).toISOString(),
    });
    const stale = fresh.sendMessage(dir, {
      actor: { kind: 'agent', id: 'sender' },
      to: 'stale',
      text: 'no',
    });
    expect(stale.ok).toBe(false);
    expect(stale.errors[0].message).toContain('TTL is 30m');
  });
});

describe('recipient liveness and send admission', () => {
  test('returns exact liveness variants for absent, stale, stopped, and active leases', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const dir = cawsDir();
    writeLeaseRecord(dir, 'stale-status', {
      status: 'active',
      last_active: new Date(NOW - 31 * 60_000).toISOString(),
    });
    writeLeaseRecord(dir, 'stale-no-status', {
      status: undefined,
      last_active: new Date(NOW - 31 * 60_000).toISOString(),
    });
    writeLeaseRecord(dir, 'stopped-unknown', {
      status: 'stopped',
      last_active: 'not-a-time',
    });
    writeLeaseRecord(dir, 'stopped-fresh', {
      status: 'stopped',
      last_active: new Date(NOW - 1_000).toISOString(),
    });
    writeLeaseRecord(dir, 'active-unknown', {
      status: undefined,
      last_active: 'not-a-time',
    });
    writeLeaseRecord(dir, 'numeric-heartbeat', {
      status: undefined,
      last_active: 0,
    });
    writeLeaseRecord(dir, 'ttl-boundary', {
      status: 'active',
      last_active: new Date(NOW - 30 * 60_000).toISOString(),
    });

    expect(describeRecipientLiveness(dir, 'missing')).toStrictEqual({
      ok: true,
      value: { live: false, reason: 'no_lease' },
    });
    expect(describeRecipientLiveness(dir, 'stale-status')).toStrictEqual({
      ok: true,
      value: {
        live: false,
        reason: 'stale_heartbeat',
        status: 'active',
        ageMs: 31 * 60_000,
      },
    });
    expect(describeRecipientLiveness(dir, 'stale-no-status')).toStrictEqual({
      ok: true,
      value: { live: false, reason: 'stale_heartbeat', ageMs: 31 * 60_000 },
    });
    expect(describeRecipientLiveness(dir, 'stopped-unknown')).toStrictEqual({
      ok: true,
      value: { live: false, reason: 'stale_heartbeat', status: 'stopped' },
    });
    expect(describeRecipientLiveness(dir, 'stopped-fresh')).toStrictEqual({
      ok: true,
      value: { live: true, idle: true, status: 'stopped' },
    });
    expect(describeRecipientLiveness(dir, 'active-unknown')).toStrictEqual({
      ok: true,
      value: { live: true },
    });
    expect(describeRecipientLiveness(dir, 'numeric-heartbeat')).toStrictEqual({
      ok: true,
      value: { live: true },
    });
    expect(describeRecipientLiveness(dir, 'ttl-boundary')).toStrictEqual({
      ok: true,
      value: { live: true, status: 'active' },
    });
  });

  test('propagates lease-registry failures through both liveness APIs', () => {
    const dir = cawsDir();
    fs.writeFileSync(path.join(dir, 'leases'), 'not a directory');

    for (const result of [
      describeRecipientLiveness(dir, 'peer'),
      isRecipientLive(dir, 'peer'),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.errors).not.toHaveLength(0);
    }
  });

  test('pins JavaScript input guards and optional persisted message fields', () => {
    const dir = cawsDir();
    const actor = { kind: 'agent', id: 'actor-only' };

    for (const to of [null, '', 'bad value']) {
      const refused = sendMessage(dir, { actor, to, text: 'refused', requireLive: false });
      expect(refused.ok).toBe(false);
      expect(refused.errors[0].rule).toBe('store.messages.recipient_invalid');
    }
    expect(sendMessage(dir, { actor, to: 'ghost', text: 'live required' }).errors[0].rule)
      .toBe('store.messages.recipient_not_live');

    const plain = sendMessage(dir, {
      actor,
      to: 'peer',
      text: 'plain',
      requireLive: false,
      replyTo: '',
      urgency: 'normal',
    });
    const linked = sendMessage(dir, {
      actor,
      to: 'peer',
      text: 'linked',
      requireLive: false,
      replyTo: 'parent',
      urgency: 'critical',
    });
    expect(plain.ok).toBe(true);
    expect(plain.value).toMatchObject({ recipientIdle: false });
    expect(plain.value.message).toMatchObject({
      actor,
      to: 'peer',
      channel: 'actor-only::peer',
      text: 'plain',
    });
    expect(plain.value.message).not.toHaveProperty('reply_to');
    expect(plain.value.message).not.toHaveProperty('urgency');
    expect(linked.value.message).toMatchObject({ reply_to: 'parent', urgency: 'critical' });

    writeLeaseRecord(dir, 'active-peer', { last_active: new Date().toISOString() });
    expect(sendMessage(dir, { actor, to: 'active-peer', text: 'active' }).value.recipientIdle)
      .toBe(false);
  });

  test('surfaces append failures without claiming the message was sent', () => {
    const dir = cawsDir();
    fs.mkdirSync(path.join(dir, 'messages.jsonl'));

    const result = sendMessage(dir, {
      actor: { kind: 'agent', id: 'sender' },
      to: 'peer',
      text: 'cannot append',
      requireLive: false,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({
      rule: 'store.messages.append_failed',
    });
    expect(result.errors[0].message).toContain('messages.jsonl');
  });
});

describe('recipient alias selection', () => {
  test('prefers the freshest lease and breaks an exact tie toward a running lease', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const dir = cawsDir();
    const tied = new Date(NOW - 1_000).toISOString();
    writeLeaseRecord(dir, 'a-stopped', {
      status: 'stopped',
      last_active: tied,
      bound_worktree: 'tie',
    });
    writeLeaseRecord(dir, 'b-running', {
      status: 'active',
      last_active: tied,
      bound_worktree: 'tie',
    });
    writeLeaseRecord(dir, 'c-older', {
      last_active: new Date(NOW - 10_000).toISOString(),
      bound_worktree: 'tie',
    });
    writeLeaseRecord(dir, 'invalid-time', {
      last_active: 'invalid',
      bound_worktree: 'tie',
    });
    writeLeaseRecord(dir, 'stale', {
      last_active: new Date(NOW - 31 * 60_000).toISOString(),
      bound_worktree: 'tie',
    });
    writeLeaseRecord(dir, 'wrong-binding', {
      last_active: new Date(NOW).toISOString(),
      bound_worktree: 'other',
    });

    expect(resolveRecipient(dir, 'wt:tie')).toEqual({
      ok: true,
      value: { sessionId: 'b-running', alias: 'wt:tie' },
    });
  });

  test('distinguishes raw ids, empty aliases, and invalid JavaScript inputs', () => {
    const dir = cawsDir();
    expect(resolveRecipient(dir, 'raw.id:1')).toEqual({
      ok: true,
      value: { sessionId: 'raw.id:1' },
    });
    for (const alias of ['wt:', 'spec:']) {
      const result = resolveRecipient(dir, alias);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.messages.alias_unresolved');
      expect(result.errors[0].message).toContain(alias);
    }
    for (const invalid of [null, '', 'bad/id']) {
      const result = resolveRecipient(dir, invalid);
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.messages.recipient_invalid');
    }
  });
});

describe('inboxMessages', () => {
  test('a missing ledger has an explicit empty read-only result', () => {
    expect(inboxMessages(cawsDir(), 'bob')).toEqual({
      ok: true,
      value: { messages: [], waiting: 0, diagnostics: [] },
    });
  });

  test('filters deliveries and recipients, reports malformed lines, and floors a finite limit', () => {
    const dir = cawsDir();
    const first = message('first', 'alice', 'bob', '2026-09-04T08:00:00.000Z');
    const second = message('second', 'alice', 'bob', '2026-09-04T09:00:00.000Z');
    const third = message('third', 'carol', 'bob', '2026-09-04T10:00:00.000Z');
    writeLedger(dir, [
      first,
      delivery('first'),
      '{bad json',
      { record: 'refusal', id: 'ignored' },
      second,
      message('other', 'alice', 'dave', '2026-09-04T09:30:00.000Z'),
      third,
    ]);
    const before = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');

    const result = inboxMessages(dir, 'bob', { limit: 1.9 });

    expect(result.ok).toBe(true);
    expect(result.value.messages.map((entry) => entry.id)).toEqual(['second']);
    expect(result.value.waiting).toBe(2);
    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0]).toMatchObject({
      rule: 'store.messages.line_malformed',
      message: 'messages.jsonl:3 is not valid JSON — skipped.',
    });
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')).toBe(before);

    for (const limit of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(inboxMessages(dir, 'bob', { limit }).value.messages).toHaveLength(2);
    }
    expect(inboxMessages(dir, 'bob', { limit: 0 }).value).toMatchObject({
      messages: [],
      waiting: 2,
    });
    expect(inboxMessages(dir, 'bob', { limit: '1' }).value.messages).toHaveLength(2);
  });

  test('an unreadable ledger is a typed load failure', () => {
    const dir = cawsDir();
    fs.mkdirSync(path.join(dir, 'messages.jsonl'));

    const result = inboxMessages(dir, 'bob');

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatchObject({ rule: 'store.messages.log_unreadable' });
  });
});

describe('polling and sender context', () => {
  test('returns an exact empty result for a missing ledger and a typed read failure', () => {
    const missing = pollMessage(cawsDir(), 'me');
    expect(missing).toEqual({
      ok: true,
      value: { message: null, messages: [], diagnostics: [] },
    });

    const unreadable = cawsDir();
    fs.mkdirSync(path.join(unreadable, 'messages.jsonl'));
    const failed = pollMessage(unreadable, 'me');
    expect(failed.ok).toBe(false);
    expect(failed.errors[0].rule).toBe('store.messages.log_unreadable');
    expect(failed.errors[0].message).toContain('messages.jsonl');
  });

  test('pins critical ordering, drain normalization, diagnostics, and receipt fallback', () => {
    const dir = cawsDir();
    const entries = [];
    for (let index = 0; index < 12; index += 1) {
      entries.push({
        ...message(
          `normal-${String(index).padStart(2, '0')}`,
          'sender',
          'me',
          `2026-09-04T09:${String(index).padStart(2, '0')}:00.000Z`
        ),
        ...(index === 11 ? { urgency: 'critical' } : {}),
      });
    }
    writeLedger(dir, [
      '{bad json',
      { record: 'unknown', id: 'ignored' },
      { record: 'delivery', deliver_id: 42, ts: '2026-09-04T10:00:00.000Z' },
      ...entries,
    ]);

    const first = pollMessage(dir, 'me', { drain: 0, receipt: 'invalid' });
    expect(first.ok).toBe(true);
    expect(first.value.messages.map((entry) => entry.message.id)).toEqual(['normal-11']);
    expect(first.value.diagnostics).toHaveLength(1);
    expect(first.value.diagnostics[0].message).toBe(
      'messages.jsonl:1 is not valid JSON — skipped.'
    );
    expect(readLedger(dir).filter((entry) => entry.record === 'delivery').at(-1)).toMatchObject({
      deliver_id: 'normal-11',
      mode: 'poll',
    });

    const capped = pollMessage(dir, 'me', { drain: 99 });
    expect(capped.value.messages.map((entry) => entry.message.id)).toEqual([
      'normal-00',
      'normal-01',
      'normal-02',
      'normal-03',
      'normal-04',
      'normal-05',
      'normal-06',
      'normal-07',
      'normal-08',
      'normal-09',
    ]);
    expect(capped.value.message.id).toBe('normal-00');
  });

  test('uses only non-empty string lease fields for sender enrichment', () => {
    const dir = cawsDir();
    writeLeaseRecord(dir, 'full-sender', {
      bound_worktree: 'wt-full',
      bound_spec_id: 'SPEC-FULL',
      branch: 'feature/full',
      work_state: 'review_ready',
    });
    writeLeaseRecord(dir, 'empty-sender', {
      bound_worktree: '',
      bound_spec_id: '',
      branch: '',
      work_state: '',
    });
    writeLedger(dir, [
      message('full', 'full-sender', 'me', '2026-09-04T09:00:00.000Z'),
      message('empty', 'empty-sender', 'me', '2026-09-04T09:01:00.000Z'),
    ]);

    const full = pollMessage(dir, 'me', { peek: true });
    expect(full.value.sender).toEqual({
      worktree: 'wt-full',
      specId: 'SPEC-FULL',
      branch: 'feature/full',
      workState: 'review_ready',
    });
    expect(full.value.messages[0].sender).toEqual(full.value.sender);

    writeLedger(dir, [
      delivery('full'),
      message('empty', 'empty-sender', 'me', '2026-09-04T09:01:00.000Z'),
    ]);
    const empty = pollMessage(dir, 'me', { peek: true });
    expect(empty.value.message.id).toBe('empty');
    expect(empty.value).not.toHaveProperty('sender');
    expect(empty.value.messages[0]).not.toHaveProperty('sender');
  });

  test('treats only literal true as peek and leaves a real peek unconsumed', () => {
    const dir = cawsDir();
    writeLedger(dir, [message('one', 'sender', 'me', '2026-09-04T09:00:00.000Z')]);

    expect(pollMessage(dir, 'me', { peek: 1 }).value.message.id).toBe('one');
    expect(pollMessage(dir, 'me').value.message).toBeNull();

    writeLedger(dir, [message('two', 'sender', 'me', '2026-09-04T09:00:00.000Z')]);
    expect(pollMessage(dir, 'me', { peek: true }).value.message.id).toBe('two');
    expect(pollMessage(dir, 'me').value.message.id).toBe('two');
  });
});

describe('inbox count and repo-wide inbox', () => {
  test('counts only undelivered recipient messages across malformed and irrelevant lines', () => {
    const dir = cawsDir();
    writeLedger(dir, [
      message('mine-delivered', 'a', 'me', '2026-09-04T09:00:00.000Z'),
      message('mine-waiting', 'a', 'me', '2026-09-04T09:01:00.000Z'),
      message('other', 'a', 'other', '2026-09-04T09:02:00.000Z'),
      delivery('mine-delivered'),
      { record: 'delivery', deliver_id: 7, ts: '2026-09-04T09:03:00.000Z' },
      { record: 'refusal', id: 'ignored' },
      '{bad json',
    ]);

    expect(inboxCount(dir, 'me')).toEqual({ ok: true, value: 1 });
    expect(inboxCount(dir, 'other')).toEqual({ ok: true, value: 1 });
    expect(inboxCount(cawsDir(), 'me')).toEqual({ ok: true, value: 0 });
  });

  test('returns typed inbox-count read failures', () => {
    const dir = cawsDir();
    fs.mkdirSync(path.join(dir, 'messages.jsonl'));
    const result = inboxCount(dir, 'me');
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.messages.log_unreadable');
  });

  test('pins repo-wide age clamping, ordering, delivery filtering, and diagnostics', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const dir = cawsDir();
    writeLedger(dir, [
      message('future', 'a', 'r2', '2026-09-04T13:00:00.000Z'),
      message('old', 'a', 'r1', '2026-09-04T09:00:00.000Z'),
      message('invalid', 'a', 'r3', 'not-a-time'),
      message('delivered', 'a', 'r4', '2026-09-04T08:00:00.000Z'),
      delivery('delivered'),
      '{bad json',
    ]);

    const result = inboxAllMessages(dir);

    expect(result.ok).toBe(true);
    expect(result.value.messages.map(({ message: entry, recipient, ageMs }) => ({
      id: entry.id,
      recipient,
      ageMs,
    }))).toEqual([
      { id: 'old', recipient: 'r1', ageMs: 3 * 60 * 60 * 1000 },
      { id: 'future', recipient: 'r2', ageMs: 0 },
      { id: 'invalid', recipient: 'r3', ageMs: 0 },
    ]);
    expect(result.value.count).toBe(3);
    expect(result.value.oldestAgeMs).toBe(3 * 60 * 60 * 1000);
    expect(result.value.diagnostics).toHaveLength(1);
    expect(result.value.diagnostics[0].message).toBe(
      'messages.jsonl:6 is not valid JSON — skipped.'
    );
  });
});

describe('mineQueued', () => {
  test('returns only the caller’s aged undelivered messages in timestamp order', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const dir = cawsDir();
    writeLedger(dir, [
      message('mine-2h', 'me', 'peer', '2026-09-04T10:00:00.000Z'),
      message('fresh', 'me', 'peer', '2026-09-04T11:50:00.000Z'),
      message('mine-3h', 'unused', 'peer', '2026-09-04T09:00:00.000Z', {
        actorId: 'me',
        withoutSession: true,
      }),
      message('other-sender', 'other', 'peer', '2026-09-04T08:00:00.000Z'),
      message('delivered', 'me', 'peer', '2026-09-04T07:00:00.000Z'),
      delivery('delivered'),
      message('invalid-time', 'me', 'peer', 'not-a-time'),
      '{bad json',
    ]);

    const result = mineQueued(dir, 'me', 60 * 60 * 1000);

    expect(result.ok).toBe(true);
    expect(result.value.messages.map((entry) => entry.message.id)).toEqual([
      'mine-3h',
      'mine-2h',
    ]);
    expect(result.value.messages.map((entry) => entry.ageMs)).toEqual([
      3 * 60 * 60 * 1000,
      2 * 60 * 60 * 1000,
    ]);
    expect(result.value).toMatchObject({ count: 2, oldestAgeMs: 3 * 60 * 60 * 1000 });
    expect(result.value.diagnostics).toHaveLength(1);

    const allMine = mineQueued(dir, 'me', -1);
    expect(allMine.value.messages.map((entry) => entry.message.id).sort()).toEqual([
      'fresh',
      'invalid-time',
      'mine-2h',
      'mine-3h',
    ]);
  });

  test('an empty ledger has a null oldest age', () => {
    const result = mineQueued(cawsDir(), 'me', 0);
    expect(result).toEqual({
      ok: true,
      value: { messages: [], count: 0, oldestAgeMs: null, diagnostics: [] },
    });
  });
});

describe('message retention planning and apply', () => {
  test('classifies every skip reason and counts only matching delivery records', () => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    const dir = cawsDir();
    const candidate = message('candidate', 'unused', 'peer', '2026-09-04T09:00:00.000Z', {
      actorId: 'actor-only',
      withoutSession: true,
    });
    writeLedger(dir, [
      message('undelivered', 'me', 'peer', '2026-09-04T08:00:00.000Z'),
      candidate,
      message('excluded', 'me', 'peer', '2026-09-04T08:00:00.000Z'),
      message('not-included', 'me', 'peer', '2026-09-04T08:00:00.000Z'),
      message('invalid-age', 'me', 'peer', 'not-a-time'),
      delivery('candidate'),
      delivery('candidate', '2026-09-04T11:31:00.000Z'),
      delivery('excluded'),
      delivery('not-included'),
      delivery('invalid-age'),
      { record: 'delivery', deliver_id: 42, ts: '2026-09-04T11:32:00.000Z' },
      { record: 'unknown' },
      '{bad json',
    ]);
    const before = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');

    const result = pruneMessages(dir, {
      status: 'delivered',
      olderThanMs: 60 * 60 * 1000,
      include: ['candidate', 'excluded', 'invalid-age'],
      exclude: ['excluded'],
    });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      status: 'delivered',
      apply: false,
      applied: false,
      delivery_records_to_remove: 2,
      selector_required_for_apply: false,
      pruned_messages: 0,
      pruned_delivery_records: 0,
    });
    expect(result.value.candidates).toEqual([{
      id: 'candidate',
      ts: candidate.ts,
      from: 'actor-only',
      to: 'peer',
      channel: candidate.channel,
      text: 'candidate',
      delivered: true,
      state: 'candidate',
      reason: 'delivered',
    }]);
    expect(result.value.skipped.map(({ id, delivered: wasDelivered, state, reason }) => ({
      id,
      delivered: wasDelivered,
      state,
      reason,
    }))).toEqual([
      { id: 'undelivered', delivered: false, state: 'skipped', reason: 'undelivered' },
      { id: 'excluded', delivered: true, state: 'skipped', reason: 'excluded' },
      { id: 'not-included', delivered: true, state: 'skipped', reason: 'not-included' },
      { id: 'invalid-age', delivered: true, state: 'skipped', reason: 'newer-than-retention' },
    ]);
    expect(result.value.diagnostics).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')).toBe(before);
  });

  test('requires a real selector for apply and treats non-boolean apply as dry-run', () => {
    const dir = cawsDir();
    writeLedger(dir, [
      message('delivered', 'me', 'peer', '2026-09-04T09:00:00.000Z'),
      delivery('delivered'),
    ]);

    for (const olderThanMs of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = pruneMessages(dir, {
        status: 'delivered',
        olderThanMs,
        apply: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.lifecycle.plan_rejected');
    }
    const truthy = pruneMessages(dir, {
      status: 'delivered',
      include: ['delivered'],
      apply: 1,
    });
    expect(truthy.ok).toBe(true);
    expect(truthy.value).toMatchObject({ apply: false, applied: false, pruned_messages: 0 });
    expect(readLedger(dir).map((entry) => entry.record)).toEqual(['message', 'delivery']);
  });

  test('archives first and writes an exact empty live ledger when every record is selected', () => {
    const dir = cawsDir();
    const sent = message('only', 'me', 'peer', '2026-09-04T09:00:00.000Z');
    const receipt = delivery('only');
    writeLedger(dir, [sent, receipt]);

    const result = pruneMessages(dir, {
      status: 'delivered',
      include: ['only'],
      apply: true,
    });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      applied: true,
      pruned_messages: 1,
      pruned_delivery_records: 1,
      delivery_records_to_remove: 1,
    });
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')).toBe('');
    const archive = readLedger(dir, 'messages.jsonl.archive');
    expect(archive).toHaveLength(3);
    expect(archive[0]).toMatchObject({ record: 'prune', ids: ['only'] });
    expect(archive.slice(1)).toEqual([sent, receipt]);
  });

  test('an archive append failure leaves the live ledger byte-identical', () => {
    const dir = cawsDir();
    writeLedger(dir, [
      message('only', 'me', 'peer', '2026-09-04T09:00:00.000Z'),
      delivery('only'),
    ]);
    const before = fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8');
    fs.mkdirSync(path.join(dir, 'messages.jsonl.archive'));

    const result = pruneMessages(dir, {
      status: 'delivered',
      include: ['only'],
      apply: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.messages.archive_append_failed');
    expect(result.errors[0].message).toContain('messages.jsonl.archive');
    expect(fs.readFileSync(path.join(dir, 'messages.jsonl'), 'utf8')).toBe(before);
  });
});

describe('platformEngagement', () => {
  test('attributes lease, actor, and unknown platforms with exact ratios', () => {
    const dir = cawsDir();
    writeLease(dir, 'alice', 'alpha');
    writeLease(dir, 'bob', 'beta');
    writeLease(dir, 'actor-only', 'delta');
    writeLease(dir, 'no-platform', undefined);
    writeLedger(dir, [
      message('leased', 'alice', 'bob', '2026-09-04T09:00:00.000Z'),
      message('actor-platform', 'unused', 'missing', '2026-09-04T09:01:00.000Z', {
        actorId: 'actor-only',
        withoutSession: true,
        platform: 'gamma',
      }),
      message('actor-fallback', 'unused', 'missing', '2026-09-04T09:01:30.000Z', {
        actorId: 'unleased-actor',
        withoutSession: true,
        platform: 'gamma',
      }),
      message('unknown-sender', 'missing-sender', 'bob', '2026-09-04T09:02:00.000Z'),
      message('missing-platform', 'alice', 'no-platform', '2026-09-04T09:03:00.000Z'),
      delivery('leased'),
      '{bad json',
    ]);

    const result = platformEngagement(dir);

    expect(result).toEqual({
      ok: true,
      value: {
        beta: { to: 2, from: 0, ratio: 0 },
        alpha: { to: 0, from: 2, ratio: null },
        unknown: { to: 3, from: 1, ratio: 1 / 3 },
        delta: { to: 0, from: 1, ratio: null },
        gamma: { to: 0, from: 1, ratio: null },
      },
    });
  });

  test('an empty ledger produces no inferred platform buckets', () => {
    expect(platformEngagement(cawsDir())).toEqual({ ok: true, value: {} });
  });
});

describe('delivery state and channel history', () => {
  test('uses the matching delivery timestamp and ignores unrelated record shapes', () => {
    const dir = cawsDir();
    const target = message('target', 'alice', 'bob', '2026-09-04T09:00:00.000Z');
    writeLedger(dir, [
      delivery('target', '2026-09-04T10:00:00.000Z'),
      { record: 'delivery', deliver_id: 42, ts: '2026-09-04T10:01:00.000Z' },
      message('other', 'alice', 'bob', '2026-09-04T09:01:00.000Z'),
      target,
      delivery('other', '2026-09-04T10:02:00.000Z'),
      delivery('target', '2026-09-04T10:03:00.000Z'),
      { record: 'refusal', id: 'ignored' },
    ]);

    expect(getMessageDeliveryState(dir, 'target')).toEqual({
      ok: true,
      value: {
        message: target,
        delivered: true,
        deliveredAt: '2026-09-04T10:03:00.000Z',
      },
    });
    expect(getMessageDeliveryState(dir, 'missing')).toEqual({ ok: true, value: null });
  });

  test('reports an exact undelivered state without manufacturing deliveredAt', () => {
    const dir = cawsDir();
    const target = message('target', 'alice', 'bob', '2026-09-04T09:00:00.000Z');
    writeLedger(dir, [target, delivery('different')]);

    expect(getMessageDeliveryState(dir, 'target')).toEqual({
      ok: true,
      value: { message: target, delivered: false },
    });
  });

  test('channel history is normalized, bidirectional, ordered, and first-delivery-wins', () => {
    const dir = cawsDir();
    const first = message('first', 'alice', 'bob', '2026-09-04T09:00:00.000Z');
    const reverse = message('reverse', 'bob', 'alice', '2026-09-04T09:01:00.000Z');
    const other = message('other', 'alice', 'carol', '2026-09-04T09:02:00.000Z');
    writeLedger(dir, [
      delivery('first', '2026-09-04T10:00:00.000Z'),
      first,
      reverse,
      other,
      delivery('first', '2026-09-04T11:00:00.000Z'),
      delivery('other', '2026-09-04T11:01:00.000Z'),
      '{bad json',
    ]);

    expect(channelHistory(dir, 'bob', 'alice')).toEqual({
      ok: true,
      value: [
        { ...first, delivered: true, deliveredAt: '2026-09-04T10:00:00.000Z' },
        { ...reverse, delivered: false },
      ],
    });
    expect(channelHistory(dir, 'alice', 'nobody')).toEqual({ ok: true, value: [] });
  });

  test('propagates shared ledger read errors through derived read models', () => {
    const dir = cawsDir();
    fs.mkdirSync(path.join(dir, 'messages.jsonl'));

    for (const result of [
      inboxAllMessages(dir),
      mineQueued(dir, 'me', 0),
      platformEngagement(dir),
      getMessageDeliveryState(dir, 'id'),
      channelHistory(dir, 'a', 'b'),
    ]) {
      expect(result.ok).toBe(false);
      expect(result.errors[0].rule).toBe('store.messages.log_unreadable');
    }
  });
});
