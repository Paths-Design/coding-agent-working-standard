const {
  reconstructStoreProjection: reconstruct,
  StoreProjectionReferenceError,
  StoreProjectionContractError,
  StoreProjectionEncodingError,
  encodeStoreProjectionEvents: encodeEvents,
} = require('../../dist/transcripts/store-projection');
const { StoreJsonError } = require('../../dist/transcripts/store-json');
const {
  StoreTimestampReferenceError,
  StoreTimestampContractError,
} = require('../../dist/transcripts/store-timestamp');
const { isCodepointText } = require('../../dist/transcripts/codepoint-text');
const jsonLimits = {
  maxInputBytes: 100000,
  maxDecodedCodepoints: 100000,
  maxNodes: 10000,
  maxDepth: 100,
  maxStringCodepoints: 100000,
  maxNumberChars: 5000,
};
const limits = (changes = {}) => ({
  json: { ...jsonLimits },
  maxRows: 100,
  maxEvents: 100,
  maxCodepoints: 100000,
  ...changes,
});
const nullCell = () => ({ storageClass: 'null' });
const sqlText = (value) => ({ storageClass: 'text', bytes: Buffer.from(value) });
const sqlInt = (value) => ({ storageClass: 'integer', value: BigInt(value) });
const sqlReal = (value) => ({ storageClass: 'real', value });
const sqlBlob = (value) => ({ storageClass: 'blob', bytes: Uint8Array.from(value) });
const row = (ordinal, message, part, id = sqlText('m'), time = sqlInt(0)) => ({
  ordinal,
  cells: [id, sqlText(message), sqlText('p' + ordinal), sqlText(part), time],
});
const textRow = (ordinal, prose, id, role = 'user', time) =>
  row(ordinal, JSON.stringify({ role }), JSON.stringify({ type: 'text', text: prose }), id, time);
const toolRow = (ordinal, tool, state = {}, callID = '') =>
  row(ordinal, '{"role":"user"}', JSON.stringify({ type: 'tool', tool, callID, state }));
const ignoredRow = (ordinal, id, time) => row(ordinal, '{}', '{"type":"reasoning"}', id, time);
const calendar = async (seconds) => ({
  kind: 'utc_calendar',
  seconds,
  tmYear: 70,
  tmMon: 0,
  tmMday: 1,
  tmHour: 0,
  tmMin: 0,
  tmSec: 0,
});
async function* sequence(items) {
  yield* items;
}
const run = (items, surface = 'zcode', bound = limits(), clock = calendar) =>
  reconstruct(sequence(items), surface, clock, bound);
test('event bytes use Python separators, literal Unicode and strict output bounds', async () => {
  const result = await run([textRow(1, 'snow 雪 😀\n\t"\\\0')]);
  const expected = Buffer.from(
    '{"type": "user", "timestamp": "1970-01-01T00:00:00+00:00", "message": {"content": [{"type": "text", "text": "snow 雪 😀\\n\\t\\"\\\\\\u0000"}]}}\n'
  );
  expect(Buffer.from(encodeEvents(result, expected.length))).toEqual(expected);
  expect(() => encodeEvents(result, expected.length - 1)).toThrow(StoreProjectionContractError);
  expect(() =>
    encodeEvents({ events: result.events, sourceRows: result.sourceRows }, 100000)
  ).toThrow(/unconstructed/);
  expect(Buffer.from(encodeEvents(await run([]), 0))).toEqual(Buffer.alloc(0));
});
test('event encoding retains numeric kinds and arbitrary nested tool values', async () => {
  const result = await run([
    row(
      1,
      '{}',
      '{"type":"tool","tool":false,"callID":{"opaque":[1,1.0,9007199254740993,NaN,Infinity]},"state":{"input":{},"status":"error","output":null}}'
    ),
  ]);
  const text = Buffer.from(encodeEvents(result, 100000)).toString();
  expect(text).toContain('"name": false');
  expect(text).toContain('"id": {"opaque": [1, 1.0, 9007199254740993, NaN, Infinity]}');
  expect(text).toContain('"is_error": true, "content": null');
});
test.each(['escaped-lone', 'literal-adjacent'])(
  'strict whole-stream encoding refuses literal surrogate %s after reconstruction',
  async (literal) => {
    let closed = false;
    async function* source() {
      try {
        const item = row(1, '{"role":"user"}', '{"type":"text","text":"\\ud800"}');
        if (literal === 'literal-adjacent')
          item.cells[3] = sqlBlob(
            Buffer.concat([
              Buffer.from('{"type":"text","text":"'),
              Buffer.from([0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80]),
              Buffer.from('"}'),
            ])
          );
        yield item;
      } finally {
        closed = true;
      }
    }
    const result = await reconstruct(source(), 'zcode', calendar, limits());
    expect(closed).toBe(true);
    expect(() => encodeEvents(result, 100000)).toThrow(StoreProjectionEncodingError);
  }
);
const key = (text) => String.fromCodePoint(...text.codepoints);
const get = (object, name) => object.entries.find(([k]) => key(k) === name)?.[1];
const content = (event) => get(get(event, 'message'), 'content')[0];
const valueText = (value) => {
  expect(isCodepointText(value)).toBe(true);
  return key(value);
};
const prose = (event) => valueText(get(content(event), 'text'));
const eventType = (event) => valueText(get(event, 'type'));
async function referenceFailure(promise, type, message) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(StoreProjectionReferenceError);
  expect(error.referenceType).toBe(type);
  expect(error.message).toBe(message);
}
async function contractFailure(promise, category, code) {
  const error = await promise.catch((e) => e);
  expect(error).toBeInstanceOf(StoreProjectionContractError);
  expect(error.category).toBe(category);
  expect(error.code).toBe(code);
}

test('merges user prose across ignored rows, keeps first timestamp, and retains every source row', async () => {
  const clock = async (seconds) => ({ ...(await calendar(seconds)), tmSec: Number(seconds) });
  const result = await run(
    [
      textRow(1, 'a', undefined, 'user', sqlInt(1000)),
      ignoredRow(2),
      textRow(3, 'b', undefined, 'user', sqlInt(2000)),
    ],
    'zcode',
    limits(),
    clock
  );
  expect(result.events).toHaveLength(1);
  expect(prose(result.events[0])).toBe('a\n\nb');
  expect(valueText(get(result.events[0], 'timestamp'))).toBe('1970-01-01T00:00:01+00:00');
  expect(result.sourceRows).toHaveLength(3);
});

test('assistant text and tool events break ordinary user grouping', async () => {
  const result = await run([
    textRow(1, 'u'),
    textRow(2, 'a', undefined, 'assistant'),
    textRow(3, 'v'),
    toolRow(4, 'unknown'),
    textRow(5, 'w'),
  ]);
  expect(result.events.map(eventType)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
  expect(prose(result.events[2])).toBe('v');
  expect(prose(result.events[4])).toBe('w');
});

test('numeric ID equality compares exact integers to integral binary64 without rounding bigint', async () => {
  const result = await run([
    textRow(1, 'a', sqlInt(9007199254740993n)),
    textRow(2, 'b', sqlReal(9007199254740992)),
    textRow(3, 'c', sqlInt(9007199254740992n)),
    textRow(4, 'd', sqlReal(9007199254740992)),
  ]);
  expect(result.events).toHaveLength(2);
  expect(prose(result.events[0])).toBe('a');
  expect(prose(result.events[1])).toBe('b\n\nc\n\nd');
});

test('TEXT and BLOB IDs differ, equal BLOB IDs merge, signed zero integer/real IDs merge', async () => {
  const result = await run([
    textRow(1, 'a', sqlText('m')),
    textRow(2, 'b', sqlBlob([109])),
    textRow(3, 'c', sqlBlob([109])),
    textRow(4, 'd', sqlInt(0)),
    textRow(5, 'e', sqlReal(-0)),
  ]);
  expect(result.events.map(prose)).toEqual(['a', 'b\n\nc', 'd\n\ne']);
});

test('NULL message ID cannot come from the fixed equality JOIN and is refused as invalid transport', async () => {
  await contractFailure(run([textRow(1, 'x', nullCell())]), 'request', 'null_message_id');
});

test('message JSON error wins over part JSON; part parsing precedes both-root object validation', async () => {
  const first = await run([row(1, '{"role":', 'BROKEN')]).catch((e) => e);
  expect(first).toBeInstanceOf(StoreJsonError);
  expect(first.offset).toBe(8);
  const second = await run([row(1, '[]', 'BROKEN')]).catch((e) => e);
  expect(second).toBeInstanceOf(StoreJsonError);
  await referenceFailure(
    run([row(1, '{}', '[]')]),
    'ValueError',
    'message and part data must be objects'
  );
});

test.each([
  ['integer', sqlInt(1), 'int'],
  ['real', sqlReal(1), 'float'],
  ['null', nullCell(), 'NoneType'],
])('SQL %s message data is a reference TypeError', async (_, cell, pythonType) => {
  const item = textRow(1, 'x');
  item.cells[1] = cell;
  await referenceFailure(
    run([item]),
    'TypeError',
    'the JSON object must be str, bytes or bytearray, not ' + pythonType
  );
});

test('ignored rows still call calendar before role/type filtering, and timestamp failure beats invalid state', async () => {
  const calls = [];
  const failure = { kind: 'os_error', seconds: 0n, errno: 22, message: 'calendar refused' };
  const clock = async (seconds) => {
    calls.push(seconds);
    return failure;
  };
  const error = await run([ignoredRow(1)], 'zcode', limits(), clock).catch((e) => e);
  expect(calls).toEqual([0n]);
  expect(error).toBeInstanceOf(StoreTimestampReferenceError);
  expect(error.message).toBe('calendar refused');
  expect(error.referenceType).toBe('OSError');
  expect(error.errno).toBe(22);
  const invalid = toolRow(1, 'read', null);
  const second = await run([invalid], 'zcode', limits(), clock).catch((e) => e);
  expect(second).toBeInstanceOf(StoreTimestampReferenceError);
});

test('calendar result passes untouched to timestamp validation; nonnumeric timestamp skips callback', async () => {
  const marker = new Error('callback rejected');
  await expect(
    run([textRow(1, 'x')], 'zcode', limits(), async () => {
      throw marker;
    })
  ).rejects.toBe(marker);
  const bad = await run([textRow(1, 'x')], 'zcode', limits(), async () => ({
    kind: 'utc_calendar',
    seconds: 1n,
  })).catch((e) => e);
  expect(bad).toBeInstanceOf(StoreTimestampContractError);
  expect(bad.code).toBe('mismatched_seconds');
  const never = jest.fn();
  const result = await run(
    [textRow(1, 'x', undefined, 'user', sqlText('not numeric'))],
    'zcode',
    limits(),
    never
  );
  expect(never).not.toHaveBeenCalled();
  expect(get(result.events[0], 'timestamp')).toBe(null);
});

test('earlier row failure closes generator without requesting later iteration failure', async () => {
  const late = new Error('late iterator');
  let reachedLater = false,
    closed = false;
  async function* input() {
    try {
      yield row(1, '{}', '{"type":"tool"}');
      reachedLater = true;
      throw late;
    } finally {
      closed = true;
    }
  }
  await referenceFailure(
    reconstruct(input(), 'zcode', calendar, limits()),
    'ValueError',
    'tool state is not an object'
  );
  expect(reachedLater).toBe(false);
  expect(closed).toBe(true);
});

test('iterator and completion-cleanup errors outrank deferred surrogate serialization because projection never serializes', async () => {
  const marker = new Error('provider close failed');
  async function* input() {
    try {
      yield textRow(1, '\ud800');
    } finally {
      await Promise.reject(marker);
    }
  }
  await expect(reconstruct(input(), 'zcode', calendar, limits())).rejects.toBe(marker);
  const cleanup = new Error('return failed');
  const provider = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ value: row(1, '{}', '{"type":"tool"}'), done: false }),
        return: async () => {
          throw cleanup;
        },
      };
    },
  };
  await referenceFailure(
    reconstruct(provider, 'zcode', calendar, limits()),
    'ValueError',
    'tool state is not an object'
  );
});

test.each([null, false, 0, [], ''])(
  'explicit nonobject tool input %p refuses rather than defaulting',
  async (input) => {
    await referenceFailure(
      run([toolRow(1, 'read', { input })], 'opencode'),
      'ValueError',
      'tool input is not an object'
    );
  }
);

test('missing input defaults to object and known mapping fields preserve null/false/zero while dropping extras', async () => {
  const result = await run(
    [
      toolRow(1, 'read'),
      toolRow(2, 'edit', {
        input: { filePath: null, oldString: false, newString: 0, extra: 'drop' },
      }),
    ],
    'opencode'
  );
  expect(valueText(get(get(content(result.events[0]), 'input'), 'file_path'))).toBe('');
  const mapped = get(content(result.events[1]), 'input');
  expect(mapped.entries.map(([name]) => key(name))).toEqual([
    'file_path',
    'old_string',
    'new_string',
  ]);
  expect(get(mapped, 'file_path')).toBe(null);
  expect(get(mapped, 'old_string')).toBe(false);
  expect(get(mapped, 'new_string')).toEqual({ kind: 'number', numberKind: 'integer', lexeme: '0' });
});

test.each([
  ['write', { filePath: 'x', content: false }, ['file_path', 'content']],
  ['bash', { command: 'x', description: null }, ['command', 'description']],
  ['grep', { pattern: 'x', path: 0 }, ['pattern', 'path']],
  ['glob', { pattern: 'x', path: 0 }, ['pattern', 'path']],
  [
    'task',
    { prompt: 'x', subagent_type: false, description: null },
    ['prompt', 'subagent_type', 'description'],
  ],
  ['skill', { name: 'x', args: [] }, ['skill', 'args']],
])('maps declared %s input coordinates directly on store AST', async (name, input, fields) => {
  const result = await run([toolRow(1, name, { input })], 'opencode');
  const mapped = get(content(result.events[0]), 'input');
  expect(mapped.entries.map(([field]) => key(field))).toEqual(fields);
  expect(valueText(mapped.entries[0][1])).toBe('x');
});

test('todowrite renames without remapping, unknown names preserve exact nested numeric kinds and nonstring names', async () => {
  const item = row(
    1,
    '{}',
    '{"type":"tool","tool":"unknown","state":{"input":{"n":900719925474099312345,"f":1e999,"z":-0.0,"x":NaN},"status":"completed","output":null},"callID":false}'
  );
  const result = await run(
    [item, toolRow(2, 'todowrite', { input: { keep: 3 } }), toolRow(3, null, { input: {} }, 0)],
    'opencode'
  );
  const input = get(content(result.events[0]), 'input');
  expect(get(input, 'n').lexeme).toBe('900719925474099312345');
  expect(get(input, 'f').lexeme).toBe('1e999');
  expect(get(input, 'z').numberKind).toBe('float');
  expect(get(input, 'x').lexeme).toBe('NaN');
  expect(get(content(result.events[1]), 'content')).toBe(null);
  expect(get(content(result.events[1]), 'tool_use_id')).toBe(false);
  expect(get(content(result.events[1]), 'is_error')).toBe(false);
  expect(valueText(get(content(result.events[2]), 'name'))).toBe('TodoWrite');
  expect(get(get(content(result.events[2]), 'input'), 'keep').lexeme).toBe('3');
  expect(get(content(result.events[3]), 'name')).toBe(null);
  expect(get(content(result.events[3]), 'id').lexeme).toBe('0');
});

test.each([
  [[], 'list'],
  [{}, 'dict'],
])('OpenCode tool name %p is unhashable but ZCode forwards it', async (name, type) => {
  await referenceFailure(
    run([toolRow(1, name)], 'opencode'),
    'TypeError',
    `unhashable type: '${type}'`
  );
  const result = await run([toolRow(1, name)], 'zcode');
  const value = get(content(result.events[0]), 'name');
  expect(type === 'list' ? Array.isArray(value) : value.kind === 'object').toBe(true);
});

test('output absence differs from null/false/zero; only exact completed/error statuses emit results', async () => {
  const result = await run([
    toolRow(1, 'x', { status: 'completed' }),
    toolRow(2, 'x', { status: 'error', output: false }),
    toolRow(3, 'x', { status: 'completed', output: 0 }),
    toolRow(4, 'x', { status: true }),
  ]);
  expect(result.events).toHaveLength(7);
  expect(valueText(get(content(result.events[1]), 'content'))).toBe('');
  expect(get(content(result.events[3]), 'content')).toBe(false);
  expect(get(content(result.events[3]), 'is_error')).toBe(true);
  expect(get(content(result.events[5]), 'content').lexeme).toBe('0');
});

test('non-user/assistant text ignores malformed prose and retains ignored source metadata', async () => {
  const result = await run([row(1, '{"role":false}', '{"type":"text","text":null}')]);
  expect(result.events).toEqual([]);
  expect(result.sourceRows).toHaveLength(1);
});

test('lone and literal adjacent surrogate codepoints remain distinct from astral values until caller encoding', async () => {
  const bytes = Buffer.concat([
    Buffer.from('{"type":"text","text":"'),
    Buffer.from([0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80]),
    Buffer.from('"}'),
  ]);
  const item = textRow(1, 'x');
  item.cells[3] = { storageClass: 'blob', bytes };
  const result = await run([item, textRow(2, '\ud800')]);
  const value = get(content(result.events[0]), 'text');
  expect(value.codepoints).toEqual([0xd800, 0xdc00, 10, 10, 0xd800]);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.codepoints)).toBe(true);
});

test('snapshots all row fields, byte views and limits before calendar await; metadata getters expose only private copies', async () => {
  const item = textRow(1, 'before', sqlBlob([1, 2]));
  const input = item.cells[0].bytes;
  const bound = limits();
  let called = false;
  const clock = async (seconds) => {
    called = true;
    input.fill(9);
    item.cells[0] = sqlText('changed');
    item.cells[2].bytes.fill(9);
    item.cells[3].bytes.fill(0);
    item.ordinal = 99;
    bound.maxEvents = 0;
    bound.maxCodepoints = 0;
    return calendar(seconds);
  };
  const result = await run([item], 'zcode', bound, clock);
  expect(called).toBe(true);
  expect(prose(result.events[0])).toBe('before');
  expect([...result.sourceRows[0].messageId.bytes]).toEqual([1, 2]);
  expect(Buffer.from(result.sourceRows[0].partId.bytes).toString()).toBe('p1');
  const exposed = result.sourceRows[0].messageId.bytes;
  exposed.fill(7);
  expect([...result.sourceRows[0].messageId.bytes]).toEqual([1, 2]);
  for (const value of [
    result,
    result.events,
    result.sourceRows,
    result.sourceRows[0],
    result.sourceRows[0].messageId,
    result.events[0],
    result.events[0].entries,
  ])
    expect(Object.isFrozen(value)).toBe(true);
});

test('zero budgets are finite, empty input can pass, and row/event/merged-codepoint refusal is separate from reference errors', async () => {
  expect(
    (await run([], 'zcode', limits({ maxRows: 0, maxEvents: 0, maxCodepoints: 0 }))).events
  ).toEqual([]);
  await contractFailure(run([ignoredRow(1)], 'zcode', limits({ maxRows: 0 })), 'resource', 'rows');
  await contractFailure(
    run([textRow(1, 'x')], 'zcode', limits({ maxEvents: 0 })),
    'resource',
    'events'
  );
  // 35 key codepoints + user(4) + UTC timestamp(25) + text(4) + x(1).
  const exact = 69;
  expect(
    (await run([textRow(1, 'x')], 'zcode', limits({ maxCodepoints: exact }))).events
  ).toHaveLength(1);
  await contractFailure(
    run([textRow(1, 'x')], 'zcode', limits({ maxCodepoints: exact - 1 })),
    'resource',
    'codepoints'
  );
  await contractFailure(
    run([textRow(1, 'x'), textRow(2, 'y')], 'zcode', limits({ maxCodepoints: exact + 2 })),
    'resource',
    'codepoints'
  );
  expect(
    prose(
      (await run([textRow(1, 'x'), textRow(2, 'y')], 'zcode', limits({ maxCodepoints: exact + 3 })))
        .events[0]
    )
  ).toBe('x\n\ny');
});

test('codepoint budget charges nested keys/values, repeated shared call IDs, and both event timestamps', async () => {
  // tool_use: 42 structural keys + 60 retained value/key codepoints;
  // tool_result: 57 structural keys + 49 retained value/key codepoints.
  const exact = 208;
  await contractFailure(
    run(
      [
        toolRow(
          1,
          'unknown',
          { input: { nested: ['α'] }, status: 'completed', output: { deep: 'β' } },
          'call'
        ),
      ],
      'zcode',
      limits({ maxCodepoints: exact - 1 })
    ),
    'resource',
    'codepoints'
  );
  expect(
    (
      await run(
        [
          toolRow(
            1,
            'unknown',
            { input: { nested: ['α'] }, status: 'completed', output: { deep: 'β' } },
            'call'
          ),
        ],
        'zcode',
        limits({ maxCodepoints: exact })
      )
    ).events
  ).toHaveLength(2);
});

test.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'invalid finite budget %p refuses before acquisition',
  async (invalid) => {
    let acquired = false;
    async function* input() {
      acquired = true;
      yield textRow(1, 'x');
    }
    await contractFailure(
      reconstruct(input(), 'zcode', calendar, limits({ maxRows: invalid })),
      'request',
      'invalid_limit_maxRows'
    );
    expect(acquired).toBe(false);
  }
);

test('ordinal is exactly one-based and row/cell/accessor/shared-byte violations are transport-contract failures', async () => {
  const badOrdinal = textRow(0, 'x');
  await contractFailure(run([badOrdinal]), 'request', 'ordinal_sequence');
  const short = { ordinal: 1, cells: [] };
  await contractFailure(run([short]), 'request', 'five_cells_required');
  const sparse = textRow(1, 'x');
  delete sparse.cells[2];
  await contractFailure(run([sparse]), 'request', 'missing_or_accessor_2');
  const access = textRow(1, 'x');
  let invoked = false;
  Object.defineProperty(access.cells[0], 'bytes', {
    get() {
      invoked = true;
      return Buffer.from('evil');
    },
  });
  await contractFailure(run([access]), 'request', 'missing_or_accessor_bytes');
  expect(invoked).toBe(false);
  const shared = textRow(1, 'x');
  shared.cells[0] = { storageClass: 'blob', bytes: new Uint8Array(new SharedArrayBuffer(1)) };
  await contractFailure(run([shared]), 'request', 'shared_bytes');
});

test('array accessor cells and unreadable proxies are refused without invoking cell accessors', async () => {
  const item = textRow(1, 'x');
  let read = false;
  Object.defineProperty(item.cells, '3', {
    get() {
      read = true;
      return sqlText('{}');
    },
  });
  await contractFailure(run([item]), 'request', 'missing_or_accessor_3');
  expect(read).toBe(false);
  const proxy = textRow(1, 'x');
  proxy.cells = new Proxy(proxy.cells, {
    ownKeys() {
      throw new Error('proxy trap');
    },
  });
  await contractFailure(run([proxy]), 'request', 'unreadable_cells');
});

test('retained occurrence budget traverses deeply nested parser-admitted values without JS recursion', async () => {
  const depth = 5000;
  const item = row(
    1,
    '{}',
    '{"type":"tool","tool":"unknown","state":{"input":{"chain":' +
      '['.repeat(depth) +
      '"x"' +
      ']'.repeat(depth) +
      '}}}'
  );
  const result = await run([item], 'zcode', limits({ json: { ...jsonLimits, maxDepth: 6000 } }));
  let value = get(get(content(result.events[0]), 'input'), 'chain');
  for (let i = 0; i < depth; i++) {
    expect(value).toHaveLength(1);
    value = value[0];
  }
  expect(valueText(value)).toBe('x');
});

test('resource refusal closes the owning generator and does not consume a later row', async () => {
  let closed = false,
    later = false;
  async function* input() {
    try {
      yield textRow(1, 'x');
      later = true;
      yield textRow(2, 'y');
    } finally {
      closed = true;
    }
  }
  await contractFailure(
    reconstruct(input(), 'zcode', calendar, limits({ maxEvents: 0 })),
    'resource',
    'events'
  );
  expect(closed).toBe(true);
  expect(later).toBe(false);
});

test('absent tool/callID defaults are distinct from explicit false and arbitrary object callID', async () => {
  const result = await run(
    [row(1, '{}', '{"type":"tool","state":{}}'), toolRow(2, false, {}, { opaque: [true] })],
    'opencode'
  );
  expect(valueText(get(content(result.events[0]), 'name'))).toBe('');
  expect(valueText(get(content(result.events[0]), 'id'))).toBe('');
  expect(get(content(result.events[1]), 'name')).toBe(false);
  expect(get(get(content(result.events[1]), 'id'), 'opaque')).toEqual([true]);
});

test('revoked row, requested-limits and cells proxies stay explicit request-contract failures', async () => {
  const revoked = (value) => {
    const item = Proxy.revocable(value, {});
    item.revoke();
    return item.proxy;
  };
  // A direct async iterator delivers the row without async-generator thenable assimilation.
  const direct = (value) => ({
    [Symbol.asyncIterator]() {
      let used = false;
      return {
        next: async () => (used ? { done: true } : ((used = true), { done: false, value })),
      };
    },
  });
  await contractFailure(
    reconstruct(direct(revoked(textRow(1, 'x'))), 'zcode', calendar, limits()),
    'request',
    'unreadable_record'
  );
  let acquired = false;
  async function* input() {
    acquired = true;
    yield textRow(1, 'x');
  }
  await contractFailure(
    reconstruct(input(), 'zcode', calendar, revoked(limits())),
    'request',
    'unreadable_record'
  );
  expect(acquired).toBe(false);
  const item = textRow(1, 'x');
  item.cells = revoked(item.cells);
  await contractFailure(run([item]), 'request', 'unreadable_cells');
});
