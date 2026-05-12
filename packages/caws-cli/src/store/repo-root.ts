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
