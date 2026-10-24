const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { assertMachinePath } = require('../../dist/init/machine-paths');
const {
  liveSelectionReadIo: io,
  captureSelectionRead,
  needSelectionObservation,
  missingSelectionObservation,
} = require('../../dist/init/selection-read-io');
let root;
test('narrow path identity supports optional and legacy custom IO without full metadata', () => {
  const file = source(),
    full = io.lstat(file);
  const value = { kind: full.kind, dev: full.dev, ino: full.ino, mode: full.mode };
  expect(io.pathIdentity(file)).toEqual(value);
  const operation = { kind: 'path-identity', path: file };
  expect(captureSelectionRead(operation)).toEqual({ kind: 'path-identity', value });
  const legacy = { ...io, pathIdentity: undefined, lstat: jest.fn(() => full) };
  expect(captureSelectionRead(operation, legacy)).toEqual({ kind: 'path-identity', value });
  expect(legacy.lstat).toHaveBeenCalledWith(file);
  const explicit = {
    ...io,
    lstat: jest.fn(() => {
      throw Error('full metadata forbidden');
    }),
    pathIdentity: jest.fn(() => value),
  };
  expect(captureSelectionRead(operation, explicit)).toEqual({ kind: 'path-identity', value });
  expect(explicit.pathIdentity).toHaveBeenCalledWith(file);
  expect(explicit.lstat).not.toHaveBeenCalled();
});

test('sibling churn preserves narrow identity while metadata and inventory remain distinct', () => {
  const directory = path.join(root, 'parent');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  const before = io.pathIdentity(directory),
    full = io.lstat(directory),
    listing = io.readDirectory(directory);
  fs.writeFileSync(path.join(directory, 'unrelated'), 'sibling');
  fs.utimesSync(directory, new Date(1000), new Date(2000));
  expect(io.pathIdentity(directory)).toEqual(before);
  expect(io.lstat(directory).mtimeMs).not.toBe(full.mtimeMs);
  expect(listing).toEqual([]);
  expect(io.readDirectory(directory)).toEqual(['unrelated']);
  fs.renameSync(directory, path.join(root, 'retained-parent'));
  fs.mkdirSync(directory);
  expect(io.pathIdentity(directory).ino).not.toBe(before.ino);
  fs.chmodSync(directory, 0o755);
  const mode = io.pathIdentity(directory).mode;
  fs.chmodSync(directory, 0o700);
  expect(io.pathIdentity(directory).mode).not.toBe(mode);
  fs.renameSync(directory, path.join(root, 'replacement-parent'));
  fs.symlinkSync(path.join(root, 'retained-parent'), directory);
  expect(io.pathIdentity(directory).kind).toBe('symlink');
});

test('confinement chooses narrow identity, preserves legacy fallback and propagates nonabsence errors', () => {
  const file = source(),
    paths = [];
  const narrow = {
    ...io,
    lstat: jest.fn(() => {
      throw Error('unexpected full metadata');
    }),
    pathIdentity: jest.fn((target) => {
      paths.push(target);
      return io.pathIdentity(target);
    }),
  };
  expect(assertMachinePath(root, file, narrow)).toBeUndefined();
  expect(paths).toEqual([root, file]);
  expect(narrow.lstat).not.toHaveBeenCalled();
  const legacy = { ...io, pathIdentity: undefined, lstat: jest.fn((target) => io.lstat(target)) };
  expect(assertMachinePath(root, file, legacy)).toBeUndefined();
  expect(legacy.lstat.mock.calls.map((args) => args[0])).toEqual([root, file]);
  expect(() => assertMachinePath(root, path.join(root, '..fixture'), narrow)).toThrow(
    'Path escapes root'
  );
  const link = path.join(root, 'redirect');
  fs.symlinkSync(file, link);
  expect(() => assertMachinePath(root, link, narrow)).toThrow('Refusing symlink');
  expect(assertMachinePath(root, path.join(root, 'absent'), narrow)).toBeUndefined();
  const denied = Object.assign(new Error('identity denied'), { code: 'EACCES' });
  const deniedIo = {
    ...io,
    pathIdentity() {
      throw denied;
    },
  };
  expect(captureSelectionRead({ kind: 'path-identity', path: file }, deniedIo)).toMatchObject({
    kind: 'error',
    code: 'EACCES',
    message: 'identity denied',
  });
  expect(() => assertMachinePath(root, file, deniedIo)).toThrow('identity denied');
});
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-selection-io-')));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function source(name = 'source') {
  const file = path.join(root, name);
  fs.writeFileSync(file, 'owned bytes');
  return file;
}
test('captures plain file identity and independent owned bytes without Stats methods', () => {
  const file = source(),
    captured = io.readRuntimeFile(file);
  expect(captured.bytes.toString()).toBe('owned bytes');
  expect(captured.stat.kind).toBe('file');
  expect(captured.stat.size).toBe(11);
  expect(captured.stat.ino).toBe(String(fs.statSync(file).ino));
  expect(captured.stat.isFile).toBeUndefined();
  captured.bytes.fill(0);
  expect(io.readRuntimeFile(file).bytes.toString()).toBe('owned bytes');
});
test('regular capture refuses symlinks directories and an explicitly single-link violation', () => {
  const file = source(),
    link = path.join(root, 'link');
  fs.symlinkSync(file, link);
  expect(() => io.readRuntimeFile(link)).toThrow('Runtime member is not a regular file');
  expect(() => io.readRuntimeFile(root)).toThrow('Runtime member is not a regular file');
  fs.linkSync(file, path.join(root, 'hardlink'));
  expect(io.readRuntimeFile(file).bytes.toString()).toBe('owned bytes');
  expect(() => io.readRuntimeFile(file, true)).toThrow('Native entry member is not single-link');
});
test('capture detects inode replacement between pathname observation and open and closes the fd', () => {
  const file = source(),
    replacement = source('replacement'),
    open = fs.openSync;
  let replaced = false;
  jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
    if (target === file && !replaced) {
      replaced = true;
      fs.renameSync(replacement, file);
    }
    return open(target, ...args);
  });
  const close = jest.spyOn(fs, 'closeSync');
  expect(() => io.readRuntimeFile(file)).toThrow('Runtime member replaced');
  expect(replaced).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});
test('capture refuses changed final fd identity and closes the original fd', () => {
  const file = source(),
    fstat = fs.fstatSync;
  let observed = 0;
  jest.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
    const stat = fstat(...args);
    if (++observed === 2) stat.ctimeMs += 1;
    return stat;
  });
  const close = jest.spyOn(fs, 'closeSync');
  expect(() => io.readRuntimeFile(file)).toThrow('Runtime member changed');
  expect(close).toHaveBeenCalledTimes(1);
});
test('executable access uses the real access result and retains refusal code', () => {
  const file = source();
  fs.chmodSync(file, 0o644);
  expect(captureSelectionRead({ kind: 'executable', path: file })).toMatchObject({
    kind: 'error',
    name: 'Error',
    code: 'EACCES',
  });
  fs.chmodSync(file, 0o755);
  expect(captureSelectionRead({ kind: 'executable', path: file })).toEqual({ kind: 'executable' });
});
test('only privately created missing observations trigger discovery and capture does not swallow them', () => {
  const operation = Object.freeze({ kind: 'read', path: path.join(root, 'missing') });
  expect(
    missingSelectionObservation(new Error('Selection requires a captured read observation'))
  ).toBeUndefined();
  let original;
  try {
    needSelectionObservation(operation);
  } catch (error) {
    original = error;
  }
  expect(missingSelectionObservation(original)).toBe(operation);
  expect(() =>
    captureSelectionRead(operation, {
      ...io,
      readFile() {
        throw original;
      },
    })
  ).toThrow(original);
});
test('capture retains native errors across realms but does not turn arbitrary thrown objects into observations', () => {
  const operation = { kind: 'read', path: path.join(root, 'foreign-error') };
  const error = vm.runInNewContext(
    "Object.assign(new TypeError('foreign read failed'), {code: 'EIO'})"
  );
  expect(error instanceof Error).toBe(false);
  expect(
    captureSelectionRead(operation, {
      ...io,
      readFile() {
        throw error;
      },
    })
  ).toEqual({
    kind: 'error',
    name: 'TypeError',
    message: 'foreign read failed',
    code: 'EIO',
  });
  const nonError = { name: 'Error', message: 'not a native error' };
  let caught;
  try {
    captureSelectionRead(operation, {
      ...io,
      readFile() {
        throw nonError;
      },
    });
  } catch (failure) {
    caught = failure;
  }
  expect(caught).toBe(nonError);
});

test('runtime-digest tooling retains guarded file identity without transporting bytes', () => {
  const file = source();
  const captured = captureSelectionRead({ kind: 'runtime-digest', path: file });
  expect(captured).toEqual({
    kind: 'runtime-digest',
    sha256: createHash('sha256').update('owned bytes').digest('hex'),
    stat: io.lstat(file),
  });
  expect(captured).not.toHaveProperty('base64');
  // Direct IO keeps its existing synchronous guarded byte capture contract.
  expect(io.runtimeFileDigest).toBeUndefined();
  const missing = captureSelectionRead({ kind: 'runtime-digest', path: path.join(root, 'absent') });
  expect(missing).toMatchObject({ kind: 'error', name: 'Error', code: 'ENOENT' });
});

test('runtime-digest tooling preserves single-link and replacement refusals and closes the fd', () => {
  const file = source(),
    replacement = source('replacement');
  fs.linkSync(file, path.join(root, 'hardlink'));
  expect(
    captureSelectionRead({ kind: 'runtime-digest', path: file, singleLink: true })
  ).toMatchObject({ kind: 'error', message: `Native entry member is not single-link: ${file}` });
  fs.unlinkSync(path.join(root, 'hardlink'));
  const open = fs.openSync;
  let replaced = false;
  jest.spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
    if (target === file && !replaced) {
      replaced = true;
      fs.renameSync(replacement, file);
    }
    return open(target, ...args);
  });
  const close = jest.spyOn(fs, 'closeSync');
  expect(captureSelectionRead({ kind: 'runtime-digest', path: file })).toMatchObject({
    kind: 'error',
    message: `Runtime member replaced: ${file}`,
  });
  expect(replaced).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});

test('runtime-digest tooling does not flatten privately owned missing observation errors', () => {
  const operation = { kind: 'runtime-digest', path: path.join(root, 'member') };
  let original;
  try {
    needSelectionObservation(operation);
  } catch (error) {
    original = error;
  }
  let actual;
  try {
    captureSelectionRead(operation, {
      ...io,
      readRuntimeFile() {
        throw original;
      },
    });
  } catch (error) {
    actual = error;
  }
  expect(actual).toBe(original);
  expect(missingSelectionObservation(actual)).toBe(operation);
});

test('tooling cannot manufacture a native generation summary or perform an ambient read for it', () => {
  const observed = [];
  const boundary = new Proxy(
    {},
    {
      get(_target, name) {
        observed.push(name);
        throw Error('ambient IO forbidden');
      },
    }
  );
  const result = captureSelectionRead(
    { kind: 'runtime-generation', path: '/native/generation' },
    boundary
  );
  expect(result).toEqual({
    kind: 'error',
    name: 'Error',
    message: 'Runtime generation summary requires the original native owner',
  });
  expect(observed).toEqual([]);
  expect(io.runtimeGeneration).toBeUndefined();
});

test('pure generation manifest validation preserves native identity and JS lexical path refusal without IO', () => {
  const {
    validateRuntimeGenerationManifest: validate,
  } = require('../../dist/init/machine-runtime-state');
  const digest = 'a'.repeat(64),
    generation = path.join(root, 'lib/runtimes', digest);
  const manifest = {
    'launcher.py': 'b'.repeat(64),
    'native-entry.json': 'c'.repeat(64),
    'nested/member': 'd'.repeat(64),
  };
  const read = jest.spyOn(fs, 'readFileSync');
  const lstat = jest.spyOn(fs, 'lstatSync');
  const accepted = validate(digest, digest, generation, manifest);
  expect(accepted).toEqual(manifest);
  accepted['launcher.py'] = 'e'.repeat(64);
  expect(manifest['launcher.py']).toBe('b'.repeat(64));
  for (const altered of [
    { ...manifest, '../escape': 'f'.repeat(64) },
    { ...manifest, '..fixture': 'f'.repeat(64) },
    { ...manifest, '/absolute': 'f'.repeat(64) },
    { ...manifest, 'empty//segment': 'f'.repeat(64) },
    { ...manifest, member: 'A'.repeat(64) },
    { ...manifest, member: 42 },
    { ...manifest, 'launcher.py': undefined },
    { 'launcher.py': 'b'.repeat(64) },
    [],
    null,
  ])
    expect(() => validate(digest, digest, generation, altered)).toThrow();
  expect(() => validate(digest, 'f'.repeat(64), generation, manifest)).toThrow('digest mismatch');
  expect(() => validate('A'.repeat(64), 'A'.repeat(64), generation, manifest)).toThrow(
    'digest mismatch'
  );
  expect(read).not.toHaveBeenCalled();
  expect(lstat).not.toHaveBeenCalled();
});
