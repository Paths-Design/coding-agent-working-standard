// Staged-diff helpers for local gate evaluators.
//
// These helpers shell out to git to enumerate staged file changes and
// their insertion counts. They are the only place local evaluators
// touch git; the evaluators themselves remain pure (path lists + numbers
// in, violations out).

import { execFileSync } from 'node:child_process';

export interface StagedFileChange {
  /** Repo-relative POSIX path of the changed file. */
  readonly path: string;
  /** Lines added in the staged diff. `null` for binary files. */
  readonly insertions: number | null;
  /** Lines deleted in the staged diff. `null` for binary files. */
  readonly deletions: number | null;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/**
 * List staged files with line-count deltas. Returns an empty array on
 * any git error (no commits yet, not a repo, etc.) — the caller decides
 * what an empty-diff means for their gate.
 *
 * `--cached` is used so the contract matches `--context=commit`. The
 * caller may swap to `--diff-filter` or other working-tree shapes if a
 * different context is needed; v11.1 only ships the commit context.
 */
export function listStagedChanges(repoRoot: string): readonly StagedFileChange[] {
  let raw: string;
  try {
    raw = runGit(['diff', '--cached', '--numstat', '-z'], repoRoot);
  } catch {
    return [];
  }
  // --numstat -z output: `\d+\t\d+\t<path>\0` per record. Binary files
  // show `-\t-\t<path>\0`.
  const records: StagedFileChange[] = [];
  for (const rec of raw.split('\0')) {
    if (rec.length === 0) continue;
    const tab1 = rec.indexOf('\t');
    if (tab1 === -1) continue;
    const tab2 = rec.indexOf('\t', tab1 + 1);
    if (tab2 === -1) continue;
    const addsRaw = rec.slice(0, tab1);
    const delsRaw = rec.slice(tab1 + 1, tab2);
    const path = rec.slice(tab2 + 1);
    if (path.length === 0) continue;
    records.push({
      path,
      insertions: addsRaw === '-' ? null : Number.parseInt(addsRaw, 10),
      deletions: delsRaw === '-' ? null : Number.parseInt(delsRaw, 10),
    });
  }
  return records;
}

/**
 * Total inserted lines across staged changes. Binary files (`null`
 * insertions) contribute 0 to the LOC count — they are governed by
 * file count instead.
 */
export function totalInsertions(changes: readonly StagedFileChange[]): number {
  let n = 0;
  for (const c of changes) {
    if (typeof c.insertions === 'number') n += c.insertions;
  }
  return n;
}
