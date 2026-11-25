'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 160 * 1024 * 1024;
const sourceKeys = ['dev', 'ino', 'uid', 'gid', 'nlink', 'size', 'mtimeMs'];
const sameSource = (a, b) => sourceKeys.every((key) => a[key] === b[key]);
const sameStat = (a, b) =>
  sameSource(a, b) && a.mode === b.mode && a.ctimeMs === b.ctimeMs;

function prepareCiTestInterpreter({ io = fs, runtime = process } = {}) {
  const insist = (condition, message) => {
    if (!condition) throw new Error('CI interpreter preparation: ' + message);
  };
  const physical = (value, label) => {
    insist(
      typeof value === 'string' &&
        path.isAbsolute(value) &&
        path.normalize(value) === value,
      label + ' must be an absolute canonical path'
    );
    insist(io.realpathSync.native(value) === value, label + ' must be physical');
    return value;
  };

  insist(
    runtime.platform !== 'win32' && typeof runtime.geteuid === 'function',
    'requires POSIX ownership'
  );
  const uid = runtime.geteuid();
  insist(Number.isSafeInteger(uid), 'missing effective UID');

  const cache = physical(runtime.env.RUNNER_TOOL_CACHE, 'RUNNER_TOOL_CACHE');
  insist(io.lstatSync(cache).isDirectory(), 'tool cache must be a directory');

  // The CLI supplies no executable-path override.
  const executable = physical(runtime.execPath, 'running interpreter');
  const relative = path.relative(cache, executable);
  insist(
    relative !== '' &&
      !path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep),
    'running interpreter must be inside RUNNER_TOOL_CACHE'
  );

  const before = io.lstatSync(executable);
  insist(before.isFile(), 'interpreter must be a regular file');
  insist(before.uid === uid, 'interpreter must belong to the effective UID');
  insist(before.nlink === 1, 'interpreter must have one link');
  insist(
    before.size > 0 && before.size <= MAX_BYTES,
    'interpreter exceeds its size bound'
  );
  insist((before.mode & 0o111) !== 0, 'interpreter must be executable');
  insist((before.mode & 0o7000) === 0, 'special permission bits are unsupported');

  const fd = io.openSync(
    executable,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  const digest = () => {
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let position = 0;
    for (;;) {
      const count = io.readSync(fd, buffer, 0, buffer.length, position);
      if (count === 0) return hash.digest('hex');
      position += count;
      insist(position <= MAX_BYTES, 'interpreter grew beyond its size bound');
      hash.update(buffer.subarray(0, count));
    }
  };

  try {
    insist(sameStat(before, io.fstatSync(fd)), 'interpreter changed while opening');
    const sha256 = digest();

    // Recheck the pathname before changing the already-open, owned inode.
    physical(cache, 'RUNNER_TOOL_CACHE');
    physical(executable, 'running interpreter');
    insist(
      sameStat(before, io.fstatSync(fd)) &&
        sameStat(before, io.lstatSync(executable)),
      'interpreter changed before chmod'
    );

    if ((before.mode & 0o7777) !== 0o755) io.fchmodSync(fd, 0o755);

    const after = io.fstatSync(fd);
    insist(
      after.isFile() &&
        sameSource(before, after) &&
        (after.mode & 0o7777) === 0o755,
      'chmod did not preserve the interpreter identity and exact mode'
    );
    insist(digest() === sha256, 'interpreter content changed');
    physical(cache, 'RUNNER_TOOL_CACHE');
    physical(executable, 'running interpreter');
    insist(
      sameStat(after, io.fstatSync(fd)) &&
        sameStat(after, io.lstatSync(executable)),
      'interpreter path or metadata changed after chmod'
    );

    return {
      schema: 'caws.ci.interpreter-preparation.v1',
      candidate: runtime.env.GITHUB_SHA || null,
      executable,
      toolCache: cache,
      dev: after.dev,
      ino: after.ino,
      uid: after.uid,
      nlink: after.nlink,
      sizeBytes: after.size,
      sha256,
      beforeMode: before.mode & 0o7777,
      afterMode: after.mode & 0o7777,
    };
  } finally {
    io.closeSync(fd);
  }
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('No path arguments accepted');
    process.stdout.write(JSON.stringify(prepareCiTestInterpreter(), null, 2) + '\n');
  } catch (error) {
    process.stderr.write(String(error.message) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { prepareCiTestInterpreter };
