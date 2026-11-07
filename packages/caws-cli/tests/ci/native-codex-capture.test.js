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
// Command/protocol fixtures; real nofollow/bounded reading is covered by custody tests.
function fixturePublicRead(relative, maximum) {
  const file = path.join(relative.startsWith('scripts/') ? packageRoot : fixture, relative);
  const bytes = fs.readFileSync(file);
  if (bytes.length > maximum) throw new Error('Public fixture exceeds bound');
  return {
    path: file,
    bytes,
    sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    mode: fs.statSync(file).mode & 0o7777,
  };
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
    readPublic: fixturePublicRead,
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
test.each([
  'fresh',
  'prior-file',
  'same-bytes',
  'missing-write',
  'failed-write',
  'other-turn',
  'other-cwd',
  'missing-cwd',
  'unknown-before',
  'different-command',
  'missing-command',
])('owned write effect requires a current correlated change: %s', (kind) => {
  const snapshot = (value) => ({
    path: '/fixture/lane/owned',
    kind: 'file',
    mode: 0o600,
    bytesBase64: Buffer.from(value).toString('base64'),
    sizeBytes: Buffer.byteLength(value),
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
  });
  const before =
    kind === 'same-bytes'
      ? snapshot('attempt-2\n')
      : kind === 'prior-file'
        ? snapshot('attempt-1\n')
        : { path: '/fixture/lane/owned', kind: 'missing' };
  const data = {
    threadId: 'thread',
    operationTurnId: 'turn',
    requestedOperationSessionCwd: kind === 'missing-cwd' ? undefined : '/fixture/lane',
    expectedOwnedPath: '/fixture/lane/owned',
    expectedOwnedBase64: Buffer.from('attempt-2\n').toString('base64'),
    ownedBefore: kind === 'unknown-before' ? undefined : before,
    ownedAfter: snapshot('attempt-2\n'),
    sources: { write: 'exact-write' },
    stream:
      kind === 'missing-write'
        ? []
        : [
            {
              direction: 'received',
              message: {
                method: 'item/completed',
                params: {
                  threadId: 'thread',
                  turnId: kind === 'other-turn' ? 'old-turn' : 'turn',
                  item: {
                    type: 'commandExecution',
                    command:
                      kind === 'missing-command'
                        ? undefined
                        : kind === 'different-command'
                          ? '/bin/zsh -c "unrelated-command"'
                          : '/bin/zsh -c "exact-write"',
                    commandActions: [{ command: 'exact-write' }],
                    cwd:
                      kind === 'missing-cwd'
                        ? undefined
                        : kind === 'other-cwd'
                          ? '/another'
                          : '/fixture/lane',
                    exitCode: kind === 'failed-write' ? 1 : 0,
                  },
                },
              },
            },
          ],
  };
  const result = config().inspectObservation(data);
  expect(result.ownedContents).toBe(true);
  expect(result.ownedWriteEffect).toBe(['fresh', 'prior-file'].includes(kind));
});
test('a synchronous host spawn failure consumes its reserved failure receipt', async () => {
  const fx = captureFixture(undefined, true);
  require('node:child_process').spawn.mockImplementationOnce(() => {
    throw Error('spawn refused');
  });
  await fx.observe(fx.custody);
  expect(fx.record.mock.calls.map(([label]) => label)).toEqual(['observe-start', 'observe']);
  expect(fx.record.mock.calls[1][1]).toMatchObject({
    error: 'spawn refused',
    terminal: { status: null, signal: null, launched: false },
  });
  expect(process.exitCode).toBe(1);
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
function fixtureHooks(entry = 'legacy') {
  const sourcePath = path.join(fixture, 'home/.codex/hooks.json');
  const machine = path.join(fixture, 'machine');
  const launcher = path.join(machine, 'bin', entry === 'native' ? 'caws-hook-native' : 'caws-hook');
  return {
    data: [
      {
        cwd: path.join(fixture, 'project'),
        warnings: [],
        errors: [],
        hooks: [
          ['preToolUse', 'pre_tool_use', 45, '.*'],
          ['postToolUse', 'post_tool_use', 60, '.*'],
          ['preCompact', 'pre_compact', 30, null],
          ['sessionStart', 'session_start', 30, null],
          ['sessionEnd', 'session_end', 3, null],
          ['stop', 'stop', 30, null],
        ].map(([eventName, event, timeoutSec, matcher]) => ({
          key: sourcePath + ':' + event + ':0:0',
          eventName,
          handlerType: 'command',
          command: `CAWS_HOME='${machine}' '${launcher}' codex ${event} --system`,
          async: false,
          matcher,
          timeoutSec,
          statusMessage: null,
          additionalContextLimit: null,
          sourcePath,
          source: 'user',
          pluginId: null,
          enabled: true,
          isManaged: false,
          currentHash: 'sha256:' + 'c'.repeat(64),
          trustStatus: 'trusted',
        })),
      },
    ],
  };
}
function captureFixture(onSend, closesNormally, entry = 'legacy') {
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
  const runtime =
    entry === 'native'
      ? { entry, nativeImage: { path: path.join(fixture, 'image.json'), sha256: 'c'.repeat(64) } }
      : { entry };
  const request = {
    surface: 'codex',
    budgetMs: 1000,
    runtime,
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
    runtime,
  };
  fs.writeFileSync(
    path.join(fixture, 'output/prepare.json'),
    JSON.stringify({
      schema: 'caws.native-session.receipt.v1',
      surface: 'codex',
      requestSha256: inputs.request.sha256,
      data: { runtime: { ...runtime, nativeImage: runtime.nativeImage ?? null, reports: [] } },
    })
  );
  const started = Date.now();
  const preparationSha256 = fixturePublicRead('output/prepare.json', 16 * 1024 * 1024).sha256;
  const record = jest.fn(() => ({
    path: path.join(fixture, 'output/observe.json'),
    sha256: 'b'.repeat(64),
  }));
  const custody = {
    request,
    inputs,
    env: { HOME: path.join(fixture, 'home'), CAWS_HOME: path.join(fixture, 'machine') },
    resolvePath: (value) => path.join(fixture, value),
    readPublic: fixturePublicRead,
    remainingMs: () => Math.max(0, 1000 - (Date.now() - started)),
    capture: (value) => ({
      path: path.join(fixture, value),
      kind: value.includes('qualification-probe') ? 'file' : 'missing',
    }),
    revalidateInputs: () => ({}),
    record,
    reserveRecord: (label) => ({ commit: (data) => record(label, data) }),
  };
  jest.spyOn(console, 'log').mockImplementation(() => {});
  return {
    child,
    sent,
    record,
    custody,
    preparationSha256,
    observe: (selected, pin = preparationSha256, attempt) =>
      config().observe(selected, pin, attempt),
  };
}
test('named observation retains the preparation pin and separate attempt receipts', async () => {
  const fx = captureFixture(bootstrapProtocol('duplicate'), true);
  await fx.observe(fx.custody, fx.preparationSha256, 'trusted-1');
  const labels = fx.record.mock.calls.map(([label]) => label);
  expect(labels).toEqual(['observe-attempt-trusted-1.start', 'observe-attempt-trusted-1']);
  const observed = fx.record.mock.calls[1][1];
  expect(observed.attempt).toBe('trusted-1');
  expect(Buffer.from(observed.expectedOwnedBase64, 'base64').toString()).toBe(
    'native-owned-aaaaaaaaaaaaaaaa-trusted-1\n'
  );
  expect(observed.ownedBefore.kind).toBe('missing');
  expect(observed.preparation.sha256).toBe(fx.preparationSha256);
  expect(observed.terminal).toEqual({ status: 0, signal: null });
});
test.each(['', '../escape', 'attempt.start', 'UPPER', 'a'.repeat(33), null, 12])(
  'invalid observation attempt %p cannot launch the host',
  async (attempt) => {
    const fx = captureFixture(undefined, true);
    await expect(fx.observe(fx.custody, fx.preparationSha256, attempt)).rejects.toThrow(
      'Invalid observation attempt'
    );
    expect(require('node:child_process').spawn).not.toHaveBeenCalled();
    expect(fx.record).not.toHaveBeenCalled();
  }
);
test('missing preparation pin prevents host spawn', async () => {
  const fx = captureFixture(undefined, true);
  await expect(config().observe(fx.custody)).rejects.toThrow('preparation receipt SHA256');
  expect(require('node:child_process').spawn).not.toHaveBeenCalled();
});
test('replaced same-request preparation metadata prevents host spawn', async () => {
  const fx = captureFixture(undefined, true);
  const file = path.join(fixture, 'output/prepare.json');
  const replaced = JSON.parse(fs.readFileSync(file));
  replaced.data.runtime.reports = [{ invented: true }];
  fs.writeFileSync(file, JSON.stringify(replaced));
  await expect(fx.observe(fx.custody)).rejects.toThrow('Preparation receipt hash mismatch');
  expect(require('node:child_process').spawn).not.toHaveBeenCalled();
});
function bootstrapProtocol(mode, entry = 'legacy') {
  let reentrantReplay;
  return (child, message) => {
    if (mode === 'reentrant' && message.id === 'first' && message.result?.decision === 'accept') {
      child.stdout.emit('data', Buffer.from(JSON.stringify(reentrantReplay) + '\n'));
      return;
    }
    const emit = (value) => child.stdout.emit('data', Buffer.from(JSON.stringify(value) + '\n'));
    if (message.method === 'initialize')
      globalThis.queueMicrotask(() => emit({ id: message.id, result: {} }));
    if (message.method === 'hooks/list')
      globalThis.queueMicrotask(() => emit({ id: message.id, result: fixtureHooks(entry) }));
    if (message.method === 'thread/start')
      globalThis.queueMicrotask(() => {
        if (mode === 'early-failed-hook')
          emit({
            method: 'hook/completed',
            params: {
              threadId: 'thread-1',
              run: { eventName: 'sessionStart', status: 'failed' },
            },
          });
        emit({ id: message.id, result: { thread: { id: 'thread-1' }, model: 'unit-fixture' } });
      });
    if (message.method !== 'turn/start') return;
    const command = JSON.parse(
      message.params.input[0].text.match(/exact cmd (".*?"), workdir /)[1]
    );
    const approval = (id, turnId) => ({
      id,
      method: 'item/commandExecution/requestApproval',
      params: {
        kind: 'command',
        threadId: 'thread-1',
        ...(turnId === undefined ? {} : { turnId }),
        itemId: 'bootstrap-command',
        environmentId: 'local',
        cwd: path.join(fixture, 'project'),
        command: '/bin/zsh -c "' + command + '"',
        commandActions: [{ command }],
        availableDecisions: ['accept', 'cancel'],
      },
    });
    if (mode === 'null' || mode === 'missing') {
      globalThis.queueMicrotask(() => emit(approval('early', mode === 'null' ? null : undefined)));
      return;
    }
    emit({ id: message.id, result: { turn: { id: 'bootstrap-1' } } });
    // The real turn response is processed before these requests are delivered.
    globalThis.setImmediate(() => {
      for (const eventName of ['sessionStart', 'preToolUse']) {
        if (mode === 'missing-' + eventName) continue;
        const sourcePath = path.join(fixture, 'home/.codex/hooks.json');
        const failed = mode === 'failed-' + eventName;
        emit({
          method: 'hook/completed',
          params: {
            threadId: mode === 'foreign-hook-thread' ? 'other-thread' : 'thread-1',
            turnId: mode === 'foreign-hook-turn' ? 'other-turn' : 'bootstrap-1',
            run: {
              eventName,
              id:
                eventName === 'sessionStart'
                  ? 'session-start:3:' + sourcePath
                  : 'pre-tool-use:0:' +
                    sourcePath +
                    ':' +
                    (mode === 'foreign-hook-item' ? 'other-item' : 'bootstrap-command'),
              handlerType: 'command',
              executionMode: 'sync',
              source: 'user',
              sourcePath: mode === 'foreign-hook-source' ? '/other/hooks.json' : sourcePath,
              status: failed ? 'failed' : mode === 'blocked-' + eventName ? 'blocked' : 'completed',
            },
          },
        });
      }
      if (mode === 'unknown-failed-hook' || mode === 'missing-source-failed-hook')
        emit({
          method: 'hook/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'bootstrap-1',
            run: {
              eventName: 'preToolUse',
              status: 'failed',
              ...(mode === 'unknown-failed-hook' ? { sourcePath: '/other/hooks.json' } : {}),
            },
          },
        });
      if (mode === 'duplicate' || mode === 'reentrant') {
        reentrantReplay = approval('second', 'bootstrap-1');
        emit(approval('first', 'bootstrap-1'));
        if (mode === 'duplicate') emit(reentrantReplay);
      } else if (!['fatal', 'duplicate', 'reentrant'].includes(mode)) {
        const request = approval('invalid-command', 'bootstrap-1');
        if (mode === 'missing-command') delete request.params.command;
        if (mode === 'different-command') request.params.command += ' && unwanted-command';
        if (mode === 'stdin') request.params.kind = 'writeStdin';
        if (mode === 'remote') request.params.environmentId = 'another-environment';
        if (mode === 'missing-environment') delete request.params.environmentId;
        if (mode === 'no-one-call-decision') request.params.availableDecisions = ['cancel'];
        if (mode === 'malformed-decisions') request.params.availableDecisions = 'accept';
        if (mode === 'network')
          request.params.networkApprovalContext = { host: 'example.com', protocol: 'https' };
        emit(request);
      } else {
        const first = approval('foreign', 'other-turn');
        const second = approval('after-fatal', 'bootstrap-1');
        child.stdout.emit(
          'data',
          Buffer.from(JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n')
        );
      }
    });
  };
}
test.each(['legacy', 'native'])(
  'trusted exact %s registration reaches the one-call bootstrap',
  async (entry) => {
    const fx = captureFixture(bootstrapProtocol('duplicate', entry), true, entry);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'first').result.decision).toBe('accept');
    const turn = fx.sent.find((message) => message.method === 'turn/start');
    expect(turn.params.input[0].text).toContain('one-call native approval before executing');
    expect(turn.params.input[0].text).toContain(
      'Do not request a persistent rule or session-wide permission'
    );
    expect(
      fx.record.mock.calls.find(([label]) => label === 'observe')[1].observations
        .trustedRegistration
    ).toBe(true);
  }
);
test.each([
  'modified',
  'disabled',
  'missing',
  'duplicate',
  'wrong-entry',
  'wrong-source',
  'wrong-timeout',
  'async',
  'matcher',
  'missing-hash',
  'warning',
  'error',
  'wrong-cwd',
])('unqualified registration (%s) stops before native session creation', async (kind) => {
  const fx = captureFixture(
    (child, message) => {
      if (!['initialize', 'hooks/list'].includes(message.method)) return;
      const list = fixtureHooks('native');
      const row = list.data[0],
        hook = row.hooks[0];
      if (kind === 'modified') hook.trustStatus = 'modified';
      if (kind === 'disabled') hook.enabled = false;
      if (kind === 'missing') row.hooks.pop();
      if (kind === 'duplicate') row.hooks[1] = { ...hook };
      if (kind === 'wrong-entry')
        hook.command = hook.command.replace('caws-hook-native', 'caws-hook');
      if (kind === 'wrong-source') hook.sourcePath = '/another/hooks.json';
      if (kind === 'wrong-timeout') hook.timeoutSec = 300;
      if (kind === 'async') hook.async = true;
      if (kind === 'matcher') hook.matcher = 'unmatched-tool';
      if (kind === 'missing-hash') delete hook.currentHash;
      if (kind === 'warning') row.warnings.push('source conflict');
      if (kind === 'error') row.errors.push('source failure');
      if (kind === 'wrong-cwd') row.cwd = '/another-project';
      globalThis.queueMicrotask(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              id: message.id,
              result: message.method === 'initialize' ? {} : list,
            }) + '\n'
          )
        )
      );
    },
    true,
    'native'
  );
  await fx.observe(fx.custody);
  expect(
    fx.sent.some((message) =>
      ['thread/start', 'thread/resume', 'turn/start'].includes(message.method)
    )
  ).toBe(false);
  expect(fx.sent.some((message) => message.result?.decision === 'accept')).toBe(false);
  const observed = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(observed.error).toMatch(/Native hook/);
  expect(observed.observations.trustedRegistration).toBe(false);
  expect(observed.terminal).toEqual({ status: 0, signal: null });
  expect(process.exitCode).toBe(1);
});
test.each([
  'missing-command',
  'different-command',
  'stdin',
  'remote',
  'network',
  'missing-environment',
  'no-one-call-decision',
  'malformed-decisions',
  'missing-sessionStart',
  'missing-preToolUse',
  'foreign-hook-thread',
  'foreign-hook-turn',
  'foreign-hook-item',
  'foreign-hook-source',
])('friendly command metadata cannot authorize %s', async (mode) => {
  const fx = captureFixture(bootstrapProtocol(mode), true);
  await fx.observe(fx.custody);
  expect(fx.sent.find((message) => message.id === 'invalid-command').result.decision).toBe(
    'decline'
  );
  expect(fx.sent.some((message) => message.result?.decision === 'accept')).toBe(false);
  expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
    'Unexpected native approval was declined'
  );
});
test.each(['sessionStart', 'preToolUse'])(
  'a failed required %s hook latches before a friendly approval',
  async (eventName) => {
    const fx = captureFixture(bootstrapProtocol('failed-' + eventName), true);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'invalid-command').result.decision).toBe(
      'decline'
    );
    expect(fx.sent.some((message) => message.result?.decision === 'accept')).toBe(false);
    expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
      'Required native hook did not complete: ' + eventName
    );
  }
);
test.each(['sessionStart', 'preToolUse'])(
  'a blocked bootstrap %s hook cannot acquire a native approval',
  async (eventName) => {
    const fx = captureFixture(bootstrapProtocol('blocked-' + eventName), true);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'invalid-command').result.decision).toBe(
      'decline'
    );
    expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
      'Required native hook did not complete: ' + eventName
    );
  }
);
test.each(['unknown-failed-hook', 'missing-source-failed-hook'])(
  'a same-thread %s cannot be concealed by preceding successful callbacks',
  async (mode) => {
    const fx = captureFixture(bootstrapProtocol(mode), true);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'invalid-command').result.decision).toBe(
      'decline'
    );
    expect(fx.sent.some((message) => message.result?.decision === 'accept')).toBe(false);
    expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
      'Required native hook did not complete: preToolUse'
    );
  }
);
test('a failed hook arriving before the thread response prevents the first turn', async () => {
  const fx = captureFixture(bootstrapProtocol('early-failed-hook'), true);
  await fx.observe(fx.custody);
  expect(fx.sent.some((message) => message.method === 'turn/start')).toBe(false);
  expect(fx.sent.some((message) => message.result?.decision === 'accept')).toBe(false);
  expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
    'Required native hook did not complete: sessionStart'
  );
});
test.each(['null', 'missing'])(
  'declines bootstrap approval with %s turn before response',
  async (mode) => {
    const fx = captureFixture(bootstrapProtocol(mode), true);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'early').result.decision).toBe('decline');
    expect(fx.sent.filter((message) => message.method === 'turn/start')).toHaveLength(1);
    expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
      'Unexpected native approval was declined'
    );
  }
);
test.each(['duplicate', 'reentrant'])(
  'accepts one correlated bootstrap approval and declines %s replay',
  async (mode) => {
    const fx = captureFixture(bootstrapProtocol(mode), true);
    await fx.observe(fx.custody);
    expect(fx.sent.find((message) => message.id === 'first').result.decision).toBe('accept');
    expect(fx.sent.find((message) => message.id === 'second').result.decision).toBe('decline');
    expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
      'Unexpected native approval was declined'
    );
  }
);
function changedObserverReadback() {
  let sourceReads = 0;
  return (relative, maximum) => {
    const result = fixturePublicRead(relative, maximum);
    if (relative === 'scripts/qualify-native-codex.cjs' && sourceReads++ > 0)
      return { ...result, sha256: '0'.repeat(64) };
    return result;
  };
}
test('prepare refuses producer drift after the recorded setup operations', () => {
  const fx = prepareFixture('native');
  fx.custody.readPublic = changedObserverReadback();
  expect(() => config().prepare(fx.custody)).toThrow('Observer source changed');
  expect(fx.run.mock.calls.some(([label]) => label === 'prepare-registration-replan')).toBe(true);
  expect(fx.record.mock.calls.some(([label]) => label === 'prepare')).toBe(false);
});
test('observe retains producer drift alongside the original protocol failure', async () => {
  const fx = captureFixture((child, message) => {
    if (message.method === 'initialize')
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            id: 'foreign',
            method: 'item/commandExecution/requestApproval',
            params: {},
          }) + '\n'
        )
      );
  }, true);
  fx.custody.readPublic = changedObserverReadback();
  await fx.observe(fx.custody);
  const data = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(data.inputDrift).toBe('Observer source changed during operation');
  expect(data.error).toBe('Unexpected native approval was declined');
  expect(data.observerSource.sha256).not.toBe('0'.repeat(64));
  expect(data.preparation.sha256).toBe(fx.preparationSha256);
});
test('fatal request and matching bootstrap in one chunk both decline', async () => {
  const fx = captureFixture(bootstrapProtocol('fatal'), true);
  await fx.observe(fx.custody);
  for (const id of ['foreign', 'after-fatal'])
    expect(fx.sent.find((message) => message.id === id).result.decision).toBe('decline');
  expect(fx.record.mock.calls.find(([label]) => label === 'observe')[1].error).toBe(
    'Unexpected native approval was declined'
  );
});
test.each(['stdout', 'stderr'])(
  'bounds excessive %s and preserves explicit truncation failure',
  async (channel) => {
    const fx = captureFixture((child, message) => {
      if (message.method === 'initialize')
        child[channel].emit('data', Buffer.alloc(16 * 1024 * 1024 + 1, 120));
    }, true);
    await fx.observe(fx.custody);
    const data = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
    expect(data.error).toBe('Native host output limit exceeded');
    expect(data.hostOutput.truncated).toBe(true);
    expect(data.hostOutput.retainedBytes).toBe(16 * 1024 * 1024);
    expect(data.hostOutput[channel + 'Bytes']).toBe(16 * 1024 * 1024 + 1);
    expect(data.hostOutput.chunks).toHaveLength(1);
    expect(Buffer.from(data.hostOutput.chunks[0].bytesBase64, 'base64').length).toBe(
      16 * 1024 * 1024
    );
    expect(fx.sent.some((message) => message.method === 'hooks/list')).toBe(false);
    expect(process.exitCode).toBe(1);
  }
);
test('bounds parsed-message accumulation from one host chunk', async () => {
  const fx = captureFixture((child, message) => {
    if (message.method === 'initialize')
      child.stdout.emit(
        'data',
        Buffer.from((JSON.stringify({ id: 'unmatched' }) + '\n').repeat(10001))
      );
  }, true);
  await fx.observe(fx.custody);
  const data = fx.record.mock.calls.find(([label]) => label === 'observe')[1];
  expect(data.error).toBe('Native host message limit exceeded');
  expect(data.stream).toHaveLength(10000);
  expect(data.hostOutput.truncated).toBe(true);
  expect(process.exitCode).toBe(1);
});
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
