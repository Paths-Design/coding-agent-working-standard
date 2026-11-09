'use strict';

// This inspects retained wire identities only. It does not assert a guard decision,
// child settlement, native execution, filesystem effects, or qualification.
const acorn = require('acorn');
const { TextDecoder } = require('node:util');
const MAX_STREAM = 8 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024;
const MAX_CALLBACKS = 1024;
const fail = (message) => {
  throw new Error(message);
};
const insist = (condition, message) => {
  if (!condition) fail(message);
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 4096;

function strictRecord(bytes) {
  insist(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_RECORD,
    'Invalid record size'
  );
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value = JSON.parse(source);
  const ast = acorn.parseExpressionAt(source, 0, { ecmaVersion: 2022 });
  const visit = (node, depth) => {
    insist(depth <= 64, 'Record nesting limit exceeded');
    if (node.type === 'ObjectExpression') {
      const keys = new Set();
      for (const property of node.properties) {
        const key = property.key.value;
        insist(typeof key === 'string' && !keys.has(key), 'Duplicate JSON selector');
        keys.add(key);
        visit(property.value, depth + 1);
      }
    } else if (node.type === 'ArrayExpression') {
      for (const element of node.elements) visit(element, depth + 1);
    }
  };
  visit(ast, 0);
  insist(object(value), 'Expected a JSON object');
  return value;
}

function inspectQwenWire(bytes, callbackBytes, expected) {
  insist(
    Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_STREAM,
    'Invalid stream size'
  );
  insist(bytes.at(-1) === 10, 'Stream must end with newline');
  insist(
    Array.isArray(callbackBytes) && callbackBytes.length <= MAX_CALLBACKS,
    'Invalid callback inventory'
  );
  insist(
    object(expected) && text(expected.cwd) && text(expected.version) && text(expected.model),
    'Invalid expected host'
  );
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, -1).split('\n');
  insist(lines.length <= 4096 && lines.every(Boolean), 'Invalid stream records');
  const messages = lines.map((line) => strictRecord(Buffer.from(line)));
  const inits = messages.filter(
    (message) => message.type === 'system' && message.subtype === 'init'
  );
  insist(inits.length === 1 && messages[0] === inits[0], 'Expected exactly one first init');
  const init = inits[0];
  insist(text(init.session_id) && init.uuid === init.session_id, 'Invalid init session');
  insist(
    init.cwd === expected.cwd &&
      init.qwen_code_version === expected.version &&
      init.model === expected.model,
    'Qwen host identity mismatch'
  );
  const sessionId = init.session_id;
  const calls = new Map();
  let terminal = null;
  for (let index = 1; index < messages.length; index++) {
    const message = messages[index];
    insist(message.session_id === sessionId, 'Stream session mismatch');
    insist(!terminal, 'Record after terminal result');
    if (message.type === 'result') {
      insist(
        index === messages.length - 1 && typeof message.is_error === 'boolean',
        'Invalid terminal result'
      );
      terminal = { subtype: message.subtype, isError: message.is_error };
      continue;
    }
    if (!['assistant', 'user'].includes(message.type)) continue;
    insist(message.parent_tool_use_id === null, 'Unexpected parent tool');
    insist(
      object(message.message) &&
        message.message.role === message.type &&
        Array.isArray(message.message.content),
      'Invalid message content'
    );
    for (const block of message.message.content) {
      insist(object(block), 'Invalid content block');
      if (message.type === 'assistant' && block.type === 'tool_use') {
        insist(text(block.id) && text(block.name) && object(block.input), 'Invalid tool call');
        insist(!calls.has(block.id), 'Duplicate tool call');
        calls.set(block.id, {
          callId: block.id,
          toolName: block.name,
          input: block.input,
          resultError: null,
        });
      }
      if (message.type === 'user' && block.type === 'tool_result') {
        const call = calls.get(block.tool_use_id);
        insist(call && typeof block.is_error === 'boolean', 'Unexpected tool result');
        insist(call.resultError === null, 'Duplicate tool result');
        call.resultError = block.is_error;
      }
    }
  }
  insist(terminal, 'Missing terminal result');
  insist(calls.size > 0, 'Missing tool call');
  insist(
    [...calls.values()].every((call) => call.resultError !== null),
    'Missing tool result'
  );
  const hooks = new Set();
  const hookUseIds = new Set();
  for (const raw of callbackBytes) {
    const callback = strictRecord(raw);
    insist(callback.session_id === sessionId, 'Callback session mismatch');
    insist(
      callback.cwd === expected.cwd &&
        callback.hook_event_name === 'PreToolUse' &&
        object(callback.tool_input),
      'Invalid callback context'
    );
    const call = calls.get(callback.tool_call_id);
    insist(
      call && callback.tool_name === call.toolName && text(callback.tool_use_id),
      'Unmatched callback'
    );
    insist(!hooks.has(callback.tool_call_id), 'Duplicate callback');
    insist(!hookUseIds.has(callback.tool_use_id), 'Duplicate hook use ID');
    hooks.add(callback.tool_call_id);
    hookUseIds.add(callback.tool_use_id);
    call.hookUseId = callback.tool_use_id;
    // Qwen may normalize path arguments before the callback. Retain both
    // projections so the scenario can compare the actual intended operation.
    call.callbackInput = callback.tool_input;
  }
  insist(hooks.size === calls.size, 'Missing callback');
  return { sessionId, terminal, calls: [...calls.values()] };
}

module.exports = { inspectQwenWire };
