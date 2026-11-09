'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sameFile = (left, right) =>
  ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(
    (key) => left[key] === right[key]
  );

function captureRegular(file, limit) {
  const before = fs.lstatSync(file, { bigint: true });
  assert(before.isFile() && before.nlink === 1n, 'Expected a single-link regular input file');
  assert(before.size >= 0n && before.size <= BigInt(limit), 'Input exceeds byte bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    assert(sameFile(before, fs.fstatSync(fd, { bigint: true })), 'Input identity changed');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      assert(read > 0, 'Input truncated during capture');
      offset += read;
    }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, offset), 0, 'Input grew during capture');
    assert(sameFile(before, fs.fstatSync(fd, { bigint: true })), 'Input changed during capture');
    assert(sameFile(before, fs.lstatSync(file, { bigint: true })), 'Input path changed');
    return { bytes, mode: Number(before.mode & 0o7777n) };
  } finally {
    fs.closeSync(fd);
  }
}

function expectedDigest(value) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Expected SHA-256 pin');
}

function realDirectory(directory, label = 'evidence') {
  assert.equal(fs.realpathSync(directory), directory, `Expected canonical ${label} directory`);
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Expected real evidence directory');
}

function createDirectories(root, relative) {
  realDirectory(root);
  if (relative === '.') return;
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    assert(part !== '.' && part !== '..', 'Invalid evidence directory component');
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    realDirectory(current);
  }
}

/** Capture the selected bytes once; npm receives the private copy, never a repack. */
function stageSelectedTarball(source, expectedSha256, outputDirectory) {
  expectedDigest(expectedSha256);
  const sourcePath = path.resolve(source);
  realDirectory(path.dirname(sourcePath), 'artifact source');
  const selected = captureRegular(sourcePath, 256 * 1024 * 1024);
  realDirectory(path.dirname(sourcePath), 'artifact source');
  assert(selected.bytes.length > 0, 'Selected tarball is empty');
  assert.equal(sha256(selected.bytes), expectedSha256, 'Selected tarball pin mismatch');
  const directory = path.resolve(outputDirectory);
  assert.equal(fs.realpathSync(directory), directory, 'Expected canonical staging directory');
  const stat = fs.lstatSync(directory);
  assert(stat.isDirectory() && (stat.mode & 0o777) === 0o700, 'Expected private staging directory');
  const file = path.join(directory, 'selected-candidate.tgz');
  fs.writeFileSync(file, selected.bytes, { flag: 'wx', mode: 0o600 });
  const staged = captureRegular(file, 256 * 1024 * 1024);
  assert.equal(staged.mode, 0o600, 'Unexpected staged tarball mode');
  assert(staged.bytes.equals(selected.bytes), 'Staged tarball changed');
  return {
    source: sourcePath,
    path: file,
    sha256: expectedSha256,
    sizeBytes: selected.bytes.length,
    integrity: 'sha512-' + crypto.createHash('sha512').update(selected.bytes).digest('base64'),
  };
}

function verifySelectedTarball(record) {
  expectedDigest(record.sha256);
  const captured = captureRegular(record.path, 256 * 1024 * 1024);
  assert.equal(captured.mode, 0o600, 'Staged tarball mode changed');
  assert.equal(captured.bytes.length, record.sizeBytes, 'Staged tarball size changed');
  assert.equal(sha256(captured.bytes), record.sha256, 'Staged tarball bytes changed');
  assert.equal(
    'sha512-' + crypto.createHash('sha512').update(captured.bytes).digest('base64'),
    record.integrity,
    'Staged tarball integrity changed'
  );
}

function verifyInstalledTarballLock(lock, consumer, selected, packageName) {
  verifySelectedTarball(selected);
  const entry = lock.packages?.[`node_modules/${packageName}`];
  assert(entry && typeof entry === 'object', 'Installed package missing from lockfile');
  assert.equal(
    entry.integrity,
    selected.integrity,
    'npm did not retain selected tarball integrity'
  );
  assert(
    typeof entry.resolved === 'string' && entry.resolved.startsWith('file:'),
    'Installed package did not resolve from the selected local tarball'
  );
  assert.equal(
    path.resolve(consumer, entry.resolved.slice(5)),
    selected.path,
    'npm resolved a different candidate artifact'
  );
}

const governanceNames = [
  'policy.yaml',
  'specs',
  'claims',
  'waivers',
  'events.jsonl',
  'worktrees.json',
  'agents.json',
];

/** Retain observed bytes and modes; source mode is metadata, raw data stays private. */
function captureGovernanceState(project, artifacts, label, forensic) {
  assert(/^[a-z][a-z0-9-]{0,79}$/.test(label), 'Invalid governance capture label');
  const source = path.join(path.resolve(project), '.caws');
  const artifactRoot = path.resolve(artifacts);
  const destination = path.join(artifactRoot, 'raw', 'governance', label);
  createDirectories(artifactRoot, path.join('raw', 'governance'));
  fs.mkdirSync(destination, { mode: 0o700 });
  const entries = [];
  const failures = [];
  let total = 0;
  const observeFailure = (file, relative, error) => {
    if (!forensic) throw error;
    const observation = { path: relative, error: error.message };
    try {
      const stat = fs.lstatSync(file, { bigint: true });
      observation.kind = stat.isSymbolicLink()
        ? 'symlink'
        : stat.isFile()
          ? 'file'
          : stat.isDirectory()
            ? 'directory'
            : 'other';
      observation.mode = Number(stat.mode & 0o7777n);
      observation.sizeBytes = stat.size.toString();
      if (stat.isSymbolicLink()) observation.link = fs.readlinkSync(file);
    } catch (captureError) {
      observation.kind = captureError.code === 'ENOENT' ? 'missing' : 'unavailable';
    }
    failures.push(observation);
  };
  const namesIn = (directory) => {
    const handle = fs.opendirSync(directory);
    const names = [];
    try {
      for (let next = handle.readSync(); next !== null; next = handle.readSync()) {
        assert(names.length < 4096, 'Governance directory count exceeds bound');
        names.push(next.name);
      }
    } finally {
      handle.closeSync();
    }
    return names.sort();
  };
  const capture = (file, relative) => {
    assert(entries.length < 4096, 'Governance entry count exceeds bound');
    const before = fs.lstatSync(file, { bigint: true });
    const mode = Number(before.mode & 0o7777n);
    if (before.isDirectory()) {
      realDirectory(file);
      const names = namesIn(file);
      entries.push({ path: relative, kind: 'directory', mode });
      for (const name of names) {
        if (entries.length >= 4096) {
          observeFailure(file, relative, new Error('Governance entry count exceeds bound'));
          break;
        }
        visit(path.join(file, name), path.join(relative, name));
      }
      assert.deepEqual(namesIn(file), names, 'Governance directory changed');
      assert(
        sameFile(before, fs.lstatSync(file, { bigint: true })),
        'Governance directory changed'
      );
    } else {
      assert.equal(fs.realpathSync(file), file, 'Governance path reached through a symlink');
      const captured = captureRegular(file, 8 * 1024 * 1024);
      total += captured.bytes.length;
      assert(total <= 32 * 1024 * 1024, 'Governance byte count exceeds bound');
      const output = path.join(destination, relative);
      createDirectories(destination, path.dirname(relative));
      fs.writeFileSync(output, captured.bytes, { flag: 'wx', mode: 0o600 });
      entries.push({
        path: relative,
        kind: 'file',
        mode: captured.mode,
        sizeBytes: captured.bytes.length,
        sha256: sha256(captured.bytes),
        raw: path.relative(path.resolve(artifacts), output),
      });
    }
  };
  const visit = (file, relative) => {
    try {
      capture(file, relative);
    } catch (error) {
      observeFailure(file, relative, error);
    }
  };
  let rootStat;
  try {
    realDirectory(source);
    rootStat = fs.lstatSync(source);
  } catch (error) {
    observeFailure(source, '.', error);
  }
  for (const name of governanceNames) {
    if (!rootStat) break;
    const file = path.join(source, name);
    try {
      fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      observeFailure(file, name, error);
      continue;
    }
    visit(file, name);
  }
  return {
    schema: 'caws.qualification.governance-capture.v1',
    root: source,
    rootMode: rootStat ? rootStat.mode & 0o7777 : null,
    complete: failures.length === 0,
    failures,
    entries,
  };
}

function captureGovernance(project, artifacts, label) {
  return captureGovernanceState(project, artifacts, label, false);
}

/** Failure evidence may be incomplete; it never satisfies preservation verification. */
function captureFailedGovernance(project, artifacts, label) {
  return captureGovernanceState(project, artifacts, label, true);
}

function verifyGovernancePreserved(before, after, artifacts) {
  assert.equal(before.schema, 'caws.qualification.governance-capture.v1');
  assert.equal(after.schema, before.schema);
  assert.equal(before.complete, true, 'Before governance capture is incomplete');
  assert.equal(after.complete, true, 'After governance capture is incomplete');
  assert.deepEqual(before.failures, []);
  assert.deepEqual(after.failures, []);
  assert.equal(after.root, before.root);
  assert.equal(after.rootMode, before.rootMode, 'Governance root mode changed');
  const root = path.resolve(artifacts);
  const compare = (snapshot) =>
    snapshot.entries.map((entry) => {
      if (entry.kind === 'directory') return entry;
      assert.equal(entry.kind, 'file');
      const file = path.resolve(root, entry.raw);
      const relative = path.relative(root, file);
      assert(
        relative &&
          !relative.startsWith('..' + path.sep) &&
          relative !== '..' &&
          !path.isAbsolute(relative),
        'Raw governance escaped evidence root'
      );
      assert.equal(fs.realpathSync(file), file, 'Raw governance reached through a symlink');
      const captured = captureRegular(file, 8 * 1024 * 1024);
      assert.equal(captured.mode, 0o600, 'Raw governance mode changed');
      assert.equal(captured.bytes.length, entry.sizeBytes, 'Raw governance size changed');
      assert.equal(sha256(captured.bytes), entry.sha256, 'Raw governance bytes changed');
      const { raw, ...observed } = entry;
      return observed;
    });
  assert.deepEqual(
    compare(after),
    compare(before),
    'Governance bytes, membership or modes changed'
  );
  return true;
}

module.exports = {
  stageSelectedTarball,
  verifySelectedTarball,
  verifyInstalledTarballLock,
  captureGovernance,
  captureFailedGovernance,
  verifyGovernancePreserved,
};
