// Working-tree overlap predicate (WORKING-TREE-PROVENANCE-GUARD-001).
//
// Pure, deterministic classification: given a snapshot of active sessions'
// ownership metadata (claimed_paths / last_modified_paths on leases) and a
// current dirty-tree path list, report which other sessions have overlap.
//
// This is the same predicate the PreToolUse guard and `caws working-tree
// check` consume (advisory/refusal surface, NEVER authority — it does not
// change scope, claim, ownership, or lifecycle decisions). No git mutation,
// no fs writes, no events. Read of the dirty list is the only git call.
//
// Path matching mirrors scope.in admission semantics: a plain directory entry
// matches itself or any descendant on a path boundary; a glob entry is an
// anchored `*`/`?` pattern. (Intentional local copy — the store layer cannot
// import from shell, and the precedent is a small local copy for a shared
// matcher.)

import * as fs from 'node:fs';
import * as path from 'node:path';

import { isOk, type AgentLease } from '../kernel';
import { loadLeases } from './leases-store';
import { runGit } from './repo-root';

export interface SessionOverlap {
  readonly sessionId: string;
  readonly overlappingPaths: readonly string[];
  readonly source: 'claimed_paths' | 'last_modified_paths' | 'both';
}

export interface WorkingTreeOverlapResult {
  readonly overlaps: readonly SessionOverlap[];
  /** Dirty paths that are NOT below any other session's claimed/modified set. */
  readonly noOverlapPaths: readonly string[];
  /** Dirty paths that appeared twice in `git status` (worktree+index) — deduped. */
  readonly unknownPaths: readonly string[];
  /** Sessions whose lease carried neither field, so no overlap was possible. */
  readonly metadataUnavailable: readonly string[];
}

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function pathEntryMatches(entry: string, target: string): boolean {
  const e = normalizeRel(entry);
  const t = normalizeRel(target);
  if (e === t) return true;
  if (!/[*?]/.test(e)) return t.startsWith(e + '/');
  const rx = e
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${rx}$`).test(t);
}

function matchesAny(entries: readonly string[] | undefined, target: string): boolean {
  if (entries === undefined || entries.length === 0) return false;
  return entries.some((e) => pathEntryMatches(e, target));
}

/** Pure classification over a sessions snapshot + a dirty-path set. */
export function classifyWorkingTreeOverlap(input: {
  readonly selfSessionId: string;
  readonly sessions: readonly {
    readonly session_id: string;
    readonly claimed_paths?: readonly string[];
    readonly last_modified_paths?: readonly string[];
  }[];
  readonly dirtyPaths: readonly string[];
}): WorkingTreeOverlapResult {
  const overlaps: SessionOverlap[] = [];
  const noOverlapPaths: string[] = [];
  const metadataUnavailable: string[] = [];

  // Dedupe the dirty set (git status can report a path twice).
  const seen = new Set<string>();
  const dirtySet: string[] = [];
  for (const p of input.dirtyPaths) {
    const norm = normalizeRel(p);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    dirtySet.push(norm);
  }

  for (const session of input.sessions) {
    if (session.session_id === input.selfSessionId) continue; // self-overlap is fine
    const claimed = session.claimed_paths ?? [];
    const modified = session.last_modified_paths ?? [];
    if (claimed.length === 0 && modified.length === 0) {
      metadataUnavailable.push(session.session_id);
      continue;
    }
    const claimedOverlap = dirtySet.filter((p) => matchesAny(claimed, p));
    const modifiedOverlap = dirtySet.filter((p) => matchesAny(modified, p));
    const overlappingPaths = Array.from(new Set([...claimedOverlap, ...modifiedOverlap]));
    if (overlappingPaths.length === 0) continue;
    overlaps.push({
      sessionId: session.session_id,
      overlappingPaths,
      source:
        claimedOverlap.length > 0 && modifiedOverlap.length > 0
          ? 'both'
          : claimedOverlap.length > 0
            ? 'claimed_paths'
            : 'last_modified_paths',
    });
  }

  const overlapSet = new Set<string>();
  for (const o of overlaps) for (const p of o.overlappingPaths) overlapSet.add(p);
  for (const p of dirtySet) if (!overlapSet.has(p)) noOverlapPaths.push(p);

  return {
    overlaps,
    noOverlapPaths,
    unknownPaths: [],
    metadataUnavailable,
  };
}

/** Load the active-session ownership snapshot from `.caws/leases/`. */
export function loadOwnershipSessions(cawsDir: string): readonly {
  readonly session_id: string;
  readonly platform: string;
  readonly claimed_paths?: readonly string[];
  readonly last_modified_paths?: readonly string[];
}[] {
  const loaded = loadLeases(cawsDir);
  if (!isOk(loaded)) return [];
  return Object.values(loaded.value.leases).map(
    (lease: AgentLease) => ({
      session_id: lease.session_id,
      platform: lease.platform,
      ...(lease.claimed_paths !== undefined ? { claimed_paths: lease.claimed_paths } : {}),
      ...(lease.last_modified_paths !== undefined ? { last_modified_paths: lease.last_modified_paths } : {}),
    })
  );
}

/** Read the current dirty-tree paths via `git status --porcelain`. */
export function loadDirtyPaths(repoRoot: string): readonly string[] {
  // --untracked-files=all: enumerate individual untracked files instead of
  // collapsing a whole untracked directory to "src/" (which would miss the
  // specific paths a claim/overlap compares against).
  const res = runGit(['status', '--porcelain', '-z', '--untracked-files=all'], repoRoot);
  if (!res.ok) return [];
  const records = res.stdout.split('\0').filter((r) => r.length > 0);
  const paths: string[] = [];
  for (const record of records) {
    // Porcelain -z: "<XY> <path>\0" (or "<XY> <renamed>\0<dest>\0" for renames).
    const secondSpace = record.indexOf(' ', 2);
    let p = secondSpace >= 0 ? record.slice(secondSpace + 1) : record.slice(3);
    // Operational .caws/ bookkeeping is not working-tree content being
    // stashed/cleaned, and is gitignored in real repos; exclude it so it never
    // registers as overlap.
    if (p.startsWith('.caws/') || p === '.caws') continue;
    p = normalizeRel(p);
    if (p.length > 0) paths.push(p);
  }
  return paths;
}

/** Compose the full read-only overlap check. */
export function checkWorkingTreeOverlap(
  cawsDir: string,
  repoRoot: string,
  selfSessionId: string | undefined
): WorkingTreeOverlapResult {
  const sessions = loadOwnershipSessions(cawsDir);
  const dirtyPaths = loadDirtyPaths(repoRoot);
  return classifyWorkingTreeOverlap({
    selfSessionId: selfSessionId ?? '',
    sessions,
    dirtyPaths,
  });
}

/** Whether a directory exists (defensive compose helper). */
export function hasOwnershipMetadata(cawsDir: string): boolean {
  return fs.existsSync(path.join(cawsDir, 'leases'));
}
