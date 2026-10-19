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
  caller: { cwd: '/project', environment: { PATH: '/usr/bin', MARKER: 'request-1' } },
  deadlineEpochMs: now + 1_000,
  inputJson: '{ "tool_input": {"command":"pwd"} }\n',
  payload: { tool_input: { command: 'pwd' } },
  ...changes,
});
const decode = (changes) => decodeRuntimeRequest(JSON.stringify(request(changes)), now);

describe('native runtime protocol', () => {
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
    { caller: { cwd: 'relative', environment: {} } },
    { caller: { cwd: '/valid\0bad', environment: {} } },
    { caller: { cwd: '/valid', environment: [] } },
    { caller: { cwd: '/valid', environment: { X: false } } },
    { caller: { cwd: '/valid', environment: { X: null } } },
    { caller: { cwd: '/valid', environment: { 'A=B': 'value' } } },
    { caller: { cwd: '/valid', environment: { X: 'bad\0value' } } },
    { caller: { cwd: '/valid', environment: {}, authority: 'other' } },
    { caller: { cwd: '/valid', environment: { X: String.fromCharCode(0xd800) } } },
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
      caller: { cwd: '/one', environment: { MARKER: 'one', GIT_DIR: '/foreign-one' } },
    });
    const second = decode({
      caller: { cwd: '/two', environment: { MARKER: 'two', GIT_DIR: '/foreign-two' } },
    });
    expect(first.caller).toEqual({
      cwd: '/one',
      environment: { MARKER: 'one', GIT_DIR: '/foreign-one' },
    });
    expect(second.caller).toEqual({
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
