import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import {
  correlateRequestCustody,
  correlateMissingSidPreToolUseCustody,
  type MissingSidPreToolUseExpectation,
  type MissingSidPreToolUseFirstExpectation,
  combinedRequestCleanup,
  decodeInvocationIdentity,
  MAX_CUSTODY_CONFIG,
  MAX_CUSTODY_JOURNAL,
  MAX_TYPED_JOURNAL,
  RequestCustodyCollector,
  type CustodyCandidate,
  type CustodyExpectation,
} from './render-request-custody';
type Row = Record<string, unknown>;
const digest = 'a'.repeat(64);
function expectation(): CustodyExpectation {
  const chain = [
    { pid: 100, parent: 12, group: 42, startSeconds: '1000', startMicros: '12', zombie: false },
    { pid: 200, parent: 100, group: 200, startSeconds: '1001', startMicros: '13', zombie: false },
    { pid: 300, parent: 200, group: 300, startSeconds: '1002', startMicros: '14', zombie: false },
  ];
  return {
    invocationId: 'independent-typed-request',
    runtimeDigest: digest,
    node: '/selected/node',
    engine: '/selected/engine.js',
    coverage: {
      expected: {
        platform: 'darwin',
        frontendPid: 100,
        frontendCommand: '/selected/native invoke',
        native: '/selected/native',
        node: '/selected/node',
        engine: '/selected/engine.js',
      },
      originalFrontend: { state: 'observed', process: { ...chain[0] } },
      confirmedChains: [chain],
      witnesses: chain,
    },
  };
}
function config(): Row {
  return {
    schema: 'caws.engine.custody.configuration.v1',
    invocation_id: 'independent-typed-request',
    runtime_digest: digest,
    node: '/selected/node',
    engine: '/selected/engine.js',
    control_fd: 32,
    receipt_fd: 33,
    render_fds: [34, 35, 36],
  };
}
function group(): Row {
  return {
    reason: 0,
    query_errno: 0,
    bytes: 648,
    capacity: 2000,
    members: 1,
    zombies: 1,
    leaders: 1,
  };
}
function started(): Row {
  return {
    schema: 'caws.engine.custody.receipt.v1',
    invocation_id: 'independent-typed-request',
    runtime_digest: digest,
    sequence: 1,
    custodian_pid: 200,
    node_pid: 300,
    state: 'started',
    reason: null,
    stop: null,
    settlement: null,
    child_exit_raw: null,
    stdout_eof: false,
    stderr_eof: false,
    stdout_bytes: 0,
    stderr_bytes: 0,
    output_discarded: false,
    frontend_output_errno: null,
    error: null,
  };
}
function complete(): Row {
  return {
    ...started(),
    sequence: 2,
    state: 'complete',
    reason: 'frontend_stop',
    stop: { Ok: 'Signalled' },
    settlement: { Ok: { Exited: { observation: group() } } },
    child_exit_raw: 0,
    stdout_eof: true,
    stderr_eof: true,
    stdout_bytes: 150,
    stderr_bytes: 20,
  };
}
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const journal = (rows: Row[]) =>
  Buffer.from(rows.map((row) => JSON.stringify(row) + '\n').join(''));
function candidate(rows = [started(), complete()]): CustodyCandidate {
  return {
    source: '/private/request/opaque-directory-name',
    configuration: bytes(config()),
    journal: journal(rows),
    previousJournal: null,
  };
}
function observe(candidates = [candidate()], expected = expectation()) {
  return correlateRequestCustody(candidates, expected);
}
function missingExpectation(source = candidate().source): MissingSidPreToolUseExpectation {
  const original = expectation();
  const { invocationId, ...withoutTypedIdentity } = original;
  void invocationId;
  const args = [
    'invoke',
    '--engine',
    original.engine,
    '--node',
    original.node,
    '--surface',
    'codex',
    '--event',
    'pre_tool_use',
    '--runtime-digest',
    digest,
    '--timeout-ms',
    '30000',
    '--configuration',
    'system',
  ];
  original.coverage.expected!.frontendCommand = ['/selected/native', ...args].join(' ');
  const rawInput = bytes({ tool_name: 'Bash', tool_input: { command: 'true' } });
  return {
    ...withoutTypedIdentity,
    request: {
      executable: '/selected/native',
      args,
      rawInput,
      inputSha256: createHash('sha256').update(rawInput).digest('hex'),
      temporary: path.dirname(source),
      configuration: {
        source,
        sha256: createHash('sha256').update(candidate().configuration).digest('hex'),
        invocationId: 'independent-typed-request',
      },
    },
  };
}
test('missing-SID PreToolUse uses exact original native custody with explicit provenance', () => {
  const result = correlateMissingSidPreToolUseCustody([candidate()], missingExpectation());
  assert.equal(result.state, 'confirmed_settled');
  assert.equal(result.provenance, 'native-only-missing-sid-pre-tool-use');
  assert.equal(result.invocationId, 'independent-typed-request');
  assert.deepEqual(result.terminal, complete());
  assert.equal(result.inputSha256, missingExpectation().request.inputSha256);
  assert.throws(() => decodeInvocationIdentity(Buffer.alloc(0), digest, 'b'.repeat(64)));
});
const missingFaults: [
  string,
  (e: MissingSidPreToolUseExpectation, c: CustodyCandidate[]) => void,
][] = [
  [
    'Stop event',
    (e) => {
      (e.request.args as string[])[8] = 'stop';
    },
  ],
  [
    'over-limit native timeout',
    (e) => {
      (e.request.args as string[])[12] = '120001';
      e.coverage.expected!.frontendCommand = [e.request.executable, ...e.request.args].join(' ');
    },
  ],
  [
    'different original command',
    (e) => {
      e.coverage.expected!.frontendCommand += ' --event stop';
    },
  ],
  [
    'foreign executable',
    (e) => {
      e.request.executable = '/foreign/native';
    },
  ],
  [
    'different input hash',
    (e) => {
      e.request.inputSha256 = '0'.repeat(64);
    },
  ],
  [
    'payload session identity',
    (e) => {
      e.request.rawInput = bytes({ session_id: 'old' });
      e.request.inputSha256 = createHash('sha256').update(e.request.rawInput).digest('hex');
    },
  ],
  [
    'empty payload session identity',
    (e) => {
      e.request.rawInput = bytes({ session_id: '' });
      e.request.inputSha256 = createHash('sha256').update(e.request.rawInput).digest('hex');
    },
  ],
  [
    'alternate session key',
    (e) => {
      e.request.rawInput = bytes({ sessionId: 'old' });
      e.request.inputSha256 = createHash('sha256').update(e.request.rawInput).digest('hex');
    },
  ],
  [
    'old original birth',
    (e) => {
      (e.coverage.originalFrontend as { process: { startMicros: string } }).process.startMicros =
        '999';
    },
  ],
  [
    'foreign chain',
    (e) => {
      e.coverage.confirmedChains[0]![1]!.parent = 999;
    },
  ],
  [
    'missing chain',
    (e) => {
      e.coverage.confirmedChains = [];
    },
  ],
  [
    'missing configuration',
    (_e, c) => {
      c.length = 0;
    },
  ],
  [
    'ambiguous configuration',
    (_e, c) => {
      c.push(candidate());
    },
  ],
  [
    'copied configuration directory',
    (_e, c) => {
      c[0]!.source = '/private/foreign/opaque';
    },
  ],
  [
    'foreign private root',
    (e) => {
      e.request.temporary = '/private/foreign';
    },
  ],
  [
    'changed configuration bytes',
    (_e, c) => {
      c[0]!.configuration = bytes({ ...config(), control_fd: 35 });
    },
  ],
  [
    'PID-prefix native ID',
    (e) => {
      e.request.configuration.invocationId = '100-spoofed';
    },
  ],
  [
    'foreign journal PID',
    (_e, c) => {
      c[0]!.journal = journal([{ ...started(), custodian_pid: 999 }, complete()]);
    },
  ],
  [
    'partial cleanup record',
    (_e, c) => {
      c[0]!.journal = c[0]!.journal.subarray(0, -1);
    },
  ],
  [
    'rewritten journal prefix',
    (_e, c) => {
      c[0]!.previousJournal = Buffer.from('foreign');
    },
  ],
  [
    'missing actual EOF',
    (_e, c) => {
      c[0]!.journal = journal([started(), { ...complete(), stdout_eof: false }]);
    },
  ],
];
for (const [name, change] of missingFaults)
  test('missing-SID branch refuses ' + name, () => {
    const e = missingExpectation(),
      c = [candidate()];
    change(e, c);
    const result = correlateMissingSidPreToolUseCustody(c, e);
    assert.equal(result.state, 'unknown', name);
    assert.notEqual(result.error, null, name);
  });
test('current native Child receipts correlate by content, without PID filename/ID prefix assumptions', () => {
  const result = observe();
  assert.equal(result.state, 'confirmed_settled');
  assert.equal(result.error, null);
  assert.equal(result.source, '/private/request/opaque-directory-name');
  assert.deepEqual(result.terminal, complete());
  for (const stop of [{ Ok: 'Absent' }, { Ok: { ExitedOnly: { observation: group() } } }]) {
    const final = { ...complete(), stop };
    assert.equal(observe([candidate([started(), final])]).state, 'confirmed_settled');
  }
});
test('SDK member counters match native u32 ranges in stop and settlement observations', () => {
  const maximum = { ...group(), members: 0xffff_ffff, zombies: 0xffff_ffff };
  const valid = { ...complete(), settlement: { Ok: { Exited: { observation: maximum } } } };
  assert.equal(observe([candidate([started(), valid])]).state, 'confirmed_settled');
  const oversized = { ...group(), members: 2 ** 32, zombies: 2 ** 32 };
  const invalidSettlement = {
    ...complete(),
    settlement: { Ok: { Exited: { observation: oversized } } },
  };
  assert.equal(observe([candidate([started(), invalidSettlement])]).state, 'unknown');
  for (const observation of [oversized, { ...group(), leaders: 2 ** 32 }]) {
    const invalidStop = { ...complete(), stop: { Ok: { ExitedOnly: { observation } } } };
    assert.equal(observe([candidate([started(), invalidStop])]).state, 'unknown');
  }
});
test('prior invocation cannot qualify the next request or lend its confirmed chain', () => {
  assert.equal(observe().state, 'confirmed_settled');
  const next = expectation();
  next.invocationId = 'different-next-request';
  assert.equal(observe([candidate()], next).state, 'unknown');
  next.coverage.confirmedChains = [];
  assert.equal(observe([candidate()], next).state, 'unknown');
  const changed = expectation();
  (changed.coverage.originalFrontend as { process: { startMicros: string } }).process.startMicros =
    '999';
  assert.equal(observe([candidate()], changed).state, 'unknown');
  changed.coverage.originalFrontend = { state: 'unavailable' };
  assert.equal(observe([candidate()], changed).state, 'unknown');
});
for (const key of ['invocation_id', 'runtime_digest', 'node', 'engine'])
  test('rejects wrong configuration ' + key, () => {
    const c = candidate();
    c.configuration = bytes({ ...config(), [key]: 'other' });
    assert.equal(observe([c]).state, 'unknown');
  });
for (const key of ['invocation_id', 'runtime_digest', 'custodian_pid', 'node_pid'])
  test('rejects wrong receipt ' + key, () => {
    const final = { ...complete(), [key]: key.endsWith('_pid') ? 999 : 'other' };
    assert.equal(observe([candidate([started(), final])]).state, 'unknown');
  });
test('zero/multiple matching configurations and malformed configuration are unknown', () => {
  assert.equal(observe([]).state, 'unknown');
  assert.equal(observe([candidate(), candidate()]).state, 'unknown');
  for (const configuration of [
    Buffer.from('{'),
    Buffer.alloc(MAX_CUSTODY_CONFIG + 1, 32),
    bytes({ ...config(), extra: 1 }),
    Buffer.from('{"schema":1,"schema":2}'),
  ])
    assert.equal(observe([{ ...candidate(), configuration }]).state, 'unknown');
});
test('partial, malformed, oversized, truncated and rewritten journals never qualify', () => {
  const c = candidate();
  for (const body of [
    Buffer.alloc(0),
    Buffer.from('{\n'),
    Buffer.from([255, 10]),
    Buffer.alloc(MAX_CUSTODY_JOURNAL + 1, 10),
    c.journal.subarray(0, c.journal.length - 1),
    Buffer.concat([Buffer.from(c.journal), Buffer.from('{')]),
    journal([complete()]),
  ])
    assert.equal(observe([{ ...c, journal: body }]).state, 'unknown');
  assert.equal(
    observe([
      { ...c, previousJournal: Buffer.concat([Buffer.from(c.journal), Buffer.from('more')]) },
    ]).state,
    'unknown'
  );
  const rewritten = Buffer.from(c.journal);
  rewritten[1] = 32;
  assert.equal(observe([{ ...c, previousJournal: rewritten }]).state, 'unknown');
  assert.equal(
    observe([{ ...c, previousJournal: journal([started()]) }]).state,
    'confirmed_settled'
  );
  const duplicate = Buffer.from(
    Buffer.from(c.journal).toString().replace('"sequence":1', '"sequence":1,"sequence":2')
  );
  assert.equal(observe([{ ...c, journal: duplicate }]).state, 'unknown');
});
const hostile: Array<[string, (rows: Row[]) => void]> = [
  [
    'sequence regression',
    (r) => {
      r[1]!.sequence = 1;
    },
  ],
  [
    'changed PID',
    (r) => {
      r[1]!.node_pid = 301;
    },
  ],
  [
    'stdout counter regression',
    (r) => {
      r[0]!.stdout_bytes = 200;
    },
  ],
  [
    'stderr counter regression',
    (r) => {
      r[0]!.stderr_bytes = 200;
    },
  ],
  [
    'stdout EOF regression',
    (r) => {
      r[0]!.stdout_eof = true;
      r[1]!.stdout_eof = false;
    },
  ],
  [
    'stderr EOF regression',
    (r) => {
      r[0]!.stderr_eof = true;
      r[1]!.stderr_eof = false;
    },
  ],
  [
    'discard flag regression',
    (r) => {
      r[0]!.output_discarded = true;
    },
  ],
  [
    'reap status changed',
    (r) => {
      r[0]!.child_exit_raw = 9;
    },
  ],
  [
    'postterminal record',
    (r) => {
      r.push({ ...complete(), sequence: 3 });
    },
  ],
  [
    'pending final state',
    (r) => {
      r[1]!.state = 'pending';
    },
  ],
  [
    'missing EOF',
    (r) => {
      r[1]!.stderr_eof = false;
    },
  ],
  [
    'missing actual reap',
    (r) => {
      r[1]!.child_exit_raw = null;
    },
  ],
  [
    'failed stop',
    (r) => {
      r[1]!.stop = {
        Err: {
          stage: 'Signal',
          raw_errno: 1,
          signal_errno: 1,
          observed_pid: null,
          observed_code: null,
          group: null,
        },
      };
    },
  ],
  [
    'live SDK group',
    (r) => {
      r[1]!.settlement = { Ok: { GroupLive: { observation: group() } } };
    },
  ],
  [
    'running SDK leader',
    (r) => {
      r[1]!.settlement = { Ok: 'LeaderRunning' };
    },
  ],
  [
    'failed SDK query',
    (r) => {
      r[1]!.settlement = {
        Err: {
          stage: 'Snapshot',
          raw_errno: 1,
          observed_pid: null,
          observed_code: null,
          before: null,
          after: null,
          group: null,
        },
      };
    },
  ],
  [
    'terminal error',
    (r) => {
      r[1]!.error = 'unsettled';
    },
  ],
  [
    'unknown field',
    (r) => {
      r[1]!.unexpected = true;
    },
  ],
  [
    'wrong scalar type',
    (r) => {
      r[1]!.stdout_eof = 'true';
    },
  ],
];
for (const [name, change] of hostile)
  test('rejects ' + name, () => {
    const rows = [started(), complete()];
    change(rows);
    assert.equal(observe([candidate(rows)]).state, 'unknown');
  });
for (const [key, value] of [
  ['reason', 1],
  ['query_errno', 1],
  ['bytes', 0],
  ['bytes', 2000],
  ['capacity', 0],
  ['members', 0],
  ['zombies', 0],
  ['leaders', 0],
  ['leaders', 2],
] as const)
  test('strict native terminal SDK condition ' + key + '=' + value, () => {
    const final = complete();
    final.settlement = { Ok: { Exited: { observation: { ...group(), [key]: value } } } };
    assert.equal(observe([candidate([started(), final])]).state, 'unknown');
  });
test('no-child cleanup cannot qualify actual selected Node execution', () => {
  const noChild = {
    ...started(),
    state: 'no_child',
    node_pid: null,
    stdout_eof: true,
    stderr_eof: true,
  };
  assert.equal(observe([candidate([noChild])]).state, 'unknown');
});
test('UTF-8 BOM cannot turn malformed native configuration, receipt or typed journal into evidence', () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const current = candidate();
  assert.equal(
    observe([{ ...current, configuration: Buffer.concat([bom, current.configuration]) }]).state,
    'unknown'
  );
  assert.equal(
    observe([{ ...current, journal: Buffer.concat([bom, current.journal]) }]).state,
    'unknown'
  );
  const typed = journal([
    {
      schema: 'caws.hook_invocation.v1',
      invocation_id: 'independent-typed-request',
      runtime_digest: digest,
      input_sha256: 'b'.repeat(64),
      surface: 'codex',
      event: 'stop',
      stage: 'invocation_started',
    },
  ]);
  assert.deepEqual(decodeInvocationIdentity(typed, digest, 'b'.repeat(64)), {
    invocationId: 'independent-typed-request',
    runtimeDigest: digest,
  });
  assert.throws(() =>
    decodeInvocationIdentity(Buffer.concat([bom, typed]), digest, 'b'.repeat(64))
  );
});
test('native settled receipt and actual process absence are separate required observations', () => {
  const settled = observe();
  assert.equal(
    combinedRequestCleanup({ state: 'confirmed_inactive' }, settled),
    'confirmed_inactive'
  );
  for (const state of ['unknown', 'live', 'not_observed'])
    assert.equal(combinedRequestCleanup({ state }, settled), 'unknown');
  assert.equal(
    combinedRequestCleanup({ state: 'confirmed_inactive' }, { state: 'unknown' }),
    'unknown'
  );
});
test('independent typed journal identity binds runtime, exact input digest, event and all rows', () => {
  const metadata = {
    schema: 'caws.hook_invocation.v1',
    invocation_id: 'independent-typed-request',
    runtime_digest: digest,
    input_sha256: 'b'.repeat(64),
    surface: 'codex',
    event: 'stop',
  };
  const rows = [
    { ...metadata, stage: 'invocation_started' },
    { ...metadata, stage: 'adapter_finished' },
  ];
  assert.deepEqual(decodeInvocationIdentity(journal(rows), digest, 'b'.repeat(64)), {
    invocationId: 'independent-typed-request',
    runtimeDigest: digest,
  });
  for (const key of ['invocation_id', 'runtime_digest', 'input_sha256', 'surface', 'event']) {
    const changed = [{ ...rows[0] }, { ...rows[1], [key]: 'other' }];
    assert.throws(() => decodeInvocationIdentity(journal(changed), digest, 'b'.repeat(64)));
  }
  for (const body of [
    journal(rows).subarray(0, -1),
    Buffer.alloc(MAX_TYPED_JOURNAL + 1, 10),
    Buffer.from('{\n'),
  ])
    assert.throws(() => decodeInvocationIdentity(body, digest, 'b'.repeat(64)));
});

type FilesystemFixture = {
  root: string;
  temporary: string;
  directory: string;
  configuration: string;
  journal: string;
  collector: RequestCustodyCollector;
};
function withFilesystem(action: (fixture: FilesystemFixture) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-request-custody-unit-'));
  try {
    const temporary = path.join(root, 'tmp');
    const directory = path.join(temporary, 'opaque');
    fs.mkdirSync(temporary, { mode: 0o700 });
    fs.mkdirSync(directory, { mode: 0o700 });
    const configuration = path.join(directory, 'configuration.json');
    const journalFile = path.join(directory, 'cleanup.jsonl');
    fs.writeFileSync(configuration, bytes(config()), { mode: 0o400 });
    fs.writeFileSync(journalFile, journal([started(), complete()]), { mode: 0o600 });
    action({
      root,
      temporary,
      directory,
      configuration,
      journal: journalFile,
      collector: new RequestCustodyCollector(temporary, path.join(root, 'snapshots')),
    });
  } finally {
    // Only this test's exclusively created directory is removed; no process exists.
    fs.rmSync(root, { recursive: true, force: true });
  }
}
test('collector retains exact private native bytes, hashes and original inode provenance', () => {
  withFilesystem((f) => {
    const result = f.collector.collect(expectation());
    assert.equal(result.state, 'confirmed_settled');
    assert.equal(result.snapshots.length, 1);
    const snapshot = result.snapshots[0]!;
    for (const [key, source] of [
      ['configuration', f.configuration],
      ['journal', f.journal],
    ]) {
      const record = snapshot[key!] as {
        source: string;
        snapshot: string;
        device: number;
        inode: number;
        bytes: number;
        sha256: string;
      };
      const original = fs.readFileSync(source!);
      assert.deepEqual(fs.readFileSync(record.snapshot), original);
      const stat = fs.statSync(source!);
      assert.equal(record.source, source);
      assert.equal(record.device, stat.dev);
      assert.equal(record.inode, stat.ino);
      assert.equal(record.bytes, original.length);
      assert.equal(record.sha256, createHash('sha256').update(original).digest('hex'));
    }
  });
});
test('missing-SID collector preserves private-source and monotonic-inode checks', () => {
  withFilesystem((f) => {
    const e = missingExpectation(f.directory);
    const first = f.collector.collectMissingSidPreToolUse(e);
    assert.equal(first.state, 'confirmed_settled');
    assert.equal(first.provenance, 'native-only-missing-sid-pre-tool-use');
    const retained = fs.readFileSync(f.journal);
    fs.unlinkSync(f.journal);
    fs.writeFileSync(f.journal, retained, { mode: 0o600 });
    const replaced = f.collector.collectMissingSidPreToolUse(e);
    assert.equal(replaced.state, 'unknown');
    assert.match(replaced.error!, /source identity changed/);
  });
});
test('missing-SID collector refuses a different temporary root and changed pinned configuration', () => {
  withFilesystem((f) => {
    const e = missingExpectation(f.directory);
    e.request.temporary = '/foreign';
    assert.equal(f.collector.collectMissingSidPreToolUse(e).state, 'unknown');
  });
  withFilesystem((f) => {
    const e = missingExpectation(f.directory);
    assert.equal(f.collector.collectMissingSidPreToolUse(e).state, 'confirmed_settled');
    fs.chmodSync(f.configuration, 0o600);
    fs.writeFileSync(f.configuration, bytes({ ...config(), control_fd: 35 }));
    fs.chmodSync(f.configuration, 0o400);
    const changed = f.collector.collectMissingSidPreToolUse(e);
    assert.equal(changed.state, 'unknown');
    assert.match(changed.error!, /source identity changed/);
  });
});
function firstExpectation(
  e: MissingSidPreToolUseExpectation
): MissingSidPreToolUseFirstExpectation {
  const { configuration, ...request } = e.request;
  void configuration;
  return { ...e, request };
}
test('first missing-SID collector observation pins exact validated native bytes without typed ID', () => {
  withFilesystem((f) => {
    const e = firstExpectation(missingExpectation(f.directory));
    assert.equal(Object.hasOwn(e.request, 'configuration'), false);
    assert.equal(Object.hasOwn(e, 'invocationId'), false);
    const observed = f.collector.observeMissingSidPreToolUse(e);
    assert.equal(observed.state, 'confirmed_settled');
    assert.equal(observed.provenance, 'native-only-missing-sid-pre-tool-use');
    assert.deepEqual(observed.configurationWitness, {
      source: f.directory,
      sha256: createHash('sha256').update(fs.readFileSync(f.configuration)).digest('hex'),
      invocationId: 'independent-typed-request',
    });
    if (observed.configurationWitness === null) throw new Error('validated witness absent');
    assert.equal(
      f.collector.collectMissingSidPreToolUse({
        ...e,
        request: { ...e.request, configuration: observed.configurationWitness },
      }).state,
      'confirmed_settled'
    );
  });
});
test('first missing-SID observation refuses incomplete native journal without issuing a pin', () => {
  withFilesystem((f) => {
    fs.writeFileSync(f.journal, journal([started()]));
    const e = firstExpectation(missingExpectation(f.directory));
    const pending = f.collector.observeMissingSidPreToolUse(e);
    assert.equal(pending.state, 'unknown');
    assert.equal(pending.configurationWitness, null);
    assert.match(pending.error!, /terminal settlement unavailable/);
    fs.appendFileSync(f.journal, journal([complete()]));
    const settled = f.collector.observeMissingSidPreToolUse(e);
    assert.equal(settled.state, 'confirmed_settled');
    assert.equal(settled.configurationWitness?.invocationId, 'independent-typed-request');
  });
});
test('first observation enforces original input, event, birth and native receipt chain before pinning', () => {
  for (const name of [
    'Stop event',
    'over-limit native timeout',
    'payload session identity',
    'old original birth',
    'foreign chain',
    'foreign journal PID',
    'partial cleanup record',
  ]) {
    withFilesystem((f) => {
      const e = missingExpectation(f.directory),
        c = [candidate()];
      const change = missingFaults.find(([label]) => label === name);
      assert.notEqual(change, undefined);
      change![1](e, c);
      fs.writeFileSync(f.journal, c[0]!.journal);
      const rejected = f.collector.observeMissingSidPreToolUse(firstExpectation(e));
      assert.equal(rejected.state, 'unknown', name);
      assert.equal(rejected.configurationWitness, null, name);
    });
  }
});
test('first observation accepts the native timeout upper boundary and refuses multiple private configurations', () => {
  withFilesystem((f) => {
    const e = firstExpectation(missingExpectation(f.directory));
    (e.request.args as string[])[12] = '120000';
    e.coverage.expected!.frontendCommand = [e.request.executable, ...e.request.args].join(' ');
    assert.equal(f.collector.observeMissingSidPreToolUse(e).state, 'confirmed_settled');
  });
  withFilesystem((f) => {
    const foreign = path.join(f.temporary, 'foreign');
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.writeFileSync(path.join(foreign, 'configuration.json'), bytes(config()), { mode: 0o400 });
    fs.writeFileSync(path.join(foreign, 'cleanup.jsonl'), journal([started(), complete()]), {
      mode: 0o600,
    });
    const rejected = f.collector.observeMissingSidPreToolUse(
      firstExpectation(missingExpectation(f.directory))
    );
    assert.equal(rejected.state, 'unknown');
    assert.equal(rejected.configurationWitness, null);
    assert.match(rejected.error!, /absent\/ambiguous/);
  });
});
test('collector accepts only extension of its observed native journal prefix', () => {
  withFilesystem((f) => {
    fs.writeFileSync(f.journal, journal([started()]));
    assert.equal(f.collector.collect(expectation()).state, 'unknown');
    fs.appendFileSync(f.journal, journal([complete()]));
    assert.equal(f.collector.collect(expectation()).state, 'confirmed_settled');
  });
  for (const kind of ['truncate', 'rewrite'])
    withFilesystem((f) => {
      assert.equal(f.collector.collect(expectation()).state, 'confirmed_settled');
      if (kind === 'truncate') fs.truncateSync(f.journal, 10);
      else fs.writeFileSync(f.journal, journal([{ ...started(), reason: 'changed' }, complete()]));
      const result = f.collector.collect(expectation());
      assert.equal(result.state, 'unknown');
      assert.match(result.error!, /truncated\/rewritten/);
    });
});
for (const target of ['configuration', 'journal'] as const)
  for (const failure of ['symlink', 'hardlink', 'directory', 'mode'] as const)
    test('collector refuses ' + target + ' ' + failure + ' at its filesystem boundary', () => {
      withFilesystem((f) => {
        const source = f[target];
        if (failure === 'mode') fs.chmodSync(source, target === 'configuration' ? 0o600 : 0o400);
        else if (failure === 'hardlink') fs.linkSync(source, path.join(f.root, 'alias'));
        else {
          const original = fs.readFileSync(source);
          fs.unlinkSync(source);
          if (failure === 'directory') fs.mkdirSync(source, { mode: 0o700 });
          else {
            const outside = path.join(f.root, 'original');
            fs.writeFileSync(outside, original, {
              mode: target === 'configuration' ? 0o400 : 0o600,
            });
            fs.symlinkSync(outside, source);
          }
        }
        const result = f.collector.collect(expectation());
        assert.equal(result.state, 'unknown');
        assert.equal(result.terminal, null);
        assert(result.error);
      });
    });
test('collector refuses a replacement journal inode despite identical receipt bytes', () => {
  withFilesystem((f) => {
    assert.equal(f.collector.collect(expectation()).state, 'confirmed_settled');
    const old = fs.statSync(f.journal).ino;
    fs.renameSync(f.journal, path.join(f.directory, 'original-cleanup'));
    fs.writeFileSync(f.journal, journal([started(), complete()]), { mode: 0o600 });
    assert.notEqual(fs.statSync(f.journal).ino, old);
    const result = f.collector.collect(expectation());
    assert.equal(result.state, 'unknown');
    assert.match(result.error!, /source identity changed/);
  });
});
test('collector refuses oversized sparse file before publishing any journal snapshot', () => {
  withFilesystem((f) => {
    fs.truncateSync(f.journal, MAX_CUSTODY_JOURNAL * 64);
    const result = f.collector.collect(expectation());
    assert.equal(result.state, 'unknown');
    assert.match(result.error!, /unsafe\/oversized/);
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.snapshots[0]!.journal, undefined);
    assert.equal(fs.existsSync(path.join(f.root, 'snapshots', '001', '00-cleanup.jsonl')), false);
    assert.equal(fs.statSync(f.journal).size, MAX_CUSTODY_JOURNAL * 64);
  });
});

test('journal event is exact against the request-owned expectation, with Stop as default', () => {
  const metadata = {
    schema: 'caws.hook_invocation.v1',
    invocation_id: 'independent-typed-request',
    runtime_digest: digest,
    input_sha256: 'b'.repeat(64),
    surface: 'codex',
    stage: 'invocation_started',
  };
  const stop = journal([{ ...metadata, event: 'stop' }]);
  assert.throws(() =>
    decodeInvocationIdentity(
      journal([{ ...metadata, event: 'post_tool_use' }]),
      digest,
      'b'.repeat(64),
      'post_tool_use' as never
    )
  );
  const pre = journal([{ ...metadata, event: 'pre_tool_use' }]);
  assert.deepEqual(decodeInvocationIdentity(stop, digest, 'b'.repeat(64)), {
    invocationId: 'independent-typed-request',
    runtimeDigest: digest,
  });
  assert.deepEqual(decodeInvocationIdentity(pre, digest, 'b'.repeat(64), 'pre_tool_use'), {
    invocationId: 'independent-typed-request',
    runtimeDigest: digest,
  });
  assert.throws(() => decodeInvocationIdentity(pre, digest, 'b'.repeat(64)));
  assert.throws(() => decodeInvocationIdentity(stop, digest, 'b'.repeat(64), 'pre_tool_use'));
  for (const event of [undefined, 'post_tool_use', 'PreToolUse', '', null]) {
    const invalid = journal([{ ...metadata, ...(event === undefined ? {} : { event }) }]);
    assert.throws(() => decodeInvocationIdentity(invalid, digest, 'b'.repeat(64), 'pre_tool_use'));
    assert.throws(() => decodeInvocationIdentity(invalid, digest, 'b'.repeat(64)));
  }
  assert.throws(() =>
    decodeInvocationIdentity(
      journal([
        { ...metadata, event: 'pre_tool_use' },
        { ...metadata, event: 'stop' },
      ]),
      digest,
      'b'.repeat(64),
      'pre_tool_use'
    )
  );
});
