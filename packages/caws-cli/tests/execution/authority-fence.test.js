'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawnCoveredSync, spawnCovered } = require('./child-coverage.cjs');
const { setTimeout, clearTimeout } = require('node:timers');
const {
  acquireLifecycleLock,
  releaseLifecycleLock,
  withLifecycleLock,
} = require('../../dist/store/lifecycle-lock');
const modulePath = path.resolve(__dirname, '../../dist/store/lifecycle-lock');
const retryClock = require('../../dist/store/repo-root');
const roots = [];
const children = [];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-authority-fence-'));
  roots.push(dir);
  return dir;
}

function acquire(dir, options = {}) {
  return acquireLifecycleLock(dir, {
    maxAttempts: 3,
    retryDelayMs: 0,
    staleThresholdMs: 0,
    ...options,
  });
}

function agedDeadLock(dir) {
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { timeout: 5000 });
  expect(dead.status).toBe(0);
  expect(dead.pid).toBeGreaterThan(0);
  expect(() => process.kill(dead.pid, 0)).toThrow();
  const file = path.join(dir, 'state.lock');
  fs.writeFileSync(file, JSON.stringify({ pid: dead.pid }));
  fs.utimesSync(file, new Date(0), new Date(0));
  return file;
}

function childResult(dir) {
  const result = spawnCoveredSync(
    process.execPath,
    [
      '-e',
      `
    const m = require(process.argv[1]);
    const r = m.acquireLifecycleLock(process.argv[2], {
      maxAttempts: 3, retryDelayMs: 0, staleThresholdMs: 0
    });
    process.stdout.write(JSON.stringify(r.ok ? { ok: true } : r));
    if (r.ok) m.releaseLifecycleLock(r.value);
  `,
      modulePath,
      dir,
    ],
    { encoding: 'utf8', timeout: 5000 }
  );
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function nextMessage(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out awaiting child message ${type}`));
    }, 10000);
    const onMessage = (message) => {
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Child exited ${code} before ${type}`));
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once('exit', resolve);
          child.kill('SIGKILL');
        })
    )
  );
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('an aged live holder is not stolen by another process', () => {
  const dir = fixture();
  const holder = acquire(dir);
  expect(holder.ok).toBe(true);
  const file = path.join(dir, 'state.lock');
  fs.utimesSync(file, new Date(0), new Date(0));
  const before = fs.readFileSync(file, 'utf8');
  try {
    expect(acquire(dir).ok).toBe(false);
    const refused = childResult(dir);
    expect(refused.ok).toBe(false);
    expect(refused.errors[0].rule).toBe('store.lifecycle.lock_contention');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  } finally {
    releaseLifecycleLock(holder.value);
  }
  expect(childResult(dir)).toEqual({ ok: true });
});

test('dead aged holders recover while malformed and unknown owners fail closed', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const deadPid = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
  expect(() => process.kill(-deadPid, 0)).toThrow();
  const recovered = acquire(dir);
  expect(recovered.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
  releaseLifecycleLock(recovered.value);
  for (const bytes of [
    'not JSON',
    '{}',
    '{"pid":0}',
    '{"pid":"123"}',
    JSON.stringify({ pid: -deadPid }),
  ]) {
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(acquire(dir).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    fs.unlinkSync(file);
  }
});

test('the recovery age boundary is inclusive and defaults to thirty seconds', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  fs.utimesSync(file, new Date(1000), new Date(1000));
  const now = jest.spyOn(Date, 'now').mockReturnValue(31000);
  try {
    expect(acquireLifecycleLock(dir, { retryDelayMs: 0 }).ok).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    now.mockReturnValue(31001);
    const acquired = acquireLifecycleLock(dir, { retryDelayMs: 0 });
    expect(acquired.ok).toBe(true);
    releaseLifecycleLock(acquired.value);
  } finally {
    now.mockRestore();
  }
});

test('valid metadata exactly at the byte bound still recovers', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').padEnd(4096, ' '));
  fs.utimesSync(file, new Date(0), new Date(0));
  const acquired = acquire(dir);
  expect(acquired.ok).toBe(true);
  releaseLifecycleLock(acquired.value);
});

test('a dead owner is protected until the minimum recovery age', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  fs.utimesSync(file, new Date(), new Date());
  const before = fs.readFileSync(file, 'utf8');
  expect(acquire(dir, { staleThresholdMs: 60000 }).ok).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  fs.utimesSync(file, new Date(0), new Date(0));
  const recovered = acquire(dir, { staleThresholdMs: 60000 });
  expect(recovered.ok).toBe(true);
  releaseLifecycleLock(recovered.value);
});

test.each(['EPERM', undefined])('unobservable process liveness fails closed (%s)', (code) => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const before = fs.readFileSync(file, 'utf8');
  const spy = jest.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('Process liveness unavailable'), code ? { code } : {});
  });
  try {
    expect(acquire(dir).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(`${file}.reclaim`)).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

test.each(['writeFileSync', 'fsyncSync'])(
  '%s failure cleans only its own acquisition',
  (method) => {
    const dir = fixture();
    const file = path.join(dir, 'state.lock');
    let failedFd;
    const original = fs[method];
    const spy = jest.spyOn(fs, method).mockImplementation((fd, ...args) => {
      if (typeof fd !== 'number') return original(fd, ...args);
      failedFd = fd;
      throw Object.assign(new Error('Injected lock metadata I/O failure'), { code: 'EIO' });
    });
    try {
      const result = acquire(dir);
      expect(result.ok).toBe(false);
      expect(result.errors[0].data.code).toBe('EIO');
      expect(result.errors[0].message).toContain('Unexpected error acquiring lifecycle lock');
      expect(result.errors[0].message).toContain('Injected lock metadata I/O failure');
      expect(result.errors[0].subject).toBe(file);
      expect(Number.isInteger(failedFd)).toBe(true);
      expect(() => fs.fstatSync(failedFd)).toThrow();
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      spy.mockRestore();
    }
    const next = acquire(dir);
    expect(next.ok).toBe(true);
    releaseLifecycleLock(next.value);
  }
);

test('oversized metadata cannot enter dead-owner recovery', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const bytes = fs.readFileSync(file, 'utf8') + ' '.repeat(8192);
  fs.writeFileSync(file, bytes);
  fs.utimesSync(file, new Date(0), new Date(0));
  expect(acquire(dir).ok).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
});

test('non-regular lock paths fail closed without blocking recovery', () => {
  const dir = fixture();
  const file = path.join(dir, 'state.lock');
  const made = spawnSync('/usr/bin/mkfifo', [file], { timeout: 5000 });
  expect(made.status).toBe(0);
  fs.utimesSync(file, new Date(0), new Date(0));
  const attempt = spawnCoveredSync(
    process.execPath,
    [
      '-e',
      `
    const m = require(process.argv[1]);
    process.stdout.write(JSON.stringify(m.acquireLifecycleLock(process.argv[2], {
      maxAttempts: 2, retryDelayMs: 0, staleThresholdMs: 0
    })));
  `,
      modulePath,
      dir,
    ],
    { encoding: 'utf8', timeout: 1500, killSignal: 'SIGKILL' }
  );
  expect(attempt.status).toBe(0);
  expect(JSON.parse(attempt.stdout).ok).toBe(false);
  expect(fs.lstatSync(file).isFIFO()).toBe(true);
  expect(fs.existsSync(`${file}.reclaim`)).toBe(false);
});

test('the default contention policy makes three attempts with delays only between them', () => {
  const dir = fixture();
  const holder = acquire(dir);
  expect(holder.ok).toBe(true);
  const file = path.join(dir, 'state.lock');
  const open = fs.openSync;
  const opened = [];
  let attempts = 0;
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
    if (target === file && flags === 'wx') attempts++;
    const fd = open(target, flags, ...args);
    opened.push(fd);
    return fd;
  });
  const sleep = jest.spyOn(retryClock, 'sleepSyncMs').mockImplementation(() => {});
  try {
    const result = acquireLifecycleLock(dir);
    expect(result.ok).toBe(false);
    expect(result.errors[0].subject).toBe(file);
    expect(result.errors[0].message).toContain('after 3 attempts');
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[50], [50]]);
    expect(opened.length).toBeGreaterThan(0);
    for (const fd of opened) expect(() => fs.fstatSync(fd)).toThrow();
    expect(fs.fstatSync(holder.value.fd).isFile()).toBe(true);
  } finally {
    sleep.mockRestore();
    spy.mockRestore();
    releaseLifecycleLock(holder.value);
  }
});

test('an already released handle cannot close a new descriptor for its old inode', () => {
  const dir = fixture();
  const first = acquire(dir);
  expect(first.ok).toBe(true);
  const alias = path.join(dir, 'retained-inode');
  fs.linkSync(path.join(dir, 'state.lock'), alias);
  releaseLifecycleLock(first.value);
  const reused = fs.openSync(alias, 'r');
  try {
    expect(reused).toBe(first.value.fd);
    releaseLifecycleLock(first.value);
    expect(fs.fstatSync(reused).isFile()).toBe(true);
  } finally {
    fs.closeSync(reused);
  }
});

test('a descriptor reused before release cannot authorize deleting the held pathname', () => {
  const dir = fixture();
  const held = acquire(dir);
  expect(held.ok).toBe(true);
  const other = path.join(dir, 'unrelated-file');
  fs.writeFileSync(other, 'unrelated');
  fs.closeSync(held.value.fd);
  const reused = fs.openSync(other, 'r');
  try {
    expect(reused).toBe(held.value.fd);
    releaseLifecycleLock(held.value);
    expect(fs.fstatSync(reused).isFile()).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(true);
  } finally {
    fs.closeSync(reused);
  }
});

test('an unavailable acquisition descriptor does not authorize unlinking its pathname', () => {
  const dir = fixture();
  const held = acquire(dir);
  expect(held.ok).toBe(true);
  fs.closeSync(held.value.fd);
  releaseLifecycleLock(held.value);
  expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(true);
});

test('inode equality on another device cannot authorize release', () => {
  const dir = fixture();
  const held = acquire(dir);
  expect(held.ok).toBe(true);
  const fstat = fs.fstatSync;
  const spy = jest.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
    const value = fstat(fd, options);
    return fd === held.value.fd ? { ...value, dev: value.dev + 1n } : value;
  });
  try {
    releaseLifecycleLock(held.value);
  } finally {
    spy.mockRestore();
  }
  expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(true);
  expect(fs.fstatSync(held.value.fd).isFile()).toBe(true);
  fs.closeSync(held.value.fd);
});

test('a replacement observed during recovery is retained with its live ownership', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const replacement = JSON.stringify({ pid: process.pid, purpose: 'replacement-live' });
  const open = fs.openSync;
  let replaced = false;
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
    const fd = open(target, flags, ...args);
    if (!replaced && target === file && (flags === 'r' || typeof flags === 'number')) {
      replaced = true;
      fs.unlinkSync(file);
      fs.writeFileSync(file, replacement);
    }
    return fd;
  });
  try {
    expect(acquire(dir).ok).toBe(false);
    expect(replaced).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(replacement);
  } finally {
    spy.mockRestore();
  }
});

test('a released path retries immediately while malformed ownership keeps the retry delay', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const open = fs.openSync;
  let released = false;
  const spy = jest.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
    if (!released && target === file && (flags === 'r' || typeof flags === 'number')) {
      released = true;
      fs.unlinkSync(file);
      throw Object.assign(new Error('Released during observation'), { code: 'ENOENT' });
    }
    return open(target, flags, ...args);
  });
  const sleep = jest.spyOn(retryClock, 'sleepSyncMs').mockImplementation(() => {});
  try {
    const acquired = acquireLifecycleLock(dir);
    expect(acquired.ok).toBe(true);
    expect(released).toBe(true);
    expect(sleep.mock.calls).toEqual([]);
    releaseLifecycleLock(acquired.value);
    fs.writeFileSync(file, 'not JSON');
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(acquireLifecycleLock(dir, { maxAttempts: 2 }).ok).toBe(false);
    expect(sleep.mock.calls).toEqual([[50]]);
    expect(fs.readFileSync(file, 'utf8')).toBe('not JSON');
  } finally {
    sleep.mockRestore();
    spy.mockRestore();
  }
});

test('a prior handle cannot unlink a successor or close its reused descriptor', () => {
  const dir = fixture();
  const first = acquire(dir);
  expect(first.ok).toBe(true);
  const file = path.join(dir, 'state.lock');
  fs.unlinkSync(file);
  const successor = acquire(dir);
  expect(successor.ok).toBe(true);
  const before = fs.readFileSync(file, 'utf8');
  releaseLifecycleLock(first.value);
  releaseLifecycleLock(first.value);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.fstatSync(successor.value.fd).isFile()).toBe(true);
  expect(childResult(dir).ok).toBe(false);
  releaseLifecycleLock(successor.value);
  const next = acquire(dir);
  expect(next.ok).toBe(true);
  releaseLifecycleLock(successor.value);
  expect(fs.fstatSync(next.value.fd).isFile()).toBe(true);
  expect(fs.existsSync(file)).toBe(true);
  releaseLifecycleLock(next.value);
});

test('an abandoned reclaimer refuses recovery rather than being stolen by age', () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const before = fs.readFileSync(file, 'utf8');
  const guard = `${file}.reclaim`;
  fs.writeFileSync(guard, '');
  fs.utimesSync(guard, new Date(0), new Date(0));
  expect(acquire(dir).ok).toBe(false);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.existsSync(guard)).toBe(true);
  fs.unlinkSync(guard);
  const recovered = acquire(dir);
  expect(recovered.ok).toBe(true);
  releaseLifecycleLock(recovered.value);
});

test('competing reclaimers cannot remove a successor after the single unlink', async () => {
  const dir = fixture();
  const file = agedDeadLock(dir);
  const beforeGate = path.join(dir, 'continue-before');
  const afterGate = path.join(dir, 'continue-after');
  const { child, completeCoverage } = spawnCovered(
    process.execPath,
    [
      '-e',
      `
    const fs = require('node:fs');
    const m = require(process.argv[1]);
    const [dir, file, beforeGate, afterGate] = process.argv.slice(2);
    const unlink = fs.unlinkSync;
    const wait = (gate) => {
      while (!fs.existsSync(gate))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    };
    fs.unlinkSync = function(p) {
      if (p === file) {
        process.send({type: 'before-unlink'});
        wait(beforeGate);
        unlink.call(fs, p);
        process.send({type: 'after-unlink'});
        wait(afterGate);
        return;
      }
      return unlink.call(fs, p);
    };
    const r = m.acquireLifecycleLock(dir, {
      maxAttempts: 3, retryDelayMs: 0, staleThresholdMs: 0
    });
    process.send({type: 'result', ok: r.ok});
    if (r.ok) m.releaseLifecycleLock(r.value);
  `,
      modulePath,
      dir,
      file,
      beforeGate,
      afterGate,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }
  );
  children.push(child);
  await nextMessage(child, 'before-unlink');
  expect(childResult(dir).ok).toBe(false);
  expect(fs.existsSync(file)).toBe(true);
  const afterUnlink = nextMessage(child, 'after-unlink');
  fs.writeFileSync(beforeGate, '');
  await afterUnlink;
  const successor = acquire(dir);
  expect(successor.ok).toBe(true);
  fs.utimesSync(file, new Date(0), new Date(0));
  const before = fs.readFileSync(file, 'utf8');
  const result = nextMessage(child, 'result');
  fs.writeFileSync(afterGate, '');
  expect(await result).toEqual({ type: 'result', ok: false });
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(childResult(dir).ok).toBe(false);
  releaseLifecycleLock(successor.value);
  await completeCoverage();
  expect(child.exitCode).toBe(0);
  expect(child.signalCode).toBe(null);
});

test('the wrapper releases on returned failure and thrown failure', () => {
  const dir = fixture();
  const refusal = { ok: false, errors: [{ rule: 'test.refused' }] };
  expect(withLifecycleLock(dir, () => refusal)).toBe(refusal);
  expect(fs.existsSync(path.join(dir, 'state.lock'))).toBe(false);
  expect(() =>
    withLifecycleLock(dir, () => {
      throw new Error('body failed');
    })
  ).toThrow('body failed');
  const acquired = acquire(dir);
  expect(acquired.ok).toBe(true);
  releaseLifecycleLock(acquired.value);
});
