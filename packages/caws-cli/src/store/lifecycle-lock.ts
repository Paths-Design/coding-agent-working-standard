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
// Recovery requires an aged file and a demonstrably dead process. A separate
// exclusive reclaimer serializes inspection and the one unlink; it is never
// stolen. A crashed reclaimer fails closed pending recovery after quiescence.
// Release belongs to a private handle, never merely to a pathname or fd number.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { err, ok, type Result } from '../kernel';

import { sleepSyncMs, storeDiagnostic } from './repo-root';
import { STORE_RULES } from './rules';
import { verifyInheritedFence } from '../execution/fence';
import type { FenceObservation } from '../execution/prepared';

const LOCK_FILE_NAME = 'state.lock';
const LOCK_MAX_ATTEMPTS = 3;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 30_000;

export interface LifecycleLockHandle {
  readonly fd: number;
  readonly lockPath: string;
}

interface LockIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

const heldLocks = new WeakMap<LifecycleLockHandle, LockIdentity>();

function sameFile(left: LockIdentity, right: LockIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    /* best effort */
  }
}

function unlinkOwnedPath(lockPath: string, identity: LockIdentity): void {
  try {
    if (sameFile(identity, fs.lstatSync(lockPath, { bigint: true }))) fs.unlinkSync(lockPath);
  } catch {
    // Missing, replaced, or inaccessible is not permission to remove a lock.
  }
}

export interface AcquireLifecycleLockOptions {
  /** Refuse existing locks without inspecting or reclaiming their owner. */
  readonly recoverStale?: boolean;
  /** Override the global lock path. Used by tests; production callers
   *  pass cawsDir and get the canonical `<cawsDir>/state.lock`. */
  readonly lockPath?: string;
  /** Minimum age before dead-owner recovery, default 30s. Live, unknown and
   *  inaccessible owners remain protected beyond this threshold. */
  readonly staleThresholdMs?: number;
  /** Override max attempts. Defaults to 3. */
  readonly maxAttempts?: number;
  /** Override retry delay. Defaults to 50ms. */
  readonly retryDelayMs?: number;
}

function tryRecoverStaleLock(lockPath: string, staleThresholdMs: number): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd: number;
  try {
    reclaimFd = fs.openSync(reclaimPath, 'wx', 0o600);
  } catch {
    return false;
  }
  let reclaimIdentity: LockIdentity | undefined;
  let lockFd: number | undefined;
  try {
    reclaimIdentity = fs.fstatSync(reclaimFd, { bigint: true });
    // Re-read after becoming the sole reclaimer. A predecessor may have
    // recovered the old holder and an ordinary caller acquired its successor.
    lockFd = fs.openSync(
      lockPath,
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
    );
    const stat = fs.fstatSync(lockFd, { bigint: true });
    if (!stat.isFile() || stat.size > 4096n) return false;
    if (Date.now() - Number(stat.mtimeMs) <= staleThresholdMs) return false;
    const metadata = JSON.parse(fs.readFileSync(lockFd, 'utf8')) as {
      pid?: unknown;
      hostname?: unknown;
    };
    if (
      !Number.isSafeInteger(metadata.pid) ||
      (metadata.pid as number) <= 0 ||
      (metadata.hostname !== undefined && metadata.hostname !== os.hostname())
    )
      return false;
    try {
      process.kill(metadata.pid as number, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
    if (!sameFile(stat, fs.lstatSync(lockPath, { bigint: true }))) return false;
    // Exactly one unlink. New acquisition may happen immediately afterward;
    // this reclaimer never unlinks the main path again.
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  } finally {
    if (lockFd !== undefined) closeQuietly(lockFd);
    if (reclaimIdentity !== undefined) unlinkOwnedPath(reclaimPath, reclaimIdentity);
    closeQuietly(reclaimFd);
  }
}

/**
 * Acquire the global lifecycle mutation lock. Returns a `LifecycleLockHandle`
 * the caller MUST release via `releaseLifecycleLock` in a `finally` block.
 *
 * The lock is held by the existence of `<cawsDir>/state.lock`. Concurrent
 * callers retry up to `maxAttempts` with `retryDelayMs` between attempts.
 * Aged locks are reclaimed only when their recorded local PID is demonstrably dead.
 * Unknown ownership and abandoned reclaimer files fail closed. This protocol
 * assumes no external replacement of the held lock or reclaimer pathname.
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
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      let identity: LockIdentity | undefined;
      try {
        identity = fs.fstatSync(fd, { bigint: true });
        fs.writeFileSync(
          fd,
          JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            at: new Date().toISOString(),
            purpose: 'lifecycle-mutation',
          })
        );
        fs.fsyncSync(fd);
      } catch (error) {
        if (identity !== undefined) unlinkOwnedPath(lockPath, identity);
        closeQuietly(fd);
        throw error;
      }
      const handle = Object.freeze({ fd, lockPath });
      heldLocks.set(handle, identity);
      return ok(handle);
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
      const recovered =
        options.recoverStale !== false && tryRecoverStaleLock(lockPath, staleThresholdMs);
      if (!recovered && attempt + 1 < maxAttempts) {
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

/** Check a genuine live acquisition, refusing structural fd/path copies. */
export function verifyLifecycleLock(handle: LifecycleLockHandle): boolean {
  const identity = heldLocks.get(handle);
  if (identity === undefined) return false;
  try {
    const held = fs.fstatSync(handle.fd, { bigint: true });
    const named = fs.lstatSync(handle.lockPath, { bigint: true });
    return (
      held.isFile() &&
      named.isFile() &&
      held.nlink === 1n &&
      named.nlink === 1n &&
      sameFile(identity, held) &&
      sameFile(identity, named)
    );
  } catch {
    return false;
  }
}

/** Release only this acquisition, once. A reused descriptor or successor
 *  pathname never belongs to a previously released handle. */
export function releaseLifecycleLock(handle: LifecycleLockHandle): void {
  const identity = heldLocks.get(handle);
  if (identity === undefined) return;
  heldLocks.delete(handle);
  try {
    if (!sameFile(identity, fs.fstatSync(handle.fd, { bigint: true }))) return;
  } catch {
    return;
  }
  // Keep the descriptor open through unlink to prevent inode recycling.
  unlinkOwnedPath(handle.lockPath, identity);
  closeQuietly(handle.fd);
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

/** Private direct-native-child capability. It is neither a reentrant lock nor
 * permission to release the parent's lock. Only explicit lifecycle consumers
 * thread this capability through their composed store calls. */
export interface BorrowedExecutionLifecycleFence {
  readonly cawsDir: string;
  readonly fence: FenceObservation;
}
const borrowedExecutionFences = new WeakSet<BorrowedExecutionLifecycleFence>();

export function borrowExecutionLifecycleFence(
  cawsDir: string,
  fence: FenceObservation
): BorrowedExecutionLifecycleFence {
  if (!verifyInheritedFence(cawsDir, fence)) throw new Error('Execution fence unavailable');
  const capability = Object.freeze({ cawsDir, fence: Object.freeze({ ...fence }) });
  borrowedExecutionFences.add(capability);
  return capability;
}

export function withLifecycleMutationFence<T>(
  cawsDir: string,
  body: () => Result<T>,
  borrowed?: BorrowedExecutionLifecycleFence
): Result<T> {
  if (borrowed === undefined) return withLifecycleLock(cawsDir, body);
  if (!verifyBorrowedExecutionLifecycleFence(cawsDir, borrowed))
    return err(
      storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, 'Execution fence unavailable.')
    );
  return body();
}

/** Hold one fail-fast publication fence; never reclaim or release another owner. */
export function withLifecyclePublicationFence<T>(
  cawsDir: string,
  body: (current: () => boolean) => Result<T>,
  borrowed?: BorrowedExecutionLifecycleFence
): Result<T> {
  if (borrowed !== undefined) {
    const current = (): boolean => verifyBorrowedExecutionLifecycleFence(cawsDir, borrowed);
    if (!current())
      return err(
        storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, 'Execution fence unavailable.')
      );
    return body(current);
  }
  const acquired = acquireLifecycleLock(cawsDir, {
    maxAttempts: 1,
    retryDelayMs: 0,
    recoverStale: false,
  });
  if (!acquired.ok) return acquired;
  try {
    const current = (): boolean => verifyLifecycleLock(acquired.value);
    if (!current())
      return err(
        storeDiagnostic(
          STORE_RULES.LIFECYCLE_PLAN_REJECTED,
          'Lifecycle publication fence unavailable.'
        )
      );
    return body(current);
  } finally {
    releaseLifecycleLock(acquired.value);
  }
}

export function verifyBorrowedExecutionLifecycleFence(
  cawsDir: string,
  borrowed: BorrowedExecutionLifecycleFence
): boolean {
  return (
    borrowedExecutionFences.has(borrowed) &&
    borrowed.cawsDir === cawsDir &&
    verifyInheritedFence(cawsDir, borrowed.fence)
  );
}
