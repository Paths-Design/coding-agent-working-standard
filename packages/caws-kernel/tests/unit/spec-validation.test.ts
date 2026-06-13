/**
 * Unit tests for the spec validation pipeline (A2): parse -> shape -> semantics.
 *
 * CAWS-TEST-KERNEL-PURE-001. These drive the REAL pipeline (parseAndValidateSpec
 * and its layers) the CLI uses, and assert each failure class by its SPECIFIC
 * SPEC_RULES code — not just "throws"/"is Err". A mutation that collapses two
 * rule mappings, or flips a tier gate, is killed.
 *
 * Failure-lineage / doctrine anchors: the v11 closed-enum and tier-conditional
 * requirements (tier-1 observability/rollback/security, tier-1/2 contracts) are
 * the exact rules CLAUDE.md spec-authoring traps #3 and #6 reference.
 */

import { parseSpecYaml } from '../../src/spec/parse';
import { validateSpecShape } from '../../src/spec/validate-shape';
import { validateSpecSemantics } from '../../src/spec/validate-semantics';
import { parseAndValidateSpec } from '../../src/spec';
import { SPEC_RULES } from '../../src/spec/rules';
import { isOk, isErr } from '../../src/result/construct';
import type { Spec } from '../../src/spec/types';

/**
 * A minimal VALID tier-3 chore spec. The schema requires: id, title,
 * risk_tier, mode, lifecycle_state, blast_radius, scope, invariants,
 * acceptance, non_functional, contracts (tier 3 / chore permits contracts: []).
 */
const VALID_TIER3 = `
id: TEST-1
title: A valid tier 3 spec
risk_tier: 3
mode: chore
lifecycle_state: active
blast_radius:
  modules:
    - src/x.ts
scope:
  in:
    - src/x.ts
invariants:
  - holds
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
`;

/** Build a real Spec object via the production parse+shape path. */
function parseShape(yaml: string): Spec {
  const parsed = parseSpecYaml(yaml);
  if (!isOk(parsed)) throw new Error('fixture YAML did not parse');
  const shaped = validateSpecShape(parsed.value);
  if (!isOk(shaped)) {
    throw new Error('fixture failed shape: ' + shaped.errors.map((e) => e.rule).join(','));
  }
  return shaped.value;
}

function firstRule(yaml: string): string {
  const r = parseAndValidateSpec(yaml);
  if (isOk(r)) throw new Error('expected validation failure but spec was valid');
  return r.errors[0]!.rule;
}

function rules(yaml: string): string[] {
  const r = parseAndValidateSpec(yaml);
  if (isOk(r)) return [];
  return r.errors.map((e) => e.rule);
}

describe('parse layer (spec.yaml.*)', () => {
  test('malformed YAML -> parse_failed', () => {
    const r = parseSpecYaml('id: [unclosed');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(SPEC_RULES.YAML_PARSE_FAILED);
  });

  test('empty document -> empty_document', () => {
    const r = parseSpecYaml('   \n');
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(SPEC_RULES.EMPTY_DOCUMENT);
  });

  test('top-level array -> not_an_object', () => {
    const r = parseSpecYaml('- a\n- b');
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(SPEC_RULES.NOT_AN_OBJECT);
  });
});

describe('shape layer (spec.schema.*): each violation has its OWN rule code', () => {
  test('the valid tier-3 fixture passes the full pipeline', () => {
    expect(isOk(parseAndValidateSpec(VALID_TIER3))).toBe(true);
  });

  test('forbidden legacy field change_budget -> dedicated rule', () => {
    expect(firstRule(VALID_TIER3 + '\nchange_budget:\n  max_files: 1')).toBe(
      SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET
    );
  });

  test('forbidden legacy field status -> dedicated rule (use lifecycle_state)', () => {
    expect(rules(VALID_TIER3 + '\nstatus: open')).toContain(SPEC_RULES.FORBIDDEN_FIELD_STATUS);
  });

  test('removed mode "development" -> mode.development_removed', () => {
    const y = VALID_TIER3.replace('mode: chore', 'mode: development');
    expect(rules(y)).toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
  });

  test('risk_tier as a string -> type_rejected (distinct from out_of_range)', () => {
    const y = VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'");
    expect(rules(y)).toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
  });

  test('risk_tier integer out of [1,2,3] -> out_of_range (distinct from type_rejected)', () => {
    const y = VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5');
    expect(rules(y)).toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
  });

  test('empty scope.in -> scope.in_empty', () => {
    const y = VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []');
    expect(rules(y)).toContain(SPEC_RULES.SCOPE_IN_EMPTY);
  });

  test('glob char in scope.out -> out_glob_forbidden (CLAUDE.md trap #2)', () => {
    // Inject an `out:` with a glob INTO the scope block (correct nesting).
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/foo/**"'
    );
    expect(rules(y)).toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
  });

  test('id not matching the v11 pattern -> id.pattern_violation', () => {
    const y = VALID_TIER3.replace('id: TEST-1', 'id: not-a-valid-id');
    expect(rules(y)).toContain(SPEC_RULES.ID_PATTERN_VIOLATION);
  });
});

describe('semantic layer (spec.semantic.*): tier gates', () => {
  /**
   * Build a schema-COMPLETE spec with controllable tier-gate inputs, so each
   * test isolates exactly one semantic rule (no spurious schema violations).
   */
  function buildSpec(opts: {
    tier: 1 | 2 | 3;
    mode?: string;
    contracts?: boolean;
    observability?: boolean;
    rollback?: boolean;
    security?: boolean;
  }): string {
    const { tier, mode = 'feature', contracts = false, observability = false, rollback = false, security = false } = opts;
    const contractsBlock = contracts
      ? `contracts:
  - name: c
    type: behavior
    path: src/x.ts
    description: d`
      : 'contracts: []';
    const obsBlock = observability ? 'observability:\n  - log it' : '';
    const rbBlock = rollback ? 'rollback:\n  - revert' : '';
    const nfBlock = security ? 'non_functional:\n  security:\n    - no new surface' : 'non_functional: {}';
    return `
id: TEST-1
title: t
risk_tier: ${tier}
mode: ${mode}
lifecycle_state: active
blast_radius:
  modules:
    - src/x.ts
scope:
  in:
    - src/x.ts
invariants:
  - holds
acceptance:
  - id: A1
    given: g
    when: w
    then: t
${nfBlock}
${obsBlock}
${rbBlock}
${contractsBlock}
`;
  }

  test('tier-1 with no contracts -> tier1.contracts_required', () => {
    // Satisfy observability/rollback/security so ONLY the contract gate fires.
    const y = buildSpec({ tier: 1, contracts: false, observability: true, rollback: true, security: true });
    expect(rules(y)).toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
  });

  test('tier-2 with no contracts -> tier2.contracts_required (distinct rule from tier1)', () => {
    const y = buildSpec({ tier: 2, contracts: false });
    expect(rules(y)).toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    expect(rules(y)).not.toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
  });

  test('mode:chore exempts the contract requirement even at tier 1', () => {
    const y = buildSpec({ tier: 1, mode: 'chore', contracts: false, observability: true, rollback: true, security: true });
    expect(rules(y)).not.toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
  });

  test('tier-1 missing observability/rollback/security each fire their own rule', () => {
    const y = buildSpec({ tier: 1, contracts: true, observability: false, rollback: false, security: false });
    const rs = rules(y);
    expect(rs).toContain(SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
    expect(rs).toContain(SPEC_RULES.TIER1_MISSING_ROLLBACK);
    expect(rs).toContain(SPEC_RULES.TIER1_MISSING_SECURITY);
  });
});

describe('semantic layer: lifecycle + resolution rules', () => {
  test('resolution set while active -> resolution.requires_closure', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, resolution: 'completed' } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    else throw new Error('expected requires_closure');
  });

  test('closed spec without resolution -> closed.resolution_required', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
    else throw new Error('expected resolution_required');
  });

  test('supersedes self-reference -> supersedes.self_reference', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: spec.id } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
    else throw new Error('expected self_reference');
  });
});

describe('semantic layer: overbroad scope.out detection (segment-boundary logic)', () => {
  // The helper isPathSegmentPrefix is mutation-rich. Drive it through real specs.
  const withScope = (inP: string, outP: string): Spec => {
    const spec = parseShape(VALID_TIER3);
    return { ...spec, scope: { in: [inP], out: [outP] } } as Spec;
  };

  test("scope.out 'a/b' shadows scope.in 'a/b/c.ts' -> overbroad_out", () => {
    const r = validateSpecSemantics(withScope('a/b/c.ts', 'a/b'));
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    else throw new Error('expected overbroad_out');
  });

  test("scope.out 'a/b' does NOT shadow sibling 'a/bc.ts' (segment boundary)", () => {
    const r = validateSpecSemantics(withScope('a/bc.ts', 'a/b'));
    // The boundary check means bc is NOT under b/. No overbroad_out here.
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  test('EXACT equality (in === out) does NOT fire overbroad_out (different defect class)', () => {
    const r = validateSpecSemantics(withScope('a/b', 'a/b'));
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});
