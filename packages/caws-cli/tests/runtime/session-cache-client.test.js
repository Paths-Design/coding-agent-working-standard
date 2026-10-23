const { AbortController } = globalThis;
const {
  SESSION_CACHE_CAPABILITY,
  decideSessionCacheCreation,
  createNativeSessionCachePort,
  sessionCacheInputSupported,
  SESSION_END_PREFIX_CAPABILITY,
  SESSION_END_PREFIX_REQUEST_SCHEMA,
  SESSION_END_PREFIX_PREVIOUS_SCHEMA,
  SESSION_END_PREFIX_DECISION_SCHEMA,
  SESSION_END_PREFIX_RESULT_SCHEMA,
  createNativeSessionEndPrefixPort,
} = require('../../dist/runtime/session-cache-client');

const request = {
  id: 'cache-test',
  runtimeDigest: 'a'.repeat(64),
  surface: 'codex',
  event: 'pre_tool_use',
  configuration: 'system',
  sessionCache: SESSION_CACHE_CAPABILITY,
  payload: { session_id: 'supplied' },
};
const bytes = (text) => Buffer.from(text);
const decide = (text, sid = 'supplied') => decideSessionCacheCreation(bytes(text), sid);

test('original numeric tokens require compatibility even when overwritten or unused', () => {
  expect(sessionCacheInputSupported('')).toBe(true);
  expect(
    sessionCacheInputSupported('{"session_id":"supplied","tool_input":{"command":"echo 4301"}}')
  ).toBe(true);
  for (const text of [
    '{"unused":1,"unused":"hidden"}',
    '{"unused":[' + '9'.repeat(4301) + ']}',
    '{"unused":1e9999}',
    '{"unused":NaN}',
    '{"unused":-0}',
    '{',
  ])
    expect(sessionCacheInputSupported(text)).toBe(false);
});
const identity = (frame) => ({
  id: frame.id,
  runtimeDigest: frame.runtimeDigest,
  token: frame.token,
});
const previous = (first, text = null) => ({
  schema: 'caws.runtime.session-cache.previous.v1',
  ...identity(first),
  existingBase64: text === null ? null : bytes(text).toString('base64'),
});
const terminal = (first, status = 'captured', changes = {}) => ({
  schema: 'caws.runtime.session-cache.result.v1',
  ...identity(first),
  status,
  envelopePublished: status === 'captured',
  diagnostic: ['declined', 'unavailable'].includes(status) ? 'finite diagnostic' : null,
  ...changes,
});
function fixture(replies, changes = {}) {
  const writes = [];
  let offset = 0;
  const controller = new AbortController();
  const transport = {
    async write(frame, signal) {
      expect(signal).toBe(controller.signal);
      writes.push(frame);
    },
    async read(signal) {
      expect(signal).toBe(controller.signal);
      const value = replies[offset++];
      if (value instanceof Error) throw value;
      const response = value(writes[0], writes);
      return typeof response === 'string' ? bytes(response) : bytes(JSON.stringify(response));
    },
  };
  return {
    writes,
    controller,
    port: createNativeSessionCachePort({ ...request, ...changes }, transport, controller.signal),
    reads: () => offset,
  };
}

test('fresh and flat string envelopes retain only same-SID nonempty creation UTF16', () => {
  expect(decideSessionCacheCreation(null, 'supplied')).toEqual({
    action: 'capture',
    createdUnits: null,
  });
  expect(decide('{}')).toEqual({ action: 'capture', createdUnits: null });
  expect(decide('{"session_id":"other","created_at":"old"}').createdUnits).toBeNull();
  expect(decide('{"session_id":"supplied","created_at":""}').createdUnits).toBeNull();
  expect(decide(String.raw`{"session_id":"supplied","created_at":"a\ud800🫠"}`)).toEqual({
    action: 'capture',
    createdUnits: [97, 0xd800, 0xd83e, 0xdee0],
  });
});

test.each([
  '',
  'null',
  '[]',
  '{',
  '{"unused":null}',
  '{"unused":false}',
  '{"unused":0}',
  '{"unused":1e9999}',
  '{"unused":NaN}',
  '{"unused":Infinity}',
  '{"unused":[]}',
  '{"unused":{}}',
  '{"unused":1,"unused":"hidden"}',
  '{"unused":[],"unused":"hidden"}',
  '{"session_id":"supplied","session_id":"supplied"}',
  '\ufeff{}',
  '{"created_at":"' + 'x'.repeat(65_536) + '"}',
])('unsupported old-envelope profile declines without guessed creation: %#', (text) => {
  expect(decide(text)).toEqual({ action: 'decline', createdUnits: null });
});

test('invalid UTF8 and excessive nesting decline before interpretation', () => {
  expect(decideSessionCacheCreation(Buffer.from([0xff]), 'supplied').action).toBe('decline');
  expect(decide('['.repeat(100) + 'null' + ']'.repeat(100)).action).toBe('decline');
});

test('one shared-transport exchange preserves exact old creation and binds all frames', async () => {
  const f = fixture([
    (first) => previous(first, '{"session_id":"supplied","created_at":"old"}'),
    (first) => terminal(first),
  ]);
  expect(await f.port.capture('/physical/project')).toEqual({
    status: 'captured',
    envelopePublished: true,
    diagnostic: null,
  });
  expect(f.writes).toHaveLength(2);
  expect(f.writes[0]).toEqual({
    schema: 'caws.runtime.session-cache.request.v1',
    ...identity(f.writes[0]),
    canonicalRoot: '/physical/project',
  });
  expect(f.writes[0].token).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(f.writes[1]).toEqual({
    schema: 'caws.runtime.session-cache.decision.v1',
    ...identity(f.writes[0]),
    action: 'capture',
    createdUnits: [111, 108, 100],
  });
  await expect(f.port.capture('/physical/project')).rejects.toThrow(/single-use/);
  expect(f.reads()).toBe(2);
});

test('unsupported bytes request decline and require an explicit no-publication confirmation', async () => {
  const f = fixture([
    (first) => previous(first, '{"unused":NaN}'),
    (first) => terminal(first, 'declined'),
  ]);
  expect((await f.port.capture('/physical/project')).status).toBe('declined');
  expect(f.writes[1].action).toBe('decline');
  expect(f.writes[1].createdUnits).toBeNull();
  const wrong = fixture([(first) => previous(first, '[]'), (first) => terminal(first)]);
  await expect(wrong.port.capture('/physical/project')).rejects.toThrow(
    /decline was not confirmed/
  );
});

test.each(['skipped', 'declined', 'unavailable'])(
  'native immediate %s terminates without a decision',
  async (status) => {
    const f = fixture([(first) => terminal(first, status)]);
    expect((await f.port.capture('/physical/project')).status).toBe(status);
    expect(f.writes).toHaveLength(1);
  }
);

test.each([
  (first) => ({ ...previous(first), id: 'foreign' }),
  (first) => ({ ...previous(first), runtimeDigest: 'b'.repeat(64) }),
  (first) => ({ ...previous(first), token: 'foreign' }),
  (first) => ({ ...previous(first), extra: true }),
  (first) => ({ ...previous(first), existingBase64: 'e30' }),
  (first) => ({ ...previous(first), existingBase64: '%%%%' }),
  (first) => ({ ...previous(first), existingBase64: Buffer.alloc(65_537).toString('base64') }),
  (first) =>
    JSON.stringify(previous(first)).replace(
      '"existingBase64":null',
      '"existingBase64":null,"existingBase64":null'
    ),
  (first) => terminal(first),
  (first) => terminal(first, 'unavailable', { envelopePublished: true }),
  (first) => terminal(first, 'declined', { envelopePublished: true }),
  (first) => terminal(first, 'declined', { diagnostic: '' }),
  (first) => terminal(first, 'unavailable', { diagnostic: 'é'.repeat(2049) }),
  (first) => terminal(first, 'skipped', { diagnostic: 'unexpected' }),
])(
  'unbound or impossible first response never grants fallback or a second attempt %#',
  async (response) => {
    const f = fixture([response]);
    await expect(f.port.capture('/physical/project')).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
    await expect(f.port.capture('/physical/project')).rejects.toThrow(/single-use/);
  }
);

test('partial publication remains diagnostic, while lost response is unknown and cannot replay', async () => {
  const f = fixture([
    (first) => previous(first),
    (first) => terminal(first, 'unavailable', { envelopePublished: true }),
  ]);
  expect(await f.port.capture('/physical/project')).toEqual({
    status: 'unavailable',
    envelopePublished: true,
    diagnostic: 'finite diagnostic',
  });
  const lost = new Error('lost result');
  const missing = fixture([(first) => previous(first), lost]);
  await expect(missing.port.capture('/physical/project')).rejects.toBe(lost);
  await expect(missing.port.capture('/physical/project')).rejects.toThrow(/single-use/);
  expect(missing.writes).toHaveLength(2);
});

test.each([
  { surface: 'claude-code' },
  { event: 'stop' },
  { configuration: 'project' },
  { sessionCache: undefined },
])('unsupported invocation never starts exchange: %j', async (changes) => {
  const f = fixture([], changes);
  await expect(f.port.capture('/physical/project')).rejects.toThrow(/Unsupported/);
  expect(f.writes).toHaveLength(0);
});

test.each(['relative', '/p//q', '/p/../q', '/p/', '/p\tq', '/p\u0085q', '/' + 'x'.repeat(4096)])(
  'unsupported native root syntax never starts exchange %#',
  async (root) => {
    const f = fixture([]);
    await expect(f.port.capture(root)).rejects.toThrow(/root/);
    expect(f.writes).toHaveLength(0);
  }
);

test('cancellation consumes operation without dispatching it', async () => {
  const f = fixture([]);
  const cancelled = new Error('cancelled');
  f.controller.abort(cancelled);
  await expect(f.port.capture('/physical/project')).rejects.toBe(cancelled);
  expect(f.writes).toHaveLength(0);
});

const prefixRequest = {
  ...request,
  event: 'session_end',
  sessionEndPrefix: SESSION_END_PREFIX_CAPABILITY,
};
const prefixPrevious = (first, text = null) => ({
  ...previous(first, text),
  schema: SESSION_END_PREFIX_PREVIOUS_SCHEMA,
});
const prefixTerminal = (first, changes = {}) => ({
  schema: SESSION_END_PREFIX_RESULT_SCHEMA,
  ...identity(first),
  status: 'completed',
  prefixComplete: true,
  envelopePublished: true,
  pointerPublished: true,
  agentPid: 'refreshed',
  reap: 'completed',
  diagnostic: null,
  ...changes,
});
const decline = {
  status: 'declined',
  prefixComplete: false,
  envelopePublished: false,
  pointerPublished: false,
  agentPid: 'not_run',
  reap: 'not_run',
  diagnostic: 'unsupported old profile',
};
function prefixFixture(replies, changes = {}) {
  const writes = [],
    controller = new AbortController();
  let reads = 0;
  const transport = {
    async write(frame, signal) {
      expect(signal).toBe(controller.signal);
      writes.push(frame);
    },
    async read(signal) {
      expect(signal).toBe(controller.signal);
      const reply = replies[reads++];
      if (reply instanceof Error) throw reply;
      const value = reply(writes[0], controller);
      return Buffer.isBuffer(value)
        ? value
        : bytes(typeof value === 'string' ? value : JSON.stringify(value));
    },
  };
  return {
    writes,
    controller,
    port: createNativeSessionEndPrefixPort(
      { ...prefixRequest, ...changes },
      transport,
      controller.signal
    ),
    reads: () => reads,
  };
}

test.each(['codex', 'claude-code'])(
  'distinct full SessionEnd prefix uses sole framed transport for %s',
  async (surface) => {
    const f = prefixFixture(
      [
        (first) => prefixPrevious(first, '{"session_id":"supplied","created_at":"original"}'),
        (first) => prefixTerminal(first, { agentPid: 'not_found', reap: 'not_run' }),
      ],
      { surface }
    );
    expect(await f.port.capture('/physical/project')).toEqual({
      status: 'completed',
      prefixComplete: true,
      envelopePublished: true,
      pointerPublished: true,
      agentPid: 'not_found',
      reap: 'not_run',
      diagnostic: null,
    });
    expect(f.writes).toEqual([
      {
        schema: SESSION_END_PREFIX_REQUEST_SCHEMA,
        ...identity(f.writes[0]),
        canonicalRoot: '/physical/project',
      },
      {
        schema: SESSION_END_PREFIX_DECISION_SCHEMA,
        ...identity(f.writes[0]),
        action: 'capture',
        createdUnits: [...'original'].map((char) => char.charCodeAt(0)),
      },
    ]);
    expect(f.writes[0]).not.toHaveProperty('processId');
    await expect(f.port.capture('/physical/project')).rejects.toThrow(/single-use/);
  }
);

test('explicit no-effect decline alone permits caller compatibility', async () => {
  const f = prefixFixture([(first) => prefixTerminal(first, decline)]);
  expect(await f.port.capture('/physical/project')).toEqual(decline);
  expect(f.writes).toHaveLength(1);
  const old = prefixFixture([
    (first) => prefixPrevious(first, '{"unsupported":1}'),
    (first) => prefixTerminal(first, decline),
  ]);
  expect((await old.port.capture('/physical/project')).status).toBe('declined');
  expect(old.writes[1].action).toBe('decline');
});

test('unreadable envelope can truthfully report completed sibling PID best-effort attempts before decision', async () => {
  const f = prefixFixture([
    (first) =>
      prefixTerminal(first, {
        status: 'unavailable',
        prefixComplete: true,
        envelopePublished: false,
        pointerPublished: false,
        agentPid: 'refreshed',
        reap: 'rate_limited',
        diagnostic: 'old envelope unavailable; sibling PID attempted',
      }),
  ]);
  expect(await f.port.capture('/physical/project')).toMatchObject({
    status: 'unavailable',
    prefixComplete: true,
    envelopePublished: false,
    pointerPublished: false,
    agentPid: 'refreshed',
    reap: 'rate_limited',
  });
  expect(f.writes).toHaveLength(1);
});

test.each([
  { envelopePublished: false, pointerPublished: false, agentPid: 'not_found', reap: 'not_run' },
  { agentPid: 'unavailable', reap: 'not_run' },
  { reap: 'unavailable' },
])('complete best-effort unavailability remains distinct from completed %#', async (effects) => {
  const f = prefixFixture([
    (first) => prefixPrevious(first),
    (first) =>
      prefixTerminal(first, {
        ...effects,
        status: 'unavailable',
        diagnostic: 'best-effort stage unavailable',
      }),
  ]);
  const result = await f.port.capture('/physical/project');
  expect(result.status).toBe('unavailable');
  expect(result.prefixComplete).toBe(true);
  expect(result).toMatchObject(effects);
});

test.each([
  { pointerPublished: true, envelopePublished: false },
  { prefixComplete: false },
  { agentPid: 'not_run' },
  { agentPid: 'not_found', reap: 'completed' },
  { reap: 'not_run' },
  { reap: 'unavailable' },
  { diagnostic: 'completed cannot hide a failed stage' },
  { ...decline, envelopePublished: true },
  { ...decline, prefixComplete: true },
  { status: 'unavailable', diagnostic: '' },
  { status: 'unavailable', diagnostic: 'x'.repeat(4097) },
  { extra: true },
  { agentPid: 'guessed' },
])('incoherent prefix effects cannot earn seal eligibility %#', async (changes) => {
  const f = prefixFixture([
    (first) => prefixPrevious(first),
    (first) => prefixTerminal(first, changes),
  ]);
  await expect(f.port.capture('/physical/project')).rejects.toThrow(/prefix result/);
  expect(f.writes).toHaveLength(2);
  await expect(f.port.capture('/physical/project')).rejects.toThrow(/single-use/);
});

test.each(['id', 'runtimeDigest', 'token', 'schema'])(
  'foreign prefix %s is fatal without replay',
  async (key) => {
    const f = prefixFixture([
      (first) => prefixPrevious(first),
      (first) => prefixTerminal(first, { [key]: 'foreign' }),
    ]);
    await expect(f.port.capture('/physical/project')).rejects.toThrow();
    expect(f.writes).toHaveLength(2);
  }
);

test('duplicate terminal identity and effect members cannot hide earlier values', async () => {
  for (const key of ['id', 'prefixComplete', 'agentPid']) {
    const f = prefixFixture([
      (first) => prefixPrevious(first),
      (first) =>
        JSON.stringify(prefixTerminal(first)).replace('{', '{' + JSON.stringify(key) + ':null,'),
    ]);
    await expect(f.port.capture('/physical/project')).rejects.toThrow();
  }
});

test('effectful first result, invalid previous encoding and old-schema terminal refuse', async () => {
  for (const reply of [
    (first) => prefixTerminal(first),
    (first) => ({ ...prefixPrevious(first), existingBase64: 'e30' }),
    (first) => terminal(first),
    () => Buffer.from([0xff]),
    () => Buffer.alloc(90_113, 32),
  ]) {
    const f = prefixFixture([reply]);
    await expect(f.port.capture('/physical/project')).rejects.toThrow();
    expect(f.writes).toHaveLength(1);
  }
});

test('partial unavailable, lost reply and cancellation never repeat a prefix', async () => {
  const f = prefixFixture([
    (first) =>
      prefixTerminal(first, {
        ...decline,
        status: 'unavailable',
        diagnostic: 'deadline before complete prefix',
      }),
  ]);
  expect(await f.port.capture('/physical/project')).toMatchObject({
    status: 'unavailable',
    prefixComplete: false,
  });
  const lost = new Error('transport lost after native effects');
  const missing = prefixFixture([(first) => prefixPrevious(first), lost]);
  await expect(missing.port.capture('/physical/project')).rejects.toBe(lost);
  await expect(missing.port.capture('/physical/project')).rejects.toThrow(/single-use/);
  const cancelled = prefixFixture([
    (first, controller) => {
      controller.abort(lost);
      return prefixTerminal(first, decline);
    },
  ]);
  await expect(cancelled.port.capture('/physical/project')).rejects.toBe(lost);
});

test.each([
  { sessionEndPrefix: undefined },
  { sessionEndPrefix: SESSION_CACHE_CAPABILITY },
  { event: 'pre_tool_use' },
  { surface: 'opencode' },
  { configuration: 'project-policy' },
  { payload: { session_id: '../escape' } },
  { payload: { session_id: 'unknown' } },
])('unsupported full prefix profile makes no request %#', async (changes) => {
  const f = prefixFixture([], changes);
  await expect(f.port.capture('/physical/project')).rejects.toThrow();
  expect(f.writes).toHaveLength(0);
});
