import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { assertMachinePath } from '../init/machine-paths';

/** Operational data only. This is not a governed-state transaction or openat capability. */
export function readOperationalFile(root: string, file: string, limit: number): Buffer {
  assertMachinePath(root, file);
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > limit ||
      stat.nlink !== 1 ||
      (stat.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    )
      throw new Error('Operational file is not bounded regular data');
    const buffer = Buffer.alloc(limit + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > limit) throw new Error('Operational file grew beyond its byte limit');
    return buffer.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

export function ensureOperationalDirectory(root: string, directory: string): void {
  assertMachinePath(root, directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertMachinePath(root, directory);
  const stat = fs.statSync(directory);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o022) !== 0 ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid())
  )
    throw new Error('Operational directory is not owned and protected from foreign writes');
}

/** One append syscall keeps ordinary concurrent records separate. Short writes are reported, not retried. */
export function appendOperationalRecord(
  root: string,
  file: string,
  bytes: Uint8Array,
  exclusive = false
): void {
  ensureOperationalDirectory(root, dirname(file));
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      fs.constants.O_CREAT |
      fs.constants.O_NOFOLLOW |
      fs.constants.O_NONBLOCK |
      (exclusive ? fs.constants.O_EXCL : 0),
    0o600
  );
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o022) !== 0
    )
      throw new Error('Operational append target is unsafe');
    if (fs.writeSync(fd, bytes) !== bytes.byteLength)
      throw new Error('Short operational record append');
  } finally {
    fs.closeSync(fd);
  }
}
