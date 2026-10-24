const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { executeNativeStopPublication } = require('../../dist/runtime/session-store-publication');
const { consumeCommittedSession } = require('../../dist/runtime/committed-session-reader');
const {
  sessionPublicationMarkerBytes,
  sessionPublicationTerminalDigest,
} = require('../../dist/runtime/session-publication-wire');
const {
  STORE_JSON_PROFILE,
  STORE_JSON_UNLIMITED_PROFILE,
} = require('../../dist/transcripts/store-json');
const { RENDER_JSON_4300 } = require('../../dist/transcripts/render-reader');
const { jsonNumber } = require('../../dist/transcripts/lossless-json');
const {
  LOCAL_CALENDAR_REPLY,
  RENDERER_CALENDAR_PROFILE,
} = require('../../dist/transcripts/renderer-calendar');

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const descriptor = (name, role, bytes) => ({
  name,
  role,
  byteLength: bytes.length,
  sha256: sha(bytes),
});
let root, retainedStates;
beforeEach(() => {
  const parent = process.env.CAWS_TEST_ARTIFACT_DIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'ordinary-stop-publication-')));
  retainedStates = [];
});
afterEach(() => {
  if (!process.env.CAWS_TEST_ARTIFACT_DIR) {
    fs.rmSync(root, { recursive: true, force: true });
    return;
  }
  const files = {};
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile())
        files[path.relative(root, file)] = { size: stat.size, sha256: sha(fs.readFileSync(file)) };
    }
  };
  visit(root);
  fs.writeFileSync(
    path.join(root, 'scenario.json'),
    JSON.stringify(
      {
        test: expect.getState().currentTestName,
        scope:
          'Fixture SQL and native observation ports; actual renderer, filesystem publication bytes and reopened reader. No native admission or installed invocation.',
        states: retainedStates.map((read) => read()),
        files,
      },
      null,
      2
    )
  );
});

// Fixed SQL/provider and observation fixtures exercise the real reconstruction,
// renderer and reopened ordinary reader. They supply no native admission proof.
function setup({
  metadata,
  changeMetadata = false,
  cleanupError,
  operationError,
  beforeConsume,
  forgePreparedTurn = false,
  gitError,
} = {}) {
  const directory = path.join(root, '.caws/sessions/s');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const correlation = {
    id: 'original-stop',
    runtimeDigest: 'a'.repeat(64),
    token: 'original-token',
    attempt: 'original-attempt',
  };
  const binding = {
    ...correlation,
    observationId: 'render-observation',
    inputDigest: 'b'.repeat(64),
  };
  const calendarContext = {
    originalPid: process.pid,
    tz: { kind: 'present', value: 'UTC0' },
    tzdir: { kind: 'absent' },
  };
  const metadataBytes = metadata === undefined ? undefined : Buffer.from(metadata);
  const priorInventory = metadataBytes ? [descriptor('.meta.json', 'metadata', metadataBytes)] : [];
  const captured = new Map(metadataBytes ? [['.meta.json', metadataBytes]] : []);
  const observations = {
    binding,
    git: jest.fn(async () => {
      if (gitError) throw gitError;
      return {
        cwd: root,
        branch: 'observed-branch',
        headSha: 'observed-head',
        dirtyFiles: jsonNumber('7'),
      };
    }),
    calendarContext,
    calendar: {
      observe: jest.fn(async (request) => ({
        schema: LOCAL_CALENDAR_REPLY,
        profile: RENDERER_CALENDAR_PROFILE,
        id: request.id,
        runtimeDigest: request.runtimeDigest,
        token: request.token,
        sequence: request.sequence,
        context: calendarContext,
        results: request.seconds.map((seconds) => {
          const d = new Date(Number(seconds) * 1000);
          return {
            kind: 'local_calendar',
            seconds,
            tmYear: d.getUTCFullYear() - 1900,
            tmMon: d.getUTCMonth(),
            tmMday: d.getUTCDate(),
            tmHour: d.getUTCHours(),
            tmMin: d.getUTCMinutes(),
            tmSec: d.getUTCSeconds(),
          };
        }),
      })),
    },
  };
  const phases = [],
    outcome = jest.fn();
  let closed = false,
    consumed = false;
  const input = (kind, files) => ({
    kind,
    observationId: binding.observationId,
    inputDigest: binding.inputDigest,
    sessionId: 's',
    reason: 'stop',
    endedAt: '2026-01-01T00:00:00Z',
    priorInventory,
    files,
    observations,
    bytes(name) {
      return Buffer.from(captured.get(name));
    },
  });
  const port = {
    surface: 'opencode',
    rows: jest.fn(async function* () {
      if (operationError) throw operationError;
      const text = (s) => ({ storageClass: 'text', bytes: Buffer.from(s) });
      yield {
        ordinal: 1,
        cells: [
          text('m'),
          text('{"role":"user"}'),
          text('p'),
          text('{"type":"text","text":"actual SQL user"}'),
          { storageClass: 'integer', value: 0n },
        ],
      };
      closed = true;
    }),
    calendar: jest.fn(async (seconds) => ({
      kind: 'utc_calendar',
      seconds,
      tmYear: 70,
      tmMon: 0,
      tmMday: 1,
      tmHour: 0,
      tmMin: 0,
      tmSec: 0,
    })),
    assertClosed: jest.fn(() => {
      if (cleanupError) throw cleanupError;
      if (!closed) throw Error('fixture source not closed');
    }),
    continuePublication: jest.fn(async (options) => {
      expect(closed).toBe(true);
      expect(options.renderObservations).toBe(true);
      for (const kind of ['projection', 'render']) {
        phases.push(kind);
        if (kind === 'render' && changeMetadata)
          captured.set('.meta.json', Buffer.from('{"model":"changed"}'));
        const files = [...captured].map(([name, bytes]) =>
          descriptor(name, name === '.meta.json' ? 'metadata' : 'projection', bytes)
        );
        const preparation = await options.prepare(input(kind, files));
        if (preparation.disposition === 'aborted') {
          const receipt = {
            status: 'not_published',
            terminalDigest: sessionPublicationTerminalDigest(correlation, 'not_published'),
            artifacts: [],
          };
          await options.consume({ status: 'not_published', correlation, receipt });
          consumed = true;
          return receipt;
        }
        for (const item of preparation.artifacts) captured.set(item.name, Buffer.from(item.bytes));
        for (const name of preparation.removals) captured.delete(name);
      }
      if (forgePreparedTurn) {
        const original = captured.get('turn-001.json').toString('utf8');
        const changed = original.replace('actual SQL user', 'forged SQL user');
        expect(changed).not.toBe(original);
        captured.set('turn-001.json', Buffer.from(changed));
      }
      const artifacts = [...captured]
        .map(([name, bytes]) =>
          descriptor(
            name,
            name === '.meta.json'
              ? 'metadata'
              : name === 'store-projection.jsonl'
                ? 'projection'
                : name === 'session-index.json'
                  ? 'index'
                  : name.endsWith('.payloads.json')
                    ? 'spill'
                    : 'turn',
            bytes
          )
        )
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const terminalDigest = sessionPublicationTerminalDigest(correlation, 'published', artifacts);
      const selection = {
        canonicalRoot: root,
        sessionId: 's',
        correlation,
        terminalDigest,
        artifacts,
      };
      for (const [name, bytes] of captured)
        fs.writeFileSync(path.join(directory, name), bytes, { mode: 0o600 });
      fs.writeFileSync(
        path.join(directory, '.session-publication.json'),
        sessionPublicationMarkerBytes(selection),
        { mode: 0o600 }
      );
      await beforeConsume?.(directory);
      const receipt = { status: 'published', terminalDigest, artifacts };
      await consumeCommittedSession(
        selection,
        { signal: controller.signal, deadlineEpochMs },
        (session) => options.consume({ status: 'published', correlation, receipt, session })
      );
      consumed = true;
      return receipt;
    }),
  };
  const controller = new globalThis.AbortController(),
    deadlineEpochMs = Date.now() + 20_000;
  const options = {
    port,
    canonicalRoot: root,
    sessionId: 's',
    signal: controller.signal,
    deadlineEpochMs,
    sqlProfile: STORE_JSON_PROFILE,
    rendererProfile: RENDER_JSON_4300,
    storeLimits: {
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
    },
    rendererLimits: {
      maximumInputBytes: 1_000_000,
      maximumArtifactBytes: 1_000_000,
      maximumTotalArtifactBytes: 2_000_000,
      maximumArtifacts: 100,
    },
    maximumProjectionBytes: 65536,
    calendarLimits: { maximumTimestampBytes: 65536, maximumQueries: 1000 },
    sources: {
      transcriptPath: path.join(directory, '.transcript-projection.jsonl'),
      audit: { path: path.join(root, '.opencode/logs/audit.log'), presence: 'absent' },
      hookOutcomes: { path: path.join(directory, 'hook-events.jsonl'), presence: 'absent' },
      subagents: {
        claudeCandidate: { path: path.join(directory, 's/subagents'), kind: 'absent' },
        qwenCandidate: { path: path.join(root, '.caws/sessions/subagents/s'), kind: 'absent' },
      },
    },
    observe: outcome,
  };
  let result;
  retainedStates.push(() => ({
    phases,
    closed,
    consumed,
    result,
    outcomeCalls: outcome.mock.calls,
    rowsCalls: port.rows.mock.calls.length,
    continuationCalls: port.continuePublication.mock.calls.length,
    gitCalls: observations.git.mock.calls.length,
    calendarCalls: observations.calendar.observe.mock.calls.length,
  }));
  return {
    port,
    observations,
    outcome,
    phases,
    directory,
    options,
    run: async (extra) => {
      try {
        const value = await executeNativeStopPublication({ ...options, ...extra });
        result = { kind: 'returned', exitCode: value.exitCode };
        return value;
      } catch (error) {
        result = {
          kind: 'threw',
          name: error?.name,
          message: error?.message,
          errors:
            error instanceof AggregateError
              ? error.errors.map((item) => ({ name: item?.name, message: item?.message }))
              : undefined,
        };
        throw error;
      }
    },
    consumed: () => consumed,
  };
}

test.each([
  [undefined, '(resumed session)', 'unknown', ''],
  [
    '{"local_time":"original start\\n\\n","model":"original model","head_sha":"original sha"}',
    'original start',
    'original model',
    'original sha',
  ],
  ['{"local_time":null,"model":false,"head_sha":""}', 'unknown', 'unknown', ''],
])(
  'ordinary Stop renders original metadata and consumes reopened artifacts: %s',
  async (metadata, started, model, startSha) => {
    const state = setup({ metadata });
    await expect(state.run()).resolves.toEqual({
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    });
    expect(state.phases).toEqual(['projection', 'render']);
    expect(state.observations.git).toHaveBeenCalledTimes(1);
    const turn = JSON.parse(fs.readFileSync(path.join(state.directory, 'turn-001.json'), 'utf8'));
    expect(turn.user).toBe('actual SQL user');
    expect(turn.context).toMatchObject({
      session_started_at: started,
      model,
      start_sha: startSha,
      branch: 'observed-branch',
      head_sha: 'observed-head',
      dirty_files: 7,
    });
    expect(state.outcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published', session_id: 's', turn_count: 1 })
    );
    expect(state.consumed()).toBe(true);
  }
);

test('metadata mutation cannot publish or acknowledge an unrelated context', async () => {
  const state = setup({ metadata: '{"model":"original"}', changeMetadata: true });
  await expect(state.run()).rejects.toThrow('Stop metadata differs from original inventory');
  expect(state.observations.git).not.toHaveBeenCalled();
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
  expect(fs.existsSync(path.join(state.directory, '.session-publication.json'))).toBe(false);
});

test('original reader refuses post-publication corruption before callback or acknowledgement', async () => {
  const state = setup({
    beforeConsume: (directory) => fs.appendFileSync(path.join(directory, 'turn-001.json'), ' '),
  });
  await expect(state.run()).rejects.toThrow();
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
});

test('original reader refuses same-length semantic substitution before acknowledgement', async () => {
  const state = setup({
    beforeConsume: (directory) => {
      const file = path.join(directory, 'turn-001.json');
      const original = fs.readFileSync(file, 'utf8');
      const changed = original.replace('actual SQL user', 'forged SQL user');
      expect(changed).not.toBe(original);
      expect(Buffer.byteLength(changed)).toBe(Buffer.byteLength(original));
      fs.writeFileSync(file, changed);
    },
  });
  await expect(state.run()).rejects.toThrow();
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
});

test('adapter refuses a self-consistent generation that differs from its prepared bytes', async () => {
  const state = setup({ forgePreparedTurn: true });
  await expect(state.run()).rejects.toThrow(
    'Committed Stop artifact differs from preparation: turn-001.json'
  );
  expect(
    JSON.parse(fs.readFileSync(path.join(state.directory, 'turn-001.json'), 'utf8')).user
  ).toBe('forged SQL user');
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
});

test('acquisition and cleanup failures retain both original objects without continuation or replay', async () => {
  const primary = new Error('original operation'),
    cleanup = new Error('original pending cleanup');
  const state = setup({ operationError: primary, cleanupError: cleanup });
  const error = await state.run().catch((error) => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, cleanup]);
  expect(error.errors[0]).toBe(primary);
  expect(error.errors[1]).toBe(cleanup);
  expect(state.port.rows).toHaveBeenCalledTimes(1);
  expect(state.port.continuePublication).not.toHaveBeenCalled();
  expect(state.outcome).not.toHaveBeenCalled();
});

test('Git observation failure retains original error and cannot acknowledge or repeat acquisition', async () => {
  const original = new Error('original Git custody pending');
  const state = setup({ gitError: original });
  await expect(state.run()).rejects.toBe(original);
  expect(state.port.rows).toHaveBeenCalledTimes(1);
  expect(state.port.continuePublication).toHaveBeenCalledTimes(1);
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
});

test('SQL and renderer selectors remain independent and invalid renderer selection cannot acquire', async () => {
  const state = setup();
  await expect(state.run({ sqlProfile: STORE_JSON_UNLIMITED_PROFILE })).resolves.toMatchObject({
    exitCode: 0,
  });
  const refused = setup();
  await expect(refused.run({ rendererProfile: undefined })).rejects.toThrow();
  expect(refused.port.rows).not.toHaveBeenCalled();
});

test('unsupported metadata values never become synthesized defaults or Git observations', async () => {
  const state = setup({ metadata: '{"model":true}' });
  await expect(state.run()).rejects.toThrow(
    'Stop metadata is outside the stock string profile: model'
  );
  expect(state.observations.git).not.toHaveBeenCalled();
  expect(state.outcome).not.toHaveBeenCalled();
  expect(state.consumed()).toBe(false);
});

test('ordinary outcome callback failure prevents acknowledgement', async () => {
  const state = setup();
  const original = new Error('ordinary consumer effect failed');
  await expect(
    state.run({
      observe: async () => {
        throw original;
      },
    })
  ).rejects.toBe(original);
  expect(state.port.rows).toHaveBeenCalledTimes(1);
  expect(state.port.continuePublication).toHaveBeenCalledTimes(1);
  expect(state.consumed()).toBe(false);
});
