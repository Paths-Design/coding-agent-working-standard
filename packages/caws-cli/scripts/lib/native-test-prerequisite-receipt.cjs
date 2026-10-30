'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = 'caws.native-test-prerequisite.v1';
const CHANNEL = '1.90.0';
const ENV = 'CAWS_TEST_GUARD_STRIKES_CORE_TEST_BINARY';
const fail = (message) => {
  throw new Error('Native test prerequisite: ' + message);
};
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const keys = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === expected.length &&
  expected.every((name) => Object.hasOwn(value, name));
function physical(value) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value)
    fail('nonabsolute/noncanonical path');
  let cursor = path.parse(value).root;
  for (const part of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('symlink path: ' + cursor);
  }
  if (fs.realpathSync.native(value) !== value) fail('nonphysical path: ' + value);
  return value;
}
function locations(packageRoot) {
  const pkg = physical(fs.realpathSync.native(packageRoot));
  const repo = physical(path.resolve(pkg, '../..'));
  const native = physical(path.resolve(pkg, '../caws-native'));
  const target = path.join(native, 'target');
  return {
    pkg,
    repo,
    native,
    target,
    receipt: path.join(target, 'qualification-tools/native-test-prerequisite.json'),
  };
}
function stableFile(file, limit = 16 * 1024 * 1024) {
  physical(file);
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.size > limit) fail('expected bounded regular file: ' + file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  const same = (a, b) =>
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.mode === b.mode;
  try {
    const opened = fs.fstatSync(fd);
    if (!same(before, opened)) fail('input replaced: ' + file);
    const digest = crypto.createHash('sha256'),
      chunk = Buffer.alloc(65536);
    let size = 0;
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > limit) fail('file grew beyond bound: ' + file);
      digest.update(chunk.subarray(0, count));
    }
    if (
      size !== before.size ||
      !same(opened, fs.fstatSync(fd)) ||
      !same(opened, fs.lstatSync(file))
    )
      fail('input changed while reading: ' + file);
    return { path: file, sizeBytes: size, sha256: digest.digest('hex') };
  } finally {
    fs.closeSync(fd);
  }
}
function sourceFingerprint(packageRoot) {
  const { repo, native } = locations(packageRoot);
  const files = [];
  let total = 0;
  const add = (file) => {
    const pin = stableFile(file);
    total += pin.sizeBytes;
    if (files.length >= 10000 || total > 128 * 1024 * 1024) fail('source inventory exceeds bound');
    files.push({
      path: path.relative(repo, file).split(path.sep).join('/'),
      sizeBytes: pin.sizeBytes,
      sha256: pin.sha256,
    });
  };
  const walk = (directory) => {
    physical(directory);
    if (!fs.lstatSync(directory).isDirectory()) fail('source tree is not a directory');
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name),
        stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('source symlink: ' + file);
      if (stat.isDirectory()) walk(file);
      else add(file);
    }
  };
  for (const name of ['Cargo.toml', 'Cargo.lock', 'build.rs']) add(path.join(native, name));
  const toolchain = path.join(repo, 'rust-toolchain.toml');
  add(toolchain);
  if (!/^channel\s*=\s*"1\.90\.0"\s*$/m.test(fs.readFileSync(toolchain, 'utf8')))
    fail('repository toolchain must pin Rust ' + CHANNEL);
  for (const name of ['src', 'tests', 'examples']) walk(path.join(native, name));
  walk(path.join(repo, 'packages/caws-cli/templates/hook-packs'));
  // Native protocol libtests embed these exact CLI source bytes with include_bytes!.
  for (const name of ['service-client.ts', 'service-protocol.ts'])
    add(path.join(repo, 'packages/caws-cli/src/runtime', name));
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { sha256: hash(JSON.stringify(files)), fileCount: files.length };
}
function toolchainObservation(rustc, cargo) {
  if (
    typeof rustc !== 'string' ||
    typeof cargo !== 'string' ||
    !/^release: 1\.90\.0$/m.test(rustc.trim()) ||
    !/^rustc 1\.90\.0\s/.test(rustc) ||
    !/^cargo 1\.90\.0\s/.test(cargo) ||
    rustc.length > 65536 ||
    cargo.length > 65536
  )
    fail('actual rustc/cargo do not match pinned ' + CHANNEL);
  return {
    channel: CHANNEL,
    rustc: rustc.trim(),
    cargo: cargo.trim(),
    platform: process.platform,
    arch: process.arch,
  };
}
function pinExecutable(packageRoot, candidate) {
  const { target } = locations(packageRoot);
  physical(target);
  physical(candidate);
  const rel = path.relative(target, candidate);
  if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel))
    fail('executable escaped local target');
  fs.accessSync(candidate, fs.constants.X_OK);
  return stableFile(candidate, 1024 * 1024 * 1024);
}
function selectCoreTestArtifact(packageRoot, output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 32 * 1024 * 1024)
    fail('Cargo JSON output unavailable/oversized');
  const { native } = locations(packageRoot);
  const candidates = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      fail('malformed Cargo JSON');
    }
    if (
      row.reason !== 'compiler-artifact' ||
      row.target?.name !== 'caws_native' ||
      !Array.isArray(row.target.kind) ||
      !row.target.kind.includes('lib') ||
      row.profile?.test !== true
    )
      continue;
    if (
      row.target.src_path !== path.join(native, 'src/lib.rs') ||
      typeof row.executable !== 'string' ||
      !Array.isArray(row.features) ||
      row.features.length
    )
      fail('libtest artifact identity/profile mismatch');
    candidates.push(pinExecutable(packageRoot, row.executable));
  }
  if (candidates.length !== 1)
    fail('expected exactly one current Cargo libtest executable, found ' + candidates.length);
  return candidates[0];
}
function removeReceipt(packageRoot) {
  const { target, receipt } = locations(packageRoot);
  if (!fs.existsSync(target)) return;
  physical(target);
  // Reject already-shared output ancestors before tsc/Cargo can write through them.
  for (const relative of [
    'debug',
    'debug/deps',
    'qualification-tools',
    'qualification-tools/scripts',
  ]) {
    const directory = path.join(target, relative),
      stat = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (stat) {
      physical(directory);
      if (!stat.isDirectory()) fail('output ancestor is not a directory');
    }
  }
  const stat = fs.lstatSync(receipt, { throwIfNoEntry: false });
  if (!stat) return;
  physical(receipt);
  if (!stat.isFile()) fail('receipt is not a regular file');
  fs.unlinkSync(receipt);
}
function publishReceipt(packageRoot, source, toolchain, coreTest) {
  const info = locations(packageRoot);
  physical(info.target);
  const directory = path.dirname(info.receipt);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  physical(directory);
  const row = {
    schema: SCHEMA,
    packageRoot: info.pkg,
    nativeRoot: info.native,
    target: info.target,
    toolchain,
    source,
    coreTest,
  };
  const temporary =
    info.receipt + '.tmp-' + process.pid + '-' + crypto.randomBytes(12).toString('hex');
  let fd;
  let ownsTemporary = false;
  const failures = [];
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    ownsTemporary = true;
    fs.writeFileSync(fd, JSON.stringify(row) + '\n');
    fs.fsyncSync(fd);
    const closing = fd;
    fd = undefined;
    fs.closeSync(closing);
    fs.renameSync(temporary, info.receipt);
    ownsTemporary = false;
  } catch (error) {
    failures.push(error);
  }
  if (fd !== undefined) {
    try {
      fs.closeSync(fd);
    } catch (error) {
      failures.push(error);
    }
  }
  if (ownsTemporary) {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push(error);
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Native prerequisite publication and cleanup failed');
  if (failures.length) throw failures[0];
  return row;
}
function readReceipt(packageRoot) {
  const info = locations(packageRoot);
  // A shared target is unavailable to this reader, never a receipt donor.
  // lstat the entry before any exists/realpath/open that could follow its link.
  const target = fs.lstatSync(info.target, { throwIfNoEntry: false });
  if (!target || target.isSymbolicLink() || !target.isDirectory()) return null;
  try {
    physical(info.target);
  } catch {
    return null;
  }
  const directory = path.dirname(info.receipt);
  const folder = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!folder || folder.isSymbolicLink() || !folder.isDirectory()) return null;
  try {
    physical(directory);
  } catch {
    return null;
  }
  const stat = fs.lstatSync(info.receipt, { throwIfNoEntry: false });
  if (!stat) return null;
  const pin = stableFile(info.receipt, 65536),
    text = fs.readFileSync(info.receipt, 'utf8');
  if (hash(text) !== pin.sha256) fail('receipt changed while decoding');
  let row;
  try {
    row = JSON.parse(text);
  } catch {
    fail('malformed receipt JSON');
  }
  if (
    JSON.stringify(row) + '\n' !== text ||
    !keys(row, [
      'schema',
      'packageRoot',
      'nativeRoot',
      'target',
      'toolchain',
      'source',
      'coreTest',
    ]) ||
    row.schema !== SCHEMA ||
    row.packageRoot !== info.pkg ||
    row.nativeRoot !== info.native ||
    row.target !== info.target ||
    !keys(row.source, ['sha256', 'fileCount']) ||
    !keys(row.coreTest, ['path', 'sizeBytes', 'sha256']) ||
    !keys(row.toolchain, ['channel', 'rustc', 'cargo', 'platform', 'arch'])
  )
    fail('receipt schema/canonical identity mismatch');
  const observed = toolchainObservation(row.toolchain.rustc, row.toolchain.cargo);
  if (JSON.stringify(observed) !== JSON.stringify(row.toolchain))
    fail('receipt toolchain/platform mismatch');
  if (JSON.stringify(sourceFingerprint(packageRoot)) !== JSON.stringify(row.source))
    fail('source fingerprint changed; run npm run test:prepare');
  if (
    JSON.stringify(pinExecutable(packageRoot, row.coreTest.path)) !== JSON.stringify(row.coreTest)
  )
    fail('compiled libtest bytes changed');
  return row;
}
function preparedEnvironment(packageRoot, environment = process.env) {
  const row = readReceipt(packageRoot),
    env = { ...environment };
  if (!row) {
    if (Object.hasOwn(environment, ENV)) fail('ambient binary has no prepared receipt');
    delete env[ENV];
    return env;
  }
  if (Object.hasOwn(environment, ENV) && environment[ENV] !== row.coreTest.path)
    fail('ambient binary differs from prepared receipt');
  env[ENV] = row.coreTest.path;
  return env;
}
module.exports = {
  ENV,
  locations,
  sourceFingerprint,
  toolchainObservation,
  selectCoreTestArtifact,
  removeReceipt,
  publishReceipt,
  readReceipt,
  preparedEnvironment,
};
