'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const packageRoot = path.resolve(__dirname, '../..');
const repositoryRoot = path.resolve(packageRoot, '../..');
const transports = [
  ['LICENSE', path.join(repositoryRoot, 'LICENSE')],
  [
    'dist/transcripts/unicode14/LICENSE.txt',
    path.join(packageRoot, 'src/transcripts/unicode14/LICENSE.txt'),
  ],
  [
    'dist/transcripts/html311/LICENSE.txt',
    path.join(packageRoot, 'src/transcripts/html311/LICENSE.txt'),
  ],
];
const markerName = '.license-transport.json';
const lockName = '.license-transport.lock';
const artifactRootArgument = process.env.CAWS_LICENSE_TRANSPORT_ARTIFACT_ROOT;
let artifactRoot;
let root, pkg, script, sources, invocation;

function observedFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { type: 'absent' };
    return { type: 'observation-error', code: error.code, message: error.message };
  }
  const identity = Object.fromEntries(
    ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'nlink'].map((field) => [
      field,
      String(stat[field]),
    ])
  );
  if (stat.isSymbolicLink()) return { type: 'symlink', identity, target: fs.readlinkSync(file) };
  if (!stat.isFile()) return { type: stat.isDirectory() ? 'directory' : 'nonregular', identity };
  const bytes = fs.readFileSync(file);
  return {
    type: 'file',
    identity,
    length: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytesBase64: bytes.toString('base64'),
  };
}
function observedState() {
  return Object.fromEntries(
    [...transports.map(([name]) => name), markerName, lockName].map((name) => {
      const parts = name.split('/');
      for (let index = 1; index < parts.length; index++) {
        const ancestor = parts.slice(0, index).join('/');
        const state = observedFile(path.join(pkg, ancestor));
        if (state.type !== 'directory') return [name, { blockedAt: ancestor, ancestor: state }];
      }
      return [name, observedFile(path.join(pkg, name))];
    })
  );
}
function retain(name, value) {
  if (artifactRoot)
    fs.writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function invoke(operation, prefix = '', cli = false, argumentsList = [pkg]) {
  const source = `${prefix}
    const transport = await import(${JSON.stringify(pathToFileURL(script).href)});
    try {
      console.log(JSON.stringify(transport.${operation}(...${JSON.stringify(argumentsList)})));
    } catch (error) {
      console.error(JSON.stringify({ message: error.message, faults: typeof faults === 'undefined' ? null : faults }));
      process.exitCode = 1;
    }`;
  const argv = Array.isArray(cli)
    ? [script, ...cli]
    : cli
      ? [script]
      : ['--input-type=module', '-e', source];
  const before = artifactRoot ? observedState() : undefined;
  const result = spawnSync(process.execPath, argv, {
    cwd: root,
    encoding: 'utf8',
    timeout: 10000,
  });
  retain(`invoke-${String(++invocation).padStart(3, '0')}.json`, {
    operation,
    executable: process.execPath,
    argv,
    cwd: root,
    status: result.status,
    signal: result.signal,
    error: result.error
      ? {
          name: result.error.name,
          message: result.error.message,
          code: result.error.code,
        }
      : null,
    stdout: result.stdout,
    stderr: result.stderr,
    before,
    after: artifactRoot ? observedState() : undefined,
  });
  return result;
}
function stage() {
  return invoke('stageLicenseTransport');
}
function clean() {
  return invoke('cleanLicenseTransport');
}
function successful(result) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}
function refused(result, message) {
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(message);
}
function assertSources() {
  for (const [file, bytes] of sources) expect(fs.readFileSync(file)).toEqual(bytes);
}
function assertTransports() {
  for (const [name, canonical] of transports)
    expect(fs.readFileSync(path.join(pkg, name))).toEqual(fs.readFileSync(canonical));
}
function ledger() {
  return JSON.parse(fs.readFileSync(path.join(pkg, markerName), 'utf8'));
}

beforeAll(() => {
  if (artifactRootArgument === undefined) return;
  if (!path.isAbsolute(artifactRootArgument))
    throw new Error('CAWS_LICENSE_TRANSPORT_ARTIFACT_ROOT must be absolute');
  const requested = path.resolve(artifactRootArgument);
  const parent = fs.realpathSync(path.dirname(requested));
  const external = path.join(parent, path.basename(requested));
  const repository = fs.realpathSync(repositoryRoot);
  const relative = path.relative(repository, external);
  if (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  )
    throw new Error('CAWS_LICENSE_TRANSPORT_ARTIFACT_ROOT must be outside the repository');
  fs.mkdirSync(external); // A previous evidence directory is never reused or overwritten.
  artifactRoot = fs.realpathSync(external);
});
beforeEach(() => {
  root = fs.realpathSync(
    fs.mkdtempSync(path.join(artifactRoot || os.tmpdir(), 'caws-license-transport- # %-'))
  );
  invocation = 0;
  pkg = path.join(root, 'packages/caws-cli');
  script = path.join(pkg, 'scripts/clean-staged-docs.mjs');
  write(script, fs.readFileSync(path.join(packageRoot, 'scripts/clean-staged-docs.mjs')));
  sources = transports.map(([name, canonical]) => {
    const file =
      name === 'LICENSE'
        ? path.join(root, 'LICENSE')
        : path.join(pkg, name.replace(/^dist\//, 'src/'));
    const bytes = fs.readFileSync(canonical);
    write(file, bytes);
    return [file, bytes];
  });
  retain('fixture.json', {
    test: expect.getState().currentTestName,
    root,
    pkg,
    script,
    initial: observedState(),
  });
});
afterEach(() => {
  if (!root) return;
  if (artifactRoot)
    retain('final.json', {
      test: expect.getState().currentTestName,
      invocations: invocation,
      state: observedState(),
    });
  else fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test('stages exact authoritative bytes, repeats without adoption, and cleans owned files idempotently', () => {
  expect(successful(stage()).created).toEqual(transports.map(([name]) => name));
  assertTransports();
  expect(ledger().phase).toBe('ready');
  expect(ledger().entries.map((entry) => entry.status)).toEqual(['owned', 'owned', 'owned']);
  const recorded = fs.readFileSync(path.join(pkg, markerName));
  expect(successful(stage())).toEqual({ created: [], preserved: transports.map(([name]) => name) });
  expect(fs.readFileSync(path.join(pkg, markerName))).toEqual(recorded);
  expect(successful(clean()).removed).toEqual(transports.map(([name]) => name));
  for (const [name] of transports) expect(fs.existsSync(path.join(pkg, name))).toBe(false);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  expect(fs.existsSync(path.join(pkg, lockName))).toBe(false);
  expect(successful(clean())).toEqual({ removed: [] });
  assertSources();
});

test('cleaner CLI removes owned transports under URL-escaped package paths', () => {
  successful(stage());
  expect(script).toContain(' # %');
  const result = invoke('cleanLicenseTransport', '', true);
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  for (const [name] of transports) expect(fs.existsSync(path.join(pkg, name))).toBe(false);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  expect(fs.existsSync(path.join(pkg, lockName))).toBe(false);
  assertSources();
});

test('identical preexisting files remain unowned while newly created siblings are cleaned', () => {
  write(path.join(pkg, 'LICENSE'), sources[0][1]);
  const before = fs.statSync(path.join(pkg, 'LICENSE'), { bigint: true });
  expect(successful(stage())).toEqual({
    created: transports.slice(1).map(([name]) => name),
    preserved: ['LICENSE'],
  });
  expect(ledger().entries.map((entry) => entry.name)).toEqual(
    transports.slice(1).map(([name]) => name)
  );
  expect(successful(clean()).removed).toEqual(transports.slice(1).map(([name]) => name));
  expect(fs.statSync(path.join(pkg, 'LICENSE'), { bigint: true }).ino).toBe(before.ino);
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'))).toEqual(sources[0][1]);
  expect(successful(clean()).removed).toEqual([]);
  assertSources();
});

test('all identical preexisting transports need no ownership marker and survive cleanup', () => {
  for (const [name, canonical] of transports)
    write(path.join(pkg, name), fs.readFileSync(canonical));
  expect(successful(stage()).created).toEqual([]);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  expect(successful(clean()).removed).toEqual([]);
  assertTransports();
  assertSources();
});

test('conflicting and nonregular destinations refuse without replacing them', () => {
  const file = path.join(pkg, 'LICENSE');
  write(file, 'foreign bytes');
  refused(stage(), /conflicting destination/);
  expect(fs.readFileSync(file, 'utf8')).toBe('foreign bytes');
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  refused(stage(), /nonregular file or symlink/);
  expect(fs.lstatSync(file).isDirectory()).toBe(true);
  assertSources();
});

test.each([0, 1, 2])('source %i absence refuses repeatedly before creating transport', (index) => {
  const [file, bytes] = sources[index];
  fs.unlinkSync(file);
  refused(stage(), /ENOENT/);
  refused(stage(), /ENOENT/);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  expect(fs.existsSync(path.join(pkg, 'LICENSE'))).toBe(false);
  expect(successful(clean()).removed).toEqual([]);
  write(file, bytes);
  successful(stage());
  assertTransports();
  assertSources();
});

test('source leaf and ancestor symlinks refuse without touching their targets', () => {
  const outside = path.join(root, 'outside-license');
  write(outside, sources[0][1]);
  fs.unlinkSync(sources[0][0]);
  fs.symlinkSync(outside, sources[0][0]);
  refused(stage(), /nonregular file or symlink/);
  expect(fs.readFileSync(outside)).toEqual(sources[0][1]);
  fs.unlinkSync(sources[0][0]);
  write(sources[0][0], sources[0][1]);
  const directory = path.dirname(sources[1][0]);
  const moved = path.join(root, 'outside-unicode14');
  fs.renameSync(directory, moved);
  fs.symlinkSync(moved, directory);
  refused(stage(), /symlink ancestor/);
  expect(fs.readFileSync(path.join(moved, 'LICENSE.txt'))).toEqual(sources[1][1]);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
});

test.each([false, true])('destination symlink refuses including dangling=%s', (dangling) => {
  const outside = path.join(root, 'outside-target');
  if (!dangling) write(outside, 'foreign target');
  fs.symlinkSync(outside, path.join(pkg, 'LICENSE'));
  refused(stage(), /nonregular file or symlink/);
  refused(clean(), /nonregular file or symlink/);
  expect(fs.lstatSync(path.join(pkg, 'LICENSE')).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(outside)).toBe(!dangling);
  if (!dangling) expect(fs.readFileSync(outside, 'utf8')).toBe('foreign target');
  assertSources();
});

test('destination ancestor symlink refuses without writing into the redirected tree', () => {
  const outside = path.join(root, 'outside-dist');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(pkg, 'dist'));
  refused(stage(), /symlink ancestor/);
  refused(clean(), /symlink ancestor/);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  assertSources();
});

test.each([markerName, lockName])('%s symlink is never followed or reclaimed', (name) => {
  const outside = path.join(root, 'outside-record');
  fs.symlinkSync(outside, path.join(pkg, name));
  refused(stage(), /nonregular file or symlink/);
  refused(clean(), /nonregular file or symlink/);
  expect(fs.lstatSync(path.join(pkg, name)).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(outside)).toBe(false);
  assertSources();
});

test.each(['LICENSE', markerName])('same-byte foreign replacement of %s is preserved', (name) => {
  successful(stage());
  const file = path.join(pkg, name);
  const bytes = fs.readFileSync(file);
  const replacement = path.join(root, 'replacement');
  write(replacement, bytes);
  const originalInode = fs.statSync(file, { bigint: true }).ino;
  fs.renameSync(replacement, file);
  expect(fs.statSync(file, { bigint: true }).ino).not.toBe(originalInode);
  refused(clean(), /replaced or changed|marker identity or schema/);
  refused(stage(), /replaced or changed|marker identity or schema/);
  expect(fs.readFileSync(file)).toEqual(bytes);
  assertTransports();
  assertSources();
});

test('changed owned bytes refuse cleanup before any sibling is removed', () => {
  successful(stage());
  const file = path.join(pkg, transports[2][0]);
  write(file, 'foreign change');
  refused(clean(), /owned license replaced or changed/);
  expect(fs.readFileSync(file, 'utf8')).toBe('foreign change');
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'))).toEqual(sources[0][1]);
  expect(fs.readFileSync(path.join(pkg, transports[1][0]))).toEqual(sources[1][1]);
  assertSources();
});

test.each(['staging', 'cleaning'])('interrupted %s marker grants no cleanup authority', (phase) => {
  successful(stage());
  const record = ledger();
  record.phase = phase;
  write(path.join(pkg, markerName), JSON.stringify(record));
  refused(clean(), /interrupted/);
  refused(stage(), /interrupted/);
  assertTransports();
  assertSources();
});

test('incomplete marker and interrupted operation lock are not reclaimed', () => {
  successful(stage());
  write(path.join(pkg, markerName), '{"schema":');
  refused(clean(), /not complete JSON/);
  assertTransports();
  write(path.join(pkg, lockName), 'interrupted operation');
  refused(stage(), /operation lock exists/);
  refused(clean(), /operation lock exists/);
  expect(fs.readFileSync(path.join(pkg, lockName), 'utf8')).toBe('interrupted operation');
  assertTransports();
  assertSources();
});

test('ordinary repeat-build dist deletion permits restaging absent owned leaves', () => {
  successful(stage());
  const mitInode = fs.statSync(path.join(pkg, 'LICENSE'), { bigint: true }).ino;
  fs.rmSync(path.join(pkg, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'dist/transcripts'), { recursive: true });
  expect(successful(stage()).created).toEqual(transports.slice(1).map(([name]) => name));
  expect(fs.statSync(path.join(pkg, 'LICENSE'), { bigint: true }).ino).toBe(mitInode);
  expect(ledger().entries).toHaveLength(3);
  assertTransports();
  expect(successful(clean()).removed).toHaveLength(3);
  assertSources();
});

test('real marker write followed by failure retains uncertain ownership and exact created bytes', () => {
  const prefix = `
    import fs from 'node:fs';
    const originalWrite = fs.writeSync;
    let faults = 0;
    fs.writeSync = function(fd, bytes, ...args) {
      const written = originalWrite.call(fs, fd, bytes, ...args);
      let target;
      try { target = fs.statSync(${JSON.stringify(path.join(pkg, markerName))}, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return written; throw error; }
      const actual = fs.fstatSync(fd, { bigint: true });
      if (target.dev !== actual.dev || target.ino !== actual.ino) return written;
      const record = JSON.parse(bytes.toString('utf8'));
      if (record.phase === 'staging' && record.entries.length === 1 && record.entries[0].status === 'owned') {
        faults++;
        throw new Error('injected post-write marker failure');
      }
      return written;
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  refused(result, /injected post-write marker failure/);
  expect(JSON.parse(result.stderr).faults).toBe(1);
  expect(ledger().phase).toBe('staging');
  expect(ledger().entries[0].status).toBe('owned');
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'))).toEqual(sources[0][1]);
  expect(fs.existsSync(path.join(pkg, transports[1][0]))).toBe(false);
  expect(fs.existsSync(path.join(pkg, lockName))).toBe(false);
  refused(clean(), /interrupted/);
  refused(stage(), /interrupted/);
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'))).toEqual(sources[0][1]);
  assertSources();
});

test('operation, lock cleanup and descriptor-close failures retain all original messages', () => {
  const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, unlink = fs.unlinkSync, close = fs.closeSync;
    const lockPath = ${JSON.stringify(path.join(pkg, lockName))};
    let heldLockFD;
    let faults = { operation: 0, cleanup: 0, close: 0 };
    fs.openSync = function(file, flags, ...args) {
      if (file === ${JSON.stringify(path.join(pkg, 'LICENSE'))} && (flags & fs.constants.O_CREAT)) {
        faults.operation++;
        throw new Error('injected license open failure');
      }
      const fd = open.call(fs, file, flags, ...args);
      if (file === lockPath && (flags & fs.constants.O_CREAT)) heldLockFD = fd;
      return fd;
    };
    fs.unlinkSync = function(file) {
      if (file === lockPath) {
        faults.cleanup++;
        throw new Error('injected lock cleanup failure');
      }
      return unlink.call(fs, file);
    };
    fs.closeSync = function(fd) {
      close.call(fs, fd);
      if (fd === heldLockFD) {
        faults.close++;
        throw new Error('injected lock close failure');
      }
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  refused(result, /injected license open failure/);
  const observed = JSON.parse(result.stderr);
  expect(observed.message).toContain('injected lock cleanup failure');
  expect(observed.message).toContain('injected lock close failure');
  expect(observed.faults).toEqual({ operation: 1, cleanup: 1, close: 1 });
  expect(fs.existsSync(path.join(pkg, lockName))).toBe(true);
  expect(fs.existsSync(path.join(pkg, 'LICENSE'))).toBe(false);
  expect(ledger().phase).toBe('staging');
  expect(ledger().entries[0].status).toBe('planned');
  refused(clean(), /operation lock exists/);
  assertSources();
});

test('partial cleanup failure retains an interrupted marker and preserves remaining licenses', () => {
  successful(stage());
  const prefix = `
    import fs from 'node:fs';
    const unlink = fs.unlinkSync;
    let faults = 0;
    fs.unlinkSync = function(file) {
      if (file === ${JSON.stringify(path.join(pkg, transports[1][0]))}) {
        faults++;
        throw new Error('injected owned unlink failure');
      }
      return unlink.call(fs, file);
    };`;
  const result = invoke('cleanLicenseTransport', prefix);
  refused(result, /injected owned unlink failure/);
  expect(JSON.parse(result.stderr).faults).toBe(1);
  expect(fs.existsSync(path.join(pkg, 'LICENSE'))).toBe(false);
  expect(ledger().phase).toBe('cleaning');
  expect(ledger().entries.map((entry) => entry.name)).toEqual(
    transports.slice(1).map(([name]) => name)
  );
  for (const [name, canonical] of transports.slice(1))
    expect(fs.readFileSync(path.join(pkg, name))).toEqual(fs.readFileSync(canonical));
  refused(clean(), /interrupted/);
  refused(stage(), /interrupted/);
  assertSources();
});

function staleOwnership() {
  successful(stage());
  const record = ledger();
  record.markerIdentity.dev = String(BigInt(record.markerIdentity.dev) + 1n);
  for (const entry of record.entries) entry.identity.dev = record.markerIdentity.dev;
  write(path.join(pkg, markerName), JSON.stringify(record) + '\n');
  const bytes = fs.readFileSync(path.join(pkg, markerName));
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
function licenseState() {
  return Object.fromEntries(transports.map(([name]) => [name, observedFile(path.join(pkg, name))]));
}
function recovery(record, retention = path.join(root, 'retained-marker.json'), prefix = '') {
  return invoke('recoverLicenseTransport', prefix, false, [record.sha256, retention, pkg]);
}

test('device mismatch stays refused; explicit recovery retains exact evidence and leaves licenses unowned', () => {
  const record = staleOwnership();
  const before = licenseState();
  refused(clean(), /marker identity or schema/);
  expect(licenseState()).toEqual(before);
  const retainedAt = path.join(root, 'retained-marker.json');
  expect(successful(recovery(record, retainedAt))).toMatchObject({
    retired: markerName,
    sha256: record.sha256,
    retainedAt,
    licenses: 'preserved-unowned',
  });
  expect(fs.readFileSync(retainedAt)).toEqual(record.bytes);
  expect(fs.statSync(retainedAt).mode & 0o777).toBe(0o600);
  expect(fs.existsSync(path.join(pkg, markerName))).toBe(false);
  expect(fs.existsSync(path.join(pkg, lockName))).toBe(false);
  expect(licenseState()).toEqual(before);
  expect(successful(stage())).toEqual({ created: [], preserved: transports.map(([name]) => name) });
  expect(successful(clean())).toEqual({ removed: [] });
  expect(licenseState()).toEqual(before);
  expect(fs.readFileSync(retainedAt)).toEqual(record.bytes);
  assertSources();
});

test('recovery CLI requires explicit reviewed arguments and never cleans staged docs', () => {
  const record = staleOwnership();
  const before = licenseState();
  const document = path.join(pkg, 'docs/keep.txt');
  write(document, 'staged docs retained');
  const retainedAt = path.join(root, 'cli-retained.json');
  const args = [
    '--recover-license-ownership',
    '--expected-sha256',
    record.sha256,
    '--retain-original',
    retainedAt,
    '--package-root',
    pkg,
  ];
  expect(successful(invoke('recoverLicenseTransport', '', args))).toMatchObject({ retainedAt });
  expect(fs.readFileSync(document, 'utf8')).toBe('staged docs retained');
  expect(licenseState()).toEqual(before);
  expect(fs.readFileSync(retainedAt)).toEqual(record.bytes);
  const help = invoke('recoverLicenseTransport', '', ['--help']);
  expect(help.status).toBe(0);
  expect(help.stdout).toContain('--expected-sha256');
  expect(help.stdout).toContain('no cleanup authority');
});

test('wrong reviewed SHA and an existing retention file cannot retire ownership', () => {
  const record = staleOwnership();
  const before = licenseState();
  const changed = {
    ...record,
    sha256: (record.sha256[0] === '0' ? '1' : '0') + record.sha256.slice(1),
  };
  refused(recovery(changed), /SHA-256 mismatch/);
  expect(fs.existsSync(path.join(root, 'retained-marker.json'))).toBe(false);
  write(path.join(root, 'retained-marker.json'), 'foreign evidence');
  refused(recovery(record), /retention already exists/);
  expect(fs.readFileSync(path.join(root, 'retained-marker.json'), 'utf8')).toBe('foreign evidence');
  expect(fs.readFileSync(path.join(pkg, markerName))).toEqual(record.bytes);
  expect(licenseState()).toEqual(before);
});

test('same-byte foreign marker replacement refuses recovery despite the matching reviewed hash', () => {
  const record = staleOwnership();
  const before = licenseState();
  const replacement = path.join(root, 'foreign-marker');
  write(replacement, record.bytes);
  const original = fs.statSync(path.join(pkg, markerName), { bigint: true }).ino;
  fs.renameSync(replacement, path.join(pkg, markerName));
  expect(fs.statSync(path.join(pkg, markerName), { bigint: true }).ino).not.toBe(original);
  refused(recovery(record), /marker was replaced/);
  expect(fs.existsSync(path.join(root, 'retained-marker.json'))).toBe(false);
  expect(fs.readFileSync(path.join(pkg, markerName))).toEqual(record.bytes);
  expect(licenseState()).toEqual(before);
});

test('relinquishment preserves a same-byte foreign license without adopting or later deleting it', () => {
  const record = staleOwnership();
  const replacement = path.join(root, 'foreign-license');
  write(replacement, sources[0][1]);
  fs.renameSync(replacement, path.join(pkg, 'LICENSE'));
  const before = licenseState();
  successful(recovery(record));
  expect(successful(stage()).created).toEqual([]);
  expect(successful(clean()).removed).toEqual([]);
  expect(licenseState()).toEqual(before);
  assertSources();
});

test.each(['retention-leaf', 'retention-parent', 'marker', 'license', 'package-parent'])(
  'recovery refuses %s symlink without touching its target',
  (kind) => {
    const record = staleOwnership();
    let retention = path.join(root, 'retained-marker.json'),
      packageArgument = pkg;
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const target = path.join(outside, 'foreign');
    write(target, 'foreign target');
    if (kind === 'retention-leaf') fs.symlinkSync(target, retention);
    if (kind === 'retention-parent') {
      fs.symlinkSync(outside, path.join(root, 'redirect'));
      retention = path.join(root, 'redirect/evidence');
    }
    if (kind === 'marker' || kind === 'license') {
      const leaf = path.join(pkg, kind === 'marker' ? markerName : 'LICENSE');
      fs.unlinkSync(leaf);
      fs.symlinkSync(target, leaf);
    }
    if (kind === 'package-parent') {
      fs.symlinkSync(path.dirname(pkg), path.join(root, 'redirect'));
      packageArgument = path.join(root, 'redirect/caws-cli');
    }
    const before = licenseState();
    refused(
      invoke('recoverLicenseTransport', '', false, [record.sha256, retention, packageArgument]),
      /symlink/
    );
    expect(licenseState()).toEqual(before);
    expect(fs.readFileSync(target, 'utf8')).toBe('foreign target');
    assertSources();
  }
);

test('existing operation lock and interrupted marker grant no recovery authority', () => {
  const record = staleOwnership();
  const before = licenseState();
  write(path.join(pkg, lockName), 'foreign lock');
  refused(recovery(record), /operation lock exists/);
  expect(fs.readFileSync(path.join(pkg, lockName), 'utf8')).toBe('foreign lock');
  fs.unlinkSync(path.join(pkg, lockName));
  const interrupted = ledger();
  interrupted.phase = 'cleaning';
  write(path.join(pkg, markerName), JSON.stringify(interrupted));
  const reviewed = {
    sha256: createHash('sha256')
      .update(fs.readFileSync(path.join(pkg, markerName)))
      .digest('hex'),
  };
  refused(recovery(reviewed), /interrupted/);
  expect(fs.existsSync(path.join(root, 'retained-marker.json'))).toBe(false);
  expect(licenseState()).toEqual(before);
});

test.each(['bytes', 'replacement'])(
  'marker %s change after durable retention is not retired',
  (change) => {
    const record = staleOwnership();
    const before = licenseState();
    const retention = path.join(root, 'retained-marker.json');
    const prefix = `
    import fs from 'node:fs';
    const sync = fs.fsyncSync;
    let faults = 0;
    fs.fsyncSync = function(fd) {
      sync.call(fs, fd);
      if (faults === 0 && fs.fstatSync(fd).isDirectory()) {
        faults++;
        const marker = ${JSON.stringify(path.join(pkg, markerName))};
        if (${JSON.stringify(change)} === 'bytes') fs.appendFileSync(marker, ' ');
        else {
          const replacement = ${JSON.stringify(path.join(pkg, 'late-foreign-marker'))};
          fs.writeFileSync(replacement, fs.readFileSync(marker), { mode: 0o600 });
          fs.renameSync(replacement, marker);
        }
      }
    };`;
    const result = recovery(record, retention, prefix);
    refused(result, /replaced or changed/);
    expect(JSON.parse(result.stderr).faults).toBe(1);
    expect(fs.existsSync(path.join(pkg, markerName))).toBe(true);
    expect(fs.readFileSync(retention)).toEqual(record.bytes);
    expect(fs.readFileSync(path.join(pkg, markerName))).toEqual(
      change === 'bytes' ? Buffer.concat([record.bytes, Buffer.from(' ')]) : record.bytes
    );
    expect(licenseState()).toEqual(before);
  }
);

test.each(['open', 'write', 'sync', 'close', 'directory-sync'])(
  'retention %s failure preserves marker authority and all licenses',
  (fault) => {
    const record = staleOwnership();
    const before = licenseState();
    const retention = path.join(root, 'retained-marker.json');
    const prefix = `
      import fs from 'node:fs';
      const open = fs.openSync, write = fs.writeFileSync, sync = fs.fsyncSync, close = fs.closeSync;
      let evidenceFd;
      let faults = 0;
      const fault = ${JSON.stringify(fault)};
      const injected = () => { faults++; throw new Error('injected retention ' + fault + ' failure'); };
      fs.openSync = function(file, ...args) {
        if (file === ${JSON.stringify(retention)} && fault === 'open') injected();
        const fd = open.call(fs, file, ...args);
        if (file === ${JSON.stringify(retention)}) evidenceFd = fd;
        return fd;
      };
      fs.writeFileSync = function(file, ...args) {
        if (file === evidenceFd && fault === 'write') injected();
        return write.call(fs, file, ...args);
      };
      fs.fsyncSync = function(fd) {
        if ((fd === evidenceFd && fault === 'sync') ||
            (fault === 'directory-sync' && fs.fstatSync(fd).isDirectory())) injected();
        return sync.call(fs, fd);
      };
      fs.closeSync = function(fd) {
        close.call(fs, fd);
        if (fd === evidenceFd && fault === 'close') injected();
      };`;
    const result = recovery(record, retention, prefix);
    refused(result, /injected retention/);
    expect(JSON.parse(result.stderr).faults).toBe(1);
    expect(fs.readFileSync(path.join(pkg, markerName))).toEqual(record.bytes);
    expect(licenseState()).toEqual(before);
    if (fault === 'open') expect(fs.existsSync(retention)).toBe(false);
    else if (fault === 'write') expect(fs.readFileSync(retention)).toEqual(Buffer.alloc(0));
    else expect(fs.readFileSync(retention)).toEqual(record.bytes);
    refused(clean(), /marker identity or schema/);
    assertSources();
  }
);

test.each(['unlink', 'package-sync', 'marker-close'])(
  'marker retirement %s failure reports uncertainty while retaining original evidence',
  (fault) => {
    const record = staleOwnership();
    const before = licenseState();
    const retention = path.join(root, 'retained-marker.json');
    const prefix = `
      import fs from 'node:fs';
      const open = fs.openSync, unlink = fs.unlinkSync, sync = fs.fsyncSync, close = fs.closeSync;
      const markerFds = new Set();
      let packageFd;
      let faults = 0;
      const fault = ${JSON.stringify(fault)};
      const injected = () => { faults++; throw new Error('injected retirement ' + fault + ' failure'); };
      fs.openSync = function(file, ...args) {
        const fd = open.call(fs, file, ...args);
        if (file === ${JSON.stringify(path.join(pkg, markerName))}) markerFds.add(fd);
        if (file === ${JSON.stringify(pkg)}) packageFd = fd;
        return fd;
      };
      fs.unlinkSync = function(file) {
        if (file === ${JSON.stringify(path.join(pkg, markerName))} && fault === 'unlink') injected();
        return unlink.call(fs, file);
      };
      fs.fsyncSync = function(fd) {
        if (fd === packageFd && fault === 'package-sync') injected();
        return sync.call(fs, fd);
      };
      fs.closeSync = function(fd) {
        const wasMarker = markerFds.delete(fd);
        close.call(fs, fd);
        if (wasMarker && fault === 'marker-close' && !fs.existsSync(${JSON.stringify(path.join(pkg, markerName))})) injected();
      };`;
    const result = recovery(record, retention, prefix);
    refused(result, /completion uncertain/);
    expect(JSON.parse(result.stderr).faults).toBe(1);
    expect(fs.readFileSync(retention)).toEqual(record.bytes);
    expect(fs.existsSync(path.join(pkg, markerName))).toBe(fault === 'unlink');
    expect(licenseState()).toEqual(before);
    assertSources();
  }
);
