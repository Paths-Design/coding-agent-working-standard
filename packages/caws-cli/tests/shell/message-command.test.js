/**
 * Command-level tests for `caws message send/poll`
 * (AGENT-MESSAGE-CHANNEL-002 A3).
 *
 * The store is unit + mutation tested elsewhere; this suite proves the THIN
 * handlers — the part only manual e2e had covered: exact exit codes (0/1/2),
 * --allow-dead bypass, --peek non-consumption, and --wait long-poll — by driving
 * runMessageSendCommand / runMessagePollCommand against a real on-disk git+caws
 * repo with injected stdout/stderr sinks. Assertions are on exit codes and emitted
 * lines, not mocks.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runMessageSendCommand,
  runMessagePollCommand,
} = require('../../dist/shell/commands/message');
const { initProject } = require('../../dist/store/init-store');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-msgcmd-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

/** Write a live lease so `sid` is a valid recipient. */
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

/** Capture sinks + a fixed sender identity via env. */
function io(root, sessionId, extra = {}) {
  const out = [];
  const err = [];
  return {
    out,
    err,
    opts: {
      cwd: root,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId },
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      ...extra,
    },
  };
}

// ─── send: exit codes ────────────────────────────────────────────────────────

test('send to a live recipient returns exit 0 and reports the channel', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  const { out, opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'bob', text: 'hi bob' });
  expect(code).toBe(0);
  expect(out.join('\n')).toMatch(/sent to bob/);
});

test('send to a non-live recipient returns exit 1 and does not write the log', () => {
  const root = mkRepo();
  const { err, opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'ghost', text: 'anyone?' });
  expect(code).toBe(1);
  expect(err.join('\n')).toMatch(/not live|not sent/i);
  expect(fs.existsSync(path.join(root, '.caws', 'messages.jsonl'))).toBe(false);
});

test('send with --allow-dead bypasses the liveness check and returns exit 0', () => {
  const root = mkRepo();
  const { opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'ghost', text: 'forced', allowDead: true });
  expect(code).toBe(0);
});

test('send with empty --text returns exit 1', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  const { opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'bob', text: '' });
  expect(code).toBe(1);
});

test('send with empty --to returns exit 1', () => {
  const root = mkRepo();
  const { opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: '', text: 'x' });
  expect(code).toBe(1);
});

test('send outside a git repo returns exit 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-nogit-'));
  repos.push(tmp);
  const out = [], err = [];
  const code = runMessageSendCommand({
    cwd: tmp,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'alice' },
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    to: 'bob',
    text: 'x',
  });
  expect(code).toBe(2);
});

// ─── poll: exit codes + delivery ─────────────────────────────────────────────

test('poll returns exit 0 and the message text for the recipient', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  runMessageSendCommand({ ...io(root, 'alice').opts, to: 'bob', text: 'hello bob' });
  const { out, opts } = io(root, 'bob');
  const code = runMessagePollCommand({ ...opts });
  expect(code).toBe(0);
  expect(out.join('\n')).toMatch(/from alice/);
  expect(out.join('\n')).toMatch(/hello bob/);
});

test('poll on an empty mailbox returns exit 0 and "(no messages)"', () => {
  const root = mkRepo();
  const { out, opts } = io(root, 'bob');
  const code = runMessagePollCommand({ ...opts });
  expect(code).toBe(0);
  expect(out.join('\n')).toMatch(/no messages/);
});

test('poll outside a git repo returns exit 2', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-nogit-'));
  repos.push(tmp);
  const code = runMessagePollCommand({
    cwd: tmp,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'bob' },
    out: () => {},
    err: () => {},
  });
  expect(code).toBe(2);
});

// ─── --peek: read without consuming ──────────────────────────────────────────

test('poll --peek shows the message without consuming it; a later poll still delivers it', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  runMessageSendCommand({ ...io(root, 'alice').opts, to: 'bob', text: 'peek me' });

  const peek = io(root, 'bob');
  expect(runMessagePollCommand({ ...peek.opts, peek: true })).toBe(0);
  expect(peek.out.join('\n')).toMatch(/peek me/);
  expect(peek.out.join('\n')).toMatch(/not consumed/);

  // the normal poll AFTER the peek still gets it
  const real = io(root, 'bob');
  expect(runMessagePollCommand({ ...real.opts })).toBe(0);
  expect(real.out.join('\n')).toMatch(/peek me/);

  // now it's consumed — a third poll is empty
  const third = io(root, 'bob');
  runMessagePollCommand({ ...third.opts });
  expect(third.out.join('\n')).toMatch(/no messages/);
});

// ─── --wait: long-poll blocks then returns on arrival ────────────────────────

test('poll --wait returns on the first attempt when a message is already waiting', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  runMessageSendCommand({ ...io(root, 'alice').opts, to: 'bob', text: 'already here' });
  const { out, opts } = io(root, 'bob');

  // The long-poll loop sleeps ONLY when it is about to retry, so observing that
  // no sleep happened proves the poll returned on its first attempt — the
  // behavior this test exists to pin. Elapsed wall-clock time cannot prove it:
  // an assertion like `Date.now() - t0 < 1500` measures the machine's load, and
  // reddened this suite under full-suite CPU contention while the code was
  // correct. Nothing else in this fixture contends for the message-log lock, so
  // the lock helper's own retry sleep is not reachable here.
  // [CAWS-DEFECT-TEST-VERDICT-INTEGRITY-01]
  const repoRoot = require('../../dist/store/repo-root');
  const sleepSpy = jest.spyOn(repoRoot, 'sleepSyncMs');
  try {
    const code = runMessagePollCommand({ ...opts, waitMs: 2000 });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/already here/);
    expect(sleepSpy).not.toHaveBeenCalled();
  } finally {
    sleepSpy.mockRestore();
  }
});

test('poll --wait on an empty mailbox retries until the window closes, then returns "(no messages)"', () => {
  const root = mkRepo();
  const { out, opts } = io(root, 'bob');

  // Positive control for the sibling test above: the same spy DOES record the
  // retry sleep when the loop runs, so `not.toHaveBeenCalled()` there is a real
  // assertion about the code and not a spy that never intercepted anything.
  const repoRoot = require('../../dist/store/repo-root');
  const sleepSpy = jest.spyOn(repoRoot, 'sleepSyncMs');
  const t0 = Date.now();
  try {
    const code = runMessagePollCommand({ ...opts, waitMs: 300 });
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/no messages/);
    expect(sleepSpy).toHaveBeenCalled();
  } finally {
    sleepSpy.mockRestore();
  }
  // it actually waited ~the window (not instant), proving the long-poll loop ran
  expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
});
