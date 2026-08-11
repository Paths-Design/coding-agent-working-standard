// push-range classifier — MULTI-AGENT-PUSH-RANGE-GUARD-001, reworked by
// CAWS-PREPUSH-PROVENANCE-REWORK-001.
//
// A pure classifier over the outgoing commit range. Given the outgoing
// commits (each with its touched files), the set of SHAs covered by
// governed merges (worktree_merged events, collected by the caller), the
// active/recently-closed specs and their scope.in, the worktree registry,
// the current session's active spec, and the set of acknowledged SHAs, it
// produces a structured report and a refuse/proceed decision.
//
// DIAGNOSE/DECIDE ONLY. This module never invokes git, never mutates repo
// state, never pushes. The caller supplies the already-collected git facts
// (the thin command does the git reads); the classifier is a deterministic
// function of its inputs so it is trivially testable against fixtures and
// produces byte-identical reports for identical input (A9 / non_functional
// reliability).
//
// GOVERNANCE CLASSES (CAWS-PREPUSH-PROVENANCE-REWORK-001). The slice-
// attribution refusal model was retired — in a multi-agent repo the pusher
// is never the author of the whole outgoing range, so "attributable to the
// current slice" refused the NORMAL trunk-publish by construction. The
// question is now commit PROVENANCE, keyed on the lane (spec + worktree),
// never the session:
//
//   governed_merge   — the commit is a worktree_merged event's merge
//                      commit or falls inside that event's recorded/
//                      derived lane range. Vetted at the merge boundary.
//   cli_bookkeeping  — recognized BY SHAPE: `chore(caws): ` subject AND
//                      every touched path confined to governed operational
//                      state (isGovernedStatePath). The CLI's own
//                      lifecycle commits; a lookalike touching anything
//                      else is NOT bookkeeping.
//   acked_exception  — unvetted, but acknowledged by a human operator
//                      (durable ack state; persists across invocations).
//   unvetted_direct  — none of the above. The ONLY commit class that
//                      refuses: a direct-on-trunk commit governance never
//                      touched.
//
// The legacy spec-attribution fields (inferredSpecIds, currentSliceMatch,
// provenanceSource, ambiguous) are RETAINED as advisory observability —
// they no longer drive the refusal.
//
// Legacy attribution rule (ADR 0001 Q1, advisory): a commit is attributed
// to EVERY active/recently-closed spec whose scope.in prefix-matches any
// file the commit touches (multi-match reported, never collapsed).
// Commit-subject SPEC-ID matching is additive — it can add an inferred
// spec, never remove a file-touch match. current_slice_match is true iff
// the current session's active spec is in the commit's match set.

import {
  CAWS_BOOKKEEPING_SUBJECT_PREFIX,
  isGovernedStatePath,
} from '../../store/git-autocommit';
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
  /** Full 40-char SHA (lowercase). Display truncates; matching does not. */
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
  /**
   * Liveness of the registered owner's session, when known (CAWS-
   * PREPUSH-PROVENANCE-REWORK-001 A7). undefined when the worktree is
   * unregistered or the owner cannot be evaluated — liveness-blind
   * escalation applies in that case. A registered worktree with a dead
   * owner session AND a fully-merged branch is a GHOST: residue, advisory
   * only, never ERROR.
   */
  readonly ownerSessionLive?: boolean;
}

export interface ClassifyRangeInput {
  /** Outgoing commits, base..HEAD order (oldest first or newest — order
   *  is preserved in the report but not relied on for decisions). */
  readonly commits: readonly OutgoingCommit[];
  /** Active + recently-closed specs available for attribution. */
  readonly specs: readonly ClassifierSpec[];
  /** The current session's active spec id, if known. Commits attributed
   *  to it are current_slice_match: true (advisory). */
  readonly currentSpecId?: string;
  /** Foreign physical worktrees observed during preflight. */
  readonly foreignWorktrees?: readonly ForeignWorktree[];
  /**
   * SHAs (full, lowercase) covered by governed merges — every
   * worktree_merged event's merge commit plus its lane range (recorded
   * post-extension; derived from the merge commit's parents for
   * pre-extension events). Collected by the caller.
   */
  readonly governedMergeShas?: readonly string[];
  /** SHAs the operator explicitly acknowledged (durable ack state plus
   *  this invocation's --ack flags, normalized by the caller). */
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

/**
 * The governance verdict for one outgoing commit
 * (CAWS-PREPUSH-PROVENANCE-REWORK-001). See the header for the class
 * definitions. Only 'unvetted_direct' refuses.
 */
export type GovernanceClass =
  | 'governed_merge'
  | 'cli_bookkeeping'
  | 'acked_exception'
  | 'unvetted_direct';

export interface CommitClassification {
  readonly sha: string;
  readonly subject: string;
  readonly touchedFiles: readonly string[];
  /** The governance verdict. Drives the refusal. */
  readonly governanceClass: GovernanceClass;
  /** Every spec id this commit is attributed to (multi-match reported,
   *  advisory). */
  readonly inferredSpecIds: readonly string[];
  /** True iff currentSpecId is in inferredSpecIds (advisory). */
  readonly currentSliceMatch: boolean;
  readonly provenanceSource: ProvenanceSource;
  /** True when no spec matched by file-touch and no known spec named in
   *  the subject (advisory). */
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
  /** Which condition(s) drove the severity. */
  readonly reasons: readonly string[];
  /**
   * True when this is residue: registered, fully merged, owner session
   * dead (A7). Ghosts are advisory (WARN) with remediation, never ERROR.
   */
  readonly ghost?: boolean;
  /** Operator-facing cleanup guidance, present on ghosts. */
  readonly remediation?: string;
}

export interface PushRangeReport {
  readonly baseRef: string;
  readonly target: PushTarget;
  readonly commits: readonly CommitClassification[];
  readonly foreignWorktrees: readonly ForeignWorktreeFinding[];
  /** Commits governance never touched and the operator has NOT acked —
   *  the only commit class that refuses. */
  readonly unvettedShas: readonly string[];
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
 * Recognized BY SHAPE, never by actor (spec invariant): the CLI's own
 * bookkeeping subject prefix AND a path set confined to governed
 * operational state. A forged `chore(caws):` commit touching anything
 * else — including .caws/policy.yaml or .caws/hooks/ — is not bookkeeping.
 * A commit touching nothing cannot be verified and is not bookkeeping.
 */
function isCliBookkeeping(commit: OutgoingCommit): boolean {
  return (
    commit.subject.startsWith(CAWS_BOOKKEEPING_SUBJECT_PREFIX) &&
    commit.touchedFiles.length > 0 &&
    commit.touchedFiles.every((f) => isGovernedStatePath(f))
  );
}

/**
 * Classify one commit: governance class (drives refusal) plus advisory
 * spec attribution. Pure.
 */
function classifyCommit(
  commit: OutgoingCommit,
  specs: readonly ClassifierSpec[],
  currentSpecId: string | undefined,
  governedMergeShas: ReadonlySet<string>,
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
  const acknowledged = ackedShas.has(commit.sha.toLowerCase());

  // The governance verdict. Governed-merge coverage is the strongest
  // signal (vetted at the merge boundary); bookkeeping is recognized by
  // shape; an ack only rescues an otherwise-unvetted commit.
  let governanceClass: GovernanceClass;
  if (governedMergeShas.has(commit.sha.toLowerCase())) {
    governanceClass = 'governed_merge';
  } else if (isCliBookkeeping(commit)) {
    governanceClass = 'cli_bookkeeping';
  } else if (acknowledged) {
    governanceClass = 'acked_exception';
  } else {
    governanceClass = 'unvetted_direct';
  }

  return {
    sha: commit.sha,
    subject: commit.subject,
    touchedFiles: commit.touchedFiles,
    governanceClass,
    inferredSpecIds,
    currentSliceMatch,
    provenanceSource,
    ambiguous,
    ...(commit.originWorktree !== undefined
      ? { originWorktree: commit.originWorktree }
      : {}),
    acknowledged,
  };
}

/**
 * Classify a foreign worktree's severity.
 *
 * CAWS-PREPUSH-PROVENANCE-REWORK-001 (A7): a GHOST — registered, branch
 * fully merged into the push base, owner session dead — is residue, not a
 * finding: it is advisory (WARN) with remediation guidance and NEVER
 * reaches ERROR. Liveness-blind cases (unregistered, or owner not
 * evaluable) keep the legacy OR-escalation: on the full-posture target,
 * any hard condition (unmerged branch / unregistered / commits in the
 * outgoing range originate from it) is an ERROR; otherwise WARN.
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

  const ghost =
    !wt.unregistered && !wt.unmerged && wt.ownerSessionLive === false;
  if (ghost) {
    reasons.push('branch fully merged into base');
    reasons.push('owner session is not live (no active lease or dead pid)');
  }

  let severity: Severity;
  if (!fullPosture) {
    // Feature-branch / non-origin-main: weakened — report, don't ERROR.
    severity = reasons.length > 0 ? 'WARN' : 'INFO';
  } else if (ghost) {
    severity = 'WARN'; // residue — advisory, cleanup guidance attached.
  } else if (reasons.length > 0) {
    severity = 'ERROR'; // OR: any one hard condition escalates on origin main.
  } else {
    severity = 'WARN'; // present during an active slice, no hard condition.
  }

  return {
    name: wt.name,
    path: wt.path,
    ...(wt.branch !== undefined ? { branch: wt.branch } : {}),
    severity,
    reasons,
    ...(ghost
      ? {
          ghost: true,
          remediation:
            `Residue from a dead session with a fully-merged branch. Clean up: ` +
            `cd ${wt.path} && caws claim --takeover (with authorization), then ` +
            `caws worktree destroy ${wt.name}; or prune the dead lease: caws agents prune --dead --apply.`,
        }
      : {}),
  };
}

/**
 * Classify the outgoing range. Pure, deterministic, side-effect-free.
 */
export function classifyRange(input: ClassifyRangeInput): PushRangeReport {
  const acked = new Set((input.ackedShas ?? []).map((s) => s.toLowerCase()));
  const governed = new Set(
    (input.governedMergeShas ?? []).map((s) => s.toLowerCase())
  );
  const fullPosture =
    input.target.remote === 'origin' && input.target.branch === 'main';

  const commits = input.commits.map((c) =>
    classifyCommit(c, input.specs, input.currentSpecId, governed, acked)
  );

  const foreignWorktrees = (input.foreignWorktrees ?? []).map((wt) =>
    classifyForeignWorktree(wt, input.commits, fullPosture)
  );

  // The only commit class that refuses: governance never touched it and
  // no operator acknowledgment covers it.
  const unvettedShas = commits
    .filter((c) => c.governanceClass === 'unvetted_direct')
    .map((c) => c.sha);

  // Max severity across foreign-worktree findings + the unvetted-commit
  // condition (an unvetted commit is an ERROR-equivalent refusal).
  let maxSeverity: Severity = 'INFO';
  for (const f of foreignWorktrees) {
    if (severityRank(f.severity) > severityRank(maxSeverity)) {
      maxSeverity = f.severity;
    }
  }
  if (unvettedShas.length > 0 && severityRank('ERROR') > severityRank(maxSeverity)) {
    maxSeverity = 'ERROR';
  }

  // Refuse iff there is any unvetted direct commit, OR any ERROR-severity
  // foreign worktree finding. WARN-only findings (including ghosts) ride
  // in the report as advisory. This is the diagnose/decide contract:
  // refuse is mechanical.
  const refused =
    unvettedShas.length > 0 ||
    foreignWorktrees.some((f) => f.severity === 'ERROR');

  return {
    baseRef: input.baseRef,
    target: input.target,
    commits,
    foreignWorktrees,
    unvettedShas,
    refused,
    maxSeverity,
  };
}
