import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  accumulateRendererEvents,
  boundedRendererText,
  compactRendererWhitespace,
  extractRendererHeuristicFields,
  type RendererDurationPort,
} from '../../src/transcripts/render-accumulator';
import { readRendererSource, RENDER_JSON_UNLIMITED } from '../../src/transcripts/render-reader';
import {
  createDefaultTranscriptRegistry,
  createTranscriptRegistry,
  registerTranscriptAdapter,
  type TranscriptRegistry,
} from '../../src/transcripts/registry';
import type { CanonicalEvent, TranscriptAdapter } from '../../src/transcripts/harness-common';
import { parsePythonJson, jsonNumber } from '../../src/transcripts/lossless-json';
import {
  renderGet,
  renderJsonDumps,
  renderInteger,
  renderFloat,
  type RenderValue,
  type RenderText,
} from '../../src/transcripts/render-values';
import {
  codepointText,
  codepointTextFromString,
  isCodepointText,
  textEqual,
} from '../../src/transcripts/codepoint-text';
import { UNICODE_PROFILE_ID } from '../../src/transcripts/python-unicode-profile';

function stock(surface?: string): TranscriptRegistry {
  return createDefaultTranscriptRegistry({
    dshProfile: { id: 'accumulator-fixture-json', decode: parsePythonJson },
    ...(surface === undefined ? {} : { surface }),
  });
}
function read(raw: string, registry = stock()) {
  const bytes = Buffer.from(raw);
  const result = readRendererSource({
    source: {
      sourceId: 'fixture-transcript',
      sourceGeneration: 'fixture-generation',
      inode: 'fixture-inode',
      size: BigInt(bytes.byteLength),
      bytes,
    },
    registry,
    numericProfile: RENDER_JSON_UNLIMITED,
  });
  assert.equal(result.disposition, 'ready');
  return result.events;
}
const rows = (...values: readonly unknown[]): string =>
  values.map((row) => JSON.stringify(row)).join('\n') + '\n';
function fixture(events: readonly CanonicalEvent[]) {
  const adapter: TranscriptAdapter<number> = {
    id: 'accumulator-event-fixture',
    revision: 'fixture/1',
    matches: () => true,
    createState: () => 0,
    cloneState: (value) => value,
    normalize: (_row, index) => ({
      state: index + 1,
      events: [{ event: events[index]!, nativeMemberPath: [] }],
    }),
  };
  const registry = createTranscriptRegistry([
    {
      id: adapter.id,
      revision: adapter.revision,
      adapters: [registerTranscriptAdapter(adapter)],
      noisePrefixes: ['<injected-noise>'],
    },
  ]);
  return { events: read(events.map(() => '{}').join('\n') + '\n', registry), registry };
}
function options(
  registry = stock(),
  duration: RendererDurationPort = {
    profileId: 'fixture-null-duration/1',
    secondsBetween: () => null,
  }
) {
  return { noisePrefixes: registry.noisePrefixes, duration };
}
function value(record: RenderValue | undefined, key: string): RenderValue {
  const result = renderGet(record, key);
  assert.notEqual(result, undefined, 'required semantic field ' + key);
  return result!;
}
function user(content: string, parentUuid?: string) {
  return { type: 'user', message: { content }, ...(parentUuid ? { parentUuid } : {}) };
}
function tool(name: string, id: string, input: unknown) {
  return {
    type: 'assistant',
    timestamp: '2026-10-21T00:00:01Z',
    message: { content: [{ type: 'tool_use', name, id, input }] },
  };
}
function output(id: string, content: string, is_error = false) {
  return {
    type: 'user',
    timestamp: '2026-10-21T00:00:02Z',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
  };
}
function codex(payload: unknown, type = 'response_item') {
  return { type, payload, timestamp: '2026-10-21T00:00:00Z' };
}

test('actual Codex exec retains codepoint-distinct source indexes, attribution, environment and output attachment', () => {
  const source = [
    "await tools.exec_command({cmd:'rg \\uD83D\\uDE00',workdir:'/repo'});",
    "await tools.exec_command({cmd:'rg 😀'});",
    'await tools.exec_command({cmd:\'sed -n "1,2p" /repo/p\\uD83D\\uDE00\'});',
    "await tools.apply_patch('*** Begin Patch\\n*** Add File: /repo/p\\uD83D\\uDE00\\n+x\\n*** End Patch');",
    "await tools.view_image({path:'/repo/image\\uD83D\\uDE00.png'});",
  ].join('\n');
  const registry = stock('codex');
  const events = read(
    rows(
      codex(
        { model: 'gpt-fixture', effort: 'high', cwd: '/repo', approval_policy: 'never' },
        'turn_context'
      ),
      codex({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Inspect the files' }],
      }),
      codex({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'call-1', input: source }),
      codex({
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '[guard] observed' }],
      }),
      codex({
        type: 'custom_tool_call_output',
        call_id: 'call-1',
        output: JSON.stringify([{ text: 'Process exited with code 3\nFAILED target' }]),
      })
    ),
    registry
  );
  assert.equal(events[2]!.derived?.kind, 'codex-source-index');
  const result = accumulateRendererEvents(events, '/repo', options(registry));
  assert.equal(result.turns.length, 1);
  const turn = result.turns[0]!,
    call = turn.timeline[0]!;
  assert.equal(turn.user, 'Inspect the files');
  assert.equal(value(turn.env, 'model'), 'gpt-fixture');
  assert.equal(value(call, 'name'), 'functions.exec');
  assert.equal(value(call, 'source_harness'), 'codex');
  assert.equal(value(call, 'input_raw'), source);
  assert.equal(value(call, 'input_truncated'), false);
  const commands = turn.commands.map((item) => value(item, 'command'));
  assert.equal(commands.length, 3);
  assert.ok(isCodepointText(commands[0]));
  assert.ok(isCodepointText(commands[1]));
  assert.deepEqual(commands[0].codepoints.slice(-2), [0xd83d, 0xde00]);
  assert.deepEqual(commands[1].codepoints.slice(-1), [0x1f600]);
  assert.equal(textEqual(commands[0], commands[1]), false);
  assert.equal(value(turn.commands[0]!, 'execution'), 'not_observed');
  assert.equal(turn.searches.length, 2);
  const edited = turn.edited_files[0]!;
  assert.ok(isCodepointText(edited));
  assert.deepEqual(edited.codepoints, [112, 0xd83d, 0xde00]);
  assert.equal(value(turn.artifacts[0]!, 'execution'), 'not_observed');
  assert.ok(
    turn.read_files.some(
      (path) => isCodepointText(path) && path.codepoints.length === 3 && path.codepoints[0] === 112
    )
  );
  assert.equal(value(call, 'output'), 'Process exited with code 3\nFAILED target');
  assert.equal(value(call, 'is_error'), true);
  assert.equal(value(call, 'output_cut'), false);
  const contexts = value(call, 'hook_contexts');
  assert.ok(Array.isArray(contexts));
  assert.equal(value(contexts[0], 'additional_context'), '[guard] observed');
  assert.equal(turn.hook_contexts.length, 1);
  assert.equal(value(turn.hook_contexts[0]!, 'tool_use_id'), 'call-1');
});

test('pending shell precedes first prompt, merges output, survives shell-only input and filters acknowledgments', () => {
  const registry = stock();
  const events = read(
    rows(
      user('<bash-input>git push</bash-input>'),
      user('<bash-stdout>pushed</bash-stdout><bash-stderr>warning</bash-stderr>'),
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'No response requested.' }] },
      },
      user('<local-command-caveat>injected'),
      user('Continue'),
      tool('Read', 'r', { file_path: '/repo/file.ts' }),
      output('r', '1→data')
    ),
    registry
  );
  const result = accumulateRendererEvents(events, '/repo', options(registry));
  assert.equal(result.turns.length, 1);
  const turn = result.turns[0]!;
  assert.equal(turn.user, 'Continue');
  assert.equal(turn.timeline.length, 2);
  assert.equal(value(turn.timeline[0]!, 'command'), 'git push');
  assert.equal(value(turn.timeline[0]!, 'stdout'), 'pushed');
  assert.equal(value(turn.timeline[0]!, 'stderr'), 'warning');
  assert.equal(value(turn.timeline[1]!, 'file'), 'file.ts');
  assert.equal(value(turn.timeline[1]!, 'output'), '1→data');
  const shellOnly = accumulateRendererEvents(
    read(rows(user('<bash-input>git status</bash-input>')), registry),
    '/repo',
    options(registry)
  );
  assert.equal(shellOnly.turns.length, 1);
  assert.equal(shellOnly.turns[0]!.user, null);
  assert.equal(value(shellOnly.turns[0]!.timeline[0]!, 'command'), 'git status');
});

test('rewinds use newest prompt claimant while noise and parallel tool parent links do not claim slots', () => {
  const registry = stock();
  const result = accumulateRendererEvents(
    read(
      rows(
        user('first', 'slot'),
        tool('Read', 'a', { file_path: '/repo/a' }),
        { ...tool('Read', 'b', { file_path: '/repo/b' }), parentUuid: 'slot' },
        output('a', 'A'),
        user('<local-command-caveat>noise', 'slot'),
        user('edited', 'slot'),
        user('edited', 'slot')
      ),
      registry
    ),
    '/repo',
    options(registry)
  );
  assert.equal(result.turns.length, 3);
  const [first, second, third] = result.turns;
  assert.equal(first!.rewound, true);
  assert.equal(second!.rewound, true);
  assert.equal(second!.rewound_from_turn, first);
  assert.equal(second!.rewind_kind, 'edited_prompt');
  assert.equal(third!.rewound_from_turn, second);
  assert.equal(third!.rewind_kind, 'same_prompt');
  assert.equal(first!.timeline.length, 2);
});

test('actual Claude request dedup spans turns and preserves numeric kinds, booleans, models and last stop', () => {
  const registry = stock();
  const raw =
    [
      JSON.stringify(user('first')),
      '{"type":"assistant","requestId":"r","message":{"id":"m","usage":{"input_tokens":true,"output_tokens":9007199254740993},"model":"one","stop_reason":"tool_use"}}',
      '{"type":"assistant","requestId":"r","message":{"id":"m","usage":{"input_tokens":true,"output_tokens":9007199254740993},"model":"two","stop_reason":"end_turn"}}',
      JSON.stringify(user('second')),
      '{"type":"assistant","requestId":"r","message":{"id":"m","usage":{"input_tokens":true,"output_tokens":9007199254740993},"model":"one"}}',
      '{"type":"assistant","requestId":true,"message":{"id":"next","usage":{"input_tokens":false,"output_tokens":0.5},"model":"three","stop_reason":"max_tokens"}}',
      '{"type":"assistant","requestId":99,"message":{"id":"next","usage":{"input_tokens":50,"output_tokens":0.5},"model":"four","stop_reason":"end_turn"}}',
    ].join('\n') + '\n';
  const result = accumulateRendererEvents(read(raw, registry), '/repo', options(registry));
  assert.equal(result.turns.length, 2);
  assert.equal(
    renderJsonDumps(result.turns[0]!.usage),
    '{"input_tokens": 1, "output_tokens": 9007199254740993}'
  );
  assert.deepEqual(result.turns[0]!.models, ['one', 'two']);
  assert.equal(result.turns[0]!.stop_reason, 'end_turn');
  assert.equal(
    renderJsonDumps(result.turns[1]!.usage),
    '{"input_tokens": 0, "output_tokens": 0.5}'
  );
  assert.deepEqual(result.turns[1]!.models, ['one', 'three', 'four']);
  assert.equal(result.turns[1]!.stop_reason, 'end_turn');
});

test('controls, interjections, audit, hooks and orphan outputs preserve order and attach command errors', () => {
  const f = fixture([
    { ev: 'user_text', text: 'Execute' },
    {
      ev: 'tool_use',
      name: 'Bash',
      id: 'b',
      input: parsePythonJson('{"command":"npm test","description":"checks"}'),
      ts: '2026-10-21T00:00:00.001Z',
    },
    { ev: 'interjection', text: 'Use the fixture' },
    {
      ev: 'control',
      subtype: 'cost_state',
      cost_usd: jsonNumber('1.25'),
      step: true,
      models: ['a', false, 'b'],
    },
    {
      ev: 'hook_context',
      tool_use_id: 'b',
      status: 'ask',
      additional_context: 'review the command',
      exit_code: jsonNumber('2'),
    },
    {
      ev: 'audit_action',
      tool: 'exec_command',
      id: 'audit',
      input: parsePythonJson('{"cmd":"npm test"}'),
      response: parsePythonJson('{"result":"observed"}'),
      is_error: false,
    },
    {
      ev: 'tool_result',
      id: 'b',
      content: 'FAIL checks',
      is_error: true,
      ts: '2026-10-21T00:00:01.006Z',
    },
    { ev: 'user_text', text: '[Request interrupted by user for tool use]' },
    { ev: 'tool_result', id: 'missing', content: 'orphan' },
    {
      ev: 'user_text',
      text: '<task-notification><task-id>t</task-id><summary>done</summary></task-notification>',
    },
  ]);
  const calls: (readonly [string | null, string | null])[] = [];
  const result = accumulateRendererEvents(
    f.events,
    '/repo',
    options(f.registry, {
      profileId: 'fixture-calendar/1',
      secondsBetween: (first, second) => {
        calls.push([first, second]);
        return renderFloat(1.0);
      },
    })
  );
  assert.equal(result.turns.length, 1);
  const turn = result.turns[0]!;
  assert.deepEqual(
    turn.timeline.map((item) => value(item, 'kind')),
    ['tool_call', 'interjection', 'control', 'audit_action', 'tool_output']
  );
  assert.equal(turn.ended_by, 'user_interrupt_tool');
  assert.equal(value(turn.timeline[0]!, 'is_error'), true);
  assert.deepEqual(value(turn.timeline[0]!, 'duration_s'), jsonNumber('1.0'));
  assert.deepEqual(calls, [['2026-10-21T00:00:00.001Z', '2026-10-21T00:00:01.006Z']]);
  assert.equal(value(turn.commands[0]!, 'output_preview'), 'FAIL checks');
  assert.equal(value(turn.commands[0]!, 'is_error'), true);
  assert.equal(turn.commands.length, 1);
  assert.equal(value(turn.timeline[2]!, 'step'), true);
  assert.deepEqual(value(turn.timeline[2]!, 'models'), ['a', 'b']);
  assert.equal(value(turn.timeline[3]!, 'input_preview'), '{"cmd": "npm test"}');
  assert.equal(value(turn.timeline[3]!, 'input_truncated'), false);
  const attached = value(turn.timeline[0]!, 'hook_contexts');
  assert.ok(Array.isArray(attached));
  assert.equal(value(attached[0], 'status'), 'ask');
  assert.equal(value(turn.interjections[0]!, 'text'), 'Use the fixture');
  assert.equal(result.sessionEvents.length, 2);
  assert.equal(value(result.sessionEvents[1]!, 'task_id'), 't');
  assert.equal(value(result.sessionEvents[1]!, 'preview'), 'done');
});

test('explicit duration profile receives naive and aware timestamps unchanged and may reject duration', () => {
  const f = fixture([
    {
      ev: 'tool_use',
      name: 'Read',
      id: 'r',
      input: parsePythonJson('{"file_path":"x"}'),
      ts: '2026-10-21T00:00:00.005',
    },
    { ev: 'tool_result', id: 'r', content: 'x', ts: '2026-10-21T00:00:01.010Z' },
  ]);
  let calls = 0;
  const result = accumulateRendererEvents(
    f.events,
    '/repo',
    options(f.registry, {
      profileId: 'fixture-mixed-awareness/1',
      secondsBetween: (first, second) => {
        calls++;
        assert.equal(first, '2026-10-21T00:00:00.005');
        assert.equal(second, '2026-10-21T00:00:01.010Z');
        return null;
      },
    })
  );
  assert.equal(calls, 1);
  assert.equal(value(result.turns[0]!.timeline[0]!, 'duration_s'), null);
  assert.throws(
    () =>
      accumulateRendererEvents(
        f.events,
        '/repo',
        options(f.registry, {
          profileId: '',
          secondsBetween: () => renderFloat(0),
        })
      ),
    /duration profile/
  );
});

test('retention flags whole text through ceiling and spills exact UTF8 only above ceiling', () => {
  const retained = 'x'.repeat(20000),
    huge = 'a'.repeat(21001) + '😀tail';
  const spill = new Map<string, RenderText>();
  const whole = boundedRendererText(retained, 1800, spill);
  assert.equal(whole.text, retained);
  assert.equal(whole.truncated, true);
  assert.equal(whole.ref, null);
  assert.equal(spill.size, 0);
  const bounded = boundedRendererText(huge, 1800, spill);
  const digest = createHash('sha256').update(huge).digest('hex');
  assert.equal(spill.get(digest), huge);
  assert.ok(bounded.ref);
  assert.equal(value(bounded.ref, 'sha256'), digest);
  assert.deepEqual(value(bounded.ref, 'length'), renderInteger(21006));
  assert.ok(typeof bounded.text === 'string' && bounded.text.endsWith('😀tail'));
  assert.equal(bounded.truncated, true);
  assert.throws(() => boundedRendererText('x'.repeat(21000) + '\ud800', 1800, spill), /surrogate/);
  const pair = codepointText([0xd83d, 0xde00], UNICODE_PROFILE_ID);
  assert.ok(isCodepointText(boundedRendererText(pair, 1).text));
  assert.throws(
    () =>
      boundedRendererText(
        codepointText([...Array(21001).fill(97), 0xd83d, 0xde00], UNICODE_PROFILE_ID),
        1800,
        spill
      ),
    /surrogate/
  );
});

test('heuristics retain codepoint capture and repeated words while Python whitespace compacts', () => {
  const h = extractRendererHeuristicFields([
    'Decisions made:\n- keep custody\n- preserve rows\n\nplan: plan accepted\nnext action: inspect\nblocking issue: blocked',
  ]);
  assert.deepEqual(
    h.decisions.map((item) => value(item, 'statement')),
    ['keep custody', 'preserve rows', 'plan accepted']
  );
  assert.equal(h.next_action, 'inspect');
  assert.equal(h.blocking_issue, 'blocked');
  assert.equal(compactRendererWhitespace('\u001c A\u0085B \u001f', 10), 'A B');
  const prefix = codepointTextFromString('plan: ', UNICODE_PROFILE_ID);
  const cp = codepointText(
    [...prefix.codepoints, 0xd83d, 0xde00, 32, 111, 107],
    UNICODE_PROFILE_ID
  );
  const statement = value(extractRendererHeuristicFields([cp]).decisions[0]!, 'statement');
  assert.ok(isCodepointText(statement));
  assert.deepEqual(statement.codepoints, [0xd83d, 0xde00, 32, 111, 107]);
});

test('late large tool result spills to owning turn while current turn retains late hook and orphan chronology', () => {
  const huge = 'worker-output-'.repeat(1700);
  const f = fixture([
    { ev: 'user_text', text: 'first' },
    {
      ev: 'tool_use',
      name: 'Agent',
      id: 'a',
      input: parsePythonJson('{"prompt":"task","subagent_type":"worker"}'),
    },
    { ev: 'user_text', text: 'next' },
    { ev: 'tool_result', id: 'a', content: huge, is_error: false },
    { ev: 'hook_context', tool_use_id: 'a', additional_context: 'late hook' },
    { ev: 'tool_result', id: 'orphan', content: 'orphan bytes' },
  ]);
  const result = accumulateRendererEvents(f.events, '/repo', options(f.registry));
  assert.equal(result.turns.length, 2);
  const [owner, current] = result.turns;
  const ref = value(owner!.timeline[0]!, 'output_ref'),
    digest = value(ref, 'sha256');
  assert.equal(typeof digest, 'string');
  assert.equal(owner!.payload_spill.get(typeof digest === 'string' ? digest : ''), huge);
  assert.equal(current!.payload_spill.size, 0);
  assert.equal(value(owner!.timeline[0]!, 'output_cut'), true);
  assert.equal(
    value(owner!.agent_runs[0]!, 'status'),
    'launched',
    'current-turn agent index follows the pinned reference'
  );
  assert.equal(value(current!.timeline[0]!, 'content'), 'orphan bytes');
  assert.equal(current!.hook_contexts.length, 1);
  assert.ok(Array.isArray(value(owner!.timeline[0]!, 'hook_contexts')));
  const same = fixture([
    { ev: 'tool_use', name: 'Read', id: 'r', input: parsePythonJson('{"file_path":"x"}') },
    { ev: 'tool_result', id: 'r', content: huge },
  ]);
  const ordinary = accumulateRendererEvents(same.events, '/repo', options(same.registry));
  assert.equal(ordinary.turns[0]!.payload_spill.size, 1);
  assert.equal(value(ordinary.turns[0]!.timeline[0]!, 'output_cut'), true);
});

test('accepted null names and boolean identifiers survive, text misuse and unhashable identifiers refuse', () => {
  const f = fixture([
    { ev: 'tool_use', name: null, id: false, input: null },
    { ev: 'tool_result', id: jsonNumber('0'), content: 'matched boolean id' },
  ]);
  const result = accumulateRendererEvents(f.events, '/repo', options(f.registry));
  assert.equal(value(result.turns[0]!.timeline[0]!, 'name'), null);
  assert.equal(value(result.turns[0]!.timeline[0]!, 'id'), false);
  assert.equal(value(result.turns[0]!.timeline[0]!, 'output'), 'matched boolean id');
  const bad = fixture([{ ev: 'user_text', text: null }]);
  assert.throws(
    () => accumulateRendererEvents(bad.events, '/repo', options(bad.registry)),
    /requires text/
  );
  const unhashable = fixture([{ ev: 'tool_use', name: 'unknown', id: [], input: null }]);
  assert.throws(
    () => accumulateRendererEvents(unhashable.events, '/repo', options(unhashable.registry)),
    /Unhashable/
  );
});

test('control subtype provenance uses Python str on accepted canonical scalars and mappings', () => {
  const f = fixture([
    { ev: 'control', subtype: true, duration_ms: false, step: true },
    { ev: 'control', subtype: false },
    { ev: 'control', subtype: jsonNumber('1.5') },
    { ev: 'control', subtype: parsePythonJson('{"a":true}'), provenance: null },
  ]);
  const turn = accumulateRendererEvents(f.events, '/repo', options(f.registry)).turns[0]!;
  assert.equal(value(turn.timeline[0]!, 'subtype'), true);
  assert.equal(value(turn.timeline[0]!, 'provenance'), 'harness:True');
  assert.equal(value(turn.timeline[0]!, 'duration_ms'), false);
  assert.equal(value(turn.timeline[0]!, 'step'), true);
  assert.equal(value(turn.timeline[1]!, 'subtype'), 'control');
  assert.equal(value(turn.timeline[1]!, 'provenance'), 'harness:control');
  assert.equal(value(turn.timeline[2]!, 'provenance'), 'harness:1.5');
  assert.equal(
    value(turn.timeline[3]!, 'provenance'),
    null,
    'explicit null is not an absent default'
  );
  assert.equal(renderJsonDumps(value(turn.timeline[3]!, 'subtype')), '{"a": true}');
});

test('heuristics use pinned Python ASCII ignore-case additions and include carriage returns in dot captures', () => {
  const h = extractRendererHeuristicFields([
    'decısion: dotted less\nDECİSİON: dotted capital\nſtrategy: long s\nplan: a\rb\nnext action: c\rd\nblocked: e\rf',
  ]);
  // The pinned finditer patterns consume their trailing LF; an immediately
  // adjacent matching line therefore has no prefix LF left for that pattern.
  assert.deepEqual(
    h.decisions.map((item) => value(item, 'statement')),
    ['dotted less', 'long s']
  );
  assert.deepEqual(
    extractRendererHeuristicFields(['DECİSİON: dotted capital']).decisions.map((item) =>
      value(item, 'statement')
    ),
    ['dotted capital']
  );
  assert.deepEqual(
    extractRendererHeuristicFields(['plan: a\rb']).decisions.map((item) =>
      value(item, 'statement')
    ),
    ['a\rb']
  );
  assert.equal(h.next_action, 'c\rd');
  assert.equal(h.blocking_issue, 'e\rf');
  const registry = stock('codex');
  const source = "await tools.exec_command({cmd:'ſed -n 1p /repo/not-a-read'});";
  const events = read(
    rows(codex({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'c', input: source })),
    registry
  );
  const result = accumulateRendererEvents(events, '/repo', options(registry));
  assert.equal(
    result.turns[0]!.read_files.length,
    0,
    'source command indexing remains case-sensitive'
  );
});

test('Claude-shaped OpenCode rows retain surface attribution separately from the selected adapter identity', () => {
  const registry = stock('opencode');
  const events = read(
    rows(user('inspect'), tool('Read', 'r', { file_path: '/repo/file' }), output('r', 'observed')),
    registry
  );
  assert.equal(events[1]!.envelope.adapter.id, 'claude');
  assert.equal(events[1]!.envelope.event.source_harness, 'opencode');
  const result = accumulateRendererEvents(events, '/repo', options(registry));
  assert.equal(value(result.turns[0]!.timeline[0]!, 'source_harness'), 'opencode');
  assert.equal(value(result.turns[0]!.timeline[0]!, 'file'), 'file');
  assert.equal(value(result.turns[0]!.timeline[0]!, 'output'), 'observed');
});

test('actual Claude edit, write, searches, command artifacts, subagent, skill and plan keep their semantic fields', () => {
  const registry = stock(),
    old = 'o'.repeat(2001),
    replacement = 'n'.repeat(21001);
  const content = 'c'.repeat(1601),
    prompt = 'p'.repeat(1801),
    plan = 'plan '.repeat(1300);
  const result = accumulateRendererEvents(
    read(
      rows(
        user('Perform the work'),
        tool('Edit', 'e', { file_path: '/repo/a', old_string: old, new_string: replacement }),
        tool('Write', 'w', { file_path: '/repo/b', content }),
        tool('Grep', 'g', { pattern: 'needle', path: '/repo' }),
        tool('WebFetch', 'web', { url: 'https://fixture.invalid/doc' }),
        tool('Bash', 'b', {
          command: 'git commit -m change; pnpm test',
          description: 'record',
          run_in_background: 'false',
        }),
        tool('Task', 't', {
          prompt,
          subagent_type: 'worker',
          isolation: 'worktree',
          run_in_background: 'true',
        }),
        output('t', '[{"text":"worker result"}]', true),
        tool('Skill', 's', { skill: 'review', args: null }),
        tool('ExitPlanMode', 'plan', { plan })
      ),
      registry
    ),
    '/repo',
    options(registry)
  );
  const turn = result.turns[0]!;
  assert.equal(result.turns.length, 1);
  assert.deepEqual(turn.edited_files, ['a', 'b']);
  const edit = turn.timeline[0]!,
    write = turn.timeline[1]!;
  assert.equal(value(edit, 'old_string'), old);
  assert.deepEqual(value(edit, 'old_string_length'), renderInteger(2001));
  assert.equal(value(edit, 'old_string_truncated'), true);
  const ref = value(edit, 'new_string_ref'),
    digest = value(ref, 'sha256');
  assert.equal(typeof digest, 'string');
  assert.equal(turn.payload_spill.get(typeof digest === 'string' ? digest : ''), replacement);
  assert.equal(value(write, 'content_preview'), content);
  assert.equal(value(write, 'content_truncated'), true);
  assert.deepEqual(
    turn.searches.map((item) => value(item, 'query')),
    ['needle', 'https://fixture.invalid/doc']
  );
  assert.deepEqual(
    turn.artifacts.map((item) => value(item, 'type')),
    ['file_edit', 'file_write', 'git_commit', 'test_run', 'plan']
  );
  assert.equal(value(turn.commands[0]!, 'description'), 'record');
  assert.equal(value(turn.timeline[4]!, 'run_in_background'), false);
  const task = turn.timeline[5]!;
  assert.equal(value(task, 'prompt'), prompt);
  assert.equal(value(task, 'prompt_truncated'), true);
  assert.equal(value(task, 'run_in_background'), true);
  assert.equal(value(task, 'isolation'), 'worktree');
  assert.equal(value(task, 'output'), 'worker result');
  assert.equal(value(turn.agent_runs[0]!, 'status'), 'error');
  assert.equal(value(turn.timeline[6]!, 'skill'), 'review');
  assert.equal(value(turn.timeline[6]!, 'args'), null);
  assert.equal(value(turn.timeline[7]!, 'plan'), plan);
  assert.equal(value(turn.timeline[7]!, 'plan_truncated'), true);
  assert.equal(value(turn.artifacts[4]!, 'content'), plan);
  assert.equal(value(turn.artifacts[4]!, 'content_truncated'), true);
});

test('prepared Codex index correlation refuses another source, profile and field path without claiming authenticity', () => {
  const registry = stock('codex');
  const source = "await tools.exec_command({cmd:'git status'});";
  const events = read(
    rows(codex({ type: 'custom_tool_call', name: 'functions.exec', call_id: 'c', input: source })),
    registry
  );
  assert.ok(events[0]!.derived);
  const otherSource = events.map((event) =>
    event.derived === null
      ? event
      : {
          ...event,
          derived: {
            ...event.derived,
            index: { ...event.derived.index, rawSource: 'different source' },
          },
        }
  );
  assert.throws(
    () => accumulateRendererEvents(otherSource, '/repo', options(registry)),
    /event context/
  );
  const otherProfile = events.map((event) =>
    event.derived === null
      ? event
      : {
          ...event,
          derived: {
            ...event.derived,
            index: { ...event.derived.index, interpretationProfileId: 'foreign-profile' },
          },
        }
  );
  assert.throws(
    () => accumulateRendererEvents(otherProfile, '/repo', options(registry)),
    /event context/
  );
  const otherField = events.map((event) =>
    event.derived === null
      ? event
      : {
          ...event,
          derived: { ...event.derived, sourceField: ['input', 'another-field'] },
        }
  );
  assert.throws(
    () =>
      Reflect.apply(accumulateRendererEvents, undefined, [otherField, '/repo', options(registry)]),
    /event context/
  );
  assert.equal(
    accumulateRendererEvents(events, '/repo', options(registry)).turns[0]!.commands.length,
    1
  );
});
