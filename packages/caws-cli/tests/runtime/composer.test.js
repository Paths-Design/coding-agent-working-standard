const {
  composeHandlers,
  ComposerExecutionError,
  normalizeCompositionCapture,
} = require('../../dist/runtime/composer');

const bytes = (value) => Buffer.from(value);
const text = (value) => Buffer.from(value).toString('utf8');
const nativeText = (value) => ({
  exitCode: value.exitCode,
  stdout: text(value.stdout),
  stderr: text(value.stderr),
});
const completion = (stdout = '', exitCode = 0, stderr = '', offers = []) => ({
  stdout: bytes(stdout),
  exitCode,
  stderr: bytes(stderr),
  offers,
});
const envelope = (specific, extra = {}) =>
  JSON.stringify({ ...extra, hookSpecificOutput: specific }) + '\n';
const card = (text, extra = {}) =>
  completion(envelope({ hookEventName: 'PreToolUse', additionalContext: text, ...extra }));
function fixture(outputs, event = 'pre_tool_use', surface = 'codex') {
  const handlers = outputs.map((_, index) =>
    Object.freeze({
      entry: `handler-${index}.sh`,
      name: `handler-${index}.sh`,
      args: [],
      path: `/fixture/handler-${index}.sh`,
      sha256: 'a'.repeat(64),
      tier: 'stock',
      kind: 'stock',
    })
  );
  const selection = {
    status: 'active',
    runtimeDigest: 'b'.repeat(64),
    checkout: '/fixture',
    canonical: '/fixture',
    surface,
    event,
    configuration: 'system',
    runtimeDirectory: '/runtime',
    hooksDirectory: '/runtime',
    handlers,
    libraries: {},
    overrides: {},
    libraryOverrides: {},
    transcriptAdapter: null,
  };
  const deps = {
    execute: jest.fn(async (_, index) => {
      const output = outputs[index];
      if (output instanceof Error) throw output;
      return output;
    }),
    record: jest.fn(async () => {}),
  };
  return {
    selection,
    deps,
    run: (options = {}, overrides = {}) =>
      composeHandlers(selection, options, { ...deps, ...overrides }),
  };
}
const context = (actual) =>
  JSON.parse(text(actual.nativeResult.stdout)).hookSpecificOutput.additionalContext;

test('awaits started/completed observations and executes in selected order', async () => {
  const f = fixture([completion('first\n'), completion('last\n')]);
  const order = [];
  const actual = await f.run(
    {},
    {
      record: async (row) => {
        order.push([row.stage, row.selectedIndex]);
      },
      execute: async (_, index) => {
        order.push(['execute', index]);
        return completion(index ? 'last\n' : 'first\n');
      },
    }
  );
  expect(order).toEqual([
    ['handler_started', 0],
    ['execute', 0],
    ['handler_completed', 0],
    ['handler_started', 1],
    ['execute', 1],
    ['handler_completed', 1],
  ]);
  expect(nativeText(actual.nativeResult)).toEqual({ exitCode: 0, stdout: 'last\n', stderr: '' });
});

test('empty chains are an explicit empty success', async () => {
  const f = fixture([]);
  expect(await f.run()).toEqual({
    nativeResult: { exitCode: 0, stdout: bytes(''), stderr: bytes('') },
    offers: [],
    pendingDedup: [],
  });
  expect(f.deps.execute).not.toHaveBeenCalled();
});

test.each(['block', 'deny'])(
  'hard JSON %s stops every event even without exit2 and preserves refusal under journal failure',
  async (decision) => {
    for (const event of ['pre_tool_use', 'post_tool_use', 'stop']) {
      const refusal = JSON.stringify({ decision, reason: 'required guard condition' });
      const f = fixture(
        [
          card('earlier'),
          completion(refusal + '\n', 0, 'guard detail'),
          completion('must not run'),
        ],
        event
      );
      const actual = await f.run(
        { dryRun: true },
        {
          record: async () => {
            throw new Error('journal unavailable');
          },
        }
      );
      expect(actual.nativeResult.exitCode).toBe(2);
      expect(text(actual.nativeResult.stdout)).toBe(refusal + '\n');
      expect(text(actual.nativeResult.stderr)).toContain('journal unavailable');
      expect(text(actual.nativeResult.stderr)).toContain('[handler-1.sh] guard detail');
      expect(f.deps.execute.mock.calls.map((call) => call[1])).toEqual([0, 1]);
      expect(actual.pendingDedup).toEqual([]);
    }
  }
);

test('nested permission denial and jq false fallback retain hard-refusal precedence', async () => {
  const stdout = envelope(
    { permissionDecision: 'deny', permissionDecisionReason: 'denied' },
    { decision: false }
  );
  const f = fixture([completion(stdout), card('must not run')]);
  expect(nativeText((await f.run()).nativeResult)).toEqual({ exitCode: 2, stdout, stderr: '' });
  expect(f.deps.execute).toHaveBeenCalledTimes(1);
});

test('ask outranks informational output and equal-priority base envelopes select the last', async () => {
  const first = envelope({ permissionDecision: 'ask', permissionDecisionReason: 'first ask' });
  const second = envelope({ permissionDecision: 'ask', permissionDecisionReason: 'last ask' });
  const actual = await fixture([
    completion(first),
    completion('information'),
    completion(second),
    completion('later information'),
  ]).run();
  expect(text(actual.nativeResult.stdout)).toBe(second);
  expect(actual.nativeResult.exitCode).toBe(0);
});

test('bare exit2 short-circuits only pre-tool use, with ordinary maximum-exit aggregation elsewhere', async () => {
  const pre = fixture([completion('guard failed', 2), completion('later')]);
  expect(nativeText((await pre.run()).nativeResult)).toEqual({
    exitCode: 2,
    stdout: 'guard failed\n',
    stderr: '',
  });
  expect(pre.deps.execute).toHaveBeenCalledTimes(1);
  const post = fixture([completion('guard failed', 2), completion('later', 7)], 'post_tool_use');
  expect(nativeText((await post.run()).nativeResult)).toEqual({
    exitCode: 7,
    stdout: 'later\n',
    stderr: '',
  });
  expect(post.deps.execute).toHaveBeenCalledTimes(2);
});

test('Kimi promotes a nonzero exit before making any dedup entries eligible for handoff', async () => {
  const actual = await fixture(
    [card('context'), completion('', 1)],
    'post_tool_use',
    'kimi-code'
  ).run();
  expect(actual.nativeResult.exitCode).toBe(2);
  expect(actual.pendingDedup).toEqual([]);
});

test('dry-run softens exit codes while retaining raw completed observations and no dedup consumption', async () => {
  const f = fixture([completion('', 2), card('visible context')]);
  const actual = await f.run({ dryRun: true });
  expect(actual.nativeResult.exitCode).toBe(0);
  expect(context(actual)).toBe('visible context');
  expect(text(actual.nativeResult.stderr)).toContain('[DRY-RUN] handler-0.sh would have exited 2');
  expect(
    f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0].result.exitCode
  ).toBe(2);
  expect(actual.pendingDedup).toEqual([]);
});

test('advisories compose in order while retaining independently selected input rewrites', async () => {
  const rewrite = completion(
    envelope({
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { file_path: 'safe.ts' },
    })
  );
  const actual = await fixture([card('first'), rewrite, card('second')]).run();
  expect(JSON.parse(text(actual.nativeResult.stdout)).hookSpecificOutput).toEqual({
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: { file_path: 'safe.ts' },
    additionalContext: 'first\n\nsecond',
  });
  expect(
    actual.pendingDedup.map((entry) => [entry.selectedIndex, entry.text, entry.emittedText])
  ).toEqual([
    [0, 'first', 'first'],
    [2, 'second', 'second'],
  ]);
});

test.each([7, null, false, {}, [], ''])(
  'malformed/empty advisory %j remains optional without replacing a base envelope',
  async (value) => {
    const f = fixture([completion('base'), completion(envelope({ additionalContext: value }))]);
    const actual = await f.run();
    expect(actual.nativeResult.exitCode).toBe(0);
    expect(text(actual.nativeResult.stdout)).toBe('base\n');
    expect(text(actual.nativeResult.stderr)).toContain(
      'additionalContext must be a non-empty string'
    );
    expect(actual.pendingDedup).toEqual([]);
  }
);

test('small/zero budgets omit oversized cards while retaining valid earlier members', async () => {
  const outputs = [card('kept'), card('too much text')];
  expect(context(await fixture(outputs).run({ advisoryBudgetBytes: 8 }))).toBe('kept');
  const zero = await fixture(outputs).run({ advisoryBudgetBytes: 0 });
  expect(text(zero.nativeResult.stdout)).toBe('');
  expect(text(zero.nativeResult.stderr)).toContain('optional advisory omitted');
  expect(zero.pendingDedup).toEqual([]);
});

test('oversized first card cannot starve a later small card', async () => {
  const original = 'A'.repeat(5000);
  const actual = await fixture([card(original), card('later card')]).run({
    advisoryBudgetBytes: 400,
  });
  const text = context(actual);
  expect(text).toContain('… [truncated:');
  expect(text.endsWith('\n\nlater card')).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(400);
  expect(actual.pendingDedup[0]).toMatchObject({
    text: original,
    emittedText: text.split('\n\n')[0],
  });
});

test.each([340, 341, 400, 512, 1024])(
  'UTF8 truncation at %s bytes retains a source prefix and accurate elision count',
  async (budget) => {
    const source = '😀é\u0301'.repeat(1000);
    const actual = await fixture([card(source)]).run({ advisoryBudgetBytes: budget });
    const text = context(actual);
    const match = text.match(/^(.*)… \[truncated: ([0-9]+) bytes elided\]$/su);
    expect(match).not.toBeNull();
    const [, prefix, elided] = match;
    expect(source.startsWith(prefix)).toBe(true);
    expect(prefix).not.toContain('\ufffd');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(budget);
    expect(Buffer.byteLength(prefix)).toBeGreaterThanOrEqual(48);
    expect(Number(elided)).toBe(Buffer.byteLength(source) - Buffer.byteLength(prefix));
  }
);

test('invalid numeric options fall back to safe defaults without truncating a fitting card', async () => {
  const source = 'context '.repeat(100);
  const actual = await fixture([card(source)]).run({
    advisoryBudgetBytes: NaN,
    cardShareDivisor: -1,
    cardFloorBytes: Infinity,
  });
  expect(context(actual)).toBe(source);
  expect(text(actual.nativeResult.stderr)).toBe('');
});

test('dedup suppresses only unchanged cards and a failed lookup emits with a diagnostic', async () => {
  const f = fixture([card('seen'), card('new')]);
  const actual = await f.run(
    {},
    {
      dedup: {
        seen: async (_, text) => {
          if (text === 'seen') return true;
          throw new Error('ledger unavailable');
        },
      },
    }
  );
  expect(context(actual)).toBe('new');
  expect(actual.pendingDedup.map((entry) => entry.text)).toEqual(['new']);
  expect(text(actual.nativeResult.stderr)).toContain('advisory suppressed');
  expect(text(actual.nativeResult.stderr)).toContain('dedup unavailable; emitting');
});

test('explicitly disabled dedup emits without lookup or pending ledger mutations', async () => {
  const seen = jest.fn(async () => true);
  const actual = await fixture([card('context')]).run({ dedupEnabled: false }, { dedup: { seen } });
  expect(context(actual)).toBe('context');
  expect(seen).not.toHaveBeenCalled();
  expect(actual.pendingDedup).toEqual([]);
});

test('live offers bypass dedup and actual output membership governs offer selection', async () => {
  const offered = { ...card('live offer'), offers: [{ offerId: 'live', recipient: 'session-a' }] };
  const omitted = {
    ...card('oversized offered context'),
    offers: [{ offerId: 'omitted', recipient: 'session-a' }],
  };
  const seen = jest.fn(async () => true);
  const actual = await fixture([offered, omitted]).run(
    { advisoryBudgetBytes: 10 },
    { dedup: { seen } }
  );
  expect(context(actual)).toBe('live offer');
  expect(actual.offers.map((offer) => [offer.offerId, offer.action])).toEqual([
    ['live', 'selected'],
    ['omitted', 'released'],
  ]);
  expect(actual.pendingDedup).toEqual([]);
  expect(seen).not.toHaveBeenCalled();
});

test.each(['plain base', 'null', '[]', '{"systemMessage":"base"}'])(
  'incompatible final base %s releases offers and consumes no advisory dedup',
  async (base) => {
    const offered = { ...card('offered'), offers: [{ offerId: 'a', recipient: 'session-a' }] };
    const actual = await fixture([card('ordinary'), offered, completion(base)]).run();
    expect(text(actual.nativeResult.stdout)).toBe(base + '\n');
    expect(actual.offers.map((offer) => offer.action)).toEqual(['released']);
    expect(actual.pendingDedup).toEqual([]);
    expect(text(actual.nativeResult.stderr)).toContain('cannot carry additionalContext');
  }
);

test('later hard/bare refusals release earlier offers and leave advice eligible for retry', async () => {
  for (const denial of [completion('{"decision":"block"}'), completion('', 2)]) {
    const offered = { ...card('message'), offers: [{ offerId: 'a', recipient: 'session-a' }] };
    const actual = await fixture([card('ordinary'), offered, denial]).run();
    expect(actual.nativeResult.exitCode).toBe(2);
    expect(actual.offers.map((offer) => offer.action)).toEqual(['released']);
    expect(actual.pendingDedup).toEqual([]);
  }
});

test('explicit reprieve/runtime-disable skips retain original selected indexes', async () => {
  const f = fixture(
    [completion('not executed'), completion('not executed'), completion('last')],
    'post_tool_use'
  );
  const actual = await f.run(
    {},
    {
      eligibility: async (_, index) =>
        index < 2
          ? {
              status: index ? 'runtime-disabled' : 'reprieved',
              reason: 'explicit policy port decision',
            }
          : { status: 'run' },
    }
  );
  expect(f.deps.execute.mock.calls.map((call) => call[1])).toEqual([2]);
  expect(
    f.deps.record.mock.calls
      .filter(([row]) => row.stage === 'handler_skipped')
      .map(([row]) => row.selectedIndex)
  ).toEqual([0, 1]);
  expect(text(actual.nativeResult.stdout)).toBe('last\n');
});

test('runtime disable cannot silently skip a pre-tool guard; unavailable reprieve evaluation runs the guard', async () => {
  const f = fixture([completion('guard executed')]);
  await expect(
    f.run(
      {},
      { eligibility: async () => ({ status: 'runtime-disabled', reason: 'invalid event' }) }
    )
  ).rejects.toThrow(ComposerExecutionError);
  expect(f.deps.execute).not.toHaveBeenCalled();
  const actual = await f.run(
    {},
    {
      eligibility: async () => {
        throw new Error('reprieve cache unavailable');
      },
    }
  );
  expect(text(actual.nativeResult.stdout)).toBe('guard executed\n');
  expect(text(actual.nativeResult.stderr)).toContain('eligibility unavailable; running guard');
});

test('required-handler execution failure is explicit and releases previously offered membership', async () => {
  const offered = { ...card('message'), offers: [{ offerId: 'a', recipient: 'session-a' }] };
  const f = fixture([
    offered,
    new Error('ENOENT: selected executable disappeared'),
    completion('must not run'),
  ]);
  let failure;
  try {
    await f.run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ComposerExecutionError);
  expect(failure.message).toContain('selected executable disappeared');
  expect(failure.offers.map((offer) => [offer.offerId, offer.action])).toEqual([['a', 'released']]);
  expect(f.deps.execute.mock.calls.map((call) => call[1])).toEqual([0, 1]);
  expect(f.deps.record.mock.calls.at(-1)[0].stage).toBe('handler_error');
});

test('invalid executor results fail rather than fabricate a successful missing guard', async () => {
  await expect(fixture([completion('', -1)]).run()).rejects.toThrow(
    'Invalid handler execution result'
  );
});

test('cancellation between handlers stops execution and leaves offered membership released', async () => {
  const controller = new globalThis.AbortController();
  const f = fixture([card('message'), completion('not run')]);
  await expect(
    f.run(
      { signal: controller.signal },
      {
        execute: async (_, index) => {
          expect(index).toBe(0);
          controller.abort('native client departed');
          return { ...card('message'), offers: [{ offerId: 'a', recipient: 'session-a' }] };
        },
      }
    )
  ).rejects.toMatchObject({
    name: 'ComposerExecutionError',
    offers: [expect.objectContaining({ offerId: 'a', action: 'released' })],
  });
});

test.each(['eligibility', 'handler_started'])(
  'cancellation while awaiting %s prevents starting the handler',
  async (stage) => {
    const controller = new globalThis.AbortController();
    const f = fixture([completion('must not execute')]);
    let entered;
    let release;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const pause = async () => {
      entered();
      await blocked;
    };
    const pending = f.run(
      { signal: controller.signal },
      {
        eligibility: async () => {
          if (stage === 'eligibility') await pause();
          return { status: 'run' };
        },
        record: async (row) => {
          if (stage === 'handler_started' && row.stage === stage) await pause();
        },
      }
    );
    const rejected = expect(pending).rejects.toThrow('cancelled');
    await waiting;
    controller.abort('client departed while awaiting dependency');
    release();
    await rejected;
    expect(f.deps.execute).not.toHaveBeenCalled();
  }
);

test('an eligibility failure cannot swallow cancellation and start a handler', async () => {
  const controller = new globalThis.AbortController();
  const f = fixture([completion('must not execute')]);
  await expect(
    f.run(
      { signal: controller.signal },
      {
        eligibility: async () => {
          controller.abort('client departed');
          throw new Error('eligibility unavailable');
        },
      }
    )
  ).rejects.toThrow('cancelled');
  expect(f.deps.execute).not.toHaveBeenCalled();
});

test('cancellation during the final handler cannot return ordinary success but cannot erase a known refusal', async () => {
  for (const refusal of [false, true]) {
    const controller = new globalThis.AbortController();
    const f = fixture([completion('placeholder')]);
    const pending = f.run(
      { signal: controller.signal },
      {
        execute: async () => {
          controller.abort('client departed');
          return refusal
            ? completion('{"decision":"block","reason":"known guard refusal"}')
            : completion('ordinary success');
        },
      }
    );
    if (refusal)
      expect(nativeText((await pending).nativeResult)).toMatchObject({
        exitCode: 2,
        stdout: '{"decision":"block","reason":"known guard refusal"}\n',
      });
    else await expect(pending).rejects.toThrow('cancelled');
  }
});

test('raw captures stay journaled while composition explicitly normalizes shell trailing newlines', async () => {
  const f = fixture([completion('plain\n\n', 0, 'unterminated diagnostic')]);
  const actual = await f.run();
  expect(normalizeCompositionCapture(bytes('a\n\nb\n\n'))).toEqual(bytes('a\n\nb'));
  expect(nativeText(actual.nativeResult)).toEqual({
    exitCode: 0,
    stdout: 'plain\n',
    stderr: '[handler-0.sh] unterminated diagnostic\n',
  });
  expect(
    f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0].result.stdout
  ).toEqual(bytes('plain\n\n'));
  expect(
    f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0].result.stderr
  ).toEqual(bytes('unterminated diagnostic'));
});

test('interleaved compositions do not share advisory state or dedup membership', async () => {
  let resume;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const a = fixture([card('session-a')]);
  const pending = a.run(
    {},
    {
      execute: () =>
        new Promise((resolve) => {
          resume = resolve;
          markStarted();
        }),
    }
  );
  await started;
  const b = await fixture([card('session-b')]).run();
  resume(card('session-a'));
  const finished = await pending;
  expect(context(b)).toBe('session-b');
  expect(context(finished)).toBe('session-a');
  expect(b.pendingDedup.map((entry) => entry.text)).toEqual(['session-b']);
  expect(finished.pendingDedup.map((entry) => entry.text)).toEqual(['session-a']);
});

test('opaque native stdout and stderr retain nonUTF8 and NUL bytes through defined composition framing', async () => {
  const rawStdout = Buffer.from([0xff, 0x00, 0x61]);
  const rawStderr = Buffer.from([0xfe, 0x00, 0x62, 0x0a, 0x00, 0xff]);
  const f = fixture([completion(rawStdout, 0, rawStderr)], 'post_tool_use', 'claude-code');
  const actual = await f.run();
  expect(actual.nativeResult.stdout).toEqual(Buffer.from([0xff, 0x00, 0x61, 0x0a]));
  expect(actual.nativeResult.stderr).toEqual(
    Buffer.concat([
      bytes('[handler-0.sh] '),
      Buffer.from([0xfe, 0x00, 0x62, 0x0a]),
      bytes('[handler-0.sh] '),
      Buffer.from([0x00, 0xff, 0x0a]),
    ])
  );
  const captured = f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0]
    .result;
  expect(captured.stdout).toEqual(rawStdout);
  expect(captured.stderr).toEqual(rawStderr);
  expect(captured.stdout).not.toBe(rawStdout);
});

test('raw normalization strips only terminal LF bytes and leaves the original capture unchanged', async () => {
  const raw = Buffer.from([0xff, 0x00, 0x61, 0x0d, 0x0a, 0x0a]);
  expect(normalizeCompositionCapture(raw)).toEqual(Buffer.from([0xff, 0x00, 0x61, 0x0d]));
  const f = fixture([completion(raw)]);
  const actual = await f.run();
  expect(actual.nativeResult.stdout).toEqual(Buffer.from([0xff, 0x00, 0x61, 0x0d, 0x0a]));
  expect(raw).toEqual(Buffer.from([0xff, 0x00, 0x61, 0x0d, 0x0a, 0x0a]));
  expect(
    f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0].result.stdout
  ).toEqual(raw);
});

test('invalid UTF8 inside a JSON reason cannot erase a hard refusal or reencode its raw bytes', async () => {
  const raw = Buffer.concat([
    bytes('{"decision":"block","reason":"'),
    Buffer.from([0xff]),
    bytes('"}\n\n'),
  ]);
  const f = fixture([completion(raw), completion('must not run')]);
  const actual = await f.run();
  expect(actual.nativeResult.exitCode).toBe(2);
  expect(actual.nativeResult.stdout).toEqual(
    Buffer.concat([raw.subarray(0, raw.length - 2), bytes('\n')])
  );
  expect(f.deps.execute).toHaveBeenCalledTimes(1);
  expect(
    f.deps.record.mock.calls.find(([row]) => row.stage === 'handler_completed')[0].result.stdout
  ).toEqual(raw);
});

test('a mutating failed observer cannot alter decision-owned bytes or an executor-owned refusal', async () => {
  const raw = completion(
    Buffer.concat([bytes('{"decision":"block","reason":"'), Buffer.from([0xff]), bytes('"}')]),
    2,
    Buffer.from([0xfe, 0x00])
  );
  const originalStdout = Buffer.from(raw.stdout);
  const originalStderr = Buffer.from(raw.stderr);
  const observed = [];
  const f = fixture([raw, completion('must not run')]);
  const actual = await f.run(
    {},
    {
      record: async (row) => {
        if (row.stage !== 'handler_completed') return;
        observed.push({
          stdout: Buffer.from(row.result.stdout),
          stderr: Buffer.from(row.result.stderr),
        });
        row.result.stdout.fill(0);
        row.result.stderr.fill(0);
        raw.stdout.fill(0);
        raw.stderr.fill(0);
        throw new Error('observer failed after modifying its copies');
      },
    }
  );
  expect(observed).toEqual([{ stdout: originalStdout, stderr: originalStderr }]);
  expect(actual.nativeResult.exitCode).toBe(2);
  expect(actual.nativeResult.stdout).toEqual(Buffer.concat([originalStdout, bytes('\n')]));
  expect(actual.nativeResult.stderr).toEqual(
    Buffer.concat([
      bytes(
        '[composer journal] incomplete: Error: observer failed after modifying its copies\n[handler-0.sh] '
      ),
      originalStderr,
      bytes('\n'),
    ])
  );
  expect(f.deps.execute).toHaveBeenCalledTimes(1);
});

test('advisory composition encodes generated JSON at an explicit UTF8 boundary', async () => {
  const first = '\ufeffcontext😀\n\n';
  const actual = await fixture([card(first), card('é second')]).run();
  const expected =
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: '\ufeffcontext😀\n\né second',
      },
    }) + '\n';
  expect(actual.nativeResult.stdout).toEqual(bytes(expected));
  expect(actual.pendingDedup.map((entry) => entry.text)).toEqual(['\ufeffcontext😀', 'é second']);
});

test('opaque base displacement releases advisory membership without replacing invalid bytes', async () => {
  const opaque = Buffer.from([0xff, 0x00, 0x61]);
  const offered = {
    ...card('offered context'),
    offers: [{ offerId: 'binary-base', recipient: 'session-a' }],
  };
  const actual = await fixture([card('ordinary'), offered, completion(opaque)]).run();
  expect(actual.nativeResult.stdout).toEqual(Buffer.concat([opaque, bytes('\n')]));
  expect(actual.offers.map((offer) => [offer.offerId, offer.action])).toEqual([
    ['binary-base', 'released'],
  ]);
  expect(actual.pendingDedup).toEqual([]);
});

test('execution failure retains previously captured opaque stderr in its error boundary', async () => {
  const f = fixture([
    completion('', 0, Buffer.from([0xff, 0x00])),
    new Error('selected guard disappeared'),
  ]);
  let failure;
  try {
    await f.run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ComposerExecutionError);
  expect(failure.stderr).toEqual(
    Buffer.concat([bytes('[handler-0.sh] '), Buffer.from([0xff, 0x00, 0x0a])])
  );
  expect(failure.message).toContain('selected guard disappeared');
});
