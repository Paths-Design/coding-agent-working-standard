// Policy-derived gate disposition.
//
// Given (parsed gates report, parsed policy), produce one
// `GateDisposition` per policy-declared gate. This is the SOLE place
// where final block/warn/skip semantics are decided. Report producers
// identify violations; this module decides what they mean.
//
// Rules:
//
//   policy.gates[gate].mode === 'skip'      → result: 'skipped',  blocks=false
//   policy.gates[gate].enabled === false    → result: 'skipped',  blocks=false
//   any matched violation + mode==='block'  → result: 'fail',     blocks=true
//   any matched violation + mode==='warn'   → result: 'fail',     blocks=false
//   no matched violation                    → result: 'pass',     blocks=false
//
// A violation is "matched" to a policy gate iff the violation's `gate`
// field equals the policy gate id. Violations targeting unknown gate
// names are surfaced separately as `unmatchedViolations` so the renderer
// can show them, but they do NOT drive policy disposition.

import type { Policy } from '@paths.design/caws-kernel';

import type { GatesReport, GatesViolation } from './gate-result-contract';

export type GateMode = 'block' | 'warn' | 'skip';
export type GateOutcome = 'pass' | 'fail' | 'skipped';

export interface GateDisposition {
  readonly gate_id: string;
  readonly mode: GateMode;
  readonly outcome: GateOutcome;
  /** True iff this gate's outcome contributes to a final exit 1. */
  readonly blocks: boolean;
  /** Violations whose `gate` field equals `gate_id`. */
  readonly violations: readonly GatesViolation[];
}

export interface DispositionResult {
  /** One disposition per policy-declared gate. */
  readonly dispositions: readonly GateDisposition[];
  /** Violations from a report whose gate name was NOT a policy gate. */
  readonly unmatchedViolations: readonly GatesViolation[];
  /** True iff any disposition blocks. */
  readonly anyBlocks: boolean;
}

const KNOWN_GATE_IDS = [
  'budget_limit',
  'spec_completeness',
  'scope_boundary',
  'god_object',
  'todo_detection',
] as const;

/**
 * Mechanical aliases from legacy report gate names to canonical policy
 * gate IDs. Each alias must be a clear naming-only translation, never a
 * semantic repurposing. Adding a new alias here requires evidence that
 * the report gate and the policy gate measure the same thing under
 * different names.
 *
 * Current aliases:
 *   - `god_objects` (legacy plural) → `god_object` (policy singular).
 *     Same intent: detect files exceeding size threshold.
 *   - `hidden-todo` (legacy internal name) → `todo_detection` (policy
 *     canonical). Same intent: detect hidden incomplete implementations.
 *
 * Refused aliases (semantically distinct, not naming variants):
 *   - `code_freeze` → `budget_limit` (crisis-response vs risk-tier budget)
 *   - `naming` → `spec_completeness` (identifier conventions vs spec health)
 *   - `duplication`, `documentation`, `placeholders`, `simplification`:
 *     no policy correspondent; remain in `unmatchedViolations`.
 */
const REPORT_GATE_TO_POLICY_GATE: Readonly<Record<string, string>> = {
  god_objects: 'god_object',
  'hidden-todo': 'todo_detection',
};

function canonicalGateName(reportGate: string): string {
  return REPORT_GATE_TO_POLICY_GATE[reportGate] ?? reportGate;
}

// gateId is a plain string: the authoritative iteration set is
// policy.gates keys (CAWS-GATES-POLICY-DISPOSITION-DRIFT-001), which
// includes gates beyond the canonical KNOWN_GATE_IDS tuple.
function gateConfigFor(
  policy: Policy,
  gateId: string
): { enabled: boolean; mode: GateMode } | undefined {
  // Policy.gates is typed (in the kernel) as a fixed-shape object over the
  // canonical gate names; the kernel type is scope.out for this slice. Read
  // through a string-indexable view so policy-declared gates beyond the
  // canonical set are reachable (CAWS-GATES-POLICY-DISPOSITION-DRIFT-001).
  // The shape of each value (enabled, mode) is unchanged.
  const gates = policy.gates as Record<
    string,
    { enabled: boolean; mode: string } | undefined
  >;
  const cfg = gates[gateId];
  if (cfg === undefined) return undefined;
  return { enabled: cfg.enabled, mode: cfg.mode as GateMode };
}

/**
 * The authoritative iteration set for disposition derivation: every gate
 * DECLARED in policy.gates. KNOWN_GATE_IDS is used ONLY to pin a stable,
 * deterministic order for the canonical five (so existing output ordering
 * is preserved); any additional policy-declared gate is appended after
 * them in policy declaration order.
 *
 * CAWS-GATES-POLICY-DISPOSITION-DRIFT-001: iterating KNOWN_GATE_IDS alone
 * silently demoted any policy-declared gate not in the tuple (a mode:block
 * gate would never block). The known tuple is order/metadata only, never
 * the authority filter for which gates are evaluated.
 */
function orderedPolicyGateIds(policy: Policy): string[] {
  const declared = Object.keys(policy.gates);
  const declaredSet = new Set(declared);
  const ordered: string[] = [];
  // Canonical five first, in their fixed order, when declared.
  for (const id of KNOWN_GATE_IDS) {
    if (declaredSet.has(id)) ordered.push(id);
  }
  // Then any other declared gate, in policy declaration order.
  const known = new Set<string>(KNOWN_GATE_IDS);
  for (const id of declared) {
    if (!known.has(id)) ordered.push(id);
  }
  return ordered;
}

export function deriveDispositions(
  report: GatesReport,
  policy: Policy
): DispositionResult {
  // Group violations by canonical gate name (applying mechanical aliases).
  const byGate = new Map<string, GatesViolation[]>();
  for (const v of report.violations) {
    const canonical = canonicalGateName(v.gate);
    const list = byGate.get(canonical);
    if (list === undefined) byGate.set(canonical, [v]);
    else list.push(v);
  }

  const dispositions: GateDisposition[] = [];
  // Iterate every POLICY-DECLARED gate (authority), ordered canonical-first
  // for stable output. KNOWN_GATE_IDS is order/metadata only — it does NOT
  // decide which gates are evaluated (CAWS-GATES-POLICY-DISPOSITION-DRIFT-001).
  for (const gateId of orderedPolicyGateIds(policy)) {
    const cfg = gateConfigFor(policy, gateId);
    if (cfg === undefined) continue; // gate not declared in policy
    const violations = byGate.get(gateId) ?? [];
    byGate.delete(gateId);

    let outcome: GateOutcome;
    let blocks: boolean;
    if (cfg.enabled === false || cfg.mode === 'skip') {
      outcome = 'skipped';
      blocks = false;
    } else if (violations.length === 0) {
      outcome = 'pass';
      blocks = false;
    } else {
      outcome = 'fail';
      blocks = cfg.mode === 'block';
    }

    dispositions.push({
      gate_id: gateId,
      mode: cfg.mode,
      outcome,
      blocks,
      violations,
    });
  }

  // Whatever remains in byGate are unmatched violations (gates the report
  // included but policy doesn't declare).
  const unmatchedViolations: GatesViolation[] = [];
  for (const list of byGate.values()) unmatchedViolations.push(...list);

  return {
    dispositions,
    unmatchedViolations,
    anyBlocks: dispositions.some((d) => d.blocks),
  };
}
