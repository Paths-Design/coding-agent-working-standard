// Atomic file write.
//
// Contract: file CONTENT atomicity. After writeFileAtomic returns Ok, the
// file at `targetPath` either contains the new bytes in full or the old
// bytes in full. There is no partial-write window for readers.
//
// Mechanism: write to a sibling temp path (`<target>.tmp.<pid>.<counter>`),
// fsync the data + descriptor, then rename onto the target. rename(2) is
// atomic on the same filesystem; the sibling location guarantees that.
//
// We do NOT guarantee crash-proof directory durability. A power loss
// between rename and a parent-directory fsync may leave the directory
// entry on disk while the new file contents are still in the page cache.
// Callers that need durability past power loss should fsync the parent
// directory themselves; events-store does this for events.jsonl.

import * as fs from 'fs';
import * as path from 'path';
import { err, ok, type Result } from '@paths.design/caws-kernel';
import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

let tmpCounter = 0;

function nextTempName(targetPath: string): string {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const counter = tmpCounter++;
  return path.join(dir, `${base}.tmp.${process.pid}.${counter}`);
}

/**
 * Write `contents` to `targetPath` atomically.
 *
 * On Err, the temp file is cleaned up. On Ok, the target file holds the
 * new bytes.
 */
export function writeFileAtomic(targetPath: string, contents: string | Buffer): Result<true> {
  const tmpPath = nextTempName(targetPath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, targetPath);
    return ok(true);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* swallow; we're already in an error path */
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* temp file may not have been created */
    }
    const cause = e as { message?: string; code?: string };
    return err(
      storeDiagnostic(STORE_RULES.WRITE_IO_FAILED, `Failed to write ${targetPath}: ${cause.message ?? 'unknown error'}.`, {
        subject: targetPath,
        data: { code: cause.code },
      })
    );
  }
}

/**
 * Best-effort parent-directory fsync. Returns true on success, false on
 * failure (some filesystems / platforms don't support it). Callers that
 * care about durability past crash should call this after a sequence of
 * atomic writes. Never throws.
 */
export function fsyncDir(dirPath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dirPath, 'r');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
