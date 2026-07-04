'use strict';

const fs = require('fs');
const path = require('path');

const {
  runMessageSendCommand,
  runMessagePollCommand,
  runMessageInboxCommand,
  runMessageHistoryCommand,
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
  if (code !== 0) {
    throw new Error(`send failed: ${err.join('\n')}`);
  }
}

function runPoll(root, me, opts = {}) {
  const out = [];
  const err = [];
  const code = runMessagePollCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: me },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runInbox(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runMessageInboxCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function runHistory(root, opts = {}) {
  const out = [];
  const err = [];
  const code = runMessageHistoryCommand({
    cwd: root,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...opts,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function messagesBytes(root) {
  const p = path.join(root, '.caws', 'messages.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
}

function messageMeta() {
  return COMMAND_SURFACE_METADATA.find((command) => command.name === 'message');
}

describe('caws message inbox/history readback', () => {
  test('metadata exposes read-only inbox and history leaves', () => {
    const leaves = messageMeta().subcommands.map((subcommand) => subcommand.name);
    expect(leaves).toEqual(expect.arrayContaining(['send', 'poll', 'inbox', 'history']));
    const inbox = messageMeta().subcommands.find((subcommand) => subcommand.name === 'inbox');
    const history = messageMeta().subcommands.find((subcommand) => subcommand.name === 'history');
    expect(inbox.description).toContain('Read-only');
    expect(history.description).toContain('Read-only');
  });

  test('inbox lists undelivered messages without consuming them', () => {
    const root = mkRepo();
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'first');
    runSend(root, 'alice', 'bob', 'second');
    runSend(root, 'alice', 'bob', 'third');
    expect(runPoll(root, 'bob').code).toBe(0);
    const before = messagesBytes(root);

    const result = runInbox(root, { me: 'bob', json: true, limit: 1 });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      me: 'bob',
      waiting: 2,
    });
    expect(payload.messages.map((message) => message.text)).toEqual(['second']);
    expect(messagesBytes(root)).toBe(before);

    const afterPoll = runPoll(root, 'bob');
    expect(afterPoll.out).toContain('second');
  });

  test('history returns bidirectional channel messages with recent limit and no delivery append', () => {
    const root = mkRepo();
    makeLive(root, 'alice');
    makeLive(root, 'bob');
    runSend(root, 'alice', 'bob', 'one');
    runSend(root, 'bob', 'alice', 'two');
    runSend(root, 'alice', 'bob', 'three');
    expect(runPoll(root, 'bob').code).toBe(0);
    const before = messagesBytes(root);

    const result = runHistory(root, { me: 'alice', with: 'bob', json: true, limit: 2 });

    expect(result.code).toBe(0);
    const payload = JSON.parse(result.out);
    expect(payload).toMatchObject({
      ok: true,
      read_only: true,
      me: 'alice',
      with: 'bob',
      total: 3,
    });
    expect(payload.messages.map((message) => message.text)).toEqual(['two', 'three']);
    expect(messagesBytes(root)).toBe(before);
  });
});
