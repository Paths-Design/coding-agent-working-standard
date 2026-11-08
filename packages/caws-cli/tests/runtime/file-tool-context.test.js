const { AbortController } = globalThis;
const {
  createNativeFileToolContextPort,
  FILE_TOOL_CONTEXT_REQUEST,
  FILE_TOOL_CONTEXT_RESULT,
  FILE_TOOL_CONTEXT_V2_REQUEST,
  FILE_TOOL_CONTEXT_V2_RESULT,
  MAX_FILE_TOOL_CONTEXT_RESULT,
} = require('../../dist/runtime/file-tool-context');
const {
  FILE_TOOL_CONTEXT_CAPABILITY,
  decodeRuntimeRequest,
} = require('../../dist/runtime/protocol');

function request() {
  const payload = {
    cwd: '/fixture/checkout',
    session_id: 'file-fixture',
    tool_name: 'Write',
    tool_input: { file_path: 'src/file.js', content: 'ordinary' },
  };
  return {
    schema: 'caws.runtime.request.v1',
    id: 'file-fixture',
    runtimeDigest: 'a'.repeat(64),
    surface: 'codex',
    event: 'pre_tool_use',
    configuration: 'system',
    fileToolContext: FILE_TOOL_CONTEXT_CAPABILITY,
    caller: { cwd: '/fixture/checkout', processId: 42, environment: {} },
    deadlineEpochMs: Date.now() + 60000,
    inputJson: JSON.stringify(payload),
    payload,
  };
}
function snapshot(overrides = {}) {
  return {
    checkout: '/fixture/checkout',
    canonical: '/fixture/repo',
    gitDir: '/fixture/repo/.git/worktrees/own',
    commonDir: '/fixture/repo/.git',
    branch: 'caws/own',
    mergeInProgress: false,
    worktrees: [
      {
        path: '/fixture/repo',
        branch: 'refs/heads/main',
        detached: false,
        prunable: false,
        bare: false,
      },
      {
        path: '/fixture/checkout',
        branch: 'refs/heads/caws/own',
        detached: false,
        prunable: false,
        bare: false,
      },
    ],
    ...overrides,
  };
}
function fixture({
  mutate,
  transform,
  native = false,
  contexts = [snapshot(), snapshot(), snapshot()],
} = {}) {
  const req = request();
  if (native)
    Object.assign(req, {
      surface: 'claude-code',
      fileToolContext: 'caws.runtime.file-tool-context.v2',
      guardStrikes: 'caws.runtime.guard-strikes.v2',
    });
  const controller = new AbortController();
  const frames = [];
  const transport = {
    write: jest.fn(async (frame) => {
      frames.push(frame);
    }),
    read: jest.fn(async () => {
      const frame = frames.at(-1);
      const result = {
        schema: native ? FILE_TOOL_CONTEXT_V2_RESULT : FILE_TOOL_CONTEXT_RESULT,
        id: frame.id,
        runtimeDigest: frame.runtimeDigest,
        token: frame.token,
        ordinal: frame.ordinal,
        snapshotToken: 'b'.repeat(64),
        context: contexts[frame.ordinal - 1],
      };
      if (mutate) mutate(result);
      const text = JSON.stringify(result);
      return transform ? transform(text) : Buffer.from(text);
    }),
  };
  return {
    req,
    controller,
    frames,
    transport,
    port: createNativeFileToolContextPort(req, transport, controller.signal),
  };
}
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('native authority requires three ordered observations with original roots and fresh final facts', async () => {
  const fresh = snapshot({ mergeInProgress: true });
  const f = fixture({ native: true, contexts: [snapshot(), snapshot(), fresh] });
  expect(typeof f.port.finalize).toBe('function');
  expect(() => f.port.association()).toThrow('completed observation');
  expect(await f.port.capture()).toEqual(snapshot());
  const association = f.port.association();
  expect(association).toEqual({ token: f.frames[0].token, snapshotToken: 'b'.repeat(64) });
  expect(Object.isFrozen(association)).toBe(true);
  expect(await f.port.revalidate()).toEqual(snapshot());
  expect(await f.port.finalize()).toEqual(fresh);
  expect(
    f.frames.map(({ schema, ordinal, snapshotToken }) => ({ schema, ordinal, snapshotToken }))
  ).toEqual([
    { schema: FILE_TOOL_CONTEXT_V2_REQUEST, ordinal: 1, snapshotToken: null },
    { schema: FILE_TOOL_CONTEXT_V2_REQUEST, ordinal: 2, snapshotToken: 'b'.repeat(64) },
    { schema: FILE_TOOL_CONTEXT_V2_REQUEST, ordinal: 3, snapshotToken: 'b'.repeat(64) },
  ]);
  await expect(f.port.finalize()).rejects.toThrow('replay');
  expect(() => f.port.association()).toThrow('invalidated');
  expect(f.transport.write).toHaveBeenCalledTimes(3);
});
test('native final observation cannot skip an earlier observation or recover after failure', async () => {
  const f = fixture({ native: true });
  await f.port.capture();
  await expect(f.port.finalize()).rejects.toThrow('order mismatch');
  await expect(f.port.revalidate()).rejects.toThrow('replay');
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test('native final observation refuses replaced roots and old-version replies without replay', async () => {
  const roots = fixture({
    native: true,
    contexts: [snapshot(), snapshot(), snapshot({ canonical: '/other' })],
  });
  await roots.port.capture();
  await roots.port.revalidate();
  await expect(roots.port.finalize()).rejects.toThrow('original roots replaced');
  await expect(roots.port.finalize()).rejects.toThrow('replay');
  expect(roots.transport.write).toHaveBeenCalledTimes(3);
  const old = fixture({
    native: true,
    mutate: (reply) => {
      reply.schema = FILE_TOOL_CONTEXT_RESULT;
    },
  });
  await expect(old.port.capture()).rejects.toThrow('correlation mismatch');
  await expect(old.port.revalidate()).rejects.toThrow('replay');
  expect(old.transport.write).toHaveBeenCalledTimes(1);
  expect(fixture().port.finalize).toBeUndefined();
  expect(fixture().port.association).toBeUndefined();
});
test('native context port cannot borrow another surface or an unpaired strike backend', () => {
  const f = fixture({ native: true });
  for (const overrides of [
    { surface: 'codex' },
    { guardStrikes: undefined },
    { guardStrikes: 'caws.runtime.guard-strikes.v1' },
    { payload: { tool_name: 'apply_patch' } },
  ]) {
    expect(() =>
      createNativeFileToolContextPort({ ...f.req, ...overrides }, f.transport, f.controller.signal)
    ).toThrow('capability unavailable');
  }
  expect(f.transport.write).not.toHaveBeenCalled();
});

test('optional capability roundtrips while unknown and duplicate values refuse', () => {
  const req = request();
  expect(decodeRuntimeRequest(JSON.stringify(req)).fileToolContext).toBe(
    FILE_TOOL_CONTEXT_CAPABILITY
  );
  delete req.fileToolContext;
  expect(decodeRuntimeRequest(JSON.stringify(req)).fileToolContext).toBeUndefined();
  req.fileToolContext = 'unknown';
  expect(() => decodeRuntimeRequest(JSON.stringify(req))).toThrow('Unsupported file-tool context');
  req.fileToolContext = FILE_TOOL_CONTEXT_CAPABILITY;
  const bytes = JSON.stringify(req).replace(
    '"fileToolContext":',
    '"fileToolContext":null,"fileToolContext":'
  );
  expect(() => decodeRuntimeRequest(bytes)).toThrow('Duplicate JSON');
});
test('wire payload is required and must match the exact original input source', () => {
  const req = request();
  const missing = { ...req };
  delete missing.payload;
  expect(() => decodeRuntimeRequest(JSON.stringify(missing))).toThrow(
    'Unsupported runtime request envelope'
  );
  req.payload.tool_input.file_path = 'different.js';
  expect(() => decodeRuntimeRequest(JSON.stringify(req))).toThrow(
    'Hook payload does not match original native input'
  );
});
test('two ordered observations retain roots and native token while consuming fresh facts', async () => {
  const fresh = snapshot({
    branch: 'main',
    mergeInProgress: true,
    worktrees: [
      {
        path: '/fixture/repo',
        branch: 'refs/heads/main',
        detached: false,
        prunable: false,
        bare: false,
      },
    ],
  });
  const f = fixture({ contexts: [snapshot(), fresh] });
  const initial = await f.port.capture();
  expect(initial).toEqual(snapshot());
  expect(Object.isFrozen(initial)).toBe(true);
  expect(Object.isFrozen(initial.worktrees)).toBe(true);
  expect(Object.isFrozen(initial.worktrees[0])).toBe(true);
  expect(await f.port.revalidate()).toEqual(fresh);
  expect(f.frames).toHaveLength(2);
  expect(f.frames[0]).toEqual({
    schema: FILE_TOOL_CONTEXT_REQUEST,
    id: f.req.id,
    runtimeDigest: f.req.runtimeDigest,
    token: expect.stringMatching(/^[a-f0-9]{64}$/),
    ordinal: 1,
    snapshotToken: null,
  });
  expect(f.frames[1]).toEqual({ ...f.frames[0], ordinal: 2, snapshotToken: 'b'.repeat(64) });
  expect(Object.keys(f.frames[0]).sort()).toEqual(
    ['schema', 'id', 'runtimeDigest', 'token', 'ordinal', 'snapshotToken'].sort()
  );
  await expect(f.port.revalidate()).rejects.toThrow('replay');
  expect(f.transport.write).toHaveBeenCalledTimes(2);
});
test('bare primary and linked checkout preserve explicit topology in both observations', async () => {
  const linked = snapshot({
    commonDir: '/fixture/repo/.bare',
    gitDir: '/fixture/repo/.bare/worktrees/own',
    worktrees: [
      { path: '/fixture/repo/.bare', branch: null, detached: false, prunable: false, bare: true },
      {
        path: '/fixture/checkout',
        branch: 'refs/heads/caws/own',
        detached: false,
        prunable: false,
        bare: false,
      },
    ],
  });
  const f = fixture({ contexts: [linked, linked] });
  expect(await f.port.capture()).toEqual(linked);
  expect(await f.port.revalidate()).toEqual(linked);
  expect(f.frames.map((frame) => frame.ordinal)).toEqual([1, 2]);
  expect(f.transport.write).toHaveBeenCalledTimes(2);
});
test('a settled unsuccessful branch observation stays null', async () => {
  const f = fixture({ contexts: [snapshot({ branch: null }), snapshot({ branch: null })] });
  expect((await f.port.capture()).branch).toBeNull();
  expect((await f.port.revalidate()).branch).toBeNull();
});
test.each([
  [
    'schema',
    (r) => {
      r.schema = 'foreign';
    },
  ],
  [
    'id',
    (r) => {
      r.id = 'foreign';
    },
  ],
  [
    'digest',
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
    'ordinal',
    (r) => {
      r.ordinal = 2;
    },
  ],
  [
    'native token',
    (r) => {
      r.snapshotToken = 'x';
    },
  ],
  [
    'unknown result field',
    (r) => {
      r.extra = true;
    },
  ],
  [
    'unknown context field',
    (r) => {
      r.context.extra = true;
    },
  ],
  [
    'relative root',
    (r) => {
      r.context.gitDir = 'relative';
    },
  ],
  [
    'invalid UTF-8 text',
    (r) => {
      r.context.checkout = '/bad/\ud800';
    },
  ],
  [
    'NUL path',
    (r) => {
      r.context.checkout = '/bad/\0';
    },
  ],
  [
    'invalid branch',
    (r) => {
      r.context.branch = 17;
    },
  ],
  [
    'invalid merge state',
    (r) => {
      r.context.mergeInProgress = 'false';
    },
  ],
  [
    'missing bare fact',
    (r) => {
      delete r.context.worktrees[0].bare;
    },
  ],
  [
    'nonboolean bare fact',
    (r) => {
      r.context.worktrees[0].bare = 'true';
    },
  ],
  [
    'bare primary with branch',
    (r) => {
      r.context.worktrees[0].bare = true;
    },
  ],
  [
    'bare primary marked detached',
    (r) => {
      r.context.worktrees[0].bare = true;
      r.context.worktrees[0].branch = null;
      r.context.worktrees[0].detached = true;
    },
  ],
  [
    'unknown worktree field',
    (r) => {
      r.context.worktrees[0].extra = true;
    },
  ],
  [
    'contradictory detached row',
    (r) => {
      r.context.worktrees[0].detached = true;
    },
  ],
  [
    'duplicate worktree path',
    (r) => {
      r.context.worktrees[1].path = r.context.worktrees[0].path;
    },
  ],
  [
    'too many worktrees',
    (r) => {
      r.context.worktrees = Array.from({ length: 4097 }, (_, i) => ({
        path: '/fixture/w' + i,
        branch: null,
        detached: true,
        prunable: false,
        bare: false,
      }));
    },
  ],
])('%s refuses and consumes the entire port', async (_name, mutate) => {
  const f = fixture({ mutate });
  await expect(f.port.capture()).rejects.toThrow();
  await expect(f.port.capture()).rejects.toThrow('replay');
  await expect(f.port.revalidate()).rejects.toThrow('replay');
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test.each([
  ['fractional ordinal', (s) => Buffer.from(s.replace('"ordinal":1', '"ordinal":1.0'))],
  ['exponent ordinal', (s) => Buffer.from(s.replace('"ordinal":1', '"ordinal":1e0'))],
  ['duplicate ordinal', (s) => Buffer.from(s.replace('"ordinal":1', '"ordinal":1,"ordinal":1'))],
  [
    'escaped duplicate',
    (s) => Buffer.from(s.replace('"ordinal":1', '"ordinal":1,"ord\\u0069nal":1')),
  ],
  ['malformed UTF-8', () => Buffer.from([0xff])],
  ['oversized result', () => Buffer.alloc(MAX_FILE_TOOL_CONTEXT_RESULT + 1, 32)],
])('%s cannot be repaired by decoded JavaScript values', async (_name, transform) => {
  const f = fixture({ transform });
  await expect(f.port.capture()).rejects.toThrow();
  expect(f.transport.write).toHaveBeenCalledTimes(1);
});
test.each(['checkout', 'canonical', 'gitDir', 'commonDir'])(
  'fresh %s replacement refuses rather than accepting new root authority',
  async (key) => {
    const f = fixture({ contexts: [snapshot(), snapshot({ [key]: '/replacement' })] });
    await f.port.capture();
    await expect(f.port.revalidate()).rejects.toThrow('roots replaced');
    expect(f.transport.write).toHaveBeenCalledTimes(2);
  }
);
test('native snapshot-token replacement refuses the fresh observation', async () => {
  const f = fixture({
    mutate: (r) => {
      if (r.ordinal === 2) r.snapshotToken = 'c'.repeat(64);
    },
  });
  await f.port.capture();
  await expect(f.port.revalidate()).rejects.toThrow('correlation');
});
test('revalidation cannot run before capture and poisons later capture', async () => {
  const f = fixture();
  await expect(f.port.revalidate()).rejects.toThrow('order');
  await expect(f.port.capture()).rejects.toThrow('replay');
  expect(f.transport.write).not.toHaveBeenCalled();
});
test.each(['write', 'read'])(
  'overlap cancels the first pending %s even if transport ignores cancellation',
  async (stage) => {
    const f = fixture();
    f.transport[stage].mockImplementation(() => new Promise(() => {}));
    const first = f.port.capture().then(
      () => {
        throw new Error('overlapped capture unexpectedly succeeded');
      },
      (error) => error
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.transport[stage]).toHaveBeenCalledTimes(1);
    await expect(f.port.revalidate()).rejects.toThrow('overlap');
    expect((await first).message).toContain('overlap');
    expect(f.transport.write).toHaveBeenCalledTimes(1);
  }
);
test('original deadline bounds a read transport that ignores cancellation', async () => {
  jest.useFakeTimers();
  const req = request();
  req.deadlineEpochMs = Date.now() + 100;
  const transport = { write: jest.fn(async () => {}), read: jest.fn(() => new Promise(() => {})) };
  const port = createNativeFileToolContextPort(req, transport, new AbortController().signal);
  const pending = expect(port.capture()).rejects.toThrow('original deadline');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(transport.read).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(100);
  await pending;
  await expect(port.revalidate()).rejects.toThrow('replay');
});
test('original cancellation bounds an uncooperative read transport', async () => {
  const f = fixture();
  f.transport.read.mockImplementation(() => new Promise(() => {}));
  const pending = expect(f.port.capture()).rejects.toThrow('original cancellation');
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(f.transport.read).toHaveBeenCalledTimes(1);
  f.controller.abort(new Error('original cancellation'));
  await pending;
  await expect(f.port.revalidate()).rejects.toThrow('replay');
});
test('already expired capture creates no transport request', async () => {
  const req = request();
  req.deadlineEpochMs = Date.now() - 1;
  const transport = { write: jest.fn(), read: jest.fn() };
  const port = createNativeFileToolContextPort(req, transport, new AbortController().signal);
  await expect(port.capture()).rejects.toThrow('original deadline');
  expect(transport.write).not.toHaveBeenCalled();
});
test.each([
  ['surface', 'claude-code'],
  ['event', 'stop'],
  ['configuration', 'project'],
  ['fileToolContext', undefined],
])('%s cannot construct the file-tool transport', (key, value) => {
  const req = request();
  req[key] = value;
  expect(() =>
    createNativeFileToolContextPort(
      req,
      { write: jest.fn(), read: jest.fn() },
      new AbortController().signal
    )
  ).toThrow('capability unavailable');
});
