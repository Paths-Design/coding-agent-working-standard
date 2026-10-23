const { AbortController } = globalThis;
const {
  createNativeTranscriptStorePort,
  NativeStoreAcquisitionError,
  reconstructNativeTranscriptStore,
} = require('../../dist/runtime/transcript-store-client');
const {
  TRANSCRIPT_STORE_CAPABILITY,
  SESSION_PUBLICATION_CAPABILITY,
  RuntimeProtocolError,
} = require('../../dist/runtime/protocol');
const request = {
  id: 'store-test',
  runtimeDigest: 'a'.repeat(64),
  surface: 'opencode',
  event: 'stop',
  configuration: 'system',
  sessionStore: TRANSCRIPT_STORE_CAPABILITY,
};
const root = '/private/tmp/store-root';
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
const text = (value) => ({ storageClass: 'text', base64: Buffer.from(value).toString('base64') });
const cells = () => [
  text('m'),
  text('{}'),
  text('p'),
  text('{}'),
  { storageClass: 'integer', decimal: '0' },
];
const row = (ordinal = 1, values = cells()) => ({
  schema: 'caws.runtime.transcript-store.row.v1',
  ordinal,
  cells: values,
});
const closed = (end = 'exhausted', count = 1, bytes = 14) => ({
  schema: 'caws.runtime.transcript-store.closed.v1',
  closed: true,
  end,
  failure: null,
  cleanup: {
    progressUnregistered: true,
    busyUnregistered: 'Succeeded',
    finalized: 'Succeeded',
    rollback: 'Succeeded',
  },
  metrics: { rowsCopied: count, rowsDelivered: count, cellBytes: bytes },
});
const calendar = () => ({
  schema: 'caws.runtime.transcript-store.utc.v1',
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
});
function setup(responses, override = {}) {
  const writes = [];
  let reads = 0,
    reading = false;
  const transport = {
    async write(frame) {
      writes.push(frame);
    },
    async read() {
      if (reading) throw Error('second transport reader');
      reading = true;
      reads++;
      try {
        const response = responses.shift();
        if (!response) throw Error('controlled EOF');
        if (response instanceof Error) throw response;
        const value = typeof response === 'function' ? await response(writes.at(-1)) : response;
        if (typeof value === 'string') return Buffer.from(value);
        const { id, runtimeDigest, token } = writes[0];
        return Buffer.from(JSON.stringify({ id, runtimeDigest, token, ...value }));
      } finally {
        reading = false;
      }
    },
  };
  const signal = new AbortController();
  const port = createNativeTranscriptStorePort(
    { ...request, ...override },
    transport,
    signal.signal
  );
  return {
    port,
    writes,
    signal,
    get reads() {
      return reads;
    },
  };
}
test('native store row, native UTC and close use one correlated ordered exchange', async () => {
  const state = setup([row(), calendar(), closed()]);
  const iterator = state.port.rows(root)[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value.ordinal).toBe(1);
  expect(first.value.cells[4]).toEqual({ storageClass: 'integer', value: 0n });
  expect(Object.getOwnPropertyDescriptor(first.value.cells[0], 'bytes')).toHaveProperty('value');
  expect(Buffer.from(first.value.cells[0].bytes).toString()).toBe('m');
  const utc = await state.port.calendar(0n);
  expect(utc).toMatchObject({ kind: 'utc_calendar', seconds: 0n, tmYear: 70, tmMon: 0 });
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
  expect(state.writes.map((value) => value.action || 'request')).toEqual([
    'request',
    'utc',
    'continue',
  ]);
  expect(state.reads).toBe(3);
  expect(() => state.port.assertClosed()).not.toThrow();
});

function publicationOptions(changes = {}) {
  return {
    canonicalRoot: root,
    sessionId: 'original-session',
    prepare: jest.fn(async () => ({ disposition: 'aborted', diagnostic: 'controlled refusal' })),
    consume: jest.fn(async () => {}),
    ...changes,
  };
}
function publicationState(responses) {
  return setup(responses, {
    sessionPublication: SESSION_PUBLICATION_CAPABILITY,
    deadlineEpochMs: Date.now() + 5000,
  });
}
test('publication before acquisition or while a row is outstanding cannot read or prepare', async () => {
  const state = publicationState([row(), closed('stopped')]);
  const options = publicationOptions();
  await expect(state.port.continuePublication(options)).rejects.toThrow(/exhausted closure/);
  expect(state.reads).toBe(0);
  expect(state.writes).toEqual([]);
  const iterator = state.port.rows(root)[Symbol.asyncIterator]();
  await iterator.next();
  await expect(state.port.continuePublication(options)).rejects.toThrow(/exhausted closure/);
  expect(state.reads).toBe(1);
  expect(state.writes).toHaveLength(1);
  expect(options.prepare).not.toHaveBeenCalled();
  expect(options.consume).not.toHaveBeenCalled();
  await iterator.return();
});
test('successful stopped closure satisfies cleanup but never publication exhaustion', async () => {
  const state = publicationState([row(), closed('stopped')]);
  const iterator = state.port.rows(root)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  expect(() => state.port.assertClosed()).not.toThrow();
  const options = publicationOptions();
  await expect(state.port.continuePublication(options)).rejects.toThrow(/exhausted closure/);
  expect(state.reads).toBe(2);
  expect(state.writes.map((frame) => frame.action || 'request')).toEqual(['request', 'stop']);
  expect(options.prepare).not.toHaveBeenCalled();
  expect(options.consume).not.toHaveBeenCalled();
});
test.each(['failed', 'metrics', 'cleanup', 'unconfirmed', 'token', 'identity', 'lost'])(
  'invalid %s closure never transfers publication eligibility',
  async (fault) => {
    const terminal = closed('exhausted', 0, 0);
    if (fault === 'failed') {
      terminal.end = 'failed';
      terminal.failure = 'actual acquisition failure';
    }
    if (fault === 'metrics') terminal.metrics.rowsDelivered = 1;
    if (fault === 'cleanup') terminal.cleanup.rollback = 'Failed';
    if (fault === 'unconfirmed') terminal.closed = false;
    if (fault === 'token') terminal.token = 'foreign-token';
    if (fault === 'identity') terminal.id = 'another-original';
    const state = publicationState([fault === 'lost' ? new Error('lost CLOSED') : terminal]);
    const iterator = state.port.rows(root)[Symbol.asyncIterator]();
    const error = await iterator.next().then(
      () => undefined,
      (error) => error
    );
    const messages = {
      failed: 'actual acquisition failure',
      metrics: 'Invalid store completion metrics',
      cleanup: 'Inconsistent store completion',
      unconfirmed: 'Store cleanup remains unconfirmed',
      token: 'Store frame binding mismatch',
      identity: 'Store frame binding mismatch',
      lost: 'lost CLOSED',
    };
    expect(error).toBeInstanceOf(
      fault === 'failed'
        ? NativeStoreAcquisitionError
        : fault === 'lost'
          ? Error
          : RuntimeProtocolError
    );
    expect(error.message).toBe(messages[fault]);
    if (fault === 'lost') expect(error.constructor).toBe(Error);
    const options = publicationOptions();
    await expect(state.port.continuePublication(options)).rejects.toThrow(/exhausted closure/);
    expect(state.reads).toBe(1);
    expect(state.writes).toHaveLength(1);
    expect(options.prepare).not.toHaveBeenCalled();
    expect(options.consume).not.toHaveBeenCalled();
  }
);
test('root mismatch and cancellation prevent any publication reads or output', async () => {
  const state = publicationState([closed('exhausted', 0, 0)]);
  await state.port.rows(root)[Symbol.asyncIterator]().next();
  await expect(
    state.port.continuePublication(publicationOptions({ canonicalRoot: root + '-other' }))
  ).rejects.toThrow(/original root/);
  const reason = new Error('cancelled after CLOSED');
  state.signal.abort(reason);
  await expect(state.port.continuePublication(publicationOptions())).rejects.toBe(reason);
  expect(state.reads).toBe(1);
  expect(state.writes).toHaveLength(1);
});
test('a lost publication response spends the single continuation without replaying acquisition', async () => {
  const state = publicationState([
    closed('exhausted', 0, 0),
    new Error('publication response lost'),
  ]);
  await state.port.rows(root)[Symbol.asyncIterator]().next();
  await expect(state.port.continuePublication(publicationOptions())).rejects.toThrow(
    'publication response lost'
  );
  await expect(state.port.continuePublication(publicationOptions())).rejects.toThrow(
    /one successful/
  );
  expect(state.reads).toBe(2);
  expect(state.writes).toHaveLength(1);
});
test('return closes outstanding row and waits for native stop acknowledgment', async () => {
  const state = setup([row(), closed('stopped')]);
  const iterator = state.port.rows(root)[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return();
  expect(state.writes.map((value) => value.action || 'request')).toEqual(['request', 'stop']);
  expect(state.reads).toBe(2);
  expect(await iterator.next()).toEqual({ value: undefined, done: true });
});
test('native failed acquisition remains a failure after actual close', async () => {
  const failed = closed('failed', 0, 0);
  failed.failure = 'Sql(prepare: no such table)';
  failed.cleanup.finalized = 'NotNeeded';
  const state = setup([failed]);
  await expect(state.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toBeInstanceOf(
    NativeStoreAcquisitionError
  );
  expect(state.writes).toHaveLength(1);
});
test.each([
  ['unsafe SQL integer', { storageClass: 'integer', decimal: '9223372036854775808' }],
  ['noncanonical SQL integer', { storageClass: 'integer', decimal: '-0' }],
  ['NaN real', { storageClass: 'real', binary64Hex: '7ff8000000000000' }],
  ['unknown real spelling', { storageClass: 'real', binary64Hex: '3FF0000000000000' }],
  ['invalid base64', { storageClass: 'blob', base64: 'YQ' }],
  ['invalid TEXT', { storageClass: 'text', base64: '/w==' }],
  ['extra cell field', { storageClass: 'null', value: null }],
])('%s refuses before yielding', async (_name, value) => {
  const values = cells();
  values[1] = value;
  const state = setup([row(1, values)]);
  await expect(state.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toThrow();
  expect(state.writes).toHaveLength(1);
});
test.each(['token', 'runtimeDigest', 'ordinal'])(
  'foreign row %s refuses without retry',
  async (field) => {
    const frame = row();
    frame[field] = field === 'ordinal' ? 2 : 'foreign';
    const state = setup([frame]);
    await expect(state.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(state.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toThrow(
      /already attempted/
    );
    expect(state.writes).toHaveLength(1);
  }
);
test('duplicate fields cannot change row interpretation', async () => {
  const state = setup([
    (frame) =>
      JSON.stringify({
        ...frame,
        schema: 'caws.runtime.transcript-store.row.v1',
        ordinal: 1,
        cells: cells(),
      }).replace('"ordinal":1', '"ordinal":2,"ordinal":1'),
  ]);
  await expect(state.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toThrow(/duplicate/);
});
test('lost response and unconfirmed close cannot grant replay or success', async () => {
  const lost = setup([]);
  await expect(lost.port.rows(root)[Symbol.asyncIterator]().next()).rejects.toThrow(/EOF/);
  expect(lost.reads).toBe(1);
  expect(lost.writes).toHaveLength(1);
  const frame = closed();
  frame.closed = false;
  const unclosed = setup([row(), frame]);
  const iterator = unclosed.port.rows(root)[Symbol.asyncIterator]();
  await iterator.next();
  await expect(iterator.next()).rejects.toThrow(/unconfirmed/);
  expect(unclosed.writes.map((frame) => frame.action || 'request')).toEqual([
    'request',
    'continue',
  ]);
});
test('next waits for pending calendar rather than starting another reader', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const state = setup([
    row(),
    async () => {
      await pending;
      return calendar();
    },
    closed(),
  ]);
  const iterator = state.port.rows(root)[Symbol.asyncIterator]();
  await iterator.next();
  const utc = state.port.calendar(0n);
  const next = iterator.next();
  expect(() => state.port.calendar(0n)).toThrow(/outside/);
  await Promise.resolve();
  expect(state.writes.map((frame) => frame.action || 'request')).toEqual(['request', 'utc']);
  release();
  await utc;
  expect((await next).done).toBe(true);
  expect(state.reads).toBe(3);
});
test('UTC response is correlated to requested signed64 seconds', async () => {
  const response = calendar();
  response.calendar.seconds = '1';
  const state = setup([row(), response]);
  await state.port.rows(root)[Symbol.asyncIterator]().next();
  await expect(state.port.calendar(0n)).rejects.toThrow(/seconds/);
});
test('capability, surface and event checks precede any transport', () => {
  for (const override of [
    { sessionStore: undefined },
    { surface: 'codex' },
    { event: 'pre_tool_use' },
    { configuration: 'project' },
  ]) {
    expect(() => setup([], override)).toThrow(/unavailable/);
  }
});
test('body exception cannot hide failed return cleanup from the settlement check', async () => {
  const state = setup([row()]);
  const primary = new Error('projection semantic failure');
  let caught;
  try {
    for await (const acquired of state.port.rows(root)) {
      expect(acquired.ordinal).toBe(1);
      throw primary;
    }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(primary);
  expect(() => state.port.assertClosed()).toThrow(/unsettled/);
  expect(state.writes.map((frame) => frame.action || 'request')).toEqual(['request', 'stop']);
});
test('actual native client rows compose with AST projection and snapshot before calendar await', async () => {
  const values = [
    text('m'),
    text('{"role":"user"}'),
    text('p'),
    text('{"type":"text","text":"hello"}'),
    { storageClass: 'integer', decimal: '0' },
  ];
  const charge = values.reduce(
    (sum, cell) =>
      sum + (cell.base64 === undefined ? 8 : Buffer.from(cell.base64, 'base64').length),
    0
  );
  let captured;
  const state = setup([
    row(1, values),
    () => {
      captured.cells[0].bytes[0] = 0;
      return calendar();
    },
    closed('exhausted', 1, charge),
  ]);
  const port = {
    ...state.port,
    rows: async function* (root) {
      for await (const next of state.port.rows(root)) {
        captured = next;
        yield next;
      }
    },
  };
  const result = await reconstructNativeTranscriptStore(port, root, 'opencode', limits);
  expect(result.events).toHaveLength(1);
  expect(Buffer.from(result.sourceRows[0].messageId.bytes).toString()).toBe('m');
  const timestamp = result.events[0].entries.find(
    ([key]) => String.fromCodePoint(...key.codepoints) === 'timestamp'
  )[1];
  expect(String.fromCodePoint(...timestamp.codepoints)).toBe('1970-01-01T00:00:00+00:00');
  const copy = result.sourceRows[0].messageId.bytes;
  copy[0] = 0;
  expect(Buffer.from(result.sourceRows[0].messageId.bytes).toString()).toBe('m');
  expect(() => state.port.assertClosed()).not.toThrow();
});
test.each([true, false])(
  'composed projection preserves body failure and independently records cleanup=%s',
  async (settled) => {
    const values = cells();
    values[1] = text('{');
    const charge = values.reduce(
      (sum, cell) =>
        sum + (cell.base64 === undefined ? 8 : Buffer.from(cell.base64, 'base64').length),
      0
    );
    const cleanupSentinel = new Error('exact stop-read failure sentinel');
    const state = setup(
      settled ? [row(1, values), closed('stopped', 1, charge)] : [row(1, values), cleanupSentinel]
    );
    let caught;
    try {
      await reconstructNativeTranscriptStore(state.port, root, 'opencode', limits);
    } catch (error) {
      caught = error;
    }
    if (settled) {
      expect(caught.name).toBe('StoreJsonError');
      expect(() => state.port.assertClosed()).not.toThrow();
    } else {
      expect(caught).toBeInstanceOf(AggregateError);
      expect(caught.errors[0].name).toBe('StoreJsonError');
      expect(caught.errors[1].message).toMatch(/unsettled/);
      expect(caught.errors[1].cause).toBe(cleanupSentinel);
    }
    expect(state.writes.map((frame) => frame.action || 'request')).toEqual(['request', 'stop']);
  }
);
test('confirmed native close remains distinct from a failed finalize during body-error cleanup', async () => {
  const values = cells();
  values[1] = text('{');
  const charge = values.reduce(
    (sum, cell) =>
      sum + (cell.base64 === undefined ? 8 : Buffer.from(cell.base64, 'base64').length),
    0
  );
  const terminal = closed('failed', 1, charge);
  terminal.failure = 'Cleanup("finalize")';
  terminal.cleanup.finalized = 'Failed(SqlFailure { phase: "finalize" })';
  const state = setup([row(1, values), terminal]);
  let caught;
  try {
    await reconstructNativeTranscriptStore(state.port, root, 'opencode', limits);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.errors[0].name).toBe('StoreJsonError');
  expect(caught.errors[1].sourceClosed).toBe(true);
  expect(caught.errors[1].cause.operationFailure).toBeInstanceOf(NativeStoreAcquisitionError);
  expect(caught.errors[1].cause.operationFailure.diagnostic).toBe('Cleanup("finalize")');
  expect(caught.errors[1].cause.observation.finalized).toBe(
    'Failed(SqlFailure { phase: "finalize" })'
  );
  expect(caught.errors[1].message).toMatch(/after confirmed close/);
});
test('native operation and independent cleanup diagnostics both survive a closed failed result', async () => {
  const terminal = closed('failed', 0, 0);
  terminal.failure = 'Sql(first operation sentinel)';
  terminal.cleanup.finalized = 'Failed(independent finalize sentinel)';
  const state = setup([terminal]);
  let caught;
  try {
    await reconstructNativeTranscriptStore(state.port, root, 'opencode', limits);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect(caught.errors[0].diagnostic).toBe('Sql(first operation sentinel)');
  expect(caught.errors[1].sourceClosed).toBe(true);
  expect(caught.errors[1].cause.operationFailure.diagnostic).toBe('Sql(first operation sentinel)');
  expect(caught.errors[1].cause.observation.finalized).toBe(
    'Failed(independent finalize sentinel)'
  );
});
