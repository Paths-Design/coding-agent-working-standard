const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const { sha, verifyRuntime } = require('../../dist/init/machine-runtime-state');
const { MACHINE_EVENTS, machineCommand } = require('../../dist/init/native-hook-identification');
const { captureSelectionRead } = require('../../dist/init/selection-read-io');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const {
  SelectionObservationSnapshot,
  resolveObservedInvocationSelection,
} = require('../../dist/runtime/selection-observation');

test('a verifier that catches an uncaptured read cannot cache incomplete verification', () => {
  const supplied = snapshot('swallowed-read');
  const verify = (_home, _digest, io) => {
    try {
      io.readFile('/missing-verification-input');
    } catch {
      /* Exercise a consumer swallowing discovery. */
    }
    return { 'first.sh': 'not evidence of a completed read' };
  };
  expect(() => supplied.io.verifyRuntime('/home', 'a'.repeat(64), verify)).toThrow(
    'Selection requires a captured read observation'
  );
  expect(supplied.runtimeSnapshots).toHaveLength(0);
  expect(() => supplied.io.verifyRuntime('/home', 'a'.repeat(64), verify)).toThrow(
    'Selection requires a captured read observation'
  );
});

let root;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-selection-observe-')));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function write(file, value, executable = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)
  );
  fs.chmodSync(file, executable ? 0o755 : 0o644);
}
function fixture(extraFiles = {}, native = false) {
  const home = path.join(root, 'home'),
    canonical = path.join(root, 'project');
  const files = {
    'launcher.py': '# fixture launcher\n',
    'bootstrap.py': '# fixture bootstrap\n',
    'first.sh': '#!/bin/sh\nexit 0\n',
    ...extraFiles,
    'surfaces/codex/lib/session-transcript.py': '# fixture surface transcript\n',
    'system-policy.json': JSON.stringify({
      version: 1,
      events: Object.fromEntries(Object.keys(MACHINE_EVENTS).map((event) => [event, ['first.sh']])),
    }),
  };
  if (native) {
    Object.assign(files, {
      'native/caws-hook-native': '#!/bin/sh\nexit 0\n',
      'native/node': '#!/bin/sh\nexit 0\n',
      'client/engine.js': '// fixture engine\n',
      'client/describe.js': '// fixture describe\n',
      'native-entry.json': JSON.stringify({
        schema: 'caws.runtime.native-entry.v1',
        timeoutMs: 1000,
        nativeExecutable: 'native/caws-hook-native',
        nodeExecutable: 'native/node',
        engineEntry: 'client/engine.js',
        describeEntry: 'client/describe.js',
      }),
    });
    files['native-modes.json'] = JSON.stringify(
      Object.fromEntries(
        [...Object.keys(files), 'native-modes.json'].map((name) => [
          name,
          name.endsWith('.sh') || ['native/caws-hook-native', 'native/node'].includes(name)
            ? 0o755
            : 0o644,
        ])
      )
    );
  }
  const manifest = JSON.stringify(
    Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, sha(bytes)]))
  );
  const runtimeDigest = sha(manifest),
    runtime = path.join(home, 'lib/runtimes', runtimeDigest);
  for (const [name, bytes] of Object.entries(files)) {
    write(
      path.join(runtime, name),
      bytes,
      name.endsWith('.sh') || (native && ['native/caws-hook-native', 'native/node'].includes(name))
    );
  }
  write(path.join(runtime, 'manifest.json'), manifest);
  write(path.join(home, 'bin/caws-hook'), files['bootstrap.py'], true);
  write(path.join(canonical, '.caws/policy.yaml'), 'version: 1\n');
  fs.mkdirSync(path.join(canonical, '.caws/specs'));
  write(path.join(home, 'surfaces/codex/settings.json'), { version: 1, enabled: true });
  const projectFile = path.join(home, 'state/projects', sha(canonical) + '.json');
  write(projectFile, {
    version: 1,
    root: canonical,
    surfaces: {
      codex: { disabled: {}, extensions: {}, handlers: {}, libraries: {} },
    },
  });
  return {
    runtime,
    projectFile,
    options: {
      home,
      canonical,
      checkout: canonical,
      runtimeDigest,
      surface: 'codex',
      event: 'pre_tool_use',
      system: true,
    },
  };
}
function snapshot(id = 'observation-fixture', limits = {}) {
  return new SelectionObservationSnapshot(id, {
    maximumObservations: 4096,
    maximumBytes: 8 * 1024 * 1024,
    maximumPathBytes: 8192,
    ...limits,
  });
}
function reply(request) {
  return {
    ...request,
    observationId: `observation-${request.sequence}`,
    result: captureSelectionRead(request.operation),
  };
}
async function observe(
  options,
  supplied = snapshot(),
  capture = async (request) => reply(request)
) {
  return resolveObservedInvocationSelection(options, {
    snapshot: supplied,
    maximumRequests: 4096,
    capture,
  });
}

test('captured selection equals live semantics and sealed replay performs no ambient reads', async () => {
  const f = fixture(),
    expected = resolveInvocationSelection(f.options);
  const captured = await observe(f.options);
  expect(captured.selection).toEqual(expected);
  expect(captured.snapshot.runtimeSnapshots).toHaveLength(1);
  for (const method of [
    'lstatSync',
    'statSync',
    'existsSync',
    'readFileSync',
    'readdirSync',
    'accessSync',
    'openSync',
  ]) {
    jest.spyOn(fs, method).mockImplementation(() => {
      throw new Error(`ambient ${method}`);
    });
  }
  expect(resolveInvocationSelection({ ...f.options, io: captured.snapshot.io })).toEqual(expected);
  const member = path.join(f.runtime, 'first.sh');
  captured.snapshot.io.readRuntimeFile(member).bytes.fill(0);
  expect(captured.snapshot.io.readRuntimeFile(member).bytes.toString()).toBe('#!/bin/sh\nexit 0\n');
});

test('driver owns original invocation properties before the first asynchronous capture', async () => {
  const f = fixture(),
    expected = resolveInvocationSelection(f.options);
  let canonical = f.options.canonical,
    reads = 0;
  const options = {
    ...f.options,
    get canonical() {
      reads++;
      return canonical;
    },
  };
  const captured = await observe(options, snapshot(), async (request) => {
    canonical = '/changed-after-observation';
    return reply(request);
  });
  expect(reads).toBe(1);
  expect(captured.selection).toEqual(expected);
});

test('capture cannot replace snapshot IO identity limits or retained state', async () => {
  const f = fixture(),
    supplied = snapshot('immutable'),
    originalIo = supplied.io,
    originalLimits = supplied.limits;
  let attempted = false;
  const result = await observe(f.options, supplied, async (request) => {
    const value = reply(request);
    if (!attempted) {
      attempted = true;
      expect(
        Reflect.set(supplied, 'io', {
          ...originalIo,
          lstat() {
            throw new Error('replaced IO');
          },
        })
      ).toBe(false);
      expect(Reflect.set(supplied, 'snapshotId', 'changed')).toBe(false);
      expect(Reflect.set(supplied, 'limits', { ...originalLimits, maximumBytes: 1 })).toBe(false);
      expect(Reflect.set(supplied, 'rows', new Map())).toBe(false);
      expect(Reflect.set(supplied, 'sealed', false)).toBe(false);
    }
    return value;
  });
  expect(attempted).toBe(true);
  expect(supplied.io).toBe(originalIo);
  expect(supplied.limits).toBe(originalLimits);
  expect(supplied.snapshotId).toBe('immutable');
  expect(Object.isFrozen(supplied)).toBe(true);
  expect(supplied.observations.length).toBeGreaterThan(1);
  expect(supplied.observations.every((row) => row.snapshotId === 'immutable')).toBe(true);
  for (const method of [
    'lstatSync',
    'statSync',
    'existsSync',
    'readFileSync',
    'readdirSync',
    'accessSync',
    'openSync',
  ])
    jest.spyOn(fs, method).mockImplementation(() => {
      throw new Error(`ambient ${method}`);
    });
  expect(resolveInvocationSelection({ ...f.options, io: supplied.io })).toEqual(result.selection);
});

test('fresh higher-priority adapter exposes changed absence inventory and ancestry inputs', async () => {
  const f = fixture(),
    before = await observe(f.options, snapshot('before'));
  const directory = path.join(f.options.home, 'surfaces/codex/lib');
  const adapter = path.join(directory, 'session-transcript.py');
  const absence = before.snapshot.observations.find(
    (row) => row.operation.kind === 'stat' && row.operation.path === adapter
  );
  expect(absence.result).toMatchObject({ kind: 'error', code: 'ENOENT' });
  const parentBefore = before.snapshot.observations.find(
    (row) => row.operation.kind === 'lstat' && row.operation.path === directory
  );
  expect(parentBefore.result).toMatchObject({ kind: 'error', code: 'ENOENT' });
  write(adapter, '# user replacement\n');
  const after = await observe(f.options, snapshot('after'));
  expect(before.selection.transcriptAdapter.path).toBe(
    path.join(f.runtime, 'surfaces/codex/lib/session-transcript.py')
  );
  expect(after.selection.transcriptAdapter).toEqual({
    path: adapter,
    sha256: sha('# user replacement\n'),
  });
  const parentAfter = after.snapshot.observations.find(
    (row) => row.operation.kind === 'lstat' && row.operation.path === directory
  );
  expect(parentAfter.result.value.kind).toBe('directory');
  const listing = after.snapshot.observations.find(
    (row) => row.operation.kind === 'list' && row.operation.path === directory
  );
  expect(listing.result.entries).toEqual(['session-transcript.py']);
  expect(resolveInvocationSelection({ ...f.options, io: before.snapshot.io })).toEqual(
    before.selection
  );
  const open = snapshot('replacement');
  open.record({ ...absence, snapshotId: 'replacement', sequence: 1, observationId: 'first' });
  expect(() =>
    open.record({
      ...absence,
      snapshotId: 'replacement',
      sequence: 2,
      observationId: 'second',
      result: captureSelectionRead({ kind: 'stat', path: adapter }),
    })
  ).toThrow('Selection observation replacement or repeated identity refused');
  expect(open.observations[0].result).toEqual(absence.result);
});

test('retained launcher sentinel escapes broad manifest discovery catch', async () => {
  const f = fixture(),
    retainedBootstrap = '# older retained bootstrap\n';
  write(path.join(f.options.home, 'bin/caws-hook'), retainedBootstrap, true);
  const retainedManifest = JSON.stringify({
    'launcher.py': sha('# prior launcher\n'),
    'bootstrap.py': sha(retainedBootstrap),
  });
  const retainedPath = path.join(
    f.options.home,
    'lib/runtimes',
    sha(retainedManifest),
    'manifest.json'
  );
  write(retainedPath, retainedManifest);
  write(path.join(f.options.canonical, '.codex/hooks.json'), {
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            { type: 'command', command: machineCommand(f.options.home, 'codex', 'pre_tool_use') },
          ],
        },
      ],
    },
  });
  const captured = await observe(f.options);
  expect(captured.selection).toEqual({
    status: 'inactive',
    reason: 'legacy native registration remains selected',
  });
  expect(
    captured.snapshot.observations.some(
      (row) => row.operation.kind === 'runtime-file' && row.operation.path === retainedPath
    )
  ).toBe(true);
});

test('first discovery hashes a captured large runtime member once before complete verification', async () => {
  const bulk = Buffer.alloc(256 * 1024, 71),
    expectedBulkDigest = sha(bulk);
  const f = fixture({ 'bulk.bin': bulk }),
    bulkPath = path.join(f.runtime, 'bulk.bin');
  const createHash = crypto.createHash;
  let hashesOfBulk = 0,
    bulkCaptured = false,
    capturesAfterBulk = 0;
  jest.spyOn(crypto, 'createHash').mockImplementation((...args) => {
    const hash = createHash(...args),
      update = hash.update;
    hash.update = function (data, ...rest) {
      if (Buffer.isBuffer(data) && data.equals(bulk)) hashesOfBulk++;
      return update.call(this, data, ...rest);
    };
    return hash;
  });
  const captured = await observe(f.options, snapshot(), async (request) => {
    if (bulkCaptured) capturesAfterBulk++;
    if (request.operation.kind === 'runtime-file' && request.operation.path === bulkPath)
      bulkCaptured = true;
    return reply(request);
  });
  expect(captured.selection.status).toBe('active');
  expect(bulkCaptured).toBe(true);
  expect(capturesAfterBulk).toBeGreaterThan(1);
  expect(hashesOfBulk).toBe(1);
  expect(captured.snapshot.runtimeSnapshots).toHaveLength(1);
  const manifest = verifyRuntime(f.options.home, f.options.runtimeDigest, captured.snapshot.io);
  manifest['bulk.bin'] = 'mutated returned manifest';
  expect(
    verifyRuntime(f.options.home, f.options.runtimeDigest, captured.snapshot.io)['bulk.bin']
  ).toBe(expectedBulkDigest);
  expect(hashesOfBulk).toBe(1);
  expect(Object.isFrozen(captured.snapshot.runtimeSnapshots[0])).toBe(true);
  expect(Object.isFrozen(captured.snapshot.runtimeSnapshots[0].observations)).toBe(true);
});

test('fresh observation refuses changed runtime bytes instead of borrowing successful verification', async () => {
  const f = fixture(),
    original = await observe(f.options, snapshot('verified-original'));
  expect(original.snapshot.runtimeSnapshots).toHaveLength(1);
  write(path.join(f.runtime, 'first.sh'), '#!/bin/sh\nexit 19\n', true);
  const fresh = snapshot('changed-generation');
  await expect(observe(f.options, fresh)).rejects.toThrow(
    'Machine runtime file modified: first.sh'
  );
  expect(fresh.runtimeSnapshots).toHaveLength(0);
  expect(resolveInvocationSelection({ ...f.options, io: original.snapshot.io })).toEqual(
    original.selection
  );
});

test.each(['access', 'not-directory'])(
  'live and captured selection retain %s refusal type code and message',
  async (kind) => {
    const f = fixture();
    if (kind === 'access') fs.chmodSync(path.join(f.runtime, 'first.sh'), 0o644);
    else write(path.join(f.options.home, 'surfaces/codex/lib'), 'not a directory');
    let liveError, observedError;
    try {
      resolveInvocationSelection(f.options);
    } catch (error) {
      liveError = error;
    }
    try {
      await observe(f.options);
    } catch (error) {
      observedError = error;
    }
    expect(liveError.code).toBe(kind === 'access' ? 'EACCES' : 'ENOTDIR');
    expect(observedError.constructor.name).toBe(liveError.constructor.name);
    expect({
      name: observedError.name,
      message: observedError.message,
      code: observedError.code,
    }).toEqual({ name: liveError.name, message: liveError.message, code: liveError.code });
  }
);

test.each(['mode', 'inventory'])('fresh snapshot rechecks native runtime %s', async (change) => {
  const f = fixture({}, true),
    before = await observe(f.options, snapshot('native-before'));
  expect(before.selection.status).toBe('active');
  expect(before.snapshot.runtimeSnapshots).toHaveLength(1);
  if (change === 'mode') fs.chmodSync(path.join(f.runtime, 'first.sh'), 0o644);
  else write(path.join(f.runtime, 'extra.txt'), 'undeclared native member');
  const fresh = snapshot('native-after');
  await expect(observe(f.options, fresh)).rejects.toThrow(
    `Native runtime member mode mismatch: ${change === 'mode' ? 'first.sh' : 'extra.txt'}`
  );
  expect(fresh.runtimeSnapshots).toHaveLength(0);
  expect(resolveInvocationSelection({ ...f.options, io: before.snapshot.io })).toEqual(
    before.selection
  );
});

test('failed and incomplete verification never populate the successful runtime memo', async () => {
  const f = fixture(),
    pending = snapshot();
  await expect(
    resolveObservedInvocationSelection(f.options, {
      snapshot: pending,
      maximumRequests: 1,
      capture: async (request) => reply(request),
    })
  ).rejects.toThrow('Selection observation request limit exceeded');
  expect(pending.runtimeSnapshots).toHaveLength(0);
  const failure = new Error('verification failed');
  expect(() =>
    pending.io.verifyRuntime('/home', 'a'.repeat(64), () => {
      throw failure;
    })
  ).toThrow(failure);
  expect(pending.runtimeSnapshots).toHaveLength(0);
});

test('an unrelated verifier cannot seed the canonical runtime verification cache', async () => {
  const f = fixture(),
    supplied = snapshot('untrusted-verifier');
  supplied.io.verifyRuntime(f.options.home, f.options.runtimeDigest, () => ({
    'first.sh': sha('wrong'),
  }));
  write(path.join(f.runtime, 'first.sh'), '#!/bin/sh\nexit 19\n', true);
  await expect(observe(f.options, supplied)).rejects.toThrow(
    'Machine runtime file modified: first.sh'
  );
});

test.each(['snapshot', 'sequence', 'operation', 'kind', 'identity'])(
  'driver refuses malformed or uncorrelated %s replies',
  async (corruption) => {
    const f = fixture();
    let calls = 0;
    await expect(
      observe(f.options, snapshot(), async (request) => {
        calls++;
        const value = reply(request);
        if (corruption === 'snapshot') value.snapshotId = 'foreign-snapshot';
        if (corruption === 'sequence') value.sequence++;
        if (corruption === 'operation')
          value.operation = { ...value.operation, path: '/foreign/path' };
        if (corruption === 'kind') value.result = { kind: 'bytes', base64: 'not canonical base64' };
        if (corruption === 'identity') value.observationId = '';
        return value;
      })
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
);

test('ordinary capture failures do not trigger sentinel retries', async () => {
  const f = fixture(),
    reason = new Error('Selection requires a captured read observation');
  let calls = 0;
  await expect(
    observe(f.options, snapshot(), async () => {
      calls++;
      throw reason;
    })
  ).rejects.toBe(reason);
  expect(calls).toBe(1);
});

test('count and byte limits refuse before retaining an observation', () => {
  const file = path.join(root, 'missing'),
    operation = { kind: 'exists', path: file };
  const first = {
    snapshotId: 'limits',
    sequence: 1,
    observationId: 'first',
    operation,
    result: { kind: 'exists', value: false },
  };
  const count = snapshot('limits', { maximumObservations: 1 });
  count.record(first);
  expect(() =>
    count.record({
      ...first,
      sequence: 2,
      observationId: 'second',
      operation: { ...operation, path: file + '-other' },
    })
  ).toThrow('Selection observation count limit exceeded');
  expect(count.observations).toHaveLength(1);
  const bytes = snapshot('limits', { maximumBytes: 1 });
  expect(() => bytes.record(first)).toThrow('Selection observation byte limit exceeded');
  expect(bytes.observations).toHaveLength(0);
});

test('cancellation rejects a pending capture without retaining another observation', async () => {
  const f = fixture(),
    controller = new AbortController(),
    reason = new Error('capture cancelled'),
    pending = snapshot();
  const result = resolveObservedInvocationSelection(f.options, {
    snapshot: pending,
    maximumRequests: 10,
    signal: controller.signal,
    capture: async () => {
      controller.abort(reason);
      return new Promise(() => {});
    },
  });
  await expect(result).rejects.toBe(reason);
  expect(pending.observations).toHaveLength(0);
});
