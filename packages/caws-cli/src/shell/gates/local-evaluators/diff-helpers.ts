// Staged-diff helpers for local gate evaluators.
//
// These helpers shell out to git to enumerate staged file changes and
// their insertion counts. They are the only place local evaluators
// touch git; the evaluators themselves remain pure (path lists + numbers
// in, violations out).

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolveGitBinary } from '../../../store/git-binary';

export interface StagedFileChange {
  /** Repo-relative POSIX path of the changed file. */
  readonly path: string;
  /** Lines added in the staged diff. `null` for binary files. */
  readonly insertions: number | null;
  /** Lines deleted in the staged diff. `null` for binary files. */
  readonly deletions: number | null;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync(resolveGitBinary(), [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

/**
 * List staged files with line-count deltas. Git errors propagate: a failed
 * read must never masquerade as an empty set of changes.
 *
 * `--cached` is used so the contract matches `--context=commit`. The
 * caller may swap to `--diff-filter` or other working-tree shapes if a
 * different context is needed; v11.1 only ships the commit context.
 */
export function listStagedChanges(repoRoot: string): readonly StagedFileChange[] {
  return parseNumstat(runGit(['diff', '--cached', '--no-renames', '--numstat', '-z'], repoRoot));
}

function parseNumstat(raw: string): readonly StagedFileChange[] {
  // --numstat -z output: `\d+\t\d+\t<path>\0` per record. Binary files
  // show `-\t-\t<path>\0`.
  const records: StagedFileChange[] = [];
  for (const rec of raw.split('\0')) {
    if (rec.length === 0) continue;
    const tab1 = rec.indexOf('\t');
    if (tab1 === -1) throw new Error('Malformed Git numstat record');
    const tab2 = rec.indexOf('\t', tab1 + 1);
    if (tab2 === -1) throw new Error('Malformed Git numstat record');
    const addsRaw = rec.slice(0, tab1);
    const delsRaw = rec.slice(tab1 + 1, tab2);
    const path = rec.slice(tab2 + 1);
    if (path.length === 0 || !/^(\d+|-)$/u.test(addsRaw) || !/^(\d+|-)$/u.test(delsRaw)) {
      throw new Error('Malformed Git numstat path or counts');
    }
    records.push({
      path,
      insertions: addsRaw === '-' ? null : Number.parseInt(addsRaw, 10),
      deletions: delsRaw === '-' ? null : Number.parseInt(delsRaw, 10),
    });
  }
  return records;
}

export interface GateChangeBasis {
  readonly kind: 'staged' | 'branch_and_staged';
  readonly checkout: string;
  readonly head_sha: string;
  readonly base_ref: string | null;
  readonly base_sha: string | null;
  readonly merge_base_sha: string | null;
  readonly index_sha256: string;
  readonly files_evaluated: number;
}

/** Snapshot each diff once. No rename detection: both source and destination
 * paths must be checked. Git failures throw; unavailable is never empty. */
export function readGateChanges(
  checkout: string,
  baseRef?: string
): {
  changes: readonly StagedFileChange[];
  basis: GateChangeBasis;
} {
  const head = runGit(['rev-parse', '--verify', 'HEAD'], checkout).trim();
  const index = runGit(['ls-files', '--stage', '-z'], checkout);
  const staged = runGit(['diff', '--cached', '--no-renames', '--numstat', '-z'], checkout);
  const changes = new Map<string, StagedFileChange>();
  let base: string | null = null;
  let ancestor: string | null = null;
  if (baseRef !== undefined) {
    base = runGit(
      ['rev-parse', '--verify', '--end-of-options', `${baseRef}^{commit}`],
      checkout
    ).trim();
    ancestor = runGit(['merge-base', base, head], checkout).trim();
    for (const change of parseNumstat(
      runGit(['diff', '--no-renames', '--numstat', '-z', ancestor, head, '--'], checkout)
    )) {
      changes.set(change.path, change);
    }
  }
  for (const change of parseNumstat(staged)) {
    const prior = changes.get(change.path);
    changes.set(
      change.path,
      prior === undefined
        ? change
        : {
            path: change.path,
            insertions:
              prior.insertions === null || change.insertions === null
                ? null
                : prior.insertions + change.insertions,
            deletions:
              prior.deletions === null || change.deletions === null
                ? null
                : prior.deletions + change.deletions,
          }
    );
  }
  if (baseRef === undefined && changes.size === 0) {
    throw new Error(
      'No staged changes and no branch basis. Supply --base <ref> to evaluate committed work; an empty index does not qualify it.'
    );
  }
  if (
    runGit(['rev-parse', '--verify', 'HEAD'], checkout).trim() !== head ||
    runGit(['ls-files', '--stage', '-z'], checkout) !== index
  ) {
    throw new Error('HEAD or index changed during scope evaluation; retry against stable inputs.');
  }
  return {
    changes: [...changes.values()].sort((a, b) => a.path.localeCompare(b.path)),
    basis: {
      kind: baseRef === undefined ? 'staged' : 'branch_and_staged',
      checkout,
      head_sha: head,
      base_ref: baseRef ?? null,
      base_sha: base,
      merge_base_sha: ancestor,
      index_sha256: createHash('sha256').update(index).digest('hex'),
      files_evaluated: changes.size,
    },
  };
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
