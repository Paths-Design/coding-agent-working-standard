'use strict';

/**
 * CAWS-MESSAGE-DELIVERY-ECONOMICS-001 — CLI parse path + hook renderer.
 *
 * Pins the delivery-economics contract end to end: critical-first polling,
 * --urgency validation, legacy compatibility, and the heartbeat hook's
 * renderer (single CRITICAL prefix vs multi-message digest + telemetry
 * sidecar). The hook renderer is extracted from the live template and run as
 * a real node subprocess against canned poll JSON, so the exact bytes the
 * agent sees are what is asserted.
 */

const fs = require('fs');
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

function spawnCli(root, args, sessionId = 'econ-test') {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
  });
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

/** Extract the hook's inline `node -e '...'` message renderer script from the template. */
function extractRenderer() {
  const src = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  // The template has TWO node -e blocks; anchor at the message-renderer's
  // telemetry env assignment, which only the message block uses (it may be
  // followed by the escalation-state env added in CAWS-MESSAGE-BEHAVIOR-001).
  const envAnchor = 'HEARTBEAT_MSG_TELEMETRY="$PROJECT_DIR_FOR_CACHE/.caws/leases/heartbeat-message-telemetry.jsonl"';
  const envStart = src.indexOf(envAnchor);
  if (envStart === -1) throw new Error('message renderer anchor not found in template');
  const marker = "node -e '";
  const start = src.indexOf(marker, envStart);
  if (start === -1) throw new Error('message renderer marker not found after env anchor');
  const body = src.slice(start + marker.length);
  const end = body.indexOf("' 2>/dev/null)");
  if (end === -1) throw new Error('renderer terminator not found in template');
  return body.slice(0, end);
}

function runRenderer(pollJson, env = {}) {
  const script = extractRenderer();
  const r = spawnSync(process.execPath, ['-e', script], {
    input: JSON.stringify(pollJson),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return r;
}

test('A1: the oldest critical message polls first through the CLI', () => {
  const root = mkRepo();
  makeLive(root, 'econ-test');
  makeLive(root, 'peer');
  expect(spawnCli(root, ['message', 'send', '--to', 'econ-test', '--text', 'old normal'], 'peer').status).toBe(0);
  expect(spawnCli(root, ['message', 'send', '--to', 'econ-test', '--text', 'new normal'], 'peer').status).toBe(0);
  expect(spawnCli(root, ['message', 'send', '--urgency', 'critical', '--to', 'econ-test', '--text', 'STOP'], 'peer').status).toBe(0);
  const r = spawnCli(root, ['message', 'poll', '--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.message.text).toBe('STOP');
  expect(parsed.message.urgency).toBe('critical');
});

test('A4: --urgency critical is ledgered; bogus is refused with a ledgered refusal', () => {
  const root = mkRepo();
  makeLive(root, 'econ-test');
  makeLive(root, 'peer');
  const ok = spawnCli(root, ['message', 'send', '--urgency', 'critical', '--to', 'econ-test', '--text', 'x'], 'peer');
  expect(ok.status).toBe(0);
  const bogus = spawnCli(root, ['message', 'send', '--urgency', 'bogus', '--to', 'econ-test', '--text', 'x'], 'peer');
  expect(bogus.status).toBe(1);
  expect(bogus.stdout).toMatch(/not sent — invalid urgency/);
  const records = ledger(root);
  expect(records.find((l) => l.record === 'message').urgency).toBe('critical');
  const refusal = records.find((l) => l.record === 'refusal');
  expect(refusal.class).toBe('urgency_invalid');
});

test('A6: legacy records without urgency read clean through history --json', () => {
  const root = mkRepo();
  makeLive(root, 'econ-test');
  makeLive(root, 'peer');
  expect(spawnCli(root, ['message', 'send', '--to', 'econ-test', '--text', 'legacy'], 'peer').status).toBe(0);
  const r = spawnCli(root, ['message', 'history', '--with', 'peer', '--json']);
  expect(r.status).toBe(0);
  const parsed = JSON.parse(r.stdout);
  expect(parsed.messages).toHaveLength(1);
  expect(parsed.messages[0].urgency).toBeUndefined();
});

test('A5: hook renderer emits the CRITICAL prefix for one urgent message', () => {
  const telemetry = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'caws-econ-tel-')), 'tel.jsonl');
  const pollJson = {
    message: {
      record: 'message',
      id: 'm-1',
      actor: { kind: 'agent', id: 'peer' },
      to: 'me',
      channel: 'me::peer',
      text: 'STOP before destroying worktree X',
      ts: new Date().toISOString(),
      urgency: 'critical',
    },
    messages: [
      {
        message: {
          record: 'message',
          id: 'm-1',
          actor: { kind: 'agent', id: 'peer' },
          to: 'me',
          channel: 'me::peer',
          text: 'STOP before destroying worktree X',
          ts: new Date().toISOString(),
          urgency: 'critical',
        },
      },
    ],
    waiting: 0,
    poll_ms: 12,
  };
  const r = runRenderer(pollJson, {
    HEARTBEAT_MSG_TELEMETRY: telemetry,
    HOOK_SESSION_ID: 'me',
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/CRITICAL MESSAGE from another Claude Code session \(id peer\)/);
  expect(r.stdout).toMatch(/not verified fact/);
  const lines = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0].injected_count).toBe(1);
  expect(lines[0].poll_ms).toBe(12);
  expect(lines[0].session_id).toBe('me');
});

test('A5: hook renderer emits one digest block for a drained backlog', () => {
  const telemetry = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'caws-econ-tel-')), 'tel.jsonl');
  const mk = (id, text, urgency) => ({
    record: 'message',
    id,
    actor: { kind: 'agent', id: 'peer' },
    to: 'me',
    channel: 'me::peer',
    text,
    ts: new Date().toISOString(),
    ...(urgency !== undefined ? { urgency } : {}),
  });
  const pollJson = {
    message: mk('m-1', 'first line of one', undefined),
    messages: [{ message: mk('m-1', 'first line of one', undefined) }, { message: mk('m-2', 'urgent thing', 'critical') }],
    waiting: 1,
    poll_ms: 7,
  };
  const r = runRenderer(pollJson, {
    HEARTBEAT_MSG_TELEMETRY: telemetry,
    HOOK_SESSION_ID: 'me',
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/2 messages received \(oldest first\):/);
  expect(r.stdout).toMatch(/m-1 from peer: first line of one/);
  expect(r.stdout).toMatch(/m-2 \[CRITICAL\] from peer: urgent thing/);
  expect(r.stdout).toMatch(/Full text: caws message status/);
  expect(r.stdout).toMatch(/1 more message\(s\) waiting/);
  const lines = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0].injected_count).toBe(2);
  expect(lines[0].waiting).toBe(1);
});

test('A5: the hook template polls with --drain 5 and --receipt auto', () => {
  const src = fs.readFileSync(HOOK_TEMPLATE, 'utf8');
  expect(src).toMatch(/--receipt auto/);
  expect(src).toMatch(/--drain 5/);
});
