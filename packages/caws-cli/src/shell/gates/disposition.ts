// Policy-derived gate disposition.
//
// Given (parsed quality-gates report, parsed policy), produce one
// `GateDisposition` per policy-declared gate. This is the SOLE place
// where final block/warn/skip semantics are decided. The subprocess
// reports violations; this module decides what they mean.
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
// names (subprocess-specific checks like 'naming') are surfaced
// separately as `unmatchedViolations` so the renderer can show them,
// but they do NOT drive policy disposition.

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
  /** Violations from the subprocess whose gate name was NOT a policy gate. */
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
 * Mechanical aliases from subprocess gate names to canonical policy
 * gate IDs. Each alias must be a clear naming-only translation, never a
 * semantic repurposing. Adding a new alias here requires evidence that
 * the subprocess gate and the policy gate measure the same thing under
 * different names.
 *
 * Current aliases:
 *   - `god_objects` (subprocess plural) → `god_object` (policy singular).
 *     Same intent: detect files exceeding size threshold.
 *   - `hidden-todo` (subprocess internal name) → `todo_detection` (policy
 *     canonical). Same intent: detect hidden incomplete implementations.
 *     NOTE: the subprocess `runHiddenTodoQualityGate` currently throws on
 *     errors instead of emitting violations, so this alias is only useful
 *     once that producer path is fixed (LEGACY-TEST-RECONCILE-001 follow-up).
 *
 * Refused aliases (semantically distinct, not naming variants):
 *   - `code_freeze` → `budget_limit` (crisis-response vs risk-tier budget)
 *   - `naming` → `spec_completeness` (identifier conventions vs spec health)
 *   - `duplication`, `documentation`, `placeholders`, `simplification`:
 *     no policy correspondent; remain in `unmatchedViolations`.
 */
const SUBPROCESS_GATE_TO_POLICY_GATE: Readonly<Record<string, string>> = {
  god_objects: 'god_object',
  'hidden-todo': 'todo_detection',
};

function canonicalGateName(subprocessGate: string): string {
  return SUBPROCESS_GATE_TO_POLICY_GATE[subprocessGate] ?? subprocessGate;
}

function gateConfigFor(
  policy: Policy,
  gateId: (typeof KNOWN_GATE_IDS)[number]
): { enabled: boolean; mode: GateMode } | undefined {
  const cfg = policy.gates[gateId];
  if (cfg === undefined) return undefined;
  return { enabled: cfg.enabled, mode: cfg.mode as GateMode };
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
  for (const gateId of KNOWN_GATE_IDS) {
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

  // Whatever remains in byGate are unmatched violations (gates the
  // subprocess reported but policy doesn't declare).
  const unmatchedViolations: GatesViolation[] = [];
  for (const list of byGate.values()) unmatchedViolations.push(...list);

  return {
    dispositions,
    unmatchedViolations,
    anyBlocks: dispositions.some((d) => d.blocks),
  };
}
