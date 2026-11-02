const { AbortController } = globalThis;
const {
  createNativeGuardStrikesPort,
  GUARD_STRIKES_REQUEST,
  GUARD_STRIKES_RESULT,
  MAX_GUARD_STRIKES_RESULT_BYTES,
} = require('../../dist/runtime/guard-strikes');
const { GUARD_STRIKES_CAPABILITY, decodeRuntimeRequest } = require('../../dist/runtime/protocol');
function request() {
  const payload = {
    session_id: 'strike-fixture',
    cwd: '/fixture/checkout',
    tool_name: 'Write',
    tool_input: { file_path: 'src/outside/a', content: 'ordinary' },
  };
  return {
    schema: 'caws.runtime.request.v1',
    id: 'strike-fixture',
    runtimeDigest: 'a'.repeat(64),
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    guardStrikes: GUARD_STRIKES_CAPABILITY,
    caller: { cwd: '/fixture/checkout', processId: 42, environment: { HOME: '/fixture/user' } },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: JSON.stringify(payload),
    payload,
  };
}
function fixture({ count = 1, mutate, transform } = {}) {
  const req = request(),
    controller = new AbortController(),
    frames = [];
  const transport = {
    write: jest.fn(async (frame) => {
      frames.push(frame);
    }),
    read: jest.fn(async () => {
      const frame = frames.at(-1);
      const reply = {
        schema: GUARD_STRIKES_RESULT,
        id: frame.id,
        runtimeDigest: frame.runtimeDigest,
        token: frame.token,
        count,
        stateSha256: 'b'.repeat(64),
      };
      if (mutate) mutate(reply);
      const text = JSON.stringify(reply);
      return transform ? transform(text) : Buffer.from(text);
    }),
  };
  return {
    req,
    controller,
    frames,
    transport,
    port: createNativeGuardStrikesPort(req, transport, controller.signal),
  };
}
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('optional capability roundtrips and unknown or duplicate declarations refuse', () => {
  const req = request();
  // Runtime request wire carries both inputJson and payload; the decoder checks their agreement.
  expect(decodeRuntimeRequest(JSON.stringify(req)).guardStrikes).toBe(GUARD_STRIKES_CAPABILITY);
  delete req.guardStrikes;
  expect(decodeRuntimeRequest(JSON.stringify(req)).guardStrikes).toBeUndefined();
  req.guardStrikes = 'unknown';
  expect(() => decodeRuntimeRequest(JSON.stringify(req))).toThrow('Unsupported guard-strikes');
  req.guardStrikes = GUARD_STRIKES_CAPABILITY;
  const duplicate = JSON.stringify(req).replace(
    '"guardStrikes":',
    '"guardStrikes":null,"guardStrikes":'
  );
  expect(() => decodeRuntimeRequest(duplicate)).toThrow('Duplicate JSON');
});
test.each([1, 2, 3, 99, Number.MAX_SAFE_INTEGER])(
  'one fixed transaction returns exact count %s and state digest',
  async (count) => {
    const f = fixture({ count });
    f.req.caller.environment.HOME = '/untrusted/later';
    f.req.payload.session_id = 'untrusted-later';
    f.req.id = 'untrusted-later';
    f.req.runtimeDigest = 'c'.repeat(64);
    const result = await f.port.incrementScopeGuard();
    expect(result).toEqual({ count, stateSha256: 'b'.repeat(64) });
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.frames).toEqual([
      {
        schema: GUARD_STRIKES_REQUEST,
        id: 'strike-fixture',
        runtimeDigest: 'a'.repeat(64),
        token: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(Object.keys(f.frames[0]).sort()).toEqual(
      ['schema', 'id', 'runtimeDigest', 'token'].sort()
    );
    await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
    expect(f.transport.write).toHaveBeenCalledTimes(1);
  }
);
test.each([
  [
    'schema',
    (r) => {
      r.schema = 'foreign';
    },
  ],
  [
    'identity',
    (r) => {
      r.id = 'foreign';
    },
  ],
  [
    'generation',
    (r) => {
      r.runtimeDigest = 'c'.repeat(64);
    },
  ],
  [
    'token',
    (r) => {
      r.token = 'c'.repeat(64);
    },
  ],
  [
    'missing count',
    (r) => {
      delete r.count;
    },
  ],
  [
    'zero count',
    (r) => {
      r.count = 0;
    },
  ],
  [
    'negative count',
    (r) => {
      r.count = -1;
    },
  ],
  [
    'fraction count',
    (r) => {
      r.count = 1.5;
    },
  ],
  [
    'unsafe count',
    (r) => {
      r.count = Number.MAX_SAFE_INTEGER + 1;
    },
  ],
  [
    'string count',
    (r) => {
      r.count = '1';
    },
  ],
  [
    'bad state digest',
    (r) => {
      r.stateSha256 = 'Z'.repeat(64);
    },
  ],
  ...[10, 13, 8232, 8233].map((code) => [
    'state digest with trailing line terminator ' + code,
    (r) => {
      r.stateSha256 = 'b'.repeat(64) + String.fromCharCode(code);
    },
  ]),
  [
    'missing state digest',
    (r) => {
      delete r.stateSha256;
    },
  ],
  [
    'HOME selector',
    (r) => {
      r.HOME = '/other';
    },
  ],
  [
    'session selector',
    (r) => {
      r.sessionId = 'other';
    },
  ],
  [
    'path selector',
    (r) => {
      r.path = '/other';
    },
  ],
  [
    'guard selector',
    (r) => {
      r.guard = 'other';
    },
  ],
  [
    'reset operation',
    (r) => {
      r.reset = true;
    },
  ],
  [
    'claimed rollback',
    (r) => {
      r.notCommitted = true;
    },
  ],
])('%s invalidates the consumed transaction without retry', async (_name, mutate) => {
  const f = fixture({ mutate });
  await expect(f.port.incrementScopeGuard()).rejects.toThrow();
  await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test.each([
  ['fraction spelling', (s) => Buffer.from(s.replace('"count":1', '"count":1.0'))],
  ['exponent spelling', (s) => Buffer.from(s.replace('"count":1', '"count":1e0'))],
  ['duplicate count', (s) => Buffer.from(s.replace('"count":1', '"count":1,"count":1'))],
  [
    'escaped duplicate count',
    (s) => Buffer.from(s.replace('"count":1', '"count":1,"co\\u0075nt":1')),
  ],
  ['malformed UTF-8', () => Buffer.from([0xff])],
  ['oversized result', () => Buffer.alloc(MAX_GUARD_STRIKES_RESULT_BYTES + 1, 32)],
])('%s cannot be normalized into a successful receipt', async (_name, transform) => {
  const f = fixture({ transform });
  await expect(f.port.incrementScopeGuard()).rejects.toThrow();
  await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test.each(['write', 'read'])(
  'overlap poisons the first pending %s and launches no second transaction',
  async (stage) => {
    const f = fixture();
    f.transport[stage].mockImplementation(() => new Promise(() => {}));
    const first = f.port.incrementScopeGuard().then(
      () => {
        throw new Error('overlapped transaction succeeded');
      },
      (error) => error
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.transport[stage]).toHaveBeenCalledTimes(1);
    await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
    expect((await first).message).toContain('consumed');
    expect(f.transport.write).toHaveBeenCalledTimes(1);
  }
);
test('uncertain publication or transport loss cannot be replayed', async () => {
  const f = fixture();
  f.transport.read.mockRejectedValue(new Error('PublicationUncertain after state rename'));
  await expect(f.port.incrementScopeGuard()).rejects.toThrow('PublicationUncertain');
  await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test('original deadline bounds an uncooperative read; no renewed request follows', async () => {
  jest.useFakeTimers();
  const req = request();
  req.deadlineEpochMs = Date.now() + 100;
  const transport = { write: jest.fn(async () => {}), read: jest.fn(() => new Promise(() => {})) };
  const port = createNativeGuardStrikesPort(req, transport, new AbortController().signal);
  req.deadlineEpochMs = Date.now() + 60000; // A later frontend mutation cannot renew the captured budget.
  const pending = expect(port.incrementScopeGuard()).rejects.toThrow('original deadline');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(transport.read).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(100);
  await pending;
  await expect(port.incrementScopeGuard()).rejects.toThrow('consumed');
});
test('original cancellation consumes an uncooperative operation', async () => {
  const f = fixture();
  f.transport.read.mockImplementation(() => new Promise(() => {}));
  const pending = expect(f.port.incrementScopeGuard()).rejects.toThrow('original cancellation');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.transport.read).toHaveBeenCalledTimes(1);
  f.controller.abort(new Error('original cancellation'));
  await pending;
  await expect(f.port.incrementScopeGuard()).rejects.toThrow('consumed');
});
test('expired original budget creates no transport effect', async () => {
  const req = request();
  req.deadlineEpochMs = Date.now() - 1;
  const transport = { write: jest.fn(), read: jest.fn() };
  const port = createNativeGuardStrikesPort(req, transport, new AbortController().signal);
  await expect(port.incrementScopeGuard()).rejects.toThrow('original deadline');
  expect(transport.write).not.toHaveBeenCalled();
});
test.each([
  ['surface', 'claude-code'],
  ['event', 'stop'],
  ['configuration', 'project'],
  ['guardStrikes', undefined],
])('%s cannot construct the fixed transaction transport', (key, value) => {
  const req = request();
  req[key] = value;
  expect(() =>
    createNativeGuardStrikesPort(
      req,
      { write: jest.fn(), read: jest.fn() },
      new AbortController().signal
    )
  ).toThrow('capability unavailable');
});
