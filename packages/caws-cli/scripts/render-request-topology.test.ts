import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  selectRequestChain,
  confirmRequestChain,
  type ProcessRow,
  type RequestExpectation,
} from './render-request-topology';

const expected: RequestExpectation = {
  platform: 'darwin',
  frontendPid: 100,
  frontendCommand: '/fixture/caws-native invoke --engine /fixture/engine.js',
  native: '/fixture/caws-native',
  node: '/selected/node',
  engine: '/fixture/engine.js',
};
const fixture = (): ProcessRow[] => [
  { pid: 100, parent: 12, group: 42, state: 'S', command: expected.frontendCommand },
  {
    pid: 200,
    parent: 100,
    group: 200,
    state: 'Ss',
    command: expected.native + ' engine-custodian 32',
  },
  { pid: 300, parent: 200, group: 300, state: 'S', command: expected.node + ' ' + expected.engine },
];
const observation = (p: ProcessRow) => ({
  state: 'observed',
  process: {
    pid: p.pid,
    parent: p.parent,
    group: p.group,
    startSeconds: String(1000 + p.pid),
    startMicros: '123',
    zombie: false,
  },
});

test('macOS selects caller, named custodian and exact selected Node in distinct groups', () => {
  const rows = fixture(),
    chain = selectRequestChain(rows, expected);
  assert.deepEqual(chain, rows);
  const observations = rows.map(observation);
  assert.deepEqual(
    confirmRequestChain(chain!, observations[0], observations, observations),
    observations.map((o) => o.process)
  );
  rows[1]!.command = expected.native + ' engine-custodian 1048576';
  assert.deepEqual(selectRequestChain(rows, expected), rows);
});
test('direct engine chain qualifies only on supported non-macOS paths', () => {
  const rows = fixture().filter((p) => p.pid !== 200);
  rows[1]!.parent = 100;
  assert.equal(selectRequestChain(rows, expected), null);
  assert.deepEqual(selectRequestChain(rows, { ...expected, platform: 'linux' }), rows);
  assert.equal(selectRequestChain(fixture(), { ...expected, platform: 'linux' }), null);
  assert.equal(selectRequestChain(rows, { ...expected, platform: 'win32' }), null);
});
const hostile: Array<[string, (rows: ProcessRow[]) => void]> = [
  [
    'caller replaced by custodian',
    (r) => {
      r[0]!.command = r[1]!.command;
    },
  ],
  [
    'arbitrary intermediary',
    (r) => {
      r[1]!.command = '/other/supervisor';
    },
  ],
  [
    'wrong custodian executable',
    (r) => {
      r[1]!.command = '/other/caws-native engine-custodian 32';
    },
  ],
  [
    'custodian extra argument',
    (r) => {
      r[1]!.command += ' extra';
    },
  ],
  [
    'custodian missing FD',
    (r) => {
      r[1]!.command = expected.native + ' engine-custodian';
    },
  ],
  [
    'wrong frontend ancestry',
    (r) => {
      r[1]!.parent = 12;
    },
  ],
  [
    'sibling Node',
    (r) => {
      r[2]!.parent = 100;
    },
  ],
  [
    'wrong Node executable',
    (r) => {
      r[2]!.command = '/other/node ' + expected.engine;
    },
  ],
  [
    'wrong engine',
    (r) => {
      r[2]!.command += '.other';
    },
  ],
  [
    'Node extra argument',
    (r) => {
      r[2]!.command += ' extra';
    },
  ],
  [
    'custodian not group leader',
    (r) => {
      r[1]!.group = 201;
    },
  ],
  [
    'Node not group leader',
    (r) => {
      r[2]!.group = 301;
    },
  ],
  [
    'frontend shares custodian group',
    (r) => {
      r[0]!.group = 200;
    },
  ],
  [
    'frontend shares Node group',
    (r) => {
      r[0]!.group = 300;
    },
  ],
  [
    'zero group',
    (r) => {
      r[0]!.group = 0;
    },
  ],
  [
    'duplicate PID',
    (r) => {
      r.push({ ...r[2]! });
    },
  ],
  [
    'duplicate matching engine',
    (r) => {
      r.push({ ...r[2]!, pid: 301, group: 301 });
    },
  ],
  [
    'duplicate matching custodian',
    (r) => {
      r.push({ ...r[1]!, pid: 201, group: 201 });
    },
  ],
];
for (const fd of ['0', '31', '033', '+32', '-32', '32.0', '1048577', '9007199254740993'])
  hostile.push([
    'custodian FD ' + fd,
    (r) => {
      r[1]!.command = expected.native + ' engine-custodian ' + fd;
    },
  ]);
for (const index of [0, 1, 2]) {
  hostile.push([
    'missing role ' + index,
    (r) => {
      r.splice(index, 1);
    },
  ]);
  hostile.push([
    'zombie role ' + index,
    (r) => {
      r[index]!.state = 'Z+';
    },
  ]);
}
for (const [name, change] of hostile)
  test('rejects ' + name, () => {
    const rows = fixture();
    change(rows);
    assert.equal(selectRequestChain(rows, expected), null);
  });
test('unknown snapshot and mismatched caller PID do not qualify', () => {
  assert.equal(selectRequestChain(null, expected), null);
  assert.equal(selectRequestChain(fixture(), { ...expected, frontendPid: 200 }), null);
});
for (const index of [0, 1, 2])
  test('reobserves precise identity and topology for role ' + index, () => {
    const chain = fixture(),
      before = chain.map(observation),
      after = chain.map(observation);
    after[index]!.process.startMicros = '124';
    assert.equal(confirmRequestChain(chain, before[0], before, after), null);
    after[index] = observation(chain[index]!);
    after[index]!.process.parent++;
    assert.equal(confirmRequestChain(chain, before[0], before, after), null);
    after[index] = observation(chain[index]!);
    after[index]!.process.group++;
    assert.equal(confirmRequestChain(chain, before[0], before, after), null);
    after[index] = observation(chain[index]!);
    after[index]!.process.zombie = true;
    assert.equal(confirmRequestChain(chain, before[0], before, after), null);
    const unknown = chain.map(observation) as unknown[];
    unknown[index] = { state: 'unavailable' };
    assert.equal(confirmRequestChain(chain, before[0], unknown, before), null);
    assert.equal(confirmRequestChain(chain, before[0], before, unknown), null);
  });
test('original caller birth cannot be replaced by a later birth or unknown observation', () => {
  const chain = fixture(),
    observations = chain.map(observation),
    original = observation(chain[0]!);
  original.process.startSeconds = '999';
  assert.equal(confirmRequestChain(chain, original, observations, observations), null);
  assert.equal(
    confirmRequestChain(chain, { state: 'unavailable' }, observations, observations),
    null
  );
  assert.equal(
    confirmRequestChain(chain, observations[0], observations.slice(1), observations),
    null
  );
});
