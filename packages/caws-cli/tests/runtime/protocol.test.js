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
      result,
    });
  });

  test.each([
    { schema: 'wrong' },
    { id: 'other' },
    { runtimeDigest: 'b'.repeat(64) },
    { result: { exitCode: '2', stdout: '', stderr: '' } },
    { result: { exitCode: 256, stdout: '', stderr: '' } },
    { result: { exitCode: -1, stdout: '', stderr: '' } },
    { result: { exitCode: 0.5, stdout: '', stderr: '' } },
    { result: { exitCode: 0, stdout: null, stderr: '' } },
    { result: { exitCode: 0, stdout: '', stderr: '', admitted: true } },
    { extra: true },
  ])('rejects mismatched native response %#', (changes) => {
    const response = {
      schema: RESPONSE_SCHEMA,
      ...identity,
      result: { exitCode: 0, stdout: '', stderr: '' },
      ...changes,
    };
    expect(() => decodeRuntimeResponse(JSON.stringify(response), identity)).toThrow(/mismatched/);
  });

  test('bounds the serialized response including JSON escaping', () => {
    expect(() =>
      encodeRuntimeResponse(identity, {
        exitCode: 0,
        stdout: '\n'.repeat(MAX_RESPONSE_BYTES),
        stderr: '',
      })
    ).toThrow(/byte limit/);
  });
});
