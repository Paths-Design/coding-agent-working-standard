#!/usr/bin/env node
// Remove the staged package-local docs/ tree (CAWS-DOCS-SHIP-CONSUMER-SET-001).
//
// The consumer docs live at the repo root (<repo>/docs); npm's `files` field
// cannot reference paths outside the package, so stage-consumer-docs.mjs copies
// the audience:consumer set into packages/caws-cli/docs/ as a transport
// artifact. This script deletes that staged tree.
// It also stages and cleans the three source-license transports, recording
// ownership outside shipped paths so cleanup preserves preexisting files and
// refuses changed or uncertain records. Staging never deletes, so it relinquishes
// such a record (moving it aside intact) instead of failing the build.
//
// Invoked at the START of prepack (beginning-clean is the real safety
// invariant — postpack can be skipped by an interrupted publish, so the next
// prepack must not inherit stale staged docs) and again at postpack as cleanup.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(__dirname, '..');
const STAGED_DOCS = path.join(PKG_ROOT, 'docs');

// These are transport files, never additional license authorities. Identity
// checks cover synchronous observations, not an actively racing external rename
// between inspection and unlink (Node has no compare-identity-and-unlink API).
const LICENSES = Object.freeze([
  { name: 'LICENSE', source: '../../LICENSE' },
  {
    name: 'dist/transcripts/unicode14/LICENSE.txt',
    source: 'src/transcripts/unicode14/LICENSE.txt',
  },
  { name: 'dist/transcripts/html311/LICENSE.txt', source: 'src/transcripts/html311/LICENSE.txt' },
]);
const MARKER = '.license-transport.json';
const LOCK = '.license-transport.lock';
// No extension: mutation input identity counts package-root *.json as authored.
const RELINQUISHED = '.license-transport.relinquished-';
const ID_FIELDS = ['dev', 'ino', 'birthtimeNs', 'ctimeNs', 'mtimeNs', 'size', 'mode', 'nlink'];
const STABLE_FIELDS = ['dev', 'ino', 'birthtimeNs', 'mode', 'nlink'];
const REMEDY =
  'cleanup deletes only files it can prove it created; run `node scripts/stage-consumer-docs.mjs` ' +
  '(every build does) to relinquish this record: that deletes no license, leaves existing ones ' +
  `unowned, and moves the record aside as ${RELINQUISHED}<uuid>`;
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const identity = (stat, fields = ID_FIELDS) =>
  Object.fromEntries(fields.map((key) => [key, String(stat[key])]));
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (message) => {
  throw new Error(`License transport: ${message}`);
};

/** A stored record that cannot establish ownership: staging relinquishes it and
 * cleanup refuses it. In-run races, symlinks and nonregular files use fail(). */
class CustodyError extends Error {}
const custody = (message) => {
  throw new CustodyError(`License transport: ${message}`);
};

// Device numbers are not durable: APFS and other filesystems assign st_dev at
// mount, so a reboot renumbers files that did not change. A record from an
// earlier run is matched on every recorded field except dev, and the device is
// checked relationally instead: the object must be on the package root's
// filesystem now, which still scopes its inode number to one filesystem.
// Observations within one run keep comparing dev exactly.
const deviceOf = (root) => String(fs.lstatSync(root, { bigint: true }).dev);
function durableMismatch(recorded, observed, device) {
  const differing = Object.keys(recorded).filter(
    (key) => key !== 'dev' && recorded[key] !== observed[key]
  );
  if (observed.dev !== device) differing.push('device');
  return differing;
}

function raise(errors, label) {
  const present = errors.filter(Boolean);
  if (present.length === 1) throw present[0];
  if (present.length > 1)
    throw new AggregateError(
      present,
      `${label}: ${present.map((error) => error.message).join(' | ')}`
    );
}

function closeAfter(fd, body) {
  let result, primary, closing;
  try {
    result = body();
  } catch (error) {
    primary = error;
  }
  try {
    fs.closeSync(fd);
  } catch (error) {
    closing = error;
  }
  raise([primary, closing], 'License transport operation and descriptor close failed');
  return result;
}

function closeFailed(fd, primary) {
  let closing;
  try {
    fs.closeSync(fd);
  } catch (error) {
    closing = error;
  }
  raise([primary, closing], 'License transport record and descriptor close failed');
}

/** Check every ancestor, including ancestors of a caller-supplied package root. */
function parents(file, create = false) {
  const parsed = path.parse(file);
  let current = parsed.root;
  for (const part of path.dirname(file).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      fs.mkdirSync(current);
      stat = fs.lstatSync(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(`non-directory or symlink ancestor: ${current}`);
  }
  return true;
}

function regular(file, optional = false) {
  if (!parents(file)) {
    if (optional) return null;
    fail(`missing ancestor: ${file}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`nonregular file or symlink: ${file}`);
  return stat;
}

function read(file, optional = false) {
  const observed = regular(file, optional);
  if (!observed) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  return closeAfter(fd, () => {
    const before = identity(fs.fstatSync(fd, { bigint: true }));
    if (!same(before, identity(observed))) fail(`file changed while opening: ${file}`);
    const bytes = fs.readFileSync(fd);
    if (
      !same(before, identity(fs.fstatSync(fd, { bigint: true }))) ||
      !same(before, identity(regular(file)))
    )
      fail(`file changed while reading: ${file}`);
    return { bytes, identity: before };
  });
}

function current(handle, checkpoint) {
  const observed = read(handle.file);
  // Keep the custody predicates and their short-circuit observation order. In
  // particular, a changed path must not cause an additional held-FD observation.
  let failedPredicate;
  let heldFdIdentity = 'not_observed';
  if (!same(observed.identity, handle.identity)) failedPredicate = 'path_identity';
  else if (!observed.bytes.equals(handle.bytes)) failedPredicate = 'path_bytes';
  else {
    heldFdIdentity = identity(fs.fstatSync(handle.fd, { bigint: true }));
    if (!same(heldFdIdentity, handle.identity)) failedPredicate = 'held_fd_identity';
  }
  if (failedPredicate)
    fail(
      `owned record replaced or changed: ${handle.file}; custody=${JSON.stringify({
        schema: 'caws.license-transport.refusal.v1',
        checkpoint,
        failedPredicate,
        expected: { identity: handle.identity, sha256: hash(handle.bytes) },
        observed: { identity: observed.identity, sha256: hash(observed.bytes) },
        heldFdIdentity,
      })}`
    );
}

function withLock(packageRoot, body) {
  const root = path.resolve(packageRoot);
  const file = path.join(root, LOCK);
  if (!parents(file)) fail(`package root is absent: ${root}`);
  if (regular(file, true)) fail(`operation lock exists; ownership is uncertain: ${file}`);
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  return closeAfter(fd, () => {
    const bytes = Buffer.from(JSON.stringify({ schema: 1, operation: randomUUID() }) + '\n');
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    const lock = { file, fd, bytes, identity: identity(fs.fstatSync(fd, { bigint: true })) };
    let result, primary;
    try {
      result = body(root);
    } catch (error) {
      primary = error;
    }
    let cleanup;
    try {
      current(lock, 'lock_cleanup');
      fs.unlinkSync(file);
    } catch (error) {
      cleanup = error;
    }
    raise([primary, cleanup], 'License transport operation and lock cleanup failed');
    return result;
  });
}

function validIdentity(value, fields) {
  return (
    value &&
    typeof value === 'object' &&
    same(Object.keys(value).sort(), [...fields].sort()) &&
    fields.every((key) => typeof value[key] === 'string' && /^\d+$/.test(value[key]))
  );
}

function markerRecord(bytes) {
  if (bytes.length > 16384) custody('ownership marker exceeds its finite profile');
  let data;
  try {
    data = JSON.parse(bytes.toString('utf8'));
  } catch {
    custody('ownership marker is not complete JSON');
  }
  if (
    !data ||
    data.schema !== 1 ||
    !['staging', 'ready', 'cleaning'].includes(data.phase) ||
    !Array.isArray(data.entries) ||
    data.entries.length > LICENSES.length ||
    !validIdentity(data.markerIdentity, STABLE_FIELDS)
  )
    custody('ownership marker schema is invalid');
  const names = new Set();
  for (const entry of data.entries) {
    if (
      !entry ||
      !LICENSES.some((item) => item.name === entry.name) ||
      names.has(entry.name) ||
      !['planned', 'owned'].includes(entry.status) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      (entry.status === 'owned' && !validIdentity(entry.identity, ID_FIELDS)) ||
      (entry.status === 'planned' && entry.identity !== undefined)
    )
      custody('ownership marker entry is invalid');
    names.add(entry.name);
  }
  if (data.phase !== 'ready' || data.entries.some((entry) => entry.status !== 'owned'))
    custody('ownership marker is interrupted; ownership is uncertain');
  return data;
}

function markerData(bytes, stat, device) {
  const data = markerRecord(bytes);
  const differing = durableMismatch(data.markerIdentity, identity(stat, STABLE_FIELDS), device);
  if (differing.length)
    custody(
      `ownership marker identity mismatch (${differing.join(', ')}); it is not the record it describes`
    );
  return data;
}

function openMarker(root, device) {
  const file = path.join(root, MARKER);
  const observed = read(file, true);
  if (!observed) return null;
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const handle = { file, fd, ...observed, data: markerData(observed.bytes, stat, device) };
    current(handle, 'marker_open');
    return handle;
  } catch (error) {
    closeFailed(fd, error);
  }
}

function writeMarker(handle) {
  current(handle, 'before_write');
  const bytes = Buffer.from(JSON.stringify(handle.data) + '\n');
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(handle.fd, bytes, offset, bytes.length - offset, offset);
    if (!count) fail('ownership marker write made no progress');
    offset += count;
  }
  fs.ftruncateSync(handle.fd, bytes.length);
  fs.fsyncSync(handle.fd);
  handle.bytes = bytes;
  handle.identity = identity(fs.fstatSync(handle.fd, { bigint: true }));
  current(handle, 'after_write');
}

function createMarker(root) {
  const file = path.join(root, MARKER);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const handle = {
      file,
      fd,
      bytes: Buffer.alloc(0),
      identity: identity(stat),
      data: {
        schema: 1,
        phase: 'staging',
        markerIdentity: identity(stat, STABLE_FIELDS),
        entries: [],
      },
    };
    writeMarker(handle);
    return handle;
  } catch (error) {
    closeFailed(fd, error);
  }
}

function owned(root, entry, device) {
  const observed = read(path.join(root, entry.name), true);
  // A build can remove dist. Absence permits dropping a record, never deletion
  // or adoption of a newly present file, even one with identical bytes.
  if (!observed) return null;
  const differing = durableMismatch(entry.identity, observed.identity, device);
  if (hash(observed.bytes) !== entry.sha256) differing.push('sha256');
  if (differing.length)
    custody(`owned license replaced or changed (${differing.join(', ')}): ${entry.name}`);
  return observed;
}

/** Move an unverifiable record aside intact. The rename keeps its inode and bytes,
 * so nothing is deleted; the record only stops granting deletion authority. */
function relinquishMarker(root, cause) {
  const file = path.join(root, MARKER);
  const observed = read(file);
  const retainedAt = `${RELINQUISHED}${randomUUID()}`;
  const retained = path.join(root, retainedAt);
  if (regular(retained, true)) fail(`relinquished record name already exists: ${retained}`);
  fs.renameSync(file, retained);
  const moved = read(retained);
  if (
    moved.identity.dev !== observed.identity.dev ||
    moved.identity.ino !== observed.identity.ino ||
    !moved.bytes.equals(observed.bytes)
  )
    fail(
      `ownership marker changed while being relinquished; every record is kept, inspect ${retained}`
    );
  const record = {
    reason: cause.message.replace(/^License transport: /, ''),
    sha256: hash(observed.bytes),
    retainedAt,
  };
  process.stderr.write(
    `license transport: relinquished an unverifiable ownership record (${record.reason}); ` +
      `no license file was deleted and existing ones are now unowned; the original record is ` +
      `kept at ${retainedAt} (sha256 ${record.sha256})\n`
  );
  return record;
}

export function stageLicenseTransport(packageRoot = PKG_ROOT) {
  return withLock(packageRoot, (root) => {
    const sources = LICENSES.map((item) => ({
      ...item,
      observed: read(path.resolve(root, item.source)),
    }));
    const device = deviceOf(root);
    // Survey destinations first so a conflict refuses before any record moves.
    const missing = [];
    const preserved = [];
    for (const source of sources) {
      const destination = read(path.join(root, source.name), true);
      if (!destination) missing.push(source);
      else if (!destination.bytes.equals(source.observed.bytes))
        fail(`conflicting destination: ${source.name}`);
      else preserved.push(source.name);
    }
    let marker = null;
    let relinquished;
    try {
      marker = openMarker(root, device);
      for (const entry of marker?.data.entries ?? []) owned(root, entry, device);
    } catch (error) {
      let closing;
      if (marker) {
        try {
          fs.closeSync(marker.fd);
        } catch (closeError) {
          closing = closeError;
        }
        marker = null;
      }
      if (!(error instanceof CustodyError) || closing)
        raise([error, closing], 'License staging and ownership descriptor close failed');
      relinquished = relinquishMarker(root, error);
    }
    const result = (body) => (relinquished ? { ...body, relinquished } : body);
    let failure;
    try {
      if (!missing.length) return result({ created: [], preserved });
      if (!marker) marker = createMarker(root);
      else {
        marker.data.phase = 'staging';
        marker.data.entries = marker.data.entries.filter((entry) => owned(root, entry, device));
        writeMarker(marker);
      }
      const created = [];
      for (const source of missing) {
        const entry = { name: source.name, status: 'planned', sha256: hash(source.observed.bytes) };
        marker.data.entries.push(entry);
        writeMarker(marker);
        const destination = path.join(root, source.name);
        parents(destination, true);
        const fd = fs.openSync(
          destination,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o644
        );
        let afterWrite;
        closeAfter(fd, () => {
          fs.writeFileSync(fd, source.observed.bytes);
          fs.fsyncSync(fd);
          afterWrite = identity(fs.fstatSync(fd, { bigint: true }));
        });
        const retained = read(destination);
        if (!same(retained.identity, afterWrite) || !retained.bytes.equals(source.observed.bytes))
          fail(`license changed after creation: ${source.name}`);
        entry.status = 'owned';
        entry.identity = afterWrite;
        created.push(source.name);
        writeMarker(marker);
      }
      marker.data.phase = 'ready';
      writeMarker(marker);
      return result({ created, preserved });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (marker) {
        try {
          fs.closeSync(marker.fd);
        } catch (closing) {
          raise([failure, closing], 'License staging and ownership descriptor close failed');
        }
      }
    }
  });
}

export function cleanLicenseTransport(packageRoot = PKG_ROOT) {
  return withLock(packageRoot, (root) => {
    try {
      return cleanOwned(root);
    } catch (error) {
      if (error instanceof CustodyError)
        throw new CustodyError(`${error.message}; ${REMEDY}`, { cause: error });
      throw error;
    }
  });
}

function cleanOwned(root) {
  // Refuse symlinks and nonregular leaves even when no marker owns them.
  for (const item of LICENSES) regular(path.join(root, item.name), true);
  const device = deviceOf(root);
  const marker = openMarker(root, device);
  if (!marker) return { removed: [] };
  let failure;
  try {
    for (const entry of marker.data.entries) owned(root, entry, device);
    marker.data.phase = 'cleaning';
    writeMarker(marker);
    const removed = [];
    for (const entry of [...marker.data.entries]) {
      if (owned(root, entry, device)) {
        fs.unlinkSync(path.join(root, entry.name));
        removed.push(entry.name);
      }
      marker.data.entries = marker.data.entries.filter((item) => item.name !== entry.name);
      writeMarker(marker);
    }
    current(marker, 'before_retire');
    fs.unlinkSync(marker.file);
    return { removed };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      fs.closeSync(marker.fd);
    } catch (closing) {
      raise([failure, closing], 'License cleanup and ownership descriptor close failed');
    }
  }
}

function syncDirectory(directory) {
  parents(path.join(directory, '.identity-check'));
  const stat = fs.lstatSync(directory, { bigint: true });
  const before = identity(stat);
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  closeAfter(fd, () => {
    if (!stat.isDirectory() || !same(before, identity(fs.fstatSync(fd, { bigint: true }))))
      fail(`retention directory changed while opening: ${directory}`);
    fs.fsyncSync(fd);
    if (
      !same(before, identity(fs.fstatSync(fd, { bigint: true }))) ||
      !same(before, identity(fs.lstatSync(directory, { bigint: true })))
    )
      fail(`retention directory changed while syncing: ${directory}`);
  });
}

/** Relinquishment only: retained bytes never authorize deletion of license leaves.
 * Retires the exact reviewed, verified ready marker into evidence outside the
 * package. Staging relinquishes unverifiable records by itself; this explicit path
 * is for deliberately abandoning ownership. Inode/birthtime/mode/link identity and
 * current fd/path checks still exclude same-byte foreign marker replacement.
 */
export function recoverLicenseTransport(
  expectedSha256,
  retentionDestination,
  packageRoot = PKG_ROOT
) {
  if (typeof expectedSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedSha256))
    fail('recovery requires an exact lowercase SHA-256');
  if (
    typeof retentionDestination !== 'string' ||
    !path.isAbsolute(retentionDestination) ||
    typeof packageRoot !== 'string' ||
    !path.isAbsolute(packageRoot)
  )
    fail('recovery requires absolute package and retention paths');
  const retention = path.resolve(retentionDestination);
  let retirementAttempted = false;
  try {
    return withLock(packageRoot, (root) => {
      const relative = path.relative(root, retention);
      if (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative) &&
          relative !== '..') ||
        LICENSES.some((item) => path.resolve(root, item.source) === retention)
      )
        fail('recovery retention must be outside the package and its license sources');
      if (!parents(retention)) fail('recovery retention parent is absent');
      if (regular(retention, true)) fail('recovery retention already exists');
      for (const item of LICENSES) regular(path.join(root, item.name), true);
      const file = path.join(root, MARKER);
      const observed = read(file);
      if (hash(observed.bytes) !== expectedSha256) fail('recovery marker SHA-256 mismatch');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      return closeAfter(fd, () => {
        const marker = { file, fd, ...observed };
        current(marker, 'marker_open');
        const data = markerRecord(observed.bytes);
        // Recovery abandons all old deletion authority instead of rebinding it, so
        // it compares the durable fields only and needs no device relation.
        const preservedFields = STABLE_FIELDS.filter((key) => key !== 'dev');
        if (
          !same(
            Object.fromEntries(preservedFields.map((key) => [key, data.markerIdentity[key]])),
            identity(fs.fstatSync(fd, { bigint: true }), preservedFields)
          )
        )
          fail('recovery marker was replaced or its identity changed');
        const retainedFd = fs.openSync(
          retention,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600
        );
        let retainedIdentity;
        closeAfter(retainedFd, () => {
          fs.writeFileSync(retainedFd, observed.bytes);
          fs.fsyncSync(retainedFd);
          retainedIdentity = identity(fs.fstatSync(retainedFd, { bigint: true }));
        });
        const verifyRetention = () => {
          const retained = read(retention);
          if (!same(retained.identity, retainedIdentity) || !retained.bytes.equals(observed.bytes))
            fail('recovery retained evidence was replaced or changed');
        };
        verifyRetention();
        syncDirectory(path.dirname(retention));
        verifyRetention();
        current(marker, 'before_retire');
        retirementAttempted = true;
        fs.unlinkSync(file);
        syncDirectory(root);
        return {
          retired: MARKER,
          sha256: expectedSha256,
          retainedAt: retention,
          markerIdentity: observed.identity,
          retainedIdentity,
          licenses: 'preserved-unowned',
        };
      });
    });
  } catch (error) {
    if (retirementAttempted)
      throw new Error(
        `License transport: recovery marker retirement attempted; completion uncertain; inspect ${retention}: ${error.message}`,
        { cause: error }
      );
    throw error;
  }
}

const USAGE = `Usage:
  node clean-staged-docs.mjs
  node clean-staged-docs.mjs --recover-license-ownership --expected-sha256 HEX --retain-original ABSOLUTE_FILE --package-root ABSOLUTE_DIRECTORY

Recovery requires a reviewed SHA-256 and a fresh evidence file outside the package.
Its parent must exist without symlinks. Original marker bytes are fsynced before
only that marker is retired; license leaves and staged docs remain untouched.
Retained evidence grants no cleanup authority. An error after retirement reports
uncertainty; inspect the marker and retained evidence before any subsequent action.
`;

function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (
    args.length === 7 &&
    args[0] === '--recover-license-ownership' &&
    args[1] === '--expected-sha256' &&
    args[3] === '--retain-original' &&
    args[5] === '--package-root'
  ) {
    process.stdout.write(JSON.stringify(recoverLicenseTransport(args[2], args[4], args[6])) + '\n');
    return 0;
  }
  if (args.length) fail(USAGE);
  cleanLicenseTransport();
  if (fs.existsSync(STAGED_DOCS)) {
    fs.rmSync(STAGED_DOCS, { recursive: true, force: true });
    process.stderr.write(`cleaned staged docs at ${path.relative(PKG_ROOT, STAGED_DOCS)}/\n`);
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    process.stderr.write(`clean-staged-docs: ${err.stack || err.message}\n`);
    process.exit(2);
  }
}
