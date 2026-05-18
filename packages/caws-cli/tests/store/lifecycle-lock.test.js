/**
 * Tests for lifecycle-lock.ts (LIFECYCLE-MUTATION-001 A1).
 *
 * The lock primitive serializes multi-file lifecycle mutations
 * through a single global .caws/state.lock. These tests verify:
 *
 *   - acquire/release round-trip
 *   - stale-lock recovery (file older than threshold reclaimed)
 *   - lock-contention error after bounded retries
 *   - release on success
 *   - release on caller exception (finally semantics)
 *   - withLifecycleLock wrapper
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  acquireLifecycleLock,
  releaseLifecycleLock,
  withLifecycleLock,
} = require('../../dist/store/lifecycle-lock');
const { ok, err } = require('@paths.design/caws-kernel');

function mkTempCawsDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

describe('acquireLifecycleLock / releaseLifecycleLock', () => {
  let cawsDir;
  beforeEach(() => {
    cawsDir = mkTempCawsDir('caws-lock-');
  });
  afterEach(() => rmrf(cawsDir));

  it('acquires a fresh lock and returns a handle with the lockPath', () => {
    const result = acquireLifecycleLock(cawsDir);
    expect(result.ok).toBe(true);
    const handle = result.value;
    expect(handle.lockPath).toBe(path.join(cawsDir, 'state.lock'));
    expect(typeof handle.fd).toBe('number');
    // Lock file exists on disk.
    expect(fs.existsSync(handle.lockPath)).toBe(true);
    releaseLifecycleLock(handle);
    expect(fs.existsSync(handle.lockPath)).toBe(false);
  });

  it('writes pid + timestamp to the lock file for diagnostics', () => {
    const result = acquireLifecycleLock(cawsDir);
    const handle = result.value;
    const content = JSON.parse(fs.readFileSync(handle.lockPath, 'utf8'));
    expect(typeof content.pid).toBe('number');
    expect(typeof content.at).toBe('string');
    expect(content.purpose).toBe('lifecycle-mutation');
    releaseLifecycleLock(handle);
  });

  it('refuses concurrent acquisition (lock contention) after bounded retries', () => {
    const first = acquireLifecycleLock(cawsDir, {
      maxAttempts: 1,
      retryDelayMs: 1,
      staleThresholdMs: 60000,
    });
    expect(first.ok).toBe(true);

    const second = acquireLifecycleLock(cawsDir, {
      maxAttempts: 2,
      retryDelayMs: 1,
      staleThresholdMs: 60000,
    });
    expect(second.ok).toBe(false);
    expect(second.errors[0].rule).toBe('store.lifecycle.lock_contention');

    releaseLifecycleLock(first.value);
  });

  it('reclaims a stale lock (file older than threshold)', () => {
    // Manually create a stale lockfile.
    const lockPath = path.join(cawsDir, 'state.lock');
    fs.writeFileSync(lockPath, '{"pid":99999,"at":"2020-01-01T00:00:00Z"}');
    // Backdate its mtime.
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    // Acquire with a small stale threshold.
    const result = acquireLifecycleLock(cawsDir, {
      staleThresholdMs: 100,
      maxAttempts: 2,
      retryDelayMs: 1,
    });
    expect(result.ok).toBe(true);
    releaseLifecycleLock(result.value);
  });

  it('release is idempotent / best-effort (calling on a missing lockfile does not throw)', () => {
    const result = acquireLifecycleLock(cawsDir);
    const handle = result.value;
    releaseLifecycleLock(handle);
    // Calling again does not throw.
    expect(() => releaseLifecycleLock(handle)).not.toThrow();
  });
});

describe('withLifecycleLock', () => {
  let cawsDir;
  beforeEach(() => {
    cawsDir = mkTempCawsDir('caws-lock-with-');
  });
  afterEach(() => rmrf(cawsDir));

  it('releases the lock on body success', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    const result = withLifecycleLock(cawsDir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return ok(42);
    });
    expect(result.ok).toBe(true);
    expect(result.value).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases the lock on body Err', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    const result = withLifecycleLock(cawsDir, () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return err([{ rule: 'test', authority: 'test', severity: 'error', message: 'test failure' }]);
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases the lock on body exception (finally semantics)', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    expect(() =>
      withLifecycleLock(cawsDir, () => {
        expect(fs.existsSync(lockPath)).toBe(true);
        throw new Error('caller-thrown error');
      })
    ).toThrow('caller-thrown error');
    // Lock released even though body threw.
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('returns the acquire-failure when the lock is already held', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    fs.writeFileSync(lockPath, '{}');
    fs.utimesSync(lockPath, new Date(), new Date()); // fresh (not stale)

    const result = withLifecycleLock(
      cawsDir,
      () => ok('should not run'),
      { maxAttempts: 1, retryDelayMs: 1, staleThresholdMs: 60000 }
    );
    expect(result.ok).toBe(false);
    expect(result.errors[0].rule).toBe('store.lifecycle.lock_contention');
  });
});

describe('lifecycle-lock concurrent serialization', () => {
  let cawsDir;
  beforeEach(() => {
    cawsDir = mkTempCawsDir('caws-lock-concurrent-');
  });
  afterEach(() => rmrf(cawsDir));

  // The lifecycle lock is a synchronous primitive (sync open/close,
  // sync busy-wait retry). The intended use is `withLifecycleLock`
  // wrapping a SYNCHRONOUS critical section. We verify serialization
  // by simulating sequential sync transactions and confirming that
  // each one observes the lockfile during its critical section and
  // that the file goes away between transactions.
  //
  // We do NOT test "async caller holds the lock for a non-trivial
  // event-loop window" because that is an anti-pattern with this
  // primitive — a sync lock + sync busy-wait + async caller would
  // deadlock by design. The transaction layer holds the lock only
  // around sync I/O.
  it('back-to-back sync acquisitions never see overlapping lockfiles', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    const observed = [];

    for (let i = 0; i < 5; i++) {
      const acquired = acquireLifecycleLock(cawsDir, {
        maxAttempts: 1,
        retryDelayMs: 1,
        staleThresholdMs: 60000,
      });
      expect(acquired.ok).toBe(true);
      observed.push({ iter: i, insideLockExists: fs.existsSync(lockPath) });
      releaseLifecycleLock(acquired.value);
      expect(fs.existsSync(lockPath)).toBe(false);
    }

    expect(observed).toHaveLength(5);
    for (const o of observed) {
      expect(o.insideLockExists).toBe(true);
    }
  });

  it('a fresh non-stale lockfile blocks acquisition until released', () => {
    const lockPath = path.join(cawsDir, 'state.lock');
    // Hand-create a fresh lockfile to simulate another process holding it.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, at: new Date().toISOString() }));
    fs.utimesSync(lockPath, new Date(), new Date());

    // Acquisition should refuse with lock_contention.
    const blocked = acquireLifecycleLock(cawsDir, {
      maxAttempts: 2,
      retryDelayMs: 5,
      staleThresholdMs: 60000,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.errors[0].rule).toBe('store.lifecycle.lock_contention');

    // After we delete the foreign lockfile, acquisition succeeds.
    fs.unlinkSync(lockPath);
    const acquired = acquireLifecycleLock(cawsDir, {
      maxAttempts: 1,
      retryDelayMs: 1,
      staleThresholdMs: 60000,
    });
    expect(acquired.ok).toBe(true);
    releaseLifecycleLock(acquired.value);
  });
});
