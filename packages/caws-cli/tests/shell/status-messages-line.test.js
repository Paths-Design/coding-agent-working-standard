'use strict';

/**
 * CAWS-MESSAGE-LEDGER-COMPLETENESS-001 A6: `caws status` surfaces queued mail
 * as one summary line when undelivered messages exist, and nothing extra when
 * the ledger is empty. Status stays read-only: the line must not consume mail.
 */

const fs = require('fs');
const path = require('path');

const { initProject } = require('../../dist/store/init-store');
const { runStatusCommand } = require('../../dist/shell/commands/status');
const { sendMessage } = require('../../dist/store/messages-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return { root, caws: path.join(root, '.caws') };
}

function makeLive(cawsDir, sid) {
  const leasesDir = path.join(cawsDir, 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform: 'test',
      status: 'active',
      last_active: new Date().toISOString(),
      repo_root: path.dirname(cawsDir),
    })
  );
}

function readLedger(cawsDir) {
  const file = path.join(cawsDir, 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

test('A6: status prints a messages summary line when undelivered mail exists', () => {
  const { root, caws } = mkRepo();
  makeLive(caws, 'r1');
  const sent = sendMessage(caws, {
    actor: { kind: 'agent', id: 's1', session_id: 's1' },
    to: 'r1',
    text: 'still queued',
  });
  expect(sent.ok).toBe(true);
  const out = [];
  const code = runStatusCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 's1' },
    out: (s) => out.push(s),
    err: () => {},
  });
  expect(code).toBe(0);
  expect(out.join('\n')).toMatch(/messages: 1 undelivered \(oldest \d+s ago\)/);
  // read-only: the message is still undelivered after status ran
  const ledger = readLedger(caws);
  expect(ledger.some((l) => l.record === 'delivery')).toBe(false);
});

test('A6: status prints no messages line when nothing is queued', () => {
  const { root, caws } = mkRepo();
  // one message, already consumed
  makeLive(caws, 'r1');
  const sent = sendMessage(caws, {
    actor: { kind: 'agent', id: 's1', session_id: 's1' },
    to: 'r1',
    text: 'consumed',
  });
  expect(sent.ok).toBe(true);
  fs.appendFileSync(
    path.join(caws, 'messages.jsonl'),
    JSON.stringify({ record: 'delivery', deliver_id: sent.value.message.id, ts: new Date().toISOString(), mode: 'poll' }) + '\n'
  );
  const out = [];
  const code = runStatusCommand({
    cwd: root,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 's1' },
    out: (s) => out.push(s),
    err: () => {},
  });
  expect(code).toBe(0);
  expect(out.join('\n')).not.toMatch(/messages: \d+ undelivered/);
});
