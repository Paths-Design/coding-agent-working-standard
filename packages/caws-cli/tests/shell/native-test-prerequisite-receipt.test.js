'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('../../scripts/lib/native-test-prerequisite-receipt.cjs');
const setup = require('../helpers/load-native-test-prerequisites');
let root, pkg, native, binary, observed, artifactRoot;
const toolchain = api.toolchainObservation(
  'rustc 1.90.0 (fixture)\nrelease: 1.90.0\nhost: fixture\n',
  'cargo 1.90.0 (fixture)\n'
);
function put(relative, bytes) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}
function artifact(overrides = {}) {
  return {
    reason: 'compiler-artifact',
    target: { name: 'caws_native', kind: ['lib'], src_path: path.join(native, 'src/lib.rs') },
    profile: { test: true },
    features: [],
    executable: binary,
    ...overrides,
  };
}
function publish() {
  return api.publishReceipt(
    pkg,
    api.sourceFingerprint(pkg),
    toolchain,
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact()) + '\n')
  );
}
beforeEach(() => {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'caws-native-prerequisite-'))
  );
  pkg = path.join(root, 'packages/caws-cli');
  native = path.join(root, 'packages/caws-native');
  for (const [file, bytes] of Object.entries({
    'rust-toolchain.toml': '[toolchain]\nchannel = "1.90.0"\n',
    'packages/caws-native/Cargo.toml': '[package]\nname="caws-native"\n',
    'packages/caws-cli/src/runtime/service-client.ts': '// client fixture',
    'packages/caws-cli/src/runtime/service-protocol.ts': '// protocol fixture',
    'packages/caws-native/Cargo.lock': 'version = 4\n',
    'packages/caws-native/build.rs': 'fn main() {}\n',
    'packages/caws-native/src/lib.rs': '// lib\n',
    'packages/caws-native/tests/input.txt': 'fixture',
    'packages/caws-native/examples/input.c': '// example',
    'packages/caws-cli/templates/hook-packs/shared/input.sh': '# input',
  }))
    put(file, bytes);
  binary = put(
    'packages/caws-native/target/debug/deps/caws_native-fixture',
    'inert artifact; never executed'
  );
  fs.chmodSync(binary, 0o755);
  observed = process.env[api.ENV];
  artifactRoot = process.env.CAWS_TEST_ARTIFACT_DIR;
});
afterEach(() => {
  jest.restoreAllMocks();
  if (observed === undefined) delete process.env[api.ENV];
  else process.env[api.ENV] = observed;
  if (artifactRoot === undefined) delete process.env.CAWS_TEST_ARTIFACT_DIR;
  else process.env.CAWS_TEST_ARTIFACT_DIR = artifactRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
test('Cargo JSON selects exactly the physical current libtest artifact, not an older filename', () => {
  put('packages/caws-native/target/debug/deps/caws_native-older', 'old');
  const rows = [
    artifact({
      target: { name: 'dependency', kind: ['lib'] },
      profile: { test: false },
      executable: null,
    }),
    artifact(),
  ];
  expect(
    api.selectCoreTestArtifact(pkg, rows.map((row) => JSON.stringify(row)).join('\n')).path
  ).toBe(binary);
  expect(() =>
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact()) + '\n' + JSON.stringify(artifact()))
  ).toThrow('exactly one');
  expect(() => api.selectCoreTestArtifact(pkg, '{')).toThrow('malformed Cargo');
  expect(() =>
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact({ profile: { test: false } })))
  ).toThrow('exactly one');
  expect(() =>
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact({ features: ['sqlite-store'] })))
  ).toThrow('profile mismatch');
  expect(() =>
    api.selectCoreTestArtifact(
      pkg,
      JSON.stringify(
        artifact({ target: { name: 'caws_native', kind: ['lib'], src_path: '/other/lib.rs' } })
      )
    )
  ).toThrow('identity');
});
test('artifact path escapes and symlinks refuse', () => {
  const foreign = put('foreign', 'outside');
  fs.chmodSync(foreign, 0o755);
  expect(() =>
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact({ executable: foreign })))
  ).toThrow('escaped');
  const link = binary + '-link';
  fs.symlinkSync(binary, link);
  expect(() =>
    api.selectCoreTestArtifact(pkg, JSON.stringify(artifact({ executable: link })))
  ).toThrow('symlink');
});
test('receipt pins exact source, executable and actual pinned toolchain', () => {
  const row = publish();
  expect(api.readReceipt(pkg)).toEqual(row);
  expect(api.preparedEnvironment(pkg, { KEEP: 'yes' })).toEqual({ KEEP: 'yes', [api.ENV]: binary });
  expect(api.preparedEnvironment(pkg, { [api.ENV]: binary })[api.ENV]).toBe(binary);
  expect(() => api.preparedEnvironment(pkg, { [api.ENV]: '/foreign' })).toThrow(
    'ambient binary differs'
  );
  expect(() =>
    api.toolchainObservation('rustc 1.91.0 (other)\nrelease: 1.91.0\n', toolchain.cargo)
  ).toThrow('pinned');
});
test.each([
  'packages/caws-native/src/lib.rs',
  'packages/caws-native/tests/input.txt',
  'packages/caws-native/Cargo.lock',
  'packages/caws-native/build.rs',
  'packages/caws-cli/templates/hook-packs/shared/input.sh',
  'packages/caws-cli/src/runtime/service-client.ts',
  'packages/caws-cli/src/runtime/service-protocol.ts',
])('changed compiler input %s invalidates a previously valid receipt', (file) => {
  publish();
  fs.appendFileSync(path.join(root, file), '\nchanged');
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
});
test('added/deleted inputs and artifact byte replacement invalidate receipts', () => {
  publish();
  const added = put('packages/caws-native/src/new.rs', '// new');
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
  fs.unlinkSync(added);
  publish();
  fs.unlinkSync(path.join(native, 'tests/input.txt'));
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
  put('packages/caws-native/tests/input.txt', 'fixture');
  publish();
  fs.appendFileSync(binary, 'replaced');
  expect(() => api.readReceipt(pkg)).toThrow('compiled libtest bytes changed');
});
test('source observations identify equal-size edits and count-preserving add/delete without admitting them', () => {
  const directory = path.join(root, 'artifacts');
  process.env.CAWS_TEST_ARTIFACT_DIR = directory;
  const before = api.sourceObservation(pkg);
  expect(api.sourceFingerprint(pkg)).toEqual(before.fingerprint);
  expect(Object.keys(before.fingerprint)).toEqual(['sha256', 'fileCount']);
  api.retainSourceObservation(pkg, 'prepare-before', before);
  publish();
  const changed = 'packages/caws-native/tests/input.txt';
  const removed = 'packages/caws-native/examples/input.c';
  const added = 'packages/caws-native/src/added.rs';
  put(changed, 'changed');
  fs.unlinkSync(path.join(root, removed));
  put(added, '// example');
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
  const observations = fs
    .readdirSync(path.join(directory, 'native-prerequisite-inputs'))
    .map((name) => ({ file: path.join(directory, 'native-prerequisite-inputs', name) }))
    .map(({ file }) => ({ file, row: JSON.parse(fs.readFileSync(file, 'utf8')) }));
  const observed = observations.find(({ row }) => row.phase === 'read-receipt');
  expect(observed.row.expected).toEqual(before.fingerprint);
  expect(observed.row.fingerprint.fileCount).toBe(before.fingerprint.fileCount);
  expect(observed.row.fingerprint.sha256).not.toBe(before.fingerprint.sha256);
  const previous = new Map(before.files.map((row) => [row.path, row]));
  const current = new Map(observed.row.inputs.map((row) => [row.path, row]));
  expect(current.get(changed).sizeBytes).toBe(previous.get(changed).sizeBytes);
  expect(current.get(changed).sha256).not.toBe(previous.get(changed).sha256);
  expect(current.has(removed)).toBe(false);
  expect(current.get(added).sha256).toBe(previous.get(removed).sha256);
  expect(previous.has(added)).toBe(false);
  expect(observed.row.receipt.path).toBe(api.locations(pkg).receipt);
  fs.writeFileSync(observed.file, JSON.stringify({ fingerprint: before.fingerprint }));
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
});
test('unwritable diagnostic destination preserves the original source refusal', () => {
  publish();
  process.env.CAWS_TEST_ARTIFACT_DIR = put('blocked-artifact-directory', 'file');
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  put('packages/caws-native/tests/input.txt', 'changed');
  expect(() => api.readReceipt(pkg)).toThrow('source fingerprint changed');
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('diagnostic unavailable'));
});
test('diagnostic destination inside observed sources cannot contaminate the inventory', () => {
  publish();
  process.env.CAWS_TEST_ARTIFACT_DIR = path.join(native, 'src');
  const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
  const before = api.sourceObservation(pkg);
  api.retainSourceObservation(pkg, 'prepare-before', before);
  expect(api.sourceObservation(pkg)).toEqual(before);
  expect(api.readReceipt(pkg).source).toEqual(before.fingerprint);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('outside source inventory'));
});
test('malformed, duplicate and foreign receipt declarations refuse', () => {
  publish();
  const file = api.locations(pkg).receipt,
    original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('"schema":', '"schema":null,"schema":'));
  expect(() => api.readReceipt(pkg)).toThrow('canonical');
  const row = JSON.parse(original);
  row.target = '/other';
  fs.writeFileSync(file, JSON.stringify(row) + '\n');
  expect(() => api.readReceipt(pkg)).toThrow('identity');
  fs.writeFileSync(file, '{');
  expect(() => api.readReceipt(pkg)).toThrow('malformed');
});
test('missing receipt permits pure port tests but never accepts an unjoined override', () => {
  expect(api.preparedEnvironment(pkg, { KEEP: 'yes' })).toEqual({ KEEP: 'yes' });
  expect(() => api.preparedEnvironment(pkg, { [api.ENV]: binary })).toThrow('no prepared receipt');
});
test.each([false, true])(
  'shared target is unavailable without following it, including pure setup (dangling=%s)',
  async (dangling) => {
    publish();
    const target = api.locations(pkg).target,
      shared = path.join(root, 'shared-target');
    const relative = 'qualification-tools/native-test-prerequisite.json';
    const before = fs.readFileSync(path.join(target, relative), 'utf8');
    fs.renameSync(target, shared);
    if (dangling) fs.rmSync(shared, { recursive: true });
    fs.symlinkSync(shared, target);
    const followsShared = (file) =>
      typeof file === 'string' &&
      (file === target ||
        file.startsWith(target + path.sep) ||
        file === shared ||
        file.startsWith(shared + path.sep));
    const followed = [];
    const guarded = ['readFileSync', 'openSync', 'existsSync', 'statSync'];
    for (const name of guarded) {
      const original = fs[name];
      jest.spyOn(fs, name).mockImplementation((file, ...args) => {
        if (followsShared(file)) {
          followed.push(name + ':' + file);
          throw new Error('followed unavailable target via ' + name);
        }
        return Reflect.apply(original, fs, [file, ...args]);
      });
    }
    const realpath = fs.realpathSync.native;
    jest.spyOn(fs.realpathSync, 'native').mockImplementation((file, ...args) => {
      if (followsShared(file)) {
        followed.push('realpath:' + file);
        throw new Error('resolved unavailable target');
      }
      return Reflect.apply(realpath, fs.realpathSync, [file, ...args]);
    });
    const lstat = fs.lstatSync;
    jest.spyOn(fs, 'lstatSync').mockImplementation((file, ...args) => {
      if (followsShared(file) && file !== target) {
        followed.push('lstat:' + file);
        throw new Error('looked through shared entry');
      }
      return Reflect.apply(lstat, fs, [file, ...args]);
    });
    const writes = ['writeFileSync', 'renameSync', 'mkdirSync', 'unlinkSync'].map((name) =>
      jest.spyOn(fs, name).mockImplementation(() => {
        throw new Error('unexpected loader write');
      })
    );
    delete process.env[api.ENV];
    expect(api.readReceipt(pkg)).toBeNull();
    expect(api.preparedEnvironment(pkg, { PURE: 'yes' })).toEqual({ PURE: 'yes' });
    await setup({}, { rootDir: pkg });
    expect(process.env[api.ENV]).toBeUndefined();
    expect(() => api.preparedEnvironment(pkg, { [api.ENV]: binary })).toThrow(
      'no prepared receipt'
    );
    expect(followed).toEqual([]);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    if (!dangling) expect(fs.readFileSync(path.join(shared, relative), 'utf8')).toBe(before);
  }
);
test('failed receipt publication cleans only its owned temporary file', () => {
  const rename = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw new Error('publication refused');
  });
  expect(() => publish()).toThrow('publication refused');
  rename.mockRestore();
  expect(fs.readdirSync(path.join(native, 'target/qualification-tools'))).toEqual([]);
});
test('failed exclusive create preserves an unowned colliding temporary file', () => {
  const originalOpen = fs.openSync;
  const prefix = api.locations(pkg).receipt + '.tmp-';
  let collision;
  jest.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
    if (typeof file === 'string' && file.startsWith(prefix)) {
      collision = file;
      const held = originalOpen(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        mode
      );
      fs.writeSync(held, 'unowned collision');
      fs.closeSync(held);
      throw Object.assign(new Error('exclusive create collision'), { code: 'EEXIST' });
    }
    return originalOpen(file, flags, mode);
  });
  expect(() => publish()).toThrow('exclusive create collision');
  expect(fs.readFileSync(collision, 'utf8')).toBe('unowned collision');
});
test('publication and owned cleanup failures retain both causes', () => {
  const publication = new Error('publication refused');
  const cleanup = new Error('owned cleanup refused');
  jest.spyOn(fs, 'renameSync').mockImplementation(() => {
    throw publication;
  });
  jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {
    throw cleanup;
  });
  let observed;
  try {
    publish();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(AggregateError);
  expect(observed.errors).toEqual([publication, cleanup]);
  expect(fs.readdirSync(path.join(native, 'target/qualification-tools'))).toHaveLength(1);
});
test('actual preload sets the verified pin inherited by independent Node worker processes without Cargo', async () => {
  publish();
  delete process.env[api.ENV];
  await setup({}, { rootDir: pkg });
  expect(process.env[api.ENV]).toBe(binary);
  const program =
    'process.stdout.write(JSON.stringify({pid:process.pid,binary:process.env.CAWS_TEST_GUARD_STRIKES_CORE_TEST_BINARY}))';
  const children = [0, 1].map(() =>
    spawnSync(process.execPath, ['-e', program], {
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 5000,
      shell: false,
    })
  );
  for (const child of children) {
    expect({
      status: child.status,
      signal: child.signal,
      error: child.error,
      stderr: child.stderr,
    }).toEqual({ status: 0, signal: null, error: undefined, stderr: '' });
    expect(JSON.parse(child.stdout).binary).toBe(binary);
  }
  expect(new Set(children.map((child) => JSON.parse(child.stdout).pid)).size).toBe(2);
  // This proves preload/environment handoff. The inert fixture is never run and
  // confers no Native compilation, filesystem transaction or host custody proof.
});
