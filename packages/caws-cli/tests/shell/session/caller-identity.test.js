'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveCallerSession,
  resolveSessionCandidates,
  admitsOwner,
} = require('../../../dist/shell/session/resolve-session');
let root, cawsDir;
const now = () => new Date('2026-09-07T07:00:00Z');
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-caller-'));
  cawsDir = path.join(root, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'sessions'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function resolve(extra = {}) {
  return resolveCallerSession({ cawsDir, worktreeRoot: root, env: {}, now, ...extra });
}
function cache(id) {
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', `${id}.json`),
    JSON.stringify({
      session_id: id,
      platform: 'codex',
      worktree_root: root,
      minted_at: now().toISOString(),
    })
  );
  const dir = path.join(cawsDir, 'sessions', id);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, '.session-envelope.json'),
    JSON.stringify({
      session_id: id,
      repo_root: root,
      platform: 'codex',
      last_seen_at: now().toISOString(),
    })
  );
}

test.each([1, 2])('%i cached sessions and a caller pointer cannot identify a caller', (count) => {
  for (const id of ['owner', 'neighbor'].slice(0, count)) cache(id);
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', '.caller-session.json'),
    JSON.stringify({
      session_id: 'owner',
      repo_root: root,
      last_seen_at: now().toISOString(),
    })
  );
  const result = resolve();
  expect(result.ok).toBe(false);
  expect(result.errors[0].message).toContain('Resume the original harness session');
  const candidates = resolveSessionCandidates({ cawsDir, env: {}, now });
  expect(candidates.candidates).toEqual([]);
  expect(admitsOwner(candidates, 'owner')).toBeNull();
});

test.each([
  [{ CAWS_SESSION_ID: 'caller', CODEX_THREAD_ID: 'neighbor' }, 'caller'],
  [
    { CAWS_AGENT_SURFACE: 'codex', CODEX_THREAD_ID: 'caller', CAWS_SESSION_ID: 'neighbor' },
    'caller',
  ],
  [{ CAWS_AGENT_SURFACE: 'qwen-code', QWEN_CODE_SESSION_ID: 'caller' }, 'caller'],
  [{ DSH_SESSION_ID: 'caller' }, 'caller'],
  [{ HOOK_SESSION_ID: 'caller' }, 'caller'],
  [{ CURSOR_TRACE_ID: 'caller' }, 'caller'],
])('ownership comparison respects the caller precedence for %j', (env, expected) => {
  cache('neighbor');
  cache('caller');
  expect(resolve({ env }).value.identity.session_id).toBe(expected);
  const candidates = resolveSessionCandidates({ cawsDir, env, now });
  expect([...new Set(candidates.candidates.map((c) => c.identity.session_id))]).toEqual([expected]);
  expect(admitsOwner(candidates, 'neighbor')).toBeNull();
});

test.each([
  'CLAUDE_SESSION_ID',
  'CODEX_THREAD_ID',
  'CAWS_SESSION_ID',
  'HOOK_SESSION_ID',
  'CURSOR_TRACE_ID',
])('the unknown sentinel in %s cannot identify a caller', (key) => {
  cache('owner');
  expect(resolve({ env: { [key]: 'unknown' } }).ok).toBe(false);
  expect(resolveSessionCandidates({ cawsDir, env: { [key]: 'unknown' }, now }).candidates).toEqual(
    []
  );
});

test('correlated live process identity survives competing caches; reused PID refuses', () => {
  cache('neighbor');
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', 'agent-pid-123.json'),
    JSON.stringify({
      session_id: 'caller',
      surface: 'codex',
      started_at: 42,
    })
  );
  const options = {
    agentProcessNames: ['fixture-agent'],
    agentPidWalkFn: () => ({ pid: 123, startEpoch: 42 }),
  };
  const result = resolve(options);
  expect(result.ok).toBe(true);
  expect(result.value.identity).toEqual({ session_id: 'caller', platform: 'codex' });
  const candidates = resolveSessionCandidates({ cawsDir, env: {}, now, ...options });
  expect(admitsOwner(candidates, 'caller').identity.session_id).toBe('caller');
  expect(admitsOwner(candidates, 'neighbor')).toBeNull();
  const reused = { ...options, agentPidWalkFn: () => ({ pid: 123, startEpoch: 43 }) };
  expect(resolve(reused).ok).toBe(false);
  expect(resolveSessionCandidates({ cawsDir, env: {}, now, ...reused }).candidates).toEqual([]);
});

const invalidStarts = [
  undefined,
  null,
  'not-a-time',
  '',
  '42',
  false,
  {},
  [],
  -1,
  0,
  42.5,
  NaN,
  Infinity,
];
test.each(
  invalidStarts.flatMap((value, index) => [
    [`record-${index}`, value, 42],
    [`observation-${index}`, 42, value],
  ])
)('incomplete or invalid PID instance evidence refuses: %s', (_label, recorded, observed) => {
  cache('owner');
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', 'agent-pid-123.json'),
    JSON.stringify({
      session_id: 'owner',
      started_at: recorded,
    })
  );
  const options = {
    agentProcessNames: ['fixture-agent'],
    agentPidWalkFn: () => ({ pid: 123, startEpoch: observed }),
  };
  expect(resolve(options).ok).toBe(false);
  expect(resolveSessionCandidates({ cawsDir, env: {}, now, ...options }).candidates).toEqual([]);
  // Explicit caller context must still work when PID evidence cannot identify it.
  for (const env of [{ CAWS_SESSION_ID: 'caller' }, { CURSOR_TRACE_ID: 'caller' }]) {
    const identified = resolve({ ...options, env });
    expect(identified.ok).toBe(true);
    expect(identified.value.identity.session_id).toBe('caller');
    expect(
      admitsOwner(resolveSessionCandidates({ cawsDir, env, now, ...options }), 'owner')
    ).toBeNull();
  }
});

test('an old record still identifies the same live process instance without a TTL', () => {
  fs.writeFileSync(
    path.join(cawsDir, 'sessions', 'agent-pid-123.json'),
    JSON.stringify({
      session_id: 'caller',
      started_at: 42,
      last_seen_at: '2000-01-01T00:00:00Z',
    })
  );
  const options = {
    agentProcessNames: ['fixture-agent'],
    agentPidWalkFn: () => ({ pid: 123, startEpoch: 42 }),
  };
  expect(resolve(options).value.identity.session_id).toBe('caller');
  expect(
    admitsOwner(resolveSessionCandidates({ cawsDir, env: {}, now, ...options }), 'caller').identity
      .session_id
  ).toBe('caller');
});

test('explicit mint creates a new caller instead of resuming a cached owner', () => {
  cache('owner');
  const result = resolve({ allowMint: true, mintIdSuffix: () => 'caller-fixture' });
  expect(result.ok).toBe(true);
  expect(result.value.source).toBe('minted');
  expect(result.value.identity.session_id).not.toBe('owner');
  const continued = resolve({ env: { CAWS_SESSION_ID: result.value.identity.session_id } });
  expect(continued.value.identity.session_id).toBe(result.value.identity.session_id);
});

test('a lifecycle comparison reuses its resolved actor if process correlation changes later', () => {
  const record = path.join(cawsDir, 'sessions', 'agent-pid-123.json');
  fs.writeFileSync(record, JSON.stringify({ session_id: 'caller', started_at: 42 }));
  const options = {
    agentProcessNames: ['fixture-agent'],
    agentPidWalkFn: () => ({ pid: 123, startEpoch: 42 }),
  };
  const actor = resolve(options);
  expect(actor.ok).toBe(true);
  fs.writeFileSync(record, JSON.stringify({ session_id: 'neighbor', started_at: 42 }));
  const candidates = resolveSessionCandidates({
    cawsDir,
    env: {},
    now,
    ...options,
    caller: actor.value,
  });
  expect(admitsOwner(candidates, 'caller').identity.session_id).toBe('caller');
  expect(admitsOwner(candidates, 'neighbor')).toBeNull();
});
