/** Qualification snapshots of flat, atomically published renderer turn files. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

const committedName = /^turn-\d+\.json$/;
const identity = (stat: fs.Stats): readonly number[] => [
  stat.dev,
  stat.ino,
  stat.size,
  stat.mtimeMs,
  stat.ctimeMs,
];
function regular(stat: fs.Stats): void {
  assert(stat.isFile() && !stat.isSymbolicLink(), 'committed turn must be a regular file');
}

/** Nonmatching entries are never traversed, statted, opened or read. */
export function committedTurnNames(session: string): string[] {
  const directory = fs.lstatSync(session);
  assert(
    directory.isDirectory() && !directory.isSymbolicLink(),
    'turn session must be a directory'
  );
  return fs
    .readdirSync(session)
    .filter((name) => committedName.test(name))
    .sort();
}

/** A matching entry that disappears or changes is an observation failure, never an omission. */
export function readCommittedTurnFile(session: string, name: string, maximumBytes: number) {
  assert(committedName.test(name), 'not a committed turn basename');
  assert(
    Number.isSafeInteger(maximumBytes) && maximumBytes > 0 && maximumBytes <= 8 * 1024 * 1024,
    'qualification turn capture limit must be 1..8 MiB'
  );
  const file = path.join(session, name),
    named = fs.lstatSync(file);
  regular(named);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const held = fs.fstatSync(fd);
    regular(held);
    assert.deepEqual(identity(held), identity(named), 'committed turn replaced before open');
    assert(held.size <= maximumBytes, 'committed turn exceeds qualification capture limit');
    const buffer = Buffer.alloc(Math.min(maximumBytes, held.size) + 1);
    let count = 0;
    while (count < buffer.length) {
      const size = fs.readSync(fd, buffer, count, buffer.length - count, null);
      if (size === 0) break;
      count += size;
    }
    assert(count <= maximumBytes, 'committed turn exceeds qualification capture limit');
    const after = fs.fstatSync(fd),
      namedAfter = fs.lstatSync(file);
    regular(after);
    regular(namedAfter);
    assert.deepEqual(identity(after), identity(held), 'committed turn changed during read');
    assert.deepEqual(
      identity(namedAfter),
      identity(held),
      'committed turn name replaced during read'
    );
    assert.equal(count, held.size, 'committed turn read did not capture its complete bytes');
    const bytes = buffer.subarray(0, count);
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    );
    assert(
      value !== null && typeof value === 'object' && !Array.isArray(value),
      'committed turn JSON must be an object'
    );
    return { bytes, value: value as Record<string, unknown>, dev: held.dev, ino: held.ino };
  } finally {
    fs.closeSync(fd);
  }
}
