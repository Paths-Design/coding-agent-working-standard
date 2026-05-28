// resolve-binding — turn (repoRoot, cwd, registry, specsBySpecId) into a
// `BindingState` plus a worktree-name resolution provenance.
//
// Algorithm:
//
//   1. Real-resolve repoRoot and cwd. macOS /tmp ↔ /private/tmp matters.
//   2. If cwd is the repoRoot (or a descendant that is NOT inside any
//      worktree path), we are NOT in a tracked worktree → `unbound`.
//   3. Walk worktrees.json entries with a recorded `path`. Pick the entry
//      whose realpath(path) is cwd or an ancestor of cwd. (Multiple matches
//      would be a registry conflict; we take the deepest match, with a
//      stable tiebreak by name.)
//   4. If no registry entry matches, fall back to `git worktree list
//      --porcelain` to find the worktree path containing cwd, then look up
//      that path in the registry. If still no match: `unbound`.
//   5. With a worktree name in hand, look up the bound spec by following
//      registry.specId → spec. If the spec exists, hand the Spec +
//      registry + name to kernel `deriveBindingState`. If not, synthesize
//      an `unbound` (and emit a one-sided shape if the registry has a
//      specId pointing at something that didn't load).
//
// The shell NEVER uses `basename(cwd)` to invent a worktree name.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { deriveBindingState } from '@paths.design/caws-kernel';

import type {
  BindingClaimant,
  GitWorktreeEntry,
  ResolveBindingInput,
  ResolvedBinding,
} from './types';

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isAncestorOrEqual(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true;
  const withSep = maybeAncestor.endsWith(path.sep)
    ? maybeAncestor
    : maybeAncestor + path.sep;
  return descendant.startsWith(withSep);
}

function defaultGitWorktreeList(repoRoot: string): readonly GitWorktreeEntry[] {
  const r = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return [];
  return parseWorktreePorcelain(r.stdout);
}

export function parseWorktreePorcelain(text: string): readonly GitWorktreeEntry[] {
  const out: GitWorktreeEntry[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (currentPath !== undefined) {
        const entry: GitWorktreeEntry =
          currentBranch !== undefined
            ? { path: currentPath, branch: currentBranch }
            : { path: currentPath };
        out.push(entry);
      }
      currentPath = line.slice('worktree '.length);
      currentBranch = undefined;
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length);
    } else if (line === '') {
      if (currentPath !== undefined) {
        const entry: GitWorktreeEntry =
          currentBranch !== undefined
            ? { path: currentPath, branch: currentBranch }
            : { path: currentPath };
        out.push(entry);
        currentPath = undefined;
        currentBranch = undefined;
      }
    }
  }
  if (currentPath !== undefined) {
    const entry: GitWorktreeEntry =
      currentBranch !== undefined
        ? { path: currentPath, branch: currentBranch }
        : { path: currentPath };
    out.push(entry);
  }
  return out;
}

interface RegistryMatch {
  readonly name: string;
  readonly path: string;
}

function findRegistryMatch(
  cwdReal: string,
  registry: ResolveBindingInput['registry']
): RegistryMatch | null {
  let best: RegistryMatch | null = null;
  let bestDepth = -1;
  for (const [name, record] of Object.entries(registry)) {
    if (typeof record?.path !== 'string') continue;
    const recordReal = safeRealpath(record.path);
    if (!isAncestorOrEqual(recordReal, cwdReal)) continue;
    const depth = recordReal.split(path.sep).length;
    if (
      depth > bestDepth ||
      (depth === bestDepth && best !== null && name < best.name)
    ) {
      best = { name, path: recordReal };
      bestDepth = depth;
    }
  }
  return best;
}

// SCOPE-CHECK-CWD-BINDING-RESOLUTION-001 helpers ─────────────────────────
//
// These power the target-path fallback (steps 2 and 3) when cwd does not
// resolve a worktree. They are pure functions of (targetPath, registry,
// specs) — no process.cwd(), no I/O beyond the realpath the caller already
// did — so the binding for a path is identical from any invocation cwd.

/**
 * Normalize a repo-root-relative path to POSIX separators with no leading
 * "./" or trailing slash, for stable matching against scope.in entries.
 */
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Anchored glob match supporting `*` (any run of non-separator or separator
 * chars within a segment-agnostic match) and `?` (single char). A bare
 * directory entry (no glob meta) matches the entry itself OR any descendant
 * (prefix match on a path boundary) — mirroring how scope.in directory
 * entries admit files beneath them. No dependency on minimatch.
 */
function scopeEntryMatches(entry: string, target: string): boolean {
  const e = normalizeRel(entry);
  const t = normalizeRel(target);
  if (e === t) return true;
  if (!/[*?]/.test(e)) {
    // Directory/prefix entry: admit descendants on a path boundary.
    return t.startsWith(e + '/');
  }
  // Glob entry: translate to an anchored RegExp. `*` → [^/]-agnostic any,
  // `?` → single char. Escape all other regex meta.
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

/**
 * Step (3): find every active bound spec whose scope.in admits `targetPath`.
 * Returns one claimant per matching spec, naming the spec, its worktree, and
 * the exact scope.in entry that matched (for the actionable refusal).
 */
function findScopeInClaimants(
  targetPath: string,
  input: ResolveBindingInput
): BindingClaimant[] {
  const claimants: BindingClaimant[] = [];
  for (const [name, record] of Object.entries(input.registry)) {
    const specId = record?.specId;
    if (typeof specId !== 'string' || specId.length === 0) continue;
    const spec = input.specs.find((s) => s.id === specId);
    if (spec === undefined) continue;
    if (spec.lifecycle_state !== 'active') continue;
    const scopeIn = spec.scope?.in ?? [];
    const matched = scopeIn.find((entry) => scopeEntryMatches(entry, targetPath));
    if (matched !== undefined) {
      claimants.push({ specId, worktreeName: name, matchedScopeInEntry: matched });
    }
  }
  return claimants;
}

export function resolveBinding(input: ResolveBindingInput): ResolvedBinding {
  const cwdReal = safeRealpath(input.cwd);
  const repoRootReal = safeRealpath(input.repoRoot);

  // If cwd is exactly the repo root, we are in the main checkout. Walk the
  // registry anyway in case a worktree was created at the repo root (rare,
  // would imply specId === <main> binding). Otherwise this returns null.
  let candidate = findRegistryMatch(cwdReal, input.registry);
  let source: ResolvedBinding['source'] = 'registry_path_match';

  if (candidate === null) {
    // Fallback: git porcelain. Find the worktree path containing cwd,
    // then match that path against the registry.
    const lister = input.gitWorktreeList ?? defaultGitWorktreeList;
    const wts = lister(input.repoRoot);
    let porcelainMatch: GitWorktreeEntry | null = null;
    let porcelainDepth = -1;
    for (const wt of wts) {
      const wtReal = safeRealpath(wt.path);
      if (!isAncestorOrEqual(wtReal, cwdReal)) continue;
      const depth = wtReal.split(path.sep).length;
      if (depth > porcelainDepth) {
        porcelainMatch = wt;
        porcelainDepth = depth;
      }
    }
    if (porcelainMatch !== null) {
      const porcelainReal = safeRealpath(porcelainMatch.path);
      // Skip if porcelain match is the main checkout (no worktree binding).
      if (porcelainReal !== repoRootReal) {
        // Look up registry entry by path equality.
        for (const [name, record] of Object.entries(input.registry)) {
          if (
            typeof record?.path === 'string' &&
            safeRealpath(record.path) === porcelainReal
          ) {
            candidate = { name, path: porcelainReal };
            source = 'git_porcelain_match';
            break;
          }
        }
      }
    }
  }

  if (candidate === null) {
    // SCOPE-CHECK-CWD-BINDING-RESOLUTION-001: cwd resolved no worktree.
    // Before falling to `unbound`, try to resolve the binding from the
    // TARGET PATH so the verdict is cwd-independent.
    if (typeof input.targetPath === 'string' && input.targetPath.length > 0) {
      const targetAbs = safeRealpath(
        path.isAbsolute(input.targetPath)
          ? input.targetPath
          : path.join(repoRootReal, input.targetPath)
      );

      // Step (2): target-path worktree-location. If the absolute path lies
      // under a registered worktree's path, that worktree binds. Unambiguous
      // (a path is inside at most one worktree dir); take the deepest match.
      const locMatch = findRegistryMatch(targetAbs, input.registry);
      if (locMatch !== null) {
        candidate = locMatch;
        source = 'target_worktree_location';
      } else {
        // Step (3): target-path scope.in claim.
        const claimants = findScopeInClaimants(input.targetPath, input);
        if (claimants.length === 1) {
          const only = claimants[0]!;
          candidate = { name: only.worktreeName, path: '' };
          source = 'target_scope_in_claim';
        } else if (claimants.length > 1) {
          // Refuse-on-conflict: name every claimant, pick none. `binding`
          // stays `unbound` (safe default); the ambiguity rides in the
          // dedicated `ambiguous` field that scope check inspects.
          return {
            binding: { kind: 'unbound' },
            ambiguous: { targetPath: normalizeRel(input.targetPath), claimants },
            source: 'target_scope_in_claim',
          };
        }
      }
    }

    if (candidate === null) {
      return { binding: { kind: 'unbound' }, source: 'none' };
    }
  }

  // We have a worktree name. Now find the bound spec for kernel evaluation.
  const record = input.registry[candidate.name];
  const registrySpecId = record?.specId;
  if (typeof registrySpecId !== 'string' || registrySpecId.length === 0) {
    // Registry knows the worktree but no spec is linked. Neither side
    // points at the other, so this is `unbound`, NOT `one_sided`.
    // The repair is "bind this worktree to a spec", not "repair corrupt
    // asymmetric binding". The downstream renderer keys off the
    // worktreeName being set to distinguish "tracked worktree without
    // spec" from "cwd outside any worktree".
    return {
      binding: { kind: 'unbound' },
      worktreeName: candidate.name,
      source,
    };
  }

  // We have registrySpecId. Find the bound spec in the loaded specs list.
  const boundSpec = input.specs.find((s) => s.id === registrySpecId);
  if (boundSpec === undefined) {
    // Registry points at a spec id that didn't load. From the kernel's
    // perspective this is one-sided (registry has specId, spec missing).
    return {
      binding: {
        kind: 'one_sided',
        detail: {
          specHasWorktree: false,
          registryHasSpecId: true,
          registrySpecId,
          worktreeName: candidate.name,
        },
      },
      worktreeName: candidate.name,
      source,
    };
  }

  return {
    binding: deriveBindingState(boundSpec, input.registry, candidate.name),
    worktreeName: candidate.name,
    source,
  };
}
