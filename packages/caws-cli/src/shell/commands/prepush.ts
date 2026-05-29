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
import * as path from 'node:path';

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

/** Collect the outgoing range + per-commit touched files + dirty state. */
function collectGitFacts(
  git: GitRunner,
  repoRoot: string,
  baseRef: string
): GitFacts {
  // Dirty working-tree paths (porcelain, NUL-safe-ish by line).
  const status = git(['status', '--porcelain'], repoRoot);
  const dirtyPaths = status
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^.. /, '').replace(/^"|"$/g, ''));

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
    return { sha: sha.slice(0, 12), subject, touchedFiles: files };
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

  // 2. Collect git facts (range + dirty state). Wrap git failures as exit 2.
  let facts: GitFacts;
  try {
    facts = collectGitFacts(git, repoRoot, baseRef);
  } catch (e) {
    err(`caws prepush: git read failed for base "${baseRef}": ${(e as Error).message}`);
    return 2;
  }

  // 3. A8 — dirty-tree / governed-path preflight, BEFORE range classification.
  //    A dirty working tree means provenance is ambiguous (whose change is
  //    this?) — refuse early so the operator resolves it before publishing.
  if (facts.dirtyPaths.length > 0) {
    err('caws prepush: refusing — working tree is dirty before classification.');
    for (const p of facts.dirtyPaths) err(`  dirty: ${p}`);
    err('  Commit or stash these (and confirm they are yours) before prepush.');
    return 1;
  }

  // 4. Load specs + worktrees (control-plane facts for attribution).
  const specsLoad = loadSpecs(cawsDir);
  const specs: ClassifierSpec[] = specsLoad.specs
    .filter((s) => s.lifecycle_state === 'active' || s.lifecycle_state === 'closed')
    .map((s) => ({
      specId: s.id,
      scopeIn: s.scope.in,
      lifecycleState: s.lifecycle_state,
    }));

  // 5. Foreign worktrees: any registry entry NOT bound to the current spec.
  //    (Minimal v1: a registered worktree whose specId differs from the
  //    current slice is "foreign" for escalation purposes.)
  const wtResult = loadWorktrees(cawsDir);
  const foreignWorktrees: ForeignWorktree[] = [];
  if (wtResult.ok) {
    for (const [name, rec] of Object.entries(wtResult.value)) {
      if (opts.specId !== undefined && rec?.specId === opts.specId) continue;
      foreignWorktrees.push({
        name,
        path: typeof rec?.path === 'string' ? rec.path : '',
        ...(typeof rec?.branch === 'string' ? { branch: rec.branch } : {}),
        unregistered: false, // registry-listed by construction
        unmerged: false, // v1 does not probe merge state per-wt
      });
    }
  }

  // 6. Classify (pure).
  const report = classifyRange({
    commits: facts.commits,
    specs,
    ...(opts.specId !== undefined ? { currentSpecId: opts.specId } : {}),
    foreignWorktrees,
    ...(opts.ack !== undefined ? { ackedShas: opts.ack } : {}),
    baseRef,
    target,
  });

  // 7. Render + decide.
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
  void path; // reserved for future relative-path rendering
  return 0;
}
