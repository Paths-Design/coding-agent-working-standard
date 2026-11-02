const { createHash } = require('node:crypto');
const { AbortController, structuredClone } = globalThis;
const { openNativeRenderObservations } = require('../../dist/runtime/render-observation-client');
const wire = require('../../dist/runtime/render-observation-wire');
const {
  RuntimeProtocolError,
  SESSION_PUBLICATION_CAPABILITY,
} = require('../../dist/runtime/protocol');
const publication = require('../../dist/runtime/session-publication-wire');
const {
  continueNativeSessionPublication,
} = require('../../dist/runtime/session-publication-client');
const calendar = require('../../dist/transcripts/renderer-calendar');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoded = (row) => Buffer.from(JSON.stringify(row));
function stopCatalogFixture() {
  const path = '/repo/.caws/sessions/s';
  const data = Buffer.from('{"toolUseId":"native-tool","agentType":"review"}');
  const descriptor = {
    name: 'subagent-claude-source',
    role: 'subagent',
    byteLength: data.length,
    sha256: sha(data),
  };
  const catalog = {
    schema: wire.STOP_SOURCE_CATALOG_SCHEMA,
    transcriptPath: path + '/.transcript-projection.jsonl',
    audit: { path: '/repo/.opencode/logs/audit.log', disposition: 'absent' },
    hookOutcomes: { path: path + '/hook-events.jsonl', disposition: 'absent' },
    subagents: {
      claudeCandidate: {
        path: path + '/s/subagents',
        kind: 'directory',
        listing: {
          disposition: 'listed',
          names: ['agent-one.jsonl', 'agent-one.meta.json'],
          entries: [
            {
              name: 'agent-one.meta.json',
              file: {
                path: path + '/s/subagents/agent-one.meta.json',
                disposition: 'read',
                descriptor,
              },
            },
          ],
        },
      },
      qwenCandidate: {
        path: '/repo/.caws/sessions/subagents/s',
        kind: 'directory',
        listing: { disposition: 'failed', error: 'native observed EACCES' },
      },
    },
  };
  const files = [descriptor];
  const validated = wire.snapshotStopSourceCatalog(catalog, files, 's');
  const originalBinding = { ...binding, inputDigest: wire.stopSourceInputDigest(files, validated) };
  return {
    catalog,
    files,
    data,
    originalBinding,
    input: { catalog: validated, files, sessionId: 's', bytes: () => data },
    frame: {
      ...original(),
      ...originalBinding,
      schema: wire.RENDER_OBSERVATION_STOP_BINDING,
      sourceCatalog: catalog,
    },
  };
}

test('Stop binding materializes native descriptors and explicit absence without sharing input bytes', async () => {
  const f = stopCatalogFixture(),
    state = setup([f.frame]);
  const lease = await state.open({ binding: f.originalBinding, stopSourceInput: f.input });
  const sources = lease.observations.stopSources;
  expect(sources.binding).toEqual(f.originalBinding);
  expect(sources.audit).toEqual(f.catalog.audit);
  expect(sources.subagents.qwenCandidate.listing).toEqual({
    disposition: 'failed',
    error: 'native observed EACCES',
  });
  const source = sources.subagents.claudeCandidate.listing.entries[0].file;
  expect(source.path).toBe('/repo/.caws/sessions/s/s/subagents/agent-one.meta.json');
  expect(Buffer.from(source.source.bytes).toString()).toBe(
    '{"toolUseId":"native-tool","agentType":"review"}'
  );
  expect(source.source.descriptor).toEqual(f.files[0]);
  f.data.fill(0);
  expect(Buffer.from(source.source.bytes).toString()).toBe(
    '{"toolUseId":"native-tool","agentType":"review"}'
  );
  expect(state.writes).toEqual([]);
  lease.close();
});

test.each([
  'path',
  'omitted-entry',
  'missing-catalog',
  'downgrade',
  'descriptor',
  'bytes',
  'input-digest',
])('Stop source carrier refuses %s before any Git/calendar request', async (failure) => {
  const f = stopCatalogFixture();
  if (failure === 'path') f.frame.sourceCatalog.audit.path = '/other/audit.log';
  if (failure === 'omitted-entry')
    f.frame.sourceCatalog.subagents.claudeCandidate.listing.entries = [];
  if (failure === 'missing-catalog') delete f.frame.sourceCatalog;
  if (failure === 'downgrade') {
    f.frame.schema = wire.RENDER_OBSERVATION_BINDING;
    delete f.frame.sourceCatalog;
  }
  if (failure === 'descriptor')
    f.frame.sourceCatalog.subagents.claudeCandidate.listing.entries[0].file.descriptor.sha256 =
      'f'.repeat(64);
  if (failure === 'bytes') f.input.bytes = () => Buffer.from('different actual source bytes');
  if (failure === 'input-digest') {
    f.originalBinding.inputDigest = 'f'.repeat(64);
    f.frame.inputDigest = 'f'.repeat(64);
  }
  const state = setup([f.frame]);
  await expect(
    state.open({ binding: f.originalBinding, stopSourceInput: f.input })
  ).rejects.toBeInstanceOf(RuntimeProtocolError);
  expect(state.writes).toEqual([]);
});

test('generic binding v1 carries no Stop catalog and cannot manufacture explicit absence', async () => {
  const state = setup([original()]);
  const lease = await state.open();
  expect(lease.observations.stopSources).toBeUndefined();
  lease.close();
  const f = stopCatalogFixture();
  delete f.catalog.audit;
  expect(() => wire.snapshotStopSourceCatalog(f.catalog, f.files, 's')).toThrow(
    'Invalid Stop source catalog'
  );
});
const binding = Object.freeze({
  id: 'actual-original',
  runtimeDigest: 'a'.repeat(64),
  token: '8c766a03-c6a7-42d0-bff5-78c88fab32a1',
  attempt: 'native-attempt',
  observationId: 'native-snapshot',
  inputDigest: 'b'.repeat(64),
});
const executable = { path: '/usr/bin/git', physicalPath: '/physical/git', sha256: 'c'.repeat(64) };
const calendarContext = { originalPid: 12345, tz: { kind: 'absent' }, tzdir: { kind: 'absent' } };
function original() {
  return {
    schema: wire.RENDER_OBSERVATION_BINDING,
    ...binding,
    cwd: '/repo/nested/../nested',
    executable,
    calendarContext,
  };
}
function gitBytes() {
  return encoded({
    schema: 'caws.render.context.observation.v1',
    id: binding.id,
    runtimeDigest: binding.runtimeDigest,
    token: binding.token,
    cwd: original().cwd,
    executable,
    queries: ['inside', 'branch', 'head', 'status'].map((operation, index) => ({
      ordinal: index + 1,
      operation,
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(['true\n', 'main\n', 'abc123\n', ' M file\n'][index]).toString('base64'),
      stderr: Buffer.from(index === 0 ? 'x'.repeat(70000) : '').toString('base64'),
      cleanup: {
        exitObserved: true,
        groupSettled: true,
        stdoutEof: true,
        stderrEof: true,
        reaped: true,
        ownershipRetained: false,
      },
    })),
  });
}
function replyFrames(operation, sequence, bytes) {
  const rows = [
    {
      schema: wire.RENDER_OBSERVATION_RESULT,
      ...binding,
      sequence,
      operation,
      byteLength: bytes.length,
      sha256: sha(bytes),
    },
  ];
  for (let offset = 0; offset < bytes.length; offset += 65536)
    rows.push({
      schema: wire.RENDER_OBSERVATION_CHUNK,
      ...binding,
      sequence,
      operation,
      offset,
      base64: bytes.subarray(offset, offset + 65536).toString('base64'),
    });
  return rows;
}
function calendarRequest(sequence = 1, seconds = ['0']) {
  return {
    schema: calendar.LOCAL_CALENDAR_REQUEST,
    profile: calendar.RENDERER_CALENDAR_PROFILE,
    id: binding.id,
    runtimeDigest: binding.runtimeDigest,
    token: binding.token,
    sequence,
    seconds,
  };
}
function calendarBytes(request) {
  return encoded({
    schema: calendar.LOCAL_CALENDAR_REPLY,
    profile: calendar.RENDERER_CALENDAR_PROFILE,
    id: binding.id,
    runtimeDigest: binding.runtimeDigest,
    token: binding.token,
    sequence: request.sequence,
    context: calendarContext,
    results: request.seconds.map((seconds) => ({
      kind: 'local_calendar',
      seconds,
      tmYear: 70,
      tmMon: 0,
      tmMday: 1,
      tmHour: 0,
      tmMin: 0,
      tmSec: 0,
    })),
  });
}
function setup(rows = []) {
  const controller = new AbortController(),
    writes = [],
    queue = [...rows];
  const transport = {
    read: jest.fn(async () => {
      if (!queue.length) throw new Error('controlled unexpected EOF');
      const row = queue.shift();
      return Buffer.isBuffer(row) ? row : encoded(row);
    }),
    write: jest.fn(async (row) => {
      writes.push(structuredClone(row));
    }),
  };
  return {
    controller,
    writes,
    queue,
    transport,
    open: (extra = {}) =>
      openNativeRenderObservations({
        binding,
        transport,
        signal: controller.signal,
        deadlineEpochMs: Date.now() + 60000,
        ...extra,
      }),
  };
}
async function refuses(promise, message) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(RuntimeProtocolError);
  expect(error.message).toBe(message);
}

test('literal native binding and bounded chunks feed the actual Git consumer, then sequential calendar batches', async () => {
  const request = calendarRequest();
  const state = setup([
    original(),
    ...replyFrames('git', 1, gitBytes()),
    ...replyFrames('calendar', 2, calendarBytes(request)),
  ]);
  const lease = await state.open();
  try {
    expect(await lease.observations.git()).toMatchObject({
      cwd: '/repo/nested/../nested',
      branch: 'main',
      headSha: 'abc123',
    });
    expect(
      (
        await lease.observations.calendar.observe(
          request,
          state.controller.signal,
          Date.now() + 60000
        )
      ).results[0].seconds
    ).toBe('0');
    lease.assertReady();
    expect(state.writes).toEqual([
      { schema: wire.RENDER_OBSERVATION_REQUEST, ...binding, sequence: 1, operation: 'git' },
      {
        schema: wire.RENDER_OBSERVATION_REQUEST,
        ...binding,
        sequence: 2,
        operation: 'calendar',
        request,
      },
    ]);
    expect(state.queue).toHaveLength(0);
  } finally {
    lease.close();
  }
  await refuses(lease.observations.git(), 'Render observation phase closed');
  expect(state.writes).toHaveLength(2);
});
test.each(['id', 'runtimeDigest', 'token', 'attempt', 'observationId', 'inputDigest'])(
  'binding swap %s refuses before callback requests',
  async (field) => {
    const row = original();
    row[field] = 'wrong';
    const state = setup([row]);
    await refuses(state.open(), 'Mismatched Render observation binding');
    expect(state.writes).toEqual([]);
  }
);
test('exposed binding is a frozen original copy and cannot redirect later requests', async () => {
  const state = setup([original(), ...replyFrames('git', 1, gitBytes())]);
  const callerBinding = { ...binding };
  const opening = openNativeRenderObservations({
    binding: callerBinding,
    transport: state.transport,
    signal: state.controller.signal,
    deadlineEpochMs: Date.now() + 60000,
  });
  callerBinding.token = 'changed-after-open';
  callerBinding.inputDigest = 'f'.repeat(64);
  const lease = await opening;
  try {
    expect(lease.observations.binding).toEqual(binding);
    expect(lease.observations.binding).not.toBe(callerBinding);
    expect(Object.isFrozen(lease.observations.binding)).toBe(true);
    expect(Reflect.set(lease.observations.binding, 'token', 'forged')).toBe(false);
    expect(Reflect.set(lease.observations, 'binding', callerBinding)).toBe(false);
    await lease.observations.git();
    expect(state.writes[0]).toMatchObject(binding);
  } finally {
    lease.close();
  }
});
test.each(['cwd', 'executable', 'extra', 'calendar'])(
  'invalid original %s refuses',
  async (fault) => {
    const row = structuredClone(original());
    if (fault === 'cwd') row.cwd = 'relative';
    if (fault === 'executable') row.executable.sha256 = 'wrong';
    if (fault === 'extra') row.engineTimezone = 'UTC';
    if (fault === 'calendar') row.calendarContext.tz = { kind: 'absent', value: 'UTC' };
    const state = setup([row]);
    await refuses(
      state.open(),
      fault === 'calendar'
        ? 'Invalid original calendar environment'
        : 'Invalid Render observation original binding'
    );
    expect(state.writes).toEqual([]);
  }
);
test('duplicate escaped binding member is rejected rather than last-wins', async () => {
  const bytes = encoded(original()).toString().replace('"id":', '"\\u0069d":"wrong","id":');
  const state = setup([Buffer.from(bytes)]);
  await refuses(state.open(), 'Invalid Render observation encoding or duplicate member');
  expect(state.writes).toEqual([]);
});
test.each(['size', 'utf8'])(
  'binding %s is refused at the unchanged frame ceiling',
  async (fault) => {
    const bytes = fault === 'size' ? Buffer.alloc(2 * 1024 * 1024 + 1) : Buffer.from([255]);
    const state = setup([bytes]);
    await refuses(
      state.open(),
      fault === 'size'
        ? 'Render observation frame exceeds bound'
        : 'Invalid Render observation encoding or duplicate member'
    );
    expect(state.writes).toEqual([]);
  }
);
test.each([
  'offset',
  'base64',
  'short',
  'sequence',
  'operation',
  'binding',
  'hash',
  'length',
  'extra',
  'missing',
])('hostile Git %s cannot produce context or another request', async (fault) => {
  const frames = replyFrames('git', 1, gitBytes());
  let expected = 'Invalid Render observation chunk';
  if (fault === 'offset') frames[1].offset = 1;
  if (fault === 'base64') {
    frames[1].base64 += '!';
    expected = 'Invalid Render observation chunk';
  }
  if (fault === 'short') {
    frames[1].base64 = Buffer.from('short').toString('base64');
    expected = 'Invalid Render observation chunk bytes';
  }
  if (fault === 'sequence') {
    frames[0].sequence = 2;
    expected = 'Mismatched Render observation sequence';
  }
  if (fault === 'operation') {
    frames[0].operation = 'calendar';
    expected = 'Mismatched Render observation sequence';
  }
  if (fault === 'binding') {
    frames[1].attempt = 'other';
    expected = 'Mismatched Render observation binding';
  }
  if (fault === 'hash') {
    frames[0].sha256 = 'd'.repeat(64);
    expected = 'Render observation hash mismatch';
  }
  if (fault === 'length') {
    frames[0].byteLength = 6 * 1024 * 1024 + 1;
    expected = 'Invalid Render observation result';
  }
  if (fault === 'extra') frames[1].unexpected = true;
  if (fault === 'missing') frames.pop();
  const state = setup([original(), ...frames]),
    lease = await state.open();
  try {
    if (fault === 'missing')
      await expect(lease.observations.git()).rejects.toThrow('controlled unexpected EOF');
    else await refuses(lease.observations.git(), expected);
    await refuses(
      lease.observations.calendar.observe(
        calendarRequest(),
        state.controller.signal,
        Date.now() + 60000
      ),
      'Render observation phase closed'
    );
    expect(state.writes).toHaveLength(1);
  } finally {
    lease.close();
  }
});
test('inner Git identity is checked by the landed consumer independently of the chunk hash', async () => {
  const raw = JSON.parse(gitBytes());
  raw.token = 'other';
  const state = setup([original(), ...replyFrames('git', 1, encoded(raw))]),
    lease = await state.open();
  try {
    await expect(lease.observations.git()).rejects.toThrow(
      'Render context differs from original identity or CWD'
    );
    expect(state.writes).toHaveLength(1);
  } finally {
    lease.close();
  }
});
test.each([true, false])(
  'native cleanupSettled=%s failure remains terminal, never publication permission',
  async (cleanupSettled) => {
    const state = setup([
        original(),
        {
          schema: wire.RENDER_OBSERVATION_FAILURE,
          ...binding,
          sequence: 1,
          operation: 'git',
          category: 'cleanup',
          diagnostic: 'owner retained',
          cleanupSettled,
        },
      ]),
      lease = await state.open();
    try {
      await refuses(
        lease.observations.git(),
        'Native Render observation failed (cleanup): owner retained'
      );
      await refuses(lease.observations.git(), 'Render observation phase closed');
      expect(state.writes).toHaveLength(1);
    } finally {
      lease.close();
    }
  }
);
test('calendar before Git and repeated Git cannot start a second reader', async () => {
  const first = setup([original()]),
    lease = await first.open();
  await refuses(
    lease.observations.calendar.observe(
      calendarRequest(),
      first.controller.signal,
      Date.now() + 60000
    ),
    'Invalid Render observation operation order'
  );
  expect(first.writes).toHaveLength(0);
  lease.close();
  const second = setup([original(), ...replyFrames('git', 1, gitBytes())]),
    next = await second.open();
  try {
    await next.observations.git();
    await refuses(next.observations.git(), 'Invalid Render observation operation order');
    expect(second.writes).toHaveLength(1);
  } finally {
    next.close();
  }
});
test.each(['sequence', 'token', 'duplicate', 'extension', 'range', 'empty'])(
  'malformed calendar %s is refused before sending a batch',
  async (fault) => {
    const state = setup([original(), ...replyFrames('git', 1, gitBytes())]),
      lease = await state.open();
    try {
      await lease.observations.git();
      const request = calendarRequest();
      if (fault === 'sequence') request.sequence = 2;
      if (fault === 'token') request.token = 'other';
      if (fault === 'duplicate') request.seconds = ['0', '0'];
      if (fault === 'extension') request.seconds = ['+0'];
      if (fault === 'range') request.seconds = ['9223372036854775808'];
      if (fault === 'empty') request.seconds = [];
      await refuses(
        lease.observations.calendar.observe(request, state.controller.signal, Date.now() + 60000),
        ['sequence', 'token', 'empty'].includes(fault)
          ? 'Invalid Render calendar request'
          : 'Invalid Render calendar seconds'
      );
      expect(state.writes).toHaveLength(1);
    } finally {
      lease.close();
    }
  }
);
test('wrong original calendar context cannot be accepted after valid outer hashing', async () => {
  const request = calendarRequest(),
    reply = JSON.parse(calendarBytes(request));
  reply.context.originalPid++;
  const state = setup([
      original(),
      ...replyFrames('git', 1, gitBytes()),
      ...replyFrames('calendar', 2, encoded(reply)),
    ]),
    lease = await state.open();
  try {
    await lease.observations.git();
    await refuses(
      lease.observations.calendar.observe(request, state.controller.signal, Date.now() + 60000),
      'Mismatched Render calendar reply'
    );
    expect(state.writes).toHaveLength(2);
  } finally {
    lease.close();
  }
});
test('calendar reply has its own two-MiB bound without changing the publication frame ceiling', async () => {
  const header = replyFrames('calendar', 2, calendarBytes(calendarRequest()))[0];
  header.byteLength = 2 * 1024 * 1024 + 1;
  const state = setup([original(), ...replyFrames('git', 1, gitBytes()), header]),
    lease = await state.open();
  try {
    await lease.observations.git();
    await refuses(
      lease.observations.calendar.observe(
        calendarRequest(),
        state.controller.signal,
        Date.now() + 60000
      ),
      'Invalid Render observation result'
    );
  } finally {
    lease.close();
  }
  expect(state.writes).toHaveLength(2);
});
test('expired calendar deadline sends no request after Git completion', async () => {
  const state = setup([original(), ...replyFrames('git', 1, gitBytes())]),
    lease = await state.open();
  try {
    await lease.observations.git();
    await refuses(
      lease.observations.calendar.observe(
        calendarRequest(),
        state.controller.signal,
        Date.now() - 1
      ),
      'Session publication callback deadline expired'
    );
  } finally {
    lease.close();
  }
  expect(state.writes).toHaveLength(1);
});
test('calendar total query frontier is finite across individually valid sequential batches', async () => {
  const state = setup([original(), ...replyFrames('git', 1, gitBytes())]);
  state.transport.write.mockImplementation(async (row) => {
    state.writes.push(structuredClone(row));
    if (row.operation === 'calendar')
      state.queue.push(...replyFrames('calendar', row.sequence, calendarBytes(row.request)));
  });
  const lease = await state.open();
  try {
    await lease.observations.git();
    const seconds = Array.from({ length: 256 }, (_, index) => String(index));
    for (let sequence = 1; sequence <= 256; sequence++)
      await lease.observations.calendar.observe(
        calendarRequest(sequence, seconds),
        state.controller.signal,
        Date.now() + 60000
      );
    await refuses(
      lease.observations.calendar.observe(
        calendarRequest(257),
        state.controller.signal,
        Date.now() + 60000
      ),
      'Render calendar query bound exceeded'
    );
    expect(state.writes).toHaveLength(257);
    expect(state.queue).toHaveLength(0);
  } finally {
    lease.close();
  }
});
test('abort while awaiting native bytes observes late rejection and prevents continuation', async () => {
  const state = setup([original()]);
  let rejectLate, started;
  const readStarted = new Promise((resolve) => {
    started = resolve;
  });
  const lease = await state.open();
  // Construct the deferred value only when the production helper adopts an
  // actual read. A write witness alone cannot establish that this read began.
  state.transport.read.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        rejectLate = reject;
        started();
      })
  );
  const pending = lease.observations.git();
  const reason = new Error('original cancelled');
  try {
    await Promise.race([
      readStarted,
      pending.then(
        () => {
          throw new Error('Git completed before the deferred read');
        },
        (error) => {
          throw error;
        }
      ),
    ]);
    state.controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  } finally {
    rejectLate?.(new Error('late transport failure'));
    lease.close();
  }
  await Promise.resolve();
  expect(state.writes).toHaveLength(1);
});
test('concurrent requests cancel the phase instead of contending for the reader', async () => {
  const state = setup([original()]);
  let release, started;
  const readStarted = new Promise((resolve) => {
    started = resolve;
  });
  const lease = await state.open();
  state.transport.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      })
  );
  const first = lease.observations.git();
  const firstOutcome = first.catch((error) => error);
  try {
    await Promise.race([
      readStarted,
      first.then(
        () => {
          throw new Error('Git completed before the deferred read');
        },
        (error) => {
          throw error;
        }
      ),
    ]);
    expect(state.writes).toHaveLength(1);
    expect(state.transport.read).toHaveBeenCalledTimes(2); // binding, then the first Git result
    await refuses(lease.observations.git(), 'Concurrent Render observations are forbidden');
    expect(await firstOutcome).toMatchObject({
      name: 'RuntimeProtocolError',
      message: 'Concurrent Render observations are forbidden',
    });
    expect(state.transport.read).toHaveBeenCalledTimes(2);
  } finally {
    release?.(encoded(replyFrames('git', 1, gitBytes())[0]));
    lease.close();
  }
  expect(state.writes).toHaveLength(1);
});

function publicationSetup(enabled, extra = [], sessionId = 'session') {
  const correlation = {
    id: binding.id,
    runtimeDigest: binding.runtimeDigest,
    token: binding.token,
    attempt: binding.attempt,
  };
  const rows = [
    {
      schema: publication.SESSION_PUBLICATION_PREPARE_SCHEMA,
      ...correlation,
      kind: 'render',
      snapshot: {
        observationId: binding.observationId,
        inputDigest: binding.inputDigest,
        sessionId,
        reason: 'end',
        endedAt: '2026-10-23T00:00:00Z',
        files: [],
        priorInventory: [],
      },
    },
    {
      schema: publication.SESSION_PUBLICATION_READY_SCHEMA,
      ...correlation,
      kind: 'render',
      direction: 'inputs',
    },
    ...extra,
    {
      schema: publication.SESSION_PUBLICATION_RESULT_SCHEMA,
      ...correlation,
      status: 'not_published',
      terminalDigest: publication.sessionPublicationTerminalDigest(correlation, 'not_published'),
      artifacts: [],
    },
  ];
  const state = setup(rows),
    observed = [];
  state.run = (prepare) =>
    continueNativeSessionPublication(
      {
        id: binding.id,
        runtimeDigest: binding.runtimeDigest,
        sessionPublication: SESSION_PUBLICATION_CAPABILITY,
        deadlineEpochMs: Date.now() + 60000,
      },
      state.transport,
      state.controller.signal,
      {
        token: binding.token,
        expectedKinds: ['render'],
        canonicalRoot: '/repo',
        sessionId,
        renderObservations: enabled,
        prepare,
        consume: (value) => {
          observed.push(value.status);
        },
      }
    );
  return { ...state, observed };
}
test('publication input exposes the lease only after complete native Render inputs and revokes it before PREPARED', async () => {
  const state = publicationSetup(true, [original(), ...replyFrames('git', 1, gitBytes())]);
  let saved;
  expect(
    (
      await state.run(async (input) => {
        saved = input.observations;
        expect(saved).toBeDefined();
        expect((await saved.git()).branch).toBe('main');
        return { disposition: 'aborted', diagnostic: 'intentional no-publication' };
      })
    ).status
  ).toBe('not_published');
  await refuses(saved.git(), 'Render observation phase closed');
  expect(state.writes.map((row) => row.schema)).toEqual([
    wire.RENDER_OBSERVATION_REQUEST,
    publication.SESSION_PUBLICATION_PREPARED_SCHEMA,
    publication.SESSION_PUBLICATION_READY_SCHEMA,
    publication.SESSION_PUBLICATION_CONSUMED_SCHEMA,
  ]);
  expect(state.writes[2]).toMatchObject({ kind: 'render', direction: 'prepared' });
  expect(state.observed).toEqual(['not_published']);
});
test('Stop PREPARE v2 carries owned INPUTS into the matching native observation lease', async () => {
  const f = stopCatalogFixture(),
    state = publicationSetup(true, [], 's');
  state.queue[0].schema = wire.STOP_PUBLICATION_PREPARE;
  Object.assign(state.queue[0].snapshot, {
    inputDigest: f.originalBinding.inputDigest,
    files: f.files,
    sourceCatalog: f.catalog,
  });
  state.queue.splice(1, 0, {
    schema: publication.SESSION_PUBLICATION_INPUTS_SCHEMA,
    id: binding.id,
    runtimeDigest: binding.runtimeDigest,
    token: binding.token,
    attempt: binding.attempt,
    kind: 'render',
    name: f.files[0].name,
    offset: 0,
    base64: f.data.toString('base64'),
  });
  state.queue.splice(3, 0, f.frame);
  const prepare = jest.fn(async (input) => {
    const sources = input.observations.stopSources;
    expect(sources.binding.inputDigest).toBe(f.originalBinding.inputDigest);
    expect(
      Buffer.from(sources.subagents.claudeCandidate.listing.entries[0].file.source.bytes)
    ).toEqual(f.data);
    expect(sources.audit.disposition).toBe('absent');
    expect(sources.subagents.qwenCandidate.listing.disposition).toBe('failed');
    return { disposition: 'aborted', diagnostic: 'carrier control only' };
  });
  await expect(state.run(prepare)).resolves.toMatchObject({ status: 'not_published' });
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(state.writes.at(-1).schema).toBe(publication.SESSION_PUBLICATION_CONSUMED_SCHEMA);
});
test('Stop PREPARE catalog mutation refuses before preparation or acknowledgement', async () => {
  const f = stopCatalogFixture(),
    state = publicationSetup(true, [], 's');
  state.queue[0].schema = wire.STOP_PUBLICATION_PREPARE;
  Object.assign(state.queue[0].snapshot, {
    inputDigest: f.originalBinding.inputDigest,
    files: f.files,
    sourceCatalog: f.catalog,
  });
  state.queue[0].snapshot.sourceCatalog.audit.path = '/another/audit.log';
  const prepare = jest.fn();
  await expect(state.run(prepare)).rejects.toThrow('Stop source catalog input digest mismatch');
  expect(prepare).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
});
test('legacy absence does not read or expose any observation frames', async () => {
  const state = publicationSetup(undefined);
  await state.run(async (input) => {
    expect(input.observations).toBeUndefined();
    return { disposition: 'aborted', diagnostic: 'legacy' };
  });
  expect(state.writes.map((row) => row.schema)).toEqual([
    publication.SESSION_PUBLICATION_PREPARED_SCHEMA,
    publication.SESSION_PUBLICATION_READY_SCHEMA,
    publication.SESSION_PUBLICATION_CONSUMED_SCHEMA,
  ]);
  expect(state.writes[1]).toMatchObject({ kind: 'render', direction: 'prepared' });
});
test('observation binding before native input READY cannot enter preparation', async () => {
  const state = publicationSetup(true, [original()]);
  state.queue[1] = original();
  const prepare = jest.fn();
  await refuses(state.run(prepare), 'Native snapshot is incomplete');
  expect(prepare).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
  expect(state.transport.read).toHaveBeenCalledTimes(2);
});
test('malformed binding or missing Git for ready preparation sends no PREPARED or CONSUMED', async () => {
  const bad = original();
  bad.observationId = 'stale';
  const state = publicationSetup(true, [bad]);
  const prepare = jest.fn();
  await refuses(state.run(prepare), 'Mismatched Render observation binding');
  expect(prepare).not.toHaveBeenCalled();
  expect(state.writes).toEqual([]);
  const missing = publicationSetup(true, [original()]);
  await refuses(
    missing.run(async () => ({ disposition: 'ready', artifacts: [], removals: [] })),
    'Render preparation lacks a completed Git observation'
  );
  expect(missing.writes).toEqual([]);
});
test('catching an observation failure cannot turn it into an aborted PREPARED or acknowledgement', async () => {
  const state = publicationSetup(true, [
    original(),
    {
      schema: wire.RENDER_OBSERVATION_FAILURE,
      ...binding,
      sequence: 1,
      operation: 'git',
      category: 'cleanup',
      diagnostic: 'retained original',
      cleanupSettled: false,
    },
  ]);
  await refuses(
    state.run(async (input) => {
      await expect(input.observations.git()).rejects.toThrow(
        'Native Render observation failed (cleanup): retained original'
      );
      return { disposition: 'aborted', diagnostic: 'cannot erase the failed exchange' };
    }),
    'Render observation phase closed'
  );
  expect(state.writes.map((row) => row.schema)).toEqual([wire.RENDER_OBSERVATION_REQUEST]);
  expect(state.observed).toEqual([]);
});
test('returning from preparation with an outstanding observation closes the lease without PREPARED', async () => {
  const state = publicationSetup(true, [original()]);
  let release, pending;
  const deferred = new Promise((resolve) => {
    release = resolve;
  });
  const originalRead = state.transport.read.getMockImplementation();
  let reads = 0;
  state.transport.read.mockImplementation(async (...args) =>
    ++reads <= 3 ? originalRead(...args) : deferred
  );
  try {
    await refuses(
      state.run(async (input) => {
        pending = input.observations.git().catch((error) => error);
        return { disposition: 'aborted', diagnostic: 'unawaited work' };
      }),
      'Render observation operation is still active'
    );
    expect(await pending).toBeInstanceOf(RuntimeProtocolError);
  } finally {
    release(encoded(replyFrames('git', 1, gitBytes())[0]));
  }
  expect(state.writes.map((row) => row.schema)).toEqual([wire.RENDER_OBSERVATION_REQUEST]);
});
