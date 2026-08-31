'use strict';

/**
 * CAWS-MESSAGE-BEHAVIOR-001 — CLI parse path + hook renderer.
 *
 * Pins the behavior surface end to end: silent-platform engagement badges in
 * agents list, the sender-side dead-letter view (`status --mine --queued`),
 * the poll JSON mine_queued_1h signal, and the hook's throttled dead-letter
 * escalation (even with zero inbound mail). The hook renderer is extracted
 * from the live template and run as a real node subprocess, so the exact
 * bytes the agent sees are what is asserted.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { initProject } = require('../../dist/store/init-store');
const { cleanupAll, makeTempRepo } = require('../helpers/git-repo-factory');

const CLI = path.resolve(__dirname, '..', '..', 'dist', 'index.js');
const HOOK_TEMPLATE = path.resolve(
  __dirname,
  '..',
  '..',
  'templates',
  'hook-packs',
  'shared',
  'agent-heartbeat.sh'
);

afterAll(() => {
  cleanupAll();
});

function mkRepo() {
  const root = makeTempRepo();
  const initialized = initProject(root);
  if (!initialized.ok) throw new Error('initProject failed: ' + JSON.stringify(initialized.errors));
  return root;
}

function spawnCli(root, args, sessionId = 'behavior-test') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
  });
}

function writeLease(root, sid, platform) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform,
      status: 'active',
      started_at: '2026-07-04T10:00:00.000Z',
      last_active: new Date().toISOString(),
      repo_root: root,
      cwd: root,
      git_common_dir: path.join(root, '.git'),
      git_dir: path.join(root, '.git'),
      hostname: os.hostname(),
      last_seen_reason: 'manual_register',
    })
  );
}

function appendMessage(root, { from, to, text, ts, urgency }) {
  const file = path.join(root, '.caws', 'messages.jsonl');
  fs.appendFileSync(
    file,
    JSON.stringify({
      record: 'message',
      id: require('crypto').randomUUID(),
      actor: { kind: 'agent', id: from, session_id: from },
      to,
      channel: [from, to].sort().join('::'),
      text,
      ts: ts || new Date().toISOString(),
      ...(urgency !== undefined ? { urgency } : {}),
    }) + '\n'
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

function extractRenderer() {
  const src = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  const anchor = 'HEARTBEAT_MSG_TELEMETRY="$PROJECT_DIR_FOR_CACHE/.caws/leases/heartbeat-message-telemetry.jsonl" HEARTBEAT_ESCALATION_STATE="$PROJECT_DIR_FOR_CACHE/.caws/leases/heartbeat-escalation-state.json" node -e \'';
  const start = src.indexOf(anchor);
  if (start === -1) throw new Error('renderer anchor not found in template');
  const body = src.slice(start + anchor.length);
  const end = body.indexOf("' 2>/dev/null)");
  if (end === -1) throw new Error('renderer terminator not found in template');
  return body.slice(0, end);
}

function runRenderer(pollJson, env = {}) {
  const script = extractRenderer();
  return spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify(pollJson),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('A1: agents list badges silent platforms (>=5 to, ratio <= 0.2)', () => {
  const root = mkRepo();
  writeLease(root, 'z1', 'zcode');
  writeLease(root, 'c1', 'claude-code');
  writeLease(root, 'me', 'claude-code');
  for (let i = 0; i < 6; i++) appendMessage(root, { from: 'me', to: 'z1', text: `to-z-${i}` });
  appendMessage(root, { from: 'z1', to: 'me', text: 'one reply from z' });
  for (let i = 0; i < 4; i++) appendMessage(root, { from: 'me', to: 'c1', text: `to-c-${i}` });
  for (let i = 0; i < 4; i++) appendMessage(root, { from: 'c1', to: 'me', text: `from-c-${i}` });

  const text = spawnCli(root, ['agents', 'list']);
  expect(text.status).toBe(0);
  expect(text.stdout).toMatch(/silent-platform: zcode \(6 to, 1 from\)/);
  expect(text.stdout).not.toMatch(/silent-platform: claude-code/);

  const json = spawnCli(root, ['agents', 'list', '--json']);
  expect(json.status).toBe(0);
  const parsed = JSON.parse(json.stdout);
  expect(parsed.silent_platforms).toEqual(
    expect.arrayContaining([{ platform: 'zcode', to: 6, from: 1 }])
  );
  // display-only: the ledger is untouched by listing
  expect(ledger(root)).toHaveLength(15);
});

test('A2: status --mine --queued lists only the aged dead letters', () => {
  const root = mkRepo();
  writeLease(root, 'behavior-test', 'claude-code');
  writeLease(root, 'ghost', 'zcode');
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const fresh = new Date().toISOString();
  appendMessage(root, { from: 'behavior-test', to: 'ghost', text: 'aged dead letter', ts: old });
  appendMessage(root, { from: 'behavior-test', to: 'ghost', text: 'still fresh', ts: fresh });

  const text = spawnCli(root, ['message', 'status', '--mine', '--queued']);
  expect(text.status).toBe(0);
  expect(text.stdout).toMatch(/aged dead letter/);
  expect(text.stdout).not.toMatch(/still fresh/);

  const json = spawnCli(root, ['message', 'status', '--mine', '--queued', '--json']);
  expect(json.status).toBe(0);
  const parsed = JSON.parse(json.stdout);
  expect(parsed.count).toBe(1);
  expect(parsed.messages[0].message.text).toBe('aged dead letter');
  // read-only: no delivery records appended
  expect(ledger(root).filter((l) => l.record === 'delivery')).toHaveLength(0);
});

test('A3: poll --json carries mine_queued_1h without consuming', () => {
  const root = mkRepo();
  writeLease(root, 'behavior-test', 'claude-code');
  writeLease(root, 'ghost', 'zcode');
  const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  appendMessage(root, { from: 'behavior-test', to: 'ghost', text: 'aged dead letter', ts: old });

  const r = spawnCli(root, ['message', 'poll', '--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.mine_queued_1h.count).toBe(1);
  expect(typeof parsed.mine_queued_1h.oldest_age_ms).toBe('number');
  expect(ledger(root).filter((l) => l.record === 'delivery')).toHaveLength(0);
});

test('A4: the hook escalates dead letters once per count (throttled), even with no inbound mail', () => {
  const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-beh-')), 'state.json');
  const pollJson = {
    message: null,
    messages: [],
    waiting: 0,
    mine_queued_1h: { count: 2, oldest_age_ms: 7200000 },
  };
  const env = {
    HEARTBEAT_MSG_TELEMETRY: path.join(path.dirname(stateFile), 'tel.jsonl'),
    HEARTBEAT_ESCALATION_STATE: stateFile,
    HOOK_SESSION_ID: 'me',
  };
  const first = runRenderer(pollJson, env);
  expect(first.status).toBe(0);
  expect(first.stdout).toMatch(/2 of YOUR sent messages are still undelivered after 1h/);
  expect(first.stdout).toMatch(/status --mine --queued/);
  // second run, same count, within the throttle window -> silent
  const second = runRenderer(pollJson, env);
  expect(second.status).toBe(0);
  expect(second.stdout).toBe('');
  // count change -> re-emits with the new count
  const third = runRenderer(
    { ...pollJson, mine_queued_1h: { count: 1, oldest_age_ms: 7200000 } },
    env
  );
  expect(third.status).toBe(0);
  expect(third.stdout).toMatch(/1 of YOUR sent messages are still undelivered after 1h/);
});

test('A5: status --help documents the dead-letter flags', () => {
  const root = mkRepo();
  const r = spawnCli(root, ['message', 'status', '--help']);
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/--mine/);
  expect(r.stdout).toMatch(/--older-than-ms/);
});
