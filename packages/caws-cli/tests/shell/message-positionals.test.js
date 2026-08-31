'use strict';

/**
 * CAWS-DEFECT-MSG-REPLY-POSITIONAL-01 — full CLI parse path.
 *
 * The heartbeat hook injection text teaches `caws message reply <message_id>
 * --text ...` and the predecessor spec's ACs use the positional form, but the
 * MESSAGE reply/status leaves declared options only — guardExcessArguments
 * computed 0 declared positionals and refused every positional invocation
 * with "unexpected extra argument(s)". Handler-level tests call the command
 * functions directly and bypass Commander, which is why this shipped
 * undetected. These tests spawn dist/index.js so the
 * argument-declaration/enforcement agreement itself is pinned.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');

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
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform: 'test',
      status: 'active',
      last_active: new Date().toISOString(),
      repo_root: root,
    })
  );
}

function ledger(root) {
  const file = path.join(root, '.caws', 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function spawnCli(root, args, sessionId = 'reply-positional-test') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
  });
}

/** Sender 'peer' sends one message to `recipient` and returns its id. */
function seedMessage(root, sender, recipient) {
  makeLive(root, sender);
  makeLive(root, recipient);
  const r = spawnCli(root, ['message', 'send', '--to', recipient, '--text', 'hello'], sender);
  if (r.status !== 0) throw new Error('seed send failed: ' + r.stderr);
  const sent = ledger(root).find((l) => l.record === 'message');
  return sent.id;
}

test('A1: `message reply <message_id>` positional form replies with reply_to linkage', () => {
  const root = mkRepo();
  const mid = seedMessage(root, 'peer', 'reply-positional-test');
  const r = spawnCli(root, ['message', 'reply', mid, '--text', 'the answer']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/replied to peer/);
  expect(r.stdout).toMatch(new RegExp(`reply to ${mid}`));
  const answer = ledger(root).find((l) => l.record === 'message' && l.text === 'the answer');
  expect(answer.reply_to).toBe(mid);
});

test('A2: `message reply --id <message_id>` flag form still works identically', () => {
  const root = mkRepo();
  const mid = seedMessage(root, 'peer', 'reply-positional-test');
  const r = spawnCli(root, ['message', 'reply', '--id', mid, '--text', 'flag answer']);
  expect(r.status).toBe(0);
  const answer = ledger(root).find((l) => l.record === 'message' && l.text === 'flag answer');
  expect(answer.reply_to).toBe(mid);
});

test('A3: positional and --id that differ are refused with nothing written', () => {
  const root = mkRepo();
  const mid = seedMessage(root, 'peer', 'reply-positional-test');
  const before = ledger(root).length;
  const r = spawnCli(root, ['message', 'reply', mid, '--id', 'different-id', '--text', 'x']);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/conflicting message ids/);
  expect(ledger(root)).toHaveLength(before);
  // agreeing forms proceed
  const agree = spawnCli(root, ['message', 'reply', mid, '--id', mid, '--text', 'agree']);
  expect(agree.status).toBe(0);
});

test('A4: `message status <message_id>` positional matches the --id form; neither still refuses', () => {
  const root = mkRepo();
  const mid = seedMessage(root, 'peer', 'reply-positional-test');
  const pos = spawnCli(root, ['message', 'status', mid]);
  const flag = spawnCli(root, ['message', 'status', '--id', mid]);
  expect(pos.status).toBe(0);
  expect(flag.status).toBe(0);
  expect(pos.stdout).toBe(flag.stdout);
  const posJson = spawnCli(root, ['message', 'status', mid, '--json']);
  const flagJson = spawnCli(root, ['message', 'status', '--id', mid, '--json']);
  expect(posJson.stdout).toBe(flagJson.stdout);
  const neither = spawnCli(root, ['message', 'status']);
  expect(neither.status).toBe(1);
  expect(neither.stderr).toMatch(/required/);
});

test('A5: two positionals on reply are refused by the excess-args guard, nothing applied', () => {
  const root = mkRepo();
  const mid = seedMessage(root, 'peer', 'reply-positional-test');
  const before = ledger(root).length;
  const r = spawnCli(root, ['message', 'reply', mid, 'extra-token', '--text', 'x']);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/unexpected extra argument|takes at most 1 positional/);
  expect(ledger(root)).toHaveLength(before);
});

test('A6: reply and status help show the optional positional form', () => {
  const root = mkRepo();
  const replyHelp = spawnCli(root, ['message', 'reply', '--help']);
  const statusHelp = spawnCli(root, ['message', 'status', '--help']);
  expect(replyHelp.status).toBe(0);
  expect(statusHelp.status).toBe(0);
  expect(replyHelp.stdout).toMatch(/\[message_id\]/);
  expect(statusHelp.stdout).toMatch(/\[message_id\]/);
});
