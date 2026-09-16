'use strict';

const fs = require('fs');
const path = require('path');

const {
  runMessageSendCommand,
  runMessagePollCommand,
  runMessagePruneCommand,
} = require('../../dist/shell/commands/message');
const { initProject } = require('../../dist/store/init-store');
const { COMMAND_SURFACE_METADATA } = require('../../dist/shell/command-metadata');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function makeLive(root, sid) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify(
      {
        lease_version: 1,
        session_id: sid,
        platform: 'test',
        status: 'active',
        last_active: new Date().toISOString(),
        repo_root: root,
      },
      null,
      2
    ) + '\n'
  );
}

function runSend(root, from, to, text) {
  const out = [];
  const err = [];
  const code = runMessageSendCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: from },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    to,
    text,
  });
  if (code !== 0) throw new Error(`send failed: ${err.join('\n')}`);
}

function runPoll(root, me) {
  const out = [];
  const err = [];
  const code = runMessagePollCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: me },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  if (code !== 0) throw new Error(`poll failed: ${err.join('\n')}`);
}

function runPrune(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runMessagePruneCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function messagesBytes(root) {
  const p = path.join(root, '.caws', 'messages.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function messageRecords(root) {
  return messagesBytes(root)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function messageMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'message');
}

describe('caws message prune retention cleanup', () => {
  test('metadata exposes dry-run-first prune leaf with both selectors', () => {
    const prune = messageMeta().subcommands.find((subcommand) => subcommand.name === 'prune');

    expect(prune).toBeTruthy();
    // CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01 superseded the prior
    // "undelivered inbox messages are preserved" wording: undelivered
    // messages to verifiably-dead recipients ARE prunable now, so the
    // description states the deliver-once boundary instead.
    expect(prune.description).toContain('Dry-run by default');
    expect(prune.description).toContain('undelivered-to-dead-session');
    expect(prune.description).toContain('preserved');
    const status = prune.options.find((option) => option.flag === '--status <status>');
    expect(status.allowedValues).toEqual(['delivered', 'undelivered-to-dead-session']);
    expect(prune.options.map((option) => option.flag)).toEqual(
      expect.arrayContaining([
        '--status <status>',
        '--older-than-ms <ms>',
        '--include <ids>',
        '--exclude <ids>',
        '--apply',
        '--json',
      ])
    );
  });

  test('dry-run reports delivered candidates and skipped undelivered messages without mutation', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'delivered');
    runSend(root, 'alice', 'bob', 'waiting');
    runPoll(root, 'bob');
    const before = messagesBytes(root);

    const result = runPrune(root, { status: 'delivered', json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({ ok: true, dry_run: true, applied: false });
    expect(payload.candidates.map((entry) => entry.text)).toEqual(['delivered']);
    expect(payload.skipped.map((entry) => [entry.text, entry.reason])).toEqual([
      ['waiting', 'undelivered'],
    ]);
    expect(messagesBytes(root)).toBe(before);
  });

  test('apply requires an explicit retention selector', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'delivered');
    runPoll(root, 'bob');
    const before = messagesBytes(root);

    const result = runPrune(root, { status: 'delivered', apply: true, json: true });

    expect(result.code).toBe(1);
    expect(result.err).toContain('requires --older-than-ms or --include');
    expect(messagesBytes(root)).toBe(before);
  });

  test('apply prunes only selected delivered messages and their delivery markers', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'delivered');
    runSend(root, 'alice', 'bob', 'waiting');
    runPoll(root, 'bob');
    const deliveredId = messageRecords(root).find(
      (record) => record.record === 'message' && record.text === 'delivered'
    ).id;

    const result = runPrune(root, {
      status: 'delivered',
      include: [deliveredId],
      apply: true,
      json: true,
    });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      dry_run: false,
      applied: true,
      pruned_messages: 1,
      pruned_delivery_records: 1,
    });
    const records = messageRecords(root);
    expect(
      records.some((record) => record.record === 'message' && record.text === 'delivered')
    ).toBe(false);
    expect(
      records.some((record) => record.record === 'delivery' && record.deliver_id === deliveredId)
    ).toBe(false);
    expect(records.some((record) => record.record === 'message' && record.text === 'waiting')).toBe(
      true
    );
  });
});

describe('caws message prune dead-recipient selector (CAWS-DEFECT-MESSAGE-PRUNE-DEAD-RECIPIENT-01)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** Seed an old undelivered message straight into the ledger (sends to dead
   *  recipients are refused by design, so retention fixtures write records). */
  function seedDeadLetter(root, { id, to, ageDays = 10 }) {
    fs.appendFileSync(
      path.join(root, '.caws', 'messages.jsonl'),
      JSON.stringify({
        record: 'message',
        id,
        actor: { kind: 'agent', id: 'alice', session_id: 'alice', platform: 'test' },
        to,
        channel: ['alice', to].sort().join('::'),
        text: id,
        ts: new Date(Date.now() - ageDays * DAY_MS).toISOString(),
      }) + '\n'
    );
  }

  test('A6-refusal: a bare --status undelivered is refused naming the accepted values, without mutation', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'waiting');
    const before = messagesBytes(root);

    const result = runPrune(root, { status: 'undelivered' });

    expect(result.code).toBe(1);
    expect(result.err).toContain('delivered or undelivered-to-dead-session');
    expect(result.err).toContain('refused on purpose');
    expect(messagesBytes(root)).toBe(before);
  });

  test('A6-dry-run: dead-recipient candidates are listed with the floor; live recipients preserved; nothing written', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'live-fresh');
    // An OLD undelivered message to a LIVE recipient (past the floor, so the
    // liveness check is what preserves it) plus an old dead letter.
    seedDeadLetter(root, { id: 'live-old', to: 'bob' });
    seedDeadLetter(root, { id: 'dead-1', to: 'gone-session' });
    const before = messagesBytes(root);

    const result = runPrune(root, { status: 'undelivered-to-dead-session', json: true });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({ ok: true, dry_run: true, applied: false });
    expect(payload.dead_recipient_floor_ms).toBe(7 * DAY_MS);
    expect(payload.candidates.map((entry) => entry.id)).toEqual(['dead-1']);
    expect(payload.skipped.map((entry) => [entry.text, entry.reason])).toEqual(
      expect.arrayContaining([
        ['live-old', 'recipient-live'],
        ['live-fresh', 'newer-than-floor'],
      ])
    );
    expect(messagesBytes(root)).toBe(before);
  });

  test('A6-apply: the dead letter is pruned and archived with a selector marker; the live message survives', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    seedDeadLetter(root, { id: 'live-old', to: 'bob' });
    seedDeadLetter(root, { id: 'dead-1', to: 'gone-session' });

    const result = runPrune(root, { status: 'undelivered-to-dead-session', apply: true });

    expect(result.code).toBe(0);
    expect(result.out).toContain('status=undelivered-to-dead-session');
    expect(result.out).toContain('Pruned 1 undelivered message(s) to dead recipient(s)');
    expect(result.out).toContain('Preserved 1 message(s) for live or idle recipient(s)');
    const records = messageRecords(root);
    expect(records.some((record) => record.record === 'message' && record.id === 'dead-1')).toBe(
      false
    );
    expect(records.some((record) => record.record === 'message' && record.id === 'live-old')).toBe(
      true
    );
    const archive = fs.readFileSync(path.join(root, '.caws', 'messages.jsonl.archive'), 'utf8');
    expect(archive).toContain('"selector":"undelivered-to-dead-session"');
  });
});
