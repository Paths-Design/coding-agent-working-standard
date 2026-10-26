import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDefaultTranscriptRegistry } from '../../src/transcripts/registry';
import { getMember, parsePythonJson } from '../../src/transcripts/lossless-json';
import { renderGet } from '../../src/transcripts/render-values';
import { isCodepointText } from '../../src/transcripts/codepoint-text';
import {
  readRendererSource,
  snapshotRendererSource,
  RENDER_JSON_4300,
  RENDER_JSON_UNLIMITED,
  parseRendererAuxiliary,
  parseRendererSubagents,
  type RenderReaderInput,
  type RenderReaderResult,
  type RenderReaderCheckpoint,
  type ObservedRendererFile,
  type ObservedRendererDirectory,
  type RendererPublicationBufferSource,
} from '../../src/transcripts/render-reader';

function registry(surface?: string, numericProfile = RENDER_JSON_4300) {
  return createDefaultTranscriptRegistry({
    numericProfile,
    ...(surface === undefined ? {} : { surface }),
  });
}
function source(raw: string | Uint8Array) {
  const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
  return {
    sourceId: '/caller/source',
    sourceGeneration: 'generation',
    inode: '7',
    size: BigInt(bytes.length),
    bytes,
  };
}
function bufferSource(raw: string | Uint8Array) {
  const bytes = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw);
  return {
    kind: 'publication-buffer' as const,
    binding: {
      id: 'original-invocation',
      runtimeDigest: 'a'.repeat(64),
      token: '52665654-e2a6-470d-bee1-b3e12f83ff59',
      attempt: 'attempt-1',
      observationId: 'observation-1',
      inputDigest: 'b'.repeat(64),
    },
    descriptor: {
      name: 'store-projection.jsonl',
      role: 'projection',
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
    size: BigInt(bytes.length),
    bytes,
  };
}
function read(raw: string | Uint8Array, extra: Partial<RenderReaderInput> = {}) {
  return readRendererSource({
    source: source(raw),
    registry: extra.registry ?? registry(undefined, extra.numericProfile ?? RENDER_JSON_4300),
    numericProfile: RENDER_JSON_4300,
    ...extra,
  });
}
function ready(result: RenderReaderResult) {
  if (result.disposition !== 'ready') throw new Error(result.failure.message);
  return result;
}
function checkpoint(result: RenderReaderResult): RenderReaderCheckpoint {
  assert.ok(result.checkpoint);
  return result.checkpoint;
}
const user = (text: string) => JSON.stringify({ type: 'user', message: { content: text } });
const line124 = (text: string) => user(text).padEnd(123, ' ') + '\n';
const texts = (result: RenderReaderResult) =>
  result.events.map(({ envelope }) => envelope.event.text);
const over = '1'.repeat(4301);
const embeddedAdapters = ['codex', 'dsh', 'claude'] as const;
function embeddedRow(adapter: (typeof embeddedAdapters)[number], payload: string): string {
  const row =
    adapter === 'codex'
      ? {
          type: 'response_item',
          payload: {
            type: 'function_call',
            name: 'example',
            call_id: 'embedded',
            arguments: payload,
          },
        }
      : adapter === 'dsh'
        ? {
            type: 'tool/call',
            data: { name: 'example', callId: 'embedded', arguments: payload },
          }
        : {
            type: 'attachment',
            attachment: { type: 'hook_success', hookName: 'profile', stdout: payload },
          };
  return JSON.stringify(row);
}

test('publication buffer owns exact original binding and bytes without claiming a physical inode', () => {
  const raw = user('buffer semantic text') + '\n',
    observed = bufferSource(raw);
  const result = ready(read(raw, { source: observed }));
  assert.deepEqual(texts(result), ['buffer semantic text']);
  const checkpoint = result.checkpoint;
  assert.equal(checkpoint.kind, 'publication-buffer');
  if (checkpoint.kind !== 'publication-buffer') throw new Error('Expected buffer identity');
  assert.equal(Object.hasOwn(checkpoint, 'inode'), false);
  assert.equal(Object.isFrozen(checkpoint.binding), true);
  assert.equal(Object.isFrozen(checkpoint.descriptor), true);
  assert.notEqual(checkpoint.binding, observed.binding);
  assert.notEqual(checkpoint.descriptor, observed.descriptor);
  assert.match(checkpoint.sourceId, /^publication-buffer:[a-f0-9]{64}$/);
  assert.match(checkpoint.sourceGeneration, /^[a-f0-9]{64}$/);
  const binding = { ...checkpoint.binding },
    descriptor = { ...checkpoint.descriptor };
  observed.binding.token = 'changed-after-read';
  observed.descriptor.sha256 = 'c'.repeat(64);
  observed.bytes.fill(0);
  assert.deepEqual(checkpoint.binding, binding);
  assert.deepEqual(checkpoint.descriptor, descriptor);
  assert.equal(
    result.events[0]!.envelope.source.rawBase64,
    Buffer.from(raw.slice(0, -1)).toString('base64')
  );
});

test('source snapshots read physical identity and buffer discriminator references exactly once', () => {
  for (const field of ['sourceId', 'sourceGeneration', 'inode'] as const) {
    const observed = source('data'),
      expected = observed[field];
    let reads = 0;
    Object.defineProperty(observed, field, {
      enumerable: true,
      get() {
        reads++;
        return reads === 1 ? expected : 0;
      },
    });
    const captured = snapshotRendererSource(observed);
    if (captured.kind === 'publication-buffer') throw new Error('Expected physical snapshot');
    assert.equal(captured[field], expected, field);
    assert.equal(reads, 1, field);
  }
  const observed = bufferSource(user('single read') + '\n');
  for (const field of ['kind', 'binding', 'descriptor', 'bytes', 'size'] as const) {
    const value = observed[field];
    let reads = 0;
    Object.defineProperty(observed, field, {
      enumerable: true,
      get() {
        reads++;
        if (reads !== 1) throw new Error(`repeated ${field}`);
        return value;
      },
    });
  }
  const captured = snapshotRendererSource(observed);
  assert.equal(captured.kind, 'publication-buffer');
  assert.equal(captured.size, BigInt(captured.bytes.byteLength));
});

test('resizing live source storage during metadata acquisition cannot contradict copied lengths', () => {
  type Resizable = ArrayBuffer & { resize(byteLength: number): void };
  const ResizableBuffer = ArrayBuffer as unknown as {
    new (byteLength: number, options: { maxByteLength: number }): Resizable;
  };
  const physicalBacking = new ResizableBuffer(4, { maxByteLength: 4 });
  assert.equal(typeof physicalBacking.resize, 'function');
  const physical = {
    bytes: new Uint8Array(physicalBacking),
    size: 4n,
    sourceGeneration: 'g',
    inode: '7',
    get sourceId() {
      physicalBacking.resize(0);
      return 'physical';
    },
  };
  assert.throws(() => snapshotRendererSource(physical), /Physical source copied length differs/);
  assert.equal(physicalBacking.byteLength, 0, 'the physical mutation actually occurred');

  const bufferBacking = new ResizableBuffer(4, { maxByteLength: 4 });
  const buffered = bufferSource('data');
  const descriptor = { ...buffered.descriptor };
  Object.defineProperty(descriptor, 'sha256', {
    enumerable: true,
    get() {
      bufferBacking.resize(0);
      return createHash('sha256').update('').digest('hex');
    },
  });
  assert.throws(
    () =>
      snapshotRendererSource({
        ...buffered,
        bytes: new Uint8Array(bufferBacking),
        descriptor,
      }),
    /Publication buffer copied length differs/
  );
  assert.equal(bufferBacking.byteLength, 0, 'the buffer mutation actually occurred');
});

test('physical labels matching buffer coordinates cannot transfer private registry state', () => {
  const turn = JSON.stringify({ type: 'turn_context', payload: { turn_id: 'turn' } }) + '\n';
  const developer =
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: '[fixture] retained context' }],
      },
    }) + '\n';
  const reg = registry(),
    buffered = ready(read(turn, { registry: reg, source: bufferSource(turn) }));
  assert.equal(buffered.events[0]!.envelope.event.ev, 'turn_boundary');
  const physicalLabels = {
    sourceId: buffered.checkpoint.sourceId,
    sourceGeneration: buffered.checkpoint.sourceGeneration,
  };
  const same = ready(
    read(turn, {
      registry: reg,
      source: { ...source(turn), ...physicalLabels },
      priorCheckpoint: buffered.checkpoint,
    })
  );
  assert.equal(same.reusedPrefix, false);
  assert.notEqual(same.checkpoint.kind, 'publication-buffer');
  // Occurrence coordinates are explicitly caller assertions, not a globally
  // reserved custody namespace. The private state and tagged snapshot differ.
  assert.deepEqual(same.events[0]!.envelope.source, buffered.events[0]!.envelope.source);
  assert.equal(same.events[0]!.envelope.source.coordinateAuthority, 'caller_asserted');
  const fresh = ready(
    read(developer, {
      registry: reg,
      source: { ...source(developer), ...physicalLabels },
      priorCheckpoint: buffered.checkpoint,
    })
  );
  assert.deepEqual(
    fresh.events,
    [],
    'turnSeen from the buffer must not leak into the physical read'
  );
  const positive = ready(
    read(turn + developer, {
      registry: reg,
      source: { ...source(turn + developer), ...physicalLabels },
    })
  );
  assert.equal(
    positive.events.filter(({ envelope }) => envelope.event.ev === 'hook_context').length,
    1,
    'the developer row must expose leaked turnSeen state if a state transfer occurs'
  );
});

test('publication buffers never reuse a prefix, including identical or independently rebound snapshots', () => {
  const raw = line124('A'),
    reg = registry(),
    observed = bufferSource(raw);
  const first = ready(read(raw, { registry: reg, source: observed }));
  const same = ready(
    read(raw, { registry: reg, source: observed, priorCheckpoint: first.checkpoint })
  );
  assert.equal(same.reusedPrefix, false);
  assert.notEqual(same.checkpoint, first.checkpoint);
  assert.deepEqual(texts(same), ['A']);
  assert.equal(same.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration);
  for (const key of [
    'id',
    'runtimeDigest',
    'token',
    'attempt',
    'observationId',
    'inputDigest',
  ] as const) {
    const changed = bufferSource(raw);
    changed.binding[key] =
      key === 'runtimeDigest' || key === 'inputDigest' ? 'c'.repeat(64) : 'other';
    const next = ready(
      read(raw, { registry: reg, source: changed, priorCheckpoint: first.checkpoint })
    );
    assert.equal(next.reusedPrefix, false, key);
    assert.notEqual(next.checkpoint.sourceGeneration, first.checkpoint.sourceGeneration, key);
    assert.deepEqual(texts(next), ['A'], key);
  }
  const renamed = bufferSource(raw);
  renamed.descriptor.name = 'other-projection.jsonl';
  const next = ready(
    read(raw, { registry: reg, source: renamed, priorCheckpoint: first.checkpoint })
  );
  assert.notEqual(next.checkpoint.sourceId, first.checkpoint.sourceId);
  const file = ready(read(raw, { registry: reg }));
  assert.equal(
    ready(read(raw, { registry: reg, source: observed, priorCheckpoint: file.checkpoint }))
      .reusedPrefix,
    false
  );
  assert.equal(
    ready(read(raw, { registry: reg, priorCheckpoint: first.checkpoint })).reusedPrefix,
    false
  );
  assert.equal(
    ready(read(raw, { registry: reg, priorCheckpoint: file.checkpoint })).reusedPrefix,
    true
  );
});

test('buffer tails and failed new generations cannot import earlier committed events', () => {
  const a = line124('A'),
    b = user('B'),
    reg = registry();
  const first = ready(read(a + b, { registry: reg, source: bufferSource(a + b) }));
  assert.equal(first.tentative, true);
  const nextSource = bufferSource(a + b + '\n');
  nextSource.binding.observationId = 'new-observation';
  const next = ready(
    read(a + b + '\n', { registry: reg, source: nextSource, priorCheckpoint: first.checkpoint })
  );
  assert.deepEqual(texts(next), ['A', 'B']);
  assert.equal(next.reusedPrefix, false);
  const invalid = bufferSource(`{"overflow":${over}}\n`);
  invalid.binding.observationId = 'failed-observation';
  const failed = read('', { registry: reg, source: invalid, priorCheckpoint: next.checkpoint });
  if (failed.disposition !== 'failed') throw new Error('Expected numeric refusal');
  assert.equal(failed.failure.phase, 'numeric');
  assert.equal(failed.reusedPrefix, false);
  assert.equal(failed.checkpoint!.offset, 0n);
  assert.notEqual(failed.checkpoint, next.checkpoint);
  assert.deepEqual(failed.events, []);
});

test('malformed publication identities and changed bytes refuse before events or checkpoint reuse', () => {
  const raw = line124('must not leak'),
    first = ready(read(raw));
  const cases: readonly [string, (value: ReturnType<typeof bufferSource>) => unknown][] = [
    [
      'hash',
      (value) => ({ ...value, descriptor: { ...value.descriptor, sha256: 'c'.repeat(64) } }),
    ],
    ['size', (value) => ({ ...value, size: value.size + 1n })],
    [
      'length',
      (value) => ({
        ...value,
        descriptor: { ...value.descriptor, byteLength: value.bytes.length + 1 },
      }),
    ],
    [
      'fractional length',
      (value) => ({ ...value, descriptor: { ...value.descriptor, byteLength: 0.5 } }),
    ],
    ['changed bytes', (value) => ({ ...value, bytes: Buffer.alloc(value.bytes.length) })],
    ['empty token', (value) => ({ ...value, binding: { ...value.binding, token: '' } })],
    [
      'overlong token',
      (value) => ({ ...value, binding: { ...value.binding, token: 'é'.repeat(65) } }),
    ],
    ['NUL token', (value) => ({ ...value, binding: { ...value.binding, token: 'bad\0token' } })],
    [
      'runtime digest',
      (value) => ({ ...value, binding: { ...value.binding, runtimeDigest: 'not-a-digest' } }),
    ],
    ['missing binding', (value) => ({ ...value, binding: undefined })],
    ['extra binding', (value) => ({ ...value, binding: { ...value.binding, extra: true } })],
    [
      'extra descriptor',
      (value) => ({ ...value, descriptor: { ...value.descriptor, extra: true } }),
    ],
    [
      'unsafe alias',
      (value) => ({ ...value, descriptor: { ...value.descriptor, name: '../projection' } }),
    ],
    ['inode', (value) => ({ ...value, inode: 'fabricated' })],
    ['sourceId', (value) => ({ ...value, sourceId: 'fabricated' })],
    ['unknown kind', (value) => ({ ...value, kind: 'memory' })],
  ];
  for (const [name, alter] of cases) {
    const result = read(raw, {
      source: alter(bufferSource(raw)) as RendererPublicationBufferSource,
      priorCheckpoint: first.checkpoint,
    });
    if (result.disposition !== 'failed') throw new Error(`Expected input refusal: ${name}`);
    assert.equal(result.failure.phase, 'input', name);
    assert.equal(result.checkpoint, null, name);
    assert.deepEqual(result.events, [], name);
    assert.equal(result.reusedPrefix, false, name);
  }
});

test('actual source registry skips malformed syntax and nonobjects and honors first matched empty owner', () => {
  const raw =
    '{broken}\n[]\nnull\n' +
    '{"type":"user","message":{"parts":[null],"content":"CLAUDE_MUST_NOT_LEAK"}}\n' +
    user('visible') +
    '\n';
  const result = ready(read(raw));
  assert.deepEqual(texts(result), ['visible']);
  assert.equal(result.events[0]!.envelope.adapter.id, 'claude');
  assert.equal(result.events[0]!.envelope.source.lineOrdinal, 4n);
  assert.equal(result.checkpoint.offset, BigInt(Buffer.byteLength(raw)));
  assert.equal(result.checkpoint.lineOrdinal, 5n);
});

test('selected integer conversion rejects before later malformed syntax or overwritten values', () => {
  for (const raw of [`{"unused":${over},bad`, `{"unused":${over},"unused":0}`, over]) {
    const result = read(raw + '\n');
    assert.equal(result.disposition, 'failed');
    if (result.disposition !== 'failed') throw new Error('expected failed');
    assert.equal(result.failure.phase, 'numeric');
    assert.equal(checkpoint(result).offset, 0n);
  }
  assert.equal(ready(read(`{"unused":${'1'.repeat(4300)}}\n`)).checkpoint.offset, 4312n);
  assert.equal(ready(read(`{"unused":-${'1'.repeat(4300)}}\n`)).events.length, 0);
  assert.equal(ready(read(`{"unused":${over}.0}\n`)).events.length, 0);
  assert.equal(
    ready(read(`{"unused":${over},bad\n`, { numericProfile: RENDER_JSON_UNLIMITED })).events.length,
    0
  );
  assert.equal(
    ready(read(`{"unused":${over}}\n`, { numericProfile: RENDER_JSON_UNLIMITED })).events.length,
    0
  );
});

test('embedded Codex DSH and Claude conversion fails before later syntax and duplicate collapse without committing the chunk', () => {
  for (const adapter of embeddedAdapters) {
    const reg = registry(),
      a = line124('A'),
      b = line124('B'),
      first = ready(read(a, { registry: reg }));
    for (const payload of [
      `{"unused":${over}}`,
      `{"unused":${over},broken`,
      `{"unused":${over},"unused":0}`,
    ]) {
      const failed = read(a + b + embeddedRow(adapter, payload) + '\n', {
        registry: reg,
        priorCheckpoint: first.checkpoint,
      });
      if (failed.disposition !== 'failed')
        throw new Error(`${adapter} must reject embedded overflow`);
      assert.equal(failed.failure.phase, 'numeric', adapter);
      assert.equal(failed.failure.byteOffset, 248n, adapter);
      assert.equal(failed.checkpoint, first.checkpoint, adapter);
      assert.deepEqual(texts(failed), ['A'], adapter);
      assert.equal(failed.tentative, false, adapter);
      assert.equal(failed.reusedPrefix, true, adapter);
    }
    const tentative = read(a + b + embeddedRow(adapter, `{"unused":${over}}`), {
      registry: reg,
      priorCheckpoint: first.checkpoint,
    });
    if (tentative.disposition !== 'failed')
      throw new Error(`${adapter} must reject tentative overflow`);
    assert.equal(tentative.failure.phase, 'numeric', adapter);
    assert.equal(checkpoint(tentative).offset, 248n, adapter);
    assert.deepEqual(texts(tentative), ['A', 'B'], adapter);
    assert.equal(tentative.tentative, true, adapter);
    const repaired = ready(
      read(a + b + line124('C'), { registry: reg, priorCheckpoint: checkpoint(tentative) })
    );
    assert.equal(repaired.checkpoint.offset, 372n, adapter);
    assert.deepEqual(texts(repaired), ['A', 'B', 'C'], adapter);
  }
});

test('embedded syntax fallback survives selected limits while unlimited conversion permits overwritten integers', () => {
  for (const adapter of embeddedAdapters) {
    for (const numericProfile of [RENDER_JSON_4300, RENDER_JSON_UNLIMITED]) {
      const malformed = '{"unused":';
      const result = ready(read(embeddedRow(adapter, malformed) + '\n', { numericProfile }));
      assert.equal(result.events.length, adapter === 'claude' ? 0 : 1, adapter);
      if (adapter !== 'claude') {
        assert.equal(result.events[0]!.envelope.event.ev, 'tool_use', adapter);
        assert.equal(getMember(result.events[0]!.envelope.event.input, 'raw'), malformed, adapter);
      }
      assert.equal(
        result.checkpoint.offset,
        BigInt(Buffer.byteLength(embeddedRow(adapter, malformed) + '\n'))
      );
    }
    const malformedAfterInteger = `{"unused":${over},broken`;
    const fallback = ready(
      read(embeddedRow(adapter, malformedAfterInteger) + '\n', {
        numericProfile: RENDER_JSON_UNLIMITED,
      })
    );
    assert.equal(fallback.events.length, adapter === 'claude' ? 0 : 1, adapter);
    if (adapter !== 'claude')
      assert.equal(
        getMember(fallback.events[0]!.envelope.event.input, 'raw'),
        malformedAfterInteger,
        adapter
      );
    const overwritten = ready(
      read(
        embeddedRow(
          adapter,
          `{"hookSpecificOutput":{"additionalContext":"kept"},"unused":${over},"unused":0}`
        ) + '\n',
        { numericProfile: RENDER_JSON_UNLIMITED }
      )
    );
    assert.equal(overwritten.events.length, 1, adapter);
    const event = overwritten.events[0]!.envelope.event;
    if (adapter === 'claude') assert.equal(event.additional_context, 'kept');
    else
      assert.deepEqual(getMember(event.input, 'unused'), {
        kind: 'number',
        numberKind: 'integer',
        lexeme: '0',
      });
  }
});

test('embedded selected conversion admits signed boundary integers long floats and numeric-looking strings', () => {
  const boundary = '1'.repeat(4300);
  for (const adapter of embeddedAdapters)
    for (const [literal, expected] of [
      [boundary, { kind: 'number', numberKind: 'integer', lexeme: boundary }],
      [`-${boundary}`, { kind: 'number', numberKind: 'integer', lexeme: `-${boundary}` }],
      [`${over}.0`, { kind: 'number', numberKind: 'float', lexeme: `${over}.0` }],
      [JSON.stringify(over), over],
    ] as const) {
      const result = ready(
        read(
          embeddedRow(
            adapter,
            `{"hookSpecificOutput":{"additionalContext":"kept"},"value":${literal}}`
          ) + '\n'
        )
      );
      assert.equal(result.events.length, 1, adapter);
      const event = result.events[0]!.envelope.event;
      if (adapter === 'claude') assert.equal(event.additional_context, 'kept');
      else assert.deepEqual(getMember(event.input, 'value'), expected, adapter);
    }
});

test('complete prefix commits before failed tentative tail: exact 124 248 248 372 offsets', () => {
  const reg = registry();
  const a = line124('A'),
    b = line124('B'),
    c = line124('C');
  assert.equal(Buffer.byteLength(a), 124);
  const first = ready(read(a, { registry: reg }));
  assert.equal(first.checkpoint.offset, 124n);
  const second = read(a + b + `{"unused":${over}}`, {
    registry: reg,
    priorCheckpoint: first.checkpoint,
  });
  assert.equal(second.disposition, 'failed');
  assert.equal(checkpoint(second).offset, 248n);
  assert.deepEqual(texts(second), ['A', 'B']);
  assert.equal(second.tentative, true);
  assert.equal(second.reusedPrefix, true);
  assert.equal(
    checkpoint(second).prefixSha256,
    createHash('sha256')
      .update(a + b)
      .digest('hex')
  );
  assert.equal(first.checkpoint.offset, 124n);
  assert.deepEqual(
    first.checkpoint.events.map(({ envelope }) => envelope.event.text),
    ['A']
  );
  const retry = read(a + b + `{"unused":${over}}\n`, {
    registry: reg,
    priorCheckpoint: checkpoint(second),
  });
  assert.equal(retry.disposition, 'failed');
  assert.equal(retry.checkpoint, second.checkpoint);
  assert.equal(checkpoint(retry).offset, 248n);
  const repaired = ready(read(a + b + c, { registry: reg, priorCheckpoint: checkpoint(retry) }));
  assert.equal(repaired.checkpoint.offset, 372n);
  assert.deepEqual(texts(repaired), ['A', 'B', 'C']);
});

test('a failed complete chunk is atomic even after an earlier successful new row', () => {
  const reg = registry(),
    a = line124('A');
  const first = ready(read(a, { registry: reg }));
  const failure = read(a + line124('B') + `{"n":${over}}\n`, {
    registry: reg,
    priorCheckpoint: first.checkpoint,
  });
  assert.equal(failure.disposition, 'failed');
  assert.equal(failure.checkpoint, first.checkpoint);
  assert.deepEqual(texts(failure), ['A']);
  const cold = read(line124('B') + `{"n":${over}}\n`, { registry: reg });
  assert.equal(cold.disposition, 'failed');
  assert.equal(checkpoint(cold).offset, 0n);
  assert.deepEqual(cold.events, []);
});

test('strict UTF8 fails complete and partial acquisition without swallowing decoder error', () => {
  const a = line124('A');
  const complete = read(Buffer.concat([Buffer.from(a), Buffer.from([0xff, 0x0a])]));
  assert.equal(complete.disposition, 'failed');
  if (complete.disposition !== 'failed') throw new Error('expected failed');
  assert.equal(complete.failure.phase, 'utf8');
  assert.equal(checkpoint(complete).offset, 0n);
  const tail = read(Buffer.concat([Buffer.from(a), Buffer.from([0xff])]));
  assert.equal(tail.disposition, 'failed');
  if (tail.disposition !== 'failed') throw new Error('expected failed');
  assert.equal(tail.failure.phase, 'utf8');
  assert.equal(checkpoint(tail).offset, 124n);
  assert.deepEqual(texts(tail), ['A']);
});

test('tentative valid events are reread without duplication when newline completes the row', () => {
  const reg = registry(),
    a = line124('A'),
    b = user('B');
  const first = ready(read(a + b, { registry: reg }));
  assert.deepEqual(texts(first), ['A', 'B']);
  assert.equal(first.checkpoint.events.length, 1);
  assert.equal(first.events[1]!.envelope.source.framing, 'partial');
  const next = ready(read(a + b + '\n', { registry: reg, priorCheckpoint: first.checkpoint }));
  assert.deepEqual(texts(next), ['A', 'B']);
  assert.equal(next.checkpoint.events.length, 2);
  assert.equal(next.events[1]!.envelope.source.framing, 'complete');
});

test('cache reuses only actual original hash inode size identity profile and registry interpretation', () => {
  const reg = registry(),
    a = line124('A');
  const first = ready(read(a, { registry: reg }));
  const options = { registry: reg, priorCheckpoint: first.checkpoint };
  assert.equal(ready(read(a + line124('B'), options)).reusedPrefix, true);
  assert.deepEqual(texts(ready(read(line124('Z'), options))), ['Z']);
  assert.equal(ready(read(line124('Z'), options)).reusedPrefix, false);
  assert.equal(ready(read('', options)).reusedPrefix, false);
  assert.equal(
    ready(read(a, { ...options, source: { ...source(a), inode: '8' } })).reusedPrefix,
    false
  );
  assert.equal(
    ready(read(a, { ...options, source: { ...source(a), sourceGeneration: 'other' } }))
      .reusedPrefix,
    false
  );
  assert.equal(
    ready(read(a, { ...options, source: { ...source(a), sourceId: '/other' } })).reusedPrefix,
    false
  );
  assert.equal(
    ready(
      read(a, {
        ...options,
        registry: registry(undefined, RENDER_JSON_UNLIMITED),
        numericProfile: RENDER_JSON_UNLIMITED,
      })
    ).reusedPrefix,
    false
  );
  assert.equal(
    ready(
      read(a, {
        ...options,
        registry: registry(undefined, { ...RENDER_JSON_4300, id: 'changed' }),
        numericProfile: { ...RENDER_JSON_4300, id: 'changed' },
      })
    ).reusedPrefix,
    false
  );
  assert.equal(ready(read(a, { ...options, registry: registry('codex') })).reusedPrefix, false);
  assert.equal(ready(read(a, { ...options, registry: registry() })).reusedPrefix, false);
  assert.equal(
    ready(read(a, { ...options, priorCheckpoint: { ...first.checkpoint } })).reusedPrefix,
    false
  );
  const bytes = source(a);
  const owned = ready(read(a, { source: bytes, registry: reg }));
  bytes.bytes.fill(0);
  assert.deepEqual(texts(owned), ['A']);
  assert.equal(
    owned.events[0]!.envelope.source.rawBase64,
    Buffer.from(a.slice(0, -1)).toString('base64')
  );
});

test('unsupported selected override, missing profile and mismatched source size fail explicitly', () => {
  for (const value of ['/external.py', '']) {
    const result = read(user('no fallback'), { selectedAdapterOverride: value });
    assert.equal(result.disposition, 'failed');
    assert.equal(result.context, null);
    assert.equal(result.checkpoint, null);
    assert.deepEqual(result.events, []);
  }
  assert.equal(
    read('', {
      registry: registry(),
      numericProfile: undefined as unknown as RenderReaderInput['numericProfile'],
    }).disposition,
    'failed'
  );
  assert.equal(
    read('', { registry: registry(), numericProfile: { id: 'unsupported', integerMaxDigits: 1 } })
      .disposition,
    'failed'
  );
  assert.equal(read('', { source: { ...source(''), size: 1n } }).disposition, 'failed');
});

test('reader refuses historical and mismatched embedded profiles before decoding or checkpoint reuse', () => {
  const first = ready(read(line124('A')));
  for (const reg of [
    createDefaultTranscriptRegistry({ dshProfile: { id: 'historical', decode: parsePythonJson } }),
    registry(undefined, RENDER_JSON_UNLIMITED),
    registry(undefined, { ...RENDER_JSON_4300, id: 'different-profile' }),
    registry(undefined, { ...RENDER_JSON_4300, integerMaxDigits: 640 }),
  ]) {
    const failed = read(Buffer.from([0xff]), { registry: reg, priorCheckpoint: first.checkpoint });
    if (failed.disposition !== 'failed') throw new Error('Expected profile refusal');
    assert.equal(failed.failure.phase, 'profile');
    assert.match(failed.failure.message, /Registry and reader numeric profiles must agree exactly/);
    assert.equal(failed.context, null);
    assert.equal(failed.checkpoint, null);
    assert.equal(failed.reusedPrefix, false);
    assert.deepEqual(failed.events, []);
  }
});

test('actual Codex raw exec source retains scalar versus surrogate actions and original attribution', () => {
  const raw =
    "tools.exec_command({cmd:'\\U0001f600'}); tools.exec_command({cmd:'\\ud83d\\ude00'});";
  const call = (name: string) =>
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'custom_tool_call', name, input: raw, call_id: 'c' },
    }) + '\n';
  const result = ready(read(call('functions.exec'), { registry: registry('codex') }));
  const event = result.events[0]!;
  assert.equal(event.envelope.event.source_harness, 'codex');
  assert.equal(event.envelope.event.name, 'functions.exec');
  assert.equal(getMember(event.envelope.event.input, 'raw'), raw);
  assert.ok(event.derived);
  assert.equal(event.derived.index.rawSource, raw);
  assert.equal(event.derived.index.execution, 'not_observed');
  const [scalar, pair] = event.derived.index.actions.map((action) => action.command);
  assert.ok(isCodepointText(scalar));
  assert.ok(isCodepointText(pair));
  assert.deepEqual(scalar.codepoints, [0x1f600]);
  assert.deepEqual(pair.codepoints, [0xd83d, 0xde00]);
  assert.equal(
    ready(read(call('functions.exec'), { registry: registry('opencode') })).events[0]!.derived,
    null
  );
  assert.equal(
    ready(read(call('functions.other'), { registry: registry('codex') })).events[0]!.derived,
    null
  );
  const claude = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'functions.exec', input: { raw } }] },
  });
  assert.ok(ready(read(claude, { registry: registry('codex') })).events[0]!.derived);
});

test('source index consumer suffix-normalizes only codex attribution but accepts literal exec on other surfaces', () => {
  const raw = 'tools.exec_command({cmd:"literal"});';
  const claude = (name: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name, input: { raw } }] },
    }) + '\n';
  const literal = ready(read(claude('exec'))).events[0]!;
  assert.equal(literal.envelope.event.source_harness, 'claude');
  assert.ok(literal.derived);
  assert.equal(literal.derived.index.rawSource, raw);
  assert.equal(ready(read(claude('functions.exec'))).events[0]!.derived, null);
  assert.ok(
    ready(read(claude('functions.exec'), { registry: registry('codex') })).events[0]!.derived
  );
});

const observedFile = (path: string, raw: string | Uint8Array): ObservedRendererFile => ({
  path,
  disposition: 'read',
  source: { ...source(raw), sourceId: path },
});
const absentFile = (path: string): ObservedRendererFile => ({ path, disposition: 'absent' });
const absentDirectory = (path: string): ObservedRendererDirectory => ({ path, kind: 'absent' });
const directory = (
  path: string,
  entries: readonly { name: string; file: ObservedRendererFile }[]
): ObservedRendererDirectory => ({
  path,
  kind: 'directory',
  listing: { disposition: 'listed', entries },
});
const metaInput = (entries: readonly { name: string; file: ObservedRendererFile }[]) => ({
  transcriptPath: '/project/sid.jsonl',
  sessionId: 'sid',
  numericProfile: RENDER_JSON_4300,
  claudeCandidate: directory('/project/sid/subagents', entries),
  qwenCandidate: absentDirectory('/subagents/sid'),
});
const auxiliary = (
  audit: ObservedRendererFile,
  hookOutcomes: ObservedRendererFile = absentFile('/hooks')
) =>
  parseRendererAuxiliary({
    audit,
    hookOutcomes,
    sessionId: 'sid',
    numericProfile: RENDER_JSON_4300,
  });

test('auxiliary byte ownership retains buffer identity and refuses descriptor tampering', () => {
  const raw = '{"session_id":"sid","event":"tool_use","tool":"Bash","command":"echo retained"}\n';
  const source = bufferSource(raw);
  source.descriptor.name = 'audit.log';
  source.descriptor.role = 'audit';
  const observed: ObservedRendererFile = { path: '/audit', disposition: 'read', source };
  const result = auxiliary(observed);
  assert.equal(result.disposition, 'ready');
  assert.equal(result.events.length, 1);
  const identity = result.observations.audit;
  if (identity.disposition !== 'read' || identity.kind !== 'publication-buffer')
    throw new Error('Expected owned buffer auxiliary identity');
  assert.equal(Object.hasOwn(identity, 'inode'), false);
  assert.equal(identity.rawBase64, Buffer.from(raw).toString('base64'));
  assert.equal(identity.sha256, source.descriptor.sha256);
  assert.equal(Object.isFrozen(identity.binding), true);
  const originalToken = identity.binding.token;
  source.binding.token = 'mutated';
  source.bytes.fill(0);
  assert.equal(identity.binding.token, originalToken);
  assert.equal(identity.rawBase64, Buffer.from(raw).toString('base64'));
  assert.throws(() => auxiliary(observed), /Publication buffer descriptor hash differs/);
});

test('actual auxiliary acquisition replaces UTF8, uses Python splitlines, retains raw bytes and syntax diagnostics', () => {
  const auditRow =
    '{"session_id":"sid","event":"tool_use","tool":"Bash","tool_input":{"command":"","file_path":""},"command":"echo REPLACED","file":"a.txt","tool_use_id":9007199254740993,"is_error":"false"}';
  const bytes = Buffer.from(auditRow.replace('REPLACED', 'X'));
  bytes[bytes.indexOf('X')] = 0xff;
  const raw = Buffer.concat([
    Buffer.from('\u00a0{}\r\nnull\u0085'),
    bytes,
    Buffer.from('\u2028' + '{"session_id":"other","event":"tool_use"}'),
  ]);
  const result = auxiliary(observedFile('/audit', raw));
  assert.equal(result.disposition, 'ready');
  assert.equal(result.events.length, 1);
  const envelope = result.events[0]!.envelope;
  assert.equal(envelope.adapter.id, 'renderer-aux-audit');
  assert.equal(envelope.source.rawBase64, bytes.toString('base64'));
  assert.equal(getMember(envelope.event.input, 'command'), 'echo \ufffd');
  assert.equal(getMember(envelope.event.input, 'file_path'), 'a.txt');
  assert.equal(envelope.event.is_error, true);
  assert.deepEqual(envelope.event.id, {
    kind: 'number',
    numberKind: 'integer',
    lexeme: '9007199254740993',
  });
  assert.deepEqual(result.diagnostics, [{ sourcePath: '/audit', malformedRecords: 1 }]);
  assert.equal(result.observations.audit.disposition, 'read');
  if (result.observations.audit.disposition !== 'read') throw new Error('expected read identity');
  assert.equal(result.observations.audit.rawBase64, raw.toString('base64'));
});

test('hook outcome derives context, status, explicit null defaults and nested numeric refusal from owned rows', () => {
  const stdout = JSON.stringify({
    hookSpecificOutput: { additionalContext: 'context', permissionDecision: 'ask' },
  });
  const hook = JSON.stringify({
    session_id: 'sid',
    stdout,
    handler: 'guard',
    exit_code: 0,
    observation_boundary: null,
  });
  const result = auxiliary(absentFile('/audit'), observedFile('/hooks', hook));
  assert.equal(result.disposition, 'ready');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.envelope.event.additional_context, 'context');
  assert.equal(result.events[0]!.envelope.event.status, 'ask');
  assert.equal(result.events[0]!.envelope.event.observation_boundary, null);
  const cap = JSON.stringify({ session_id: 'sid', stdout: '{"unused":' + over + '}' });
  const failed = auxiliary(absentFile('/audit'), observedFile('/hooks', cap));
  assert.equal(failed.disposition, 'failed');
  if (failed.disposition !== 'failed') throw new Error('expected numeric refusal');
  assert.equal(failed.failure.phase, 'numeric');
  assert.deepEqual(failed.events, []);
  const outer = auxiliary(observedFile('/audit', '{"unused":' + over + ',bad'));
  assert.equal(outer.disposition, 'failed');
  const observations = auxiliary({ path: '/audit', disposition: 'failed', error: 'EACCES' });
  assert.equal(observations.disposition, 'ready');
  assert.deepEqual(observations.observations.audit, {
    path: '/audit',
    disposition: 'failed',
    error: 'EACCES',
  });
});

test('metadata selects first directory even empty or listing failure and retains negative candidate evidence', () => {
  const qwen = directory('/subagents/sid', [
    {
      name: 'agent-q.meta.json',
      file: observedFile('/subagents/sid/agent-q.meta.json', '{"toolUseId":"q"}'),
    },
  ]);
  const base = metaInput([]);
  const emptyFirst = parseRendererSubagents({ ...base, qwenCandidate: qwen });
  assert.equal(emptyFirst.disposition, 'ready');
  const absentMeta = parseRendererSubagents(
    metaInput([
      { name: 'agent-a.meta.json', file: absentFile('/project/sid/subagents/agent-a.meta.json') },
    ])
  );
  const failedMeta = parseRendererSubagents(
    metaInput([
      {
        name: 'agent-a.meta.json',
        file: {
          path: '/project/sid/subagents/agent-a.meta.json',
          disposition: 'failed',
          error: 'EACCES',
        },
      },
    ])
  );
  const readMeta = parseRendererSubagents(
    metaInput([
      {
        name: 'agent-a.meta.json',
        file: observedFile('/project/sid/subagents/agent-a.meta.json', '{}'),
      },
    ])
  );
  assert.notDeepEqual(absentMeta.observations, failedMeta.observations);
  assert.notDeepEqual(failedMeta.observations, readMeta.observations);
  assert.equal(emptyFirst.selectedDirectory, '/project/sid/subagents');
  assert.deepEqual(emptyFirst.links, []);
  const qwenSelected = parseRendererSubagents({
    ...base,
    claudeCandidate: absentDirectory('/project/sid/subagents'),
    qwenCandidate: qwen,
  });
  assert.equal(qwenSelected.disposition, 'ready');
  assert.equal(qwenSelected.selectedDirectory, '/subagents/sid');
  assert.deepEqual(
    qwenSelected.links.map((link) => link.toolUseId),
    ['q']
  );
  assert.equal(qwenSelected.observations.claudeCandidate.kind, 'absent');
  const listingFailure = parseRendererSubagents({
    ...base,
    claudeCandidate: {
      path: '/project/sid/subagents',
      kind: 'directory',
      listing: { disposition: 'failed', error: 'EACCES' },
    },
    qwenCandidate: qwen,
  });
  assert.equal(listingFailure.disposition, 'ready');
  assert.deepEqual(listingFailure.links, []);
  assert.equal(listingFailure.selectedDirectory, '/project/sid/subagents');
  assert.equal(
    parseRendererSubagents({ ...base, claudeCandidate: absentDirectory('/wrong') }).disposition,
    'failed'
  );
});

test('sorted metadata last-wins retains bool depth,200 codepoints and the actual fork transcript filename', () => {
  const entries = [
    {
      name: 'agent-z.meta.json',
      file: observedFile(
        '/project/sid/subagents/agent-z.meta.json',
        JSON.stringify({
          toolUseId: 'same',
          spawnDepth: true,
          description: '😀'.repeat(201),
          model: 'last',
        })
      ),
    },
    {
      name: 'agent-a.meta.json',
      file: observedFile(
        '/project/sid/subagents/agent-a.meta.json',
        '{"toolUseId":"same","spawnDepth":1,"model":"first"}'
      ),
    },
    {
      name: 'agent-b.meta.json',
      file: observedFile('/project/sid/subagents/agent-b.meta.json', '{"unused":' + over + '}'),
    },
    {
      name: 'agent-c.meta.json',
      file: observedFile('/project/sid/subagents/agent-c.meta.json', Buffer.from([0xff])),
    },
    { name: 'not-agent.json', file: observedFile('/ignored', 'null') },
  ];
  const result = parseRendererSubagents(metaInput(entries));
  assert.equal(result.disposition, 'ready');
  assert.equal(result.links.length, 1);
  const value = result.links[0]!.value;
  assert.equal(renderGet(value, 'spawn_depth'), true);
  assert.equal(renderGet(value, 'model'), 'last');
  assert.equal(renderGet(value, 'description'), '😀'.repeat(200));
  assert.equal(renderGet(value, 'transcript'), 'agent-z.jsonl');
  const failed = parseRendererSubagents(
    metaInput([
      {
        name: 'agent-b.meta.json',
        file: observedFile('/project/sid/subagents/agent-b.meta.json', '[]'),
      },
    ])
  );
  assert.equal(failed.disposition, 'failed');
  if (failed.disposition !== 'failed') throw new Error('expected nonobject metadata failure');
  assert.match(failed.failure.message, /not an object/);
});
