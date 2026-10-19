const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { AbortController } = globalThis;
const {
  RuntimeFrameReader,
  writeRuntimeFrame,
  decodeHandoff,
} = require('../../dist/runtime/live-protocol');
const { capturedRefusal } = require('../../dist/runtime/engine');
const { HandlerExecutionError } = require('../../dist/runtime/handler-executor');
const { InvocationJournal } = require('../../dist/runtime/journal');
const { AdvisoryDedup } = require('../../dist/runtime/advisory-dedup');
const { resolveInvocationIdentity } = require('../../dist/runtime/identity');

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-engine-core-')));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
const identity = { id: 'invocation-one', runtimeDigest: 'a'.repeat(64) };
function request(sid = 'session-one') {
  return {
    ...identity,
    inputJson: '{}',
    payload: { session_id: sid },
    surface: 'codex',
    event: 'pre_tool_use',
    caller: {
      cwd: root,
      processId: process.pid,
      environment: {
        CODEX_THREAD_ID: 'neighbor',
        CAWS_SESSION_ID: 'other',
        HOOK_SESSION_ID: 'stale',
      },
    },
  };
}

test('aborted work read leaves the same outstanding input for the subsequent wire phase', async () => {
  const input = new PassThrough();
  const reader = new RuntimeFrameReader(input, 1024);
  const work = new AbortController();
  const waiting = reader.read(work.signal);
  const reason = new Error('work deadline');
  work.abort(reason);
  await expect(waiting).rejects.toBe(reason);
  input.end('{"ack":true}\n{"next":1}\n');
  expect((await reader.read()).toString()).toBe('{"ack":true}');
  expect((await reader.read()).toString()).toBe('{"next":1}');
  await expect(reader.read()).rejects.toThrow('before a complete frame');
});

test('control frames reject wrong proposal tokens and extra keys', () => {
  const ack = {
    schema: 'caws.runtime.handoff.v1',
    ...identity,
    token: 'proposal-one',
    success: true,
  };
  const bytes = (value) => Buffer.from(JSON.stringify(value));
  expect(decodeHandoff(bytes(ack), identity, 'proposal-one')).toBe(true);
  expect(decodeHandoff(bytes({ ...ack, success: false }), identity, 'proposal-one')).toBe(false);
  for (const changed of [
    { ...ack, token: 'neighbor' },
    { ...ack, id: 'neighbor' },
    { ...ack, extra: true },
    { ...ack, success: 1 },
  ])
    expect(() => decodeHandoff(bytes(changed), identity, 'proposal-one')).toThrow();
});

test('frame writer rejects an actual failing Writable without an unhandled stream error', async () => {
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('fixture EPIPE'));
    },
  });
  await expect(writeRuntimeFrame(output, identity, new AbortController().signal)).rejects.toThrow(
    'fixture EPIPE'
  );
  await new Promise((accept) => setImmediate(accept));
});

test('known bare exit two survives receipt failure without requiring JSON stdout', () => {
  const failure = new HandlerExecutionError(
    'bad receipt',
    Buffer.alloc(0),
    Buffer.from('real guard\n'),
    [],
    Buffer.alloc(0),
    Buffer.alloc(0),
    2
  );
  const kept = capturedRefusal(failure);
  expect(kept.exitCode).toBe(2);
  expect(kept.stdout).toEqual(Buffer.alloc(0));
  expect(kept.stderr.toString()).toContain('real guard\n');
  expect(capturedRefusal(new HandlerExecutionError('unknown outcome'))).toBeNull();
});

test('protective capture uses composer replacement decoding without altering raw bytes', () => {
  const stdout = Buffer.concat([
    Buffer.from('{"decision":"block","reason":"'),
    Buffer.from([255]),
    Buffer.from('"}\n'),
  ]);
  const kept = capturedRefusal(new HandlerExecutionError('held capture', stdout));
  expect(kept.exitCode).toBe(2);
  expect(kept.stdout).toEqual(stdout);
  // Top-level allow has the same precedence as in the composer.
  expect(
    capturedRefusal(
      new HandlerExecutionError(
        'held capture',
        Buffer.from('{"decision":"allow","hookSpecificOutput":{"permissionDecision":"deny"}}')
      )
    )
  ).toBeNull();
});

test('a colliding invocation cannot append to the first journal or publish handler records', () => {
  const selected = { canonical: root, checkout: root, handlers: [], configuration: 'system' };
  const first = new InvocationJournal(request(), selected, 'session-one');
  first.append('dispatch_started');
  const file = path.join(root, '.caws/sessions/session-one/hook-invocations/invocation-one.jsonl');
  const before = fs.readFileSync(file);
  const second = new InvocationJournal(request(), selected, 'session-one');
  second.append('dispatch_started');
  second.record({
    stage: 'after',
    selectedIndex: 0,
    handler: { entry: 'guard.sh', path: '/guard.sh', sha256: 'b'.repeat(64) },
    result: { exitCode: 2, stdout: Buffer.from('block'), stderr: Buffer.alloc(0) },
  });
  expect(second.takeDiagnostics()).toContain('incomplete');
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.existsSync(path.join(root, '.caws/sessions/session-one/hook-events.jsonl'))).toBe(
    false
  );
});

test('mixed case journals never write through an alias of an existing session directory', () => {
  const selected = { canonical: root, checkout: root, handlers: [], configuration: 'system' };
  const first = new InvocationJournal(request('CaseA'), selected, 'CaseA');
  first.append('dispatch_started');
  const beforePath = path.join(root, '.caws/sessions/CaseA/hook-invocations/invocation-one.jsonl');
  const before = fs.readFileSync(beforePath);
  const other = new InvocationJournal(
    { ...request('casea'), id: 'invocation-two' },
    selected,
    'casea'
  );
  other.append('dispatch_started');
  const names = fs.readdirSync(path.join(root, '.caws/sessions'));
  if (names.includes('casea')) {
    expect(other.takeDiagnostics()).toBe('');
    expect(fs.statSync(path.join(root, '.caws/sessions/casea')).ino).not.toBe(
      fs.statSync(path.join(root, '.caws/sessions/CaseA')).ino
    );
  } else {
    expect(other.takeDiagnostics()).toContain('aliases another session identity');
    expect(
      fs.existsSync(path.join(root, '.caws/sessions/CaseA/hook-invocations/invocation-two.jsonl'))
    ).toBe(false);
  }
  expect(fs.readFileSync(beforePath)).toEqual(before);
});

test('dedup with handler arguments is committed by name and isolated by project and session', () => {
  const home = path.join(root, 'machine');
  const handler = { name: 'advice.sh', entry: 'advice.sh extra', args: ['extra'] };
  const cache = new AdvisoryDedup(home, root, 'session-one', {});
  expect(cache.seen(handler, 'specific advice')).toBe(false);
  cache.commit([{ handler: handler.name, text: 'specific advice' }]);
  expect(cache.diagnostics).toEqual([]);
  expect(cache.seen(handler, 'specific advice')).toBe(true);
  expect(cache.seen(handler, 'different advice')).toBe(false);
  expect(new AdvisoryDedup(home, root, 'session-two', {}).seen(handler, 'specific advice')).toBe(
    false
  );
  expect(
    new AdvisoryDedup(home, path.join(root, 'other-project'), 'session-one', {}).seen(
      handler,
      'specific advice'
    )
  ).toBe(false);
});

test('harness payload precedes inherited identity and PID-only recovery is absent', () => {
  const current = request();
  expect(resolveInvocationIdentity(current, new AbortController().signal).sessionId).toBe(
    'session-one'
  );
  delete current.payload.session_id;
  expect(resolveInvocationIdentity(current, new AbortController().signal).sessionId).toBe(
    'neighbor'
  );
  current.caller.environment = { HOOK_SESSION_ID: 'stale' };
  expect(resolveInvocationIdentity(current, new AbortController().signal).sessionId).toBeNull();
});
