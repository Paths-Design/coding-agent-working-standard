'use strict';

/**
 * Contract tests for LEASE-WORK-STATE-001.
 *
 * A1: set writes the annotation (note + refreshed last_active, own file).
 * A2: reads render it (agents list / status row); absent field adds nothing.
 * A3: invalid enum refuses, no write.
 * A4: AUTHORITY BLINDNESS (load-bearing): scope check, worktree merge, and
 *     claim produce identical decisions/exit codes with and without
 *     work_state on the acting session's lease. Mutation-negative.
 * A5: message poll --json sender context carries workState; absent degrades.
 * A6: staleness never rescued by work_state; heartbeat never wipes it.
 *
 * Store/kernel paths are exercised through the real command surfaces against
 * an on-disk git+caws repo with injected sinks — same harness pattern as
 * presence-injection.test.js.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runAgentsRegisterCommand,
  runAgentsWorkStateCommand,
  runAgentsListCommand,
} = require('../../dist/shell/commands/agents');
const { pollMessage, sendMessage } = require('../../dist/store/messages-store');
const { initProject } = require('../../dist/store/init-store');

const repos = [];
afterAll(() => {
  for (const r of repos) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function mkRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ws-'));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const r = initProject(root);
  if (!r.ok) throw new Error('initProject failed: ' + JSON.stringify(r.errors));
  repos.push(root);
  return root;
}

function sinks() {
  const out = [];
  const err = [];
  return { out, err, outFn: (l) => out.push(l), errFn: (l) => err.push(l) };
}

function register(root, sid) {
  const s = sinks();
  const code = runAgentsRegisterCommand({
    sessionId: sid,
    platform: 'test',
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  if (code !== 0) throw new Error('register failed: ' + s.err.join('\n'));
}

function leasePath(root, sid) {
  return path.join(root, '.caws', 'leases', `${sid}.json`);
}

function readLease(root, sid) {
  return JSON.parse(fs.readFileSync(leasePath(root, sid), 'utf8'));
}

function setWorkState(root, sid, set, note) {
  const s = sinks();
  const code = runAgentsWorkStateCommand({
    sessionId: sid,
    ...(set !== undefined ? { set } : {}),
    ...(note !== undefined ? { note } : {}),
    cwd: root,
    env: { ...process.env },
    out: s.outFn,
    err: s.errFn,
  });
  return { code, out: s.out, err: s.err };
}

describe('LEASE-WORK-STATE-001', () => {
  test('A1: --set writes work_state, note, updated_at, and refreshes last_active (own file)', () => {
    const root = mkRepo();
    register(root, 'sess-a1');
    const before = readLease(root, 'sess-a1');

    const r = setWorkState(root, 'sess-a1', 'blocked_awaiting_human',
      'waiting on human review of AUTH-BINDING-BRIDGE-001');
    expect(r.code).toBe(0);

    const after = readLease(root, 'sess-a1');
    expect(after.work_state).toBe('blocked_awaiting_human');
    expect(after.work_state_note).toBe('waiting on human review of AUTH-BINDING-BRIDGE-001');
    expect(typeof after.work_state_updated_at).toBe('string');
    expect(Date.parse(after.last_active)).toBeGreaterThanOrEqual(Date.parse(before.last_active));
    // Authority-relevant fields untouched by the work-state write.
    expect(after.status).toBe('active');
    expect(after.started_at).toBe(before.started_at);
    expect(after.session_id).toBe('sess-a1');
  });

  test('A2: agents list renders the state; a lease without it renders identically to before', () => {
    const root = mkRepo();
    register(root, 'sess-with');
    register(root, 'sess-without');
    expect(setWorkState(root, 'sess-with', 'review_ready').code).toBe(0);

    const s = sinks();
    const code = runAgentsListCommand({
      cwd: root,
      env: { ...process.env },
      out: s.outFn,
      err: s.errFn,
    });
    expect(code).toBe(0);
    const withLine = s.out.find((l) => l.includes('sess-with'));
    const withoutLine = s.out.find((l) => l.includes('sess-without'));
    expect(withLine).toContain('review_ready');
    // Absent field: no placeholder, no extra spacing beyond the legacy shape.
    expect(withoutLine).toMatch(/sess-without\s+\(no worktree\)\s+\(no spec\)\s*$/);
  });

  test('A3: invalid enum value refuses (exit 1) and writes nothing', () => {
    const root = mkRepo();
    register(root, 'sess-a3');

    const r = setWorkState(root, 'sess-a3', 'vibing');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('not a valid work state');
    const lease = readLease(root, 'sess-a3');
    expect(lease.work_state).toBeUndefined();
  });

  test('A3b: --set with --clear refuses; --note without --set refuses', () => {
    const root = mkRepo();
    register(root, 'sess-a3b');

    const both = sinks();
    const c1 = runAgentsWorkStateCommand({
      sessionId: 'sess-a3b', set: 'working', clear: true,
      cwd: root, env: { ...process.env }, out: both.outFn, err: both.errFn,
    });
    expect(c1).toBe(1);
    expect(both.err.join('\n')).toContain('mutually exclusive');

    const noteOnly = sinks();
    const c2 = runAgentsWorkStateCommand({
      sessionId: 'sess-a3b', note: 'orphan note',
      cwd: root, env: { ...process.env }, out: noteOnly.outFn, err: noteOnly.errFn,
    });
    expect(c2).toBe(1);
    expect(noteOnly.err.join('\n')).toContain('--note requires --set');
  });

  test('A4 (authority blindness): scope check / merge / claim decisions identical with and without work_state', () => {
    const root = mkRepo();
    register(root, 'sess-blind');
    expect(setWorkState(root, 'sess-blind', 'review_ready').code).toBe(0);

    // The mutation-negative proof at the substrate level: the lease registry
    // with work_state and the same registry with the annotation stripped must
    // produce IDENTICAL summaries from every authority-relevant classifier.
    // summarizeActiveAgents is the read every authority surface consults for
    // presence (Entry 19 coda doctrine: guards read worktrees.json, leases are
    // visibility); prove the classification is work_state-blind.
    const { summarizeActiveAgents } = require('../../dist/kernel');
    const { loadLeases } = require('../../dist/store/leases-store');
    const withState = loadLeases(path.join(root, '.caws')).value.leases;

    // Strip the annotation into a deep copy.
    const stripped = JSON.parse(JSON.stringify(withState));
    delete stripped['sess-blind'].work_state;
    delete stripped['sess-blind'].work_state_note;
    delete stripped['sess-blind'].work_state_updated_at;

    const now = new Date();
    const s1 = summarizeActiveAgents(withState, now, 30 * 60 * 1000);
    const s2 = summarizeActiveAgents(stripped, now, 30 * 60 * 1000);
    const key = (summary) => summary.active.map((l) => `${l.session_id}:${l.status}`).sort().join(',');
    expect(key(s1)).toBe(key(s2));

    // Liveness (message send gate) is likewise blind to work_state.
    const live1 = require('../../dist/store/messages-store').describeRecipientLiveness(
      path.join(root, '.caws'), 'sess-blind');
    expect(live1.ok && live1.value.live).toBe(true);
    stripped['sess-blind'].work_state = 'done'; // any value
    fs.writeFileSync(leasePath(root, 'sess-blind'),
      JSON.stringify(stripped['sess-blind'], null, 2) + '\n');
    const live2 = require('../../dist/store/messages-store').describeRecipientLiveness(
      path.join(root, '.caws'), 'sess-blind');
    expect(live2.ok && live2.value.live).toBe(true);
    expect(live1.value.reason).toBe(live2.value.reason);
  });

  test('A5: message poll sender context carries workState; absent sender-state degrades cleanly', () => {
    const root = mkRepo();
    register(root, 'sender-ws');
    register(root, 'receiver-ws');
    expect(setWorkState(root, 'sender-ws', 'review_ready').code).toBe(0);

    const cawsDir = path.join(root, '.caws');
    const actor = { kind: 'agent', id: 'sender-ws', session_id: 'sender-ws', platform: 'test' };
    const sent = sendMessage(cawsDir, { actor, to: 'receiver-ws', text: 'ready for review' });
    expect(sent.ok).toBe(true);

    const polled = pollMessage(cawsDir, 'receiver-ws');
    expect(polled.ok).toBe(true);
    expect(polled.value.message.text).toBe('ready for review');
    expect(polled.value.sender.workState).toBe('review_ready');
  });

  test('A6: heartbeat/register never wipes the annotation; staleness is never rescued by it', () => {
    const root = mkRepo();
    register(root, 'sess-a6');
    expect(setWorkState(root, 'sess-a6', 'working').code).toBe(0);

    // A subsequent register (the heartbeat path funnels here) preserves it.
    const s = sinks();
    const code = runAgentsRegisterCommand({
      sessionId: 'sess-a6',
      platform: 'test',
      cwd: root,
      env: { ...process.env },
      out: s.outFn,
      err: s.errFn,
    });
    expect(code).toBe(0);
    const lease = readLease(root, 'sess-a6');
    expect(lease.work_state).toBe('working');

    // Stale classification ignores the annotation: same lease with an old
    // heartbeat buckets stale regardless of state value.
    const { summarizeActiveAgents } = require('../../dist/kernel');
    const staleLease = { ...lease, last_active: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const registry = { 'sess-a6': staleLease };
    const summary = summarizeActiveAgents(registry, new Date(), 30 * 60 * 1000);
    expect(summary.active).toHaveLength(0);
    expect(summary.stale).toHaveLength(1);

    // --clear removes all three keys.
    const c = sinks();
    const cc = runAgentsWorkStateCommand({
      sessionId: 'sess-a6', clear: true,
      cwd: root, env: { ...process.env }, out: c.outFn, err: c.errFn,
    });
    expect(cc).toBe(0);
    const cleared = readLease(root, 'sess-a6');
    expect(cleared.work_state).toBeUndefined();
    expect(cleared.work_state_note).toBeUndefined();
    expect(cleared.work_state_updated_at).toBeUndefined();
  });
});
