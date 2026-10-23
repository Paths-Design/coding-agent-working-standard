// Transport-boundary controls. These do not execute native Git or establish cleanup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ContextGitError,
  CONTEXT_GIT_RESULT_SCHEMA,
  MAX_CONTEXT_GIT_REQUEST_BYTES,
  MAX_CONTEXT_GIT_RESULT_BYTES,
  MAX_CONTEXT_GIT_OUTPUT_BYTES,
  createContextGitRequest,
  decodeContextGitResult,
} = require('../../dist/runtime/context-git-wire');
const { createNativeContextGitPort } = require('../../dist/runtime/context-git-client');

const checkoutArgs = ['rev-parse', '--show-toplevel'];
const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
const cleanup = { groupSettled: true, stdoutEof: true, stderrEof: true, reaped: true };
const identity = { id: 'context-test', runtimeDigest: 'a'.repeat(64) };
const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
const wireRequest = () =>
  createContextGitRequest(identity, 'b'.repeat(64), 1, 'checkout', '/selected/git', '/request');
function result(frame, changes = {}) {
  return {
    schema: CONTEXT_GIT_RESULT_SCHEMA,
    id: frame.id,
    runtimeDigest: frame.runtimeDigest,
    token: frame.token,
    ordinal: frame.ordinal,
    operation: frame.operation,
    status: 'exited',
    exitCode: 0,
    signal: null,
    stdout: Buffer.from(frame.ordinal === 1 ? '/checkout\n' : '/canonical/.git\n').toString(
      'base64'
    ),
    stderr: '',
    cleanup: { ...cleanup },
    diagnostic: '',
    ...changes,
  };
}
function fixture(reply = (frame) => result(frame), changes = {}) {
  const controller = new globalThis.AbortController();
  const writes = [];
  let reads = 0;
  const request = {
    ...identity,
    caller: { cwd: '/caller', environment: { PATH: '', CAWS_GIT_BINARY: '/selected/git' } },
    deadlineEpochMs: Date.now() + 60_000,
    ...changes,
  };
  const transport = {
    async write(frame, signal) {
      writes.push(frame);
      expect(signal.aborted).toBe(false);
    },
    async read(signal) {
      reads++;
      const value = await reply(writes.at(-1), signal);
      return value instanceof Uint8Array ? value : bytes(value);
    },
  };
  return {
    request,
    writes,
    controller,
    transport,
    port: createNativeContextGitPort(request, transport, controller.signal),
    reads: () => reads,
  };
}

test('two actual port calls preserve operation, selected executable, cwd, bytes and correlation', async () => {
  const f = fixture();
  await expect(f.port.run(checkoutArgs, '/request')).resolves.toBe('/checkout');
  await expect(f.port.run(commonArgs, '/checkout')).resolves.toBe('/canonical/.git');
  expect(
    f.writes.map(({ ordinal, operation, executable, cwd }) => ({
      ordinal,
      operation,
      executable,
      cwd,
    }))
  ).toEqual([
    { ordinal: 1, operation: 'checkout', executable: '/selected/git', cwd: '/request' },
    { ordinal: 2, operation: 'commonDir', executable: '/selected/git', cwd: '/checkout' },
  ]);
  for (const frame of f.writes) {
    expect(frame.schema).toBe('caws.runtime.context-git.request.v1');
    expect(frame.id).toBe(identity.id);
    expect(frame.runtimeDigest).toBe(identity.runtimeDigest);
    expect(frame.token).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(f.writes[0].token).toBe(f.writes[1].token);
  await expect(f.port.run(commonArgs, '/checkout')).rejects.toMatchObject({ category: 'protocol' });
  expect(f.reads()).toBe(2);
});

test.each([
  [commonArgs, '/request'],
  [['status'], '/request'],
])('unsupported or out-of-order arguments refuse before transport %#', async (args, cwd) => {
  const f = fixture();
  await expect(f.port.run(args, cwd)).rejects.toMatchObject({ category: 'protocol' });
  expect(f.writes).toEqual([]);
  expect(f.reads()).toBe(0);
});

test('second cwd must be the first Git output, and failed exchanges cannot retry', async () => {
  const f = fixture();
  await f.port.run(checkoutArgs, '/request');
  await expect(f.port.run(commonArgs, '/foreign')).rejects.toMatchObject({ category: 'protocol' });
  await expect(f.port.run(commonArgs, '/checkout')).rejects.toMatchObject({ category: 'protocol' });
  expect(f.writes).toHaveLength(1);
});

test('concurrent calls do not acquire another reader or return a usable first result', async () => {
  let release, entered;
  const reading = new Promise((accept) => {
    entered = accept;
  });
  const f = fixture(
    (frame) =>
      new Promise((accept) => {
        release = () => accept(result(frame));
        entered();
      })
  );
  const first = f.port.run(checkoutArgs, '/request');
  await reading;
  const second = f.port.run(checkoutArgs, '/request');
  const secondError = await second.catch((error) => error);
  expect(secondError.category).toBe('protocol');
  expect(f.reads()).toBe(1);
  release();
  await expect(first).rejects.toMatchObject({ category: 'protocol' });
  expect(f.writes).toHaveLength(1);
});

test.each([
  ['id', 'foreign'],
  ['runtimeDigest', 'c'.repeat(64)],
  ['token', 'd'.repeat(64)],
  ['ordinal', 2],
  ['operation', 'commonDir'],
  ['schema', 'other'],
])('wrong result %s refuses and does not retry', async (key, value) => {
  const f = fixture((frame) => result(frame, { [key]: value }));
  await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'protocol',
  });
  await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'protocol',
  });
  expect(f.writes).toHaveLength(1);
});

test.each(['groupSettled', 'stdoutEof', 'stderrEof', 'reaped'])(
  'an exited child without %s is unusable even with correct stdout',
  async (field) => {
    const f = fixture((frame) => result(frame, { cleanup: { ...cleanup, [field]: false } }));
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
      category: 'cleanup',
      cleanup: { [field]: false },
    });
  }
);

test.each([
  ['spawn_failed', 'spawn_failed'],
  ['cancelled', 'cancelled'],
  ['deadline', 'deadline'],
  ['output_limit', 'output_limit'],
  ['cleanup_unsettled', 'cleanup'],
  ['identity_changed', 'identity'],
])('native %s remains fatal after its supplied cleanup observation', async (status, category) => {
  const f = fixture((frame) =>
    result(frame, {
      status,
      exitCode: null,
      diagnostic: 'native failure',
      cleanup: status === 'cleanup_unsettled' ? { ...cleanup, reaped: false } : cleanup,
    })
  );
  await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category,
    message: 'native failure',
  });
});

test('coherent nonzero exit retains Git stderr, while signal termination is fatal', async () => {
  const nonzero = fixture((frame) =>
    result(frame, {
      exitCode: 128,
      stderr: Buffer.from(' precise Git failure\n').toString('base64'),
    })
  );
  await expect(nonzero.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'git_exit',
    message: 'precise Git failure',
    cleanup,
  });
  const signalled = fixture((frame) => result(frame, { exitCode: null, signal: 9 }));
  await expect(signalled.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'signal',
    message: 'Project Git terminated by signal 9',
  });
});

test.each([
  { exitCode: null },
  { exitCode: 0, signal: 9 },
  { signal: 0 },
  { exitCode: -1 },
  { exitCode: 256 },
  { signal: 2147483648, exitCode: null },
  { status: 'spawn_failed', exitCode: 0 },
  { status: 'cleanup_unsettled', cleanup },
  { cleanup: { ...cleanup, extra: true } },
  { cleanup: { ...cleanup, reaped: 1 } },
  { diagnostic: 'x'.repeat(1025) },
  { diagnostic: '\ud800' },
  { status: 'unknown' },
  { extra: true },
])('invalid status, cleanup or result shape is protocol failure %#', async (changes) => {
  const f = fixture((frame) => result(frame, changes));
  await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'protocol',
  });
});

test.each(['Zg', 'Zg==\n', 'Zh==', 'Zg===', '====', '_w==', 'AA=A'])(
  'base64 %s cannot be accepted through Node permissive decoding',
  async (stdout) => {
    const f = fixture((frame) => result(frame, { stdout }));
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
      category: 'protocol',
    });
  }
);

test.each(['ordinal', 'exitCode', 'signal'])(
  'rounded or noncanonical %s tokens refuse before projection',
  async (key) => {
    const tokens =
      key === 'signal'
        ? ['9.0', '9e0', '9.0000000000000000001']
        : key === 'ordinal'
          ? ['1.0', '1.0000000000000000001', '1e0']
          : ['-0', '1.0', '1e0', '1.0000000000000000001'];
    for (const token of tokens) {
      const f = fixture((frame) => {
        const baseline = result(frame, key === 'signal' ? { exitCode: null, signal: 9 } : {});
        return bytes(
          JSON.stringify(baseline).replace(
            new RegExp('"' + key + '":(?:9|1|0|null)'),
            '"' + key + '":' + token
          )
        );
      });
      await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
        category: 'protocol',
      });
    }
  }
);

test('duplicate keys, malformed UTF8, trailing JSON and overlarge frames cannot attest a result', async () => {
  const cases = [
    (frame) =>
      bytes(JSON.stringify(result(frame)).replace('"exitCode":0', '"exitCode":0,"exitCode":0')),
    (frame) =>
      bytes(
        JSON.stringify(result(frame)).replace(
          '"id":"' + frame.id + '"',
          '"id":"foreign","id":"' + frame.id + '"'
        )
      ),
    (frame) =>
      bytes(JSON.stringify(result(frame)).replace('"reaped":true', '"reaped":false,"reaped":true')),
    () => Buffer.from([0xff]),
    (frame) => bytes(JSON.stringify(result(frame)) + '{}'),
    () => Buffer.alloc(MAX_CONTEXT_GIT_RESULT_BYTES + 1, 32),
  ];
  for (const reply of cases) {
    const f = fixture(reply);
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
      category: 'protocol',
    });
  }
});

test('raw combined output boundary includes stderr and permits exact 1MiB before text interpretation', () => {
  const request = wireRequest();
  const stdout = Buffer.alloc(MAX_CONTEXT_GIT_OUTPUT_BYTES - 1, 97),
    stderr = Buffer.from('x');
  const decoded = decodeContextGitResult(
    bytes(
      result(request, { stdout: stdout.toString('base64'), stderr: stderr.toString('base64') })
    ),
    request
  );
  expect(decoded.stdout.equals(stdout)).toBe(true);
  expect(decoded.stderr.equals(stderr)).toBe(true);
  expect(() =>
    decodeContextGitResult(
      bytes(
        result(request, {
          stdout: stdout.toString('base64'),
          stderr: Buffer.from('xx').toString('base64'),
        })
      ),
      request
    )
  ).toThrow('output exceeds byte limit');
});

test('UTF8, absolute root and diagnostic byte semantics remain explicit', async () => {
  for (const channel of ['stdout', 'stderr']) {
    const f = fixture((frame) =>
      result(frame, { [channel]: Buffer.from([0xff]).toString('base64') })
    );
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({ category: 'utf8' });
  }
  for (const text of ['relative', '', '/root\0suffix']) {
    const f = fixture((frame) => result(frame, { stdout: Buffer.from(text).toString('base64') }));
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
      category: 'protocol',
    });
  }
  const request = wireRequest();
  expect(
    decodeContextGitResult(bytes(result(request, { diagnostic: 'é'.repeat(512) })), request)
      .diagnostic
  ).toBe('é'.repeat(512));
  expect(() =>
    decodeContextGitResult(bytes(result(request, { diagnostic: 'é'.repeat(513) })), request)
  ).toThrow('diagnostic');
});

test('request byte limit, correlation identity and native path admission are checked before writing', () => {
  const base = wireRequest();
  const capacity = MAX_CONTEXT_GIT_REQUEST_BYTES - Buffer.byteLength(JSON.stringify(base));
  const exact = createContextGitRequest(
    identity,
    base.token,
    1,
    'checkout',
    base.executable,
    base.cwd + 'x'.repeat(capacity)
  );
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(MAX_CONTEXT_GIT_REQUEST_BYTES);
  expect(() =>
    createContextGitRequest(identity, base.token, 1, 'checkout', base.executable, exact.cwd + 'x')
  ).toThrow('request exceeds byte limit');
  for (const token of ['A'.repeat(64), 'b'.repeat(63), 'not-a-token'])
    expect(() =>
      createContextGitRequest(identity, token, 1, 'checkout', base.executable, base.cwd)
    ).toThrow(ContextGitError);
  for (const cwd of ['relative', '/root\0bad', '/root\ud800'])
    expect(() =>
      createContextGitRequest(identity, base.token, 1, 'checkout', base.executable, cwd)
    ).toThrow(ContextGitError);
});

test('local abort rejects an uncooperative pending transport without asserting cleanup or replay', async () => {
  let reading;
  const entered = new Promise((accept) => {
    reading = accept;
  });
  const f = fixture(() => {
    reading();
    return new Promise(() => {});
  });
  const pending = f.port.run(checkoutArgs, '/request');
  await entered;
  f.controller.abort();
  await expect(pending).rejects.toMatchObject({ category: 'cancelled', cleanup: null });
  await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'protocol',
  });
  expect(f.writes).toHaveLength(1);
});

test('already aborted and expired requests cannot start transport', async () => {
  const cancelled = fixture();
  cancelled.controller.abort();
  await expect(cancelled.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'cancelled',
    cleanup: null,
  });
  expect(cancelled.writes).toEqual([]);
  const expired = fixture(undefined, { deadlineEpochMs: Date.now() - 1 });
  await expect(expired.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
    category: 'deadline',
    cleanup: null,
  });
  expect(expired.writes).toEqual([]);
});

test('deadline and write/read rejection remain fatal transport boundaries', async () => {
  jest.useFakeTimers();
  try {
    const f = fixture(() => new Promise(() => {}), { deadlineEpochMs: Date.now() + 50 });
    const pending = f.port.run(checkoutArgs, '/request');
    const observed = pending.catch((error) => error);
    await jest.advanceTimersByTimeAsync(51);
    expect(await observed).toMatchObject({ category: 'deadline', cleanup: null });
  } finally {
    jest.useRealTimers();
  }
  for (const method of ['read', 'write']) {
    const f = fixture();
    f.transport[method] = async () => {
      throw new Error('broken channel');
    };
    await expect(f.port.run(checkoutArgs, '/request')).rejects.toMatchObject({
      category: 'protocol',
      cleanup: null,
    });
    expect(f.writes).toHaveLength(method === 'write' ? 0 : 1);
  }
});

test('caller-selected relative wrapper and symlink paths are retained without resident resolver cache', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'context-git-client-')));
  try {
    fs.mkdirSync(path.join(root, 'bin'));
    const executable = path.join(root, 'bin/git');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.symlinkSync(executable, path.join(root, 'bin/alias'));
    for (const [environment, selected] of [
      [{ PATH: 'bin' }, executable],
      [{ CAWS_GIT_BINARY: './bin/alias', PATH: '' }, path.join(root, 'bin/alias')],
      [{ CAWS_GIT_BINARY: 'alias', PATH: 'bin' }, path.join(root, 'bin/alias')],
    ]) {
      const f = fixture(undefined, { caller: { cwd: root, environment } });
      environment.CAWS_GIT_BINARY = '/later/foreign';
      f.request.id = 'changed-after-construction';
      await expect(f.port.run(checkoutArgs, root)).resolves.toBe('/checkout');
      expect(f.writes[0].executable).toBe(selected);
      expect(f.writes[0].id).toBe(identity.id);
      const token = f.writes[0].token;
      environment.CAWS_GIT_BINARY = '/another/foreign';
      environment.PATH = '/another/path';
      await expect(f.port.run(commonArgs, '/checkout')).resolves.toBe('/canonical/.git');
      expect(f.writes[1].token).toBe(token);
      expect(f.writes[1].executable).toBe(selected);
      expect(f.writes[1].id).toBe(identity.id);
    }
    const absent = fixture(undefined, { caller: { cwd: root, environment: { PATH: ':' } } });
    await expect(absent.port.run(checkoutArgs, root)).rejects.toMatchObject({
      category: 'unavailable',
    });
    expect(absent.writes).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
