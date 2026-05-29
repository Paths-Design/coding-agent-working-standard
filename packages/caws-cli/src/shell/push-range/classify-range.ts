// push-range classifier — MULTI-AGENT-PUSH-RANGE-GUARD-001
//
// A pure classifier over the outgoing commit range. Given the outgoing
// commits (each with its touched files), the active/recently-closed specs
// and their scope.in, the worktree registry, the current session's active
// spec, and the set of acknowledged SHAs, it produces a structured report
// and a refuse/proceed decision.
//
// DIAGNOSE/DECIDE ONLY. This module never invokes git, never mutates repo
// state, never pushes. The caller supplies the already-collected git facts
// (the thin command does the git reads); the classifier is a deterministic
// function of its inputs so it is trivially testable against fixtures and
// produces byte-identical reports for identical input (A9 / non_functional
// reliability).
//
// Provenance (ADR 0001 Q1): a commit is attributed to EVERY active/
// recently-closed spec whose scope.in prefix-matches any file the commit
// touches (multi-match reported, never collapsed). Commit-subject SPEC-ID
// matching is additive — it can add an inferred spec, never remove a
// file-touch match. current_slice_match is true iff the current session's
// active spec is in the commit's match set. A commit matching no spec by
// file-touch AND naming no known spec in its subject is provenance:
// 'ambiguous'.

import { scopeEntryMatches } from './scope-match';

/** One spec the classifier may attribute commits to. */
export interface ClassifierSpec {
  readonly specId: string;
  /** scope.in entries (repo-root-relative paths / globs). */
  readonly scopeIn: readonly string[];
  /** Lifecycle state — only 'active' and 'closed' are considered. */
  readonly lifecycleState: string;
}

/** One outgoing commit with the facts the classifier needs. */
export interface OutgoingCommit {
  readonly sha: string;
  readonly subject: string;
  /** Repo-root-relative paths the commit touched. */
  readonly touchedFiles: readonly string[];
  /**
   * Optional: the worktree name this commit originates from, when the
   * caller could determine it (e.g. from `git branch --contains` against
   * the registry). Used for foreign-worktree escalation.
   */
  readonly originWorktree?: string;
}

/** A foreign physical worktree the caller observed. */
export interface ForeignWorktree {
  readonly name: string;
  readonly path: string;
  readonly branch?: string;
  /** True if the branch is absent from .caws/worktrees.json. */
  readonly unregistered: boolean;
  /** True if the branch is not merged into the push base. */
  readonly unmerged: boolean;
}

export interface ClassifyRangeInput {
  /** Outgoing commits, base..HEAD order (oldest first or newest — order
   *  is preserved in the report but not relied on for decisions). */
  readonly commits: readonly OutgoingCommit[];
  /** Active + recently-closed specs available for attribution. */
  readonly specs: readonly ClassifierSpec[];
  /** The current session's active spec id, if known. Commits attributed
   *  to it are current_slice_match: true. */
  readonly currentSpecId?: string;
  /** Foreign physical worktrees observed during preflight. */
  readonly foreignWorktrees?: readonly ForeignWorktree[];
  /** SHAs the operator explicitly acknowledged (per-SHA, ADR Q3). */
  readonly ackedShas?: readonly string[];
  /** The base ref the range was computed against (e.g. 'origin/main').
   *  Reported for transparency. */
  readonly baseRef: string;
  /** The push target ('origin main' is full posture; feature branches get
   *  weakened foreign-worktree escalation per ADR Q5). */
  readonly target: PushTarget;
}

export interface PushTarget {
  readonly remote: string;
  readonly branch: string;
}

export type ProvenanceSource =
  | 'file_touch'
  | 'commit_subject'
  | 'file_touch+commit_subject'
  | 'none';

export interface CommitClassification {
  readonly sha: string;
  readonly subject: string;
  readonly touchedFiles: readonly string[];
  /** Every spec id this commit is attributed to (multi-match reported). */
  readonly inferredSpecIds: readonly string[];
  /** True iff currentSpecId is in inferredSpecIds. */
  readonly currentSliceMatch: boolean;
  readonly provenanceSource: ProvenanceSource;
  /** True when no spec matched by file-touch and no known spec named in
   *  the subject — operator review needed. */
  readonly ambiguous: boolean;
  /** Foreign worktree this commit originates from, if the caller tagged it. */
  readonly originWorktree?: string;
  /** True when this commit is acknowledged by the operator. */
  readonly acknowledged: boolean;
}

export type Severity = 'INFO' | 'WARN' | 'ERROR';

export interface ForeignWorktreeFinding {
  readonly name: string;
  readonly path: string;
  readonly branch?: string;
  readonly severity: Severity;
  /** Which OR-condition(s) (ADR Q4) drove the severity. */
  readonly reasons: readonly string[];
}

export interface PushRangeReport {
  readonly baseRef: string;
  readonly target: PushTarget;
  readonly commits: readonly CommitClassification[];
  readonly foreignWorktrees: readonly ForeignWorktreeFinding[];
  /** Commits that are unexpected (not current-slice-match) and NOT acked. */
  readonly unexpectedUnacked: readonly string[];
  /** True iff the guard refuses the push. */
  readonly refused: boolean;
  /** Highest severity across all findings. */
  readonly maxSeverity: Severity;
}

const SPEC_ID_IN_SUBJECT = /\b([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+[a-z]*)\b/g;

function severityRank(s: Severity): number {
  return s === 'ERROR' ? 2 : s === 'WARN' ? 1 : 0;
}

/**
 * Classify one commit's spec provenance. Pure.
 */
function classifyCommit(
  commit: OutgoingCommit,
  specs: readonly ClassifierSpec[],
  currentSpecId: string | undefined,
  ackedShas: ReadonlySet<string>
): CommitClassification {
  const considered = specs.filter(
    (s) => s.lifecycleState === 'active' || s.lifecycleState === 'closed'
  );

  // (a) file-touch matches — every spec whose scope.in admits any touched file.
  const fileTouchMatches = new Set<string>();
  for (const spec of considered) {
    const hit = commit.touchedFiles.some((f) =>
      spec.scopeIn.some((entry) => scopeEntryMatches(entry, f))
    );
    if (hit) fileTouchMatches.add(spec.specId);
  }

  // (b) commit-subject SPEC-ID matches — additive, only for KNOWN specs.
  const knownIds = new Set(considered.map((s) => s.specId));
  const subjectMatches = new Set<string>();
  for (const m of commit.subject.matchAll(SPEC_ID_IN_SUBJECT)) {
    const id = m[1]!;
    if (knownIds.has(id)) subjectMatches.add(id);
  }

  const inferred = new Set<string>([...fileTouchMatches, ...subjectMatches]);
  const inferredSpecIds = [...inferred].sort();

  let provenanceSource: ProvenanceSource;
  if (fileTouchMatches.size > 0 && subjectMatches.size > 0) {
    provenanceSource = 'file_touch+commit_subject';
  } else if (fileTouchMatches.size > 0) {
    provenanceSource = 'file_touch';
  } else if (subjectMatches.size > 0) {
    provenanceSource = 'commit_subject';
  } else {
    provenanceSource = 'none';
  }

  const ambiguous = inferred.size === 0;
  const currentSliceMatch =
    currentSpecId !== undefined && inferred.has(currentSpecId);

  return {
    sha: commit.sha,
    subject: commit.subject,
    touchedFiles: commit.touchedFiles,
    inferredSpecIds,
    currentSliceMatch,
    provenanceSource,
    ambiguous,
    ...(commit.originWorktree !== undefined
      ? { originWorktree: commit.originWorktree }
      : {}),
    acknowledged: ackedShas.has(commit.sha),
  };
}

/**
 * Classify a foreign worktree's severity (ADR Q4 — OR of three ERROR
 * conditions; WARN otherwise during an active slice; INFO when not on the
 * full-posture target).
 */
function classifyForeignWorktree(
  wt: ForeignWorktree,
  commits: readonly OutgoingCommit[],
  fullPosture: boolean
): ForeignWorktreeFinding {
  const reasons: string[] = [];
  if (wt.unmerged) reasons.push('unmerged branch');
  if (wt.unregistered) reasons.push('branch not in worktrees.json');
  const originatesCommit = commits.some((c) => c.originWorktree === wt.name);
  if (originatesCommit) {
    reasons.push('commits in the outgoing range originate from it');
  }

  let severity: Severity;
  if (!fullPosture) {
    // Feature-branch / non-origin-main: weakened — report, don't ERROR.
    severity = reasons.length > 0 ? 'WARN' : 'INFO';
  } else if (reasons.length > 0) {
    severity = 'ERROR'; // OR: any one condition escalates on origin main.
  } else {
    severity = 'WARN'; // present during an active slice, no hard condition.
  }

  return {
    name: wt.name,
    path: wt.path,
    ...(wt.branch !== undefined ? { branch: wt.branch } : {}),
    severity,
    reasons,
  };
}

/**
 * Classify the outgoing range. Pure, deterministic, side-effect-free.
 */
export function classifyRange(input: ClassifyRangeInput): PushRangeReport {
  const acked = new Set(input.ackedShas ?? []);
  const fullPosture =
    input.target.remote === 'origin' && input.target.branch === 'main';

  const commits = input.commits.map((c) =>
    classifyCommit(c, input.specs, input.currentSpecId, acked)
  );

  const foreignWorktrees = (input.foreignWorktrees ?? []).map((wt) =>
    classifyForeignWorktree(wt, input.commits, fullPosture)
  );

  // Unexpected = not current-slice-match (includes ambiguous), and NOT acked.
  const unexpectedUnacked = commits
    .filter((c) => !c.currentSliceMatch && !c.acknowledged)
    .map((c) => c.sha);

  // Max severity across foreign-worktree findings + the unexpected-commit
  // condition (an unexpected unacked commit is an ERROR-equivalent refusal).
  let maxSeverity: Severity = 'INFO';
  for (const f of foreignWorktrees) {
    if (severityRank(f.severity) > severityRank(maxSeverity)) {
      maxSeverity = f.severity;
    }
  }
  if (unexpectedUnacked.length > 0 && severityRank('ERROR') > severityRank(maxSeverity)) {
    maxSeverity = 'ERROR';
  }

  // Refuse iff there is any unexpected unacked commit, OR any ERROR-severity
  // foreign worktree finding. WARN-only findings do not refuse (they ride in
  // the report). This is the diagnose/decide contract: refuse is mechanical.
  const refused =
    unexpectedUnacked.length > 0 ||
    foreignWorktrees.some((f) => f.severity === 'ERROR');

  return {
    baseRef: input.baseRef,
    target: input.target,
    commits,
    foreignWorktrees,
    unexpectedUnacked,
    refused,
    maxSeverity,
  };
}
