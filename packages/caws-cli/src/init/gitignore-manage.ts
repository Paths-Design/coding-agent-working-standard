// Manage a marked, idempotent CAWS block in the repo-root .gitignore
// (CAWS-INIT-GITIGNORE-MANAGE-001).
//
// PROBLEM this solves: `caws init` (via initProject) writes runtime artifacts
// to disk — agents.json, worktrees.json — and the hook pack / event-log writer
// later write leases/, events.jsonl, caches. Without ignore rules these land
// untracked-but-not-ignored, inviting accidental commits via the very
// `git add .caws/` the init "Next:" hint suggests. This module writes a fenced,
// version-marked block listing the EPHEMERAL .caws/ paths so they are ignored,
// while AUTHORITY state (.caws/specs/, .caws/policy.yaml, .caws/waivers/) is
// never matched and stays tracked.
//
// The block is owned by caws ONLY between its markers; everything else in
// .gitignore is preserved verbatim. Re-running init updates the block in place
// (a version bump refreshes the entries) and never duplicates it.

import * as fs from 'fs';
import * as path from 'path';

/** Bump when the managed entry set changes; the markers carry it so a stale
 * block (older version) is detected and replaced in place.
 * v2: added `tmp/guard-strikes-*.json` (defense-in-depth for any legacy
 * guard-strike file that lands in a tracked `tmp/`;
 * CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001). */
export const GITIGNORE_BLOCK_VERSION = 2;

export const GITIGNORE_BEGIN_MARKER = `# >>> caws gitignore (managed, v${GITIGNORE_BLOCK_VERSION}) >>>`;
export const GITIGNORE_END_MARKER = '# <<< caws gitignore <<<';

/** Marker prefix without the version — used to detect ANY managed block
 * (including a stale one with a different version) for in-place replacement. */
const BEGIN_MARKER_PREFIX = '# >>> caws gitignore (managed';

/**
 * The ephemeral / runtime / local .caws/ paths that must never be tracked.
 * Each entry names a path some CAWS code path writes:
 *   - worktrees.json / worktrees/  : worktree registry + checkouts (per-CLI)
 *   - agents.json / leases/        : per-session lease cache (agent hooks)
 *   - events.jsonl[.lock]          : append-only event log (runtime)
 *   - cache/ sessions/ state/      : runtime caches
 *   - duplication-cache.json       : god-object/duplication scan cache
 *   - tmp/guard-strikes-*.json     : scope-guard strike-state (defense-in-depth)
 * AUTHORITY state (specs/, policy.yaml, waivers/) is intentionally ABSENT so it
 * stays tracked. Mirrors the canonical CAWS repo .gitignore classification.
 *
 * The `tmp/guard-strikes-*.json` entry is a backstop. Since
 * CAWS-GUARD-STRIKE-FILE-OUT-OF-TREE-001 the scope-guard writes per-worktree
 * strike state under the worktree's gitdir (outside every working tree), so it
 * can no longer leak via `git add -A`. This entry still ignores any strike file
 * a pre-relocation hook left in a tracked `tmp/`, so an old repo that re-inits
 * never re-commits one (friction-probe Event 5).
 */
export const EPHEMERAL_CAWS_ENTRIES: readonly string[] = [
  '.caws/worktrees/',
  '.caws/worktrees.json',
  '.caws/agents.json',
  '.caws/leases/',
  '.caws/cache/',
  '.caws/sessions/',
  '.caws/state/',
  '.caws/duplication-cache.json',
  '.caws/events.jsonl',
  '.caws/events.jsonl.lock',
  'tmp/guard-strikes-*.json',
];

/** The full managed block text (markers + comment + entries), no trailing
 * newline (the writer controls separators). */
export function renderManagedBlock(): string {
  return [
    GITIGNORE_BEGIN_MARKER,
    '# Ephemeral CAWS runtime/local state — never tracked. Authority state',
    '# (.caws/specs/, .caws/policy.yaml, .caws/waivers/) is intentionally NOT',
    '# listed here so it stays versioned. Managed by `caws init`; edits inside',
    '# these markers are overwritten on the next init.',
    ...EPHEMERAL_CAWS_ENTRIES,
    GITIGNORE_END_MARKER,
  ].join('\n');
}

export type GitignoreOutcome =
  | 'created' // .gitignore did not exist; created with the block
  | 'block_added' // existing file had no managed block; appended
  | 'block_updated' // a stale/different managed block was replaced in place
  | 'unchanged' // managed block already current (byte-identical)
  | 'adopted' // --adopt and no managed block present; nothing written
  | 'write_failed'; // I/O error (advisory — init still exits 0)

export interface GitignoreManageResult {
  readonly outcome: GitignoreOutcome;
  readonly gitignorePath: string;
  /** Present on write_failed. */
  readonly error?: string;
}

/** Find the [start,end] line indices (inclusive) of an existing managed block,
 * or null if absent. Detection keys on the marker lines, not entry contents,
 * so a stale (different-version) block is still found and replaced. */
function findManagedBlock(
  lines: readonly string[]
): { start: number; end: number } | null {
  const start = lines.findIndex((l) => l.startsWith(BEGIN_MARKER_PREFIX));
  if (start === -1) return null;
  const end = lines.findIndex(
    (l, i) => i >= start && l.trim() === GITIGNORE_END_MARKER
  );
  if (end === -1) return null;
  return { start, end };
}

/**
 * Compute the new .gitignore content given the existing content (or null if the
 * file does not exist) and the flags. Pure — does no I/O — so it is directly
 * unit-testable. Returns the new content plus the outcome classification.
 *
 * Contract:
 *   - no file + default/overwrite  → create with just the block ('created')
 *   - no file + adopt              → no file written ('adopted')
 *   - file, no managed block, default/overwrite → append block after a single
 *     blank-line separator, preserving existing content ('block_added')
 *   - file, no managed block, adopt → leave as-is ('adopted')
 *   - file, managed block present, current → no change ('unchanged')
 *   - file, managed block present, stale → replace block region in place,
 *     content outside markers untouched ('block_updated')
 *   - file, managed block present, adopt → leave as-is ('unchanged' if current,
 *     else still left as-is and reported 'unchanged' — adopt never rewrites)
 */
export function computeGitignore(
  existing: string | null,
  opts: { adopt?: boolean } = {}
): { content: string | null; outcome: GitignoreOutcome } {
  const block = renderManagedBlock();
  const adopt = opts.adopt === true;

  if (existing === null) {
    if (adopt) return { content: null, outcome: 'adopted' };
    // New file: block + trailing newline.
    return { content: `${block}\n`, outcome: 'created' };
  }

  const lines = existing.split('\n');
  const found = findManagedBlock(lines);

  if (found === null) {
    if (adopt) return { content: existing, outcome: 'adopted' };
    // Append after existing content with exactly one blank-line separator.
    // Normalize: strip trailing blank lines, then add one blank line + block.
    const trimmedEnd = existing.replace(/\n*$/, '');
    const separator = trimmedEnd.length > 0 ? '\n\n' : '';
    return {
      content: `${trimmedEnd}${separator}${block}\n`,
      outcome: 'block_added',
    };
  }

  // A managed block exists. Adopt never rewrites a present block.
  const currentBlockLines = lines.slice(found.start, found.end + 1);
  const isCurrent = currentBlockLines.join('\n') === block;
  if (isCurrent || adopt) {
    return { content: existing, outcome: 'unchanged' };
  }

  // Replace the block region in place; content outside the markers untouched.
  const before = lines.slice(0, found.start);
  const after = lines.slice(found.end + 1);
  const rebuilt = [...before, ...block.split('\n'), ...after].join('\n');
  return { content: rebuilt, outcome: 'block_updated' };
}

/**
 * Apply the managed .gitignore block at the repo root. Writes only when the
 * computed content differs from disk. Never throws — an I/O failure is returned
 * as a 'write_failed' outcome (advisory; init treats it as a warning, not a
 * hard error).
 */
export function manageGitignore(
  repoRoot: string,
  opts: { adopt?: boolean } = {}
): GitignoreManageResult {
  const gitignorePath = path.join(repoRoot, '.gitignore');
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    existing = null; // ENOENT (or unreadable) → treat as absent.
  }

  const { content, outcome } = computeGitignore(existing, opts);

  // No write needed for unchanged / adopted (content === existing or null).
  if (outcome === 'unchanged' || outcome === 'adopted') {
    return { outcome, gitignorePath };
  }

  if (content === null) {
    return { outcome, gitignorePath };
  }

  try {
    fs.writeFileSync(gitignorePath, content, 'utf8');
    return { outcome, gitignorePath };
  } catch (e) {
    return {
      outcome: 'write_failed',
      gitignorePath,
      error: (e as Error).message,
    };
  }
}
