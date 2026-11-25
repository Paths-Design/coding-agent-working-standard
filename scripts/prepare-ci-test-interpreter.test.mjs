import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { prepareCiTestInterpreter } = require('./prepare-ci-test-interpreter.cjs');
const helper = fileURLToPath(new URL('./prepare-ci-test-interpreter.cjs', import.meta.url));
const mode = (file) => fs.statSync(file).mode & 0o7777;
const sha = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-ci-node-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, 'cache');
  fs.mkdirSync(cache);
  const executable = path.join(cache, 'node');
  fs.writeFileSync(executable, '# private interpreter fixture\n');
  fs.chmodSync(executable, 0o777);
  const runtime = {
    platform: process.platform,
    geteuid: () => process.geteuid(),
    execPath: executable,
    env: { RUNNER_TOOL_CACHE: cache },
  };
  return { root, cache, executable, runtime };
}

test('normalizes the owned inode to 0755 without changing its bytes', (t) => {
  const f = fixture(t);
  const before = fs.statSync(f.executable);
  const digest = sha(f.executable);
  const result = prepareCiTestInterpreter({ runtime: f.runtime });
  const after = fs.statSync(f.executable);
  assert.equal(result.beforeMode, 0o777);
  assert.equal(result.afterMode, 0o755);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(sha(f.executable), digest);
  assert.equal(result.sha256, digest);
});

test('already-normalized interpreter requires no chmod', (t) => {
  const f = fixture(t);
  fs.chmodSync(f.executable, 0o755);
  const io = {
    ...fs,
    fchmodSync() {
      assert.fail('already-normalized inode must not be changed');
    },
  };
  assert.equal(
    prepareCiTestInterpreter({ runtime: f.runtime, io }).afterMode,
    0o755
  );
});

test('a cache-prefix sibling cannot select an outside executable', (t) => {
  const f = fixture(t);
  const sibling = f.cache + '-outside';
  fs.mkdirSync(sibling);
  const outside = path.join(sibling, 'node');
  fs.writeFileSync(outside, 'outside');
  fs.chmodSync(outside, 0o777);
  f.runtime.execPath = outside;
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime }),
    /inside RUNNER_TOOL_CACHE/
  );
  assert.equal(mode(outside), 0o777);
});

test('a symlinked tool-cache root refuses without chmod', (t) => {
  const f = fixture(t);
  const alias = path.join(f.root, 'cache-alias');
  fs.symlinkSync(f.cache, alias, 'dir');
  f.runtime.env.RUNNER_TOOL_CACHE = alias;
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime }),
    /must be physical/
  );
  assert.equal(mode(f.executable), 0o777);
});

test('a symlinked executable refuses without changing its referent', (t) => {
  const f = fixture(t);
  const target = path.join(f.cache, 'real-node');
  fs.renameSync(f.executable, target);
  fs.symlinkSync(target, f.executable);
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime }),
    /must be physical/
  );
  assert.equal(mode(target), 0o777);
});

test('hard-linked and foreign-owned interpreter identities refuse', (t) => {
  const f = fixture(t);
  const link = path.join(f.cache, 'second-link');
  fs.linkSync(f.executable, link);
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime }),
    /must have one link/
  );
  fs.unlinkSync(link);
  f.runtime.geteuid = () => fs.statSync(f.executable).uid + 1;
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime }),
    /effective UID/
  );
  assert.equal(mode(f.executable), 0o777);
});

test('replacement during open refuses before changing either inode', (t) => {
  const f = fixture(t);
  const original = f.executable + '.original';
  const originalBytes = fs.readFileSync(f.executable);
  let closed = false;
  const io = {
    ...fs,
    openSync(...args) {
      const fd = fs.openSync(...args);
      fs.renameSync(f.executable, original);
      fs.writeFileSync(f.executable, 'replacement');
      fs.chmodSync(f.executable, 0o777);
      return fd;
    },
    fchmodSync() {
      assert.fail('replacement must be detected before chmod');
    },
    closeSync(fd) {
      closed = true;
      fs.closeSync(fd);
    },
  };
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime, io }),
    /CI interpreter preparation: interpreter changed (?:while opening|before chmod)/
  );
  assert.equal(closed, true);
  assert.equal(mode(original), 0o777);
  assert.equal(mode(f.executable), 0o777);
  assert.deepEqual(fs.readFileSync(original), originalBytes);
  assert.equal(fs.readFileSync(f.executable, 'utf8'), 'replacement');
});

test('replacement at the named-path check refuses before changing either inode', (t) => {
  const f = fixture(t);
  const original = f.executable + '.original';
  const originalBytes = fs.readFileSync(f.executable);
  let executableStats = 0;
  let closed = false;
  const io = {
    ...fs,
    lstatSync(file, ...args) {
      if (file === f.executable && ++executableStats === 2) {
        fs.renameSync(f.executable, original);
        fs.writeFileSync(f.executable, 'replacement');
        fs.chmodSync(f.executable, 0o777);
      }
      return fs.lstatSync(file, ...args);
    },
    fchmodSync() {
      assert.fail('named replacement must refuse before chmod');
    },
    closeSync(fd) {
      closed = true;
      fs.closeSync(fd);
    },
  };
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime, io }),
    /CI interpreter preparation: interpreter changed before chmod/
  );
  assert.equal(executableStats, 2);
  assert.equal(closed, true);
  assert.equal(mode(original), 0o777);
  assert.equal(mode(f.executable), 0o777);
  assert.deepEqual(fs.readFileSync(original), originalBytes);
  assert.equal(fs.readFileSync(f.executable, 'utf8'), 'replacement');
});

test('unsuccessful chmod cannot report successful preparation', (t) => {
  const f = fixture(t);
  const io = { ...fs, fchmodSync() {} };
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime, io }),
    /exact mode/
  );
  assert.equal(mode(f.executable), 0o777);
});

test('replacement after chmod cannot pass final path verification', (t) => {
  const f = fixture(t);
  const original = f.executable + '.original';
  const io = {
    ...fs,
    fchmodSync(fd, permissions) {
      fs.fchmodSync(fd, permissions);
      fs.renameSync(f.executable, original);
      fs.writeFileSync(f.executable, 'replacement');
      fs.chmodSync(f.executable, 0o777);
    },
  };
  assert.throws(
    () => prepareCiTestInterpreter({ runtime: f.runtime, io }),
    /changed after chmod/
  );
  assert.equal(mode(original), 0o755);
  assert.equal(mode(f.executable), 0o777);
});

test('the CLI rejects an arbitrary target argument without changing it', (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [helper, f.executable], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_TOOL_CACHE: f.cache },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No path arguments accepted/);
  assert.equal(mode(f.executable), 0o777);
});
