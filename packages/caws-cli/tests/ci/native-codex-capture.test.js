'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const packageRoot = path.resolve(__dirname, '../..');
let fixture, previousExitCode;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(packageRoot, 'reports/codex-capture-unit-'));
  previousExitCode = process.exitCode;
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  jest.dontMock('node:child_process');
  jest.resetModules();
  process.exitCode = previousExitCode;
  fs.rmSync(fixture, { recursive: true, force: true });
});
function config() {
  return require('../../scripts/qualify-native-codex.cjs');
}
function prepareFixture(entry) {
  const nodeRoot = path.join(fixture, 'retained-node');
  const npm = path.join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js');
  const node = path.join(nodeRoot, 'bin/node');
  fs.mkdirSync(path.dirname(npm), { recursive: true });
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(npm, '// Not executed: command-contract fixture.\n');
  fs.writeFileSync(node, '// Not executed.\n');
  for (const name of ['project/.git', 'consumer', 'output', 'home'])
    fs.mkdirSync(path.join(fixture, name), { recursive: true });
  const image = {
    path: path.join(fixture, 'native-image.json'),
    sha256: 'c'.repeat(64),
    mode: 0o644,
    sizeBytes: 1,
  };
  const runtime = entry === 'native' ? { entry, nativeImage: image } : { entry };
  const request = {
    surface: 'codex',
    runtime:
      entry === 'native'
        ? { entry, nativeImage: { path: 'native-image.json', sha256: image.sha256 } }
        : { entry },
    paths: { project: 'project', consumer: 'consumer', output: 'output' },
    scenario: {
      ownedFile: 'project/.caws/worktrees/native-owned/allowed.txt',
      protectedFile: 'project/.caws/hooks/qualification-probe.sh',
    },
    adapter: { model: 'unit-fixture', adoptProject: true },
  };
  const run = jest.fn((label) => ({
    stdout:
      label === 'prepare-version'
        ? '12.2.0-rc.3\n'
        : JSON.stringify({
            operation: label,
            digest: 'd'.repeat(64),
            ...(label === 'prepare-machine-install' && entry === 'native'
              ? { nativeLauncher: '/unit/reported-native-entry' }
              : {}),
          }),
    receipt: { path: path.join(fixture, label + '.json'), sha256: 'e'.repeat(64) },
  }));
  const record = jest.fn(() => ({
    path: path.join(fixture, 'prepare.json'),
    sha256: 'f'.repeat(64),
  }));
  const custody = {
    request,
    inputs: {
      runtime,
      node: { path: node },
      candidate: { tarball: { path: path.join(fixture, 'candidate.tgz') } },
    },
    env: { HOME: path.join(fixture, 'home') },
    resolvePath: (relative) => path.join(fixture, relative),
    revalidateInputs: jest.fn(() => ({})),
    run,
    record,
    capture: () => ({ kind: 'missing' }),
  };
  return { custody, run, record, node, image };
}
test.each(['legacy', 'native'])(
  'prepare uses explicit %s selection in every install and registration operation',
  (entry) => {
    const fx = prepareFixture(entry);
    config().prepare(fx.custody);
    const cli = path.join(fixture, 'consumer/node_modules/@paths.design/caws-cli/dist/index.js');
    const imageArgs = entry === 'native' ? ['--native-image', fx.image.path] : [];
    const expected = [
      ['machine-plan', ['install', ...imageArgs, '--plan', '--json']],
      ['machine-install', ['install', ...imageArgs, '--json']],
      ['machine-replan', ['install', ...imageArgs, '--plan', '--json']],
      [
        'registration-plan',
        ['configure', '--agent-surface', 'codex', '--entry', entry, '--plan', '--json'],
      ],
      [
        'registration-install',
        ['configure', '--agent-surface', 'codex', '--entry', entry, '--json'],
      ],
      [
        'registration-replan',
        ['configure', '--agent-surface', 'codex', '--entry', entry, '--plan', '--json'],
      ],
    ];
    for (const [label, args] of expected) {
      const calls = fx.run.mock.calls.filter(([name]) => name === 'prepare-' + label);
      expect(calls).toHaveLength(1);
      expect(calls[0][1]).toEqual([fx.node, cli, 'init', 'adapters', ...args]);
    }
    const prepared = fx.record.mock.calls.find(([label]) => label === 'prepare')[1];
    expect(prepared.runtime.entry).toBe(entry);
    expect(prepared.runtime.nativeImage).toEqual(entry === 'native' ? fx.image : null);
    expect(prepared.runtime.reports).toHaveLength(6);
    if (entry === 'native')
      expect(
        prepared.runtime.reports.find((row) => row.operation === 'machine-install').reported
          .nativeLauncher
      ).toBe('/unit/reported-native-entry');
  }
);
test('prepare stops after custody reports post-operation input drift', () => {
  const fx = prepareFixture('native');
  const normal = fx.run.getMockImplementation();
  fx.run.mockImplementation((label, ...args) => {
    if (label === 'prepare-machine-install')
      throw Object.assign(new Error('Command failed: prepare-machine-install'), {
        observation: {
          status: 0,
          inputValidation: {
            error: { phase: 'after', message: 'Public input hash mismatch: nativeImage' },
          },
        },
      });
    return normal(label, ...args);
  });
  expect(() => config().prepare(fx.custody)).toThrow('Command failed');
  expect(fx.run.mock.calls.map(([label]) => label)).toEqual([
    'prepare-install',
    'prepare-version',
    'prepare-machine-plan',
    'prepare-machine-install',
  ]);
  expect(fx.record.mock.calls.some(([label]) => label === 'prepare')).toBe(false);
});
test('prepare cannot infer legacy when selection is missing', () => {
  const fx = prepareFixture('legacy');
  delete fx.custody.request.runtime;
  expect(() => config().prepare(fx.custody)).toThrow('Select runtime entry explicitly');
  expect(fx.run).not.toHaveBeenCalled();
});
test('pre-observe input drift prevents host spawn', async () => {
  const fx = captureFixture(undefined, true);
  fx.custody.revalidateInputs = () => {
    throw new Error('Public input hash mismatch: nativeImage');
  };
  await expect(fx.observe(fx.custody)).rejects.toThrow('Public input hash mismatch');
  expect(require('node:child_process').spawn).not.toHaveBeenCalled();
});
test('post-observe drift remains in the retained failure observation', async () => {
  const fx = captureFixture((child, message) => {
    if (message.method === 'initialize')
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: 'foreign-approval',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'foreign-thread', turnId: 'foreign-turn' },
          }) + '\n'
        )
      );
  }, true);
  fx.custody.revalidateInputs = jest
    .fn()
    .mockReturnValueOnce({})
    .mockImplementationOnce(() => {
      throw new Error('Public input hash mismatch: nativeImage');
    });
  await fx.observe(fx.custody);
  const observed = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(observed.inputDrift).toBe('Public input hash mismatch: nativeImage');
  expect(observed.terminal).toEqual({ status: 0, signal: null });
  expect(process.exitCode).toBe(1);
});
test('incomplete and threadless observations cannot manufacture positive results', () => {
  const observed = config().inspectObservation({
    ownedAfter: { kind: 'file' },
    protectedBefore: { kind: 'file' },
    protectedAfter: { kind: 'file' },
    stream: [
      {
        direction: 'received',
        message: {
          method: 'item/completed',
          params: {
            item: {
              type: 'commandExecution',
              commandActions: [{}],
              exitCode: 0,
              aggregatedOutput: '',
            },
          },
        },
      },
    ],
  });
  expect(observed).toMatchObject({
    ownedContents: false,
    ownedRead: false,
    protectedUnchanged: false,
    operationCompleted: false,
    ownedCommandExit: null,
  });
  expect(config().inspectObservation({ stream: {}, hooks: { data: {} } }).ownedContents).toBe(
    false
  );
});
test('file observations require complete matching bytes, hashes, paths and mode', () => {
  const snapshot = (file, value) => ({
    path: file,
    kind: 'file',
    mode: 0o640,
    bytesBase64: Buffer.from(value).toString('base64'),
    sizeBytes: Buffer.byteLength(value),
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
  });
  const data = {
    expectedOwnedPath: '/fixture/owned',
    expectedProtectedPath: '/fixture/protected',
    expectedOwnedBase64: Buffer.from('nonce\n').toString('base64'),
    ownedAfter: snapshot('/fixture/owned', 'nonce\n'),
    protectedBefore: snapshot('/fixture/protected', 'protected'),
    protectedAfter: snapshot('/fixture/protected', 'protected'),
  };
  expect(config().inspectObservation(data)).toMatchObject({
    ownedContents: true,
    protectedUnchanged: true,
  });
  data.protectedBefore.sha256 = data.protectedAfter.sha256 = '0'.repeat(64);
  expect(config().inspectObservation(data).protectedUnchanged).toBe(false);
  delete data.ownedAfter.bytesBase64;
  expect(config().inspectObservation(data).ownedContents).toBe(false);
});
test.each(['sent', 'wrong-thread', 'wrong-turn'])('command matching excludes %s rows', (kind) => {
  const observed = config().inspectObservation({
    threadId: 'thread',
    operationTurnId: 'turn',
    sources: { write: 'exact-command' },
    stream: [
      {
        direction: kind === 'sent' ? 'sent' : 'received',
        message: {
          method: 'item/completed',
          params: {
            threadId: kind === 'wrong-thread' ? 'foreign' : 'thread',
            turnId: kind === 'wrong-turn' ? 'foreign' : 'turn',
            item: {
              type: 'commandExecution',
              commandActions: [{ command: 'exact-command' }],
              exitCode: 0,
            },
          },
        },
      },
    ],
  });
  expect(observed.ownedCommandExit).toBeNull();
});
test('configuration replacement preserves unrelated bytes and original mode', () => {
  const file = path.join(fixture, 'config.toml');
  fs.writeFileSync(file, 'unrelated = "preserved"\nowned = true\n', { mode: 0o600 });
  const opened = config().openConfig(file, true);
  try {
    expect(opened.bytes.toString()).toContain('owned = true');
    opened.replace(Buffer.from('unrelated = "preserved"\n'));
  } finally {
    opened.close();
  }
  expect(fs.readFileSync(file, 'utf8')).toBe('unrelated = "preserved"\n');
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
});
test.each(['symlink', 'hardlink'])('configuration refuses %s before opening', (kind) => {
  const original = path.join(fixture, 'original');
  const alias = path.join(fixture, 'config.toml');
  fs.writeFileSync(original, 'unrelated = true\n');
  if (kind === 'symlink') fs.symlinkSync(original, alias);
  else fs.linkSync(original, alias);
  const opened = jest.spyOn(fs, 'openSync');
  expect(() => config().openConfig(alias, true)).toThrow('physical private configuration');
  expect(opened.mock.calls.some(([file]) => file === alias)).toBe(false);
  expect(fs.readFileSync(original, 'utf8')).toBe('unrelated = true\n');
});
test('configuration pathname replacement is refused without writing either file', () => {
  const file = path.join(fixture, 'config.toml'),
    old = path.join(fixture, 'old');
  fs.writeFileSync(file, 'original\n');
  const opened = config().openConfig(file, true);
  try {
    fs.renameSync(file, old);
    fs.writeFileSync(file, 'replacement\n');
    expect(() => opened.replace(Buffer.from('forbidden\n'))).toThrow('changed');
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement\n');
    expect(fs.readFileSync(old, 'utf8')).toBe('original\n');
  } finally {
    opened.close();
  }
});
function captureFixture(onSend, closesNormally) {
  jest.resetModules();
  const child = new EventEmitter();
  for (const name of ['stdin', 'stdout', 'stderr']) {
    child[name] = new EventEmitter();
    child[name].destroy = jest.fn();
  }
  const sent = [];
  child.stdin.write = jest.fn((line) => {
    const message = JSON.parse(line);
    sent.push(message);
    onSend?.(child, message);
    return true;
  });
  child.stdin.end = jest.fn(() => {
    if (closesNormally) child.emit('close', 0, null);
  });
  child.kill = jest.fn(() => true);
  child.unref = jest.fn();
  child.pid = 42;
  jest.doMock('node:child_process', () => ({
    ...jest.requireActual('node:child_process'),
    spawn: jest.fn(() => child),
  }));
  const request = {
    surface: 'codex',
    budgetMs: 1000,
    runtime: { entry: 'legacy' },
    paths: { project: 'project', consumer: 'consumer', output: 'output' },
    scenario: {
      ownedFile: 'project/.caws/worktrees/native-owned/allowed.txt',
      protectedFile: 'project/.caws/hooks/qualification-probe.sh',
    },
    adapter: { model: 'unit-fixture' },
  };
  for (const name of ['project', 'consumer', 'output', 'home'])
    fs.mkdirSync(path.join(fixture, name));
  const inputs = {
    request: { sha256: 'a'.repeat(64) },
    host: { image: { path: path.join(fixture, 'fake-host') } },
    runtime: { entry: 'legacy' },
  };
  fs.writeFileSync(
    path.join(fixture, 'output/prepare.json'),
    JSON.stringify({
      requestSha256: inputs.request.sha256,
      data: { runtime: { entry: 'legacy', nativeImage: null, reports: [] } },
    })
  );
  const started = Date.now();
  const record = jest.fn(() => ({
    path: path.join(fixture, 'output/observe.json'),
    sha256: 'b'.repeat(64),
  }));
  const custody = {
    request,
    inputs,
    env: { HOME: path.join(fixture, 'home') },
    resolvePath: (value) => path.join(fixture, value),
    remainingMs: () => Math.max(0, 1000 - (Date.now() - started)),
    capture: (value) => ({
      path: path.join(fixture, value),
      kind: value.includes('qualification-probe') ? 'file' : 'missing',
    }),
    revalidateInputs: () => ({}),
    record,
  };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  return { child, sent, record, custody, observe: config().observe };
}
test('unexpected approval during initialize is latched and declines before later RPCs', async () => {
  const fx = captureFixture((child, message) => {
    if (message.method === 'initialize')
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: 'foreign-approval',
            method: 'item/commandExecution/requestApproval',
            params: { threadId: 'foreign-thread', turnId: 'foreign-turn' },
          }) + '\n'
        )
      );
  }, true);
  await fx.observe(fx.custody);
  expect(fx.sent.find((message) => message.id === 'foreign-approval').result.decision).toBe(
    'decline'
  );
  expect(fx.sent.some((message) => message.method === 'hooks/list')).toBe(false);
  const observed = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(observed.error).toBe('Unexpected native approval was declined');
  expect(observed.terminal).toEqual({ status: 0, signal: null });
});
test('unresponsive child records unsettled outcome within the original budget', async () => {
  jest.useFakeTimers();
  const fx = captureFixture(undefined, false);
  const observation = fx.observe(fx.custody);
  await jest.advanceTimersByTimeAsync(1000);
  await observation;
  const observed = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(observed.error).toBe('initialize timed out');
  expect(observed.terminal).toMatchObject({ status: null, signal: null, unsettled: true, pid: 42 });
  expect(fx.child.kill).toHaveBeenCalledWith('SIGTERM');
  expect(fx.child.unref).toHaveBeenCalledTimes(1);
  expect(fx.child.stdout.destroy).toHaveBeenCalledTimes(1);
  expect(fx.custody.remainingMs()).toBe(0);
});
