/**
 * CAWS-BUDGET-LIMIT-ADVISORY-SIZING-GOAL-01 — kernel side.
 *
 * Risk-tier change budgets are a sizing goal, not a limit. Enforcing them
 * pushed agents to trim, defer or stub work to come in under a line count,
 * which is the opposite of durable software; the boundary CAWS enforces is
 * scope. So the policy layer must stop asking for budget_limit to block, and
 * must say so plainly when a policy still declares block (the old default),
 * because a config that reads "block" while nothing blocks is a lie unless it
 * is reported.
 *
 * Controls: spec_completeness and scope_boundary are still critical gates —
 * their not-blocking warnings must survive, or this test would pass against a
 * change that silently dropped every posture check.
 */

import { parseAndValidatePolicy } from '../../../src/kernel/policy';
import { validatePolicySemantics } from '../../../src/kernel/policy/validate-semantics';
import { POLICY_RULES } from '../../../src/kernel/policy/rules';
import { inspectProjectState } from '../../../src/kernel/doctor/inspect';
import { DOCTOR_RULES } from '../../../src/kernel/doctor/rules';
import type { Diagnostic } from '../../../src/kernel/diagnostics/types';
import type { Policy } from '../../../src/kernel/policy/types';

const NOW = new Date('2026-10-01T12:00:00.000Z');

type Mode = 'block' | 'warn' | 'skip';

function policy(modes: { budget?: Mode; completeness?: Mode; scope?: Mode } = {}): Policy {
  return {
    version: 1,
    risk_tiers: {
      '1': { max_files: 5, max_loc: 200 },
      '2': { max_files: 15, max_loc: 600 },
      '3': { max_files: 30, max_loc: 1500 },
    },
    gates: {
      budget_limit: { enabled: true, mode: modes.budget ?? 'warn' },
      spec_completeness: { enabled: true, mode: modes.completeness ?? 'block' },
      scope_boundary: { enabled: true, mode: modes.scope ?? 'block' },
      god_object: { enabled: true, mode: 'warn' },
      todo_detection: { enabled: true, mode: 'warn' },
    },
    edit_rules: {
      policy_and_code_same_pr: true,
      require_signed_commits: false,
      require_dual_control_for_governance: false,
    },
  } as unknown as Policy;
}

function semanticWarnings(p: Policy): readonly Diagnostic[] {
  const result = validatePolicySemantics(p);
  if (!result.ok) throw new Error(`policy unexpectedly invalid: ${JSON.stringify(result.errors)}`);
  return result.warnings ?? [];
}

describe('policy semantics: budget_limit is advisory', () => {
  test('budget_limit in warn mode draws no warning at all', () => {
    expect(semanticWarnings(policy({ budget: 'warn' }))).toEqual([]);
  });

  test('budget_limit in block mode is reported as not honored, with the one-line repair', () => {
    const warnings = semanticWarnings(policy({ budget: 'block' }));
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w.rule).toBe(POLICY_RULES.ADVISORY_GATE_BLOCK_NOT_HONORED);
    expect(w.severity).toBe('warning');
    expect(w.location).toEqual({ pointer: '/gates/budget_limit/mode' });
    expect(w.message).toBe(
      'Gate "budget_limit" is advisory: risk-tier budgets are a sizing goal, not a limit, so mode "block" is not honored and the gate never blocks.'
    );
    expect(w.narrowRepair).toBe('Set gates.budget_limit.mode to "warn".');
  });

  test('a budget_limit in block mode is never reported as a critical gate', () => {
    const rules = semanticWarnings(policy({ budget: 'block' })).map((w) => w.rule);
    expect(rules).not.toContain(POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING);
  });

  test('spec_completeness and scope_boundary out of block mode still warn as critical gates', () => {
    const warnings = semanticWarnings(policy({ completeness: 'warn', scope: 'skip' }));
    expect(warnings.map((w) => [w.rule, w.location])).toEqual([
      [POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING, { pointer: '/gates/spec_completeness/mode' }],
      [POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING, { pointer: '/gates/scope_boundary/mode' }],
    ]);
  });
});

// CAWS-BUDGET-ADVISORY-CLEANUP-01. A budget-raise approver count reads as a
// process for buying a bigger budget; none exists. Existing consumer policies
// carry the key, so it must keep loading (through the full parse + strict
// schema path) while being named as inert.
describe('policy load: min_approvers_for_budget_raise is accepted but named inert', () => {
  const POLICY_YAML = [
    'version: 1',
    'risk_tiers:',
    "  '1': { max_files: 5, max_loc: 200 }",
    "  '2': { max_files: 15, max_loc: 600 }",
    "  '3': { max_files: 30, max_loc: 1500 }",
    'gates:',
    '  budget_limit: { enabled: true, mode: warn }',
    '  spec_completeness: { enabled: true, mode: block }',
    '  scope_boundary: { enabled: true, mode: block }',
  ].join('\n');

  test('a policy carrying the key still loads, with exactly one inert-key warning', () => {
    const result = parseAndValidatePolicy(
      `${POLICY_YAML}\nwaivers:\n  min_approvers_for_budget_raise: 2\n`
    );
    if (!result.ok) throw new Error(`policy failed to load: ${JSON.stringify(result.errors)}`);
    expect(result.value.waivers).toEqual({ min_approvers_for_budget_raise: 2 });
    const warnings = result.warnings ?? [];
    expect(warnings).toHaveLength(1);
    const [w] = warnings;
    expect(w.rule).toBe(POLICY_RULES.BUDGET_RAISE_APPROVERS_INERT);
    expect(w.severity).toBe('warning');
    expect(w.location).toEqual({ pointer: '/waivers/min_approvers_for_budget_raise' });
    expect(w.message).toBe(
      'waivers.min_approvers_for_budget_raise has no effect: risk-tier budgets are an advisory sizing goal and are never raised by waiver.'
    );
    expect(w.narrowRepair).toBe('Remove waivers.min_approvers_for_budget_raise.');
  });

  test('a policy without the key draws no inert-key warning', () => {
    const result = parseAndValidatePolicy(
      `${POLICY_YAML}\nwaivers:\n  max_active_waivers_per_gate: 3\n`
    );
    if (!result.ok) throw new Error(`policy failed to load: ${JSON.stringify(result.errors)}`);
    expect(result.warnings ?? []).toEqual([]);
  });

  test('the key misplaced under edit_rules is told to be removed, not moved', () => {
    const result = parseAndValidatePolicy(
      `${POLICY_YAML}\nedit_rules:\n  min_approvers_for_budget_raise: 2\n`
    );
    expect(result.ok).toBe(false);
    const errors = result.ok ? [] : result.errors;
    const misplaced = errors.filter((e) => e.rule === POLICY_RULES.MISPLACED_APPROVERS_FIELD);
    expect(misplaced).toHaveLength(1);
    expect(misplaced[0].narrowRepair).toBe(
      'Remove min_approvers_for_budget_raise from edit_rules: it has no effect, because risk-tier budgets are an advisory sizing goal and are never raised by waiver.'
    );
  });
});

describe('doctor posture: budget_limit is not a critical gate', () => {
  function criticalFindings(p: Policy) {
    return inspectProjectState({ now: NOW, specs: [], policy: p }).findings.filter(
      (f) => f.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING
    );
  }

  test('budget_limit in warn mode produces no posture finding', () => {
    expect(criticalFindings(policy({ budget: 'warn' }))).toEqual([]);
  });

  test('scope_boundary in warn mode still produces a posture finding', () => {
    const findings = criticalFindings(policy({ scope: 'warn' }));
    expect(findings.map((f) => f.subject)).toEqual(['policy.gates.scope_boundary']);
  });

  test('a block-mode budget_limit reaches doctor as the not-honored warning, not as posture risk', () => {
    const p = policy({ budget: 'block' });
    const report = inspectProjectState({
      now: NOW,
      specs: [],
      policy: p,
      policyWarnings: semanticWarnings(p),
    });
    expect(
      report.findings.filter((f) => f.rule === DOCTOR_RULES.POLICY_CRITICAL_GATE_NOT_BLOCKING)
    ).toEqual([]);
    const relayed = report.findings.filter(
      (f) =>
        f.rule === DOCTOR_RULES.POLICY_VALID_WITH_WARNINGS &&
        (f.data as { source_rule?: string } | undefined)?.source_rule ===
          POLICY_RULES.ADVISORY_GATE_BLOCK_NOT_HONORED
    );
    expect(relayed).toHaveLength(1);
    expect(relayed[0].narrowRepair).toBe('Set gates.budget_limit.mode to "warn".');
  });
});
