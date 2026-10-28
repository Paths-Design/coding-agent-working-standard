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

const relinquishedName =
  /^\.license-transport\.relinquished-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const remedy =
  /cleanup deletes only files it can prove it created; run `node scripts\/stage-consumer-docs\.mjs`/;
function replaceWithSameBytes(file) {
  const replacement = path.join(root, 'replacement');
  write(replacement, fs.readFileSync(file));
  fs.chmodSync(replacement, fs.statSync(file).mode & 0o777);
  const original = fs.statSync(file, { bigint: true }).ino;
  fs.renameSync(replacement, file);
  expect(fs.statSync(file, { bigint: true }).ino).not.toBe(original);
}
function rewriteMarker(change) {
  const record = ledger();
  change(record);
  write(path.join(pkg, markerName), JSON.stringify(record));
}
function relinquishedFiles() {
  return fs.readdirSync(pkg).filter((name) => name.startsWith('.license-transport.relinquished-'));
}

// Staging only creates files, so a stored record it cannot verify is moved aside
// intact instead of failing the build; cleanup, which deletes, keeps refusing it.
test.each([
  [
    'interrupted staging phase',
    () => rewriteMarker((record) => (record.phase = 'staging')),
    /ownership marker is interrupted/,
  ],
  [
    'interrupted cleaning phase',
    () => rewriteMarker((record) => (record.phase = 'cleaning')),
    /ownership marker is interrupted/,
  ],
  [
    'incomplete JSON',
    () => write(path.join(pkg, markerName), '{"schema":'),
    /ownership marker is not complete JSON/,
  ],
  [
    'unknown schema',
    () => rewriteMarker((record) => (record.schema = 2)),
    /ownership marker schema is invalid/,
  ],
  [
    'same-byte foreign marker',
    () => replaceWithSameBytes(path.join(pkg, markerName)),
    /ownership marker identity mismatch \(ino/,
  ],
  [
    'same-byte foreign owned license',
    () => replaceWithSameBytes(path.join(pkg, 'LICENSE')),
    /owned license replaced or changed \(ino\b[^)]*\): LICENSE/,
  ],
])(
  '%s: cleanup refuses with the remedy; staging relinquishes and deletes nothing',
  (_, corrupt, reason) => {
    successful(stage());
    corrupt();
    const marker = path.join(pkg, markerName);
    const recordBytes = fs.readFileSync(marker);
    const recordInode = fs.statSync(marker, { bigint: true }).ino;
    const before = licenseState();
    const cleaned = clean();
    refused(cleaned, reason);
    expect(JSON.parse(cleaned.stderr).message).toMatch(remedy);
    expect(licenseState()).toEqual(before);
    expect(fs.readFileSync(marker)).toEqual(recordBytes);

    const staged = stage();
    const result = successful(staged);
    expect(result).toEqual({
      created: [],
      preserved: transports.map(([name]) => name),
      relinquished: {
        reason: expect.stringMatching(reason),
        sha256: createHash('sha256').update(recordBytes).digest('hex'),
        retainedAt: expect.stringMatching(relinquishedName),
      },
    });
    const retained = path.join(pkg, result.relinquished.retainedAt);
    expect(fs.readFileSync(retained)).toEqual(recordBytes);
    expect(fs.statSync(retained, { bigint: true }).ino).toBe(recordInode);
    expect(relinquishedFiles()).toEqual([result.relinquished.retainedAt]);
    expect(fs.existsSync(marker)).toBe(false);
    expect(staged.stderr).toContain('no license file was deleted');
    expect(staged.stderr).toContain(result.relinquished.retainedAt);
    expect(staged.stderr).toContain(result.relinquished.sha256);
    expect(licenseState()).toEqual(before);
    expect(successful(clean())).toEqual({ removed: [] });
    expect(licenseState()).toEqual(before);
    expect(fs.readFileSync(retained)).toEqual(recordBytes);
    assertSources();
  }
);

test('a failed relinquish rename refuses staging and leaves the record in place', () => {
  successful(stage());
  rewriteMarker((record) => (record.phase = 'staging'));
  const marker = path.join(pkg, markerName);
  const before = observedFile(marker);
  const licenses = licenseState();
  const prefix = `
    import fs from 'node:fs';
    const rename = fs.renameSync;
    let faults = 0;
    fs.renameSync = function(from, to) {
      if (from === ${JSON.stringify(marker)}) {
        faults++;
        throw new Error('injected relinquish rename failure');
      }
      return rename.call(fs, from, to);
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  refused(result, /injected relinquish rename failure/);
  expect(JSON.parse(result.stderr).faults).toBe(1);
  expect(result.stderr).not.toContain('no license file was deleted');
  expect(observedFile(marker)).toEqual(before);
  expect(relinquishedFiles()).toEqual([]);
  expect(licenseState()).toEqual(licenses);
  assertSources();
});

test('a record swapped during relinquish is moved aside, never deleted, and no fresh record is made', () => {
  successful(stage());
  rewriteMarker((record) => (record.phase = 'cleaning'));
  const marker = path.join(pkg, markerName);
  const licenses = licenseState();
  const prefix = `
    import fs from 'node:fs';
    const rename = fs.renameSync;
    let faults = 0;
    fs.renameSync = function(from, to) {
      if (from === ${JSON.stringify(marker)} && faults === 0) {
        faults++;
        const foreign = ${JSON.stringify(path.join(pkg, 'late-foreign-marker'))};
        fs.writeFileSync(foreign, 'late foreign record', { mode: 0o600 });
        rename.call(fs, foreign, from);
      }
      return rename.call(fs, from, to);
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  refused(result, /ownership marker changed while being relinquished/);
  expect(JSON.parse(result.stderr).faults).toBe(1);
  const retained = relinquishedFiles();
  expect(retained).toHaveLength(1);
  expect(retained[0]).toMatch(relinquishedName);
  expect(fs.readFileSync(path.join(pkg, retained[0]), 'utf8')).toBe('late foreign record');
  expect(fs.existsSync(marker)).toBe(false);
  expect(licenseState()).toEqual(licenses);
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

test('incomplete marker and interrupted operation lock are not reclaimed', () => {
  successful(stage());
  write(path.join(pkg, markerName), '{"schema":');
  refused(clean(), /not complete JSON/);
  assertTransports();
  write(path.join(pkg, lockName), 'interrupted operation');
  refused(stage(), /operation lock exists/);
  refused(clean(), /operation lock exists/);
  expect(fs.readFileSync(path.join(pkg, lockName), 'utf8')).toBe('interrupted operation');
  // The lock refusal precedes custody, so staging relinquished nothing.
  expect(fs.readFileSync(path.join(pkg, markerName), 'utf8')).toBe('{"schema":');
  expect(relinquishedFiles()).toEqual([]);
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

function custodyDiagnostic(result) {
  refused(result, /owned record replaced or changed/);
  const message = JSON.parse(result.stderr).message;
  const diagnostic = message.slice(message.indexOf('; custody=') + '; custody='.length);
  expect(Buffer.byteLength(diagnostic)).toBeLessThan(2048);
  const data = JSON.parse(diagnostic);
  expect(data.schema).toBe('caws.license-transport.refusal.v1');
  expect(Object.keys(data).sort()).toEqual(
    ['schema', 'checkpoint', 'failedPredicate', 'expected', 'observed', 'heldFdIdentity'].sort()
  );
  for (const observation of [data.expected, data.observed]) {
    expect(Object.keys(observation).sort()).toEqual(['identity', 'sha256']);
    expect(Object.keys(observation.identity).sort()).toEqual(
      ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'nlink'].sort()
    );
    expect(observation.sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  return data;
}

// The held marker is statted on open, by current(), and around each write.
// Mutating after the specified real stat leaves its returned observation intact;
// the next checkpoint must refuse rather than adopt or delete the changed record.
test.each([
  ['marker_open', 'append', 1],
  ['marker_open', 'replacement', 1],
  ['marker_open', 'timestamps', 1],
  ['before_write', 'append', 2],
  ['after_write', 'append', 4],
  ['before_retire', 'append', 14],
])(
  'custody refusal identifies %s (%s) and skips the held FD after a path mismatch',
  (checkpoint, mutation, mutationStat) => {
    successful(stage());
    const marker = path.join(pkg, markerName);
    const before = observedFile(marker);
    const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, stat = fs.fstatSync, close = fs.closeSync;
    const marker = ${JSON.stringify(marker)};
    let held;
    let faults = { heldStats: 0, mutations: 0 };
    fs.openSync = function(file, flags, ...args) {
      const fd = open.call(fs, file, flags, ...args);
      if (file === marker && flags === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)) held = fd;
      return fd;
    };
    fs.fstatSync = function(fd, ...args) {
      const observed = stat.call(fs, fd, ...args);
      if (fd === held && ++faults.heldStats === ${mutationStat}) {
        if (${JSON.stringify(mutation)} === 'replacement') {
          const replacement = marker + '.foreign';
          fs.writeFileSync(replacement, fs.readFileSync(marker), { mode: 0o600 });
          fs.renameSync(replacement, marker);
        } else if (${JSON.stringify(mutation)} === 'timestamps') {
          fs.utimesSync(marker, Number(observed.atimeMs) / 1000, Number(observed.mtimeMs) / 1000 + 60);
        } else fs.appendFileSync(marker, ' ');
        faults.mutations++;
      }
      return observed;
    };
    fs.closeSync = function(fd) {
      if (fd === held) held = undefined;
      return close.call(fs, fd);
    };`;
    const result = invoke('cleanLicenseTransport', prefix);
    const data = custodyDiagnostic(result);
    expect(data.checkpoint).toBe(checkpoint);
    expect(data.failedPredicate).toBe('path_identity');
    expect(data.heldFdIdentity).toBe('not_observed');
    expect(JSON.parse(result.stderr).faults).toEqual({ heldStats: mutationStat, mutations: 1 });
    const after = observedFile(marker);
    expect(data.observed).toEqual({ identity: after.identity, sha256: after.sha256 });
    expect(data.expected.identity).not.toEqual(data.observed.identity);
    if (mutation === 'replacement') expect(data.observed.sha256).toBe(data.expected.sha256);
    if (mutation === 'timestamps') {
      expect(data.observed.sha256).toBe(data.expected.sha256);
      expect(data.observed.identity.mtimeNs).not.toBe(data.expected.identity.mtimeNs);
      for (const field of ['dev', 'ino', 'birthtimeNs', 'size', 'mode', 'nlink'])
        expect(data.observed.identity[field]).toBe(data.expected.identity[field]);
      expect(fs.readFileSync(marker)).toEqual(Buffer.from(before.bytesBase64, 'base64'));
    }
    if (checkpoint === 'marker_open' || checkpoint === 'before_write')
      expect(data.expected).toEqual({ identity: before.identity, sha256: before.sha256 });
    expect(after.type).toBe('file');
    expect(fs.existsSync(path.join(pkg, lockName))).toBe(false);
    if (checkpoint === 'before_retire') {
      expect(ledger().entries).toEqual([]);
      for (const [name] of transports) expect(fs.existsSync(path.join(pkg, name))).toBe(false);
    } else assertTransports();
    assertSources();
  }
);

test('byte mismatch reports captured hashes and skips the held FD without reopening for diagnostics', () => {
  successful(stage());
  const marker = path.join(pkg, markerName);
  const before = observedFile(marker);
  const changed = Buffer.from(fs.readFileSync(marker));
  changed[changed.length - 1] = 32; // Same-length observation fault; filesystem identity is unchanged.
  const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, read = fs.readFileSync, stat = fs.fstatSync, close = fs.closeSync;
    const marker = ${JSON.stringify(marker)};
    let held;
    const readers = new Set();
    let faults = { pathReads: 0, heldStats: 0, mutations: 0 };
    fs.openSync = function(file, flags, ...args) {
      const fd = open.call(fs, file, flags, ...args);
      if (file === marker) {
        if (flags === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)) held = fd;
        else readers.add(fd);
      }
      return fd;
    };
    fs.readFileSync = function(file, ...args) {
      const bytes = read.call(fs, file, ...args);
      if (readers.has(file) && ++faults.pathReads === 2) {
        const changed = Buffer.from(bytes);
        changed[changed.length - 1] = 32;
        faults.mutations++;
        return changed;
      }
      return bytes;
    };
    fs.fstatSync = function(fd, ...args) {
      if (fd === held) faults.heldStats++;
      return stat.call(fs, fd, ...args);
    };
    fs.closeSync = function(fd) {
      readers.delete(fd);
      if (fd === held) held = undefined;
      return close.call(fs, fd);
    };`;
  const result = invoke('cleanLicenseTransport', prefix);
  const data = custodyDiagnostic(result);
  expect(data.checkpoint).toBe('marker_open');
  expect(data.failedPredicate).toBe('path_bytes');
  expect(data.expected).toEqual({ identity: before.identity, sha256: before.sha256 });
  expect(data.observed).toEqual({
    identity: before.identity,
    sha256: createHash('sha256').update(changed).digest('hex'),
  });
  expect(data.heldFdIdentity).toBe('not_observed');
  expect(JSON.parse(result.stderr).faults).toEqual({ pathReads: 2, heldStats: 1, mutations: 1 });
  expect(observedFile(marker)).toEqual(before);
  assertTransports();
  assertSources();
});

test('held FD mismatch retains the earlier path observation and the actual FD identity', () => {
  successful(stage());
  const marker = path.join(pkg, markerName);
  const before = observedFile(marker);
  const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, stat = fs.fstatSync, close = fs.closeSync;
    const marker = ${JSON.stringify(marker)};
    let held;
    let faults = { heldStats: 0, mutations: 0 };
    fs.openSync = function(file, flags, ...args) {
      const fd = open.call(fs, file, flags, ...args);
      if (file === marker && flags === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)) held = fd;
      return fd;
    };
    fs.fstatSync = function(fd, ...args) {
      if (fd === held && ++faults.heldStats === 2) {
        fs.appendFileSync(marker, ' ');
        faults.mutations++;
      }
      return stat.call(fs, fd, ...args);
    };
    fs.closeSync = function(fd) {
      if (fd === held) held = undefined;
      return close.call(fs, fd);
    };`;
  const result = invoke('cleanLicenseTransport', prefix);
  const data = custodyDiagnostic(result);
  expect(data.checkpoint).toBe('marker_open');
  expect(data.failedPredicate).toBe('held_fd_identity');
  expect(data.expected).toEqual({ identity: before.identity, sha256: before.sha256 });
  expect(data.observed).toEqual(data.expected);
  expect(data.heldFdIdentity).toEqual(observedFile(marker).identity);
  expect(data.heldFdIdentity).not.toEqual(data.expected.identity);
  expect(JSON.parse(result.stderr).faults).toEqual({ heldStats: 2, mutations: 1 });
  assertTransports();
  assertSources();
});

test('lock cleanup refusal identifies the checkpoint and preserves the changed lock', () => {
  const lock = path.join(pkg, lockName);
  const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, stat = fs.fstatSync;
    let held;
    let faults = { heldStats: 0, mutations: 0 };
    fs.openSync = function(file, flags, ...args) {
      const fd = open.call(fs, file, flags, ...args);
      if (file === ${JSON.stringify(lock)} && (flags & fs.constants.O_CREAT)) held = fd;
      return fd;
    };
    fs.fstatSync = function(fd, ...args) {
      const observed = stat.call(fs, fd, ...args);
      if (fd === held && ++faults.heldStats === 1) {
        fs.appendFileSync(${JSON.stringify(lock)}, ' ');
        faults.mutations++;
      }
      return observed;
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  const data = custodyDiagnostic(result);
  expect(data.checkpoint).toBe('lock_cleanup');
  expect(data.failedPredicate).toBe('path_identity');
  expect(data.heldFdIdentity).toBe('not_observed');
  const after = observedFile(lock);
  expect(data.observed).toEqual({ identity: after.identity, sha256: after.sha256 });
  expect(JSON.parse(result.stderr).faults).toEqual({ heldStats: 1, mutations: 1 });
  expect(ledger().phase).toBe('ready');
  assertTransports();
  assertSources();
});

// Relinquishing is for a stored record that cannot prove ownership; a record that
// changes while staging holds it is an active race and must still refuse.
test('a marker changed while staging holds it refuses instead of being relinquished', () => {
  successful(stage());
  const marker = path.join(pkg, markerName);
  const prefix = `
    import fs from 'node:fs';
    const open = fs.openSync, stat = fs.fstatSync, close = fs.closeSync;
    const marker = ${JSON.stringify(marker)};
    let held;
    let faults = { heldStats: 0, mutations: 0 };
    fs.openSync = function(file, flags, ...args) {
      const fd = open.call(fs, file, flags, ...args);
      if (file === marker && flags === (fs.constants.O_RDWR | fs.constants.O_NOFOLLOW)) held = fd;
      return fd;
    };
    fs.fstatSync = function(fd, ...args) {
      const observed = stat.call(fs, fd, ...args);
      if (fd === held && ++faults.heldStats === 1) {
        fs.appendFileSync(marker, ' ');
        faults.mutations++;
      }
      return observed;
    };
    fs.closeSync = function(fd) {
      if (fd === held) held = undefined;
      return close.call(fs, fd);
    };`;
  const result = invoke('stageLicenseTransport', prefix);
  const data = custodyDiagnostic(result);
  expect(data.checkpoint).toBe('marker_open');
  expect(data.failedPredicate).toBe('path_identity');
  expect(JSON.parse(result.stderr).faults).toEqual({ heldStats: 1, mutations: 1 });
  expect(relinquishedFiles()).toEqual([]);
  expect(ledger().phase).toBe('ready');
  assertTransports();
  assertSources();
});

test('a conflicting destination refuses staging before an unverifiable record is relinquished', () => {
  successful(stage());
  rewriteMarker((record) => (record.phase = 'staging'));
  const marker = path.join(pkg, markerName);
  const before = observedFile(marker);
  write(path.join(pkg, 'LICENSE'), 'foreign bytes');
  refused(stage(), /conflicting destination: LICENSE/);
  expect(observedFile(marker)).toEqual(before);
  expect(relinquishedFiles()).toEqual([]);
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'), 'utf8')).toBe('foreign bytes');
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
  // The next build relinquishes the interrupted record instead of refusing every
  // later build; the license created before the crash becomes unowned, not deleted.
  const marker = path.join(pkg, markerName);
  const interrupted = fs.readFileSync(marker);
  const interruptedInode = fs.statSync(marker, { bigint: true }).ino;
  const restaged = successful(stage());
  expect(restaged).toEqual({
    created: transports.slice(1).map(([name]) => name),
    preserved: ['LICENSE'],
    relinquished: {
      reason: expect.stringMatching(/ownership marker is interrupted/),
      sha256: createHash('sha256').update(interrupted).digest('hex'),
      retainedAt: expect.stringMatching(relinquishedName),
    },
  });
  const retained = path.join(pkg, restaged.relinquished.retainedAt);
  expect(fs.readFileSync(retained)).toEqual(interrupted);
  expect(fs.statSync(retained, { bigint: true }).ino).toBe(interruptedInode);
  expect(ledger().entries.map((entry) => entry.name)).toEqual(
    transports.slice(1).map(([name]) => name)
  );
  assertTransports();
  expect(successful(clean()).removed).toEqual(transports.slice(1).map(([name]) => name));
  expect(fs.readFileSync(path.join(pkg, 'LICENSE'))).toEqual(sources[0][1]);
  for (const [name] of transports.slice(1)) expect(fs.existsSync(path.join(pkg, name))).toBe(false);
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
  // Restaging recreates only the removed license; the two left behind by the
  // failed cleanup stay on disk unowned, so a later cleanup cannot delete them.
  const restaged = successful(stage());
  expect(restaged.created).toEqual(['LICENSE']);
  expect(restaged.preserved).toEqual(transports.slice(1).map(([name]) => name));
  expect(restaged.relinquished.reason).toMatch(/ownership marker is interrupted/);
  assertTransports();
  expect(successful(clean()).removed).toEqual(['LICENSE']);
  for (const [name, canonical] of transports.slice(1))
    expect(fs.readFileSync(path.join(pkg, name))).toEqual(fs.readFileSync(canonical));
  assertSources();
});

// A reboot renumbers the device (APFS assigns st_dev at mount): the recorded dev
// no longer matches the live one while every other recorded field still does.
function deviceShifted() {
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

test('a reboot-renumbered device keeps custody through restaging and cleanup', () => {
  const shifted = deviceShifted();
  const marker = path.join(pkg, markerName);
  expect(ledger().markerIdentity.dev).not.toBe(observedFile(marker).identity.dev);
  const before = licenseState();
  const repeated = stage();
  expect(successful(repeated)).toEqual({
    created: [],
    preserved: transports.map(([name]) => name),
  });
  expect(repeated.stderr).toBe('');
  expect(fs.readFileSync(marker)).toEqual(shifted.bytes);
  expect(licenseState()).toEqual(before);
  // The observed failure: the next build after a reboot wipes dist and restages.
  fs.rmSync(path.join(pkg, 'dist'), { recursive: true });
  expect(successful(stage())).toEqual({
    created: transports.slice(1).map(([name]) => name),
    preserved: ['LICENSE'],
  });
  expect(relinquishedFiles()).toEqual([]);
  expect(ledger().entries.map((entry) => entry.name)).toEqual(transports.map(([name]) => name));
  assertTransports();
  expect(successful(clean())).toEqual({ removed: transports.map(([name]) => name) });
  for (const [name] of transports) expect(fs.existsSync(path.join(pkg, name))).toBe(false);
  expect(fs.existsSync(marker)).toBe(false);
  assertSources();
});

// Dropping dev from the cross-boot comparison must not admit a different inode.
test.each([
  ['LICENSE', /owned license replaced or changed \(ino\b[^)]*\): LICENSE/],
  [markerName, /ownership marker identity mismatch \(ino(, birthtimeNs)?\)/],
])('a device shift never admits a same-byte foreign %s', (name, reason) => {
  deviceShifted();
  replaceWithSameBytes(path.join(pkg, name));
  const before = licenseState();
  const result = clean();
  refused(result, reason);
  expect(JSON.parse(result.stderr).message).not.toMatch(/device|sha256/);
  expect(licenseState()).toEqual(before);
  assertSources();
});

// Reports `dev + 1` for one path's lstat and for every descriptor opened on it,
// so that object reads self-consistently but sits on another device.
function deviceSplit(target) {
  return `
    import fs from 'node:fs';
    const open = fs.openSync, lstat = fs.lstatSync, fstat = fs.fstatSync, close = fs.closeSync;
    const target = ${JSON.stringify(target)};
    const fds = new Set();
    let faults = 0;
    const shifted = (stat) => new Proxy(stat, {
      get(observed, key) {
        if (key === 'dev') return typeof observed.dev === 'bigint' ? observed.dev + 1n : observed.dev + 1;
        const value = observed[key];
        return typeof value === 'function' ? value.bind(observed) : value;
      },
    });
    fs.openSync = function(file, ...args) {
      const fd = open.call(fs, file, ...args);
      if (file === target) fds.add(fd);
      return fd;
    };
    fs.closeSync = function(fd) {
      fds.delete(fd);
      return close.call(fs, fd);
    };
    fs.lstatSync = function(file, ...args) {
      const stat = lstat.call(fs, file, ...args);
      if (file !== target) return stat;
      faults++;
      return shifted(stat);
    };
    fs.fstatSync = function(fd, ...args) {
      const stat = fstat.call(fs, fd, ...args);
      return fds.has(fd) ? shifted(stat) : stat;
    };`;
}

test.each([
  ['the package root', () => pkg, /ownership marker identity mismatch \(device\)/],
  [
    'an owned leaf',
    () => path.join(pkg, transports[2][0]),
    /owned license replaced or changed \(device\): dist\/transcripts\/html311\/LICENSE\.txt/,
  ],
])('%s on another device refuses cleanup and deletes nothing', (_, target, reason) => {
  successful(stage());
  const before = licenseState();
  const result = invoke('cleanLicenseTransport', deviceSplit(target()));
  refused(result, reason);
  expect(JSON.parse(result.stderr).faults).toBeGreaterThan(0);
  expect(licenseState()).toEqual(before);
  expect(ledger().phase).toBe('ready');
  assertSources();
});

test('explicit recovery retires a verified marker into external evidence and leaves licenses unowned', () => {
  const record = deviceShifted();
  const before = licenseState();
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
  const record = deviceShifted();
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
  const record = deviceShifted();
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
  const record = deviceShifted();
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
  const record = deviceShifted();
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
    const record = deviceShifted();
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
  const record = deviceShifted();
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
    const record = deviceShifted();
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
    const record = deviceShifted();
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
    // The marker kept its authority, so ordinary cleanup still removes what it owns.
    expect(successful(clean())).toEqual({ removed: transports.map(([name]) => name) });
    assertSources();
  }
);

test.each(['unlink', 'package-sync', 'marker-close'])(
  'marker retirement %s failure reports uncertainty while retaining original evidence',
  (fault) => {
    const record = deviceShifted();
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
