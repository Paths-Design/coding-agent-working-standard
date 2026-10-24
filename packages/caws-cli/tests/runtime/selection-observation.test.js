const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AbortController } = globalThis;
const {
  sha,
  verifyRuntime,
  ensureRuntimeVerified,
} = require('../../dist/init/machine-runtime-state');
const { MACHINE_EVENTS, machineCommand } = require('../../dist/init/native-hook-identification');
const { captureSelectionRead, liveSelectionReadIo } = require('../../dist/init/selection-read-io');
const { resolveInvocationSelection } = require('../../dist/runtime/selection');
const { assertMachinePath } = require('../../dist/init/machine-paths');
const {
  SelectionObservationSnapshot,
  resolveObservedInvocationSelection,
  createNativeSelectionResolver,
} = require('../../dist/runtime/selection-observation');

test('path identity is immutable evidence and cannot satisfy metadata, inventory or bytes', () => {
  const file = path.join(root, 'owned-directory');
  fs.mkdirSync(file);
  const supplied = snapshot('narrow-path');
  const operation = { kind: 'path-identity', path: file },
    result = captureSelectionRead(operation);
  const original = { ...result.value };
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'identity-1',
    operation,
    result,
  });
  result.value = { ...result.value, ino: '999999' };
  expect(supplied.io.pathIdentity(file)).toEqual(original);
  expect(Object.isFrozen(supplied.io.pathIdentity(file))).toBe(true);
  expect(() => supplied.io.lstat(file)).toThrow('Selection requires a captured read observation');
  expect(() => supplied.io.stat(file)).toThrow('Selection requires a captured read observation');
  expect(() => supplied.io.readDirectory(file)).toThrow(
    'Selection requires a captured read observation'
  );
  expect(() => supplied.io.readFile(file)).toThrow(
    'Selection requires a captured read observation'
  );
  const full = captureSelectionRead({ kind: 'lstat', path: file });
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 2,
    observationId: 'full-2',
    operation: { kind: 'lstat', path: file },
    result: full,
  });
  expect(supplied.io.lstat(file)).toEqual(full.value);
  expect(supplied.io.lstat(file).ctimeMs).toBe(full.value.ctimeMs);
  supplied.seal();
  fs.renameSync(file, path.join(root, 'original-directory'));
  fs.mkdirSync(file);
  expect(captureSelectionRead(operation).value.ino).not.toBe(original.ino);
  expect(supplied.io.pathIdentity(file)).toEqual(original);
  // Revalidating retained identity belongs to native seal/dispatch. A TS
  // snapshot supplies prior evidence, not a claim that the pathname is fresh.
});

test.each([
  ['wrong result', (row) => ({ ...row, result: { kind: 'info', value: row.result.value } })],
  [
    'extra timestamp',
    (row) => ({ ...row, result: { ...row.result, value: { ...row.result.value, ctimeMs: 0 } } }),
  ],
  [
    'missing mode',
    (row) => {
      const value = { ...row.result.value };
      delete value.mode;
      return { ...row, result: { ...row.result, value } };
    },
  ],
  [
    'invalid kind',
    (row) => ({
      ...row,
      result: { ...row.result, value: { ...row.result.value, kind: 'socket' } },
    }),
  ],
  [
    'nondecimal device',
    (row) => ({ ...row, result: { ...row.result, value: { ...row.result.value, dev: '-1' } } }),
  ],
  [
    'numeric inode',
    (row) => ({ ...row, result: { ...row.result, value: { ...row.result.value, ino: 42 } } }),
  ],
  [
    'unsafe mode',
    (row) => ({
      ...row,
      result: { ...row.result, value: { ...row.result.value, mode: Number.MAX_SAFE_INTEGER + 1 } },
    }),
  ],
  [
    'negative mode',
    (row) => ({ ...row, result: { ...row.result, value: { ...row.result.value, mode: -1 } } }),
  ],
  ['singleLink false', (row) => ({ ...row, operation: { ...row.operation, singleLink: false } })],
])('path identity refuses %s without recording progress', (_case, alter) => {
  const supplied = snapshot('invalid-path-identity'),
    operation = { kind: 'path-identity', path: root };
  const row = {
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'identity-1',
    operation,
    result: captureSelectionRead(operation),
  };
  expect(() => supplied.record(alter(row))).toThrow();
  expect(supplied.observations).toEqual([]);
  supplied.record(row);
  expect(supplied.io.pathIdentity(root)).toEqual(row.result.value);
});

test('path absence stays original ENOENT and fresh evidence exposes an appearing symlink', () => {
  const file = path.join(root, 'appearing'),
    operation = { kind: 'path-identity', path: file };
  const supplied = snapshot('identity-absence'),
    result = captureSelectionRead(operation);
  expect(result).toMatchObject({ kind: 'error', code: 'ENOENT' });
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'missing-1',
    operation,
    result,
  });
  supplied.seal();
  fs.symlinkSync(root, file);
  expect(captureSelectionRead(operation)).toMatchObject({
    kind: 'path-identity',
    value: { kind: 'symlink' },
  });
  expect(() => assertMachinePath(root, file)).toThrow('Refusing symlink');
  let originalError;
  try {
    supplied.io.pathIdentity(file);
  } catch (error) {
    originalError = error;
  }
  expect(originalError).toMatchObject({ code: 'ENOENT', message: result.message });
  expect(() => supplied.io.lstat(file)).toThrow('Uncaptured read in sealed selection snapshot');
});

test('narrow identity cannot be presented as generic lstat information', () => {
  const supplied = snapshot('full-info-required'),
    operation = { kind: 'lstat', path: root };
  const narrow = captureSelectionRead({ kind: 'path-identity', path: root });
  expect(() =>
    supplied.record({
      snapshotId: supplied.snapshotId,
      sequence: 1,
      observationId: 'wrong-info',
      operation,
      result: { kind: 'info', value: narrow.value },
    })
  ).toThrow('Invalid selection file information');
  expect(supplied.observations).toEqual([]);
});

test('compact runtime digest is immutable data and full byte capture stays a separate operation', () => {
  const file = path.join(root, 'runtime-member');
  write(file, 'original runtime bytes');
  const supplied = snapshot('compact-digest');
  const operation = { kind: 'runtime-digest', path: file, singleLink: false };
  const result = captureSelectionRead(operation);
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'digest-1',
    operation,
    result,
  });
  result.sha256 = 'f'.repeat(64);
  expect(supplied.io.runtimeFileDigest(file)).toBe(sha('original runtime bytes'));
  expect(() => supplied.io.readRuntimeFile(file)).toThrow(
    'Selection requires a captured read observation'
  );
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 2,
    observationId: 'bytes-2',
    operation: { kind: 'runtime-file', path: file, singleLink: false },
    result: captureSelectionRead({ kind: 'runtime-file', path: file }),
  });
  supplied.seal();
  fs.writeFileSync(file, 'new ambient bytes');
  expect(supplied.io.runtimeFileDigest(file)).toBe(sha('original runtime bytes'));
  expect(supplied.io.readRuntimeFile(file).bytes.toString()).toBe('original runtime bytes');
  expect(supplied.runtimeSnapshots).toHaveLength(0);
});

test.each([
  ['wrong-kind', (result) => ({ kind: 'runtime-file', base64: '', stat: result.stat })],
  ['uppercase', (result) => ({ ...result, sha256: 'A'.repeat(64) })],
  ['short', (result) => ({ ...result, sha256: 'a'.repeat(63) })],
  ['extra-key', (result) => ({ ...result, base64: '' })],
  ['missing-stat', (result) => ({ kind: result.kind, sha256: result.sha256 })],
  [
    'unsafe-size',
    (result) => ({ ...result, stat: { ...result.stat, size: Number.MAX_SAFE_INTEGER + 1 } }),
  ],
  ['nonfile', (result) => ({ ...result, stat: { ...result.stat, kind: 'symlink' } })],
  ['extra-stat-key', (result) => ({ ...result, stat: { ...result.stat, authorized: true } })],
])('runtime-digest decoder refuses %s without recording progress', (_case, alter) => {
  const file = path.join(root, 'runtime-member');
  write(file, 'runtime bytes');
  const supplied = snapshot('bad-digest');
  const operation = { kind: 'runtime-digest', path: file };
  const result = captureSelectionRead(operation);
  const row = {
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'digest-1',
    operation,
    result: alter(result),
  };
  expect(() => supplied.record(row)).toThrow();
  expect(supplied.observations).toHaveLength(0);
  supplied.record({ ...row, result });
  expect(supplied.io.runtimeFileDigest(file)).toBe(sha('runtime bytes'));
});

test('digest single-link requests enforce nlink while ordinary digest reads permit hardlinks', () => {
  const file = path.join(root, 'runtime-member');
  write(file, 'runtime bytes');
  fs.linkSync(file, path.join(root, 'hardlink'));
  const result = captureSelectionRead({ kind: 'runtime-digest', path: file });
  expect(result.stat.nlink).toBe(2);
  const supplied = snapshot('link-bound');
  const row = {
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'digest-1',
    operation: { kind: 'runtime-digest', path: file, singleLink: true },
    result,
  };
  expect(() => supplied.record(row)).toThrow(
    'Selection observation result does not match its operation'
  );
  supplied.record({ ...row, operation: { ...row.operation, singleLink: false } });
  expect(supplied.io.runtimeFileDigest(file)).toBe(sha('runtime bytes'));
});

test('well-formed mismatching runtime digest cannot satisfy the actual manifest verifier', async () => {
  const f = fixture();
  const file = path.join(f.runtime, 'first.sh');
  await expect(
    observe(f.options, snapshot('wrong-digest'), async (request) => {
      const row = reply(request);
      if (request.operation.kind === 'runtime-digest' && request.operation.path === file)
        row.result.sha256 = 'f'.repeat(64);
      return row;
    })
  ).rejects.toThrow('Machine runtime file modified: first.sh');
});

test('runtime digest response for a different requested path cannot satisfy discovery', async () => {
  const f = fixture();
  await expect(
    observe(f.options, snapshot('wrong-path'), async (request) => {
      const row = reply(request);
      if (request.operation.kind === 'runtime-digest')
        row.operation = { ...row.operation, path: path.join(f.runtime, 'different-member') };
      return row;
    })
  ).rejects.toThrow('Selection capture operation mismatch');
});

test('compact digest absence remains the original observed ENOENT error', () => {
  const file = path.join(root, 'absent-member'),
    supplied = snapshot('digest-absence');
  const operation = { kind: 'runtime-digest', path: file };
  const result = captureSelectionRead(operation);
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'absent-1',
    operation,
    result,
  });
  let error;
  try {
    supplied.io.runtimeFileDigest(file);
  } catch (failure) {
    error = failure;
  }
  expect(error).toMatchObject({ name: result.name, message: result.message, code: 'ENOENT' });
  expect(supplied.observations).toHaveLength(1);
});

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
  expect(captured.snapshot.io.runtimeFileDigest(member)).toBe(sha('#!/bin/sh\nexit 0\n'));
  expect(() => captured.snapshot.io.readRuntimeFile(member)).toThrow(
    'Uncaptured read in sealed selection snapshot'
  );
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
    (row) => row.operation.kind === 'path-identity' && row.operation.path === directory
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
    (row) => row.operation.kind === 'path-identity' && row.operation.path === directory
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

test.each([false, true])(
  'verification-only discovery avoids discarded manifest copies with identical observations (native=%s)',
  async (native) => {
    const f = fixture({ 'copy-control.bin': 'retained bytes' }, native);
    const selector = require('../../dist/runtime/selection');
    const original = selector.resolveInvocationSelection;
    const freeze = Object.freeze;
    let copies = 0;
    // Count enumeration of the actual frozen cache manifest, rather than wall
    // time or helper calls that could hide another discarded copy.
    jest.spyOn(Object, 'freeze').mockImplementation((value) => {
      const frozen = freeze(value);
      if (value && typeof value === 'object' && Object.hasOwn(value, 'copy-control.bin')) {
        return new Proxy(frozen, {
          ownKeys(target) {
            copies++;
            return Reflect.ownKeys(target);
          },
        });
      }
      return frozen;
    });
    let legacy = true;
    jest.spyOn(selector, 'resolveInvocationSelection').mockImplementation((options) =>
      original({
        ...options,
        io: legacy ? { ...options.io, ensureRuntimeVerified: undefined } : options.io,
      })
    );
    const run = async () => {
      if (native) {
        const transport = selectionTransport(f);
        const selection = await transport.resolve(f.options);
        return { selection, operations: transport.writes.map((row) => row.operation) };
      }
      const observed = await observe(f.options, snapshot());
      return {
        selection: observed.selection,
        operations: observed.snapshot.observations.map((row) => row.operation),
      };
    };
    const before = await run(),
      legacyCopies = copies;
    legacy = false;
    copies = 0;
    const after = await run();
    console.info(
      JSON.stringify({
        native,
        legacyCopies,
        verificationOnlyCopies: copies,
        observations: after.operations.length,
      })
    );
    expect(before.selection.status).toBe('active');
    expect(legacyCopies).toBeGreaterThan(1);
    expect(after).toEqual(before);
    expect(copies).toBe(0);
  }
);

test('verification-only hooks preserve canonical callback and legacy custom IO semantics', async () => {
  const f = fixture(),
    captured = await observe(f.options);
  const verify = jest.fn((home, digest, canonical) => {
    expect(home).toBe(f.options.home);
    expect(digest).toBe(f.options.runtimeDigest);
    return canonical(home, digest, captured.snapshot.io);
  });
  const legacy = {
    ...captured.snapshot.io,
    ensureRuntimeVerified: undefined,
    verifyRuntime: verify,
  };
  expect(ensureRuntimeVerified(f.options.home, f.options.runtimeDigest, legacy)).toBeUndefined();
  const canonical = verify.mock.calls[0][2];
  const ensure = jest.fn();
  expect(
    ensureRuntimeVerified(f.options.home, f.options.runtimeDigest, {
      ...legacy,
      ensureRuntimeVerified: ensure,
    })
  ).toBeUndefined();
  expect(ensure).toHaveBeenCalledWith(f.options.home, f.options.runtimeDigest, canonical);
  expect(verify).toHaveBeenCalledTimes(1);
  // With no optional hooks, the ordinary complete verifier still executes.
  expect(
    ensureRuntimeVerified(f.options.home, f.options.runtimeDigest, liveSelectionReadIo)
  ).toBeUndefined();
  write(path.join(f.runtime, 'first.sh'), '#!/bin/sh\nexit 42\n', true);
  expect(() =>
    ensureRuntimeVerified(f.options.home, f.options.runtimeDigest, liveSelectionReadIo)
  ).toThrow('Machine runtime file modified: first.sh');
});

test('verification-only cache retains verifier/home/digest/snapshot separation and copy ownership', () => {
  const a = snapshot('verification-a'),
    b = snapshot('verification-b');
  const first = jest.fn(() => ({ member: 'original' }));
  const second = jest.fn(() => ({ member: 'different verifier' }));
  const home = '/home',
    digest = 'a'.repeat(64);
  a.io.ensureRuntimeVerified(home, digest, first);
  a.io.ensureRuntimeVerified(home, digest, first);
  expect(first).toHaveBeenCalledTimes(1);
  const returned = a.io.verifyRuntime(home, digest, first);
  returned.member = 'caller mutation';
  expect(a.io.verifyRuntime(home, digest, first)).toEqual({ member: 'original' });
  expect(first).toHaveBeenCalledTimes(1);
  a.io.ensureRuntimeVerified(home, digest, second);
  expect(second).toHaveBeenCalledTimes(1);
  expect(a.io.verifyRuntime(home, digest, second)).toEqual({ member: 'different verifier' });
  a.io.ensureRuntimeVerified('/other', digest, first);
  a.io.ensureRuntimeVerified(home, 'b'.repeat(64), first);
  b.io.ensureRuntimeVerified(home, digest, first);
  expect(first).toHaveBeenCalledTimes(4);
  expect(a.runtimeSnapshots).toHaveLength(4);
  expect(b.runtimeSnapshots).toHaveLength(1);
});

test('cached verification-only dependencies join outer collection and refuse replacement', () => {
  const supplied = snapshot('nested-verification');
  const operation = { kind: 'read', path: '/captured-input' };
  const row = {
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'input-1',
    operation,
    result: { kind: 'bytes', base64: Buffer.from('original').toString('base64') },
  };
  supplied.record(row);
  const inner = jest.fn((_home, _digest, io) => ({
    member: io.readFile(operation.path).toString(),
  }));
  const outer = jest.fn((home, digest, io) => {
    io.ensureRuntimeVerified(home, digest, inner);
    return { outer: 'verified' };
  });
  supplied.io.ensureRuntimeVerified('/home', 'a'.repeat(64), inner);
  supplied.io.ensureRuntimeVerified('/home', 'a'.repeat(64), outer);
  supplied.io.ensureRuntimeVerified('/home', 'a'.repeat(64), outer);
  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).toHaveBeenCalledTimes(1);
  expect(supplied.runtimeSnapshots).toHaveLength(2);
  const [innerResult, outerResult] = supplied.runtimeSnapshots;
  expect(innerResult.observations).toHaveLength(1);
  expect(outerResult.observations).toHaveLength(1);
  expect(outerResult.observations[0]).toBe(innerResult.observations[0]);
  expect(outerResult.observations[0]).toBe(supplied.observations[0]);
  expect(Object.isFrozen(outerResult.observations[0])).toBe(true);
  expect(() => supplied.record({ ...row, sequence: 2, observationId: 'replacement' })).toThrow(
    'replacement or repeated identity refused'
  );
  const incomplete = snapshot('incomplete-only');
  expect(() => incomplete.io.ensureRuntimeVerified('/home', 'a'.repeat(64), inner)).toThrow(
    'Selection requires a captured read observation'
  );
  expect(incomplete.runtimeSnapshots).toEqual([]);
});

test('first discovery uses a compact digest for a large runtime member without carrying its bytes', async () => {
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
    if (request.operation.kind === 'runtime-digest' && request.operation.path === bulkPath)
      bulkCaptured = true;
    return reply(request);
  });
  expect(captured.selection.status).toBe('active');
  expect(bulkCaptured).toBe(true);
  const bulkRows = captured.snapshot.observations.filter((row) => row.operation.path === bulkPath);
  expect(bulkRows.filter((row) => row.operation.kind === 'runtime-file')).toEqual([]);
  expect(bulkRows.find((row) => row.operation.kind === 'runtime-digest').result).toEqual({
    kind: 'runtime-digest',
    sha256: expectedBulkDigest,
    stat: liveSelectionReadIo.lstat(bulkPath),
  });
  expect(JSON.stringify(bulkRows).length).toBeLessThan(4096);
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

function retainMetadataParseBinding(label, observation) {
  const parent = process.env.CAWS_TEST_ARTIFACT_DIR;
  if (!parent) return;
  if (!path.isAbsolute(parent)) throw new Error('Metadata artifact root must be absolute');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'metadata-parse-binding-'));
  fs.writeFileSync(
    path.join(directory, 'observation.json'),
    JSON.stringify(
      {
        schema: 'caws.ts.metadata_hash_to_parse.observation.v1',
        synthetic: true,
        component: 'resolveInvocationSelection -> verifyRuntime -> verifyNativeLayout',
        label,
        ...observation,
      },
      null,
      2
    ) + '\n'
  );
}

test.each(['native-entry.json', 'native-modes.json'])(
  'native metadata parse binding: altered %s read cannot borrow its earlier hash',
  (name) => {
    const f = fixture({}, true),
      target = path.join(f.runtime, name);
    const original = fs.readFileSync(target),
      value = JSON.parse(original);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.runtime, 'manifest.json')));
    const engine = path.join(f.runtime, 'client/engine.js');
    const originalMode = fs.statSync(engine).mode & 0o7777;
    if (name === 'native-entry.json') value.timeoutMs = 1001;
    else value['client/engine.js'] = 0o755;
    const altered = Buffer.from(JSON.stringify(value));
    const reads = [],
      inventoryModes = [];
    let changed = false,
      restoredAtInventory = false,
      pendingMode = false;
    function restore() {
      fs.writeFileSync(target, original);
      fs.chmodSync(engine, originalMode);
      pendingMode = false;
    }
    const io = {
      ...liveSelectionReadIo,
      readRuntimeFile(file, singleLink = false) {
        if (file !== target) return liveSelectionReadIo.readRuntimeFile(file, singleLink);
        const read = reads.length + 1;
        if (read === 2) {
          fs.writeFileSync(target, altered);
          if (name === 'native-modes.json') {
            fs.chmodSync(engine, 0o755);
            pendingMode = true;
          }
          changed = true;
        }
        const captured = liveSelectionReadIo.readRuntimeFile(file, singleLink);
        reads.push({
          phase: read === 1 ? 'manifest_member_hash' : 'metadata_parse_capture',
          read,
          payloadSha256: sha(captured.bytes),
          namedPayloadSha256: sha(fs.readFileSync(target)),
          capturedCandidateMetadata: JSON.parse(captured.bytes),
          capturedStat: captured.stat,
        });
        // The returned capture owns its buffer. Restoring the pathname does
        // not rewrite the actual later bytes supplied to the metadata parser.
        if (name === 'native-entry.json' && read === 2) restore();
        return captured;
      },
      lstat(file) {
        const info = liveSelectionReadIo.lstat(file);
        if (file === engine && pendingMode) {
          inventoryModes.push(info.mode & 0o7777);
          restore();
          restoredAtInventory = true;
        }
        return info;
      },
    };
    let selected = null,
      failure = null;
    try {
      selected = resolveInvocationSelection({ ...f.options, io });
    } catch (error) {
      failure = { name: error.name, message: error.message };
    } finally {
      restore();
    }
    let restoredVerification = null,
      restoredError = null;
    try {
      restoredVerification = verifyRuntime(f.options.home, f.options.runtimeDigest);
    } catch (error) {
      restoredError = { name: error.name, message: error.message };
    }
    const restored = {
      payloadSha256: sha(fs.readFileSync(target)),
      engineMode: fs.statSync(engine).mode & 0o7777,
      verificationOk: restoredVerification !== null,
      verificationError: restoredError,
    };
    // Persist observed old admission or repaired refusal BEFORE assertions.
    retainMetadataParseBinding(name, {
      runtimeDigest: f.options.runtimeDigest,
      target: name,
      expectedPayloadSha256: manifest[name],
      originalPayloadSha256: sha(original),
      alteredPayloadSha256: sha(altered),
      changed,
      reads,
      inventoryModes,
      restoredAtInventory,
      originalEngineMode: originalMode,
      admitted: selected?.status === 'active',
      actualSelection: selected,
      error: failure,
      restored,
      boundary:
        'Real private file captures through existing IO; fixture executables are not launched. Metadata fields in reads are the actual delivered capture, not an independently exposed parser result.',
    });
    expect(changed).toBe(true);
    expect(reads).toHaveLength(2);
    expect(reads[0].payloadSha256).toBe(manifest[name]);
    expect(reads[1].payloadSha256).toBe(sha(altered));
    expect(sha(altered)).not.toBe(manifest[name]);
    expect(restored).toMatchObject({
      payloadSha256: manifest[name],
      engineMode: originalMode,
      verificationOk: true,
      verificationError: null,
    });
    expect(failure?.message).toBe(
      `Machine runtime file modified: ${name}; preserve and reconcile local growth before updating`
    );
    expect(selected).toBeNull();
  }
);

test('native metadata parse binding: unchanged live and immutable snapshot reads retain selection', async () => {
  const f = fixture({}, true),
    counts = {};
  const io = {
    ...liveSelectionReadIo,
    readRuntimeFile(file, singleLink = false) {
      if (
        ['native-entry.json', 'native-modes.json'].some(
          (name) => file === path.join(f.runtime, name)
        )
      )
        counts[file] = (counts[file] ?? 0) + 1;
      return liveSelectionReadIo.readRuntimeFile(file, singleLink);
    },
  };
  const selected = resolveInvocationSelection({ ...f.options, io });
  const observed = await observe(f.options, snapshot('unchanged-metadata-binding'));
  const metadataRows = observed.snapshot.observations.filter(
    (row) =>
      row.operation.kind === 'runtime-file' &&
      ['native-entry.json', 'native-modes.json'].some(
        (name) => row.operation.path === path.join(f.runtime, name)
      )
  );
  retainMetadataParseBinding('unchanged', {
    runtimeDigest: f.options.runtimeDigest,
    admitted: selected.status === 'active',
    actualSelection: selected,
    snapshotSelection: observed.selection,
    liveReadCounts: counts,
    metadataObservations: metadataRows,
  });
  expect(selected.status).toBe('active');
  expect(observed.selection).toEqual(selected);
  expect(metadataRows).toHaveLength(2);
  for (const name of ['native-entry.json', 'native-modes.json'])
    expect(counts[path.join(f.runtime, name)]).toBe(2);
});

test('native directory closure: undeclared empty tree refuses before descent', () => {
  const f = fixture({}, true),
    unadmitted = path.join(f.runtime, 'undeclared');
  fs.mkdirSync(path.join(unadmitted, 'deeper/deepest'), { recursive: true });
  const descended = [];
  const io = {
    ...liveSelectionReadIo,
    readDirectory(directory) {
      if (directory === unadmitted || directory.startsWith(unadmitted + path.sep))
        descended.push(directory);
      return liveSelectionReadIo.readDirectory(directory);
    },
  };
  let selected = null,
    failure = null;
  try {
    selected = resolveInvocationSelection({ ...f.options, io });
  } catch (error) {
    failure = { name: error.name, message: error.message };
  }
  retainMetadataParseBinding('undeclared-empty-directory', {
    runtimeDigest: f.options.runtimeDigest,
    firstUndeclaredComponent: 'undeclared',
    descendantDepth: 3,
    descended,
    admitted: selected?.status === 'active',
    actualSelection: selected,
    error: failure,
    boundary: 'Existing real directory reads and synthetic component fixture; no engine executed.',
  });
  expect(failure?.message).toBe('Undeclared native runtime directory: undeclared');
  expect(descended).toEqual([]);
  expect(selected).toBeNull();
});

function selectionTransport(fixture, changes = {}) {
  const controller = changes.controller ?? new AbortController();
  const request = {
    id: 'transport-original',
    runtimeDigest: fixture.options.runtimeDigest,
    deadlineEpochMs: Date.now() + 20_000,
    selectionObservation: {
      schema: 'caws.runtime.selection-observation.v1',
      snapshotId: 'native-original-snapshot',
      limits: {
        maximumObservations: 4096,
        maximumBytes: 8 * 1024 * 1024,
        maximumPathBytes: 8192,
        ...changes.limits,
      },
    },
  };
  const queue = [],
    writes = [];
  const transport = {
    async write(frame) {
      writes.push(frame);
      const common = {
        id: frame.id,
        runtimeDigest: frame.runtimeDigest,
        snapshotId: frame.snapshotId,
        sequence: frame.sequence,
      };
      const row = {
        snapshotId: frame.snapshotId,
        sequence: frame.sequence,
        observationId: 'native-' + frame.sequence,
        operation: frame.operation,
        // Native-side fixture only: actual Rust generation validation belongs to
        // its receipt tests. Never ask tooling to manufacture this summary.
        result:
          frame.operation.kind === 'runtime-generation'
            ? (() => {
                if (frame.operation.path !== fixture.runtime)
                  throw Error('native generation root mismatch');
                return {
                  kind: 'runtime-generation',
                  digest: fixture.options.runtimeDigest,
                  manifest: JSON.parse(
                    fs.readFileSync(path.join(fixture.runtime, 'manifest.json'), 'utf8')
                  ),
                };
              })()
            : captureSelectionRead(frame.operation),
      };
      const raw = changes.body ? changes.body(row) : Buffer.from(JSON.stringify(row));
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      let header = {
        schema: 'caws.runtime.selection-observation.result.v1',
        ...common,
        byteLength: bytes.length,
        sha256: sha(bytes),
      };
      if (changes.header) header = changes.header(header);
      queue.push(Buffer.from(JSON.stringify(header)));
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        let chunk = {
          schema: 'caws.runtime.selection-observation.chunk.v1',
          ...common,
          offset,
          base64: bytes.subarray(offset, offset + 65536).toString('base64'),
        };
        if (changes.chunk) chunk = changes.chunk(chunk);
        queue.push(Buffer.from(JSON.stringify(chunk)));
      }
      changes.afterWrite?.(controller);
    },
    async read() {
      if (!queue.length) throw Error('controlled selection EOF');
      return queue.shift();
    },
  };
  return {
    request,
    writes,
    queue,
    controller,
    resolve: createNativeSelectionResolver(request, transport, controller.signal),
  };
}

test('native selection transport assembles bounded chunks and resolves the existing selector once', async () => {
  const f = fixture({}, true);
  let bodies = 0;
  const state = selectionTransport(f, {
    body: (row) => JSON.stringify(row) + (++bodies === 1 ? ' '.repeat(100_000) : ''),
  });
  const result = await state.resolve(f.options);
  expect(result).toEqual(resolveInvocationSelection(f.options));
  expect(state.writes.filter((row) => row.operation.kind === 'runtime-generation')).toHaveLength(1);
  expect(state.writes.some((row) => row.operation.kind === 'runtime-digest')).toBe(false);
  expect(state.writes.map((row) => row.sequence)).toEqual(state.writes.map((_, i) => i + 1));
  expect(
    state.writes.every(
      (row) =>
        row.id === state.request.id &&
        row.runtimeDigest === state.request.runtimeDigest &&
        row.snapshotId === state.request.selectionObservation.snapshotId
    )
  ).toBe(true);
  expect(state.queue).toEqual([]);
  const count = state.writes.length;
  await expect(state.resolve(f.options)).rejects.toThrow('already attempted');
  expect(state.writes).toHaveLength(count);
});

test.each([
  ['foreign id', { header: (row) => ({ ...row, id: 'foreign' }) }],
  ['foreign generation', { header: (row) => ({ ...row, runtimeDigest: 'b'.repeat(64) }) }],
  ['foreign snapshot', { header: (row) => ({ ...row, snapshotId: 'foreign' }) }],
  ['wrong sequence', { header: (row) => ({ ...row, sequence: 2 }) }],
  ['header surplus', { header: (row) => ({ ...row, qualified: true }) }],
  ['digest mismatch', { header: (row) => ({ ...row, sha256: 'f'.repeat(64) }) }],
  ['chunk surplus bytes', { header: (row) => ({ ...row, byteLength: row.byteLength - 1 }) }],
  ['offset gap', { chunk: (row) => ({ ...row, offset: 1 }) }],
  ['chunk identity', { chunk: (row) => ({ ...row, id: 'foreign' }) }],
  ['empty chunk', { chunk: (row) => ({ ...row, base64: '' }) }],
  ['noncanonical base64', { chunk: (row) => ({ ...row, base64: row.base64 + ' ' }) }],
  ['inner snapshot', { body: (row) => JSON.stringify({ ...row, snapshotId: 'foreign' }) }],
  [
    'inner operation',
    {
      body: (row) => JSON.stringify({ ...row, operation: { ...row.operation, path: '/foreign' } }),
    },
  ],
  ['inner duplicate', { body: (row) => JSON.stringify(row).replace('{', '{"sequence":999,') }],
  ['invalid UTF8', { body: () => Buffer.from([0xff]) }],
])(
  'native selection transport consumes %s failure without live fallback or retry',
  async (_name, changes) => {
    const f = fixture({}, true),
      state = selectionTransport(f, changes);
    await expect(state.resolve(f.options)).rejects.toThrow();
    expect(state.writes).toHaveLength(1);
    await expect(state.resolve(f.options)).rejects.toThrow('already attempted');
    expect(state.writes).toHaveLength(1);
  }
);

test('advertised request and aggregate byte bounds are enforced independently', async () => {
  const f = fixture({}, true);
  const count = selectionTransport(f, { limits: { maximumObservations: 1 } });
  await expect(count.resolve(f.options)).rejects.toThrow('request limit');
  expect(count.writes).toHaveLength(1);
  const bytes = selectionTransport(f, { limits: { maximumBytes: 1 } });
  await expect(bytes.resolve(f.options)).rejects.toThrow('result header');
  expect(bytes.writes).toHaveLength(1);
});

test('transport keeps the captured deadline and original cancellation reason', async () => {
  const f = fixture({}, true);
  const expired = selectionTransport(f);
  // Construct an already-expired resolver, then mutate the public request: its
  // captured original deadline cannot be replaced by that later value.
  expired.request.deadlineEpochMs = Date.now() - 1;
  const dead = createNativeSelectionResolver(
    expired.request,
    { read: jest.fn(), write: jest.fn() },
    expired.controller.signal
  );
  expired.request.deadlineEpochMs = Date.now() + 60_000;
  await expect(dead(f.options)).rejects.toThrow('original deadline expired');
  const original = new Error('original selection cancellation');
  const cancelled = selectionTransport(f, {
    afterWrite: (controller) => controller.abort(original),
  });
  await expect(cancelled.resolve(f.options)).rejects.toBe(original);
  expect(cancelled.writes).toHaveLength(1);
  await expect(cancelled.resolve(f.options)).rejects.toThrow('already attempted');
});

test('native canonical verifier uses one bounded generation summary for more than4096 members', async () => {
  const members = Object.fromEntries(
    Array.from({ length: 4200 }, (_, index) => [`bulk/member-${index}`, 'retained member\n'])
  );
  const f = fixture(members, true),
    state = selectionTransport(f);
  const result = await state.resolve(f.options);
  expect(result.status).toBe('active');
  expect(result.handlers.map((row) => row.entry)).toEqual(['first.sh']);
  const summaries = state.writes.filter((row) => row.operation.kind === 'runtime-generation');
  expect(summaries).toHaveLength(1);
  expect(summaries[0].operation).toEqual({ kind: 'runtime-generation', path: f.runtime });
  expect(state.writes.length).toBeLessThan(256);
  expect(
    state.writes.some((row) => row.operation.path.startsWith(path.join(f.runtime, 'bulk')))
  ).toBe(false);
  expect(
    state.writes.some(
      (row) =>
        row.operation.kind === 'read' &&
        row.operation.path === path.join(f.runtime, 'system-policy.json')
    )
  ).toBe(true);
  expect(
    state.writes.some(
      (row) =>
        row.operation.kind === 'read' && row.operation.path === path.join(f.runtime, 'first.sh')
    )
  ).toBe(true);
  // Public/tooling snapshots still run the real complete verifier and cannot
  // silently inherit this native-only optimization or raise their declared cap.
  const plain = snapshot('ordinary-large', { maximumObservations: 64 });
  await expect(observe(f.options, plain)).rejects.toThrow('count limit');
  expect(plain.observations.every((row) => row.operation.kind !== 'runtime-generation')).toBe(true);
});

test.each([
  ['wrong digest', (result) => ({ ...result, digest: 'f'.repeat(64) })],
  [
    'missing launcher',
    (result) => {
      const manifest = { ...result.manifest };
      delete manifest['launcher.py'];
      return { ...result, manifest };
    },
  ],
  [
    'missing native metadata',
    (result) => {
      const manifest = { ...result.manifest };
      delete manifest['native-entry.json'];
      return { ...result, manifest };
    },
  ],
  [
    'bad member hash',
    (result) => ({ ...result, manifest: { ...result.manifest, member: 'A'.repeat(64) } }),
  ],
  [
    'unsafe path',
    (result) => ({ ...result, manifest: { ...result.manifest, '../escape': 'b'.repeat(64) } }),
  ],
  [
    'JS lexical sibling prefix',
    (result) => ({ ...result, manifest: { ...result.manifest, '..fixture': 'b'.repeat(64) } }),
  ],
  ['surplus field', (result) => ({ ...result, qualified: true })],
  ['nonobject manifest', (result) => ({ ...result, manifest: [] })],
])('native generation %s refuses without fallback or a second attempt', async (_name, alter) => {
  const f = fixture({}, true),
    state = selectionTransport(f, {
      body(row) {
        return JSON.stringify(
          row.operation.kind === 'runtime-generation' ? { ...row, result: alter(row.result) } : row
        );
      },
    });
  await expect(state.resolve(f.options)).rejects.toThrow();
  expect(state.writes.filter((row) => row.operation.kind === 'runtime-generation')).toHaveLength(1);
  expect(state.writes.some((row) => row.operation.kind === 'runtime-digest')).toBe(false);
  const count = state.writes.length;
  await expect(state.resolve(f.options)).rejects.toThrow('already attempted');
  expect(state.writes).toHaveLength(count);
});

test('native generation reply for another root and another original digest cannot satisfy discovery', async () => {
  const f = fixture({}, true),
    wrongRoot = selectionTransport(f, {
      body(row) {
        return JSON.stringify(
          row.operation.kind === 'runtime-generation'
            ? {
                ...row,
                operation: { ...row.operation, path: path.join(f.runtime, 'another-generation') },
              }
            : row
        );
      },
    });
  await expect(wrongRoot.resolve(f.options)).rejects.toThrow('operation mismatch');
  const wrongRequest = selectionTransport(f);
  await expect(
    wrongRequest.resolve({ ...f.options, runtimeDigest: 'f'.repeat(64) })
  ).rejects.toThrow('differs from original request');
  expect(wrongRequest.writes).toEqual([]);
  const wrongHome = selectionTransport(f);
  await expect(
    wrongHome.resolve({ ...f.options, home: path.join(root, 'alien-home') })
  ).rejects.toThrow('native generation root mismatch');
});

test('generation summary cannot supply byte reads or let an alien verifier seed or borrow canonical cache', async () => {
  const selector = require('../../dist/runtime/selection');
  const original = selector.resolveInvocationSelection;
  const f = fixture({ 'uncaptured.bin': 'never requested bytes' }, true);
  const alienManifest = { 'alien-only': 'f'.repeat(64) };
  const alien = jest.fn(() => ({ ...alienManifest }));
  let nativeIo;
  jest.spyOn(selector, 'resolveInvocationSelection').mockImplementation((options) => {
    nativeIo = options.io;
    expect(options.io.verifyRuntime(options.home, options.runtimeDigest, alien)).toEqual(
      alienManifest
    );
    return original(options);
  });
  const state = selectionTransport(f);
  const result = await state.resolve(f.options);
  expect(result.handlers[0].sha256).toBe(sha('#!/bin/sh\nexit 0\n'));
  expect(alien).toHaveBeenCalledTimes(1);
  const after = jest.fn(() => ({ other: 'a'.repeat(64) }));
  expect(nativeIo.verifyRuntime(f.options.home, f.options.runtimeDigest, after)).toEqual({
    other: 'a'.repeat(64),
  });
  expect(after).toHaveBeenCalledTimes(1);
  expect(verifyRuntime(f.options.home, f.options.runtimeDigest, nativeIo)['launcher.py']).toBe(
    sha('# fixture launcher\n')
  );
  expect(() => nativeIo.readRuntimeFile(path.join(f.runtime, 'uncaptured.bin'))).toThrow(
    'Uncaptured read in sealed selection snapshot'
  );
  expect(() => nativeIo.readFile(path.join(f.runtime, 'uncaptured.bin'))).toThrow(
    'Uncaptured read in sealed selection snapshot'
  );
  expect(state.writes.filter((row) => row.operation.kind === 'runtime-generation')).toHaveLength(1);
});

test('public snapshot cannot opt into native generation verification using recorded summary data', async () => {
  const f = fixture({}, true),
    supplied = snapshot('public-summary');
  const manifest = JSON.parse(fs.readFileSync(path.join(f.runtime, 'manifest.json'), 'utf8'));
  supplied.record({
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'asserted-summary',
    operation: { kind: 'runtime-generation', path: f.runtime },
    result: { kind: 'runtime-generation', digest: f.options.runtimeDigest, manifest },
  });
  supplied.io.verifyRuntime(f.options.home, f.options.runtimeDigest, () => ({
    'first.sh': 'f'.repeat(64),
  }));
  write(path.join(f.runtime, 'first.sh'), '#!/bin/sh\nexit 29\n', true);
  await expect(observe(f.options, supplied)).rejects.toThrow(
    'Machine runtime file modified: first.sh'
  );
  expect(supplied.observations.some((row) => row.operation.kind === 'runtime-digest')).toBe(true);
});

test('runtime generation operation rejects singleLink and cannot become byte content', () => {
  const f = fixture({}, true),
    supplied = snapshot('bad-generation-operation');
  const row = {
    snapshotId: supplied.snapshotId,
    sequence: 1,
    observationId: 'generation-one',
    operation: { kind: 'runtime-generation', path: f.runtime, singleLink: false },
    result: {
      kind: 'runtime-generation',
      digest: f.options.runtimeDigest,
      manifest: JSON.parse(fs.readFileSync(path.join(f.runtime, 'manifest.json'), 'utf8')),
    },
  };
  expect(() => supplied.record(row)).toThrow('Invalid selection read operation');
  expect(supplied.observations).toHaveLength(0);
});
