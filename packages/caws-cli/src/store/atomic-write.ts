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

export interface WriteFileAtomicOptions {
  /**
   * When true and `targetPath` exists, the temp file is created with the
   * target's existing mode, and the final on-disk file has the same mode
   * after rename. Used by the lifecycle substrate to preserve the
   * executable bit on managed hook scripts.
   *
   * When false (default), the temp file is created with the standard
   * `'w'` mode (0o666 masked by umask). This preserves the historical
   * behavior of writeFileAtomic so existing callers are not silently
   * affected.
   *
   * When `targetPath` does NOT exist, this option has no effect; the
   * file is created with the default mode regardless.
   */
  readonly preserveMode?: boolean;
}

/**
 * Write `contents` to `targetPath` atomically.
 *
 * On Err, the temp file is cleaned up. On Ok, the target file holds the
 * new bytes. When `options.preserveMode` is true and the target exists,
 * the new file has the same mode bits as the prior file.
 */
export function writeFileAtomic(
  targetPath: string,
  contents: string | Buffer,
  options: WriteFileAtomicOptions = {}
): Result<true> {
  const tmpPath = nextTempName(targetPath);
  let fd: number | undefined;

  // When preserveMode is requested, stat the target BEFORE the temp
  // write so we can match the mode at creation time (reducing the
  // window where the file has a wrong mode) and verify/restore after
  // rename (so chmod failures on the temp file don't silently drop
  // the exec bit).
  let preservedMode: number | undefined;
  if (options.preserveMode === true) {
    try {
      preservedMode = fs.statSync(targetPath).mode & 0o7777;
    } catch {
      // Target doesn't exist; preserveMode has no effect.
    }
  }

  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // Apply preserved mode to the temp file before rename so the
    // window between rename and chmod is minimal.
    if (preservedMode !== undefined) {
      try {
        fs.chmodSync(tmpPath, preservedMode);
      } catch {
        // chmod on temp may fail on some filesystems (e.g., NFS);
        // post-rename chmod below is the safety net.
      }
    }

    fs.renameSync(tmpPath, targetPath);

    // Post-rename verification: if preserveMode was requested, ensure
    // the final file has the right bits. This is the safety net for
    // pre-rename chmod failure, and a no-op when the pre-rename chmod
    // succeeded.
    if (preservedMode !== undefined) {
      try {
        const actualMode = fs.statSync(targetPath).mode & 0o7777;
        if (actualMode !== preservedMode) {
          fs.chmodSync(targetPath, preservedMode);
        }
      } catch {
        // Best-effort: if the verify or chmod itself fails, the write
        // already succeeded; the caller may need to chmod manually.
      }
    }

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
