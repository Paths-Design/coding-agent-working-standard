// caws prepush — MULTI-AGENT-PUSH-RANGE-GUARD-001 command surface.
//
// Thin command over the pure classifier (push-range/classify-range). It
// does the git READS (outgoing range, per-commit touched files, foreign
// worktree state, dirty-tree preflight), hands the collected facts to
// classifyRange(), renders the structured report, and returns an exit code.
//
// It NEVER invokes git push, never mutates repo state. v1 is prepush-first:
// `caws prepush` classifies + refuses; it does not wrap the transport. The
// operator runs `git push` themselves after a clean pass. (Per ADR 0001 +
// the maintainer's prepush-first v1 narrowing.)

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

import {
  resolveRepoRoot,
  loadSpecs,
  loadWorktrees,
} from '../../store';
import {
  classifyRange,
  type ClassifierSpec,
  type OutgoingCommit,
  type ForeignWorktree,
  type PushRangeReport,
  type PushTarget,
} from '../push-range/classify-range';

/** Injectable git runner: (args, cwd) -> stdout. Throws on non-zero. */
export type GitRunner = (args: readonly string[], cwd: string) => string;

const defaultGitRunner: GitRunner = (args, cwd) =>
  execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();

export interface PrepushCommandOptions {
  readonly cwd?: string;
  /** Default 'origin'. */
  readonly remote?: string;
  /** Default 'main'. */
  readonly branch?: string;
  /** Explicit base ref override; defaults to `<remote>/<branch>`. */
  readonly base?: string;
  /** SHAs the operator acknowledges (repeatable --ack). */
  readonly ack?: readonly string[];
  /** The current session's active spec id (for current-slice-match). */
  readonly specId?: string;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
  /** Injectable git runner for tests. */
  readonly git?: GitRunner;
  readonly showData?: boolean;
}

interface GitFacts {
  readonly commits: OutgoingCommit[];
  readonly dirtyPaths: readonly string[];
}

/**
 * One registered worktree the caller asks us to attribute commits to. The
 * branch is what `git branch --contains` reports against; the name is the
 * registry key we surface in findings.
 */
interface RegisteredWorktreeRef {
  readonly name: string;
  readonly branch?: string;
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z` output into the set of
 * dirty paths. The `-z` form is the only robust parse: it does NOT quote or
 * escape paths, and renames/copies emit the new path and the old path as two
 * separate NUL-terminated fields immediately following the 3-char status
 * prefix. We surface both sides of a rename so the operator sees the full
 * dirty footprint. Lines are `XY <path>\0` (and for R/C, `<orig>\0` follows).
 */
function parseDirtyPathsZ(zOutput: string): string[] {
  const fields = zOutput.split('\0').filter((f) => f.length > 0);
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    // Each status record is `XY <path>`; XY is two status chars + a space.
    const status = field.slice(0, 2);
    const p = field.slice(3);
    if (p.length > 0) paths.push(p);
    // Rename (R) and copy (C) entries carry the original path in the NEXT
    // NUL-terminated field with no status prefix — consume it too.
    if (status[0] === 'R' || status[0] === 'C') {
      const orig = fields[i + 1];
      if (orig !== undefined) {
        paths.push(orig);
        i++; // skip the original-path field we just consumed
      }
    }
  }
  return paths;
}

/**
 * Best-effort attribution of a commit SHA to a registered worktree's branch
 * via `git branch --contains <sha>`. Returns the worktree NAME when exactly
 * one registered branch contains the commit AND that branch is not the base
 * branch we're pushing (a commit on the push branch itself is not "from a
 * foreign worktree"). Returns undefined on any ambiguity or git failure —
 * attribution is best-effort and NEVER fabricates an origin (invariant 3).
 */
function attributeOriginWorktree(
  git: GitRunner,
  repoRoot: string,
  sha: string,
  registered: readonly RegisteredWorktreeRef[]
): string | undefined {
  let containing: Set<string>;
  try {
    const out = git(['branch', '--contains', sha, '--format=%(refname:short)'], repoRoot);
    containing = new Set(
      out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  } catch {
    return undefined; // git read failed — degrade silently.
  }
  const matches = registered.filter(
    (wt) => wt.branch !== undefined && containing.has(wt.branch)
  );
  if (matches.length !== 1) return undefined; // none, or ambiguous → undefined.
  return matches[0]!.name;
}

/**
 * Probe whether a branch is merged into the push base. Returns true (treated
 * as "unmerged" by the caller) when the branch is NOT an ancestor of base.
 * On any git failure we return false — we do not escalate on an unreadable
 * merge state (invariant 3: failed observation is non-escalating).
 */
function branchIsUnmerged(
  git: GitRunner,
  repoRoot: string,
  branch: string,
  baseRef: string
): boolean {
  try {
    // `merge-base --is-ancestor` exits 0 when branch IS an ancestor of base
    // (i.e. merged), non-zero otherwise. The runner throws on non-zero.
    git(['merge-base', '--is-ancestor', branch, baseRef], repoRoot);
    return false; // ancestor → merged.
  } catch {
    // Non-zero exit means "not an ancestor" (unmerged) — but a genuine git
    // error (bad ref) lands here too. Distinguish by verifying the branch
    // resolves; if it doesn't, we cannot claim it's unmerged.
    try {
      git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`], repoRoot);
      return true; // branch resolves but is not an ancestor → unmerged.
    } catch {
      return false; // branch unresolvable → no escalation.
    }
  }
}

/** One physical git worktree as reported by `git worktree list`. */
interface PhysicalWorktree {
  readonly path: string;
  readonly branch?: string;
}

/**
 * Enumerate physical git worktrees via `git worktree list --porcelain`.
 * This is git's ground truth — it includes worktrees created OUTSIDE CAWS
 * (the session-13 class) that are absent from .caws/worktrees.json. Returns
 * an empty list on any git failure (non-escalating; invariant 3).
 */
function listPhysicalWorktrees(
  git: GitRunner,
  repoRoot: string
): PhysicalWorktree[] {
  let out: string;
  try {
    out = git(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return [];
  }
  const result: PhysicalWorktree[] = [];
  let curPath: string | undefined;
  let curBranch: string | undefined;
  const flush = () => {
    if (curPath !== undefined) {
      result.push({
        path: curPath,
        ...(curBranch !== undefined ? { branch: curBranch } : {}),
      });
    }
    curPath = undefined;
    curBranch = undefined;
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      curPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      // `branch refs/heads/<name>` — normalize to the short name.
      curBranch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
    // `detached`, `HEAD <sha>`, `bare`, blank — ignored for our purposes.
  }
  flush();
  return result;
}

/** Collect the outgoing range + per-commit touched files + dirty state. */
function collectGitFacts(
  git: GitRunner,
  repoRoot: string,
  baseRef: string,
  registered: readonly RegisteredWorktreeRef[]
): GitFacts {
  // Dirty working-tree paths via NUL-delimited porcelain v1 (-z): robust for
  // renames and non-ASCII/quoted paths, which the line-based parse mangled.
  const status = git(['status', '--porcelain=v1', '-z'], repoRoot);
  const dirtyPaths = parseDirtyPathsZ(status);

  // Outgoing range SHAs, newest-first.
  const revs = git(
    ['rev-list', `${baseRef}..HEAD`],
    repoRoot
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const commits: OutgoingCommit[] = revs.map((sha) => {
    const subject = git(['log', '-1', '--format=%s', sha], repoRoot).trim();
    const files = git(
      ['diff-tree', '--no-commit-id', '--name-only', '-r', sha],
      repoRoot
    )
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const origin = attributeOriginWorktree(git, repoRoot, sha, registered);
    return {
      sha: sha.slice(0, 12),
      subject,
      touchedFiles: files,
      ...(origin !== undefined ? { originWorktree: origin } : {}),
    };
  });

  return { commits, dirtyPaths };
}

function renderReport(report: PushRangeReport, out: (s: string) => void): void {
  out(`prepush: outgoing range ${report.baseRef}..HEAD → ${report.target.remote} ${report.target.branch}`);
  if (report.commits.length === 0) {
    out('  (no outgoing commits)');
  }
  for (const c of report.commits) {
    const flag = c.currentSliceMatch
      ? 'current-slice'
      : c.acknowledged
        ? 'acknowledged'
        : c.ambiguous
          ? 'AMBIGUOUS'
          : 'UNEXPECTED';
    const specs = c.inferredSpecIds.length > 0 ? c.inferredSpecIds.join(',') : '(none)';
    out(`  ${c.sha} [${flag}] ${c.subject}`);
    out(`      specs: ${specs}  via: ${c.provenanceSource}  files: ${c.touchedFiles.length}`);
    if (c.originWorktree !== undefined) {
      out(`      origin-worktree: ${c.originWorktree}`);
    }
  }
  for (const f of report.foreignWorktrees) {
    out(`  [${f.severity}] foreign worktree ${f.name} (${f.path})${f.branch ? ' @ ' + f.branch : ''}`);
    for (const r of f.reasons) out(`      - ${r}`);
  }
}

/**
 * Run the prepush guard. Returns 0 on clean pass, 1 on refusal, 2 on a
 * setup/composition error.
 */
export function runPrepushCommand(opts: PrepushCommandOptions): number {
  const cwd = opts.cwd ?? process.cwd();
  const out = opts.out ?? ((s: string) => process.stdout.write(s + '\n'));
  const err = opts.err ?? ((s: string) => process.stderr.write(s + '\n'));
  const git = opts.git ?? defaultGitRunner;
  const remote = opts.remote ?? 'origin';
  const branch = opts.branch ?? 'main';
  const target: PushTarget = { remote, branch };
  const baseRef = opts.base ?? `${remote}/${branch}`;

  // 1. Repo root.
  const rootResult = resolveRepoRoot(cwd);
  if (!rootResult.ok) {
    err('caws prepush: failed to resolve repo root (not a git repository?).');
    return 2;
  }
  const { repoRoot, cawsDir } = rootResult.value;

  // 2. Load the worktree registry FIRST — its branches feed per-commit origin
  //    attribution (git branch --contains) inside collectGitFacts.
  const wtResult = loadWorktrees(cawsDir);
  const registry: Record<string, { specId?: string; path?: string; branch?: string }> =
    wtResult.ok ? wtResult.value : {};
  const registered: RegisteredWorktreeRef[] = Object.entries(registry).map(
    ([name, rec]) => ({
      name,
      ...(typeof rec?.branch === 'string' ? { branch: rec.branch } : {}),
    })
  );

  // 3. Collect git facts (range + per-commit origin + dirty state). Wrap git
  //    failures as exit 2.
  let facts: GitFacts;
  try {
    facts = collectGitFacts(git, repoRoot, baseRef, registered);
  } catch (e) {
    err(`caws prepush: git read failed for base "${baseRef}": ${(e as Error).message}`);
    return 2;
  }

  // 4. A8 — dirty-tree / governed-path preflight, BEFORE range classification.
  //    A dirty working tree means provenance is ambiguous (whose change is
  //    this?) — refuse early so the operator resolves it before publishing.
  if (facts.dirtyPaths.length > 0) {
    err('caws prepush: refusing — working tree is dirty before classification.');
    for (const p of facts.dirtyPaths) err(`  dirty: ${p}`);
    err('  Commit or stash these (and confirm they are yours) before prepush.');
    return 1;
  }

  // 5. Load specs (control-plane facts for attribution).
  const specsLoad = loadSpecs(cawsDir);
  const specs: ClassifierSpec[] = specsLoad.specs
    .filter((s) => s.lifecycle_state === 'active' || s.lifecycle_state === 'closed')
    .map((s) => ({
      specId: s.id,
      scopeIn: s.scope.in,
      lifecycleState: s.lifecycle_state,
    }));

  // 6. Foreign worktrees, from git's PHYSICAL truth joined against the
  //    registry. A foreign worktree is any physical worktree that is NOT the
  //    current checkout (repoRoot) and is NOT the one bound to the current
  //    slice. For each we observe (read-only):
  //      - unregistered: its branch is absent from .caws/worktrees.json
  //        (ADR Q4 condition b — the session-13 "created outside CAWS" class);
  //      - unmerged:     its branch is not an ancestor of the push base
  //        (ADR Q4 condition a);
  //      - originates:   handled per-commit via originWorktree attribution,
  //        which classifyForeignWorktree reads (ADR Q4 condition c).
  //    Enumerating physical worktrees (not just the registry) is what lets the
  //    guard catch an unregistered sibling worktree at all.
  let repoRootReal: string;
  try {
    repoRootReal = fs.realpathSync(repoRoot);
  } catch {
    repoRootReal = repoRoot;
  }
  const registeredBranches = new Set(
    registered.map((r) => r.branch).filter((b): b is string => b !== undefined)
  );
  const currentSliceBranches = new Set(
    Object.entries(registry)
      .filter(([, rec]) => opts.specId !== undefined && rec?.specId === opts.specId)
      .map(([, rec]) => rec?.branch)
      .filter((b): b is string => typeof b === 'string')
  );
  const nameByBranch = new Map(
    registered
      .filter((r) => r.branch !== undefined)
      .map((r) => [r.branch as string, r.name])
  );

  const foreignWorktrees: ForeignWorktree[] = [];
  for (const phys of listPhysicalWorktrees(git, repoRoot)) {
    let physReal: string;
    try {
      physReal = fs.realpathSync(phys.path);
    } catch {
      physReal = phys.path;
    }
    // Skip the current checkout (where the push originates from).
    if (physReal === repoRootReal) continue;
    // Skip the worktree bound to the current slice — it is not "foreign".
    if (phys.branch !== undefined && currentSliceBranches.has(phys.branch)) continue;

    const unregistered =
      phys.branch === undefined || !registeredBranches.has(phys.branch);
    const unmerged =
      phys.branch !== undefined &&
      branchIsUnmerged(git, repoRoot, phys.branch, baseRef);
    // Prefer the registry name when known; fall back to the branch or path.
    const name =
      (phys.branch !== undefined ? nameByBranch.get(phys.branch) : undefined) ??
      phys.branch ??
      phys.path;
    foreignWorktrees.push({
      name,
      path: phys.path,
      ...(phys.branch !== undefined ? { branch: phys.branch } : {}),
      unregistered,
      unmerged,
    });
  }

  // 7. Classify (pure).
  const report = classifyRange({
    commits: facts.commits,
    specs,
    ...(opts.specId !== undefined ? { currentSpecId: opts.specId } : {}),
    foreignWorktrees,
    ...(opts.ack !== undefined ? { ackedShas: opts.ack } : {}),
    baseRef,
    target,
  });

  // 8. Render + decide.
  renderReport(report, out);
  if (report.refused) {
    err('caws prepush: REFUSED. The outgoing range contains commits not');
    err('  attributable to the current slice, or an ERROR-severity foreign');
    err('  worktree. Acknowledge specific commits with --ack <sha> after');
    err('  confirming they belong in this push, or resolve the foreign');
    err('  worktree, then re-run. This is a governed pre-push check; it does');
    err('  NOT run git push.');
    if (report.unexpectedUnacked.length > 0) {
      err(`  unexpected (unacknowledged): ${report.unexpectedUnacked.join(', ')}`);
    }
    return 1;
  }

  out('caws prepush: range is cleanly attributable. Safe to git push.');
  return 0;
}
