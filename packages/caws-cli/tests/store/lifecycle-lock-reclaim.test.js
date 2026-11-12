'use strict';
// A process killed while reclaiming a dead owner's lifecycle lock leaves its
// reclaim marker behind. These cases pin that the marker is cleared by the
// same rule as the lock (aged, owner provably gone), that a live or unknown
// owner's marker is never taken, and that a refusal says what is in the way.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  acquireLifecycleLock,
  releaseLifecycleLock,
  withLifecyclePublicationFence,
} = require('../../dist/store/lifecycle-lock');
const { ok } = require('../../dist/kernel');

const directories = [];
afterAll(() =>
  directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
);
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lock-reclaim-'));
  directories.push(directory);
  return {
    directory,
    lock: path.join(directory, 'state.lock'),
    reclaim: path.join(directory, 'state.lock.reclaim'),
  };
}
/** A process id that existed and has exited. */
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  return Number(child.stdout.toString());
}
const owner = (pid, hostname = os.hostname()) => JSON.stringify({ pid, hostname });
const age = (file, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  fs.utimesSync(file, at, at);
};
const STALE = 1000;
const options = { staleThresholdMs: STALE, maxAttempts: 2, retryDelayMs: 0 };

function deadOwnerLock(f) {
  fs.writeFileSync(f.lock, owner(deadPid()));
  age(f.lock, STALE * 5);
}

test('a marker left by a reclaimer that died is cleared and the dead lock is reclaimed', () => {
  const f = fixture();
  deadOwnerLock(f);
  fs.writeFileSync(f.reclaim, owner(deadPid()));
  age(f.reclaim, STALE * 5);
  const acquired = acquireLifecycleLock(f.directory, options);
  expect(acquired.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.lock, 'utf8')).pid).toBe(process.pid);
  expect(fs.existsSync(f.reclaim)).toBe(false);
  releaseLifecycleLock(acquired.value);
  // Nothing is left beside the lock: no marker and no moved-aside copy.
  expect(fs.readdirSync(f.directory)).toEqual([]);
});

test('a marker held by a live reclaimer is never taken, however old', () => {
  const f = fixture();
  deadOwnerLock(f);
  fs.writeFileSync(f.reclaim, owner(process.pid));
  age(f.reclaim, STALE * 100);
  const before = fs.readFileSync(f.reclaim);
  const result = acquireLifecycleLock(f.directory, options);
  expect(result.ok).toBe(false);
  expect(fs.readFileSync(f.reclaim)).toEqual(before);
  expect(fs.readdirSync(f.directory).sort()).toEqual(['state.lock', 'state.lock.reclaim']);
});

test('a marker whose dead owner is recent is left until it has aged', () => {
  const f = fixture();
  deadOwnerLock(f);
  fs.writeFileSync(f.reclaim, owner(deadPid()));
  expect(acquireLifecycleLock(f.directory, options).ok).toBe(false);
  expect(fs.existsSync(f.reclaim)).toBe(true);
});

test('a marker recorded on another host is not judged dead from this one', () => {
  const f = fixture();
  deadOwnerLock(f);
  fs.writeFileSync(f.reclaim, owner(deadPid(), 'some-other-host.invalid'));
  age(f.reclaim, STALE * 100);
  expect(acquireLifecycleLock(f.directory, options).ok).toBe(false);
  expect(fs.existsSync(f.reclaim)).toBe(true);
});

test.each([
  ['just past the ordinary threshold', STALE * 5, false],
  ['past ten thresholds', STALE * 11, true],
])('a marker with no recorded owner, %s', (_label, msAgo, cleared) => {
  const f = fixture();
  deadOwnerLock(f);
  fs.writeFileSync(f.reclaim, '');
  age(f.reclaim, msAgo);
  const result = acquireLifecycleLock(f.directory, options);
  expect(result.ok).toBe(cleared);
  expect(fs.existsSync(f.reclaim)).toBe(!cleared);
  if (result.ok) releaseLifecycleLock(result.value);
});

test('a marker that is a symbolic link is not followed or removed', () => {
  const f = fixture();
  deadOwnerLock(f);
  const target = path.join(f.directory, 'elsewhere');
  fs.writeFileSync(target, owner(deadPid()));
  age(target, STALE * 100);
  fs.symlinkSync(target, f.reclaim);
  expect(acquireLifecycleLock(f.directory, options).ok).toBe(false);
  expect(fs.lstatSync(f.reclaim).isSymbolicLink()).toBe(true);
  expect(fs.existsSync(target)).toBe(true);
});

describe('the refusal says what is in the way', () => {
  test('a lock held by a running process names it and tells the caller to retry', () => {
    const f = fixture();
    fs.writeFileSync(f.lock, owner(process.pid));
    const result = acquireLifecycleLock(f.directory, options);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain(`it is held by process ${process.pid} for `);
    expect(result.errors[0].message).toContain('Retry when it finishes.');
  });

  test('a dead owner that is not yet old enough says when it becomes reclaimable', () => {
    const f = fixture();
    const pid = deadPid();
    fs.writeFileSync(f.lock, owner(pid));
    const result = acquireLifecycleLock(f.directory, options);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain(`it is held by process ${pid}, which has exited`);
    expect(result.errors[0].message).toContain('it is reclaimed once it is 1s old');
  });

  test('a blocking marker is named with its owner and when it clears', () => {
    const f = fixture();
    deadOwnerLock(f);
    fs.writeFileSync(f.reclaim, owner(process.pid));
    const result = acquireLifecycleLock(f.directory, options);
    expect(result.ok).toBe(false);
    expect(result.errors[0].message).toContain(
      `An interrupted recovery left ${f.reclaim} (process ${process.pid}, `
    );
    expect(result.errors[0].message).toContain(
      'cleared automatically once it is 1s old and its owner has exited.'
    );
  });
});

describe('publication fence', () => {
  test('a lock released during the wait is acquired instead of refused', () => {
    const f = fixture();
    // A detached helper removes the lock 10ms after it reports that it is
    // running; five attempts 50ms apart outlast that. The launcher returns only
    // once the helper has reported, so process start-up time is not in the race.
    fs.writeFileSync(f.lock, owner(process.pid));
    const ready = path.join(os.tmpdir(), `caws-lock-helper-ready-${process.pid}-${Date.now()}`);
    const helper = spawnSync(
      process.execPath,
      [
        '-e',
        `const fs = require('fs');
         require('child_process').spawn(process.execPath, ['-e',
          'require("fs").writeFileSync(process.argv[2], ""); setTimeout(() => require("fs").unlinkSync(process.argv[1]), 10)',
          process.argv[1], process.argv[2]],
          { detached: true, stdio: 'ignore' }).unref();
         const until = Date.now() + 20000;
         while (!fs.existsSync(process.argv[2])) if (Date.now() > until) process.exit(3);`,
        f.lock,
        ready,
      ],
      { encoding: 'utf8' }
    );
    fs.rmSync(ready, { force: true });
    expect(helper.status).toBe(0);
    const result = withLifecyclePublicationFence(f.directory, (current) => ok(current()));
    expect(result).toEqual({ ok: true, value: true });
    expect(fs.existsSync(f.lock)).toBe(false);
  });

  test('a lock that stays held is refused without being reclaimed, and the holder is named', () => {
    const f = fixture();
    fs.writeFileSync(f.lock, owner(deadPid()));
    age(f.lock, 3_600_000);
    const before = fs.readFileSync(f.lock);
    let ran = false;
    const result = withLifecyclePublicationFence(f.directory, () => {
      ran = true;
      return ok(null);
    });
    expect(result.ok).toBe(false);
    expect(ran).toBe(false);
    // Publication never reclaims, even a provably dead owner's lock.
    expect(fs.readFileSync(f.lock)).toEqual(before);
    // It names the holder but does not probe whether that process is running.
    expect(result.errors[0].message).toMatch(
      /it is held by process \d+ for \d+s\. Publication waits/
    );
    expect(result.errors[0].message).not.toContain('which has exited');
  });
});
