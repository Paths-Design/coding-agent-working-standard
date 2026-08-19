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

// ─── CAWS-MESSAGE-DELIVERY-UX-001: idle delivery, stdout verdicts, reply,
// status, aliases, sender context ────────────────────────────────────────────

const {
  runMessageReplyCommand,
  runMessageStatusCommand,
  runMessageHistoryCommand,
} = require('../../dist/shell/commands/message');

/** Write a lease with optional bindings / status / age (ms ago). */
function makeBound(root, sid, { worktree, spec, status = 'active', ageMs = 1000 }) {
  const leasesDir = path.join(root, '.caws', 'leases');
  fs.mkdirSync(leasesDir, { recursive: true });
  fs.writeFileSync(
    path.join(leasesDir, `${sid}.json`),
    JSON.stringify({
      lease_version: 1,
      session_id: sid,
      platform: 'test',
      status,
      last_active: new Date(Date.now() - ageMs).toISOString(),
      repo_root: root,
      ...(worktree !== undefined ? { bound_worktree: worktree } : {}),
      ...(spec !== undefined ? { bound_spec_id: spec } : {}),
    })
  );
}

/** Parse .caws/messages.jsonl into records. */
function readLog(root) {
  const file = path.join(root, '.caws', 'messages.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('UX A1: send to an idle (stopped, fresh-heartbeat) recipient succeeds with an idle note', () => {
  const root = mkRepo();
  makeBound(root, 'sleeper', { status: 'stopped', ageMs: 2 * 60 * 1000 });
  const { out, opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'sleeper', text: 'you up?' });
  expect(code).toBe(0);
  const stdout = out.join('\n');
  expect(stdout).toMatch(/sent to sleeper/);
  expect(stdout).toMatch(/idle between turns/);
});

test('UX A3: a refused send is observable on stdout even with stderr discarded', () => {
  const root = mkRepo();
  const { out, opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'ghost', text: 'anyone?' });
  expect(code).toBe(1);
  const stdout = out.join('\n');
  expect(stdout).toMatch(/not sent — recipient not live/);
  // and still nothing was written
  expect(fs.existsSync(path.join(root, '.caws', 'messages.jsonl'))).toBe(false);
});

test('UX A4: reply sends to the original sender on the same channel', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  makeLive(root, 'alice'); // the reply recipient must be live too
  const { opts } = io(root, 'alice');
  expect(runMessageSendCommand({ ...opts, to: 'bob', text: 'question' })).toBe(0);
  const original = readLog(root).find((r) => r.record === 'message');
  expect(original).toBeDefined();

  const bobIo = io(root, 'bob');
  const code = runMessageReplyCommand({ ...bobIo.opts, id: original.id, text: 'answer' });
  expect(code).toBe(0);
  expect(bobIo.out.join('\n')).toMatch(new RegExp(`replied to alice .*reply to ${original.id}`));
  const reply = readLog(root).filter((r) => r.record === 'message')[1];
  expect(reply.to).toBe('alice');
  expect(reply.channel).toBe(original.channel); // same normalized channel
});

test('UX A4: reply refuses an unknown message id and a self-reply', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  const { opts } = io(root, 'alice');
  expect(runMessageSendCommand({ ...opts, to: 'bob', text: 'hi' })).toBe(0);
  const original = readLog(root).find((r) => r.record === 'message');

  const unknown = io(root, 'bob');
  expect(runMessageReplyCommand({ ...unknown.opts, id: 'no-such-id', text: 'x' })).toBe(1);
  expect(unknown.out.join('\n')).toMatch(/not sent — message not found/);

  const self = io(root, 'alice'); // alice replying to her own message
  expect(runMessageReplyCommand({ ...self.opts, id: original.id, text: 'note to self' })).toBe(1);
  expect(self.out.join('\n')).toMatch(/not sent — reply-to-self refused/);
});

test('UX A5: status reports undelivered then delivered; history annotates both', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  const { opts } = io(root, 'alice');
  expect(runMessageSendCommand({ ...opts, to: 'bob', text: 'observe' })).toBe(0);
  const original = readLog(root).find((r) => r.record === 'message');

  const before = io(root, 'alice');
  expect(runMessageStatusCommand({ ...before.opts, id: original.id })).toBe(0);
  expect(before.out.join('\n')).toMatch(/delivered: no \(still queued/);

  const asJson = io(root, 'alice');
  expect(runMessageStatusCommand({ ...asJson.opts, id: original.id, json: true })).toBe(0);
  const parsed = JSON.parse(asJson.out.join('\n'));
  expect(parsed.delivered).toBe(false);
  expect(parsed.read_only).toBe(true);

  // bob consumes it
  const poll = io(root, 'bob');
  expect(runMessagePollCommand({ ...poll.opts })).toBe(0);

  const after = io(root, 'alice');
  expect(runMessageStatusCommand({ ...after.opts, id: original.id })).toBe(0);
  expect(after.out.join('\n')).toMatch(/delivered: yes \(at /);

  const hist = io(root, 'alice');
  expect(runMessageHistoryCommand({ ...hist.opts, with: 'bob' })).toBe(0);
  expect(hist.out.join('\n')).toMatch(/\[delivered/);

  const histJson = io(root, 'alice');
  expect(runMessageHistoryCommand({ ...histJson.opts, with: 'bob', json: true })).toBe(0);
  const histParsed = JSON.parse(histJson.out.join('\n'));
  expect(histParsed.messages[0].delivered).toBe(true);
});

test('UX A6: --to wt:<worktree> resolves and sends; an unbound alias is refused on stdout', () => {
  const root = mkRepo();
  makeBound(root, 'bound-agent', { worktree: 'wt-demo', spec: 'SPEC-1' });
  const { out, opts } = io(root, 'alice');
  const code = runMessageSendCommand({ ...opts, to: 'wt:wt-demo', text: 'via alias' });
  expect(code).toBe(0);
  const stdout = out.join('\n');
  expect(stdout).toMatch(/alias wt:wt-demo -> session bound-agent/);
  expect(stdout).toMatch(/sent to bound-agent/);

  const specIo = io(root, 'alice');
  expect(runMessageSendCommand({ ...specIo.opts, to: 'spec:SPEC-1', text: 'via spec' })).toBe(0);
  expect(specIo.out.join('\n')).toMatch(/sent to bound-agent/);

  const gone = io(root, 'alice');
  expect(runMessageSendCommand({ ...gone.opts, to: 'wt:wt-gone', text: 'nobody' })).toBe(1);
  expect(gone.out.join('\n')).toMatch(/not sent — recipient alias unresolved/);
  expect(gone.err.join('\n')).toMatch(/wt:wt-gone/);
});

test('UX A7: poll renders registry-derived sender context (worktree + spec)', () => {
  const root = mkRepo();
  makeLive(root, 'bob');
  makeBound(root, 'alice', { worktree: 'wt-alice', spec: 'SPEC-A' });
  const { opts } = io(root, 'alice');
  expect(runMessageSendCommand({ ...opts, to: 'bob', text: 'who am I' })).toBe(0);

  const bobIo = io(root, 'bob');
  expect(runMessagePollCommand({ ...bobIo.opts })).toBe(0);
  expect(bobIo.out.join('\n')).toMatch(/from alice \(worktree wt-alice, spec SPEC-A\):/);
});
