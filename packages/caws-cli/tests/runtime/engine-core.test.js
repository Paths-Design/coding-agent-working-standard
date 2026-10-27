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
    schema: 'caws.runtime.handoff.v2',
    ...identity,
    token: 'proposal-one',
    success: true,
    containment: null,
  };
  const bytes = (value) => Buffer.from(JSON.stringify(value));
  expect(decodeHandoff(bytes(ack), identity, 'proposal-one')).toEqual({
    success: true,
    containment: null,
  });
  expect(decodeHandoff(bytes({ ...ack, success: false }), identity, 'proposal-one')).toEqual({
    success: false,
    containment: null,
  });
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

function compatibilityJournal() {
  const handler = {
    name: 'guard.sh',
    entry: 'guard.sh',
    path: path.join(root, 'guard.sh'),
    sha256: 'b'.repeat(64),
  };
  const selected = {
    canonical: root,
    checkout: root,
    handlers: [handler],
    configuration: 'system',
  };
  const invocation = request();
  invocation.payload.tool_use_id = 'call-one';
  invocation.payload.tool_name = 'Bash';
  const journal = new InvocationJournal(invocation, selected, 'session-one');
  const row = {
    timestamp: new Date().toISOString(),
    session_id: 'session-one',
    handler: handler.name,
    path: handler.path,
    status: 'completed',
    exit_code: 2,
    stdout: '{"decision":"block","reason":"owned refusal"}',
    stderr: 'guard diagnostic',
    hook_event: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'call-one',
  };
  return {
    journal,
    handler,
    selected,
    invocation,
    row,
    file: path.join(root, '.caws/sessions/session-one/hook-events.jsonl'),
  };
}

test.each([
  ['session', { session_id: 'neighbor' }],
  ['handler', { handler: 'other.sh' }],
  ['path', { path: '/foreign/guard.sh' }],
  ['event', { hook_event: 'Stop' }],
  ['tool correlation', { tool_use_id: 'another-call' }],
  ['timestamp', { timestamp: 'invalid' }],
  ['status', { status: 'started' }],
  ['unknown exit', { exit_code: null }],
  ['fractional exit', { exit_code: 2.5 }],
  ['output', { stdout: {} }],
  ['skipped result', { status: 'reprieved', exit_code: 0 }],
  ['skipped output', { status: 'reprieved', exit_code: null }],
])('invalid compatibility %s is diagnostic and cannot publish an outcome', (_name, changes) => {
  const f = compatibilityJournal();
  f.journal.recordCompatibility(Buffer.from(JSON.stringify({ ...f.row, ...changes }) + '\n'));
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.journal.takeDiagnostics()).toContain('does not match');
});

test.each(['malformed', 'duplicate'])(
  '%s compatibility capture cannot publish a first-row-wins result',
  (kind) => {
    const f = compatibilityJournal();
    const line = JSON.stringify(f.row) + '\n';
    f.journal.recordCompatibility(Buffer.from(line + (kind === 'malformed' ? 'not-json\n' : line)));
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.journal.takeDiagnostics()).toContain('incomplete');
  }
);

test('valid compatibility reports preserve their explicit unverified observation boundary', () => {
  const f = compatibilityJournal();
  f.journal.recordCompatibility(Buffer.from(JSON.stringify(f.row) + '\n'));
  const rows = fs.readFileSync(f.file, 'utf8').trim().split('\n').map(JSON.parse);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    ...f.row,
    delivery: 'not_observed',
    observation_boundary: 'unverified_compatibility_dispatcher_report',
    source_sha256: f.handler.sha256,
  });
  expect(f.journal.takeDiagnostics()).toBe('');
});

test.each(['missing', 'reprieved'])(
  'compatibility %s remains a nonexecution observation',
  (status) => {
    const f = compatibilityJournal();
    f.journal.recordCompatibility(
      Buffer.from(
        JSON.stringify({ ...f.row, status, exit_code: null, stdout: '', stderr: '' }) + '\n'
      )
    );
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toMatchObject({
      status,
      exit_code: null,
      stdout: '',
      delivery: 'not_observed',
    });
  }
);

test('compatibility observations obey capture bounds, collision protection and no-follow writes', () => {
  const f = compatibilityJournal();
  f.journal.recordCompatibility(Buffer.alloc(2 * 1024 * 1024 + 1));
  expect(f.journal.takeDiagnostics()).toContain('capture limit');
  const colliding = new InvocationJournal(f.invocation, f.selected, 'session-one');
  colliding.recordCompatibility(Buffer.from(JSON.stringify(f.row) + '\n'));
  expect(colliding.takeDiagnostics()).toContain('incomplete');
  expect(fs.existsSync(f.file)).toBe(false);
  const target = path.join(root, 'preserved.txt');
  fs.writeFileSync(target, 'preserved');
  fs.symlinkSync(target, f.file);
  f.journal.recordCompatibility(Buffer.from(JSON.stringify(f.row) + '\n'));
  expect(f.journal.takeDiagnostics()).toContain('incomplete');
  expect(fs.readFileSync(target, 'utf8')).toBe('preserved');
});

test('typed handler results retain raw renderer fields alongside lossless journal bytes', () => {
  const f = compatibilityJournal();
  f.journal.record({ stage: 'handler_started', selectedIndex: 0, handler: f.handler });
  expect(fs.existsSync(f.file)).toBe(false);
  f.journal.record({
    stage: 'handler_completed',
    selectedIndex: 0,
    handler: f.handler,
    result: { exitCode: 2, stdout: Buffer.from(f.row.stdout), stderr: Buffer.from(f.row.stderr) },
  });
  const row = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  expect(row).toMatchObject({
    status: 'completed',
    session_id: 'session-one',
    stdout: f.row.stdout,
    stderr: f.row.stderr,
    tool_use_id: 'call-one',
    exit_code: 2,
    delivery: 'not_observed',
  });
  expect(Number.isFinite(Date.parse(row.timestamp))).toBe(true);
  expect(Buffer.from(row.stdout_base64, 'base64').toString()).toBe(f.row.stdout);
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
