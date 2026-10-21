'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { pollAgentMessages } = require('../../dist/application/message-poll');
const store = require('../../dist/store/messages-store');

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-poll-application-'));
  dirs.push(dir);
  return dir;
}
function send(dir, text, urgency) {
  const result = store.sendMessage(dir, {
    actor: { kind: 'agent', id: 'sender', session_id: 'sender' },
    to: 'recipient',
    text,
    requireLive: false,
    ...(urgency ? { urgency } : {}),
  });
  expect(result.ok).toBe(true);
  return result;
}
function input(dir, options = {}) {
  let time = 100;
  return { cawsDir: dir, recipient: 'recipient', options, nowMs: () => (time += 7) };
}

test('real canonical queue is critical-first; offered occurrences remain queued until settlement', () => {
  const dir = directory();
  send(dir, 'older normal');
  send(dir, 'newer critical', 'critical');
  const first = pollAgentMessages(input(dir, { receipt: 'auto', offer: true, drain: 1 }));
  expect(first.ok).toBe(true);
  expect(first.value.message.text).toBe('newer critical');
  expect(first.value.messages.map((entry) => entry.message.text)).toEqual(['newer critical']);
  expect(first.value).toMatchObject({
    waiting: 2,
    poll_ms: 7,
    mine_queued_1h: { count: 0, oldest_age_ms: null },
    offer: { recipient: 'recipient' },
  });
  expect(store.inboxCount(dir, 'recipient')).toEqual({ ok: true, value: 2 });
  const offer = first.value.offer;
  expect(store.settleMessageOffer(dir, offer.id, 'recipient', 'released').ok).toBe(true);
  const retry = pollAgentMessages(input(dir, { receipt: 'auto', offer: true, drain: 1 }));
  expect(retry.ok).toBe(true);
  expect(retry.value.message.id).toBe(first.value.message.id);
  expect(retry.value.offer.id).not.toBe(offer.id);
  expect(store.settleMessageOffer(dir, retry.value.offer.id, 'recipient', 'delivered').ok).toBe(
    true
  );
  const next = pollAgentMessages(input(dir, { offer: false, drain: 5 }));
  expect(next.ok).toBe(true);
  expect(next.value.messages.map((entry) => entry.message.text)).toEqual(['older normal']);
  expect(next.value.waiting).toBe(0);
});

test('supplementary dead-letter count includes my old sent messages without inbound mail', () => {
  const dir = directory();
  fs.writeFileSync(
    path.join(dir, 'messages.jsonl'),
    JSON.stringify({
      record: 'message',
      id: 'old-sent',
      actor: { kind: 'agent', id: 'recipient', session_id: 'recipient' },
      to: 'other',
      channel: 'other::recipient',
      text: 'awaiting reply',
      ts: new Date(Date.now() - 7200000).toISOString(),
    }) + '\n'
  );
  const result = pollAgentMessages(input(dir, { offer: true, drain: 5 }));
  expect(result.ok).toBe(true);
  expect(result.value.message).toBeNull();
  expect(result.value.messages).toEqual([]);
  expect(result.value.waiting).toBe(0);
  expect(result.value.mine_queued_1h.count).toBe(1);
  expect(result.value.mine_queued_1h.oldest_age_ms).toBeGreaterThanOrEqual(7200000);
});

test('command option admission and supplemental failure defaults preserve exact output projection', () => {
  const dir = directory();
  const pollMessage = jest.fn(() => ({
    ok: true,
    value: { message: null, messages: [], diagnostics: [] },
  }));
  const mineQueued = jest.fn(() => ({ ok: false, errors: [] }));
  const result = pollAgentMessages(
    input(dir, {
      waitMs: -1,
      drain: 5.9,
      receipt: 'auto',
      offer: true,
      offerTtlMs: NaN,
      peek: false,
    }),
    {
      pollMessage,
      inboxCount: () => ({ ok: false, errors: [] }),
      mineQueued,
    }
  );
  expect(pollMessage).toHaveBeenCalledWith(dir, 'recipient', {
    drain: 5,
    receipt: 'auto',
    offer: true,
  });
  expect(mineQueued).toHaveBeenCalledWith(dir, 'recipient', 3600000);
  expect(result).toEqual({
    ok: true,
    value: {
      message: null,
      messages: [],
      waiting: null,
      poll_ms: 7,
      mine_queued_1h: { count: 0, oldest_age_ms: null },
    },
  });
  expect(JSON.stringify(result.value)).toBe(
    '{"message":null,"messages":[],"waiting":null,"poll_ms":7,"mine_queued_1h":{"count":0,"oldest_age_ms":null}}'
  );
});

test('failed primary poll retains diagnostics and skips supplemental reads', () => {
  const errors = [{ rule: 'fixture.poll', severity: 'error', message: 'primary read refused' }];
  const inboxCount = jest.fn();
  const mineQueued = jest.fn();
  const result = pollAgentMessages(input(directory()), {
    pollMessage: () => ({ ok: false, errors }),
    inboxCount,
    mineQueued,
  });
  expect(result).toEqual({ ok: false, stage: 'poll', errors });
  expect(inboxCount).not.toHaveBeenCalled();
  expect(mineQueued).not.toHaveBeenCalled();
});
