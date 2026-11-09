const {
  readQwenOriginalWrite,
  originalNativeFileOperation,
} = require('../../dist/runtime/file-tools/original-operation');

const original = () => ({
  session_id: 'original-qwen_01',
  cwd: '/owned',
  tool_name: 'write_file',
  tool_input: { file_path: '/owned/src/main.ts', content: 'export const n = 1;' },
  tool_use_id: 'original-use',
  tool_call_id: 'original-call',
  permission_mode: 'default',
});
test('original Qwen classification preserves raw operation/session/input', () => {
  const payload = original();
  const text = JSON.stringify(payload).slice(0, -1) + ',"opaque":{"n":1e9999,"n":2}}';
  const result = readQwenOriginalWrite(text, payload);
  expect(result.surface).toBe('qwen-code');
  expect(result.operation).toBe('write');
  expect(result.sessionId).toBe(payload.session_id);
  expect(result.payload.tool_name).toBe('write_file');
  expect(result.payload.tool_input).toEqual(payload.tool_input);
  expect(text).toContain('1e9999');
  expect(originalNativeFileOperation('claude-code', 'Write')).toBe('write');
  expect(originalNativeFileOperation('claude-code', 'Edit')).toBe('edit');
  expect(originalNativeFileOperation('qwen-code', 'write_file')).toBe('write');
});
test.each(['Write', 'Edit', 'edit', 'apply_patch', 'run_shell_command', null])(
  'Qwen raw tool %j cannot borrow authored Write',
  (tool) => {
    expect(originalNativeFileOperation('qwen-code', tool)).toBeNull();
    expect(() =>
      readQwenOriginalWrite(JSON.stringify({ ...original(), tool_name: tool }))
    ).toThrow();
  }
);
test.each([
  'session_id',
  'cwd',
  'tool_name',
  'tool_input',
  'tool_use_id',
  'tool_call_id',
  'permission_mode',
])('original root selector %s cannot silently choose a duplicate', (key) => {
  const payload = original();
  const text =
    '{"' + key + '":' + JSON.stringify(payload[key]) + ',' + JSON.stringify(payload).slice(1);
  expect(() => readQwenOriginalWrite(text)).toThrow(/duplicate/);
  const escaped = JSON.stringify(key).replace(
    key[0],
    '\\u' + key.charCodeAt(0).toString(16).padStart(4, '0')
  );
  expect(() =>
    readQwenOriginalWrite(
      '{' + escaped + ':' + JSON.stringify(payload[key]) + ',' + JSON.stringify(payload).slice(1)
    )
  ).toThrow(/duplicate/);
});
test.each(['file_path', 'content'])('original input %s cannot choose a duplicate', (key) => {
  const text = JSON.stringify(original()).replace(
    '"tool_input":{',
    '"tool_input":{"' + key + '":"foreign",'
  );
  expect(() => readQwenOriginalWrite(text)).toThrow(/duplicate/);
});
test.each([
  { file_path: 'relative.ts', content: 'x' },
  { file_path: '/owned/a.ts ', content: 'x' },
  { file_path: '/owned/a.ts', content: 'x', cwd: '/foreign' },
  { file_path: '/owned/a.ts', content: 'x', path: '/foreign' },
  { file_path: '/owned/a.ts', content: 7 },
])('unsupported Qwen input refuses instead of fabricating context: %j', (tool_input) => {
  expect(() => readQwenOriginalWrite(JSON.stringify({ ...original(), tool_input }))).toThrow();
});
test('projection/session/cwd mismatch never selects environment recovery', () => {
  const payload = original();
  expect(() =>
    readQwenOriginalWrite(JSON.stringify(payload), {
      ...payload,
      session_id: 'foreign',
    })
  ).toThrow(/projection/);
  expect(() => readQwenOriginalWrite(JSON.stringify({ ...payload, session_id: '' }))).toThrow(
    /session/
  );
  expect(() => readQwenOriginalWrite(JSON.stringify({ ...payload, cwd: null }))).toThrow(/cwd/);
});
