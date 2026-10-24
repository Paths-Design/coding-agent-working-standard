const fs = require('node:fs');
const vm = require('node:vm');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  liveSelectionReadIo: io,
  captureSelectionRead,
  needSelectionObservation,
  missingSelectionObservation,
} = require('../../dist/init/selection-read-io');
let root;
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
