const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { AbortController } = globalThis;
const { createNativeTranscriptStorePort } = require('../../dist/runtime/transcript-store-client');
const { publishNativeTranscriptStore } = require('../../dist/runtime/session-store-publication');
const { getMember } = require('../../dist/transcripts/lossless-json');
const { StoreProjectionContractError } = require('../../dist/transcripts/store-projection');
const {
  STORE_JSON_PROFILE,
  STORE_JSON_UNLIMITED_PROFILE,
  StoreJsonError,
} = require('../../dist/transcripts/store-json');
const {
  TRANSCRIPT_STORE_CAPABILITY,
  SESSION_PUBLICATION_CAPABILITY,
  RuntimeProtocolError,
} = require('../../dist/runtime/protocol');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptor = (name, role, bytes) => ({
  name,
  role,
  byteLength: bytes.length,
  sha256: sha(bytes),
});
const ordered = (items) =>
  [...items].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const prefix = 'caws.runtime.session-publication.';
const storePrefix = 'caws.runtime.transcript-store.';
const limits = {
  json: {
    maxInputBytes: 65536,
    maxDecodedCodepoints: 65536,
    maxNodes: 10000,
    maxDepth: 128,
    maxStringCodepoints: 65536,
    maxNumberChars: 4301,
  },
  maxRows: 100,
  maxEvents: 100,
  maxCodepoints: 65536,
};
let canonicalRoot, directory;
beforeEach(() => {
  canonicalRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'store-publication-')));
  directory = path.join(canonicalRoot, '.caws/sessions/original-session');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
});
afterEach(() => fs.rmSync(canonicalRoot, { recursive: true, force: true }));

async function refusal(promise, ErrorType, message) {
  const error = await promise.then(
    () => undefined,
    (error) => error
  );
  expect(error).toBeInstanceOf(ErrorType);
  expect(error.message).toBe(message);
  return error;
}

async function unsettledAcquisition(promise, ErrorType, message) {
  const error = await refusal(
    promise,
    AggregateError,
    'Store reconstruction and native cleanup both failed'
  );
  expect(error.errors).toHaveLength(2);
  expect(error.errors[0]).toBeInstanceOf(ErrorType);
  expect(error.errors[0].message).toBe(message);
  expect(error.errors[1]).toBeInstanceOf(RuntimeProtocolError);
  expect(error.errors[1]).toMatchObject({
    message: 'Native transcript store cleanup remains unsettled',
    sourceClosed: false,
    cause: error.errors[0],
  });
  return error;
}

// This transport emits the native wire shapes but does not execute SQLite or
// the native publisher. Its actual files exercise the independent ordinary
// current-generation reader, rather than substituting a receipt-only consumer.
function setup(options = {}) {
  const controller = new AbortController();
  const request = {
    id: 'store-publication',
    runtimeDigest: 'a'.repeat(64),
    surface: options.surface || 'opencode',
    event: 'stop',
    configuration: 'system',
    sessionStore: TRANSCRIPT_STORE_CAPABILITY,
    sessionPublication: SESSION_PUBLICATION_CAPABILITY,
    deadlineEpochMs: Date.now() + 5000,
  };
  const text = (value) => ({ storageClass: 'text', base64: Buffer.from(value).toString('base64') });
  const cells = [
    text('m'),
    text(options.messageJson || '{"role":"user"}'),
    text('p'),
    text('{"type":"text","text":"hello"}'),
    { storageClass: 'integer', decimal: '0' },
  ];
  const charge = cells.reduce(
    (sum, cell) =>
      sum + (cell.storageClass === 'integer' ? 8 : Buffer.from(cell.base64, 'base64').length),
    0
  );
  const closed = {
    schema: storePrefix + 'closed.v1',
    closed: true,
    end: 'exhausted',
    failure: null,
    cleanup: {
      progressUnregistered: true,
      busyUnregistered: 'Succeeded',
      finalized: 'Succeeded',
      rollback: 'Succeeded',
    },
    metrics: { rowsCopied: 1, rowsDelivered: 1, cellBytes: charge },
  };
  const queue = [
    { schema: storePrefix + 'row.v1', ordinal: 1, cells },
    {
      schema: storePrefix + 'utc.v1',
      ordinal: 1,
      calendar: {
        kind: 'utc_calendar',
        seconds: '0',
        tmYear: 70,
        tmMon: 0,
        tmMday: 1,
        tmHour: 0,
        tmMin: 0,
        tmSec: 0,
      },
    },
    options.closure === 'lost' ? new Error('lost CLOSED') : { ...closed, ...options.closure },
  ];
  const writes = [],
    artifacts = new Map();
  let correlation,
    reading = false,
    reads = 0,
    aborted = false;
  const bind = (frame) => ({ ...correlation, ...frame });
  const prepare = (kind, files = []) => ({
    schema: prefix + 'prepare.v1',
    kind,
    snapshot: {
      observationId: 'original-observation',
      inputDigest: 'b'.repeat(64),
      sessionId: 'original-session',
      reason: 'stop',
      endedAt: '2026-10-22T00:00:00Z',
      files,
      priorInventory: [],
    },
  });
  const ready = (kind) => ({ schema: prefix + 'ready.v1', kind, direction: 'inputs' });
  queue.push(prepare('projection'), ready('projection'));
  const transport = {
    async read() {
      if (reading) throw new Error('second transport reader');
      reading = true;
      reads++;
      try {
        const frame = queue.shift();
        if (!frame) throw new Error('controlled EOF');
        if (frame instanceof Error) throw frame;
        if (options.eofBefore && options.eofBefore(frame)) throw new Error('controlled EOF');
        let value = frame.schema.startsWith(prefix)
          ? bind(frame)
          : {
              id: correlation.id,
              runtimeDigest: correlation.runtimeDigest,
              token: correlation.token,
              ...frame,
            };
        if (options.frame) value = options.frame(value);
        return Buffer.from(JSON.stringify(value));
      } finally {
        reading = false;
      }
    },
    async write(frame) {
      writes.push(frame);
      if (frame.schema === storePrefix + 'request.v1') {
        correlation = {
          id: frame.id,
          runtimeDigest: frame.runtimeDigest,
          token: frame.token,
          attempt: 'original-attempt',
        };
      } else if (frame.schema === prefix + 'prepared.v1' && frame.disposition === 'aborted') {
        aborted = true;
      } else if (frame.schema === prefix + 'chunk.v1') {
        const prior = artifacts.get(frame.name) || Buffer.alloc(0);
        expect(frame.offset).toBe(prior.length);
        artifacts.set(frame.name, Buffer.concat([prior, Buffer.from(frame.base64, 'base64')]));
      } else if (frame.schema === prefix + 'ready.v1' && frame.direction === 'prepared') {
        if (aborted) {
          queue.push({
            schema: prefix + 'result.v1',
            status: 'not_published',
            terminalDigest: sha(Buffer.from(JSON.stringify([correlation, 'not_published']))),
            artifacts: [],
          });
        } else if (frame.kind === 'projection') {
          let bytes = artifacts.get('store-projection.jsonl');
          if (options.staleProjection)
            bytes = Buffer.from(
              '{"type":"user","message":{"content":[{"type":"text","text":"stale"}]}}\n'
            );
          queue.push(
            prepare('render', [descriptor('store-projection.jsonl', 'projection', bytes)])
          );
          queue.push({
            schema: prefix + 'inputs.v1',
            kind: 'render',
            name: 'store-projection.jsonl',
            offset: 0,
            base64: bytes.toString('base64'),
          });
          queue.push(ready('render'));
        } else {
          const inventory = ordered(
            [...artifacts].map(([name, bytes]) =>
              descriptor(
                name,
                name === 'store-projection.jsonl'
                  ? 'projection'
                  : name === 'session-index.json'
                    ? 'index'
                    : 'turn',
                bytes
              )
            )
          );
          const terminalDigest = sha(
            Buffer.from(JSON.stringify([correlation, 'published', inventory]))
          );
          for (const [name, bytes] of artifacts)
            fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
          fs.writeFileSync(
            path.join(directory, '.session-publication.json'),
            JSON.stringify({
              schema: 'caws.session.publication.v1',
              canonicalRoot,
              sessionId: 'original-session',
              correlation,
              terminalDigest,
              artifacts: inventory,
            }),
            { mode: 0o600 }
          );
          if (options.beforeResult) options.beforeResult({ directory, artifacts, correlation });
          queue.push({
            schema: prefix + 'result.v1',
            status: 'published',
            terminalDigest,
            artifacts: inventory,
          });
        }
      }
    },
  };
  const port = createNativeTranscriptStorePort(request, transport, controller.signal);
  const render = jest.fn(async (input) => {
    expect(input.kind).toBe('render');
    const event = JSON.parse(Buffer.from(input.bytes('store-projection.jsonl')).toString('utf8'));
    expect(event.type).toBe('user');
    expect(event.message.content[0].text).toBe('hello');
    expect(writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
    if (options.renderFailure) throw options.renderFailure;
    if (options.abortRender)
      return { disposition: 'aborted', diagnostic: 'explicit renderer refusal' };
    const result = {
      disposition: 'ready',
      removals: [],
      artifacts: [
        {
          name: 'turn-001.json',
          role: 'turn',
          bytes: Buffer.from(
            '{"user":"' +
              event.message.content[0].text +
              '","usage":{"input_tokens":9007199254740993}}'
          ),
        },
        {
          name: 'session-index.json',
          role: 'index',
          bytes: Buffer.from('{"session_id":"original-session","turns":[1]}'),
        },
      ],
    };
    return options.renderPreparation ? options.renderPreparation(result) : result;
  });
  const published = jest.fn(async (log) => {
    expect(log.canonicalRoot).toBe(canonicalRoot);
    expect(log.sessionId).toBe('original-session');
    expect(log.turns).toHaveLength(1);
    expect(getMember(log.turns[0].value, 'user')).toBe('hello');
    expect(getMember(getMember(log.turns[0].value, 'usage'), 'input_tokens').lexeme).toBe(
      '9007199254740993'
    );
    expect(log.projectionJsonl).toContain('hello');
    expect(writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
    if (options.consume) await options.consume(log, controller);
  });
  const notPublished = jest.fn();
  const run = (overrides = {}) =>
    publishNativeTranscriptStore({
      port,
      canonicalRoot,
      sessionId: 'original-session',
      limits,
      // Explicit reference profile for this synthetic fixture, not production qualification.
      sqlProfile: STORE_JSON_PROFILE,
      maximumProjectionBytes: 65536,
      prepareRender: render,
      consumer: { published, notPublished },
      ...overrides,
    });
  return {
    run,
    port,
    request,
    controller,
    writes,
    render,
    published,
    notPublished,
    get reads() {
      return reads;
    },
  };
}

test.each(['opencode', 'zcode'])(
  'exhausted %s projection is rendered and independently consumed before same-token ACK',
  async (surface) => {
    const state = setup({ surface });
    // Mutating the caller object cannot replace the factory-captured identity.
    state.request.id = 'foreign';
    state.request.surface = 'claude-code';
    const receipt = await state.run();
    expect(receipt.status).toBe('published');
    expect(state.render).toHaveBeenCalledTimes(1);
    expect(state.published).toHaveBeenCalledTimes(1);
    expect(state.notPublished).not.toHaveBeenCalled();
    expect(state.writes.at(-1).schema).toBe(prefix + 'consumed.v1');
    expect(new Set(state.writes.map((item) => item.token)).size).toBe(1);
    expect(state.writes.every((item) => item.id === 'store-publication')).toBe(true);
    expect(state.port.surface).toBe(surface);
    const originalWrites = state.writes.length;
    await expect(state.run()).rejects.toThrow('already attempted');
    expect(state.writes).toHaveLength(originalWrites);
  }
);

test.each([
  ['lost', 'lost', Error, 'lost CLOSED', true],
  ['stopped', { end: 'stopped' }, RuntimeProtocolError, 'Inconsistent store completion', false],
  [
    'unconfirmed',
    { closed: false },
    RuntimeProtocolError,
    'Store cleanup remains unconfirmed',
    true,
  ],
  [
    'metrics',
    { metrics: { rowsCopied: 1, rowsDelivered: 1, cellBytes: 0 } },
    RuntimeProtocolError,
    'Invalid store completion metrics',
    true,
  ],
])(
  'unusable CLOSED %s prevents projection/render/publication',
  async (_label, closure, ErrorType, message, unsettled) => {
    const state = setup({ closure });
    if (unsettled) await unsettledAcquisition(state.run(), ErrorType, message);
    else await refusal(state.run(), ErrorType, message);
    expect(state.render).not.toHaveBeenCalled();
    expect(state.published).not.toHaveBeenCalled();
    expect(state.writes.every((item) => item.schema.startsWith(storePrefix))).toBe(true);
  }
);

test.each(['token', 'id', 'attempt', 'session', 'order', 'chunk'])(
  'hostile publication %s cannot reach render or acknowledgement',
  async (kind) => {
    const state = setup({
      frame(frame) {
        if (!frame.schema.startsWith(prefix)) return frame;
        if (kind === 'token') return { ...frame, token: 'foreign-token' };
        if (kind === 'id') return { ...frame, id: 'foreign-id' };
        if (kind === 'session' && frame.snapshot)
          return { ...frame, snapshot: { ...frame.snapshot, sessionId: 'foreign-session' } };
        if (kind === 'order' && frame.kind === 'projection') return { ...frame, kind: 'render' };
        if (kind === 'attempt' && frame.kind === 'render')
          return { ...frame, attempt: 'foreign-attempt' };
        if (kind === 'chunk' && frame.schema === prefix + 'inputs.v1')
          return { ...frame, schema: prefix + 'chunk.v1' };
        return frame;
      },
    });
    const message = {
      token: 'Mismatched publication correlation',
      id: 'Mismatched publication correlation',
      attempt: 'Publication attempt changed',
      session: 'Invalid native publication snapshot',
      order: 'Unexpected publication preparation phase',
      chunk: 'Invalid native publication chunk',
    }[kind];
    await refusal(state.run(), RuntimeProtocolError, message);
    expect(state.render).not.toHaveBeenCalled();
    expect(state.published).not.toHaveBeenCalled();
    expect(state.writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
  }
);

test('self-consistent but stale Render projection is refused before explicit renderer', async () => {
  const state = setup({ staleProjection: true });
  await refusal(
    state.run(),
    RuntimeProtocolError,
    'Native render input differs from the exhausted store projection'
  );
  expect(state.render).not.toHaveBeenCalled();
  expect(state.published).not.toHaveBeenCalled();
  expect(
    state.writes.filter((item) => item.schema === prefix + 'prepared.v1').map((item) => item.kind)
  ).toEqual(['projection']);
});

test('transport EOF is distinct from the malformed-frame refusal and emits no prepared output', async () => {
  const state = setup({
    eofBefore: (frame) => frame.schema === prefix + 'ready.v1' && frame.kind === 'projection',
  });
  const error = await refusal(state.run(), Error, 'controlled EOF');
  expect(error.constructor).toBe(Error);
  expect(error).not.toBeInstanceOf(RuntimeProtocolError);
  expect(state.render).not.toHaveBeenCalled();
  expect(state.published).not.toHaveBeenCalled();
  expect(state.writes.every((item) => item.schema.startsWith(storePrefix))).toBe(true);
});

test.each(['wrong-name', 'wrong-role', 'duplicate'])(
  'renderer %s output is refused before Render PREPARED or ACK',
  async (fault) => {
    const state = setup({
      renderPreparation(result) {
        if (fault === 'wrong-name') result.artifacts[0].name = '.meta.json';
        if (fault === 'wrong-role') result.artifacts[0].role = 'projection';
        if (fault === 'duplicate') result.artifacts.push(result.artifacts[0]);
        return result;
      },
    });
    await refusal(
      state.run(),
      RuntimeProtocolError,
      fault === 'duplicate' ? 'Duplicate publication name' : 'Invalid prepared publication targets'
    );
    expect(state.render).toHaveBeenCalledTimes(1);
    expect(state.published).not.toHaveBeenCalled();
    expect(
      state.writes.filter((item) => item.schema === prefix + 'prepared.v1').map((item) => item.kind)
    ).toEqual(['projection']);
    expect(state.writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
  }
);

test('renderer exception retains the original failure and emits no Render PREPARED or ACK', async () => {
  const failure = new Error('selected renderer failed');
  const state = setup({ renderFailure: failure });
  await expect(state.run()).rejects.toBe(failure);
  expect(state.render).toHaveBeenCalledTimes(1);
  expect(state.published).not.toHaveBeenCalled();
  expect(
    state.writes.filter((item) => item.schema === prefix + 'prepared.v1').map((item) => item.kind)
  ).toEqual(['projection']);
  expect(state.writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
});

test.each(['missing', 'changed', 'marker', 'extra'])(
  'ordinary reader refuses %s current generation without ACK',
  async (fault) => {
    const state = setup({
      beforeResult({ directory }) {
        const turn = path.join(directory, 'turn-001.json');
        const marker = path.join(directory, '.session-publication.json');
        if (fault === 'missing') fs.unlinkSync(turn);
        if (fault === 'changed') fs.writeFileSync(turn, '{"user":"stale"}');
        if (fault === 'extra')
          fs.writeFileSync(path.join(directory, 'turn-002.json'), '{}', { mode: 0o600 });
        if (fault === 'marker') {
          const value = JSON.parse(fs.readFileSync(marker, 'utf8'));
          value.correlation.id = 'stale-original';
          fs.writeFileSync(marker, JSON.stringify(value));
        }
      },
    });
    const message =
      fault === 'marker'
        ? 'Committed session marker differs from admitted current selection'
        : fault === 'changed'
          ? 'Committed session artifact bytes differ'
          : 'Committed session current inventory differs';
    await refusal(state.run(), RuntimeProtocolError, message);
    expect(state.render).toHaveBeenCalledTimes(1);
    expect(state.published).not.toHaveBeenCalled();
    expect(state.writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
  }
);

test.each(['failure', 'changed', 'cancelled'])(
  'consumer %s cannot acknowledge validated bytes',
  async (fault) => {
    const failure = new Error('ordinary consumer failed');
    const state = setup({
      async consume(_log, controller) {
        if (fault === 'failure') throw failure;
        if (fault === 'changed') {
          const turn = path.join(directory, 'turn-001.json');
          const original = fs.readFileSync(turn, 'utf8');
          fs.writeFileSync(turn, original.replace('hello', 'jello'));
          expect(fs.statSync(turn).size).toBe(Buffer.byteLength(original));
        }
        if (fault === 'cancelled') controller.abort(failure);
      },
    });
    if (fault === 'changed')
      await refusal(
        state.run(),
        RuntimeProtocolError,
        'Committed session artifact replaced or changed'
      );
    else await expect(state.run()).rejects.toBe(failure);
    expect(state.published).toHaveBeenCalledTimes(1);
    expect(state.notPublished).not.toHaveBeenCalled();
    expect(state.writes.some((item) => item.schema === prefix + 'consumed.v1')).toBe(false);
  }
);

test('cancelled acquisition never emits publication preparation', async () => {
  const state = setup();
  const reason = new Error('original cancelled');
  state.controller.abort(reason);
  const error = await unsettledAcquisition(state.run(), Error, 'original cancelled');
  expect(error.errors[0]).toBe(reason);
  expect(state.writes).toEqual([]);
  expect(state.render).not.toHaveBeenCalled();
  expect(state.published).not.toHaveBeenCalled();
});

test('explicit renderer refusal consumes only definitive non-publication without ordinary success', async () => {
  const state = setup({ abortRender: true });
  await expect(state.run()).resolves.toMatchObject({ status: 'not_published', artifacts: [] });
  expect(state.render).toHaveBeenCalledTimes(1);
  expect(state.published).not.toHaveBeenCalled();
  expect(state.notPublished).toHaveBeenCalledWith(
    expect.objectContaining({ status: 'not_published' })
  );
  expect(state.writes.at(-1).schema).toBe(prefix + 'consumed.v1');
  expect(fs.readdirSync(directory)).toEqual([]);
});

test('projection serialization failure after exhausted closure emits no publication bytes', async () => {
  const state = setup();
  const error = await refusal(
    state.run({ maximumProjectionBytes: 0 }),
    StoreProjectionContractError,
    'resource:output_bytes'
  );
  expect(error).toMatchObject({ category: 'resource', code: 'output_bytes' });
  expect(() => state.port.assertClosed()).not.toThrow();
  expect(state.writes.map((item) => item.schema)).toEqual([
    storePrefix + 'request.v1',
    storePrefix + 'control.v1',
    storePrefix + 'control.v1',
  ]);
  expect(state.render).not.toHaveBeenCalled();
  expect(state.published).not.toHaveBeenCalled();
});

test.each([undefined, null])(
  'renderer must be supplied before acquisition: %s',
  async (prepareRender) => {
    const state = setup();
    await expect(state.run({ prepareRender })).rejects.toThrow(
      'Invalid native store publication adapter input'
    );
    expect(state.writes).toEqual([]);
    expect(state.render).not.toHaveBeenCalled();
  }
);

test('publication forwards explicit SQL profile independently of renderer preparation', async () => {
  const state = setup({ messageJson: '{"role":"user","ignored":' + '7'.repeat(4301) + '}' });
  const result = await state.run({ sqlProfile: STORE_JSON_UNLIMITED_PROFILE });
  expect(result.status).toBe('published');
  expect(state.render).toHaveBeenCalledTimes(1);
  expect(state.published).toHaveBeenCalledTimes(1);
});

test.each(['omitted', 'undefined', 'null'])(
  '%s SQL profile is refused before observing the port or consumer',
  async (kind) => {
    const state = setup();
    const observed = jest.fn((name) => {
      throw new Error(`Publication observed ${name} before profile validation`);
    });
    const options = {
      get port() {
        observed('port');
        return state.port;
      },
      canonicalRoot,
      sessionId: 'original-session',
      limits,
      maximumProjectionBytes: 65536,
      prepareRender: state.render,
      get consumer() {
        observed('consumer');
        return { published: state.published, notPublished: state.notPublished };
      },
    };
    // The omitted case is an actual JS options object with no sqlProfile key.
    if (kind !== 'omitted') options.sqlProfile = kind === 'null' ? null : undefined;
    const error = await refusal(
      publishNativeTranscriptStore(options),
      StoreJsonError,
      'request:unsupported_profile at request 0'
    );
    expect(error).toMatchObject({ category: 'request', code: 'unsupported_profile' });
    expect(observed).not.toHaveBeenCalled();
    expect(state.reads).toBe(0);
    expect(state.writes).toEqual([]);
    expect(state.render).not.toHaveBeenCalled();
    expect(state.published).not.toHaveBeenCalled();
    expect(state.notPublished).not.toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([]);
  }
);

test('unsupported SQL profile is refused before native acquisition or renderer callbacks', async () => {
  const state = setup();
  await expect(state.run({ sqlProfile: 'unsupported-profile' })).rejects.toBeInstanceOf(
    StoreJsonError
  );
  expect(state.writes).toHaveLength(0);
  expect(state.render).not.toHaveBeenCalled();
  expect(state.published).not.toHaveBeenCalled();
});
