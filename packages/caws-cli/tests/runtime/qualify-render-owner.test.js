'use strict';

// Executes the exact qualifier accounting declarations without launching main.
// Synthetic events exercise accounting only, not native cleanup or custody.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync(
  path.resolve(__dirname, '../../scripts/qualify-render-owner.ts'),
  'utf8'
);
function loadAccounting(text = source, warmSessionEnd = true) {
  const tree = ts.createSourceFile('qualify-render-owner.ts', text, ts.ScriptTarget.ES2022, true);
  assert.equal(tree.parseDiagnostics.length, 0, 'qualifier source must parse');
  const names = ['object', 'row', 'workerCleanupAccounting', 'warmFixtureUsage', 'transcript'];
  const declarations = tree.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
  );
  assert.deepEqual(
    declarations.map((node) => node.name.text).sort(),
    [...names].sort(),
    'exact accounting declarations required'
  );
  const types = tree.statements.filter(
    (node) => ts.isTypeAliasDeclaration(node) && node.name.text === 'Data'
  );
  assert.equal(types.length, 1, 'exact accounting data type required');
  const selected = [...types, ...declarations].map((node) => node.getText(tree)).join('\n');
  const compiled = ts.transpileModule(selected, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    reportDiagnostics: true,
  });
  assert.deepEqual(compiled.diagnostics, [], 'accounting declarations must transpile');
  const context = {
    assert,
    module: { exports: {} },
    warmSessionEnd,
    project: '/private/qualifier-fixture/project',
  };
  vm.runInNewContext(
    compiled.outputText + '\nmodule.exports = { account: workerCleanupAccounting, transcript };',
    context,
    { timeout: 1000 }
  );
  return context.module.exports;
}
const { account, transcript } = loadAccounting();
function worker(nativeWorkerPid, backendPid) {
  const identity = { nativeWorkerPid, backendPid };
  return [
    { event: 'worker_spawned', nativeWorkerPid },
    { event: 'worker_created', ...identity },
    {
      event: 'worker_cleanup',
      ...identity,
      receipt: {
        childPid: backendPid,
        directChildReaped: true,
        logsPersisted: true,
        deadlineExceeded: false,
        stdout: { eof: true },
        stderr: { eof: true },
      },
    },
    { event: 'worker_exit', ...identity, code: 0, signal: null },
  ];
}

test('warm input supplies recognized per-turn Codex usage before the next turn boundary', () => {
  const rows = transcript(2).trimEnd().split('\n').map(JSON.parse);
  const usage = rows.filter((item) => item.type === 'token_usage_record');
  expect(usage.map((item) => item.payload.usage)).toEqual([
    {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 5,
      cached_input_tokens: 20,
      reasoning_output_tokens: 11,
      total_tokens: 130,
    },
    {
      input_tokens: 200,
      output_tokens: 60,
      cache_read_input_tokens: 14,
      cache_creation_input_tokens: 10,
      cached_input_tokens: 40,
      reasoning_output_tokens: 22,
      total_tokens: 260,
    },
  ]);
  expect(rows.indexOf(usage[0])).toBe(5);
  expect(rows[6].type).toBe('turn_context');
  expect(rows[11]).toBe(usage[1]);
  expect(
    rows.filter((item) => item.type === 'turn_context').map((item) => item.payload.model)
  ).toEqual(['owner-fixture-model', 'owner-fixture-model']);
});

test('default fixture retains its original transcript grammar without warm usage additions', () => {
  const { transcript: originalTranscript } = loadAccounting(source, false);
  const rows = originalTranscript(2).trimEnd().split('\n').map(JSON.parse);
  expect(rows).toHaveLength(10);
  expect(rows.filter((item) => item.type === 'token_usage_record')).toEqual([]);
  expect(rows[5].payload.turn_id).toBe('owner-turn-2');
});

test('failed before B owes exactly the A birth, cleanup and exit, not an invented B', () => {
  const a = worker(100, 101);
  const result = account(a, null);
  expect(result.created).toEqual([a[1]]);
  expect(result.receipts).toEqual([a[2]]);
  expect(result.exits).toEqual([a[3]]);
  expect(() => account(a, 2)).toThrow('complete scenario worker creation count');
});

test('complete warm success requires two exact worker tuples', () => {
  const a = worker(100, 101),
    b = worker(200, 201);
  const result = account([...a, { event: 'unrelated' }, ...b], 2);
  expect(result.created).toEqual([a[1], b[1]]);
  expect(result.receipts).toEqual([a[2], b[2]]);
  expect(result.exits).toEqual([a[3], b[3]]);
  expect(() => account([...a, ...b], 1)).toThrow('complete scenario worker creation count');
});

test('no owned worker is permitted only for an incomplete scenario', () => {
  expect(account([], null)).toEqual({ created: [], receipts: [], exits: [] });
  expect(() => account([], 2)).toThrow('complete scenario worker creation count');
});

test.each(['worker_cleanup', 'worker_exit'])(
  '%s cannot borrow another created worker backend',
  (event) => {
    const rows = [...worker(100, 101), ...worker(200, 201)];
    rows.find((item) => item.event === event).backendPid = 201;
    expect(() => account(rows, 2)).toThrow('names an uncreated tuple');
  }
);

test.each(['worker_cleanup', 'worker_exit'])(
  '%s duplicate cannot hide another missing tuple',
  (event) => {
    const rows = [...worker(100, 101), ...worker(200, 201)];
    const first = rows.find((item) => item.event === event);
    Object.assign(
      rows.find((item) => item.event === event && item.nativeWorkerPid === 200),
      first
    );
    expect(() => account(rows, 2)).toThrow('duplicate worker');
  }
);

test.each(['worker_cleanup', 'worker_exit'])(
  '%s missing or orphaned receipt refuses even after scenario failure',
  (event) => {
    const rows = worker(100, 101);
    expect(() =>
      account(
        rows.filter((item) => item.event !== event),
        null
      )
    ).toThrow('receipt missing');
    expect(() => account([rows.find((item) => item.event === event)], null)).toThrow(
      'receipt missing'
    );
  }
);

test('spawned worker without a created backend cannot disappear from cleanup accounting', () => {
  expect(() => account([{ event: 'worker_spawned', nativeWorkerPid: 100 }], null)).toThrow(
    'spawned worker lacks a created worker receipt'
  );
});

test('created worker must have its own unique exact spawn', () => {
  const rows = worker(100, 101);
  rows[0].nativeWorkerPid = 200;
  expect(() => account(rows, null)).toThrow('created worker lacks its exact spawn');
  expect(() => account([...worker(100, 101), ...worker(100, 201)], null)).toThrow(
    'one native worker must name one backend'
  );
  expect(() => account([...worker(100, 101), ...worker(100, 101)], null)).toThrow(
    'duplicate created worker tuple'
  );
});

test('cleanup must follow creation and precede native exit', () => {
  const rows = worker(100, 101);
  expect(() => account([rows[0], rows[2], rows[1], rows[3]], null)).toThrow(
    'worker birth/cleanup/exit order differs'
  );
  expect(() => account([rows[0], rows[1], rows[3], rows[2]], null)).toThrow(
    'worker birth/cleanup/exit order differs'
  );
});

test.each([
  'childPid',
  'directChildReaped',
  'logsPersisted',
  'deadlineExceeded',
  'stdout',
  'stderr',
])('cleanup %s must establish the exact backend and both complete streams', (field) => {
  const rows = worker(100, 101);
  const wrong = {
    childPid: 201,
    directChildReaped: false,
    logsPersisted: false,
    deadlineExceeded: true,
    stdout: { eof: false },
    stderr: { eof: false },
  };
  rows[2].receipt[field] = wrong[field];
  expect(() => account(rows, null)).toThrow();
});

test.each([{ code: 1 }, { signal: 'SIGKILL' }])(
  'native worker unsuccessful terminal refuses: %j',
  (terminal) => {
    const rows = worker(100, 101);
    Object.assign(rows[3], terminal);
    expect(() => account(rows, null)).toThrow('native worker exit');
  }
);

test.each([0, 1, -1, 2_147_483_648, 1.5, '100', undefined])(
  'invalid worker PID %s cannot become a receipt identity',
  (nativeWorkerPid) => {
    expect(() => account(worker(nativeWorkerPid, 101), null)).toThrow('invalid worker tuple');
  }
);

test('the isolated loader refuses missing or extra accounting declarations', () => {
  expect(() =>
    loadAccounting(source.replace('function workerCleanupAccounting(', 'function other('))
  ).toThrow('exact accounting declarations required');
  expect(() => loadAccounting(source + '\nfunction workerCleanupAccounting() {}\n')).toThrow(
    'exact accounting declarations required'
  );
});
