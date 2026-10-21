import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { codepointText } from '../../src/transcripts/codepoint-text';
import { jsonNumber } from '../../src/transcripts/lossless-json';
import {
  accumulateRendererEvents,
  type RenderTurn,
} from '../../src/transcripts/render-accumulator';
import {
  buildRendererTurnPayload,
  isPreparedSessionArtifact,
  prepareRendererArtifacts,
} from '../../src/transcripts/render-artifacts';
import { createDefaultTranscriptRegistry } from '../../src/transcripts/registry';
import { readRendererSource, RENDER_JSON_4300 } from '../../src/transcripts/render-reader';
import {
  renderGet,
  renderInteger,
  renderObject,
  renderTextLength,
} from '../../src/transcripts/render-values';

function turn(): RenderTurn {
  return {
    user: 'one',
    user_ts: '2026-01-01T00:00:00Z',
    payload_spill: new Map(),
    timeline: [],
    hook_contexts: [],
    interjections: [],
    edited_files: [],
    read_files: [],
    searches: [],
    commands: [],
    agent_runs: [],
    artifacts: [],
    control_events: [],
    usage: renderObject(),
    models: [],
    stop_reason: null,
    env: renderObject(),
  };
}
const context = renderObject([
  ['session_id', 's'],
  ['project', 'p'],
  ['branch', 'b'],
  ['head_sha', 'h'],
]);
test('prepares the complete exact minimal turn and index bytes without trailing LF', () => {
  const prepared = prepareRendererArtifacts([turn()], context);
  assert.deepEqual(
    prepared.artifacts.map((item) => [item.name, item.role]),
    [
      ['turn-001.json', 'turn'],
      ['session-index.json', 'index'],
    ]
  );
  const expected = {
    schema_version: 2,
    turn: 1,
    context: { session_id: 's', project: 'p', branch: 'b', head_sha: 'h' },
    payloads_sidecar: null,
    payloads_sha256: [],
    ts_start: '2026-01-01T00:00:00Z',
    ts_end: '2026-01-01T00:00:00Z',
    user: 'one',
    user_ts: '2026-01-01T00:00:00Z',
    turn_summary: null,
    status: 'ok',
    ended_by: null,
    decisions: [],
    next_action: null,
    blocking_issue: null,
    refs: {
      files: { edited: [], read: [] },
      searches: [],
      commands: [],
      agents: [],
      artifacts: [],
    },
    hook_contexts: [],
    interjections: [],
    timeline: [],
  };
  assert.equal(
    Buffer.from(prepared.artifacts[0]!.bytes()).toString(),
    JSON.stringify(expected, null, 2)
  );
  assert.equal(
    Buffer.from(prepared.artifacts[1]!.bytes()).toString(),
    JSON.stringify(
      {
        schema_version: 1,
        session_id: 's',
        project: 'p',
        turn_count: 1,
        ts_start: '2026-01-01T00:00:00Z',
        ts_end: '2026-01-01T00:00:00Z',
        branch: 'b',
        head_sha: 'h',
      },
      null,
      2
    )
  );
  for (const artifact of prepared.artifacts) {
    assert.equal(isPreparedSessionArtifact(artifact), true);
    assert.equal(artifact.byteLength, artifact.bytes().length);
    assert.equal(artifact.sha256, createHash('sha256').update(artifact.bytes()).digest('hex'));
    assert.notEqual(artifact.bytes()[artifact.byteLength - 1], 10);
  }
  assert.equal(isPreparedSessionArtifact({ ...prepared.artifacts[0] }), false);
});
test('retains per-turn spill closure and isolates owned bytes from consumer mutation', () => {
  const current = turn(),
    text = '😀'.repeat(21000);
  const digest = createHash('sha256').update(text).digest('hex');
  current.payload_spill.set(digest, text);
  current.timeline.push(
    renderObject([
      ['kind', 'tool_call'],
      ['output', 'preview'],
      [
        'output_ref',
        renderObject([
          ['sha256', digest],
          ['length', renderInteger(21000)],
        ]),
      ],
    ])
  );
  const prepared = prepareRendererArtifacts([current], context);
  assert.deepEqual(
    prepared.artifacts.map((item) => item.name),
    ['turn-001.payloads.json', 'turn-001.json', 'session-index.json']
  );
  assert.equal(
    Buffer.from(prepared.artifacts[0]!.bytes()).toString(),
    JSON.stringify({ [digest]: text }, null, 2)
  );
  assert.deepEqual(renderGet(prepared.turnPayloads[0], 'payloads_sha256'), [digest]);
  assert.equal(renderGet(prepared.turnPayloads[0], 'payloads_sidecar'), 'turn-001.payloads.json');
  const bytes = prepared.artifacts[0]!.bytes(),
    first = bytes[0];
  bytes[0] = 0;
  assert.equal(prepared.artifacts[0]!.bytes()[0], first);
  current.payload_spill.clear();
  assert.equal(
    prepared.artifacts[0]!.sha256,
    createHash('sha256').update(prepared.artifacts[0]!.bytes()).digest('hex')
  );
});
test('refuses dangling, wrong-length and wrong-content spill references before returning artifacts', () => {
  const current = turn(),
    digest = createHash('sha256').update('full').digest('hex');
  current.timeline.push(
    renderObject([
      ['kind', 'tool_call'],
      [
        'output_ref',
        renderObject([
          ['sha256', digest],
          ['length', renderInteger(4)],
        ]),
      ],
    ])
  );
  assert.throws(() => prepareRendererArtifacts([current], context), /unavailable sibling spill/);
  current.payload_spill.set(digest, 'other');
  assert.throws(() => prepareRendererArtifacts([current], context), /length disagrees/);
  current.payload_spill.set(digest, 'nope');
  assert.throws(() => prepareRendererArtifacts([current], context), /digest does not match/);
});
test('checks every renderer-issued spill coordinate without traversing source values', async (t) => {
  const coordinates = [
    ['reasoning', '', 'text_ref'],
    ['audit_action', '', 'input_ref'],
    ['audit_action', '', 'response_ref'],
    ['tool_call', 'Read', 'output_ref'],
    ['tool_call', 'Edit', 'old_string_ref'],
    ['tool_call', 'Edit', 'new_string_ref'],
    ['tool_call', 'Write', 'content_ref'],
    ['tool_call', 'Agent', 'prompt_ref'],
    ['tool_call', 'Task', 'prompt_ref'],
    ['tool_call', 'ExitPlanMode', 'plan_ref'],
    ['tool_call', 'functions.Edit', 'old_string_ref'],
    ['tool_call', 'functions.Edit', 'new_string_ref'],
    ['tool_call', 'functions.Write', 'content_ref'],
    ['tool_call', 'functions.Agent', 'prompt_ref'],
    ['tool_call', 'functions.Task', 'prompt_ref'],
    ['tool_call', 'functions.ExitPlanMode', 'plan_ref'],
  ] as const;
  for (const [kind, name, field] of coordinates)
    await t.test(`${kind}/${name}/${field}`, () => {
      const current = turn(),
        digest = createHash('sha256').update('full').digest('hex');
      current.timeline.push(
        renderObject([
          ['kind', kind],
          ['text', 'preview'],
          ['name', name],
          ['source_harness', name.startsWith('functions.') ? 'codex' : ''],
          [
            field,
            renderObject([
              ['sha256', digest],
              ['length', renderInteger(4)],
            ]),
          ],
          [
            'input',
            renderObject([
              [
                'document_ref',
                renderObject([
                  ['sha256', 'external'],
                  ['length', renderInteger(7)],
                ]),
              ],
            ]),
          ],
        ])
      );
      assert.throws(
        () => prepareRendererArtifacts([current], context),
        /unavailable sibling spill/
      );
      current.payload_spill.set(digest, 'full');
      assert.deepEqual(
        prepareRendererArtifacts([current], context).artifacts.map((item) => item.name),
        ['turn-001.payloads.json', 'turn-001.json', 'session-index.json']
      );
      current.payload_spill.set(digest, 'other');
      assert.throws(() => prepareRendererArtifacts([current], context), /length disagrees/);
    });
});
test('refuses a removed spill produced by actual source tool output', () => {
  const output = 'source output '.repeat(1600),
    digest = createHash('sha256').update(output).digest('hex'),
    registry = createDefaultTranscriptRegistry({
      numericProfile: RENDER_JSON_4300,
    });
  const bytes = Buffer.from(
    [
      { type: 'user', message: { content: 'Read' } },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', id: 'read', input: { file_path: 'x' } }],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: output }] },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join('\n') + '\n'
  );
  const read = readRendererSource({
    source: {
      sourceId: 'spill-source',
      sourceGeneration: 'g1',
      inode: '100',
      size: BigInt(bytes.length),
      bytes,
    },
    registry,
    numericProfile: RENDER_JSON_4300,
  });
  assert.equal(read.disposition, 'ready');
  if (read.disposition !== 'ready') throw new Error('Expected prepared source');
  const accumulated = accumulateRendererEvents(read.events, '/repo', {
    noisePrefixes: registry.noisePrefixes,
    duration: { profileId: 'spill-null-duration', secondsBetween: () => null },
  });
  assert.equal(accumulated.turns.length, 1);
  const current = accumulated.turns[0]!;
  assert.equal(current.payload_spill.get(digest), output);
  assert.deepEqual(
    renderGet(current.timeline[0], 'output_ref'),
    renderObject([
      ['sha256', digest],
      ['length', renderInteger(output.length)],
    ])
  );
  assert.equal(prepareRendererArtifacts(accumulated.turns, context).artifacts[0]!.role, 'spill');
  current.payload_spill.delete(digest);
  assert.throws(
    () => prepareRendererArtifacts(accumulated.turns, context),
    /unavailable sibling spill/
  );
});
test('resolves rewind numbering only against retained turns and preserves status precedence', () => {
  const first = turn(),
    second = turn();
  first.rewound = true;
  first.timeline.push(
    renderObject([
      ['kind', 'tool_call'],
      ['is_error', true],
    ])
  );
  second.rewound_from_turn = first;
  second.rewind_kind = 'edited_prompt';
  const prepared = prepareRendererArtifacts([first, second], context);
  assert.equal(renderGet(prepared.turnPayloads[0], 'status'), 'rewound');
  assert.deepEqual(renderGet(prepared.turnPayloads[1], 'rewound_from'), renderInteger(1));
  assert.equal(renderGet(prepared.turnPayloads[1], 'rewind_kind'), 'edited_prompt');
  const unnumbered = buildRendererTurnPayload(second, 1, context, new Map());
  assert.equal(renderGet(unnumbered, 'rewound_from'), undefined);
});
test('keeps surrogate-pair and scalar file identities distinct before lossy ASCII projection', () => {
  const current = turn(),
    pair = codepointText([0xd83d, 0xde00], 'p'),
    scalar = codepointText([0x1f600], 'p');
  current.edited_files.push(pair, scalar, pair);
  const payload = buildRendererTurnPayload(current, 1, context, new Map());
  const files = renderGet(renderGet(renderGet(payload, 'refs'), 'files'), 'edited');
  assert(Array.isArray(files));
  assert.equal(files.length, 2);
  assert.equal(renderTextLength(files[0] as typeof pair), 2);
  assert.equal(renderTextLength(files[1] as typeof scalar), 1);
});
test('index rolls up exact numeric usage and rejects unencodable index text', () => {
  const first = turn(),
    second = turn();
  first.usage = renderObject([
    ['input_tokens', jsonNumber('9007199254740993')],
    ['cached', true],
  ]);
  second.usage = renderObject([
    ['input_tokens', jsonNumber('2')],
    ['cached', false],
  ]);
  const prepared = prepareRendererArtifacts([first, second], context);
  assert.deepEqual(
    renderGet(renderGet(prepared.index, 'usage'), 'input_tokens'),
    jsonNumber('9007199254740995')
  );
  assert.deepEqual(renderGet(renderGet(prepared.index, 'usage'), 'cached'), renderInteger(1));
  first.models.push(codepointText([0xd800], 'p'));
  assert.throws(() => prepareRendererArtifacts([first], context), /surrogate|UTF8|UTF-8/i);
});
