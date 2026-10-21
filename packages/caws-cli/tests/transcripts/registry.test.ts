import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultTranscriptRegistry,
  createTranscriptRegistry,
  registerTranscriptAdapter,
  type TranscriptHarnessModule,
} from '../../src/transcripts/registry';
import {
  type TranscriptAdapter,
  type NormalizationContext,
} from '../../src/transcripts/harness-common';
import { TranscriptJsonNumericConversionError } from '../../src/transcripts/transcript-json-profile';
import {
  decodeOccurrence,
  type OccurrenceCoordinates,
} from '../../src/transcripts/source-occurrence';
import {
  getMember,
  jsonNumber,
  jsonObject,
  parsePythonJson,
  type JsonObject,
} from '../../src/transcripts/lossless-json';

// The decoder is a caller-selected fixture dependency, not a production profile.
const profile = { id: 'registry-fixture-json', decode: parsePythonJson };
function row(raw: string, extra: Partial<OccurrenceCoordinates> = {}) {
  return decodeOccurrence(Buffer.from(raw), {
    sourceId: 'source',
    sourceGeneration: 'generation',
    occurrenceId: 'row',
    framing: 'complete',
    ...extra,
  });
}
function initial(registry: ReturnType<typeof createTranscriptRegistry>) {
  return registry.createCheckpoint('source', 'generation');
}
interface Counter {
  count: number;
  seen: Set<string>;
}
function counter(id: string, matches = (_row: JsonObject) => true): TranscriptAdapter<Counter> {
  return {
    id,
    revision: id + '/fixture1',
    matches,
    createState: () => ({ count: 0, seen: new Set() }),
    cloneState: (state) => ({ count: state.count, seen: new Set(state.seen) }),
    normalize: (raw, state) => {
      state.count++;
      state.seen.add('safe');
      return {
        state,
        events:
          getMember(raw, 'empty') === true
            ? []
            : [
                {
                  event: { ev: 'assistant_text', text: `${id}:${state.count}:${[...state.seen]}` },
                  nativeMemberPath: ['payload', 'text'],
                },
              ],
      };
    },
  };
}
function contribution<S>(
  adapter: TranscriptAdapter<S>,
  noisePrefixes: readonly string[] = []
): TranscriptHarnessModule {
  return {
    id: adapter.id,
    revision: 'module/1',
    adapters: [registerTranscriptAdapter(adapter)],
    noisePrefixes,
  };
}

test('stock registry declares historical module/adapter order and aggregate noise without an OpenCode row adapter', () => {
  const registry = createDefaultTranscriptRegistry({ dshProfile: profile });
  assert.deepEqual(
    registry.modules.map((module) => module.id),
    ['kimi-code', 'dsh', 'codex', 'qwen-code', 'claude', 'zcode', 'opencode']
  );
  assert.deepEqual(
    registry.adapters.map((adapter) => adapter.id),
    ['kimi-code', 'dsh', 'codex', 'qwen-code', 'claude', 'zcode']
  );
  assert.deepEqual(registry.modules[6]!.adapters, []);
  assert.deepEqual(registry.noisePrefixes, [
    '<local-command',
    '<command-name',
    '<command-message',
    '<local-command-stdout',
    '<local-command-caveat',
    'This session is being continued',
    '<!-- copy-turn:',
    "This slash command's behavior is handled entirely by",
    'Operation stopped by hook:',
    "The TodoWrite tool hasn't been used recently",
    'The following tool was executed by the user',
    '[Sterling context-authority',
    '<system-reminder>',
  ]);
  assert.deepEqual(registry.context.orderedAdapters, registry.adapters);
  assert.equal(Object.isFrozen(registry), true);
  assert.equal(Object.isFrozen(registry.modules), true);
  for (const module of registry.modules) {
    assert.equal(Object.isFrozen(module), true);
    assert.equal(Object.isFrozen(module.adapters), true);
    assert.equal(Object.isFrozen(module.noisePrefixes), true);
  }
});

// These independently derived historical factory rows discriminate all six owners.
const builtins = [
  [
    'kimi-code',
    '{"type":"context.append_loop_event","time":0,"event":{"type":"tool.call","name":"ReadFile","toolCallId":"k","args":{"path":"evidence-only.txt"}}}',
  ],
  [
    'dsh',
    '{"type":"tool/call","time":0,"data":{"name":"Read","callId":"d","arguments":{"file_path":"evidence-only.txt"}}}',
  ],
  [
    'codex',
    '{"type":"response_item","payload":{"type":"function_call","name":"Read","call_id":"c","arguments":"{\\"file_path\\":\\"evidence-only.txt\\"}"}}',
  ],
  [
    'qwen-code',
    '{"type":"assistant","message":{"parts":[{"functionCall":{"name":"read_file","id":"q","args":{"path":"evidence-only.txt"}}}]}}',
  ],
  [
    'claude',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","id":"cl","input":{"file_path":"evidence-only.txt"}}]}}',
  ],
  [
    'zcode',
    '{"type":"model_io","turnId":"z","response":{"text":"non-tool text","toolCalls":[{"name":"Read","id":"z","input":{"file_path":"evidence-only.txt"}}]}}',
  ],
] as const;
for (const [id, raw] of builtins)
  test(`stock registry dispatch reaches actual ${id} projection`, () => {
    const registry = createDefaultTranscriptRegistry({ dshProfile: profile });
    const parsed = row(raw),
      result = registry.normalize(parsed, initial(registry));
    assert.equal(result.disposition, 'normalized');
    assert.equal(result.selectedAdapter!.id, id);
    const tool = result.events.find((event) => event.event.ev === 'tool_use');
    assert.ok(tool);
    assert.equal(tool.event.source_harness, id);
    assert.deepEqual(tool.adapter, result.selectedAdapter);
    assert.equal(tool.source, parsed.source);
    assert.equal(result.original, parsed);
    assert.equal(result.source.rawBase64, Buffer.from(raw).toString('base64'));
    assert.ok(tool.nativeMemberPath.length);
    assert.equal(result.commitAllowed, true);
  });

test('matched-empty Qwen owns overlapping Claude text and suppresses fallback', () => {
  const registry = createDefaultTranscriptRegistry({ dshProfile: profile });
  const previous = initial(registry);
  const result = registry.normalize(
    row('{"type":"user","message":{"parts":[null],"content":"CLAUDE_MUST_NOT_LEAK"}}'),
    previous
  );
  assert.equal(result.disposition, 'normalized');
  assert.equal(result.selectedAdapter!.id, 'qwen-code');
  assert.deepEqual(result.events, []);
  assert.equal(result.commitAllowed, true);
  assert.notEqual(result.nextState, previous);
});

test('complete matched-empty state advances while later adapters are never consulted', () => {
  let fallbackMatches = 0;
  const later = counter('later', () => {
    fallbackMatches++;
    return true;
  });
  const registry = createTranscriptRegistry([contribution(counter('first')), contribution(later)]);
  const empty = registry.normalize(row('{"empty":true}'), initial(registry));
  const visible = registry.normalize(row('{}'), empty.nextState);
  assert.deepEqual(empty.events, []);
  assert.equal(visible.events[0]!.event.text, 'first:2:safe');
  assert.equal(fallbackMatches, 0);
});

test('interleaved adapters preserve independent state slots', () => {
  const registry = createTranscriptRegistry([
    contribution(counter('a', (raw) => getMember(raw, 'kind') === 'a')),
    contribution(counter('b', (raw) => getMember(raw, 'kind') === 'b')),
  ]);
  let state = initial(registry);
  const texts: unknown[] = [];
  for (const kind of ['a', 'b', 'a']) {
    const result = registry.normalize(row(`{"kind":"${kind}"}`), state);
    state = result.nextState;
    texts.push(result.events[0]!.event.text);
  }
  assert.deepEqual(texts, ['a:1:safe', 'b:1:safe', 'a:2:safe']);
});

test('partial projections retain raw envelopes and cannot advance the reusable checkpoint', () => {
  const registry = createTranscriptRegistry([contribution(counter('a'))]);
  const previous = initial(registry);
  const partial = row('{}', { framing: 'partial' });
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = registry.normalize(partial, previous);
    assert.equal(result.events[0]!.event.text, 'a:1:safe');
    assert.equal(result.events[0]!.source, partial.source);
    assert.equal(result.tentative, true);
    assert.equal(result.commitAllowed, false);
    assert.equal(result.nextState, previous);
  }
  const completed = registry.normalize(row('{}'), previous);
  assert.equal(completed.events[0]!.event.text, 'a:1:safe');
  assert.notEqual(completed.nextState, previous);
});

test('normalizer failure leaks no state and never falls through', () => {
  const base = counter('first');
  const failure = new Error('after mutable draft');
  let fallbacks = 0;
  const first = {
    ...base,
    normalize: (raw: JsonObject, state: Counter) => {
      if (getMember(raw, 'fail') === true) {
        state.count = 40;
        state.seen.add('leak');
        throw failure;
      }
      return base.normalize(raw, state);
    },
  };
  const registry = createTranscriptRegistry([
    contribution(first),
    contribution(
      counter('fallback', () => {
        fallbacks++;
        return true;
      })
    ),
  ]);
  const previous = initial(registry);
  assert.throws(
    () => registry.normalize(row('{"fail":true}'), previous),
    (error) => error === failure
  );
  const result = registry.normalize(row('{}'), previous);
  assert.equal(result.events[0]!.event.text, 'first:1:safe');
  assert.equal(fallbacks, 0);
});

test('matcher failure does not consult later adapters', () => {
  const failure = new Error('matcher failed');
  let fallbacks = 0;
  const registry = createTranscriptRegistry([
    contribution(
      counter('first', () => {
        throw failure;
      })
    ),
    contribution(
      counter('fallback', () => {
        fallbacks++;
        return true;
      })
    ),
  ]);
  assert.throws(
    () => registry.normalize(row('{}'), initial(registry)),
    (error) => error === failure
  );
  assert.equal(fallbacks, 0);
});

test('source, generation, context and foreign registry checkpoints refuse before matching', () => {
  let matches = 0;
  const modules = [
    contribution(
      counter('first', () => {
        matches++;
        return true;
      })
    ),
  ];
  const registry = createTranscriptRegistry(modules);
  const previous = initial(registry);
  for (const extra of [{ sourceId: 'other' }, { sourceGeneration: 'other' }]) {
    const result = registry.normalize(row('{}', extra), previous);
    assert.equal(result.disposition, 'source_mismatch');
    assert.equal(result.nextState, previous);
  }
  const changed = createTranscriptRegistry(modules, { surface: '' });
  assert.equal(changed.normalize(row('{}'), previous).disposition, 'context_mismatch');
  const sameLabels = createTranscriptRegistry(modules);
  assert.equal(sameLabels.normalize(row('{}'), previous).disposition, 'adapter_mismatch');
  assert.equal(matches, 0);
  assert.throws(() => registry.normalize(row('{}'), { ...previous }), /original checkpoint/);
  assert.throws(() => registry.normalize({ ...row('{}') }, previous), /decoded raw occurrence/);
});

test('invalid and unmatched occurrences remain explicit with no invented events or state', () => {
  let matches = 0;
  const registry = createTranscriptRegistry([
    contribution(
      counter('first', () => {
        matches++;
        return false;
      })
    ),
  ]);
  const previous = initial(registry);
  const inputs = [
    [
      decodeOccurrence(Buffer.from([0xff]), {
        sourceId: 'source',
        sourceGeneration: 'generation',
        occurrenceId: 'invalid-utf8',
        framing: 'complete',
      }),
      'invalid_utf8',
    ],
    [row('{'), 'invalid_json'],
    [row('[]'), 'non_object'],
    [row('{}'), 'unmatched'],
  ] as const;
  for (const [parsed, disposition] of inputs) {
    const result = registry.normalize(parsed, previous);
    assert.equal(result.disposition, disposition);
    assert.equal(result.original, parsed);
    assert.equal(result.nextState, previous);
    assert.equal(result.selectedAdapter, null);
    assert.equal(result.commitAllowed, false);
    assert.deepEqual(result.events, []);
  }
  assert.equal(matches, 1);
});

test('surface attribution follows historical fallback and changes tool events only', () => {
  const base = counter('fixture');
  const adapter: TranscriptAdapter<Counter> = {
    ...base,
    normalize: (_raw, state) => ({
      state,
      events: [
        {
          event: { ev: 'tool_use', name: 'Read', source_harness: 'old' },
          nativeMemberPath: ['tool'],
        },
        {
          event: { ev: 'assistant_text', text: 'text', source_harness: 'kept' },
          nativeMemberPath: ['text'],
        },
      ],
    }),
  };
  const expected = new Map<string | undefined, string>([
    [undefined, 'fixture'],
    ['', 'fixture'],
    ['unknown', 'fixture'],
    ['kimi-code', 'fixture'],
    ['__proto__', 'fixture'],
    ['constructor', 'fixture'],
    ['claude-code', 'claude'],
    ['codex', 'codex'],
    ['dsh', 'dsh'],
    ['qwen-code', 'qwen-code'],
    ['opencode', 'opencode'],
    ['zcode', 'zcode'],
  ]);
  for (const [surface, attribution] of expected) {
    const registry = createTranscriptRegistry(
      [contribution(adapter)],
      surface === undefined ? {} : { surface }
    );
    const result = registry.normalize(row('{}'), initial(registry));
    assert.deepEqual(
      result.events.map((event) => event.event.source_harness),
      [attribution, 'kept']
    );
    assert.deepEqual(
      result.events.map((event) => event.emissionIndex),
      [0, 1]
    );
  }
});

test('duplicate keys and large numeric lexemes retain raw custody and selected projection values', () => {
  const registry = createDefaultTranscriptRegistry({ dshProfile: profile });
  const raw =
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","id":1,"id":9007199254740993,"input":{"n":9007199254740995}}]}}';
  const result = registry.normalize(row(raw), initial(registry));
  const event = result.events[0]!;
  assert.equal(result.source.rawBase64, Buffer.from(raw).toString('base64'));
  assert.deepEqual(event.event.id, jsonNumber('9007199254740993'));
  assert.deepEqual(getMember(event.event.input, 'n'), jsonNumber('9007199254740995'));
  assert.deepEqual(event.nativeMemberPath, ['message', 'content', 0]);
});

test('empty registry is unmatched and declaration snapshots retain duplicate noise without filtering', () => {
  const empty = createTranscriptRegistry([]);
  const result = empty.normalize(row('{}'), initial(empty));
  assert.equal(result.disposition, 'unmatched');
  assert.equal(result.commitAllowed, false);
  const prefixes = ['noise', 'noise'];
  const module = contribution(counter('a'), prefixes);
  const modules = [module];
  const registry = createTranscriptRegistry(modules);
  prefixes.push('later');
  modules.length = 0;
  assert.deepEqual(registry.noisePrefixes, ['noise', 'noise']);
  assert.equal(
    registry.normalize(row('{"text":"noise"}'), initial(registry)).selectedAdapter!.id,
    'a'
  );
});

test('duplicate identities, forged registration and incomplete checkpoint identity are rejected', () => {
  const module = contribution(counter('a'));
  assert.throws(() => createTranscriptRegistry([module, module]), /unique and nonempty/);
  const forged = { ...module, adapters: [{ ...module.adapters[0]! }] };
  assert.throws(() => createTranscriptRegistry([forged]), /unregistered/);
  const registry = createTranscriptRegistry([module]);
  assert.throws(() => registry.createCheckpoint('', 'generation'), /nonempty source/);
  assert.throws(() => registry.createCheckpoint('source', ''), /nonempty source/);
  assert.equal(Object.isFrozen(initial(registry)), true);
});

test('registration captures callback references and DSH requires an explicit named decoder', () => {
  const adapter = counter('a');
  const module = contribution(adapter);
  adapter.normalize = () => {
    throw new Error('replacement must not execute');
  };
  const registry = createTranscriptRegistry([module]);
  assert.equal(registry.normalize(row('{}'), initial(registry)).events[0]!.event.text, 'a:1:safe');
  assert.throws(
    () => createDefaultTranscriptRegistry({ dshProfile: { id: '', decode: parsePythonJson } }),
    /profile requires/
  );
  const other = createDefaultTranscriptRegistry({
    dshProfile: { ...profile, id: 'another-decoder' },
  });
  const original = createDefaultTranscriptRegistry({ dshProfile: profile });
  assert.notEqual(other.adapters[1]!.revision, original.adapters[1]!.revision);
  assert.equal(other.normalize(row('{}'), initial(original)).disposition, 'context_mismatch');
});

test('the selected DSH decoder actually receives arguments and its non-syntax failure cannot fall through', () => {
  let calls = 0;
  const selected = {
    id: 'chosen-decoder',
    decode: (raw: string) => {
      calls++;
      assert.equal(raw, 'fixture-input');
      return jsonObject([['decoded_by', 'chosen-decoder']]);
    },
  };
  const registry = createDefaultTranscriptRegistry({ dshProfile: selected });
  selected.decode = () => {
    throw new Error('replacement decoder must not execute');
  };
  const parsed = row(
    '{"type":"tool/call","data":{"name":"Read","callId":"d","arguments":"fixture-input"}}'
  );
  const result = registry.normalize(parsed, initial(registry));
  assert.equal(result.selectedAdapter!.id, 'dsh');
  assert.equal(getMember(result.events[0]!.event.input, 'decoded_by'), 'chosen-decoder');
  assert.equal(calls, 1);
  const failure = new Error('selected decoder refused');
  const refusing = createDefaultTranscriptRegistry({
    dshProfile: {
      id: 'refusing-decoder',
      decode: () => {
        throw failure;
      },
    },
  });
  const checkpoint = initial(refusing);
  assert.throws(
    () => refusing.normalize(parsed, checkpoint),
    (error) => error === failure
  );
  const valid = refusing.normalize(
    row('{"type":"tool/call","data":{"name":"Read","arguments":{}}}'),
    checkpoint
  );
  assert.equal(valid.selectedAdapter!.id, 'dsh');
  assert.equal(valid.commitAllowed, true);
});

const numericProfile = { id: 'selected-json-4300', integerMaxDigits: 4300 };
const overlongInteger = '1'.repeat(4301);

test('selected registry profile is frozen data, passed as actual context, and mismatches on identity or limit', () => {
  let received: NormalizationContext | undefined;
  const base = counter('context-observer');
  const adapter: TranscriptAdapter<Counter> = {
    ...base,
    normalize(raw, state, context) {
      received = context;
      return base.normalize(raw, state);
    },
  };
  const supplied = { ...numericProfile };
  const modules = [contribution(adapter)];
  const registry = createTranscriptRegistry(modules, { numericProfile: supplied });
  supplied.id = 'changed';
  supplied.integerMaxDigits = 0;
  const checkpoint = initial(registry);
  assert.equal(
    registry.normalize(row('{}'), checkpoint).events[0]!.event.text,
    'context-observer:1:safe'
  );
  assert.equal(received, registry.context);
  assert.deepEqual(registry.context.numericProfile, numericProfile);
  assert.equal(Object.isFrozen(registry.context.numericProfile), true);
  for (const changed of [
    { ...numericProfile, id: 'other' },
    { ...numericProfile, integerMaxDigits: 0 },
  ]) {
    const other = createTranscriptRegistry(modules, { numericProfile: changed });
    assert.equal(other.normalize(row('{}'), checkpoint).disposition, 'context_mismatch');
  }
  const historical = createTranscriptRegistry(modules);
  assert.equal(historical.normalize(row('{}'), checkpoint).disposition, 'context_mismatch');
});

test('default registry accepts exactly one shared numeric policy or historical custom DSH decoder', () => {
  const selectedInput = { ...numericProfile };
  const selected = createDefaultTranscriptRegistry({ numericProfile: selectedInput });
  selectedInput.integerMaxDigits = 0;
  assert.deepEqual(selected.context.numericProfile, numericProfile);
  assert.equal(
    createDefaultTranscriptRegistry({ dshProfile: profile }).context.numericProfile,
    undefined
  );
  assert.throws(
    // @ts-expect-error Both forms are also rejected for untyped runtime callers.
    () => createDefaultTranscriptRegistry({ numericProfile, dshProfile: profile }),
    /not both/
  );
  const parsed = row(
    JSON.stringify({
      type: 'tool/call',
      data: { name: 'Read', arguments: `{"n":${overlongInteger}}` },
    })
  );
  assert.equal(parsed.disposition, 'parsed');
  assert.throws(
    () => selected.normalize(parsed, initial(selected)),
    TranscriptJsonNumericConversionError
  );
});

for (const [id, nativeRow] of [
  [
    'codex',
    (embedded: string) => ({
      type: 'response_item',
      payload: { type: 'function_call', name: 'Read', call_id: 'c', arguments: embedded },
    }),
  ],
  [
    'dsh',
    (embedded: string) => ({
      type: 'tool/call',
      data: { name: 'Read', callId: 'd', arguments: embedded },
    }),
  ],
] as const)
  test(`selected ${id} mapping conversion is fatal after quoted outer admission, while syntax falls back`, () => {
    const selected = createDefaultTranscriptRegistry({ numericProfile });
    const embedded = `{"n":${overlongInteger},"n":0}`;
    const parsed = row(JSON.stringify(nativeRow(embedded)));
    assert.equal(parsed.disposition, 'parsed');
    const checkpoint = initial(selected);
    assert.throws(
      () => selected.normalize(parsed, checkpoint),
      TranscriptJsonNumericConversionError
    );
    const malformed = selected.normalize(row(JSON.stringify(nativeRow('{invalid'))), checkpoint);
    assert.equal(malformed.selectedAdapter!.id, id);
    assert.equal(getMember(malformed.events[0]!.event.input, 'raw'), '{invalid');
    const historical = createDefaultTranscriptRegistry({ dshProfile: profile });
    const historicalResult = historical.normalize(parsed, initial(historical));
    assert.equal(historicalResult.selectedAdapter!.id, id);
    assert.deepEqual(getMember(historicalResult.events[0]!.event.input, 'n'), jsonNumber('0'));
  });

test('selected Claude hook stdout conversion is fatal after quoted outer admission and syntax remains ignorable', () => {
  const selected = createDefaultTranscriptRegistry({ numericProfile });
  const nativeRow = (stdout: string) => ({
    type: 'attachment',
    attachment: { type: 'hook_success', stdout, hookName: 'fixture' },
  });
  const stdout = `{"ignored":${overlongInteger},"hookSpecificOutput":{"additionalContext":"retained"}}`;
  const parsed = row(JSON.stringify(nativeRow(stdout)));
  assert.equal(parsed.disposition, 'parsed');
  const checkpoint = initial(selected);
  assert.throws(() => selected.normalize(parsed, checkpoint), TranscriptJsonNumericConversionError);
  const malformed = selected.normalize(row(JSON.stringify(nativeRow('{invalid'))), checkpoint);
  assert.equal(malformed.selectedAdapter!.id, 'claude');
  assert.deepEqual(malformed.events, []);
  const historical = createDefaultTranscriptRegistry({ dshProfile: profile });
  const result = historical.normalize(parsed, initial(historical));
  assert.equal(result.events[0]!.event.additional_context, 'retained');
});

test('selected Codex tool output threads the policy to structured text and error classification fallbacks', () => {
  const output = `[{"text":"tool failed: embedded","is_error":true,"n":${overlongInteger}}]`;
  const parsed = row(
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'c', output },
    })
  );
  assert.equal(parsed.disposition, 'parsed');
  const selected = createDefaultTranscriptRegistry({ numericProfile });
  const result = selected.normalize(parsed, initial(selected));
  assert.equal(result.selectedAdapter!.id, 'codex');
  assert.equal(result.events[0]!.event.content, output);
  assert.equal(result.events[0]!.event.is_error, false);
  const historical = createDefaultTranscriptRegistry({ dshProfile: profile });
  assert.equal(historical.normalize(parsed, initial(historical)).events[0]!.event.is_error, true);
});
