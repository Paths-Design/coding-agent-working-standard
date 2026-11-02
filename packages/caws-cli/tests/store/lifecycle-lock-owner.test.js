'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { acquireLifecycleLock, releaseLifecycleLock } = require('../../dist/store/lifecycle-lock');

const directories = [];
afterEach(() => jest.restoreAllMocks());
afterAll(() =>
  directories.forEach((directory) => fs.rmSync(directory, { recursive: true, force: true }))
);
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lock-owner-'));
  directories.push(directory);
  return { directory, file: path.join(directory, 'state.lock') };
}
function age(file) {
  fs.utimesSync(file, new Date(0), new Date(0));
}
const options = { staleThresholdMs: 1, maxAttempts: 2, retryDelayMs: 0 };

test('a separate live process retains an aged lock for long removals', async () => {
  const f = fixture();
  const modulePath = require.resolve('../../dist/store/lifecycle-lock');
  const holder = spawn(process.execPath, [
    '-e',
    `
    const locks = require(${JSON.stringify(modulePath)});
    const acquired = locks.acquireLifecycleLock(${JSON.stringify(f.directory)});
    if (!acquired.ok) process.exit(1);
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
  ]);
  try {
    const [ready] = await once(holder.stdout, 'data');
    expect(ready.toString()).toBe('ready');
    age(f.file);
    const before = fs.readFileSync(f.file);
    expect(acquireLifecycleLock(f.directory, options)).toMatchObject({ ok: false });
    expect(fs.readFileSync(f.file)).toEqual(before);
  } finally {
    const stopped = once(holder, 'exit');
    holder.kill();
    await stopped;
  }
  // The same retained lock becomes reclaimable only after the owner exits.
  const recovered = acquireLifecycleLock(f.directory, options);
  expect(recovered.ok).toBe(true);
  releaseLifecycleLock(recovered.value);
  expect(fs.existsSync(f.file)).toBe(false);
});

test.each(['missing pid', 'malformed', 'foreign host', 'permission denied'])(
  'uncertain owner liveness cannot retire an aged lock: %s',
  (problem) => {
    const f = fixture();
    const owner = { pid: process.pid, hostname: os.hostname() };
    if (problem === 'missing pid') delete owner.pid;
    if (problem === 'foreign host') owner.hostname = 'foreign-host';
    fs.writeFileSync(f.file, problem === 'malformed' ? '{' : JSON.stringify(owner));
    age(f.file);
    const before = fs.readFileSync(f.file);
    if (problem === 'permission denied')
      jest.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      });
    expect(acquireLifecycleLock(f.directory, options)).toMatchObject({ ok: false });
    expect(fs.readFileSync(f.file)).toEqual(before);
  }
);

test('releasing a displaced descriptor cannot unlink its replacement lock', () => {
  const f = fixture();
  const held = acquireLifecycleLock(f.directory);
  expect(held.ok).toBe(true);
  fs.renameSync(f.file, f.file + '.old');
  fs.writeFileSync(f.file, 'replacement owner');
  releaseLifecycleLock(held.value);
  expect(fs.readFileSync(f.file, 'utf8')).toBe('replacement owner');
});

test('a replaced lock observed during stale recovery is retained', () => {
  const f = fixture();
  const dead = spawn(process.execPath, ['-e', '']);
  return once(dead, 'exit').then(() => {
    fs.writeFileSync(f.file, JSON.stringify({ pid: dead.pid, hostname: os.hostname() }));
    age(f.file);
    const actual = process.kill;
    jest.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === dead.pid) {
        fs.renameSync(f.file, f.file + '.old');
        fs.writeFileSync(f.file, JSON.stringify({ pid: process.pid, hostname: os.hostname() }));
        throw Object.assign(new Error('owner exited'), { code: 'ESRCH' });
      }
      return actual(pid, signal);
    });
    expect(acquireLifecycleLock(f.directory, options)).toMatchObject({ ok: false });
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).pid).toBe(process.pid);
  });
});
