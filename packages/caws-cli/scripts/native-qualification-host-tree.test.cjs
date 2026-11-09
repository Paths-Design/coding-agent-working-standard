'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotHostTree, verifyHostTree } = require('./native-qualification-host-tree.cjs');

function fixture(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caws-host-tree-')));
  try {
    fs.mkdirSync(path.join(root, 'pkg'));
    fs.writeFileSync(path.join(root, 'pkg', 'cli.js'), 'fixture\n', { mode: 0o755 });
    fs.symlinkSync('pkg/cli.js', path.join(root, 'entry'));
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('retains sorted file hashes, modes, and internal symlink targets', () =>
  fixture((root) => {
    const snapshot = snapshotHostTree(root);
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.path),
      ['entry', 'pkg', 'pkg/cli.js']
    );
    assert.equal(snapshot.entries[0].target, 'pkg/cli.js');
    assert.equal(snapshot.entries[2].mode, 0o755);
    assert.equal(verifyHostTree(root, snapshot.digest).digest, snapshot.digest);
  }));

test('detects changed bytes, modes, membership and link identity', () =>
  fixture((root) => {
    const original = snapshotHostTree(root);
    const file = path.join(root, 'pkg', 'cli.js');
    fs.writeFileSync(file, 'changed\n');
    assert.throws(() => verifyHostTree(root, original.digest), /identity mismatch/);
    fs.writeFileSync(file, 'fixture\n');
    fs.chmodSync(file, 0o644);
    assert.throws(() => verifyHostTree(root, original.digest), /identity mismatch/);
    fs.chmodSync(file, 0o755);
    fs.writeFileSync(path.join(root, 'pkg', 'extra'), 'x');
    assert.throws(() => verifyHostTree(root, original.digest), /identity mismatch/);
    fs.unlinkSync(path.join(root, 'entry'));
    fs.symlinkSync('pkg/extra', path.join(root, 'entry'));
    assert.throws(() => verifyHostTree(root, original.digest), /identity mismatch/);
  }));

test('rejects escaping, absolute, dangling, and root alias links', () =>
  fixture((root) => {
    const link = path.join(root, 'entry');
    for (const target of ['../outside', '/etc/passwd', 'missing']) {
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
      assert.throws(() => snapshotHostTree(root), /link/i);
    }
    assert.throws(() => snapshotHostTree(root + '/pkg/..'), /physical/i);
  }));

test('rejects hard links and case collisions rather than guessing identity', () =>
  fixture((root) => {
    const file = path.join(root, 'pkg', 'cli.js');
    fs.linkSync(file, path.join(root, 'pkg', 'hard'));
    assert.throws(() => snapshotHostTree(root), /single.link/i);
    fs.unlinkSync(path.join(root, 'pkg', 'hard'));
    if (!fs.existsSync(path.join(root, 'pkg', 'CLI.js')))
      fs.writeFileSync(path.join(root, 'pkg', 'CLI.js'), 'other');
    const original = fs.readdirSync;
    fs.readdirSync = (directory, ...args) =>
      directory === path.join(root, 'pkg') ? ['cli.js', 'CLI.js'] : original(directory, ...args);
    try {
      assert.throws(() => snapshotHostTree(root), /case collision/i);
    } finally {
      fs.readdirSync = original;
    }
  }));
