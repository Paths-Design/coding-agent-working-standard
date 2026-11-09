'use strict';

// Private qualification instrumentation. The caller must separately pin this
// program and the exact launcher, enforce the host deadline, inspect the
// receipt, and classify the host's response. It does not grant authority.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const MAX_CAPTURE = 1024 * 1024;

function start(argv = process.argv.slice(2)) {
  const [directory, launcher, ...args] = argv;
  if (
    !directory ||
    !launcher ||
    !path.isAbsolute(directory) ||
    !path.isAbsolute(launcher) ||
    path.resolve(directory) !== directory ||
    path.resolve(launcher) !== launcher ||
    fs.realpathSync(directory) !== directory ||
    fs.realpathSync(launcher) !== launcher ||
    !fs.lstatSync(directory).isDirectory() ||
    (fs.statSync(directory).mode & 0o077) !== 0 ||
    !fs.lstatSync(launcher).isFile()
  )
    throw new Error('Invalid capture or launcher');
  const id = randomUUID(),
    streams = {},
    opened = [];
  let complete = true;
  for (const name of ['stdin', 'stdout', 'stderr']) {
    const fd = fs.openSync(
      path.join(directory, id + '.' + name),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600
    );
    opened.push(fd);
    streams[name] = { fd, totalBytes: 0, retainedBytes: 0, hash: createHash('sha256') };
  }
  const capture = (name, bytes) => {
    const stream = streams[name];
    stream.totalBytes += bytes.length;
    stream.hash.update(bytes);
    const retained = Math.min(bytes.length, MAX_CAPTURE - stream.retainedBytes);
    if (retained !== bytes.length) complete = false;
    try {
      let at = 0;
      while (at < retained) {
        const count = fs.writeSync(stream.fd, bytes, at, retained - at);
        if (count <= 0) throw new Error('Short capture');
        at += count;
        stream.retainedBytes += count;
      }
    } catch {
      complete = false;
    }
  };
  const started = Date.now();
  const child = spawn(launcher, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  let inputFinished = false,
    childFinished = false,
    exitCode = null,
    signal = null;
  child.on('error', () => {
    complete = false;
  });
  child.stdin.on('error', () => {
    complete = false;
  });
  process.stdin.on('error', () => {
    complete = false;
  });
  child.stdout.on('error', () => {
    complete = false;
  });
  child.stderr.on('error', () => {
    complete = false;
  });
  process.stdin.on('data', (bytes) => capture('stdin', bytes));
  child.stdout.on('data', (bytes) => capture('stdout', bytes));
  child.stderr.on('data', (bytes) => capture('stderr', bytes));
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  process.stdin.on('end', () => {
    inputFinished = true;
    finish();
  });
  child.on('close', (code, childSignal) => {
    childFinished = true;
    exitCode = code;
    signal = childSignal;
    finish();
  });
  function finish() {
    if (!inputFinished || !childFinished) return;
    for (const fd of opened) {
      try {
        fs.closeSync(fd);
      } catch {
        complete = false;
      }
    }
    const receipt = {
      schema: 'caws.native-qualification.hook-tap.v1',
      id,
      startedAtMs: started,
      finishedAtMs: Date.now(),
      launcher,
      args,
      exitCode,
      signal,
      complete,
      streams: {},
    };
    for (const [name, stream] of Object.entries(streams))
      receipt.streams[name] = {
        totalBytes: stream.totalBytes,
        retainedBytes: stream.retainedBytes,
        sha256: stream.hash.digest('hex'),
      };
    try {
      fs.writeFileSync(path.join(directory, id + '.json'), JSON.stringify(receipt) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    } catch {
      process.exitCode = 1;
      return;
    }
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
  }
}

if (require.main === module) {
  try {
    start();
  } catch {
    process.exitCode = 1;
  }
}
module.exports = { start };
