import { diagnostic } from '../diagnostics';
import { err, ok } from '../result';
import type { Result } from '../result/types';
import type { RiskTier } from '../spec/types';
import { POLICY_RULES } from './rules';
import type {
  AppliedWaiverEntry,
  BudgetDerivationTrace,
  EffectiveBudget,
  Policy,
  SkippedWaiverEntry,
  Waiver,
} from './types';

export interface DeriveBudgetOptions {
  /**
   * Time injection for deterministic expiry checks. REQUIRED.
   *
   * Kernel purity invariant (caws-vnext-command-surface §6.3): the kernel
   * must not call wall-clock time. Callers always supply `now`. Omitting
   * `now` throws — there is no implicit `new Date()` fallback.
   *
   * String form is parsed as ISO-8601; that's deterministic input
   * conversion, not clock access.
   */
  now: Date | string;
}

/**
 * Pure budget derivation.
 *
 *   baseline = policy.risk_tiers[String(spec.risk_tier)]
 *   effective = baseline + sum(applicable budget_limit waiver deltas)
 *
 * A waiver applies iff:
 *   - status === 'active'
 *   - expires_at is absent OR strictly after `now`
 *   - gates includes 'budget_limit'
 *   - delta values (when present) are non-negative
 *   - approvers length >= policy.waivers.min_approvers_for_budget_raise (default 1)
 *     when the waiver actually raises budget (delta has a positive value)
 *
 * spec.change_budget is NEVER consulted. The signature deliberately
 * accepts only the spec's risk_tier — no other field — so a stray
 * change_budget cannot leak into derivation.
 */
export function deriveBudget(
  policy: Policy,
  spec: { risk_tier: RiskTier },
  waivers: readonly Waiver[],
  options: DeriveBudgetOptions,
): Result<{ budget: EffectiveBudget; trace: BudgetDerivationTrace }> {
  const tierKey = String(spec.risk_tier) as '1' | '2' | '3';
  const baseline = policy.risk_tiers[tierKey];

  if (!baseline) {
    return err(
      diagnostic({
        rule: POLICY_RULES.BUDGET_TIER_NOT_FOUND,
        authority: 'kernel/policy',
        message: `Policy has no risk_tiers entry for tier ${tierKey}.`,
        subject: '.caws/policy.yaml',
        location: { pointer: `/risk_tiers/${tierKey}` },
        narrowRepair: `Add risk_tiers["${tierKey}"] with max_files and max_loc.`,
      }),
    );
  }

  const now = resolveNow(options.now);
  const minApprovers = policy.waivers?.min_approvers_for_budget_raise ?? 1;

  let effectiveFiles = baseline.max_files;
  let effectiveLoc = baseline.max_loc;
  const applied: AppliedWaiverEntry[] = [];
  const skipped: SkippedWaiverEntry[] = [];

  for (const waiver of waivers) {
    const decision = evaluateWaiver(waiver, now, minApprovers);
    if (decision.kind === 'skip') {
      skipped.push({
        waiver_id: waiver.waiver_id,
        reason: decision.reason,
        ...(decision.detail !== undefined && { detail: decision.detail }),
      });
      continue;
    }
    effectiveFiles += decision.delta.max_files;
    effectiveLoc += decision.delta.max_loc;
    applied.push({
      waiver_id: waiver.waiver_id,
      delta: decision.delta,
    });
  }

  const trace: BudgetDerivationTrace = {
    tier: spec.risk_tier,
    baseline: { max_files: baseline.max_files, max_loc: baseline.max_loc },
    appliedWaivers: applied,
    skippedWaivers: skipped,
    effective: { max_files: effectiveFiles, max_loc: effectiveLoc },
    evaluatedAt: now.toISOString(),
  };

  return ok({
    budget: { max_files: effectiveFiles, max_loc: effectiveLoc },
    trace,
  });
}

type WaiverDecision =
  | { kind: 'apply'; delta: { max_files: number; max_loc: number } }
  | { kind: 'skip'; reason: SkippedWaiverEntry['reason']; detail?: string };

function evaluateWaiver(waiver: Waiver, now: Date, minApprovers: number): WaiverDecision {
  if (waiver.status !== 'active') {
    return { kind: 'skip', reason: 'status_not_active', detail: `status=${waiver.status}` };
  }

  if (!Array.isArray(waiver.gates) || !waiver.gates.includes('budget_limit')) {
    return { kind: 'skip', reason: 'gate_not_covered', detail: 'budget_limit not in waiver.gates' };
  }

  if (waiver.expires_at !== undefined) {
    const exp = parseDate(waiver.expires_at);
    if (exp === null) {
      return { kind: 'skip', reason: 'malformed', detail: `unparseable expires_at=${waiver.expires_at}` };
    }
    if (exp.getTime() <= now.getTime()) {
      return { kind: 'skip', reason: 'expired', detail: `expired_at=${waiver.expires_at}` };
    }
  }

  const dFiles = waiver.delta?.max_files ?? 0;
  const dLoc = waiver.delta?.max_loc ?? 0;

  if (dFiles < 0 || dLoc < 0) {
    return { kind: 'skip', reason: 'negative_delta', detail: `delta files=${dFiles} loc=${dLoc}` };
  }

  // Approver gate only matters when the waiver actually raises budget.
  if (dFiles > 0 || dLoc > 0) {
    const approverCount = waiver.approvers?.length ?? 0;
    if (approverCount < minApprovers) {
      return {
        kind: 'skip',
        reason: 'insufficient_approvers',
        detail: `${approverCount} < required ${minApprovers}`,
      };
    }
  }

  return {
    kind: 'apply',
    delta: { max_files: dFiles, max_loc: dLoc },
  };
}

function resolveNow(now: Date | string | undefined): Date {
  if (now === undefined) {
    // Kernel purity invariant: no wall-clock fallback.
    throw new Error('deriveBudget: `now` is required (Date | ISO string).');
  }
  if (now instanceof Date) return now;
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`deriveBudget: invalid now value: ${String(now)}`);
  }
  return d;
}

function parseDate(s: string): Date | null {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}
