import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { getMember, jsonNumber, parsePythonJson } from '../../src/transcripts/lossless-json';
import { createDefaultTranscriptRegistry } from '../../src/transcripts/registry';
import {
  RENDER_JSON_4300,
  RENDER_JSON_UNLIMITED,
  type ObservedRendererFile,
} from '../../src/transcripts/render-reader';
import {
  prepareSessionArtifacts,
  type PrepareSessionArtifactsInput,
  type SessionArtifactPreparation,
} from '../../src/transcripts/render-prepare';
import { renderGet, renderInteger } from '../../src/transcripts/render-values';

const transcriptPath = '/fixture/chats/s.jsonl';
function file(path: string, text: string): ObservedRendererFile {
  const bytes = Buffer.from(text);
  return {
    path,
    disposition: 'read',
    source: {
      sourceId: path,
      sourceGeneration: 'g1',
      inode: '100',
      size: BigInt(bytes.length),
      bytes,
    },
  };
}
const user = (text: string) => ({
  type: 'user',
  timestamp: '2026-01-01T00:00:00Z',
  message: { content: text },
});
const rows = (...values: unknown[]): string =>
  values.map((value) => JSON.stringify(value)).join('\n') + '\n';
function input(
  raw = rows(user('Hello'), {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:01Z',
    message: {
      id: 'm1',
      model: 'observed-model',
      usage: { input_tokens: 3 },
      content: [{ type: 'text', text: 'The work is retained.' }],
    },
  })
): PrepareSessionArtifactsInput {
  return {
    transcript: file(transcriptPath, raw),
    audit: { path: '/fixture/audit.jsonl', disposition: 'absent' },
    hookOutcomes: { path: '/fixture/hooks.jsonl', disposition: 'absent' },
    subagents: {
      claudeCandidate: { path: '/fixture/chats/s/subagents', kind: 'absent' },
      qwenCandidate: { path: '/fixture/subagents/s', kind: 'absent' },
    },
    registry: createDefaultTranscriptRegistry({
      numericProfile: RENDER_JSON_4300,
    }),
    numericProfile: RENDER_JSON_4300,
    calendar: {
      profileId: 'fixture-utc-calendar/1',
      timezone: 'UTC',
      epochSeconds: (ts) =>
        ts === null || !Number.isFinite(Date.parse(ts)) ? null : Date.parse(ts) / 1000,
      secondsBetween: () => null,
    },
    context: {
      sessionId: 's',
      cwd: '/repo/project',
      startedAt: '2026-01-01T00:00:00Z',
      model: 'unknown',
      branch: 'feature',
      headSha: 'head',
      startSha: 'start',
      dirtyFiles: jsonNumber('2'),
    },
    priorInventory: { observationId: 'inventory-1', artifacts: [] },
    limits: {
      maximumInputBytes: 1_000_000,
      maximumArtifactBytes: 1_000_000,
      maximumTotalArtifactBytes: 2_000_000,
      maximumArtifacts: 100,
    },
  };
}
function ready(value: SessionArtifactPreparation) {
  if (value.disposition !== 'ready')
    throw new Error(
      `Preparation failed: ${value.disposition}: ${value.disposition === 'failed' ? String(value.failure.cause) : ''}`
    );
  return value;
}
const prior = (...names: string[]) => ({
  observationId: 'observed-prior',
  artifacts: names.map((name) => ({ name, sha256: 'a'.repeat(64), byteLength: 7 })),
});

test('actual owned source bytes reach complete turn and index artifacts with recovered context', () => {
  const configured = input(),
    prepared = ready(prepareSessionArtifacts(configured));
  assert.equal(prepared.publication, 'not_attempted');
  assert.equal(prepared.generation.schema, 'caws.prepared-session-artifacts.v1');
  assert.deepEqual(
    prepared.generation.artifacts.map((item) => item.name),
    ['turn-001.json', 'session-index.json']
  );
  const payload = JSON.parse(Buffer.from(prepared.generation.artifacts[0]!.bytes()).toString());
  const index = JSON.parse(Buffer.from(prepared.generation.artifacts[1]!.bytes()).toString());
  assert.equal(payload.user, 'Hello');
  assert.equal(payload.timeline[0].text, 'The work is retained.');
  assert.deepEqual(payload.usage, { input_tokens: 3 });
  assert.equal(payload.context.model, 'observed-model');
  assert.equal(payload.context.project, 'project');
  assert.equal(payload.context.dirty_files, 2);
  assert.equal(index.turn_count, 1);
  assert.equal(index.model, 'observed-model');
  assert.equal(
    prepared.checkpoint!.offset,
    BigInt(
      Buffer.byteLength(
        rows(user('Hello'), {
          type: 'assistant',
          timestamp: '2026-01-01T00:00:01Z',
          message: {
            id: 'm1',
            model: 'observed-model',
            usage: { input_tokens: 3 },
            content: [{ type: 'text', text: 'The work is retained.' }],
          },
        })
      )
    )
  );
  const original = prepared.generation.artifacts[0]!.bytes();
  if (configured.transcript.disposition !== 'read') throw new Error('Fixture source missing');
  configured.transcript.source.bytes.fill(0);
  assert.deepEqual(prepared.generation.artifacts[0]!.bytes(), original);
  assert.equal('outputs_current' in prepared.generation, false);
});
test('source tool input references remain data while renderer output closes over its sibling spill', () => {
  const documentRef = { sha256: 'external', length: 7 },
    output = 'renderer output '.repeat(1600),
    digest = createHash('sha256').update(output).digest('hex');
  const raw = rows(
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Read the document' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'read_document',
        call_id: 'document-tool',
        arguments: JSON.stringify({
          nested: { document_ref: documentRef, output_ref: documentRef },
        }),
      },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'document-tool', output },
    }
  );
  const prepared = ready(prepareSessionArtifacts(input(raw)));
  assert.equal(prepared.publication, 'not_attempted');
  assert.deepEqual(
    prepared.generation.artifacts.map((item) => item.name),
    ['turn-001.payloads.json', 'turn-001.json', 'session-index.json']
  );
  const payload = JSON.parse(
    Buffer.from(
      prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
    ).toString()
  );
  const spill = JSON.parse(
    Buffer.from(
      prepared.generation.artifacts.find((item) => item.role === 'spill')!.bytes()
    ).toString()
  );
  assert.equal(payload.timeline[0].source_harness, 'codex');
  assert.deepEqual(payload.timeline[0].input.nested, {
    document_ref: documentRef,
    output_ref: documentRef,
  });
  assert.deepEqual(payload.timeline[0].output_ref, { sha256: digest, length: output.length });
  assert.deepEqual(spill, { [digest]: output });
  assert.deepEqual(payload.payloads_sha256, [digest]);
  assert.equal(payload.payloads_sidecar, 'turn-001.payloads.json');
});
test('missing and empty sources retain observed human history as explicitly noncurrent', () => {
  const configured = input('');
  const existing = prior('turn-001.json', 'session-index.json');
  const empty = prepareSessionArtifacts({ ...configured, priorInventory: existing });
  assert.equal(empty.disposition, 'retain');
  if (empty.disposition !== 'retain') throw new Error('Expected retained history');
  assert.equal(empty.reason, 'empty_source');
  assert.equal(empty.currentness, 'noncurrent');
  assert.equal('generation' in empty, false);
  const missing = prepareSessionArtifacts({
    ...configured,
    transcript: { path: transcriptPath, disposition: 'absent' },
    priorInventory: existing,
  });
  if (missing.disposition !== 'retain') throw new Error('Expected retained missing source');
  assert.equal(missing.reason, 'missing_source');
  assert.equal(missing.publication, 'not_attempted');
  assert.equal(prepareSessionArtifacts(configured).disposition, 'empty');
});
test('a failed tentative conversion returns the new complete-prefix checkpoint without artifacts', () => {
  const configured = input(),
    complete = rows(user('A'), user('B'));
  const failed = prepareSessionArtifacts({
    ...configured,
    transcript: file(transcriptPath, complete + '{"tooLarge":' + '1'.repeat(4301)),
  });
  if (failed.disposition !== 'failed') throw new Error('Expected numeric failure');
  assert.equal(failed.failure.phase, 'numeric');
  assert.equal(failed.checkpoint!.offset, BigInt(Buffer.byteLength(complete)));
  assert.equal(failed.checkpoint!.events.length, 2);
  assert.equal(failed.publication, 'not_attempted');
  assert.equal('generation' in failed, false);
  const repaired = ready(
    prepareSessionArtifacts({
      ...configured,
      transcript: file(transcriptPath, complete + rows(user('C'))),
      priorCheckpoint: failed.checkpoint!,
    })
  );
  assert.equal(repaired.checkpoint!.events.length, 3);
  assert.equal(repaired.generation.artifacts.filter((item) => item.role === 'turn').length, 3);
});
test('embedded conversion failures retain the complete prefix and cannot return ready artifacts', () => {
  const embedded = `{"unused":${'1'.repeat(4301)},broken`;
  for (const row of [
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'example', call_id: 'embedded', arguments: embedded },
    },
    { type: 'tool/call', data: { name: 'example', callId: 'embedded', arguments: embedded } },
    {
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'profile', stdout: embedded },
    },
  ]) {
    const a = rows(user('A')),
      b = rows(user('B')),
      configured = input(a),
      baseline = ready(prepareSessionArtifacts(configured));
    const failed = prepareSessionArtifacts({
      ...configured,
      transcript: file(transcriptPath, a + b + JSON.stringify(row)),
      priorCheckpoint: baseline.checkpoint!,
    });
    if (failed.disposition !== 'failed') throw new Error('Expected embedded numeric failure');
    assert.equal(failed.failure.phase, 'numeric');
    assert.equal(failed.publication, 'not_attempted');
    assert.equal('generation' in failed, false);
    assert.equal(failed.checkpoint!.offset, BigInt(Buffer.byteLength(a + b)));
    assert.deepEqual(
      failed.checkpoint!.events.map(({ envelope }) => envelope.event.text),
      ['A', 'B']
    );
    assert.equal(baseline.checkpoint!.offset, BigInt(Buffer.byteLength(a)));
    assert.equal(baseline.checkpoint!.events.length, 1);
    const repaired = ready(
      prepareSessionArtifacts({
        ...configured,
        transcript: file(transcriptPath, a + b + rows(user('C'))),
        priorCheckpoint: failed.checkpoint!,
      })
    );
    assert.equal(repaired.checkpoint!.events.length, 3);
    assert.equal(repaired.generation.artifacts.filter((item) => item.role === 'turn').length, 3);
  }
});

test('selected structured output fallback changes actual error fields lengths and spill bytes', () => {
  const output =
    '[{"text":"ok","is_error":true,"unused":' +
    '1'.repeat(4301) +
    ',"padding":"' +
    'x'.repeat(18000) +
    '"}]';
  const raw = rows(
    user('Inspect the output'),
    {
      type: 'response_item',
      payload: { type: 'function_call', name: 'example', call_id: 'output', arguments: '{}' },
    },
    {
      type: 'response_item',
      payload: { type: 'function_call_output', call_id: 'output', output },
    }
  );
  const digest = createHash('sha256').update(output).digest('hex');
  for (const numericProfile of [RENDER_JSON_4300, RENDER_JSON_UNLIMITED]) {
    const prepared = ready(
      prepareSessionArtifacts({
        ...input(raw),
        numericProfile,
        registry: createDefaultTranscriptRegistry({ numericProfile }),
      })
    );
    const payload = JSON.parse(
      Buffer.from(
        prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
      ).toString()
    );
    assert.equal(payload.timeline.length, 1);
    const tool = payload.timeline[0];
    assert.equal(tool.kind, 'tool_call');
    assert.equal(tool.name, 'example');
    if (numericProfile.integerMaxDigits === 0) {
      assert.equal(tool.output, 'ok');
      assert.equal(tool.output_length, 2);
      assert.equal(tool.is_error, true);
      assert.equal(tool.output_truncated, false);
      assert.equal(tool.output_ref, undefined);
      assert.equal(payload.payloads_sidecar, null);
      assert.deepEqual(payload.payloads_sha256, []);
      assert.equal(prepared.generation.artifacts.filter((item) => item.role === 'spill').length, 0);
    } else {
      assert.equal(tool.output_length, output.length);
      assert.equal(tool.is_error, false);
      assert.equal(tool.output_truncated, true);
      assert.equal(tool.output_cut, true);
      assert.deepEqual(tool.output_ref, { sha256: digest, length: output.length });
      assert.equal(payload.payloads_sidecar, 'turn-001.payloads.json');
      assert.deepEqual(payload.payloads_sha256, [digest]);
      const spillArtifact = prepared.generation.artifacts.find((item) => item.role === 'spill');
      assert.ok(spillArtifact);
      const spill = JSON.parse(Buffer.from(spillArtifact.bytes()).toString());
      assert.deepEqual(spill, { [digest]: output });
      const retained = spill[digest];
      assert.ok(typeof retained === 'string');
      assert.equal(createHash('sha256').update(retained).digest('hex'), digest);
    }
  }
});

test('lineage CR projection skips selected numeric failure while unlimited retains the parent', () => {
  const raw =
    'garbage\r{"type":"session_meta","payload":{"forked_from":"selected-parent"},"unused":' +
    '1'.repeat(4301) +
    '}\n' +
    rows(user('Inspect lineage'));
  for (const numericProfile of [RENDER_JSON_4300, RENDER_JSON_UNLIMITED]) {
    const prepared = ready(
      prepareSessionArtifacts({
        ...input(raw),
        numericProfile,
        registry: createDefaultTranscriptRegistry({ numericProfile }),
      })
    );
    const lineage = renderGet(prepared.generation.context, 'lineage');
    assert.equal(prepared.checkpoint!.events.length, 1);
    assert.equal(prepared.checkpoint!.events[0]!.envelope.event.text, 'Inspect lineage');
    if (numericProfile.integerMaxDigits === 0) {
      assert.equal(renderGet(lineage, 'parent_session_id'), 'selected-parent');
      assert.equal(renderGet(lineage, 'authority'), 'none');
    } else assert.equal(lineage, null);
    const payload = JSON.parse(
      Buffer.from(
        prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
      ).toString()
    );
    assert.deepEqual(
      payload.context.lineage,
      numericProfile.integerMaxDigits === 0
        ? {
            parent_session_id: 'selected-parent',
            source: 'transcript_metadata',
            authority: 'none',
            source_path: transcriptPath,
          }
        : null
    );
  }
});

test('selected output conversion refuses usage sums that grow past the input integer boundary', () => {
  const boundary = '9'.repeat(4300),
    sum = (BigInt(boundary) + BigInt(boundary)).toString();
  assert.equal(sum.length, 4301);
  const assistantUsage = (id: string, usage: string): string =>
    '{"type":"assistant","timestamp":"2026-01-01T00:00:01Z","message":{"id":' +
    JSON.stringify(id) +
    ',"usage":{"input_tokens":' +
    usage +
    '},"content":[{"type":"text","text":"Observed response"}]}}\n';
  const artifactUsage = (bytes: Uint8Array) =>
    getMember(getMember(parsePythonJson(Buffer.from(bytes).toString()), 'usage'), 'input_tokens');

  for (const literal of ['3', boundary]) {
    const raw = rows(user('One contribution')) + assistantUsage('boundary-message', literal),
      prepared = ready(prepareSessionArtifacts(input(raw)));
    assert.equal(prepared.checkpoint!.offset, BigInt(Buffer.byteLength(raw)));
    assert.equal(prepared.generation.artifacts.filter((item) => item.role === 'turn').length, 1);
    assert.deepEqual(
      artifactUsage(prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()),
      jsonNumber(literal)
    );
    assert.deepEqual(
      artifactUsage(prepared.generation.artifacts.find((item) => item.role === 'index')!.bytes()),
      jsonNumber(literal)
    );
  }

  for (const scenario of [
    {
      name: 'same-turn usage',
      raw:
        rows(user('Two contributions')) +
        assistantUsage('same-turn-first', boundary) +
        assistantUsage('same-turn-second', boundary),
      turnUsage: [sum],
    },
    {
      name: 'session-index usage',
      raw:
        rows(user('First contribution')) +
        assistantUsage('first-turn-message', boundary) +
        rows(user('Second contribution')) +
        assistantUsage('second-turn-message', boundary),
      turnUsage: [boundary, boundary],
    },
  ]) {
    const failed = prepareSessionArtifacts(input(scenario.raw));
    if (failed.disposition !== 'failed')
      throw new Error(`${scenario.name} must fail selected output conversion`);
    assert.equal(failed.failure.phase, 'encoding', scenario.name);
    assert.equal(failed.publication, 'not_attempted', scenario.name);
    assert.equal('generation' in failed, false, scenario.name);
    assert.equal(failed.checkpoint!.offset, BigInt(Buffer.byteLength(scenario.raw)), scenario.name);
    const contributions = failed
      .checkpoint!.events.filter(({ envelope }) => envelope.event.ev === 'assistant_meta')
      .map(({ envelope }) => getMember(envelope.event.usage, 'input_tokens'));
    assert.deepEqual(contributions, [jsonNumber(boundary), jsonNumber(boundary)], scenario.name);

    const unlimited = ready(
      prepareSessionArtifacts({
        ...input(scenario.raw),
        numericProfile: RENDER_JSON_UNLIMITED,
        registry: createDefaultTranscriptRegistry({ numericProfile: RENDER_JSON_UNLIMITED }),
      })
    );
    assert.equal(unlimited.publication, 'not_attempted', scenario.name);
    assert.equal(
      unlimited.checkpoint!.offset,
      BigInt(Buffer.byteLength(scenario.raw)),
      scenario.name
    );
    const turns = unlimited.generation.artifacts.filter((item) => item.role === 'turn');
    assert.equal(turns.length, scenario.turnUsage.length, scenario.name);
    assert.deepEqual(
      turns.map((artifact) => artifactUsage(artifact.bytes())),
      scenario.turnUsage.map((literal) => jsonNumber(literal)),
      scenario.name
    );
    assert.deepEqual(
      artifactUsage(unlimited.generation.artifacts.find((item) => item.role === 'index')!.bytes()),
      jsonNumber(sum),
      scenario.name
    );
  }
});
test('smaller positive preparation proposes only observed obsolete output names', () => {
  const prepared = ready(
    prepareSessionArtifacts({
      ...input(),
      priorInventory: prior(
        'turn-001.json',
        'turn-002.json',
        'turn-002.payloads.json',
        'turn-003.txt',
        'foreign.config'
      ),
    })
  );
  assert.deepEqual(
    prepared.generation.proposedRemovals.map((item) => item.name),
    ['turn-002.json', 'turn-002.payloads.json', 'turn-003.txt']
  );
  assert(
    prepared.generation.proposedRemovals.every(
      (item) => item.sha256 === 'a'.repeat(64) && item.byteLength === 7
    )
  );
});
test('profile, source failure and encoded output limits cannot inherit prior readiness', () => {
  const configured = input();
  for (const changed of [
    { ...configured, selectedAdapterOverride: '/selected/adapter.py' },
    {
      ...configured,
      transcript: { path: transcriptPath, disposition: 'failed' as const, error: 'read-sentinel' },
    },
    { ...configured, limits: { ...configured.limits, maximumArtifactBytes: 10 } },
  ]) {
    const result = prepareSessionArtifacts(changed);
    assert.equal(result.disposition, 'failed');
    assert.equal(result.publication, 'not_attempted');
    assert.equal('generation' in result, false);
  }
});
test('metadata negative candidates and selected calendar context affect preparation identity', () => {
  const configured = input(),
    baseline = ready(prepareSessionArtifacts(configured));
  const changedDirectory = ready(
    prepareSessionArtifacts({
      ...configured,
      subagents: {
        ...configured.subagents,
        claudeCandidate: {
          path: '/fixture/chats/s/subagents',
          kind: 'directory',
          listing: { disposition: 'listed', entries: [] },
        },
      },
    })
  );
  assert.notEqual(changedDirectory.generation.identity, baseline.generation.identity);
  const changedCalendar = ready(
    prepareSessionArtifacts({
      ...configured,
      calendar: { ...configured.calendar, timezone: 'selected-fixture-zone' },
    })
  );
  assert.notEqual(changedCalendar.generation.identity, baseline.generation.identity);
  assert.equal(
    renderGet(renderGet(changedCalendar.generation.observations, 'calendar'), 'timezone'),
    'selected-fixture-zone'
  );
});
test('lineage false and zero values fall through to the actual parent string', () => {
  const raw = rows(
    { type: 'session_meta', payload: { forked_from: 0, parent_session_id: 'parent-s' } },
    user('forked')
  );
  const prepared = ready(prepareSessionArtifacts(input(raw)));
  const lineage = renderGet(prepared.generation.context, 'lineage');
  assert.equal(renderGet(lineage, 'parent_session_id'), 'parent-s');
  assert.equal(renderGet(lineage, 'authority'), 'none');
  assert.deepEqual(renderGet(prepared.generation.context, 'dirty_files'), renderInteger(2));
});

test('real audit and hook sources merge after tool use and before result at equal timestamps', () => {
  const ts = '2026-01-01T00:00:01Z';
  const configured = input(
    rows(
      user('run'),
      {
        type: 'assistant',
        timestamp: ts,
        message: {
          content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo hi' } }],
        },
      },
      {
        type: 'user',
        timestamp: ts,
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't', content: 'hi', is_error: false }],
        },
      }
    )
  );
  const prepared = ready(
    prepareSessionArtifacts({
      ...configured,
      audit: file(
        '/fixture/audit.jsonl',
        rows({
          session_id: 's',
          event: 'tool_use',
          timestamp: ts,
          tool: 'Bash',
          tool_use_id: 't',
          tool_input: { command: 'echo hi' },
          tool_response: {},
        })
      ),
      hookOutcomes: file(
        '/fixture/hooks.jsonl',
        rows({
          session_id: 's',
          timestamp: ts,
          handler: 'scope',
          tool_use_id: 't',
          stdout: '{"decision":"block","reason":"Scope refused"}',
          exit_code: 2,
        })
      ),
    })
  );
  const payload = JSON.parse(
    Buffer.from(
      prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
    ).toString()
  );
  assert.equal(payload.status, 'blocked');
  assert.equal(payload.hook_contexts[0].additional_context, 'Scope refused');
  assert.equal(payload.hook_contexts[0].status, 'block');
  assert.equal(payload.timeline[0].kind, 'tool_call');
  assert.equal(payload.timeline[0].output, 'hi');
  assert.equal(payload.timeline[0].hook_contexts[0].hook_name, 'scope');
  assert.equal(
    payload.refs.commands.filter((item: { command: string }) => item.command === 'echo hi').length,
    1
  );
});

test('metadata links the actual matching fork filename onto the prepared agent reference', () => {
  const configured = input(
    rows(user('delegate'), {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'fork-tool',
            name: 'Agent',
            input: {
              description: 'inspect',
              subagent_type: 'Explore',
              prompt: 'Trace the consumer',
            },
          },
        ],
      },
    })
  );
  const path = '/fixture/chats/s/subagents/agent-child.meta.json';
  const prepared = ready(
    prepareSessionArtifacts({
      ...configured,
      subagents: {
        ...configured.subagents,
        claudeCandidate: {
          path: '/fixture/chats/s/subagents',
          kind: 'directory',
          listing: {
            disposition: 'listed',
            entries: [
              {
                name: 'agent-child.meta.json',
                file: file(path, '{"toolUseId":"fork-tool","agentType":"Explore","spawnDepth":1}'),
              },
            ],
          },
        },
      },
    })
  );
  const payload = JSON.parse(
    Buffer.from(
      prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
    ).toString()
  );
  assert.equal(payload.refs.agents[0].subagent.transcript, 'agent-child.jsonl');
  assert.equal(payload.refs.agents[0].subagent.agent_type, 'Explore');
  assert.equal(payload.refs.agents[0].subagent.spawn_depth, 1);
});

test('the declared input byte frontier refuses oversized data before copying it', () => {
  const configured = input(),
    bytes = new Uint8Array(11);
  let copied = false;
  Object.defineProperty(bytes, Symbol.iterator, {
    value: () => {
      copied = true;
      throw new Error('copy-sentinel');
    },
  });
  const result = prepareSessionArtifacts({
    ...configured,
    limits: { ...configured.limits, maximumInputBytes: 10 },
    transcript: {
      path: transcriptPath,
      disposition: 'read',
      source: { sourceId: 's', sourceGeneration: 'g', inode: 'i', size: 11n, bytes },
    },
  });
  if (result.disposition !== 'failed') throw new Error('Expected input frontier refusal');
  assert.equal(result.failure.phase, 'input');
  assert.match(String(result.failure.cause), /declared byte profile/);
  assert.equal(copied, false);
});

test('retained ordinary store event bytes reach the Claude adapter under OpenCode and Zcode attribution', () => {
  // Synthetic ordinary-store projection, retained SHA from the acquisition/publication reference.
  const projection =
    '{"type": "user", "timestamp": "1970-01-01T00:00:01+00:00", "message": {"content": [{"type": "text", "text": "a\\n\\nb"}]}}\n';
  assert.equal(
    createHash('sha256').update(projection).digest('hex'),
    '95011de1a155c684f2a5097ba8dae5447d58b0312a253e86672508764bbe8a2a'
  );
  for (const surface of ['opencode', 'zcode']) {
    const prepared = ready(
      prepareSessionArtifacts({
        ...input(projection),
        registry: createDefaultTranscriptRegistry({
          surface,
          numericProfile: RENDER_JSON_4300,
        }),
      })
    );
    const event = prepared.checkpoint!.events[0]!.envelope;
    assert.equal(event.adapter.id, 'claude');
    assert.deepEqual(prepared.checkpoint!.context.normalization.surface, {
      presence: 'present',
      value: surface,
    });
    assert.equal(
      event.event.source_harness,
      undefined,
      'the consumer attributes tool events, not user text'
    );
    const payload = JSON.parse(
      Buffer.from(
        prepared.generation.artifacts.find((item) => item.role === 'turn')!.bytes()
      ).toString()
    );
    assert.equal(payload.user, 'a\n\nb');
    assert.equal(payload.turn, 1);
  }
});
