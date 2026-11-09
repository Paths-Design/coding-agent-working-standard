'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspectQwenWire } = require('./native-qualification-qwen-wire.cjs');

const session = 'qwen-session';
const init = {
  type: 'system',
  subtype: 'init',
  uuid: session,
  session_id: session,
  cwd: '/fixture/lane',
  qwen_code_version: '0.21.14',
  model: 'fixture-model',
};
const call = {
  type: 'assistant',
  session_id: session,
  parent_tool_use_id: null,
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'write_file',
        input: { file_path: '/fixture/lane/allowed.txt', content: 'sentinel' },
      },
    ],
  },
};
const result = {
  type: 'user',
  session_id: session,
  parent_tool_use_id: null,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: false, content: 'written' }],
  },
};
const terminal = {
  type: 'result',
  subtype: 'success',
  session_id: session,
  is_error: false,
  result: 'done',
};
const callback = {
  session_id: session,
  hook_event_name: 'PreToolUse',
  tool_name: 'write_file',
  tool_call_id: 'call-1',
  tool_use_id: 'toolu-separate',
  cwd: '/fixture/lane',
  tool_input: { file_path: '/fixture/lane/allowed.txt', content: 'sentinel' },
};
const stream = (messages) =>
  Buffer.from(messages.map((message) => JSON.stringify(message)).join('\n') + '\n');
const expected = { cwd: '/fixture/lane', version: '0.21.14', model: 'fixture-model' };
const inspect = (messages = [init, call, result, terminal], callbacks = [callback]) =>
  inspectQwenWire(
    stream(messages),
    callbacks.map((entry) => Buffer.from(JSON.stringify(entry))),
    expected
  );

test('joins the original stream call ID to callback tool_call_id, preserving separate hook ID', () => {
  const observed = inspect();
  assert.equal(observed.sessionId, session);
  assert.deepEqual(
    observed.calls.map(({ callId, hookUseId, toolName, resultError }) => ({
      callId,
      hookUseId,
      toolName,
      resultError,
    })),
    [{ callId: 'call-1', hookUseId: 'toolu-separate', toolName: 'write_file', resultError: false }]
  );
});

test('rejects missing or mismatched callback, session, result and duplicate calls', () => {
  assert.throws(() => inspect(undefined, []), /callback/i);
  assert.throws(
    () => inspect(undefined, [{ ...callback, tool_call_id: 'toolu-separate' }]),
    /callback/i
  );
  assert.throws(() => inspect(undefined, [{ ...callback, session_id: 'other' }]), /session/i);
  assert.throws(() => inspect([init, call, terminal]), /result/i);
  assert.throws(() => inspect([init, call, call, result, terminal]), /duplicate/i);
  assert.throws(() => inspect([init, call, result, result, terminal]), /duplicate/i);
  assert.throws(() => inspect([init, init, call, result, terminal]), /init/i);
  assert.throws(
    () => inspect([init, call, result, { ...terminal, session_id: 'other' }]),
    /session/i
  );
});

test('rejects non-top-level calls, incomplete streams, and mismatched host identity', () => {
  assert.throws(
    () => inspect([init, { ...call, parent_tool_use_id: 'parent' }, result, terminal]),
    /parent/i
  );
  assert.throws(() => inspect([init, call, result]), /terminal/i);
  assert.throws(
    () => inspect([{ ...init, qwen_code_version: '0.21.4' }, call, result, terminal]),
    /host/i
  );
  assert.throws(() => inspect([{ ...init, cwd: '/other' }, call, result, terminal]), /host/i);
  assert.throws(() => inspectQwenWire(Buffer.from('{"type":"system"}'), [], expected), /newline/i);
});

test('rejects duplicate JSON selectors, even when one uses an escaped spelling', () => {
  const data = Buffer.from(
    '{"type":"system","subtype":"init","session_id":"bad","session_\\u0069d":"qwen-session"}\n'
  );
  assert.throws(() => inspectQwenWire(data, [], expected), /duplicate/i);
  const raw = Buffer.from(
    '{"session_id":"qwen-session","tool_call_id":"call-1","tool_call_\\u0069d":"call-1"}'
  );
  assert.throws(
    () => inspectQwenWire(stream([init, call, result, terminal]), [raw], expected),
    /duplicate/i
  );
});

test('never turns terminal success into proof a tool succeeded or a callback denied', () => {
  const failed = {
    ...result,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'denied' }],
    },
  };
  assert.equal(inspect([init, call, failed, terminal]).calls[0].resultError, true);
  assert.equal(
    inspect([
      init,
      call,
      result,
      { ...terminal, is_error: true, subtype: 'error_during_execution' },
    ]).terminal.isError,
    true
  );
});

test('preserves a changed callback input for scenario-level comparison', () => {
  const observed = inspect(undefined, [{ ...callback, tool_input: { file_path: '/different' } }]);
  assert.equal(observed.calls[0].input.file_path, '/fixture/lane/allowed.txt');
  assert.equal(observed.calls[0].callbackInput.file_path, '/different');
  assert.throws(() => inspect([init, terminal], []), /missing tool call/i);
});

test('refuses separate calls sharing a callback hook identity', () => {
  const secondCall = JSON.parse(JSON.stringify(call));
  secondCall.message.content[0].id = 'call-2';
  const secondResult = JSON.parse(JSON.stringify(result));
  secondResult.message.content[0].tool_use_id = 'call-2';
  assert.throws(
    () =>
      inspect(
        [init, call, result, secondCall, secondResult, terminal],
        [callback, { ...callback, tool_call_id: 'call-2' }]
      ),
    /duplicate hook/i
  );
});
