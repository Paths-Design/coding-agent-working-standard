'use strict';

// Public host-package identity only; authentication and loaded OS libraries are
// outside this inventory. This is not an atomic snapshot against an uncooperative
// writer; capture again after each host observation.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const MAX_ENTRIES = 10000;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const insist = (value, message) => {
  if (!value) throw new Error(message);
};
const identity = (stat) =>
  ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .map((key) => String(stat[key]))
    .join(':');

function snapshotHostTree(root) {
  insist(
    typeof root === 'string' && path.isAbsolute(root) && path.resolve(root) === root,
    'Physical absolute root required'
  );
  const rootStat = fs.lstatSync(root, { bigint: true });
  insist(
    fs.realpathSync(root) === root && rootStat.isDirectory(),
    'Physical directory root required'
  );
  const ancestorIdentity = (stat) => [stat.dev, stat.ino, stat.mode].map(String).join(':');
  const ancestors = [];
  let ancestor = path.parse(root).root;
  for (const part of path.relative(ancestor, root).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    const stat = fs.lstatSync(ancestor, { bigint: true });
    insist(stat.isDirectory() && !stat.isSymbolicLink(), 'Host ancestor must be physical');
    ancestors.push({ path: ancestor, identity: ancestorIdentity(stat) });
  }
  const checkAncestors = () => {
    for (const entry of ancestors) {
      const stat = fs.lstatSync(entry.path, { bigint: true });
      insist(
        stat.isDirectory() && !stat.isSymbolicLink() && ancestorIdentity(stat) === entry.identity,
        'Host ancestor changed'
      );
    }
  };
  const entries = [],
    folded = new Set();
  const observed = [];
  let total = 0;
  const inside = (file) => file.startsWith(root + path.sep);
  function visit(directory, relative) {
    checkAncestors();
    const before = fs.lstatSync(directory, { bigint: true });
    insist(before.isDirectory() && !before.isSymbolicLink(), 'Directory identity changed');
    for (const name of fs.readdirSync(directory).sort()) {
      checkAncestors();
      const rel = relative ? relative + '/' + name : name;
      insist(
        rel.length <= 4096 &&
          !rel.includes('\\') &&
          [...rel].every(
            (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
          ),
        'Invalid host member name'
      );
      insist(!folded.has(rel.toLowerCase()), 'Host tree case collision');
      folded.add(rel.toLowerCase());
      insist(folded.size <= MAX_ENTRIES, 'Host tree entry limit');
      const file = path.join(directory, name),
        stat = fs.lstatSync(file, { bigint: true });
      observed.push({ file, identity: identity(stat) });
      const mode = Number(stat.mode & 0o7777n);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        insist(target && !path.isAbsolute(target), 'Absolute or empty host link refused');
        const resolved = path.resolve(directory, target);
        insist(inside(resolved), 'Host link escapes tree');
        let actual;
        try {
          actual = fs.realpathSync(file);
        } catch {
          throw new Error('Dangling or cyclic host link');
        }
        insist(inside(actual), 'Host link resolves outside tree');
        insist(
          identity(fs.lstatSync(file, { bigint: true })) === identity(stat),
          'Host link changed'
        );
        entries.push({
          path: rel,
          kind: 'link',
          target,
          referent: path.relative(root, actual).split(path.sep).join('/'),
        });
      } else if (stat.isDirectory()) {
        entries.push({ path: rel, kind: 'directory', mode });
        visit(file, rel);
      } else if (stat.isFile()) {
        insist(
          stat.nlink === 1n && stat.size <= BigInt(MAX_FILE),
          'Expected bounded single-link host file'
        );
        total += Number(stat.size);
        insist(total <= MAX_TOTAL, 'Host tree byte limit');
        const fd = fs.openSync(
          file,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        try {
          insist(
            identity(fs.fstatSync(fd, { bigint: true })) === identity(stat),
            'Host file changed before read'
          );
          const bytes = Buffer.alloc(Number(stat.size));
          let offset = 0;
          while (offset < bytes.length) {
            const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
            insist(count > 0, 'Host file truncated during read');
            offset += count;
          }
          insist(fs.readSync(fd, Buffer.alloc(1), 0, 1, null) === 0, 'Host file grew during read');
          insist(
            bytes.length === Number(stat.size) &&
              identity(fs.fstatSync(fd, { bigint: true })) === identity(stat) &&
              identity(fs.lstatSync(file, { bigint: true })) === identity(stat),
            'Host file changed during read'
          );
          entries.push({
            path: rel,
            kind: 'file',
            mode,
            sizeBytes: bytes.length,
            sha256: sha(bytes),
          });
        } finally {
          fs.closeSync(fd);
        }
      } else {
        throw new Error('Special host member refused');
      }
    }
    insist(
      identity(fs.lstatSync(directory, { bigint: true })) === identity(before),
      'Host directory changed'
    );
  }
  visit(root, '');
  checkAncestors();
  insist(fs.realpathSync(root) === root, 'Host root physical path changed');
  for (const member of observed)
    insist(
      identity(fs.lstatSync(member.file, { bigint: true })) === member.identity,
      'Host member changed after read'
    );
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  insist(
    identity(fs.lstatSync(root, { bigint: true })) === identity(rootStat),
    'Host root changed'
  );
  const inventory = {
    schema: 'caws.native-qualification.host-tree.v1',
    rootMode: Number(rootStat.mode & 0o7777n),
    entries,
  };
  return { ...inventory, digest: sha(Buffer.from(JSON.stringify(inventory))) };
}

function verifyHostTree(root, expectedDigest) {
  insist(
    typeof expectedDigest === 'string' && /^[0-9a-f]{64}$/.test(expectedDigest),
    'Expected host tree digest'
  );
  const observed = snapshotHostTree(root);
  insist(observed.digest === expectedDigest, 'Host tree identity mismatch');
  return observed;
}

module.exports = { snapshotHostTree, verifyHostTree };
