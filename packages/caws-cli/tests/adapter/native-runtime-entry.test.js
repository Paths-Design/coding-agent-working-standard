const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const { prepareNativeRuntimeEntry } = require(path.join(dist, 'init/native-runtime-entry'));
const { installMachineRuntime, rollbackMachineRuntime } = require(
  path.join(dist, 'init/machine-adapters')
);
const { verifyRuntime } = require(path.join(dist, 'init/machine-runtime-state'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const cli = 'node_modules/@paths.design/caws-cli';
let root, input;
function write(relative, bytes, mode = 0o644) {
  const file = path.join(input.prefixRoot, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.chmodSync(file, mode);
  input.files[relative] = { sha256: sha(Buffer.from(bytes)), mode };
}
function json(relative, value) {
  write(relative, JSON.stringify(value));
}
function packageAt(relative, name, version, dependencies = {}) {
  input.packages[relative] = { name, version, licenses: ['LICENSE'] };
  json(relative + '/package.json', { name, version, dependencies });
  write(relative + '/LICENSE', 'Fixture license\n');
}
function lock() {
  const packages = { '': { dependencies: { '@paths.design/caws-cli': 'file:reviewed.tgz' } } };
  for (const relative of Object.keys(input.packages))
    packages[relative] = JSON.parse(
      fs.readFileSync(path.join(input.prefixRoot, relative, 'package.json'))
    );
  json('package-lock.json', { lockfileVersion: 3, packages });
}
beforeEach(() => {
  const parent = process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'caws-native-image-')));
  input = {
    schema: 'caws.runtime.native-image-input.v1',
    prefixRoot: path.join(root, 'prefix'),
    files: {},
    packages: {},
    omissions: {},
    timeoutMs: 1000,
  };
  fs.mkdirSync(input.prefixRoot);
  for (const name of ['native', 'node', 'stableEntry']) {
    const source = path.join(root, name);
    fs.writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    input[name] = { source, sha256: sha(fs.readFileSync(source)) };
    if (name !== 'stableEntry') {
      const notice = path.join(root, name + '-notice');
      fs.writeFileSync(notice, 'Reviewed fixture notice\n', { mode: 0o644 });
      input[name].notices = { LICENSE: { source: notice, sha256: sha(fs.readFileSync(notice)) } };
    }
  }
  json('package.json', { dependencies: { '@paths.design/caws-cli': 'file:reviewed.tgz' } });
  packageAt(cli, '@paths.design/caws-cli', '1.0.0', { foo: '^2.0.0' });
  packageAt('node_modules/foo', 'foo', '2.1.0');
  for (const file of [
    'dist/index.js',
    'dist/runtime/engine-entry.js',
    'dist/runtime/describe-entry.js',
    'templates/hook-packs/runtime/bootstrap.py',
  ])
    write(cli + '/' + file, 'fixture asset\n');
  write(cli + '/dist/relative.json', '{"fixture":"retained"}');
  lock();
});
afterEach(() => {
  if (process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR)
    fs.writeFileSync(
      path.join(root, 'test-observation.json'),
      JSON.stringify(
        {
          test: expect.getState().currentTestName,
          input,
          boundary:
            'Fixture production-prefix preparation/publication; fake engines are not executed',
        },
        null,
        2
      )
    );
  else fs.rmSync(root, { recursive: true, force: true });
});
function install(home, native = true) {
  const nativeImage = path.join(root, 'native-image.json');
  if (native) fs.writeFileSync(nativeImage, JSON.stringify(input), { mode: 0o600 });
  return installMachineRuntime({
    home,
    templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    ...(native ? { nativeImage } : {}),
  });
}
test('preserves complete prefix layout, assets, licenses, executable membership and deterministic metadata', () => {
  write(cli + '/dist/index.js', '#!/usr/bin/env node\n', 0o755);
  const a = prepareNativeRuntimeEntry(input),
    b = prepareNativeRuntimeEntry(input);
  expect([...a.files]).toEqual([...b.files]);
  expect(a.files.get('native-prefix/' + cli + '/dist/relative.json').toString()).toBe(
    '{"fixture":"retained"}'
  );
  expect(a.files.get('native-prefix/node_modules/foo/LICENSE').toString()).toBe(
    'Fixture license\n'
  );
  expect(a.executablePaths.has('native-prefix/' + cli + '/dist/index.js')).toBe(true);
  expect(a.metadata.schema).toBe('caws.runtime.native-entry.v1');
  expect(a.metadata.runtimeDigest).toBeUndefined();
  expect(a.files.get('native/licenses/node/LICENSE').toString()).toBe('Reviewed fixture notice\n');
  expect(Object.keys(JSON.parse(a.files.get('native-modes.json'))).sort()).toEqual(
    [...a.files.keys()].sort()
  );
  expect(fs.readdirSync(root).sort()).toEqual([
    'native',
    'native-notice',
    'node',
    'node-notice',
    'prefix',
    'stableEntry',
  ]);
});
test('resolves nested dependency from importer ancestry rather than unrelated top-level version', () => {
  packageAt(cli, '@paths.design/caws-cli', '1.0.0', { foo: '^2.0.0', bar: '^1' });
  packageAt('node_modules/bar', 'bar', '1.0.0', { foo: '^1' });
  packageAt(cli + '/node_modules/foo', 'foo', '2.2.0');
  packageAt('node_modules/foo', 'foo', '1.0.0');
  lock();
  expect(
    prepareNativeRuntimeEntry(input).files.has(
      'native-prefix/' + cli + '/node_modules/foo/package.json'
    )
  ).toBe(true);
});
test.each(['{}', '{', JSON.stringify({ lockfileVersion: 2, packages: {} })])(
  'rejects invalid lock despite matching pinned bytes: %s',
  (bytes) => {
    write('package-lock.json', bytes);
    expect(() => prepareNativeRuntimeEntry(input)).toThrow();
  }
);
test('rejects stale lock version, package set and dependency declarations', () => {
  const original = JSON.parse(fs.readFileSync(path.join(input.prefixRoot, 'package-lock.json')));
  for (const mutate of [
    (p) => {
      p['node_modules/foo'].version = '1.0.0';
    },
    (p) => {
      delete p['node_modules/foo'];
    },
    (p) => {
      p[cli].dependencies.foo = '^9.0.0';
    },
  ]) {
    const changed = JSON.parse(JSON.stringify(original));
    mutate(changed.packages);
    json('package-lock.json', changed);
    expect(() => prepareNativeRuntimeEntry(input)).toThrow(/lock/i);
  }
});
test('rejects dependency directory with the wrong identity even when lock and review repeat the forgery', () => {
  packageAt('node_modules/foo', 'bar', '2.1.0');
  lock();
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/dependency identity/);
});
test.each(['.', '..'])('rejects self-satisfying dependency %s', (name) => {
  packageAt(cli, '@paths.design/caws-cli', '1.0.0', { [name]: '*' });
  lock();
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/dependency name/);
});
test.each(['file:../foo', 'workspace:*', 'npm:bar@2', 'https://example.invalid/foo.tgz'])(
  'rejects unmodeled dependency form %s',
  (declaration) => {
    packageAt(cli, '@paths.design/caws-cli', '1.0.0', { foo: declaration });
    lock();
    expect(() => prepareNativeRuntimeEntry(input)).toThrow(/Unsupported dependency declaration/);
  }
);
test('requires a resolved required dependency and explicit optional omission', () => {
  packageAt(cli, '@paths.design/caws-cli', '1.0.0', { absent: '^1' });
  lock();
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/Unresolved/);
  const pkg = {
    name: '@paths.design/caws-cli',
    version: '1.0.0',
    optionalDependencies: { absent: '^1' },
  };
  fs.rmSync(path.join(input.prefixRoot, 'node_modules/foo'), { recursive: true });
  delete input.packages['node_modules/foo'];
  for (const file of Object.keys(input.files))
    if (file.startsWith('node_modules/foo/')) delete input.files[file];
  json(cli + '/package.json', pkg);
  lock();
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/Unresolved/);
  input.omissions[cli + ':optionalDependencies:absent'] =
    'Reviewed platform exclusion in this fixture';
  expect(prepareNativeRuntimeEntry(input).metadata.timeoutMs).toBe(1000);
});
test.each(['extra', 'missing', 'modified', 'mode', 'license'])(
  'rejects incomplete or changed inventory: %s',
  (kind) => {
    const file = path.join(input.prefixRoot, cli, 'dist/relative.json');
    if (kind === 'extra') fs.writeFileSync(path.join(input.prefixRoot, 'extra'), 'unreviewed');
    if (kind === 'missing') fs.unlinkSync(file);
    if (kind === 'modified') fs.writeFileSync(file, 'changed');
    if (kind === 'mode') fs.chmodSync(file, 0o755);
    if (kind === 'license') {
      fs.unlinkSync(path.join(input.prefixRoot, cli, 'LICENSE'));
      delete input.files[cli + '/LICENSE'];
    }
    expect(() => prepareNativeRuntimeEntry(input)).toThrow();
  }
);
test.each(['member', 'directory', 'executable', 'hardlink'])(
  'rejects redirected or aliased inputs: %s',
  (kind) => {
    if (kind === 'member') {
      fs.unlinkSync(path.join(input.prefixRoot, cli, 'dist/relative.json'));
      fs.symlinkSync('/etc/hosts', path.join(input.prefixRoot, cli, 'dist/relative.json'));
    }
    if (kind === 'directory') fs.symlinkSync(root, path.join(input.prefixRoot, 'linked'));
    if (kind === 'executable') {
      fs.symlinkSync(input.node.source, path.join(root, 'node-link'));
      input.node.source = path.join(root, 'node-link');
    }
    if (kind === 'hardlink') fs.linkSync(input.node.source, path.join(root, 'node-alias'));
    expect(() => prepareNativeRuntimeEntry(input)).toThrow();
  }
);
test.each([0, 120001, 1.5, NaN])('rejects native timeout %s', (timeoutMs) => {
  input.timeoutMs = timeoutMs;
  expect(() => prepareNativeRuntimeEntry(input)).toThrow();
});
test.each(['native', 'node'])('requires and pins %s notice bytes', (kind) => {
  const pin = input[kind].notices.LICENSE;
  input[kind].notices = {};
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/notices/);
  input[kind].notices = { LICENSE: pin };
  fs.writeFileSync(pin.source, 'changed');
  expect(() => prepareNativeRuntimeEntry(input)).toThrow(/notice/);
});
test('publishes exact modes under restrictive umask without promoting a nonexecutable prefix shell file', () => {
  write(cli + '/fixture.sh', '# reviewed data, not an executable\n', 0o644);
  const home = path.join(root, 'machine'),
    prior = process.umask(0o077);
  let result;
  try {
    result = install(home);
  } finally {
    process.umask(prior);
  }
  const generation = path.join(home, 'lib/runtimes', result.digest);
  expect(fs.statSync(path.join(generation, 'native-prefix', cli, 'fixture.sh')).mode & 0o7777).toBe(
    0o644
  );
  expect(fs.statSync(path.join(home, 'bin/caws-hook-native')).mode & 0o7777).toBe(0o755);
  expect(fs.statSync(path.join(generation, 'manifest.json')).mode & 0o7777).toBe(0o644);
  expect(Object.keys(verifyRuntime(home, result.digest))).toContain('native-entry.json');
});
test('same-target entry mode repair preserves exact pointer and predecessor bytes', () => {
  const home = path.join(root, 'machine');
  const legacy = install(home, false);
  const native = install(home);
  const pointer = path.join(home, 'state/adapter-runtime.json'),
    before = fs.readFileSync(pointer);
  fs.chmodSync(path.join(home, 'bin/caws-hook-native'), 0o700);
  const prior = process.umask(0o077);
  let repaired;
  try {
    repaired = install(home);
  } finally {
    process.umask(prior);
  }
  expect(repaired.digest).toBe(native.digest);
  expect(repaired.previousDigest).toBe(legacy.digest);
  expect(repaired.changed).toBe(true);
  expect(fs.readFileSync(pointer)).toEqual(before);
  expect(fs.statSync(path.join(home, 'bin/caws-hook-native')).mode & 0o7777).toBe(0o755);
  expect(install(home).changed).toBe(false);
});
test('legacy rollback repairs a missing native compatibility entry from retained bytes', () => {
  const home = path.join(root, 'machine');
  const legacy = install(home, false);
  const native = install(home);
  const entry = path.join(home, 'bin/caws-hook-native'),
    expected = fs.readFileSync(entry);
  fs.unlinkSync(entry);
  const result = rollbackMachineRuntime({
    home,
    templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
  });
  expect(result.digest).toBe(legacy.digest);
  expect(result.previousDigest).toBe(native.digest);
  expect(fs.readFileSync(entry)).toEqual(expected);
  expect(fs.statSync(entry).mode & 0o7777).toBe(0o755);
});
test('legacy rollback refuses modified native entry without changing selected pointer', () => {
  const home = path.join(root, 'machine');
  install(home, false);
  install(home);
  const pointer = path.join(home, 'state/adapter-runtime.json'),
    before = fs.readFileSync(pointer);
  const entry = path.join(home, 'bin/caws-hook-native');
  fs.writeFileSync(entry, 'operator growth');
  expect(() =>
    rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    })
  ).toThrow(/local growth/);
  expect(fs.readFileSync(pointer)).toEqual(before);
  expect(fs.readFileSync(entry, 'utf8')).toBe('operator growth');
});
test('legacy rollback cannot treat a corrupt native catalogue as evidence of a legacy-only home', () => {
  const home = path.join(root, 'machine');
  install(home, false);
  const native = install(home);
  const pointer = path.join(home, 'state/adapter-runtime.json'),
    before = fs.readFileSync(pointer);
  fs.unlinkSync(path.join(home, 'bin/caws-hook-native'));
  fs.writeFileSync(
    path.join(home, 'lib/runtimes', native.digest, 'manifest.json'),
    'corrupt catalogue'
  );
  expect(() =>
    rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    })
  ).toThrow(/identity cannot be verified/);
  expect(fs.readFileSync(pointer)).toEqual(before);
});
