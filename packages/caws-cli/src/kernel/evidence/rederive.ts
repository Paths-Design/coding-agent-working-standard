/**
 * Acceptance-evidence re-derivation — CAWS-SPECS-VERIFY-ACS-REDERIVE-001.
 *
 * An evidence entry carries a `status` and, optionally, machine-checkable
 * citations: `commit_sha`, `artifact_path`, `test_nodeid`, `command`. Before
 * this module nothing read the citations; the close gate read `status` alone,
 * so a hand-edited `status: pass` satisfied it with no second reader. This
 * module is the second reader.
 *
 * PURITY. Nothing here touches the filesystem, git, a subprocess, the
 * environment, or a clock. The module splits the work in three so the impure
 * part can live in the store:
 *
 *   planRederivation(spec)            -> what to check, per criterion   (pure)
 *   <the store executes the plan>     -> RederivationReport             (impure)
 *   classifyRederivation(plan, report)-> verdicts                       (pure)
 *
 * Same discipline as the successor-custody gate: the store INJECTS data, the
 * kernel decides. An `undefined` report is a distinct, load-bearing input — it
 * yields NOT_REDERIVED for every check, never VERIFIED, so "could not check"
 * is never confused with "checked and clean".
 *
 * THREE VERDICTS, NEVER COLLAPSED. The v10.2 `verify-acs` mapped "the test was
 * collected" straight onto PASS, and the port of it in downstream repos does
 * the same. Existence of a check is not execution; execution is not passing.
 * A check that was found but not run is NOT_REDERIVED, and NOT_REDERIVED never
 * counts toward VERIFIED.
 *
 * COMMAND IS NEVER EXECUTED. A `command` (or acceptance `test_command`) is a
 * string authored by the agent whose work is being judged. The plan marks it
 * non-executable, and classification reports COMMAND_NOT_EXECUTED even if a
 * store wrongly supplies an outcome for it — the invariant is enforced at the
 * point of decision, not left to the caller's discipline.
 *
 * WHAT THIS DOES NOT CLAIM. Re-deriving a citation proves the citation is real
 * — the sha is an object, the path exists, the test passes. It does not prove
 * the citation is RELEVANT to the criterion; the agent chose it after the
 * outcome was known. Every verdict derived from an agent-supplied field is
 * therefore marked `self_reported` so a self-assertion reads as one.
 */

import type { EvidenceRecord, EvidenceStatus, Spec } from '../spec/types';

export const REDERIVATION_VERDICTS = ['verified', 'refuted', 'not_rederived'] as const;
export type RederivationVerdict = (typeof REDERIVATION_VERDICTS)[number];

export const CHECK_CLASSES = ['citation', 'artifact', 'test', 'command'] as const;
export type CheckClass = (typeof CHECK_CLASSES)[number];

/**
 * Where a declared check came from. Both sources are agent-authored in this
 * slice; the distinction exists so a divergence between them can be reported
 * and so a future non-agent source (a CI-recorded entry) has somewhere to go.
 */
export const CHECK_SOURCES = ['evidence', 'acceptance'] as const;
export type CheckSource = (typeof CHECK_SOURCES)[number];

/**
 * What the store may observe when it executes one check. Deliberately a
 * closed vocabulary of FACTS about the world, not verdicts — the mapping to a
 * verdict happens here, once, so no caller can re-map `not_run` onto pass.
 */
export const CHECK_OUTCOMES = [
  'passed',
  'failed',
  'missing',
  'unreachable',
  'refused',
  'unavailable',
  'timeout',
  'not_run',
] as const;
export type CheckOutcomeKind = (typeof CHECK_OUTCOMES)[number];

export const REDERIVATION_REASONS = [
  // verified
  'passed',
  // refuted
  'test_failed',
  'test_not_found',
  'artifact_missing',
  'object_missing',
  'object_unreachable',
  'target_refused',
  // not_rederived
  'no_evidence',
  'no_mechanical_field',
  'command_not_executed',
  'runner_unavailable',
  'timeout',
  'not_run',
  'report_unavailable',
  'outcome_missing',
] as const;
export type RederivationReason = (typeof REDERIVATION_REASONS)[number];

export interface DeclaredCheck {
  readonly class: CheckClass;
  /** The sha, path, nodeid, or command string exactly as declared. */
  readonly target: string;
  readonly source: CheckSource;
  /** False for every `command` check. The store must not execute a non-executable check. */
  readonly executable: boolean;
}

export interface CriterionPlan {
  readonly id: string;
  /** `undefined` when the criterion has no evidence entry at all. */
  readonly status: EvidenceStatus | undefined;
  readonly checks: readonly DeclaredCheck[];
}

export interface RederivationPlan {
  readonly criteria: readonly CriterionPlan[];
}

export interface CheckOutcome {
  readonly class: CheckClass;
  readonly target: string;
  readonly outcome: CheckOutcomeKind;
  readonly detail?: string;
}

/** Built by the store. `outcomes` is keyed by criterion id. */
export interface RederivationReport {
  readonly outcomes: Readonly<Record<string, readonly CheckOutcome[]>>;
}

export interface CheckVerdict {
  readonly class: CheckClass;
  readonly target: string;
  readonly source: CheckSource;
  readonly verdict: RederivationVerdict;
  readonly reason: RederivationReason;
  readonly detail?: string;
}

export interface CriterionVerdict {
  readonly id: string;
  readonly status: EvidenceStatus | undefined;
  readonly verdict: RederivationVerdict;
  /** The reason that decided the verdict (the first check in the deciding class). */
  readonly reason: RederivationReason;
  /** True when any check derives from an agent-supplied field. Always true when checks exist in this slice. */
  readonly self_reported: boolean;
  readonly checks: readonly CheckVerdict[];
  /** Present when the acceptance criterion declares nodeids and the evidence names one outside them. */
  readonly divergence?: { readonly declared: readonly string[]; readonly reported: string };
}

export interface RederivationSummary {
  readonly total: number;
  readonly verified: number;
  readonly refuted: number;
  readonly not_rederived: number;
  /** Criteria with no mechanical field at all (no entry, or an entry with only status/evidence_ref). */
  readonly narrative_only: number;
  /** Criteria whose verdict rests on at least one agent-supplied field. */
  readonly self_reported: number;
  /** Criteria that declared a `command`/`test_command` — recorded, never executed. */
  readonly command_declared: number;
}

// ─── plan ────────────────────────────────────────────────────────────────────

function evidenceByCriterion(spec: Spec): Map<string, EvidenceRecord> {
  const map = new Map<string, EvidenceRecord>();
  for (const entry of spec.evidence ?? []) {
    map.set(entry.criterion_id, entry);
  }
  return map;
}

/**
 * Derive the declared checks for every acceptance criterion. Pure: reads only
 * the spec. Evidence-level fields come first; acceptance-level `test_nodeids`
 * are added as separate `acceptance`-sourced checks, deduplicated against an
 * identical evidence nodeid so the same test is not run twice.
 */
export function planRederivation(spec: Spec): RederivationPlan {
  const evidence = evidenceByCriterion(spec);
  const criteria: CriterionPlan[] = [];

  for (const ac of spec.acceptance) {
    const entry = evidence.get(ac.id);
    const checks: DeclaredCheck[] = [];

    if (entry !== undefined) {
      if (entry.commit_sha !== undefined) {
        checks.push({
          class: 'citation',
          target: entry.commit_sha,
          source: 'evidence',
          executable: true,
        });
      }
      if (entry.artifact_path !== undefined) {
        checks.push({
          class: 'artifact',
          target: entry.artifact_path,
          source: 'evidence',
          executable: true,
        });
      }
      if (entry.test_nodeid !== undefined) {
        checks.push({
          class: 'test',
          target: entry.test_nodeid,
          source: 'evidence',
          executable: true,
        });
      }
      if (entry.command !== undefined) {
        checks.push({
          class: 'command',
          target: entry.command,
          source: 'evidence',
          executable: false,
        });
      }
    }

    for (const nodeid of ac.test_nodeids ?? []) {
      const duplicate = checks.some((c) => c.class === 'test' && c.target === nodeid);
      if (!duplicate) {
        checks.push({ class: 'test', target: nodeid, source: 'acceptance', executable: true });
      }
    }
    if (ac.test_command !== undefined) {
      checks.push({
        class: 'command',
        target: ac.test_command,
        source: 'acceptance',
        executable: false,
      });
    }

    criteria.push({ id: ac.id, status: entry?.status, checks });
  }

  return { criteria };
}

// ─── classify ────────────────────────────────────────────────────────────────

const VERDICT_RANK: Readonly<Record<RederivationVerdict, number>> = {
  refuted: 0,
  not_rederived: 1,
  verified: 2,
};

/** Map one observed outcome to a verdict, by class. The only place this mapping lives. */
function verdictForOutcome(
  cls: CheckClass,
  outcome: CheckOutcomeKind
): { verdict: RederivationVerdict; reason: RederivationReason } {
  switch (outcome) {
    case 'passed':
      return { verdict: 'verified', reason: 'passed' };
    case 'failed':
      return { verdict: 'refuted', reason: 'test_failed' };
    case 'missing':
      return {
        verdict: 'refuted',
        reason:
          cls === 'citation'
            ? 'object_missing'
            : cls === 'artifact'
              ? 'artifact_missing'
              : 'test_not_found',
      };
    case 'unreachable':
      return { verdict: 'refuted', reason: 'object_unreachable' };
    case 'refused':
      return { verdict: 'refuted', reason: 'target_refused' };
    case 'unavailable':
      return { verdict: 'not_rederived', reason: 'runner_unavailable' };
    case 'timeout':
      return { verdict: 'not_rederived', reason: 'timeout' };
    case 'not_run':
      // The ancestral bug lives on the other side of this line: a check that
      // was found but never executed is NOT verified.
      return { verdict: 'not_rederived', reason: 'not_run' };
  }
}

function classifyCheck(
  check: DeclaredCheck,
  outcomes: readonly CheckOutcome[] | undefined,
  reportAvailable: boolean
): CheckVerdict {
  const base = { class: check.class, target: check.target, source: check.source };

  if (!check.executable) {
    // A command is recorded, never run. Any outcome a store supplies for it is
    // ignored here rather than trusted — the decision point owns the invariant.
    return { ...base, verdict: 'not_rederived', reason: 'command_not_executed' };
  }
  if (!reportAvailable) {
    return { ...base, verdict: 'not_rederived', reason: 'report_unavailable' };
  }
  const observed = outcomes?.find((o) => o.class === check.class && o.target === check.target);
  if (observed === undefined) {
    return { ...base, verdict: 'not_rederived', reason: 'outcome_missing' };
  }
  const mapped = verdictForOutcome(check.class, observed.outcome);
  return observed.detail !== undefined
    ? { ...base, ...mapped, detail: observed.detail }
    : { ...base, ...mapped };
}

function divergenceFor(spec: Spec, plan: CriterionPlan): CriterionVerdict['divergence'] {
  const ac = spec.acceptance.find((a) => a.id === plan.id);
  const declared = ac?.test_nodeids;
  if (declared === undefined || declared.length === 0) return undefined;
  const reported = plan.checks.find((c) => c.class === 'test' && c.source === 'evidence');
  if (reported === undefined) return undefined;
  return declared.includes(reported.target) ? undefined : { declared, reported: reported.target };
}

/**
 * Classify every criterion in the plan against the store's report. A
 * criterion's verdict is the WEAKEST of its checks (refuted < not_rederived <
 * verified): VERIFIED means every citation it made holds; one unrun or failed
 * check is enough to withhold it.
 */
export function classifyRederivation(
  spec: Spec,
  plan: RederivationPlan,
  report: RederivationReport | undefined
): CriterionVerdict[] {
  const verdicts: CriterionVerdict[] = [];

  for (const criterion of plan.criteria) {
    const outcomes = report?.outcomes[criterion.id];
    const checks = criterion.checks.map((c) => classifyCheck(c, outcomes, report !== undefined));
    const selfReported = checks.some((c) => c.source === 'evidence' || c.source === 'acceptance');

    let verdict: RederivationVerdict;
    let reason: RederivationReason;
    if (checks.length === 0) {
      verdict = 'not_rederived';
      reason = criterion.status === undefined ? 'no_evidence' : 'no_mechanical_field';
    } else {
      const deciding = checks.reduce((worst, c) =>
        VERDICT_RANK[c.verdict] < VERDICT_RANK[worst.verdict] ? c : worst
      );
      verdict = deciding.verdict;
      reason = deciding.reason;
    }

    const divergence = divergenceFor(spec, criterion);
    verdicts.push({
      id: criterion.id,
      status: criterion.status,
      verdict,
      reason,
      self_reported: selfReported,
      checks,
      ...(divergence !== undefined ? { divergence } : {}),
    });
  }

  return verdicts;
}

export function summarizeRederivation(verdicts: readonly CriterionVerdict[]): RederivationSummary {
  let verified = 0;
  let refuted = 0;
  let notRederived = 0;
  let narrativeOnly = 0;
  let selfReported = 0;
  let commandDeclared = 0;
  for (const v of verdicts) {
    if (v.verdict === 'verified') verified += 1;
    else if (v.verdict === 'refuted') refuted += 1;
    else notRederived += 1;
    if (v.checks.length === 0) narrativeOnly += 1;
    if (v.self_reported) selfReported += 1;
    if (v.checks.some((c) => c.class === 'command')) commandDeclared += 1;
  }
  return {
    total: verdicts.length,
    verified,
    refuted,
    not_rederived: notRederived,
    narrative_only: narrativeOnly,
    self_reported: selfReported,
    command_declared: commandDeclared,
  };
}
