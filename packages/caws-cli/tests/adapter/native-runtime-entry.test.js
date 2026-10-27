const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const dist = process.env.CAWS_TEST_DIST || path.join(__dirname, '../../dist');
const { prepareNativeRuntimeEntry, prepareNativeRuntimeEntryFromBuild, readNativeImage } = require(
  path.join(dist, 'init/native-runtime-entry')
);
const nativeBuildTooling = require(path.join(dist, 'tooling/native-sqlite-build'));
const { installMachineRuntime, rollbackMachineRuntime } = require(
  path.join(dist, 'init/machine-adapters')
);
const { verifyRuntime, readRetainedNativeEntryIdentity } = require(
  path.join(dist, 'init/machine-runtime-state')
);
const { configureSystemRuntime, systemSurfaceEnabled } = require(
  path.join(dist, 'init/system-runtime')
);
const { observeSystemRuntime } = require(path.join(dist, 'store/system-runtime-observation'));
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
function install(home, native = true, options = {}) {
  const nativeImage = path.join(root, 'native-image.json');
  if (native) fs.writeFileSync(nativeImage, JSON.stringify(input), { mode: 0o600 });
  return installMachineRuntime({
    home,
    templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    ...(native ? { nativeImage } : {}),
    ...options,
  });
}
test('explicit base runtime preserves guard bytes and policy through native install and rollback', () => {
  const home = path.join(root, 'machine');
  const base = install(home, false);
  const baseRoot = path.join(home, 'lib/runtimes', base.digest);
  const rawManifest = fs.readFileSync(path.join(baseRoot, 'manifest.json'));
  const manifest = JSON.parse(rawManifest);
  const nativeImage = path.join(root, 'native-image.json');
  fs.writeFileSync(nativeImage, JSON.stringify(input));
  const options = {
    home,
    nativeImage,
    baseRuntimeDigest: base.digest,
    templatesRoot: path.join(root, 'must-not-read-current-templates'),
  };
  const before = fixtureState(home);
  const plan = installMachineRuntime({ ...options, plan: true });
  expect(fixtureState(home)).toEqual(before);
  const installed = installMachineRuntime(options);
  expect(installed.digest).toBe(plan.digest);
  expect(installed.baseRuntimeDigest).toBe(base.digest);
  expect(installed.previousDigest).toBe(base.digest);
  expect(installed.digest).not.toBe(base.digest);
  const selected = path.join(home, 'lib/runtimes', installed.digest);
  const combined = verifyRuntime(home, installed.digest);
  for (const [name, hash] of Object.entries(manifest)) {
    expect(combined[name]).toBe(hash);
    expect(fs.readFileSync(path.join(selected, name))).toEqual(
      fs.readFileSync(path.join(baseRoot, name))
    );
    expect(fs.statSync(path.join(selected, name)).mode & 0o777).toBe(
      name.endsWith('.sh') ? 0o755 : 0o644
    );
  }
  const provenance = JSON.parse(
    fs.readFileSync(path.join(selected, 'base-runtime-provenance.json'))
  );
  expect(provenance).toEqual({
    schema: 'caws.runtime.base-provenance.v1',
    digest: base.digest,
    manifest: rawManifest.toString('utf8'),
  });
  expect(sha(Buffer.from(provenance.manifest))).toBe(base.digest);
  expect(combined['native-entry.json']).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.existsSync(path.join(home, 'surfaces'))).toBe(false);
  expect(
    rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    }).digest
  ).toBe(base.digest);
  expect(JSON.parse(fs.readFileSync(path.join(home, 'state/adapter-runtime.json'))).digest).toBe(
    base.digest
  );
  expect(installMachineRuntime(options).digest).toBe(installed.digest);
});

test.each([
  'tampered bytes',
  'symlink',
  'hardlink',
  'executable mode',
  'missing generation',
  'native base',
])('explicit base runtime refuses %s without changing selected entries', (kind) => {
  const home = path.join(root, 'machine');
  const base = install(home, kind === 'native base');
  const file = path.join(home, 'lib/runtimes', base.digest, 'bash-write-guard.sh');
  if (kind === 'tampered bytes') fs.appendFileSync(file, '\nchanged\n');
  if (kind === 'executable mode') fs.chmodSync(file, 0o644);
  if (kind === 'symlink' || kind === 'hardlink') {
    const retained = path.join(root, 'retained-guard');
    fs.renameSync(file, retained);
    if (kind === 'symlink') fs.symlinkSync(retained, file);
    else fs.linkSync(retained, file);
  }
  const before = fixtureState(home);
  expect(() =>
    install(home, true, {
      baseRuntimeDigest: kind === 'missing generation' ? 'f'.repeat(64) : base.digest,
    })
  ).toThrow();
  expect(fixtureState(home)).toEqual(before);
});

test('explicit base runtime rejects a captured member changed after initial verification', () => {
  const home = path.join(root, 'machine');
  const base = install(home, false);
  const baseRoot = path.join(home, 'lib/runtimes', base.digest);
  const manifestIno = fs.statSync(path.join(baseRoot, 'manifest.json')).ino;
  const member = path.join(baseRoot, 'bash-write-guard.sh');
  const pointer = fs.readFileSync(path.join(home, 'state/adapter-runtime.json'));
  const bootstrap = fs.readFileSync(path.join(home, 'bin/caws-hook'));
  const originalRead = fs.readFileSync;
  let changed = false;
  let manifestCaptures = 0;
  const read = jest.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
    const result = originalRead(file, ...args);
    if (typeof file === 'number' && fs.fstatSync(file).ino === manifestIno) manifestCaptures++;
    if (!changed && manifestCaptures === 2) {
      changed = true;
      fs.appendFileSync(member, '\nchanged after verification\n');
    }
    return result;
  });
  try {
    expect(() => install(home, true, { baseRuntimeDigest: base.digest })).toThrow(
      /changed during capture/
    );
  } finally {
    read.mockRestore();
  }
  expect(changed).toBe(true);
  expect(fs.readFileSync(path.join(home, 'state/adapter-runtime.json'))).toEqual(pointer);
  expect(fs.readFileSync(path.join(home, 'bin/caws-hook'))).toEqual(bootstrap);
  expect(fs.existsSync(path.join(home, 'bin/caws-hook-native'))).toBe(false);
});

test('explicit base runtime requires native image and an exact digest before any writes', () => {
  const home = path.join(root, 'absent-home');
  for (const options of [
    { baseRuntimeDigest: 'a'.repeat(64) },
    { baseRuntimeDigest: '', nativeImage: '/absent' },
    { baseRuntimeDigest: '../escape', nativeImage: '/absent' },
  ])
    expect(() => installMachineRuntime({ home, ...options })).toThrow(/base runtime/);
  expect(() => rollbackMachineRuntime({ home, baseRuntimeDigest: 'a'.repeat(64) })).toThrow(
    /only valid/
  );
  expect(fs.existsSync(home)).toBe(false);
});
function fixtureState(directory = root) {
  const state = {};
  function visit(parent) {
    for (const name of fs.readdirSync(parent).sort()) {
      const file = path.join(parent, name);
      const stat = fs.lstatSync(file);
      const key = path.relative(directory, file);
      state[key] = { mode: stat.mode & 0o7777, nlink: stat.nlink };
      if (stat.isDirectory()) visit(file);
      else state[key].bytes = fs.readFileSync(file);
    }
  }
  visit(directory);
  return state;
}
function rewriteRetainedMetadata(home, digest, mutate) {
  const previous = path.join(home, 'lib/runtimes', digest);
  const manifest = JSON.parse(fs.readFileSync(path.join(previous, 'manifest.json')));
  const metadata = JSON.parse(fs.readFileSync(path.join(previous, 'native-entry.json')));
  mutate(metadata, manifest);
  const bytes = JSON.stringify(metadata);
  fs.writeFileSync(path.join(previous, 'native-entry.json'), bytes);
  manifest['native-entry.json'] = sha(Buffer.from(bytes));
  const manifestBytes = JSON.stringify(manifest);
  const next = sha(Buffer.from(manifestBytes));
  fs.writeFileSync(path.join(previous, 'manifest.json'), manifestBytes);
  fs.renameSync(previous, path.join(home, 'lib/runtimes', next));
  const pointer = path.join(home, 'state/adapter-runtime.json');
  const value = JSON.parse(fs.readFileSync(pointer));
  if (value.digest === digest) value.digest = next;
  if (value.previous_digest === digest) value.previous_digest = next;
  fs.writeFileSync(pointer, JSON.stringify(value));
  return next;
}
test.each(['changed payload', 'missing payload', 'unused Node mode'])(
  'ordinary legacy rollback keeps configured transport observable despite %s in unused native image',
  (kind) => {
    const home = path.join(root, 'machine');
    const user = path.join(root, 'user');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(user);
    fs.mkdirSync(path.join(repo, '.caws/specs'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.caws/policy.yaml'), 'version: 1\n');
    const legacy = install(home, false);
    const native = install(home);
    configureSystemRuntime({ home, userHome: user, surface: 'codex', entry: 'native' });
    const entry = path.join(home, 'bin/caws-hook-native');
    const stable = fs.readFileSync(entry);
    const nativeRoot = path.join(home, 'lib/runtimes', native.digest);
    const payload = path.join(nativeRoot, 'native-prefix', cli, 'dist/relative.json');
    if (kind === 'changed payload') fs.writeFileSync(payload, '{"fixture":"changed"}');
    if (kind === 'missing payload') fs.unlinkSync(payload);
    if (kind === 'unused Node mode') fs.chmodSync(path.join(nativeRoot, 'native/node'), 0o644);
    const failure = kind === 'unused Node mode' ? /mode mismatch/ : /modified|ENOENT/;
    expect(() => verifyRuntime(home, native.digest)).toThrow(failure);
    const retainedBefore = fixtureState(nativeRoot);
    const result = rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    });
    expect(result.digest).toBe(legacy.digest);
    expect(result.previousDigest).toBe(native.digest);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'state/adapter-runtime.json')))).toEqual({
      version: 1,
      digest: legacy.digest,
      previous_digest: native.digest,
    });
    expect(fs.readFileSync(entry)).toEqual(stable);
    expect(fs.statSync(entry).mode & 0o7777).toBe(0o755);
    expect(fixtureState(nativeRoot)).toEqual(retainedBefore);
    const before = fixtureState();
    const priorHome = process.env.CAWS_HOME;
    const homedir = jest.spyOn(os, 'homedir').mockReturnValue(user);
    process.env.CAWS_HOME = home;
    try {
      expect(
        configureSystemRuntime({ home, userHome: user, surface: 'codex', plan: true }).changed
      ).toBe(false);
      expect(systemSurfaceEnabled('codex', home, user)).toBe(true);
      expect(observeSystemRuntime(repo)).toEqual({
        surfaces: ['codex'],
        legacySurfaces: [],
        overrides: [],
        digest: legacy.digest,
      });
      expect(verifyRuntime(home, legacy.digest)['bootstrap.py']).toMatch(/^[a-f0-9]{64}$/);
      expect(() => verifyRuntime(home, native.digest)).toThrow(failure);
      expect(() =>
        configureSystemRuntime({
          home,
          userHome: user,
          surface: 'codex',
          entry: 'native',
          plan: true,
        })
      ).toThrow(/native-image/);
      expect(() =>
        rollbackMachineRuntime({
          home,
          templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
        })
      ).toThrow(failure);
    } finally {
      homedir.mockRestore();
      if (priorHome === undefined) delete process.env.CAWS_HOME;
      else process.env.CAWS_HOME = priorHome;
    }
    expect(fixtureState()).toEqual(before);
  }
);
test.each([
  'metadata hash',
  'metadata schema',
  'metadata timeout',
  'metadata extra field',
  'metadata traversal',
  'metadata missing member pin',
  'retained entry bytes',
  'retained entry mode',
  'retained entry hardlink',
  'stable entry hardlink',
])('ordinary legacy rollback refuses invalid compatibility identity: %s', (kind) => {
  const home = path.join(root, 'machine');
  install(home, false);
  let native = install(home).digest;
  if (kind.startsWith('metadata ') && kind !== 'metadata hash')
    native = rewriteRetainedMetadata(home, native, (metadata, manifest) => {
      if (kind === 'metadata schema') metadata.schema = 'unrecognized';
      if (kind === 'metadata timeout') metadata.timeoutMs = 0;
      if (kind === 'metadata extra field') metadata.unreviewed = true;
      if (kind === 'metadata traversal') {
        metadata.engineEntry = '../outside-engine.js';
        manifest[metadata.engineEntry] = sha(Buffer.from('outside fixture'));
      }
      if (kind === 'metadata missing member pin') delete manifest[metadata.engineEntry];
    });
  const retained = path.join(home, 'lib/runtimes', native, 'native/caws-hook-native');
  if (kind === 'metadata hash')
    fs.writeFileSync(path.join(home, 'lib/runtimes', native, 'native-entry.json'), '{}');
  if (kind === 'retained entry bytes') fs.writeFileSync(retained, 'Changed retained entry');
  if (kind === 'retained entry mode') fs.chmodSync(retained, 0o644);
  if (kind === 'retained entry hardlink')
    fs.linkSync(retained, path.join(root, 'retained-hardlink'));
  if (kind === 'stable entry hardlink')
    fs.linkSync(path.join(home, 'bin/caws-hook-native'), path.join(root, 'stable-hardlink'));
  const before = fixtureState();
  expect(() =>
    rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    })
  ).toThrow(/compatibility|identity|native|retained|link|metadata/i);
  expect(fixtureState()).toEqual(before);
});
test('ordinary legacy rollback repairs known single-link stable mode from retained entry identity', () => {
  const home = path.join(root, 'machine');
  const legacy = install(home, false);
  const native = install(home);
  const stable = path.join(home, 'bin/caws-hook-native');
  const bytes = fs.readFileSync(stable);
  fs.chmodSync(stable, 0o700);
  const result = rollbackMachineRuntime({
    home,
    templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
  });
  expect(result.digest).toBe(legacy.digest);
  expect(result.previousDigest).toBe(native.digest);
  expect(fs.readFileSync(stable)).toEqual(bytes);
  expect(fs.statSync(stable).mode & 0o7777).toBe(0o755);
  expect(fs.statSync(stable).nlink).toBe(1);
});
test('legacy rollback refuses dangling native metadata in the selected target', () => {
  const home = path.join(root, 'machine');
  const legacy = install(home, false);
  install(home);
  const marker = path.join(home, 'lib/runtimes', legacy.digest, 'native-entry.json');
  fs.symlinkSync('missing-native-metadata', marker);
  const pointer = path.join(home, 'state/adapter-runtime.json');
  const before = fs.readFileSync(pointer);
  const entry = path.join(home, 'bin/caws-hook-native');
  const bytes = fs.readFileSync(entry);
  expect(fs.existsSync(marker)).toBe(false);
  expect(fs.lstatSync(marker).isSymbolicLink()).toBe(true);
  expect(() => verifyRuntime(home, legacy.digest)).toThrow(/Untracked native metadata/);
  expect(() =>
    rollbackMachineRuntime({
      home,
      templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
    })
  ).toThrow(/Untracked native metadata/);
  expect(fs.readFileSync(pointer)).toEqual(before);
  expect(fs.readFileSync(entry)).toEqual(bytes);
  expect(fs.readlinkSync(marker)).toBe('missing-native-metadata');
});
test('legacy install refuses an orphan dangling native metadata marker', () => {
  const home = path.join(root, 'machine');
  install(home, false);
  const orphan = path.join(home, 'lib/runtimes', 'e'.repeat(64));
  fs.mkdirSync(orphan);
  const marker = path.join(orphan, 'native-entry.json');
  fs.symlinkSync('missing-native-metadata', marker);
  const pointer = path.join(home, 'state/adapter-runtime.json');
  const before = fs.readFileSync(pointer);
  expect(fs.existsSync(marker)).toBe(false);
  expect(() => install(home, false)).toThrow(/Native compatibility identity/);
  expect(fs.readFileSync(pointer)).toEqual(before);
  expect(fs.readlinkSync(marker)).toBe('missing-native-metadata');
  expect(fs.existsSync(path.join(home, 'bin/caws-hook-native'))).toBe(false);
});
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

describe('v2 receipt-derived image component boundaries (mocked receipt loader, no native execution)', () => {
  let descriptor, loaded, loader, nativeBytes, stableBytes, observation;
  const errorIdentity = (error) => ({
    name: error?.name,
    message: error?.message ?? String(error),
  });
  function installedState(home) {
    try {
      return Object.fromEntries(
        Object.entries(fixtureState(home)).map(([relative, entry]) => [
          relative,
          {
            mode: entry.mode,
            nlink: entry.nlink,
            ...(entry.bytes === undefined
              ? { type: 'directory' }
              : { type: 'file', sizeBytes: entry.bytes.length, sha256: sha(entry.bytes) }),
          },
        ])
      );
    } catch (error) {
      return { observationError: errorIdentity(error) };
    }
  }
  function observeOperation(label, run, home) {
    if (!process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR) return run();
    const callStart = loader.mock.results.length;
    const operation = { label, ...(home ? { home, before: installedState(home) } : {}) };
    try {
      const result = run();
      if (typeof result?.digest === 'string') operation.returned = result;
      return result;
    } catch (error) {
      operation.error = errorIdentity(error);
      throw error;
    } finally {
      operation.loaderResults = loader.mock.results
        .slice(callStart)
        .map((result) =>
          result.type === 'throw'
            ? { type: 'throw', error: errorIdentity(result.value) }
            : { type: result.type, returnedLoaded: result.value }
        );
      if (home) operation.after = installedState(home);
      observation.operations.push(operation);
    }
  }
  function retainPrepared(label, prepared) {
    if (!process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR) return;
    const identity = (bytes) =>
      Buffer.isBuffer(bytes) ? { sizeBytes: bytes.length, sha256: sha(bytes) } : null;
    const provenance = prepared.files.get('native-build-provenance.json');
    let parsedProvenance;
    try {
      parsedProvenance = JSON.parse(provenance);
    } catch (error) {
      parsedProvenance = { observationError: errorIdentity(error) };
    }
    observation.prepared.push({
      label,
      metadata: prepared.metadata,
      native: identity(prepared.files.get('native/caws-native')),
      stableEntryMember: identity(prepared.files.get('native/caws-hook-native')),
      stableEntry: identity(prepared.stableEntry),
      provenance: { ...identity(provenance), value: parsedProvenance },
    });
  }
  function prepareDescriptor() {
    const prepared = observeOperation('prepare receipt descriptor', () =>
      prepareNativeRuntimeEntryFromBuild(descriptor)
    );
    retainPrepared('returned image', prepared);
    return prepared;
  }
  function reviewedFile(name, bytes, mode = 0o644) {
    const file = path.join(root, name);
    fs.writeFileSync(file, bytes, { mode });
    fs.chmodSync(file, mode);
    return { path: file, sizeBytes: Buffer.byteLength(bytes), sha256: sha(Buffer.from(bytes)) };
  }
  function pinIdentity(pin) {
    return { sizeBytes: pin.sizeBytes, sha256: pin.sha256 };
  }
  function expectedProvenance() {
    return {
      schema: 'caws.runtime.native-build-provenance.v1',
      requestFile: pinIdentity(loaded.requestFile),
      completionReceipt: pinIdentity(loaded.completionReceipt),
      requestDigest: loaded.build.requestDigest,
      sourceTreeDigest: loaded.build.sourceTreeDigest,
      profile: loaded.build.profile,
      artifacts: {
        native: pinIdentity(loaded.build.artifacts.native),
        stableEntry: pinIdentity(loaded.build.artifacts.stableEntry),
      },
    };
  }
  function reviewedCliDomain() {
    const { cliClosureDigest } = require(path.join(dist, 'runtime/cli-identity'));
    const files = Object.fromEntries(
      Object.entries(descriptor.files)
        .filter(
          ([name]) => name.startsWith('node_modules/') && !name.endsWith('/.package-lock.json')
        )
        .map(([name, pin]) => [
          name,
          { ...pin, sizeBytes: fs.statSync(path.join(descriptor.prefixRoot, name)).size },
        ])
    );
    const review = {
      files,
      packages: Object.fromEntries(
        Object.entries(descriptor.packages).map(([name, pkg]) => [
          name,
          { name: pkg.name, version: pkg.version },
        ])
      ),
      omissions: descriptor.omissions,
      node: {
        path: 'native/node',
        sha256: descriptor.node.sha256,
        sizeBytes: fs.statSync(descriptor.node.source).size,
        mode: 0o755,
      },
    };
    const file = reviewedFile(
      'reviewed-cli-domain.json',
      JSON.stringify({
        schema: 'caws.cli.agents-stop-domain.v1',
        operation: 'agents-stop-explicit-session-opencode',
        closureSha256: cliClosureDigest(review),
        importers: [],
        dormantSites: [],
      })
    );
    descriptor.cliIdentityDomain = { source: file.path, sha256: file.sha256 };
    return file;
  }
  test('reviewed CLI policy is fixed pinned data copied into generation manifest inputs', () => {
    const domain = reviewedCliDomain(),
      prepared = prepareDescriptor();
    const source = JSON.parse(prepared.files.get('native-cli-identity.json'));
    expect(source.prefixRoot).toBe('native-prefix');
    expect(source.domain).toEqual({
      path: 'native-cli-domain.json',
      sha256: domain.sha256,
      sizeBytes: domain.sizeBytes,
      mode: 0o644,
    });
    expect(source.node.path).toBe('native/node');
    expect(source.files[cli + '/dist/index.js'].sha256).toBe(
      descriptor.files[cli + '/dist/index.js'].sha256
    );
    expect(source.files).not.toHaveProperty('package-lock.json');
    expect(prepared.files.get('native-cli-domain.json')).toEqual(fs.readFileSync(domain.path));
    const modes = JSON.parse(prepared.files.get('native-modes.json'));
    expect(modes['native-cli-domain.json']).toBe(0o644);
    expect(modes['native-cli-identity.json']).toBe(0o644);
  });
  test('missing CLI policy remains absent; present malformed or changed policy refuses', () => {
    expect(prepareDescriptor().files.has('native-cli-identity.json')).toBe(false);
    const domain = reviewedCliDomain();
    fs.appendFileSync(domain.path, ' ');
    expect(() => prepareDescriptor()).toThrow(/domain content changed/);
    descriptor.cliIdentityDomain.sha256 = sha(fs.readFileSync(domain.path));
    fs.writeFileSync(domain.path, '{}');
    descriptor.cliIdentityDomain.sha256 = sha(fs.readFileSync(domain.path));
    expect(() => prepareDescriptor()).toThrow(/does not bind/);
  });
  test('reviewed policy for old package bytes cannot be relabeled for the new closure', () => {
    reviewedCliDomain();
    write(cli + '/dist/index.js', 'changed package bytes\n');
    descriptor.files = input.files;
    expect(() => prepareDescriptor()).toThrow(/does not bind/);
  });
  function imageFile() {
    const file = path.join(root, 'receipt-image.json');
    fs.writeFileSync(file, JSON.stringify(descriptor), { mode: 0o600 });
    return file;
  }
  function existingHome() {
    const home = path.join(root, 'machine');
    install(home);
    return home;
  }
  function installDescriptor(home, nativeImage, plan = false) {
    return observeOperation(
      plan ? 'install plan' : 'install apply',
      () =>
        installMachineRuntime({
          home,
          nativeImage,
          plan,
          templatesRoot: path.join(__dirname, '../../templates/hook-packs'),
        }),
      home
    );
  }
  beforeEach(() => {
    observation = {
      test: expect.getState().currentTestName,
      boundary:
        'Mocked receipt-loader component observation; not a real build or assertion verdict',
      operations: [],
      prepared: [],
    };
    nativeBytes = Buffer.from('# inert receipt-selected native artifact\n');
    stableBytes = Buffer.from('# inert receipt-selected stable entry artifact\n');
    const requestFile = reviewedFile('native-build-request.json', '{"fixture":"request v2"}\n');
    const completionReceipt = reviewedFile('native-completed.json', '{"fixture":"receipt v2"}\n');
    loaded = {
      requestFile: { ...requestFile },
      completionReceipt: { ...completionReceipt },
      build: {
        schema: 'caws.native_sqlite_build_receipt.v2',
        status: 'completed',
        adoption: 'NOT_ADOPTED',
        requestDigest: 'a'.repeat(64),
        sourceTreeDigest: 'b'.repeat(64),
        profile: 'debug',
        observedIdentity: {
          schema: 'caws.sqlite_build_identity.v2',
          version: '3.53.4',
          sourceId:
            '2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc',
          threadSafe: 1,
          compileOptions: ['THREADSAFE=1', 'OMIT_LOAD_EXTENSION', 'ENABLE_API_ARMOR'],
          compiledPrefixSha256: 'c'.repeat(64),
          installedInvocation: { protocol: 'invoke-installed-v1', maxOriginalTimeoutMs: 30000 },
        },
        artifacts: {
          native: reviewedFile('receipt-native', nativeBytes, 0o755),
          stableEntry: reviewedFile('receipt-stable-entry', stableBytes, 0o755),
        },
      },
    };
    loaded.build.artifacts.runtimeIdentity = reviewedFile(
      'receipt-runtime-identity.json',
      JSON.stringify(loaded.build.observedIdentity)
    );
    const { native, ...shared } = input;
    delete shared.stableEntry;
    descriptor = {
      ...shared,
      schema: 'caws.runtime.native-image-input.v2',
      nativeNotices: native.notices,
      requestFile,
      completionReceipt,
    };
    loader = jest
      .spyOn(nativeBuildTooling, 'loadNativeSqliteBuildWithStableEntry')
      .mockReturnValue(loaded);
  });
  afterEach(() => {
    try {
      if (process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR)
        fs.writeFileSync(
          path.join(root, 'v2-observation.json'),
          JSON.stringify(
            {
              ...observation,
              descriptor,
              mockedLoadedCandidate: loaded,
            },
            null,
            2
          )
        );
    } finally {
      jest.restoreAllMocks();
    }
  });

  function replaceDiagnostic(value) {
    loaded.build.observedIdentity = value;
    loaded.build.artifacts.runtimeIdentity = reviewedFile(
      'receipt-runtime-identity.json',
      JSON.stringify(value)
    );
  }
  test('old diagnostic receipt cannot be stamped as an installed-capable image', () => {
    const old = { ...loaded.build.observedIdentity, schema: 'caws.sqlite_build_identity.v1' };
    delete old.installedInvocation;
    replaceDiagnostic(old);
    const before = fixtureState();
    expect(() => prepareDescriptor()).toThrow(/old receipts cannot produce entry v2/);
    expect(fixtureState()).toEqual(before);
  });
  test.each(['missing', 'null', 'extra', 'protocol', 'maximum'])(
    'receipt capability refuses %s before image publication',
    (kind) => {
      const value = globalThis.structuredClone(loaded.build.observedIdentity);
      if (kind === 'missing') delete value.installedInvocation;
      if (kind === 'null') value.installedInvocation = null;
      if (kind === 'extra') value.installedInvocation.downgrade = true;
      if (kind === 'protocol') value.installedInvocation.protocol = 'invoke';
      if (kind === 'maximum') value.installedInvocation.maxOriginalTimeoutMs = 120000;
      replaceDiagnostic(value);
      const before = fixtureState();
      expect(() => prepareDescriptor()).toThrow(/shape|capability/);
      expect(fixtureState()).toEqual(before);
    }
  );
  test('diagnostic bytes and receipt observation must agree under the selected pin', () => {
    const other = globalThis.structuredClone(loaded.build.observedIdentity);
    other.compileOptions.push('OTHER=1');
    loaded.build.artifacts.runtimeIdentity = reviewedFile(
      'other-runtime-identity.json',
      JSON.stringify(other)
    );
    expect(() => prepareDescriptor()).toThrow(/identity mismatch/);
  });
  test('changed retained diagnostic bytes refuse their pin before image construction', () => {
    fs.appendFileSync(loaded.build.artifacts.runtimeIdentity.path, ' ');
    expect(() => prepareDescriptor()).toThrow(/size mismatch|pin mismatch/);
  });
  test.each([0, 30001, 120000, 1.5])('installed image refuses timeout %s', (timeout) => {
    descriptor.timeoutMs = timeout;
    expect(() => prepareDescriptor()).toThrow(/1\.\.30000/);
  });
  test.each([1, 30000])(
    'installed image retains configured timeout %s without renewal',
    (timeout) => {
      descriptor.timeoutMs = timeout;
      expect(prepareDescriptor().metadata.timeoutMs).toBe(timeout);
    }
  );

  function syntheticSemanticData(prepared) {
    // Mechanical image inclusion only. These synthetic rows do not establish an
    // executed comparison or create a native invocation receipt.
    const sql = [
      'message-int4300',
      'message-int4301',
      'message-negative4300',
      'message-negative4301',
      'part-int4301',
      'message-string4301',
      'message-float4301',
    ];
    const renderer = [
      'plain',
      'integer4300',
      'integer4301',
      'negative4301',
      'string4301',
      'float4301',
      'html-literal4301',
      'html-decimal4301',
    ];
    return {
      schema: 'caws.runtime.stop-semantic-profile.v1',
      surface: 'opencode',
      event: 'stop',
      scope: 'controlled-components',
      implementation: Object.fromEntries(
        [...prepared.files]
          .filter(
            ([name]) =>
              name.startsWith('native/') ||
              name.startsWith('native-prefix/') ||
              ['native-entry.json', 'native-build-provenance.json'].includes(name)
          )
          .map(([name, bytes]) => [name, sha(bytes)])
      ),
      selectors: {
        sql: [4300, 0].map((integerMaxDigits) => ({
          id: `cpython-3.11.13-unicode14-int${integerMaxDigits}`,
          integerMaxDigits,
        })),
        renderer: [4300, 0].map((integerMaxDigits) => ({
          id: `cpython3.11-json/int-max-str-digits:${integerMaxDigits}`,
          integerMaxDigits,
        })),
      },
      sqliteIdentity: {
        schema: 'caws.sqlite_build_identity.v1',
        version: 'synthetic',
        sourceId: 'synthetic',
        threadSafe: 1,
        compileOptions: ['A=1'],
        compiledPrefixSha256: 'a'.repeat(64),
      },
      environment: { tz: 'UTC0', tzdir: 'absent', integerMaxDigits: [4300, 0] },
      comparison: {
        receiptSha256: 'b'.repeat(64),
        driverSha256: 'c'.repeat(64),
        comparisons: [4300, 0].flatMap((limit) => [
          ...sql.map((name) => ({
            id: `sql/${limit}/${name}`,
            result: 'equal',
            referenceSha256: 'd'.repeat(64),
            candidateSha256: 'd'.repeat(64),
          })),
          ...renderer.map((name) => ({
            id: `renderer/${limit}/${name}`,
            result: 'equal',
            referenceSha256: 'd'.repeat(64),
            candidateSha256: 'd'.repeat(64),
          })),
        ]),
      },
      provenance: {
        referenceMode: 'controlled-no-site-explicit-X',
        referenceAdapterSha256: '074dcc4c9880758ea9bfc092612034bff7f78b7d07bed2b4331e02d5916171a9',
        referenceSharedInventorySha256:
          '9976411f31abc0c6249433c79a45e6e556901ebcc9ae948218416fc9a92eaad8',
        corpusSha256: 'e9d9303ec7ce77dc15260aceadfa8392c7b2dbd5b3c70803354cedec6e097d19',
      },
      remainingJoins: [
        'native-calendar-original-environment',
        'bundled-engine-dispatch-equivalence',
        'native-selection-prefix-and-queued-peer-admission',
        'ordinary-publication-reopened-consumer-and-release',
        'ambient-legacy-startup-equivalence',
        'other-supported-surfaces',
      ],
    };
  }
  function selectSemanticData(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    const source = path.join(root, 'synthetic-semantic-data.json');
    fs.writeFileSync(source, bytes, { mode: 0o644 });
    descriptor.stopProfile = { source, sha256: sha(bytes) };
    return bytes;
  }

  function syntheticGitObservation(nativeSha256) {
    const hash = 'b'.repeat(64),
      snapshot = {
        path: '/usr/bin/git',
        physicalPath: '/usr/bin/git',
        sha256: hash,
        device: '1',
        inode: '1152921500312571562',
        bytes: 3,
        mode: 33261,
        modifiedSeconds: 4,
        modifiedNanoseconds: 0,
        changedSeconds: 5,
        changedNanoseconds: 0,
      };
    return {
      schema: 'caws.runtime.stop-git-distribution.v1',
      platform: 'macos',
      os: { kernelRelease: 'synthetic', kernelVersion: 'synthetic', machine: 'arm64' },
      inspectorNativeSha256: nativeSha256,
      callerGit: snapshot,
      resolver: { ...snapshot, path: '/usr/bin/xcrun' },
      developerSelector: { ...snapshot, path: '/usr/bin/xcode-select' },
      developerDirectory: '/Developer',
      developerIdentity: {
        physicalPath: '/Developer',
        device: '1',
        inode: '18446744073709551615',
        mode: 16877,
        modifiedSeconds: 4,
        modifiedNanoseconds: 0,
        changedSeconds: 5,
        changedNanoseconds: 0,
      },
      implementation: snapshot,
      provenance: {
        authenticator:
          'Security.framework/SecStaticCodeCheckValidity/all-architectures+strict/no-network',
        requirements: [
          'identifier "com.apple.git" and anchor apple',
          'identifier "com.apple.dt.xcode_select.tool-shim-public" and anchor apple',
          'identifier "com.apple.xcrun" and anchor apple',
          'identifier "com.apple.xcode-select" and anchor apple',
        ],
        loaderTcb: [
          'macos-platform-loader',
          'apple-code-signing-trust-store',
          'Security.framework',
          'CoreFoundation.framework',
          'CoreServices.framework',
          'libSystem',
          'libz',
          'libiconv',
        ],
      },
    };
  }
  test('v1 controlled data rejects an added Git observation even when null', () => {
    const before = prepareDescriptor();
    for (const observation of [null, syntheticGitObservation('a'.repeat(64))]) {
      const data = syntheticSemanticData(before);
      data.gitDistribution = observation;
      selectSemanticData(data);
      expect(() => prepareDescriptor()).toThrow(/semantic profile/);
    }
  });
  test('v2 observed Git data is copied into hashed image only with exact independent native identity', () => {
    const before = prepareDescriptor(),
      data = syntheticSemanticData(before);
    data.schema = 'caws.runtime.stop-semantic-profile.v2';
    data.gitDistribution = syntheticGitObservation(sha(before.files.get('native/caws-native')));
    const bytes = selectSemanticData(data);
    expect(prepareDescriptor().files.get('native-stop-profile.json')).toEqual(bytes);
    for (const inode of [
      Number('1152921500312571562'),
      '01',
      '+1',
      '-1',
      '18446744073709551616',
      ...[10, 13, 8232, 8233].map((code) => '1' + String.fromCharCode(code)),
    ]) {
      const bad = JSON.parse(JSON.stringify(data));
      bad.gitDistribution.callerGit.inode = inode;
      selectSemanticData(bad);
      expect(() => prepareDescriptor()).toThrow();
    }
    for (const kind of [
      'missing',
      'null',
      'old image',
      'unknown provenance',
      'extra permission',
      'unknown OS',
    ]) {
      const bad = JSON.parse(JSON.stringify(data));
      if (kind === 'missing') delete bad.gitDistribution;
      if (kind === 'null') bad.gitDistribution = null;
      if (kind === 'old image') bad.gitDistribution.inspectorNativeSha256 = '0'.repeat(64);
      if (kind === 'unknown provenance') bad.gitDistribution.provenance.requirements = [];
      if (kind === 'extra permission') bad.gitDistribution.permission = true;
      if (kind === 'unknown OS') bad.gitDistribution.platform = 'linux';
      selectSemanticData(bad);
      expect(() => prepareDescriptor()).toThrow();
    }
  });

  test('v2 includes exact semantic data without a final generation digest cycle or activation', () => {
    const before = prepareDescriptor();
    const data = syntheticSemanticData(before),
      bytes = selectSemanticData(data);
    const prepared = prepareDescriptor();
    expect(prepared.files.get('native-stop-profile.json')).toEqual(bytes);
    expect(JSON.parse(prepared.files.get('native-modes.json'))['native-stop-profile.json']).toBe(
      0o644
    );
    expect(prepared.files.get('native/caws-native')).toEqual(
      before.files.get('native/caws-native')
    );
    expect(prepared.metadata).toEqual(before.metadata);
    expect(data.implementation).not.toHaveProperty('native-stop-profile.json');
    expect(data.implementation).not.toHaveProperty('native-modes.json');
    expect(() =>
      prepareNativeRuntimeEntry({ ...input, stopProfile: descriptor.stopProfile })
    ).toThrow(/requires reviewed v2/);
  });
  test.each([
    'old native',
    'missing dist',
    'omitted row',
    'failed row',
    'swapped selectors',
    'erased joins',
    'component draft',
  ])('semantic data inclusion refuses %s before returning an image', (kind) => {
    const data = syntheticSemanticData(prepareDescriptor());
    if (kind === 'old native') data.implementation['native/caws-native'] = '0'.repeat(64);
    if (kind === 'missing dist') delete data.implementation[`native-prefix/${cli}/dist/index.js`];
    if (kind === 'omitted row') data.comparison.comparisons.pop();
    if (kind === 'failed row') data.comparison.comparisons[0].result = 'failed';
    if (kind === 'swapped selectors') data.selectors.sql = data.selectors.renderer;
    if (kind === 'erased joins') data.remainingJoins = [];
    if (kind === 'component draft') data.schema = 'caws.stop-profile.component-draft.v1';
    selectSemanticData(data);
    expect(() => prepareDescriptor()).toThrow(/Semantic|semantic/);
  });
  test('maps one selected artifact pair into retained buffers and ordinary provenance', () => {
    const prepared = prepareDescriptor();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(descriptor.requestFile.path);
    expect(prepared.files.get('native/caws-native')).toEqual(nativeBytes);
    expect(prepared.files.get('native/caws-hook-native')).toEqual(stableBytes);
    expect(prepared.stableEntry).toEqual(stableBytes);
    for (const [member, pin] of [
      ['native/caws-native', loaded.build.artifacts.native],
      ['native/caws-hook-native', loaded.build.artifacts.stableEntry],
    ]) {
      expect(prepared.files.get(member).length).toBe(pin.sizeBytes);
      expect(sha(prepared.files.get(member))).toBe(pin.sha256);
      expect(prepared.executablePaths.has(member)).toBe(true);
    }
    expect(JSON.parse(prepared.files.get('native-build-provenance.json'))).toEqual(
      expectedProvenance()
    );
    expect(prepared.executablePaths.has('native-build-provenance.json')).toBe(false);
    expect(prepared.files.get('native/licenses/native/LICENSE').toString()).toBe(
      'Reviewed fixture notice\n'
    );
    expect(prepared.metadata).toEqual({
      schema: 'caws.runtime.native-entry.v2',
      installedInvocation: { protocol: 'invoke-installed-v1', maxOriginalTimeoutMs: 30000 },
      nativeExecutable: 'native/caws-native',
      nodeExecutable: 'native/node',
      engineEntry: `native-prefix/${cli}/dist/runtime/engine-entry.js`,
      describeEntry: `native-prefix/${cli}/dist/runtime/describe-entry.js`,
      timeoutMs: 1000,
    });
  });

  test('returned image buffers retain the selected pair after source paths change', () => {
    const prepared = prepareDescriptor();
    fs.writeFileSync(loaded.build.artifacts.native.path, 'later native path bytes');
    fs.writeFileSync(loaded.build.artifacts.stableEntry.path, 'later stable path bytes');
    retainPrepared('after source-path mutation', prepared);
    expect(prepared.files.get('native/caws-native')).toEqual(nativeBytes);
    expect(prepared.files.get('native/caws-hook-native')).toEqual(stableBytes);
    expect(prepared.stableEntry).toEqual(stableBytes);
    expect(sha(prepared.files.get('native/caws-native'))).toBe(
      loaded.build.artifacts.native.sha256
    );
    expect(sha(prepared.stableEntry)).toBe(loaded.build.artifacts.stableEntry.sha256);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test('real image reader and installer publish exact receipt buffers without adopting the harness', () => {
    const home = existingHome();
    const legacyLauncher = fs.readFileSync(path.join(home, 'bin/caws-hook'));
    const user = path.join(root, 'user');
    fs.mkdirSync(user);
    configureSystemRuntime({ home, userHome: user, surface: 'claude-code', entry: 'legacy' });
    const registration = path.join(user, '.claude/settings.json');
    const registrationBytes = fs.readFileSync(registration);
    const nativeImage = imageFile();
    const before = fixtureState();
    const planned = installDescriptor(home, nativeImage, true);
    expect(planned.changed).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fixtureState()).toEqual(before);
    loader.mockClear();
    const applied = installDescriptor(home, nativeImage);
    expect(applied.digest).toBe(planned.digest);
    expect(loader).toHaveBeenCalledTimes(1);
    const generation = path.join(home, 'lib/runtimes', applied.digest);
    expect(fs.readFileSync(path.join(generation, 'native/caws-native'))).toEqual(nativeBytes);
    expect(fs.readFileSync(path.join(generation, 'native/caws-hook-native'))).toEqual(stableBytes);
    expect(fs.readFileSync(path.join(home, 'bin/caws-hook-native'))).toEqual(stableBytes);
    const provenance = fs.readFileSync(path.join(generation, 'native-build-provenance.json'));
    expect(JSON.parse(provenance)).toEqual(expectedProvenance());
    expect(verifyRuntime(home, applied.digest)['native-build-provenance.json']).toBe(
      sha(provenance)
    );
    for (const member of ['native/caws-native', 'native/caws-hook-native'])
      expect(fs.statSync(path.join(generation, member)).mode & 0o7777).toBe(0o755);
    expect(fs.statSync(path.join(generation, 'native-build-provenance.json')).mode & 0o7777).toBe(
      0o644
    );
    expect(fs.readFileSync(path.join(home, 'bin/caws-hook'))).toEqual(legacyLauncher);
    expect(fs.readFileSync(registration)).toEqual(registrationBytes);
  });

  test.each(['native', 'stableEntry'])(
    'rejects raw v2 executable override %s before loading',
    (field) => {
      const home = existingHome();
      descriptor[field] = input[field];
      const before = fixtureState(home);
      expect(() =>
        observeOperation('read executable override', () => readNativeImage(imageFile()), home)
      ).toThrow(/fields|native image/i);
      expect(loader).not.toHaveBeenCalled();
      expect(fixtureState(home)).toEqual(before);
    }
  );

  test.each(
    ['requestFile', 'completionReceipt'].flatMap((field) =>
      ['path', 'sizeBytes', 'sha256'].map((member) => [field, member])
    )
  )('refuses selected %s %s disagreement before publication', (field, member) => {
    const home = existingHome();
    if (member === 'path') {
      const alias = path.join(root, 'different-' + field + '.json');
      fs.copyFileSync(descriptor[field].path, alias);
      descriptor[field].path = alias;
    } else if (member === 'sizeBytes') descriptor[field].sizeBytes++;
    else descriptor[field].sha256 = 'f'.repeat(64);
    const nativeImage = imageFile();
    const before = fixtureState(home);
    expect(() => installDescriptor(home, nativeImage)).toThrow(
      /identity|mismatch|request|receipt/i
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(loader).toHaveBeenCalledWith(descriptor.requestFile.path);
    expect(fixtureState(home)).toEqual(before);
  });

  test.each([
    'request v1',
    'receipt v1 downgrade',
    'source identity mismatch',
    'profile mismatch',
    'completion receipt/request mismatch',
  ])('propagates loader refusal for %s without a conventional-target fallback', (reason) => {
    const home = existingHome();
    const conventional = path.join(root, 'target/aarch64-apple-darwin/debug');
    fs.mkdirSync(conventional, { recursive: true });
    fs.writeFileSync(path.join(conventional, 'caws-native'), nativeBytes, { mode: 0o755 });
    fs.writeFileSync(path.join(conventional, 'caws-hook-native'), stableBytes, { mode: 0o755 });
    const refusal = new Error('receipt loader refused: ' + reason);
    loader.mockImplementation(() => {
      throw refusal;
    });
    const nativeImage = imageFile();
    const before = fixtureState(home);
    expect(() => installDescriptor(home, nativeImage)).toThrow(refusal);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fixtureState(home)).toEqual(before);
  });

  test.each(
    ['native', 'stableEntry'].flatMap((artifact) =>
      [
        'same-size bytes',
        'size growth',
        'symlink',
        'hardlink',
        'nonexecutable',
        'writable mode',
      ].map((change) => [artifact, change])
    )
  )('refuses %s %s changed after loading and preserves installed state', (artifact, change) => {
    const home = existingHome();
    loader.mockImplementation(() => {
      const pin = loaded.build.artifacts[artifact];
      if (change === 'same-size bytes') {
        const changed = fs.readFileSync(pin.path);
        changed[0] ^= 0xff;
        fs.writeFileSync(pin.path, changed);
      }
      if (change === 'size growth') fs.appendFileSync(pin.path, 'x');
      if (change === 'symlink') {
        fs.renameSync(pin.path, pin.path + '-retained');
        fs.symlinkSync(pin.path + '-retained', pin.path);
      }
      if (change === 'hardlink') fs.linkSync(pin.path, pin.path + '-alias');
      if (change === 'nonexecutable') fs.chmodSync(pin.path, 0o644);
      if (change === 'writable mode') fs.chmodSync(pin.path, 0o777);
      return loaded;
    });
    const nativeImage = imageFile();
    const before = fixtureState(home);
    expect(() => installDescriptor(home, nativeImage)).toThrow(
      /changed|mismatch|unsafe|canonical|symlink|link|executable|permissions|size/i
    );
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fixtureState(home)).toEqual(before);
  });

  test.each(['native', 'stableEntry'])(
    'refuses %s ancestor redirection during bounded capture despite unchanged leaf identity',
    (artifact) => {
      const home = existingHome();
      const pin = loaded.build.artifacts[artifact];
      const parent = path.join(root, 'artifact-input');
      const retainedParent = parent + '-retained';
      fs.mkdirSync(parent, { mode: 0o700 });
      const artifactPath = path.join(parent, path.basename(pin.path));
      fs.renameSync(pin.path, artifactPath);
      pin.path = artifactPath;
      const leafIdentity = () => {
        const stat = fs.statSync(artifactPath);
        const bytes = fs.readFileSync(artifactPath);
        return {
          dev: stat.dev,
          ino: stat.ino,
          mode: stat.mode,
          nlink: stat.nlink,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          sha256: sha(bytes),
        };
      };
      const selectedLeaf = leafIdentity();
      const selectedRealpath = fs.realpathSync(artifactPath);
      expect(selectedRealpath).toBe(artifactPath);
      expect(selectedLeaf.sha256).toBe(pin.sha256);
      expect(selectedLeaf.sizeBytes).toBe(pin.sizeBytes);
      const nativeImage = imageFile();
      const before = fixtureState(home);
      const originalRead = fs.readSync;
      const originalFstat = fs.fstatSync;
      let swapped = false;
      const read = jest.spyOn(fs, 'readSync').mockImplementation((fd, ...args) => {
        const stat = originalFstat(fd);
        const count = originalRead(fd, ...args);
        if (
          !swapped &&
          count > 0 &&
          stat.dev === selectedLeaf.dev &&
          stat.ino === selectedLeaf.ino
        ) {
          fs.renameSync(parent, retainedParent);
          fs.symlinkSync(retainedParent, parent, 'dir');
          swapped = true;
        }
        return count;
      });
      let failure, witness;
      try {
        installDescriptor(home, nativeImage);
      } catch (error) {
        failure = error;
      } finally {
        read.mockRestore();
        witness = {
          artifact,
          artifactPath,
          parent,
          retainedParent,
          swapped,
          beforeRealpath: selectedRealpath,
          afterRealpath: fs.realpathSync(artifactPath),
          beforeLeaf: selectedLeaf,
          afterLeaf: leafIdentity(),
          ...(failure ? { error: errorIdentity(failure) } : {}),
        };
        if (process.env.CAWS_NATIVE_IMAGE_ARTIFACT_DIR) observation.ancestorSwap = witness;
      }
      expect(witness.swapped).toBe(true);
      expect(witness.afterLeaf).toEqual(witness.beforeLeaf);
      expect(witness.afterRealpath).toBe(path.join(retainedParent, path.basename(artifactPath)));
      expect(witness.afterRealpath).not.toBe(witness.beforeRealpath);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/canonical|changed/i);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(fixtureState(home)).toEqual(before);
    }
  );
});

test.each([1, 2])('retained entry identity admits exact metadata v%s', (version) => {
  const home = path.join(root, 'retained-metadata-home');
  let digest = install(home).digest;
  if (version === 2)
    digest = rewriteRetainedMetadata(home, digest, (metadata) => {
      metadata.schema = 'caws.runtime.native-entry.v2';
      metadata.installedInvocation = {
        protocol: 'invoke-installed-v1',
        maxOriginalTimeoutMs: 30000,
      };
    });
  expect(verifyRuntime(home, digest)['native-entry.json']).toMatch(/^[a-f0-9]{64}$/);
  const retained = readRetainedNativeEntryIdentity(home, digest);
  expect(retained.digest).toBe(digest);
  expect(retained.sha256).toBe(sha(retained.bytes));
});
test.each(['missing', 'null', 'extra', 'protocol', 'maximum', 'timeout', 'v1 capability'])(
  'retained metadata rejects a manifest-rebound invalid capability: %s',
  (kind) => {
    const home = path.join(root, 'hostile-retained-home');
    const original = install(home).digest;
    const digest = rewriteRetainedMetadata(home, original, (metadata) => {
      metadata.schema = 'caws.runtime.native-entry.v2';
      metadata.installedInvocation = {
        protocol: 'invoke-installed-v1',
        maxOriginalTimeoutMs: 30000,
      };
      if (kind === 'missing') delete metadata.installedInvocation;
      if (kind === 'null') metadata.installedInvocation = null;
      if (kind === 'extra') metadata.installedInvocation.renew = true;
      if (kind === 'protocol') metadata.installedInvocation.protocol = 'invoke';
      if (kind === 'maximum') metadata.installedInvocation.maxOriginalTimeoutMs = 120000;
      if (kind === 'timeout') metadata.timeoutMs = 30001;
      if (kind === 'v1 capability') metadata.schema = 'caws.runtime.native-entry.v1';
    });
    expect(() => verifyRuntime(home, digest)).toThrow(/metadata|schema|capability|timeout/);
    expect(() => readRetainedNativeEntryIdentity(home, digest)).toThrow(
      /metadata|schema|capability|timeout/
    );
  }
);
