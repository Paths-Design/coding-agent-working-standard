// Lifecycle mutation lock.
//
// LIFECYCLE-MUTATION-001 invariant: multi-file lifecycle mutations
// serialize through a single global `.caws/state.lock`. This lock is
// distinct from `.caws/events.jsonl.lock` (held by appendEvent only)
// because lifecycle mutations cross file boundaries — spec YAML +
// registry + event append — and need a wider critical section than
// the per-file event lock provides.
//
// Per-resource locks (per-spec, per-worktree) are deferred. The plan
// is: get the lifecycle mutation graph stable on a single conservative
// lock first; introduce finer-grained locking only when the mutation
// surface is well understood. Premature optimization here recreates
// exactly the cross-file split-brain hazard the substrate exists to
// prevent.
//
// Implementation parity with events-store.ts:
//   - existence-based lockfile (`openSync(path, 'wx')`)
//   - bounded retry with stale-lock recovery
//   - same constants: 30s stale threshold, 3 attempts, 50ms retry
//   - release in `finally` of caller's wrapper (transaction layer)

import * as fs from 'fs';
import * as path from 'path';

import { err, ok, type Result } from '@paths.design/caws-kernel';

import { storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';

const LOCK_FILE_NAME = 'state.lock';
const LOCK_MAX_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;

export interface LifecycleLockHandle {
  readonly fd: number;
  readonly lockPath: string;
}

export interface AcquireLifecycleLockOptions {
  /** Override the global lock path. Used by tests; production callers
   *  pass cawsDir and get the canonical `<cawsDir>/state.lock`. */
  readonly lockPath?: string;
  /** Override stale-lock threshold. Defaults to 30s. Tests can lower it
   *  to validate recovery without sleeping. */
  readonly staleThresholdMs?: number;
  /** Override max attempts. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Override retry delay. Defaults to 50ms. */
  readonly retryDelayMs?: number;
}

function sleepSyncMs(ms: number): void {
  // Busy-wait short sleep. Matches events-store.ts pattern.
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional spin
  }
}

function tryRecoverStaleLock(
  lockPath: string,
  staleThresholdMs: number
): boolean {
  try {
    const stat = fs.statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    if (ageMs > staleThresholdMs) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    // Race: lock was released between EEXIST and statSync. Treat as
    // recoverable so the next attempt can take it.
    return true;
  }
  return false;
}

/**
 * Acquire the global lifecycle mutation lock. Returns a `LifecycleLockHandle`
 * the caller MUST release via `releaseLifecycleLock` in a `finally` block.
 *
 * The lock is held by the existence of `<cawsDir>/state.lock`. Concurrent
 * callers retry up to `maxAttempts` with `retryDelayMs` between attempts.
 * Stale locks (older than `staleThresholdMs`) are reclaimed.
 */
export function acquireLifecycleLock(
  cawsDir: string,
  options: AcquireLifecycleLockOptions = {}
): Result<LifecycleLockHandle> {
  const lockPath = options.lockPath ?? path.join(cawsDir, LOCK_FILE_NAME);
  const staleThresholdMs = options.staleThresholdMs ?? LOCK_STALE_MS;
  const maxAttempts = options.maxAttempts ?? LOCK_MAX_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? LOCK_RETRY_DELAY_MS;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      // Best-effort metadata so a future doctor or operator can see who
      // is holding the lock.
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            at: new Date().toISOString(),
            purpose: 'lifecycle-mutation',
          })
        );
        fs.fsyncSync(fd);
      } catch {
        // Lock content is best-effort; the lock itself is the file's
        // existence.
      }
      return ok({ fd, lockPath });
    } catch (e) {
      const cause = e as { code?: string; message?: string };
      if (cause.code !== 'EEXIST') {
        return err(
          storeDiagnostic(
            STORE_RULES.LIFECYCLE_LOCK_CONTENTION,
            `Unexpected error acquiring lifecycle lock: ${cause.message ?? 'unknown error'}.`,
            { subject: lockPath, data: { code: cause.code ?? null } }
          )
        );
      }
      const recovered = tryRecoverStaleLock(lockPath, staleThresholdMs);
      if (!recovered) {
        sleepSyncMs(retryDelayMs);
      }
    }
  }

  return err(
    storeDiagnostic(
      STORE_RULES.LIFECYCLE_LOCK_CONTENTION,
      `Could not acquire lifecycle lock after ${maxAttempts} attempts.`,
      { subject: lockPath }
    )
  );
}

/** Release the lifecycle lock. Always safe to call; errors are swallowed
 *  because lock-release is best-effort (the lockfile is the contract, not
 *  the fd state). */
export function releaseLifecycleLock(handle: LifecycleLockHandle): void {
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* ignore */
  }
  try {
    fs.unlinkSync(handle.lockPath);
  } catch {
    /* ignore */
  }
}

/** Convenience wrapper: acquire, run the body, release in a `finally`.
 *  Returns the body's `Result` or the acquire-failure `Result`. */
export function withLifecycleLock<T>(
  cawsDir: string,
  body: () => Result<T>,
  options: AcquireLifecycleLockOptions = {}
): Result<T> {
  const acquired = acquireLifecycleLock(cawsDir, options);
  if (!acquired.ok) {
    return acquired;
  }
  try {
    return body();
  } finally {
    releaseLifecycleLock(acquired.value);
  }
}
