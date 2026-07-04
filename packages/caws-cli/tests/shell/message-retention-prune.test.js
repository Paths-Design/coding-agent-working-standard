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
  test('metadata exposes dry-run-first delivered-message prune leaf', () => {
    const prune = messageMeta().subcommands.find((subcommand) => subcommand.name === 'prune');

    expect(prune).toBeTruthy();
    expect(prune.description).toContain('Dry-run by default');
    expect(prune.description).toContain('undelivered inbox messages are preserved');
    expect(prune.options.map((option) => option.flag)).toEqual(expect.arrayContaining([
      '--status <status>',
      '--older-than-ms <ms>',
      '--include <ids>',
      '--exclude <ids>',
      '--apply',
      '--json',
    ]));
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
    const deliveredId = messageRecords(root).find((record) => record.record === 'message' && record.text === 'delivered').id;

    const result = runPrune(root, { status: 'delivered', include: [deliveredId], apply: true, json: true });

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
    expect(records.some((record) => record.record === 'message' && record.text === 'delivered')).toBe(false);
    expect(records.some((record) => record.record === 'delivery' && record.deliver_id === deliveredId)).toBe(false);
    expect(records.some((record) => record.record === 'message' && record.text === 'waiting')).toBe(true);
  });
});
