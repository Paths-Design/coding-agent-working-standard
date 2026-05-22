// Sparse-checkout helper for CAWS-created worktrees
// (WORKTREE-SPEC-AUTHORITY-CONTROL-PLANE-001 A1).
//
// CAWS state is control-plane. The .caws/specs/ directory exists exactly
// once for the project, owned by the main checkout. When `caws worktree
// create` adds a linked worktree, git's default full checkout would
// materialize .caws/specs/<id>.yaml into the worktree filesystem,
// producing the v10.2 split-brain authority class: an editable spec
// copy inside the worktree, divergent from control-plane bytes,
// silently consulted by anything that walks cwd upward.
//
// This helper configures non-cone sparse-checkout on a freshly-added
// worktree so the .caws/specs/ tree is excluded from checkout. The
// rest of the worktree is a normal full checkout — the historic
// objection to sparse-checkout (broken cross-module imports caused by
// nearly-empty worktrees) is preserved by including everything OTHER
// than the authority files.
//
// Sparse-checkout vs the worktree-guard.sh hook policy: the hook
// (`.claude/hooks/worktree-guard.sh:52-56`) blocks agent-issued
// `git sparse-checkout` commands because sparse-checkout can be
// misused to hide source files and break work. This helper's use is
// different: it excludes ONLY the .caws/specs/ authority files, never
// source code, and runs from the CLI writer (via child_process.spawn)
// which does not go through the Bash tool hook surface. The hook's
// purpose is preserved.
//
// Pattern: `/*` includes everything; `!/.caws/specs/` excludes the
// authority directory. Non-cone mode is required because cone mode
// would force enumeration of all top-level directories. Non-cone
// sparse-checkout requires git 2.27+, which is documented in the
// spec's non_functional.reliability clause.

import { execFileSync } from 'child_process';

/**
 * Configure non-cone sparse-checkout on `wtPath` so that `.caws/specs/`
 * is excluded from checkout, then run `git checkout` to materialize the
 * remaining tree.
 *
 * Returns Result-shape `{ ok: true }` on success or `{ ok: false,
 * reason }` on the first failing git invocation. The caller is
 * responsible for compensating side effects (typically by running
 * `git worktree remove --force <wtPath>` on the partially-created
 * worktree).
 *
 * IMPORTANT: this function does NOT call `git worktree add`. The caller
 * must have already added the worktree with `--no-checkout` so that no
 * files have been materialized yet. Calling this on a worktree that
 * was added with a normal full checkout would not retroactively remove
 * already-checked-out `.caws/specs/` files.
 */
export function configureWorktreeSparseCheckout(
  wtPath: string,
): { ok: true } | { ok: false; reason: string; step: 'init' | 'set' | 'checkout' } {
  // 1) Initialize sparse-checkout in non-cone mode.
  const initResult = runGit(wtPath, ['sparse-checkout', 'init', '--no-cone']);
  if (!initResult.ok) return { ok: false, reason: initResult.reason, step: 'init' };

  // 2) Set the pattern: include everything, exclude .caws/specs/.
  //    Non-cone mode interprets these as gitignore-style patterns
  //    relative to the worktree root. The leading slash in '/.caws/specs/'
  //    anchors the exclusion to the worktree root (not subdirectories
  //    named .caws/specs/ further down — there are none in this
  //    project, but the anchor is correct discipline).
  const setResult = runGit(wtPath, [
    'sparse-checkout',
    'set',
    '--no-cone',
    '/*',
    '!/.caws/specs/',
  ]);
  if (!setResult.ok) return { ok: false, reason: setResult.reason, step: 'set' };

  // 3) Materialize the included files. `git worktree add --no-checkout`
  //    leaves the worktree empty; this populates everything sparse-
  //    checkout admits.
  const checkoutResult = runGit(wtPath, ['checkout']);
  if (!checkoutResult.ok)
    return { ok: false, reason: checkoutResult.reason, step: 'checkout' };

  return { ok: true };
}

function runGit(cwd: string, args: readonly string[]): { ok: true; stdout: string } | { ok: false; reason: string } {
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
          : (cause.message ?? 'unknown git error');
    return { ok: false, reason: stderr.trim() };
  }
}
