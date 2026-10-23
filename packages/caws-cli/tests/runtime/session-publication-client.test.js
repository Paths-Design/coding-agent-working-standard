const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AbortController, structuredClone } = globalThis;
const {
  continueNativeSessionPublication,
  createNativeSessionSealPort,
} = require('../../dist/runtime/session-publication-client');
const { SESSION_PUBLICATION_CAPABILITY } = require('../../dist/runtime/protocol');
const wire = require('../../dist/runtime/session-publication-wire');
const { readCommittedSessionLog } = require('../../dist/runtime/session-log');
const {
  executeNativeSessionSeal,
  prepareCapturedSessionSeal,
} = require('../../dist/runtime/session-seal-runtime');

const request = {
  id: 'publication-test',
  runtimeDigest: 'a'.repeat(64),
  surface: 'codex',
  event: 'session_end',
  configuration: 'system',
  sessionPublication: SESSION_PUBLICATION_CAPABILITY,
  deadlineEpochMs: Date.now() + 60_000,
};
const token = 'original-token';
const attempt = 'native-attempt';
const inputBytes = Buffer.from('{"usage":{"input_tokens":9007199254740993}}');
const outputBytes = Buffer.from('{"ended":{"reason":"exit"}}');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptor = (name, role, bytes) => ({
  name,
  role,
  byteLength: bytes.length,
  sha256: sha(bytes),
});
const inputDescriptor = descriptor('turn-001.json', 'turn', inputBytes);
const outputDescriptor = descriptor('.meta.json', 'metadata', outputBytes);
const ordered = (artifacts) =>
  [...artifacts].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const terminal = (status, artifacts, selectedToken = token) =>
  sha(
    Buffer.from(
      JSON.stringify(
        status === 'not_published'
          ? [
              {
                id: request.id,
                runtimeDigest: request.runtimeDigest,
                token: selectedToken,
                attempt,
              },
              status,
            ]
          : [
              {
                id: request.id,
                runtimeDigest: request.runtimeDigest,
                token: selectedToken,
                attempt,
              },
              'published',
              ordered(artifacts),
            ]
      )
    )
  );
const terminalDigest = terminal('published', [outputDescriptor]);
const notPublishedDigest = terminal('not_published', []);
let canonicalRoot, sessionDirectory;
beforeEach(() => {
  canonicalRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'session-publication-client-'))
  );
  sessionDirectory = path.join(canonicalRoot, '.caws/sessions/session-one');
  fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
});
afterEach(() => fs.rmSync(canonicalRoot, { recursive: true, force: true }));
const prepareFrame = (kind = 'seal', files = [inputDescriptor], priorInventory = []) => ({
  schema: wire.SESSION_PUBLICATION_PREPARE_SCHEMA,
  kind,
  snapshot: {
    observationId: 'native-observation',
    inputDigest: 'b'.repeat(64),
    sessionId: 'session-one',
    reason: 'exit',
    endedAt: '2026-10-22T00:00:00Z',
    files,
    priorInventory,
  },
});
const inputFrame = (
  kind = 'seal',
  name = inputDescriptor.name,
  bytes = inputBytes,
  offset = 0
) => ({
  schema: wire.SESSION_PUBLICATION_INPUTS_SCHEMA,
  kind,
  name,
  offset,
  base64: bytes.toString('base64'),
});
const readyFrame = (kind = 'seal') => ({
  schema: wire.SESSION_PUBLICATION_READY_SCHEMA,
  kind,
  direction: 'inputs',
});
const resultFrame = (status = 'published', artifacts = [outputDescriptor]) => ({
  schema: wire.SESSION_PUBLICATION_RESULT_SCHEMA,
  status,
  terminalDigest: terminal(status, artifacts),
  artifacts: ordered(artifacts),
});
const readyPreparation = () => ({
  disposition: 'ready',
  artifacts: [{ name: '.meta.json', role: 'metadata', bytes: outputBytes }],
  removals: [],
  summaryMode: 'recomputed',
});
const sealFrames = () => [prepareFrame(), inputFrame(), readyFrame(), resultFrame()];

test.each([false, true])(
  'ordinary SessionEnd closure reads exact seven counts and unrelated metadata before ack; consumer failure=%s',
  async (failConsumer) => {
    const fields = [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
      'cached_input_tokens',
      'reasoning_output_tokens',
      'total_tokens',
    ];
    const huge = '9'.repeat(4300);
    const meta = Buffer.from('{"unrelated":{"exact":9007199254740993},"models":["prior"]}');
    const turn = Buffer.from(
      '{"schema_version":2,"models":["actual","second"],"usage":{' +
        fields.map((field) => JSON.stringify(field) + ':' + huge).join(',') +
        '}}'
    );
    const files = [
      descriptor('.meta.json', 'metadata', meta),
      descriptor('turn-001.json', 'turn', turn),
    ];
    const preparation = prepareCapturedSessionSeal({
      kind: 'seal',
      sessionId: 'session-one',
      reason: 'exit',
      endedAt: '2026-10-22T00:00:00Z',
      files,
      bytes: (name) => (name === '.meta.json' ? meta : turn),
    });
    expect(preparation.disposition).toBe('ready');
    const sealed = Buffer.from(preparation.artifacts[0].bytes);
    const state = setup(
      [
        prepareFrame('seal', files, files),
        inputFrame('seal', '.meta.json', meta),
        inputFrame('seal', 'turn-001.json', turn),
        readyFrame(),
        resultFrame('published', [descriptor('.meta.json', 'metadata', sealed), files[1]]),
      ],
      { dynamicToken: true, retainedFiles: new Map([['turn-001.json', turn]]) }
    );
    fs.writeFileSync(path.join(sessionDirectory, 'turn-001.json'), turn, { mode: 0o600 });
    const observations = [],
      failure = new Error('actual ordinary consumer failed');
    const run = executeNativeSessionSeal({
      port: createNativeSessionSealPort(request, state.transport, state.controller.signal),
      canonicalRoot,
      sessionId: 'session-one',
      signal: state.controller.signal,
      observe: (row) => {
        expect(
          state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
        ).toBe(false);
        expect(row.status).toBe('published');
        expect(row.counts.map(({ field, value }) => [field, value.lexeme])).toEqual(
          fields.map((field) => [field, huge])
        );
        expect(row.models).toEqual(['actual', 'second']);
        expect(row.reason).toBe('exit');
        expect(row.ended_at).toBe('2026-10-22T00:00:00Z');
        const raw = fs.readFileSync(path.join(sessionDirectory, '.meta.json'), 'utf8');
        expect(raw).toContain('"exact":9007199254740993');
        expect(row.metadata_sha256).toBe(sha(Buffer.from(raw)));
        observations.push(row);
        if (failConsumer) throw failure;
      },
    });
    if (failConsumer) {
      await expect(run).rejects.toBe(failure);
      expect(
        state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
      ).toBe(false);
    } else {
      await expect(run).resolves.toEqual({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
      });
      expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_CONSUMED_SCHEMA);
    }
    expect(observations).toHaveLength(1);
  }
);

test('ordinary missing-metadata seal is silent and explicitly consumed as not_published', async () => {
  const state = setup([prepareFrame('seal', []), readyFrame(), resultFrame('not_published', [])], {
    dynamicToken: true,
  });
  const observations = [];
  await expect(
    executeNativeSessionSeal({
      port: createNativeSessionSealPort(request, state.transport, state.controller.signal),
      canonicalRoot,
      sessionId: 'session-one',
      signal: state.controller.signal,
      observe: (row) => observations.push(row),
    })
  ).resolves.toEqual({ exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array() });
  expect(observations).toEqual([
    expect.objectContaining({ status: 'not_published', missing_metadata: true }),
  ]);
  expect(fs.existsSync(path.join(sessionDirectory, '.session-publication.json'))).toBe(false);
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_CONSUMED_SCHEMA);
});

function setup(
  frames,
  {
    failWrite,
    dynamicToken = false,
    publish = true,
    afterPublish,
    consume,
    retainedFiles = new Map([[inputDescriptor.name, inputBytes]]),
  } = {}
) {
  const writes = [],
    reads = [],
    consumptions = [];
  const controller = new AbortController();
  const transport = {
    async read() {
      const frame = frames.shift();
      if (frame === undefined) throw Error('controlled EOF');
      if (frame instanceof Error) throw frame;
      const correlated = {
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token: dynamicToken ? writes[0]?.token : token,
        attempt,
        ...frame,
      };
      if (correlated.schema === wire.SESSION_PUBLICATION_RESULT_SCHEMA && dynamicToken)
        correlated.terminalDigest = terminal(
          correlated.status,
          correlated.artifacts,
          correlated.token
        );
      if (
        correlated.schema === wire.SESSION_PUBLICATION_RESULT_SCHEMA &&
        correlated.status === 'published' &&
        publish
      ) {
        const contents = new Map(retainedFiles);
        for (const item of writes.filter(
          (item) => item.schema === wire.SESSION_PUBLICATION_CHUNK_SCHEMA
        )) {
          if (item.offset === 0) contents.set(item.name, Buffer.alloc(0));
          contents.set(
            item.name,
            Buffer.concat([
              contents.get(item.name) ?? Buffer.alloc(0),
              Buffer.from(item.base64, 'base64'),
            ])
          );
        }
        for (const artifact of correlated.artifacts) {
          const bytes = contents.get(artifact.name);
          if (bytes)
            fs.writeFileSync(path.join(sessionDirectory, artifact.name), bytes, { mode: 0o600 });
        }
        fs.writeFileSync(
          path.join(sessionDirectory, '.session-publication.json'),
          JSON.stringify({
            schema: 'caws.session.publication.v1',
            canonicalRoot,
            sessionId: 'session-one',
            correlation: {
              id: correlated.id,
              runtimeDigest: correlated.runtimeDigest,
              token: correlated.token,
              attempt: correlated.attempt,
            },
            terminalDigest: correlated.terminalDigest,
            artifacts: correlated.artifacts,
          }),
          { mode: 0o600 }
        );
        await afterPublish?.();
      }
      const bytes =
        typeof frame === 'string' || Buffer.isBuffer(frame)
          ? Buffer.from(frame)
          : Buffer.from(JSON.stringify(correlated));
      reads.push(Buffer.from(bytes));
      return bytes;
    },
    async write(frame) {
      if (failWrite?.(frame)) throw Error('controlled delivery loss');
      writes.push(structuredClone(frame));
    },
  };
  return {
    transport,
    writes,
    reads,
    consumptions,
    controller,
    run(prepare = async () => readyPreparation(), expectedKinds = ['seal'], invocation = request) {
      return continueNativeSessionPublication(invocation, transport, controller.signal, {
        token,
        expectedKinds,
        prepare,
        canonicalRoot,
        sessionId: 'session-one',
        consume:
          consume ??
          (async (outcome) => {
            consumptions.push(
              outcome.status === 'published'
                ? {
                    status: outcome.status,
                    bytes: outcome.session.artifacts.map((item) =>
                      Buffer.from(outcome.session.bytes(item.name))
                    ),
                  }
                : { status: outcome.status }
            );
          }),
      });
    },
  };
}

test('complete native snapshot and exact output bytes precede terminal consumption', async () => {
  const state = setup(sealFrames());
  const receipt = await state.run(async (input) => {
    expect(input.files).toEqual([inputDescriptor]);
    expect(input.sessionId).toBe('session-one');
    expect(input.reason).toBe('exit');
    expect(Buffer.from(input.bytes(inputDescriptor.name))).toEqual(inputBytes);
    const copy = input.bytes(inputDescriptor.name);
    copy.fill(0);
    expect(Buffer.from(input.bytes(inputDescriptor.name))).toEqual(inputBytes);
    expect(() => input.bytes('not-observed')).toThrow('Unknown native snapshot file');
    return readyPreparation();
  });
  expect(receipt).toEqual({ status: 'published', terminalDigest, artifacts: [outputDescriptor] });
  expect(state.writes).toEqual([
    {
      schema: wire.SESSION_PUBLICATION_PREPARED_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      token,
      attempt,
      kind: 'seal',
      observationId: 'native-observation',
      inputDigest: 'b'.repeat(64),
      disposition: 'ready',
      artifacts: [outputDescriptor],
      removals: [],
      summaryMode: 'recomputed',
    },
    {
      schema: wire.SESSION_PUBLICATION_CHUNK_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      token,
      attempt,
      kind: 'seal',
      name: '.meta.json',
      offset: 0,
      base64: outputBytes.toString('base64'),
    },
    {
      schema: wire.SESSION_PUBLICATION_READY_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      token,
      attempt,
      kind: 'seal',
      direction: 'prepared',
    },
    {
      schema: wire.SESSION_PUBLICATION_CONSUMED_SCHEMA,
      id: request.id,
      runtimeDigest: request.runtimeDigest,
      token,
      attempt,
      terminalDigest,
    },
  ]);
  expect(state.reads).toHaveLength(4);
});

test.each(['id', 'runtimeDigest', 'token', 'attempt'])(
  'changed %s refuses without consumption',
  async (key) => {
    const frames = sealFrames();
    frames[1][key] = 'foreign';
    const state = setup(frames);
    const prepare = jest.fn();
    await expect(state.run(prepare)).rejects.toThrow(/correlation|attempt/);
    expect(prepare).not.toHaveBeenCalled();
    expect(state.writes).toEqual([]);
  }
);

test.each([
  [
    'offset',
    (frame) => {
      frame.offset = 1;
    },
    /chunk/,
  ],
  [
    'filename',
    (frame) => {
      frame.name = 'other.json';
    },
    /chunk/,
  ],
  [
    'phase',
    (frame) => {
      frame.kind = 'render';
    },
    /chunk/,
  ],
  [
    'noncanonical base64',
    (frame) => {
      frame.base64 = inputBytes.toString('base64').replace(/=+$/, '');
    },
    /encoding/,
  ],
  [
    'changed bytes',
    (frame) => {
      frame.base64 = Buffer.alloc(inputBytes.length, 1).toString('base64');
    },
    /digest/,
  ],
])('invalid input %s refuses before preparation', async (_label, alter, message) => {
  const frames = sealFrames();
  alter(frames[1]);
  const state = setup(frames),
    prepare = jest.fn();
  await expect(state.run(prepare)).rejects.toThrow(message);
  expect(prepare).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
});

test('incomplete input snapshot refuses instead of using supplied partial bytes', async () => {
  const state = setup([prepareFrame(), inputFrame(), resultFrame()]);
  const prepare = jest.fn();
  await expect(state.run(prepare)).rejects.toThrow('snapshot is incomplete');
  expect(prepare).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
});

test.each(['../turn.json', '/tmp/turn.json', 'x/../turn.json', 'turn\u0000.json'])(
  'unsafe input name %s refuses before reading bytes',
  async (name) => {
    const state = setup([prepareFrame('seal', [{ ...inputDescriptor, name }])]);
    await expect(state.run()).rejects.toThrow('descriptor');
    expect(state.reads).toHaveLength(1);
    expect(state.writes).toEqual([]);
  }
);

test.each([
  [
    'wrong target',
    (value) => {
      value.artifacts[0].name = 'turn-001.json';
    },
  ],
  [
    'wrong role',
    (value) => {
      value.artifacts[0].role = 'turn';
    },
  ],
  [
    'multiple targets',
    (value) => {
      value.artifacts.push({ name: 'other.json', role: 'metadata', bytes: outputBytes });
    },
  ],
  [
    'seal removal',
    (value) => {
      value.removals.push('turn-001.json');
    },
  ],
])('invalid prepared %s sends no prepared frame or bytes', async (_label, alter) => {
  const state = setup(sealFrames()),
    preparation = readyPreparation();
  alter(preparation);
  await expect(state.run(async () => preparation)).rejects.toThrow(/targets|removals/);
  expect(state.writes).toEqual([]);
});

test.each([
  { disposition: undefined },
  { disposition: null },
  { disposition: 'refused' },
  { disposition: ['ready'] },
])(
  'unknown preparation disposition %j refuses before copying or writing output',
  async ({ disposition }) => {
    const state = setup(sealFrames());
    const original = Buffer.from;
    let copies = 0;
    const spy = jest.spyOn(Buffer, 'from').mockImplementation((value, ...args) => {
      if (value === outputBytes) {
        copies++;
        throw Error('copy of refused output');
      }
      return original(value, ...args);
    });
    try {
      await expect(state.run(async () => ({ ...readyPreparation(), disposition }))).rejects.toThrow(
        'Invalid publication preparation disposition'
      );
      expect(copies).toBe(0);
      expect(state.writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }
);

test('aborted preparation sends no output bytes and consumes a definite refusal', async () => {
  const state = setup([
    prepareFrame(),
    inputFrame(),
    readyFrame(),
    resultFrame('not_published', []),
  ]);
  expect(
    await state.run(async () => ({ disposition: 'aborted', diagnostic: 'invalid turn' }))
  ).toEqual({ status: 'not_published', terminalDigest: notPublishedDigest, artifacts: [] });
  expect(state.consumptions).toEqual([{ status: 'not_published' }]);
  expect(state.writes.map((frame) => frame.schema)).toEqual([
    wire.SESSION_PUBLICATION_PREPARED_SCHEMA,
    wire.SESSION_PUBLICATION_READY_SCHEMA,
    wire.SESSION_PUBLICATION_CONSUMED_SCHEMA,
  ]);
  expect(state.writes[0]).toMatchObject({
    disposition: 'aborted',
    artifacts: [],
    removals: [],
    diagnostic: 'invalid turn',
  });
});

test.each(['published', 'publication_uncertain'])(
  'aborted preparation rejects a contradictory %s result without consumption',
  async (status) => {
    const state = setup([prepareFrame(), inputFrame(), readyFrame(), resultFrame(status, [])]);
    await expect(
      state.run(async () => ({ disposition: 'aborted', diagnostic: 'invalid turn' }))
    ).rejects.toThrow('aborted');
    expect(
      state.writes.some((frame) => frame.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
    ).toBe(false);
  }
);

test('aborted projection cannot advance to render preparation', async () => {
  const state = setup([
    prepareFrame('projection', []),
    readyFrame('projection'),
    prepareFrame('render', []),
  ]);
  const prepare = jest.fn(async () => ({
    disposition: 'aborted',
    diagnostic: 'refused projection',
  }));
  await expect(state.run(prepare, ['projection', 'render'])).rejects.toThrow('aborted');
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(state.writes.map((frame) => frame.schema)).toEqual([
    wire.SESSION_PUBLICATION_PREPARED_SCHEMA,
    wire.SESSION_PUBLICATION_READY_SCHEMA,
  ]);
});

test.each([
  ['missing', []],
  ['changed digest', [{ ...outputDescriptor, sha256: 'd'.repeat(64) }]],
  ['changed role', [{ ...outputDescriptor, role: 'turn' }]],
  ['changed length', [{ ...outputDescriptor, byteLength: outputDescriptor.byteLength + 1 }]],
])('published inventory with %s prepared artifact is not consumed', async (_label, artifacts) => {
  const state = setup([
    prepareFrame(),
    inputFrame(),
    readyFrame(),
    resultFrame('published', artifacts),
  ]);
  await expect(state.run()).rejects.toThrow('inventory differs');
  expect(
    state.writes.some((frame) => frame.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
});

test('early published result does not fabricate completion', async () => {
  const state = setup([resultFrame()]);
  await expect(state.run()).rejects.toThrow('before all preparation phases');
  expect(state.writes).toEqual([]);
});

test.each([
  { status: ['published'] },
  { status: { value: 'published' } },
  { status: null },
  { status: 0 },
])('non-string status %j is refused before terminal consumption', async ({ status }) => {
  const state = setup([resultFrame(status, [])]);
  await expect(state.run()).rejects.toThrow('Invalid publication result');
  expect(state.writes).toEqual([]);
});

test('published inventory refuses unexplained artifacts', async () => {
  const extra = descriptor('turn-999.json', 'turn', Buffer.from('unobserved'));
  const state = setup([
    prepareFrame(),
    inputFrame(),
    readyFrame(),
    resultFrame('published', [outputDescriptor, extra]),
  ]);
  await expect(state.run()).rejects.toThrow('inventory differs');
  expect(
    state.writes.some((frame) => frame.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
});

test('published inventory retains unchanged prior artifacts exactly', async () => {
  const prior = descriptor('turn-001.json', 'turn', inputBytes);
  const state = setup([
    prepareFrame('seal', [], [prior]),
    readyFrame(),
    resultFrame('published', [prior, outputDescriptor]),
  ]);
  expect(await state.run()).toEqual({
    status: 'published',
    terminalDigest: terminal('published', [prior, outputDescriptor]),
    artifacts: ordered([prior, outputDescriptor]),
  });
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_CONSUMED_SCHEMA);
});

test.each(['missing', 'changed'])(
  'published inventory refuses %s unchanged prior artifact',
  async (mode) => {
    const prior = descriptor('turn-001.json', 'turn', inputBytes);
    const artifacts =
      mode === 'missing'
        ? [outputDescriptor]
        : [outputDescriptor, { ...prior, sha256: 'd'.repeat(64) }];
    const state = setup([
      prepareFrame('seal', [], [prior]),
      readyFrame(),
      resultFrame('published', artifacts),
    ]);
    await expect(state.run()).rejects.toThrow('inventory differs');
    expect(
      state.writes.some((frame) => frame.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
    ).toBe(false);
  }
);

test.each(['count', 'aggregate'])(
  'output %s limit refuses before copying any output bytes',
  async (limit) => {
    const shared = Buffer.alloc(limit === 'count' ? 1 : 65536);
    const count =
      limit === 'count'
        ? wire.MAX_PUBLICATION_ARTIFACTS + 1
        : wire.MAX_PUBLICATION_TOTAL_BYTES / shared.length + 1;
    const preparation = {
      disposition: 'ready',
      removals: [],
      artifacts: Array.from({ length: count }, (_unused, index) => ({
        name: `turn-${String(index + 1).padStart(3, '0')}.json`,
        role: 'turn',
        bytes: shared,
      })),
    };
    const state = setup([prepareFrame('projection', []), readyFrame('projection')]);
    const original = Buffer.from;
    let copies = 0;
    const spy = jest.spyOn(Buffer, 'from').mockImplementation((value, ...args) => {
      if (value === shared) {
        copies++;
        throw Error('copy before output limits');
      }
      return original(value, ...args);
    });
    try {
      await expect(state.run(async () => preparation, ['projection', 'render'])).rejects.toThrow(
        /inventory|byte bound/
      );
      expect(copies).toBe(0);
      expect(state.writes).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  }
);

test('lost terminal consumption delivery throws while retaining no local success', async () => {
  const state = setup(sealFrames(), {
    failWrite: (frame) => frame.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA,
  });
  await expect(state.run()).rejects.toThrow('controlled delivery loss');
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_READY_SCHEMA);
});

test('projection then render retain prior bytes, apply removals and chunk bounded output', async () => {
  const projection = Buffer.from('{"events":[]}\n');
  const rendered = Buffer.alloc(wire.MAX_PUBLICATION_CHUNK_BYTES + 1, 120);
  const prior = descriptor('turn-001.json', 'turn', inputBytes);
  const index = descriptor('session-index.json', 'index', rendered);
  const projectionDescriptor = descriptor('store-projection.jsonl', 'projection', projection);
  const state = setup([
    prepareFrame('projection', [], [prior]),
    readyFrame('projection'),
    prepareFrame('render', [], [prior]),
    readyFrame('render'),
    resultFrame('published', [projectionDescriptor, index]),
  ]);
  const phases = [];
  const receipt = await state.run(
    async (input) => {
      phases.push(input.kind);
      return input.kind === 'projection'
        ? {
            disposition: 'ready',
            artifacts: [{ name: projectionDescriptor.name, role: 'projection', bytes: projection }],
            removals: [],
          }
        : {
            disposition: 'ready',
            artifacts: [{ name: index.name, role: 'index', bytes: rendered }],
            removals: [prior.name],
          };
    },
    ['projection', 'render']
  );
  expect(phases).toEqual(['projection', 'render']);
  expect(receipt.artifacts).toEqual(ordered([projectionDescriptor, index]));
  const chunks = state.writes.filter(
    (frame) => frame.schema === wire.SESSION_PUBLICATION_CHUNK_SCHEMA && frame.kind === 'render'
  );
  expect(chunks.map((frame) => frame.offset)).toEqual([0, wire.MAX_PUBLICATION_CHUNK_BYTES]);
  expect(chunks.map((frame) => Buffer.from(frame.base64, 'base64').length)).toEqual([
    wire.MAX_PUBLICATION_CHUNK_BYTES,
    1,
  ]);
  expect(Buffer.concat(chunks.map((frame) => Buffer.from(frame.base64, 'base64')))).toEqual(
    rendered
  );
  expect(state.writes.at(-1)).toMatchObject({
    schema: wire.SESSION_PUBLICATION_CONSUMED_SCHEMA,
    terminalDigest: terminal('published', [projectionDescriptor, index]),
  });
});

test('a second preparation cannot substitute a different prior inventory', async () => {
  const prior = descriptor('turn-001.json', 'turn', inputBytes);
  const projection = Buffer.from('{}');
  const state = setup([
    prepareFrame('projection', [], [prior]),
    readyFrame('projection'),
    prepareFrame('render', [], [{ ...prior, sha256: 'd'.repeat(64) }]),
  ]);
  const prepare = jest.fn(async () => ({
    disposition: 'ready',
    artifacts: [{ name: 'store-projection.jsonl', role: 'projection', bytes: projection }],
    removals: [],
  }));
  await expect(state.run(prepare, ['projection', 'render'])).rejects.toThrow('inventory changed');
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_READY_SCHEMA);
});

test.each(['projection', 'seal,render', 'render,projection'])(
  'partial or reordered phase sequence %s is unavailable',
  async (sequence) => {
    const state = setup([]);
    await expect(state.run(async () => readyPreparation(), sequence.split(','))).rejects.toThrow(
      'Invalid publication continuation'
    );
    expect(state.reads).toEqual([]);
    expect(state.writes).toEqual([]);
  }
);

test('cancellation during preparation emits no prepared bytes or consumption', async () => {
  const state = setup(sealFrames()),
    cancelled = Error('cancelled preparation');
  await expect(
    state.run(async () => {
      state.controller.abort(cancelled);
      return readyPreparation();
    })
  ).rejects.toBe(cancelled);
  expect(state.writes).toEqual([]);
});

test('ordinary seal port has one attempt and a fresh correlated token', async () => {
  const state = setup([resultFrame('not_published', [])], { dynamicToken: true });
  const port = createNativeSessionSealPort(request, state.transport, state.controller.signal);
  const consumed = jest.fn(async () => {});
  const receipt = await port.seal(
    canonicalRoot,
    'session-one',
    async () => readyPreparation(),
    consumed
  );
  expect(receipt).toEqual({
    status: 'not_published',
    terminalDigest: terminal('not_published', [], state.writes[0].token),
    artifacts: [],
  });
  expect(state.writes[0]).toMatchObject({
    schema: wire.SESSION_SEAL_REQUEST_SCHEMA,
    id: request.id,
    runtimeDigest: request.runtimeDigest,
    canonicalRoot,
  });
  expect(state.writes[0].token).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.writes[1].token).toBe(state.writes[0].token);
  expect(consumed).toHaveBeenCalledWith(expect.objectContaining({ status: 'not_published' }));
  await expect(
    port.seal(canonicalRoot, 'session-one', async () => readyPreparation(), consumed)
  ).rejects.toThrow('repeated');
  expect(state.writes).toHaveLength(2);
});

test.each([{ event: 'stop' }, { configuration: 'project' }, { sessionPublication: undefined }])(
  'seal port requires the original SessionEnd capability %j',
  (override) => {
    const state = setup([]);
    expect(() =>
      createNativeSessionSealPort(
        { ...request, ...override },
        state.transport,
        state.controller.signal
      )
    ).toThrow('unavailable');
    expect(state.writes).toEqual([]);
  }
);

test('receipt parsing cannot acknowledge a generation absent from the ordinary filesystem', async () => {
  const consume = jest.fn();
  const state = setup(sealFrames(), { publish: false, consume });
  await expect(state.run()).rejects.toThrow();
  expect(consume).not.toHaveBeenCalled();
  expect(
    state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
});

test('actual semantic log use completes before CONSUMED is sent', async () => {
  let entered, release;
  const enteredConsumer = new Promise((accept) => {
    entered = accept;
  });
  const consumerMayFinish = new Promise((accept) => {
    release = accept;
  });
  let used;
  const state = setup(sealFrames(), {
    consume: async (outcome) => {
      expect(outcome.status).toBe('published');
      used = readCommittedSessionLog(outcome.session);
      entered();
      await consumerMayFinish;
    },
  });
  const pending = state.run();
  await enteredConsumer;
  expect(used.metadata.json).toBe(outputBytes.toString());
  expect(
    state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
  release();
  await expect(pending).resolves.toMatchObject({ status: 'published' });
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_CONSUMED_SCHEMA);
});

test.each(['consumer', 'marker', 'artifact', 'cancelled'])(
  '%s failure after independent read never acknowledges or falls back',
  async (failure) => {
    const cause = new Error('ordinary consumer failed');
    let used = false;
    const state = setup(sealFrames(), {
      consume: async (outcome) => {
        used = readCommittedSessionLog(outcome.session).metadata.json === outputBytes.toString();
        if (failure === 'consumer') throw cause;
        if (failure === 'cancelled') state.controller.abort(cause);
        if (failure === 'marker')
          fs.appendFileSync(path.join(sessionDirectory, '.session-publication.json'), ' ');
        if (failure === 'artifact') {
          const replacement = path.join(sessionDirectory, 'replacement');
          fs.writeFileSync(replacement, outputBytes, { mode: 0o600 });
          fs.renameSync(replacement, path.join(sessionDirectory, '.meta.json'));
        }
      },
    });
    await expect(state.run()).rejects.toThrow();
    expect(used).toBe(true);
    expect(
      state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
    ).toBe(false);
  }
);

test('uncertain publication cannot invoke an outcome consumer or send CONSUMED', async () => {
  const frames = sealFrames();
  frames.at(-1).status = 'publication_uncertain';
  const consume = jest.fn();
  const state = setup(frames, { consume });
  await expect(state.run()).rejects.toThrow('uncertain');
  expect(consume).not.toHaveBeenCalled();
  expect(
    state.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
});

test('wrong original session and forged terminal digest refuse consumption', async () => {
  const foreign = sealFrames();
  foreign[0].snapshot.sessionId = 'foreign';
  const first = setup(foreign);
  await expect(first.run()).rejects.toThrow('snapshot');
  expect(first.writes).toEqual([]);
  const forged = sealFrames();
  forged.at(-1).terminalDigest = '0'.repeat(64);
  const second = setup(forged);
  await expect(second.run()).rejects.toThrow('terminal digest');
  expect(second.consumptions).toEqual([]);
  expect(
    second.writes.some((item) => item.schema === wire.SESSION_PUBLICATION_CONSUMED_SCHEMA)
  ).toBe(false);
});

test('non-store render publishes and consumes a semantic log without fabricating a projection', async () => {
  const bytes = Buffer.from('{"session_id":"session-one","turn_count":0}');
  const index = descriptor('session-index.json', 'index', bytes);
  let used;
  const state = setup(
    [prepareFrame('render', []), readyFrame('render'), resultFrame('published', [index])],
    {
      consume: async (outcome) => {
        used = readCommittedSessionLog(outcome.session);
      },
    }
  );
  await expect(
    state.run(
      async (input) => {
        expect(input.kind).toBe('render');
        expect(input.files).toEqual([]);
        return {
          disposition: 'ready',
          artifacts: [{ name: index.name, role: index.role, bytes }],
          removals: [],
        };
      },
      ['render']
    )
  ).resolves.toMatchObject({ status: 'published', artifacts: [index] });
  expect(used.index.json).toBe(bytes.toString());
  expect(used.projectionJsonl).toBeUndefined();
  expect(state.writes.filter((item) => item.kind).every((item) => item.kind === 'render')).toBe(
    true
  );
  expect(state.writes.at(-1).schema).toBe(wire.SESSION_PUBLICATION_CONSUMED_SCHEMA);
});
