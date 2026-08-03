// Resolve the canonical CAWS repo root.
//
// CAWS lives under a single `.caws/` directory in the *main* repository,
// not under linked worktrees. A worktree's `.git` is a file pointing at
// `<main>/.git/worktrees/<name>/`. Using `git rev-parse --show-toplevel`
// from inside a worktree would return the WORKTREE's filesystem root,
// not the main repo's — and any path derived from it would write state
// into the worktree's filesystem.
//
// The correct authority is:
//
//   git rev-parse --path-format=absolute --git-common-dir
//
// which returns `<main>/.git` regardless of where the caller stands. The
// CAWS repo root is the parent of that directory. The `.caws/` directory
// is one level deeper.

import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  diagnostic,
  err,
  ok,
  SPEC_ID_REGEX,
  type Diagnostic,
  type Result,
} from '@paths.design/caws-kernel';
import { STORE_RULES } from './rules';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface RepoRoot {
  /** Absolute path to the main repository root (parent of .git common dir). */
  readonly repoRoot: string;
  /** Absolute path to the .caws/ directory under the repo root. */
  readonly cawsDir: string;
}

/**
 * Pluggable git invoker. Tests stub this; production uses execFileSync.
 *
 * Returns the trimmed stdout on success, or throws on non-zero exit. The
 * caller distinguishes "not a git repo" by inspecting the thrown error's
 * stderr / status, which production execFileSync surfaces.
 */
export type GitRunner = (
  args: readonly string[],
  options: { cwd: string }
) => string;

export const defaultGitRunner: GitRunner = (args, options) => {
  const execOptions: ExecFileSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  return execFileSync('git', args, execOptions).trim();
};

/**
 * Run a git subprocess, returning a Result-shaped outcome (never throws).
 * The byte-identical twin formerly private to git-autocommit.ts and
 * worktrees-writer.ts. Spawns via execFileSync with stdio
 * `['ignore','pipe','pipe']` and utf8 encoding; on non-zero exit, captures
 * stderr into `reason` (falling back to the error message, then a literal).
 * (CAWS-REFACTOR-SHARED-UTILS-001.)
 *
 * NOTE: this is the result-shape helper. Divergent variants stay in place —
 * the THROWING runGit in shell/gates/local-evaluators/diff-helpers.ts, the
 * SWAPPED-arg runGit/gitOutput in git-sparse-checkout.ts and
 * shell/commands/worktree.ts, and the positional-cwd defaultGitRunner in
 * shell/commands/prepush.ts. Only the two identical twins consolidated.
 */
export function runGit(
  args: readonly string[],
  cwd: string
): { ok: true; stdout: string } | { ok: false; reason: string } {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout.toString() };
  } catch (e) {
    const cause = e as { message?: string; stderr?: Buffer | string };
    const stderr: string =
      cause.stderr instanceof Buffer
        ? cause.stderr.toString()
        : typeof cause.stderr === 'string'
          ? cause.stderr
          : '';
    const message: string = typeof cause.message === 'string' ? cause.message : '';
    return { ok: false, reason: stderr || message || 'unknown git error' };
  }
}

// ----------------------------------------------------------------------------
// Shared store-layer helpers (CAWS-REFACTOR-SHARED-UTILS-001)
//
// These were previously private copies in lifecycle-lock.ts, events-store.ts,
// messages-store.ts, git-autocommit.ts (sleep), and worktrees-writer.ts,
// specs-writer.ts, resolve-session.ts, specs-migration.ts (repo-root). They
// are byte-identical across their former homes; consolidating them here is a
// pure-mechanical refactor with no behavior change.
// ----------------------------------------------------------------------------

/**
 * Synchronous busy-wait sleep for the tens-of-ms inter-attempt delays used by
 * the file-lock and git-contention retry loops. This is a CPU-burning spin
 * over Date.now(), NOT a real sleep — it blocks the event loop and is
 * acceptable only for short contention backoff. Atomics.wait is the cleaner
 * tool but requires a SharedArrayBuffer setup; polling Date.now() is fine at
 * this scale. (Formerly duplicated in lifecycle-lock.ts, events-store.ts,
 * messages-store.ts as `sleepSync`/`sleepSyncMs`.)
 */
export function sleepSyncMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // intentional spin
  }
}

/**
 * Derive the git repo root from a known `.caws/` directory path. The repo
 * root is the parent of `.caws/`. Formerly a byte-identical private helper
 * (`repoRootFromCawsDir`) in worktrees-writer.ts and specs-writer.ts plus
 * inline `path.dirname(cawsDir)` copies in resolve-session.ts and
 * specs-migration.ts. The invariant `repoRoot === path.dirname(cawsDir)` is
 * documented at resolve-session.ts:219.
 */
export function repoRootFromCawsDir(cawsDir: string): string {
  return path.dirname(cawsDir);
}

/**
 * Validate a CAWS spec id against the canonical v11 grammar (shared from
 * the kernel's SPEC_ID_REGEX). STORE_RULES-flavored: emits
 * LIFECYCLE_PLAN_REJECTED via storeDiagnostic, so it stays on the shell
 * side even though the regex is pure kernel. The superset of the two
 * former private copies (worktrees-writer.ts and specs-writer.ts): it
 * carries the empty-string guard and the "e.g., FEAT-001" repair hint.
 * (CAWS-REFACTOR-SHARED-UTILS-001.)
 */
export function validateSpecId(id: string): Result<true> {
  if (typeof id !== 'string' || id.length === 0) {
    return err(
      storeDiagnostic(STORE_RULES.LIFECYCLE_PLAN_REJECTED, 'Spec id is required.', {
        subject: 'id',
      })
    );
  }
  if (!SPEC_ID_REGEX.test(id)) {
    return err(
      storeDiagnostic(
        STORE_RULES.LIFECYCLE_PLAN_REJECTED,
        `Spec id "${id}" does not match the v11 pattern (e.g., FEAT-001, CLI-SPECS-001).`,
        { subject: id, data: { pattern: SPEC_ID_REGEX.source } }
      )
    );
  }
  return ok(true as const);
}

// ----------------------------------------------------------------------------
// resolveRepoRoot
// ----------------------------------------------------------------------------

export interface ResolveRepoRootOptions {
  readonly git?: GitRunner;
  /**
   * If true, the .caws/ directory must already exist on disk. When false
   * (default) the function only resolves where it WOULD be, leaving
   * creation to a different layer (e.g., `caws init`).
   */
  readonly requireCawsDir?: boolean;
}

/**
 * Resolve the main-repo root from `cwd`, even when cwd is inside a linked
 * worktree.
 *
 * Returns Err when:
 *  - cwd is not inside a git repository, OR
 *  - git invocation fails for another reason, OR
 *  - `requireCawsDir: true` and `.caws/` does not exist.
 *
 * Programmer errors (cwd not a string, git binary missing) throw.
 */
export function resolveRepoRoot(
  cwd: string,
  options: ResolveRepoRootOptions = {}
): Result<RepoRoot> {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('resolveRepoRoot: cwd must be a non-empty string.');
  }

  const git = options.git ?? defaultGitRunner;

  let commonDir: string;
  try {
    commonDir = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
    });
  } catch (e) {
    const cause = e as { status?: number; stderr?: Buffer | string; message?: string };
    const stderr =
      typeof cause.stderr === 'string'
        ? cause.stderr
        : cause.stderr instanceof Buffer
          ? cause.stderr.toString('utf8')
          : '';
    // "not a git repository" surfaces on stderr.
    if (stderr.toLowerCase().includes('not a git repository')) {
      return err(
        diagnostic({
          rule: STORE_RULES.REPO_ROOT_NOT_A_GIT_REPO,
          authority: 'kernel/diagnostics',
          message: `${cwd} is not inside a git repository.`,
          subject: cwd,
          narrowRepair: 'Run `git init` or change directory to a repository.',
        })
      );
    }
    return err(
      diagnostic({
        rule: STORE_RULES.REPO_ROOT_GIT_INVOCATION_FAILED,
        authority: 'kernel/diagnostics',
        message: `git rev-parse failed: ${cause.message ?? 'unknown error'}.`,
        subject: cwd,
        data: { stderr },
      })
    );
  }

  // commonDir is the path to <main>/.git (or a separate gitdir). The
  // repository root is its parent. We do NOT use --show-toplevel.
  const repoRoot = path.dirname(commonDir);
  const cawsDir = path.join(repoRoot, '.caws');

  if (options.requireCawsDir && !fs.existsSync(cawsDir)) {
    return err(
      diagnostic({
        rule: STORE_RULES.REPO_ROOT_CAWS_DIR_MISSING,
        authority: 'kernel/diagnostics',
        message: `Resolved repo root has no .caws/ directory: ${repoRoot}.`,
        subject: repoRoot,
        narrowRepair: 'Run `caws init` to bootstrap the repository.',
      })
    );
  }

  return ok({ repoRoot, cawsDir });
}

// ----------------------------------------------------------------------------
// Helpers exposed for tests
// ----------------------------------------------------------------------------

/** Construct a structured Diagnostic with the canonical store authority. */
export function storeDiagnostic(
  rule: string,
  message: string,
  extra: { subject?: string; narrowRepair?: string; data?: Record<string, unknown> } = {}
): Diagnostic {
  return diagnostic({
    rule,
    authority: 'kernel/diagnostics',
    message,
    ...(extra.subject !== undefined ? { subject: extra.subject } : {}),
    ...(extra.narrowRepair !== undefined ? { narrowRepair: extra.narrowRepair } : {}),
    ...(extra.data !== undefined ? { data: extra.data } : {}),
  });
}
