const crypto = require('node:crypto');
const {
  REQUEST_SCHEMA,
  RESPONSE_SCHEMA,
  MAX_INPUT_BYTES,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_REQUEST_DURATION_MS,
  decodeRuntimeRequest,
  decodeRuntimeResponse,
  encodeRuntimeResponse,
  nativeInputDigest,
} = require('../../dist/runtime/protocol');

const now = 1_000_000;
const identity = { id: 'request-1', runtimeDigest: 'a'.repeat(64) };
const request = (changes = {}) => ({
  schema: REQUEST_SCHEMA,
  ...identity,
  surface: 'codex',
  event: 'pre_tool_use',
  configuration: 'system',
  caller: {
    processId: 123,
    cwd: '/project',
    environment: { PATH: '/usr/bin', MARKER: 'request-1' },
  },
  deadlineEpochMs: now + 1_000,
  inputJson: '{ "tool_input": {"command":"pwd"} }\n',
  payload: { tool_input: { command: 'pwd' } },
  ...changes,
});
const decode = (changes) => decodeRuntimeRequest(JSON.stringify(request(changes)), now);

describe('native runtime protocol', () => {
  test('full SessionEnd prefix capability is distinct from cache and publication authority', () => {
    expect(decode().sessionEndPrefix).toBeUndefined();
    const result = decode({ sessionEndPrefix: 'caws.runtime.session-end-prefix.v1' });
    expect(result.sessionEndPrefix).toBe('caws.runtime.session-end-prefix.v1');
    expect(result.sessionCache).toBeUndefined();
    expect(result.sessionPublication).toBeUndefined();
    for (const sessionEndPrefix of [
      null,
      false,
      true,
      '',
      [],
      {},
      'caws.runtime.session-cache.v1',
      'caws.runtime.session-end-prefix.v2',
    ])
      expect(() => decode({ sessionEndPrefix })).toThrow(/SessionEnd prefix capability/);
    const frame = JSON.stringify(
      request({ sessionEndPrefix: 'caws.runtime.session-end-prefix.v1' })
    );
    expect(() =>
      decodeRuntimeRequest(
        frame.replace('{', '{"sessionEndPrefix":"caws.runtime.session-end-prefix.v2",'),
        now
      )
    ).toThrow();
  });
  test('preserves the exact publication capability independently of cache and store', () => {
    expect(decode().sessionPublication).toBeUndefined();
    const decoded = decode({ sessionPublication: 'caws.runtime.session-publication.v1' });
    expect(decoded.sessionPublication).toBe('caws.runtime.session-publication.v1');
    expect(decoded.sessionCache).toBeUndefined();
    expect(decoded.sessionStore).toBeUndefined();
    for (const sessionPublication of [
      null,
      false,
      true,
      '',
      [],
      {},
      'caws.runtime.session-publication.v2',
    ])
      expect(() => decode({ sessionPublication })).toThrow(/session publication capability/);
  });
  test('escaped top-level capability and identity duplicates refuse without changing opaque payload semantics', () => {
    const frame = JSON.stringify(
      request({ sessionEndPrefix: 'caws.runtime.session-end-prefix.v1' })
    );
    for (const duplicate of [
      String.raw`"\u0073essionEndPrefix":"caws.runtime.session-end-prefix.v2",`,
      String.raw`"\u0069d":"foreign",`,
      '"runtimeDigest":"' + 'b'.repeat(64) + '",',
    ])
      expect(() => decodeRuntimeRequest(frame.replace('{', '{' + duplicate), now)).toThrow(
        /Duplicate/
      );
    const inputJson =
      '{"unused":9007199254740993,"unused":18446744073709551617,"nested":{"value":1e400,"value":1e401},"text":"sessionEndPrefix"}';
    const opaque = JSON.stringify(
      request({ inputJson, payload: {}, sessionEndPrefix: 'caws.runtime.session-end-prefix.v1' })
    ).replace('"payload":{}', '"payload":' + inputJson);
    const decoded = decodeRuntimeRequest(opaque, now);
    expect(decoded.inputJson).toBe(inputJson);
    expect(decoded.sessionEndPrefix).toBe('caws.runtime.session-end-prefix.v1');
    expect(decoded.payload).toEqual(JSON.parse(inputJson));
  });
  test('context Git capability is optional, exact, and independent of other capabilities', () => {
    expect(Object.hasOwn(decode(), 'contextGit')).toBe(false);
    const decoded = decode({ contextGit: 'caws.runtime.context-git.v1' });
    expect(decoded.contextGit).toBe('caws.runtime.context-git.v1');
    expect(decoded.sessionCache).toBeUndefined();
    expect(decoded.sessionStore).toBeUndefined();
    expect(
      decode({
        contextGit: 'caws.runtime.context-git.v1',
        sessionCache: 'caws.runtime.session-cache.v1',
        sessionStore: 'caws.runtime.transcript-store.v1',
      })
    ).toMatchObject({
      contextGit: 'caws.runtime.context-git.v1',
      sessionCache: 'caws.runtime.session-cache.v1',
      sessionStore: 'caws.runtime.transcript-store.v1',
    });
    for (const contextGit of [null, false, true, '', 'caws.runtime.context-git.v2', {}, []])
      expect(() => decode({ contextGit })).toThrow(/context Git capability/);
    expect(() => decode({ contextGitExtra: 'caws.runtime.context-git.v1' })).toThrow(
      /request envelope/
    );
  });
  test('preserves the optional native store capability without borrowing cache authority', () => {
    expect(decode().sessionStore).toBeUndefined();
    expect(decode({ sessionStore: 'caws.runtime.transcript-store.v1' }).sessionStore).toBe(
      'caws.runtime.transcript-store.v1'
    );
    expect(
      decode({ sessionStore: 'caws.runtime.transcript-store.v1' }).sessionCache
    ).toBeUndefined();
    for (const sessionStore of [null, false, true, '', 'caws.runtime.transcript-store.v2', {}])
      expect(() => decode({ sessionStore })).toThrow(/transcript store capability/);
  });
  test('preserves an explicit native cache capability and rejects unsupported spellings', () => {
    expect(decode().sessionCache).toBeUndefined();
    expect(decode({ sessionCache: 'caws.runtime.session-cache.v1' }).sessionCache).toBe(
      'caws.runtime.session-cache.v1'
    );
    for (const sessionCache of [null, false, true, '', 'caws.runtime.session-cache.v2', {}])
      expect(() => decode({ sessionCache })).toThrow(/session cache capability/);
  });

  test('rejects fractional or exponent control tokens even when JavaScript rounds to a valid integer', () => {
    for (const token of ['123.00000000000000001', '2147483647.00000001', '1.23e2', '123.0', '-0']) {
      const frame = JSON.stringify(request()).replace('"processId":123', '"processId":' + token);
      expect(() => decodeRuntimeRequest(frame, now)).toThrow(/caller snapshot/);
    }
    for (const token of ['1001000.00000000001', '1.001e6', '1001000.0']) {
      const frame = JSON.stringify(request()).replace(
        '"deadlineEpochMs":1001000',
        '"deadlineEpochMs":' + token
      );
      expect(() => decodeRuntimeRequest(frame, now)).toThrow(/deadline/);
    }
  });

  test('accepts exact canonical control bounds without changing opaque payload numbers', () => {
    const result = decode({
      caller: { processId: 2147483647, cwd: '/project', environment: {} },
      deadlineEpochMs: now + MAX_REQUEST_DURATION_MS,
    });
    expect(result.caller.processId).toBe(2147483647);
    expect(result.deadlineEpochMs).toBe(now + MAX_REQUEST_DURATION_MS);
    expect(
      decode({ caller: { processId: 1, cwd: '/project', environment: {} } }).caller.processId
    ).toBe(1);
    const nearLimit = JSON.stringify(request({ deadlineEpochMs: Number.MAX_SAFE_INTEGER }));
    expect(decodeRuntimeRequest(nearLimit, Number.MAX_SAFE_INTEGER - 1).deadlineEpochMs).toBe(
      Number.MAX_SAFE_INTEGER
    );
  });

  test('rejects numeric payload differences hidden by JavaScript rounding', () => {
    for (const [original, changed] of [
      ['9007199254740993', '9007199254740992'],
      ['18446744073709551617', '18446744073709551616'],
      ['1e400', '1e401'],
      ['1e-400', '0'],
      ['-0', '0'],
    ]) {
      const inputJson = '{"nested":{"revision":' + original + '}}';
      const frame = JSON.stringify(request({ inputJson, payload: {} })).replace(
        '"payload":{}',
        '"payload":{"nested":{"revision":' + changed + '}}'
      );
      expect(() => decodeRuntimeRequest(frame, now)).toThrow(/does not match/);
    }
  });

  test('accepts exact opaque numeric tokens and private-looking object keys', () => {
    const inputJson =
      '{"revision":18446744073709551617,"tiny":1e-400,"huge":1E+004,"object":{"$serde_json::private::Number":"123","sibling":true}}';
    const frame = JSON.stringify(request({ inputJson, payload: {} })).replace(
      '"payload":{}',
      '"payload":' + inputJson
    );
    const result = decodeRuntimeRequest(frame, now);
    expect(result.inputJson).toBe(inputJson);
    expect(result.payload.object).toEqual({ '$serde_json::private::Number': '123', sibling: true });
  });

  test('retains exact native input custody and freezes nested request state', () => {
    const result = decode();
    expect(result.inputJson).toBe(request().inputJson);
    expect(nativeInputDigest(result)).toBe(
      crypto.createHash('sha256').update(request().inputJson).digest('hex')
    );
    expect(nativeInputDigest(result)).not.toBe(
      crypto.createHash('sha256').update(JSON.stringify(result.payload)).digest('hex')
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.payload)).toBe(true);
    expect(Object.isFrozen(result.payload.tool_input)).toBe(true);
    expect(Object.isFrozen(result.caller)).toBe(true);
    expect(Object.isFrozen(result.caller.environment)).toBe(true);
  });

  test.each([
    'pre_tool_use',
    'post_tool_use',
    'session_start',
    'stop',
    'pre_compact',
    'session_end',
  ])('accepts declared event %s', (event) => expect(decode({ event }).event).toBe(event));
  test.each(['codex', 'claude-code', 'kimi-code', 'qwen-code', 'zcode', 'opencode', 'dsh'])(
    'accepts audited runtime surface %s',
    (surface) => expect(decode({ surface }).surface).toBe(surface)
  );
  test.each([
    { schema: 'caws.runtime.request.v2' },
    { id: '' },
    { id: '../other' },
    { id: 'x'.repeat(129) },
    { runtimeDigest: 'A'.repeat(64) },
    { runtimeDigest: 'a'.repeat(63) },
    { runtimeDigest: 'a'.repeat(64) + '\n' },
    { id: 'request-1\n' },
    { event: 'constructor' },
    { event: '__proto__' },
    { event: 'Stop' },
    { surface: 'cursor' },
    { surface: 'windsurf' },
    { surface: 'none' },
    { configuration: undefined },
    { configuration: 'legacy' },
    { configuration: true },
    { caller: undefined },
    { caller: { processId: 123, cwd: 'relative', environment: {} } },
    { caller: { processId: 123, cwd: '/valid\0bad', environment: {} } },
    { caller: { processId: 123, cwd: '/valid', environment: [] } },
    { caller: { processId: 123, cwd: '/valid', environment: { X: false } } },
    { caller: { processId: 123, cwd: '/valid', environment: { X: null } } },
    { caller: { processId: 123, cwd: '/valid', environment: { 'A=B': 'value' } } },
    { caller: { processId: 123, cwd: '/valid', environment: { X: 'bad\0value' } } },
    { caller: { processId: 123, cwd: '/valid', environment: {}, authority: 'other' } },
    { caller: { processId: 123, cwd: '/valid', environment: { X: String.fromCharCode(0xd800) } } },
    ...[undefined, null, '123', 0, -1, 1.2, 2147483648].map((processId) => ({
      caller: { processId, cwd: '/valid', environment: {} },
    })),
    { deadlineEpochMs: now },
    { deadlineEpochMs: now - 1 },
    { deadlineEpochMs: now + MAX_REQUEST_DURATION_MS + 1 },
    { deadlineEpochMs: 1.5 },
    { deadlineEpochMs: '1000001' },
    { deadlineEpochMs: Number.MAX_SAFE_INTEGER + 1 },
    { payload: { tool_input: { command: 'rm secret' } } },
    { inputJson: '{}' },
    { inputJson: 'null', payload: null },
    { inputJson: '[]', payload: [] },
    { inputJson: '{broken' },
    { inputJson: '{"value":NaN}', payload: {} },
    { additionalAuthority: true },
    { inputJson: ' '.repeat(MAX_INPUT_BYTES + 1) },
  ])('rejects malformed or mismatched request %#', (changes) => {
    expect(() => decode(changes)).toThrow();
  });

  test('accepts exact deadline limit and semantically equal object key order', () => {
    expect(decode({ deadlineEpochMs: now + MAX_REQUEST_DURATION_MS }).deadlineEpochMs).toBe(
      now + MAX_REQUEST_DURATION_MS
    );
    expect(decode({ inputJson: '{"b":2,"a":1}', payload: { a: 1, b: 2 } }).payload).toEqual({
      b: 2,
      a: 1,
    });
  });

  test('keeps caller context and entry mode isolated across interleaved decoded requests', () => {
    const ambient = process.env.MARKER;
    const first = decode({
      configuration: 'project',
      caller: {
        processId: 123,
        cwd: '/one',
        environment: { MARKER: 'one', GIT_DIR: '/foreign-one' },
      },
    });
    const second = decode({
      caller: {
        processId: 456,
        cwd: '/two',
        environment: { MARKER: 'two', GIT_DIR: '/foreign-two' },
      },
    });
    expect(first.caller).toEqual({
      processId: 123,
      cwd: '/one',
      environment: { MARKER: 'one', GIT_DIR: '/foreign-one' },
    });
    expect(second.caller).toEqual({
      processId: 456,
      cwd: '/two',
      environment: { MARKER: 'two', GIT_DIR: '/foreign-two' },
    });
    expect(first.configuration).toBe('project');
    expect(second.configuration).toBe('system');
    expect(process.env.MARKER).toBe(ambient);
  });

  test('bounds structure without recursive comparison overflow', () => {
    let payload = {};
    for (let index = 0; index < 130; index++) payload = { nested: payload };
    expect(() => decode({ inputJson: JSON.stringify(payload), payload })).toThrow(
      /structural limit/
    );
  });

  test('rejects invalid UTF8 and oversized frames', () => {
    expect(() => decodeRuntimeRequest(Buffer.from([0xff]), now)).toThrow(/valid UTF-8 JSON/);
    expect(() => decodeRuntimeRequest(' '.repeat(MAX_REQUEST_BYTES + 1), now)).toThrow(
      /byte limit/
    );
    expect(() => decodeRuntimeRequest(JSON.stringify(request()), NaN)).toThrow(/deadline/);
  });

  test('rejects a claimed raw input string that cannot represent original UTF8 bytes', () => {
    expect(() =>
      decode({
        inputJson: '{"x":"' + String.fromCharCode(0xd800) + '"}',
        payload: { x: String.fromCharCode(0xfffd) },
      })
    ).toThrow(/valid UTF-8 bytes/);
  });

  test('compares arrays, null and primitives with their semantic identity', () => {
    const payload = { values: [null, true, false, 0, 'x', { nested: 'y' }] };
    expect(decode({ inputJson: JSON.stringify(payload), payload }).payload).toEqual(payload);
    expect(() =>
      decode({ inputJson: JSON.stringify({ values: [1] }), payload: { values: { 0: 1 } } })
    ).toThrow(/does not match/);
  });

  test('round trips exact native result bytes without interpreting a refusal as transport failure', () => {
    const result = { exitCode: 2, stdout: '{"decision":"block"}\n', stderr: 'reason\n\n' };
    const frame = encodeRuntimeResponse(identity, result);
    expect(frame.endsWith('\n')).toBe(true);
    expect(decodeRuntimeResponse(frame, identity)).toEqual({
      schema: RESPONSE_SCHEMA,
      ...identity,
      result: {
        exitCode: result.exitCode,
        stdout: Buffer.from(result.stdout),
        stderr: Buffer.from(result.stderr),
      },
    });
  });

  test.each([
    { schema: 'wrong' },
    { id: 'other' },
    { runtimeDigest: 'b'.repeat(64) },
    { result: { exitCode: '2', stdoutBase64: '', stderrBase64: '' } },
    { result: { exitCode: 256, stdoutBase64: '', stderrBase64: '' } },
    { result: { exitCode: -1, stdoutBase64: '', stderrBase64: '' } },
    { result: { exitCode: 0.5, stdoutBase64: '', stderrBase64: '' } },
    { result: { exitCode: 0, stdoutBase64: null, stderrBase64: '' } },
    { result: { exitCode: 0, stdoutBase64: '', stderrBase64: '', admitted: true } },
    { result: { exitCode: 0, stdout: '', stderr: '' } },
    { extra: true },
  ])('rejects mismatched native response %#', (changes) => {
    const response = {
      schema: RESPONSE_SCHEMA,
      ...identity,
      result: { exitCode: 0, stdoutBase64: '', stderrBase64: '' },
      ...changes,
    };
    expect(() => decodeRuntimeResponse(JSON.stringify(response), identity)).toThrow(/mismatched/);
  });

  test('retains all native byte values including invalid UTF8 and NUL', () => {
    const native = {
      exitCode: 0,
      stdout: Buffer.from([0xff, 0x00, 0x61]),
      stderr: Buffer.from(Array.from({ length: 256 }, (_, value) => value)),
    };
    const frame = encodeRuntimeResponse(identity, native);
    expect(JSON.parse(frame).result.stdoutBase64).toBe('/wBh');
    expect(decodeRuntimeResponse(frame, identity).result).toEqual(native);
  });

  test.each(['Zg', 'Zg=', 'Zg===', 'Zh==', 'Zm9=', 'Z g==', 'Zg==\n', '-w==', '雪'])(
    'rejects noncanonical native byte encoding %j',
    (encoded) => {
      for (const channel of ['stdoutBase64', 'stderrBase64']) {
        const response = {
          schema: RESPONSE_SCHEMA,
          ...identity,
          result: { exitCode: 0, stdoutBase64: '', stderrBase64: '', [channel]: encoded },
        };
        expect(() => decodeRuntimeResponse(JSON.stringify(response), identity)).toThrow(
          /mismatched/
        );
      }
    }
  );

  test('bounds the serialized response including binary transport expansion', () => {
    expect(() =>
      encodeRuntimeResponse(identity, {
        exitCode: 0,
        stdout: '\n'.repeat(MAX_RESPONSE_BYTES),
        stderr: '',
      })
    ).toThrow(/byte limit/);
  });

  test('round trips a large valid binary frame without regex stack growth', () => {
    const stdout = Buffer.alloc(1024 * 1024, 0xff);
    const stderr = Buffer.alloc(1024 * 1024, 0x00);
    const result = { exitCode: 0, stdout, stderr };
    const frame = encodeRuntimeResponse(identity, result);
    expect(Buffer.byteLength(frame)).toBeLessThan(MAX_RESPONSE_BYTES);
    expect(decodeRuntimeResponse(frame, identity).result).toEqual(result);
  });
});

test('optional native selection advertisement preserves exact native limits without admission flags', () => {
  const advertisement = {
    schema: 'caws.runtime.selection-observation.v1',
    snapshotId: 'selection-native-1',
    limits: { maximumObservations: 4096, maximumBytes: 64 * 1024 * 1024, maximumPathBytes: 16384 },
  };
  expect(decode().selectionObservation).toBeUndefined();
  const decoded = decode({ selectionObservation: advertisement });
  expect(decoded.selectionObservation).toEqual(advertisement);
  expect(Object.isFrozen(decoded.selectionObservation.limits)).toBe(true);
  expect(decoded.selectionObservation).not.toHaveProperty('qualified');
  for (const selectionObservation of [
    null,
    {},
    { ...advertisement, qualified: true },
    { ...advertisement, snapshotId: '' },
    { ...advertisement, schema: 'caws.runtime.selection-observation.v2' },
    { ...advertisement, limits: { ...advertisement.limits, maximumBytes: 64 * 1024 * 1024 + 1 } },
    { ...advertisement, limits: { ...advertisement.limits, maximumObservations: 0 } },
  ])
    expect(() => decode({ selectionObservation })).toThrow();
  const text = JSON.stringify(request({ selectionObservation: advertisement }));
  expect(() =>
    decodeRuntimeRequest(text.replace('"maximumBytes":', '"maximumBytes":1,"maximumBytes":'), now)
  ).toThrow('Duplicate');
});

test('native request preserves the exact execution-workdir Git profile without upgrading ordinary profile', () => {
  expect(decode({ contextGit: 'caws.runtime.context-git.execution-workdir.v1' }).contextGit).toBe(
    'caws.runtime.context-git.execution-workdir.v1'
  );
  expect(decode({ contextGit: 'caws.runtime.context-git.v1' }).contextGit).toBe(
    'caws.runtime.context-git.v1'
  );
  expect(() => decode({ contextGit: 'caws.runtime.context-git.execution-workdir.v2' })).toThrow(
    /context Git capability/
  );
});
