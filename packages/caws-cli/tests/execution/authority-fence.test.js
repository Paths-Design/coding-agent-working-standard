'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { setTimeout, clearTimeout } = require('node:timers');
const {
  acquireLifecycleLock,
  releaseLifecycleLock,
  withLifecycleLock,
} = require('../../dist/store/lifecycle-lock');
const modulePath = path.resolve(__dirname, '../../dist/store/lifecycle-lock');
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
  const result = spawnSync(
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
  const recovered = acquire(dir);
  expect(recovered.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).pid).toBe(process.pid);
  releaseLifecycleLock(recovered.value);
  for (const bytes of ['not JSON', '{}', '{"pid":0}', '{"pid":"123"}']) {
    fs.writeFileSync(file, bytes);
    fs.utimesSync(file, new Date(0), new Date(0));
    expect(acquire(dir).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    fs.unlinkSync(file);
  }
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
  const child = spawn(
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
