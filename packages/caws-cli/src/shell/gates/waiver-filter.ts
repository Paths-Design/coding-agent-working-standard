// Waiver filter — shell-level helper that removes effective-waiver-suppressed
// violations from a GatesReport before disposition.
//
// Discipline:
//
//   1. This helper does NOT mutate `policy.gates[gate].mode`. A waived
//      violation is removed from the blocking calculation, but the gate's
//      block/warn/skip meaning still comes only from policy. After filtering,
//      `deriveDispositions(filteredReport, policy)` is run unchanged.
//
//   2. Applicability is delegated to the kernel
//      (`effectiveWaiversForGate`) so kernel rules stay the single source
//      of truth. The shell only knows: "given the per-gate effective
//      waivers, drop the violations that match this gate."
//
//   3. Path scoping (`scope.paths`) is intentionally absent. The kernel
//      type does not include it. Doing it half-way here would be worse
//      than deferring it to a later slice.
//
//   4. The "violation matched this gate" rule is the same as
//      `deriveDispositions`'s grouping rule: violations whose `gate`
//      field equals a gate in the waiver's `gates` list. We do NOT use
//      the violation's `severity` field for matching — policy and waivers
//      are both gate-level constructs in this slice; per-violation
//      identity (e.g. by rule + subject) is not yet a thing waivers
//      address.
//
//   5. Subprocess "unmatched" gates (gates the subprocess reports but
//      policy doesn't declare) are never waiver-suppressed: waivers
//      filter violations that policy can act on, and unmatched gates
//      are observational by construction. Leaving them untouched here
//      preserves the existing `unmatchedViolations` surface.

import {
  effectiveWaiversForGate,
  type Waiver,
} from '@paths.design/caws-kernel';

import type { GatesReport, GatesViolation } from './gate-result-contract';

export interface WaiverFilterInput {
  readonly report: GatesReport;
  readonly waivers: readonly Waiver[];
  readonly specId: string;
  readonly now: Date;
  /**
   * Gate ids the policy declares. Violations targeting any other gate
   * pass through the filter unmodified — waivers MUST NOT promote an
   * unmatched (subprocess-only) violation to a policy-suppressed state,
   * because policy doesn't own that gate. Treating waivers as scoped to
   * policy-declared gates keeps the unmatched bucket purely
   * observational, which is the contract `deriveDispositions` relies on.
   *
   * If omitted, every gate is considered policy-declared (legacy / test
   * convenience). Production callers should always pass this.
   */
  readonly policyGateIds?: readonly string[];
}

export interface WaiverEvidence {
  /** Number of violations on this gate that an effective waiver suppressed. */
  readonly waived_count: number;
  /** Stable ids of the waivers credited with the suppression, deduped + sorted. */
  readonly waiver_ids: readonly string[];
}

export interface WaiverFilterResult {
  /**
   * The same report shape, but with `violations` reduced to those NOT
   * suppressed by an effective waiver. `warnings`, `timestamp`,
   * `context`, `files_scoped`, and the optional `waivers` / `performance`
   * blocks are passed through unchanged.
   */
  readonly reportForDisposition: GatesReport;
  /**
   * Per-gate evidence keyed by the violation's `gate` field. Only gates
   * that actually had at least one suppression appear here. Gates with
   * zero suppressions are intentionally omitted: callers should default
   * them to `{ waived_count: 0, waiver_ids: [] }` if they need a uniform
   * shape, but the canonical form is "absent means zero".
   */
  readonly waivedByGate: Readonly<Record<string, WaiverEvidence>>;
}

/**
 * Filter `report.violations` against the supplied effective waivers.
 *
 * For each violation:
 *   - look up the effective waivers for that violation's gate (kernel call)
 *   - if any are effective, the violation is suppressed and the waivers'
 *     ids are recorded as evidence on that gate's bucket
 *   - if none are effective, the violation passes through unchanged
 *
 * The kernel's effectiveness rule (active && not expired && gate matches
 * && (no spec_id OR matches input.specId)) is the only applicability
 * decision. Path scoping is not consulted (see file header).
 */
export function filterWaivedViolations(
  input: WaiverFilterInput
): WaiverFilterResult {
  // Per-gate effective waivers, computed lazily so we don't pay the cost
  // for gates that have no violations in this report.
  const effectiveByGate = new Map<string, readonly Waiver[]>();
  const policyGateSet =
    input.policyGateIds === undefined
      ? undefined
      : new Set<string>(input.policyGateIds);

  function effectiveFor(gate: string): readonly Waiver[] {
    // Waivers only touch policy-declared gates. An unmatched (subprocess-
    // only) violation is observational by construction; letting waivers
    // suppress it would break that contract and confuse the unmatched
    // surface in `deriveDispositions`.
    if (policyGateSet !== undefined && !policyGateSet.has(gate)) {
      return [];
    }
    const cached = effectiveByGate.get(gate);
    if (cached !== undefined) return cached;
    const computed = effectiveWaiversForGate({
      waivers: input.waivers,
      gate,
      specId: input.specId,
      now: input.now,
    });
    effectiveByGate.set(gate, computed);
    return computed;
  }

  const survivors: GatesViolation[] = [];
  const evidenceByGate = new Map<string, Set<string>>();

  for (const v of input.report.violations) {
    const effective = effectiveFor(v.gate);
    if (effective.length === 0) {
      survivors.push(v);
      continue;
    }
    // Suppressed. Credit every effective waiver — overlapping coverage is
    // fine; the audit record names every authorized exception.
    let bucket = evidenceByGate.get(v.gate);
    if (bucket === undefined) {
      bucket = new Set<string>();
      evidenceByGate.set(v.gate, bucket);
    }
    for (const w of effective) bucket.add(w.id);
  }

  const waivedByGate: Record<string, WaiverEvidence> = {};
  for (const [gate, ids] of evidenceByGate) {
    const sorted = Array.from(ids).sort();
    // waived_count counts violations on this gate that were suppressed,
    // not waivers credited. Recompute by re-walking; cheaper than carrying
    // a parallel counter and keeps the meaning explicit.
    let count = 0;
    for (const v of input.report.violations) {
      if (v.gate !== gate) continue;
      if (effectiveFor(v.gate).length > 0) count++;
    }
    waivedByGate[gate] = {
      waived_count: count,
      waiver_ids: sorted,
    };
  }

  const reportForDisposition: GatesReport = {
    ...input.report,
    violations: survivors,
  };

  return { reportForDisposition, waivedByGate };
}
