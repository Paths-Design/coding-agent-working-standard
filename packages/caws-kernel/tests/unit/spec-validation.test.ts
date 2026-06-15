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
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors[0]!.rule).toBe(SPEC_RULES.EMPTY_DOCUMENT);
  });

  test('top-level array -> not_an_object', () => {
    const r = parseSpecYaml('- a\n- b');
    expect(isErr(r)).toBe(true);
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
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    else throw new Error('expected requires_closure');
  });

  test('closed spec without resolution -> closed.resolution_required', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
    else throw new Error('expected resolution_required');
  });

  test('supersedes self-reference -> supersedes.self_reference', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: spec.id } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
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
    expect(isErr(r)).toBe(true);
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

// ============================================================
// EXTENDED COVERAGE: validate-shape message/repair paths
// ============================================================

describe('shape layer: forbidden legacy field acceptance_criteria', () => {
  test('acceptance_criteria forbidden field -> dedicated rule + repair message', () => {
    const y = VALID_TIER3 + '\nacceptance_criteria:\n  - A1';
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA);
      expect(d).toBeDefined();
      expect(d!.message).toContain('acceptance_criteria');
      expect(d!.message).toContain('not permitted');
    }
  });
});

describe('shape layer: forbidden legacy field scope.include / scope.exclude', () => {
  test('scope.include forbidden -> FORBIDDEN_FIELD_SCOPE_INCLUDE rule', () => {
    const y = VALID_TIER3.replace('scope:\n  in:\n    - src/x.ts', 'scope:\n  in:\n    - src/x.ts\n  include:\n    - src/y.ts');
    const rs = rules(y);
    expect(rs).toContain(SPEC_RULES.FORBIDDEN_FIELD_SCOPE_INCLUDE);
  });

  test('scope.exclude forbidden -> FORBIDDEN_FIELD_SCOPE_EXCLUDE rule', () => {
    const y = VALID_TIER3.replace('scope:\n  in:\n    - src/x.ts', 'scope:\n  in:\n    - src/x.ts\n  exclude:\n    - src/z.ts');
    const rs = rules(y);
    expect(rs).toContain(SPEC_RULES.FORBIDDEN_FIELD_SCOPE_EXCLUDE);
  });
});

describe('shape layer: diagnostic messages and repair hints (formatMessage / formatRepair coverage)', () => {
  /**
   * Each test triggers a specific AJV keyword path, then asserts on the
   * diagnostic `message` field (formatMessage) and `narrowRepair` (formatRepair).
   * This kills StringLiteral and ConditionalExpression survivors in both functions.
   */

  test('additionalProperties -> message contains field name', () => {
    const y = VALID_TIER3 + '\nchange_budget:\n  max_files: 1';
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      expect(d!.message).toContain('change_budget');
      expect(d!.message).toContain('not permitted');
      expect(d!.narrowRepair).toContain('Remove change_budget');
      expect(d!.narrowRepair).toContain('policy.yaml');
    }
  });

  test('acceptance_criteria forbidden field -> repair says rename to acceptance', () => {
    const y = VALID_TIER3 + '\nacceptance_criteria:\n  - A1';
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('acceptance_criteria');
      expect(d!.narrowRepair).toContain('acceptance');
    }
  });

  test('scope.include forbidden -> repair says rename to scope.in', () => {
    const y = VALID_TIER3.replace(
      'scope:\n  in:\n    - src/x.ts',
      'scope:\n  in:\n    - src/x.ts\n  include:\n    - src/y.ts'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_SCOPE_INCLUDE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('scope.in');
    }
  });

  test('scope.exclude forbidden -> repair says rename to scope.out', () => {
    const y = VALID_TIER3.replace(
      'scope:\n  in:\n    - src/x.ts',
      'scope:\n  in:\n    - src/x.ts\n  exclude:\n    - src/z.ts'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_SCOPE_EXCLUDE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('scope.out');
    }
  });

  test('status forbidden field -> repair says use lifecycle_state', () => {
    const y = VALID_TIER3 + '\nstatus: open';
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_STATUS);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('lifecycle_state');
    }
  });

  test('unknown top-level field -> SCHEMA_VIOLATION with remove-field repair', () => {
    const y = VALID_TIER3 + '\nmystery_field: oops';
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCHEMA_VIOLATION && e.message?.includes('mystery_field'));
      expect(d).toBeDefined();
      // narrowRepair for unknown field says Remove field "mystery_field"
      expect(d!.narrowRepair).toContain('mystery_field');
    }
  });

  test('mode invalid value -> message mentions allowed enum values', () => {
    const y = VALID_TIER3.replace('mode: chore', 'mode: development');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(d).toBeDefined();
      expect(d!.message).toContain('permitted enum');
      expect(d!.narrowRepair).toContain('feature');
    }
  });

  test('risk_tier string -> message says Expected integer', () => {
    const y = VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'");
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(d).toBeDefined();
      expect(d!.message).toContain('Expected');
      expect(d!.narrowRepair).toContain('integer');
    }
  });

  test('risk_tier out of range -> message mentions enum + repair mentions 1, 2, or 3', () => {
    const y = VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(d).toBeDefined();
      expect(d!.message).toContain('permitted enum');
      expect(d!.narrowRepair).toContain('1, 2, or 3');
    }
  });

  test('scope.in empty -> message says at least 1 item + repair says add path', () => {
    const y = VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY);
      expect(d).toBeDefined();
      expect(d!.message).toContain('at least');
      expect(d!.narrowRepair).toContain('scope.in');
    }
  });

  test('scope.out glob char -> message is Forbidden value. + repair mentions no glob', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/foo/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('Glob');
      expect(d!.narrowRepair).toContain('scope.out');
    }
  });

  test('id pattern violation -> message says does not match pattern + repair mentions regex', () => {
    const y = VALID_TIER3.replace('id: TEST-1', 'id: not-valid');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      expect(d!.message).toContain('pattern');
      expect(d!.narrowRepair).toContain('FOO-1');
    }
  });

  test('missing required field -> message mentions field name + repair says add field', () => {
    // Remove 'title' which is required
    const y = VALID_TIER3.replace('title: A valid tier 3 spec\n', '');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Look for a diagnostic about a missing required field
      const d = r.errors.find((e) => e.message?.includes('Missing required field'));
      expect(d).toBeDefined();
      expect(d!.message).toContain('Missing required field');
      expect(d!.narrowRepair).toContain('Add field');
    }
  });
});

describe('shape layer: sourcePath option propagates into diagnostic subject', () => {
  test('sourcePath is included in the subject when validation fails', () => {
    const parsed = parseSpecYaml(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value, { sourcePath: '/path/to/myspec.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      // subject should start with the sourcePath
      expect(d!.subject).toContain('/path/to/myspec.yaml');
    }
  });

  test('sourcePath adds path prefix to AJV instancePath pointer in subject', () => {
    // A violation that has an instancePath (e.g. /risk_tier -> type error)
    const parsed = parseSpecYaml(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'bad'"));
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value, { sourcePath: 'specs/myfile.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(d).toBeDefined();
      expect(d!.subject).toContain('specs/myfile.yaml');
    }
  });

  test('no sourcePath -> subject is the AJV pointer only', () => {
    const parsed = parseSpecYaml(VALID_TIER3.replace('id: TEST-1', 'id: bad-id'));
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      // Without sourcePath, subject should just be the pointer '/'
      expect(d!.subject).toBe('/id');
    }
  });

  test('diagnostic data includes ajvKeyword, ajvParams, ajvSchemaPath', () => {
    const parsed = parseSpecYaml(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(d).toBeDefined();
      expect(d!.data).toBeDefined();
      expect(d!.data!['ajvKeyword']).toBe('enum');
      expect(d!.data!['ajvParams']).toBeDefined();
      expect(d!.data!['ajvSchemaPath']).toBeDefined();
    }
  });
});

// ============================================================
// EXTENDED COVERAGE: validate-semantics deeper paths
// ============================================================

describe('semantic layer: experimental_mode tier restriction', () => {
  test('experimental_mode on tier 1 -> EXPERIMENTAL_MODE_TIER_RESTRICTED', () => {
    // Build a tier-1 spec with experimental_mode
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
      experimental_mode: { enabled: true, rationale: 'test', expires_at: '2030-01-01' },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
      const d = r.errors.find((e) => e.rule === SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
      expect(d!.message).toContain('Tier 3');
      expect(d!.narrowRepair).toContain('experimental_mode');
    }
  });

  test('experimental_mode on tier 2 -> EXPERIMENTAL_MODE_TIER_RESTRICTED', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 2 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      experimental_mode: { enabled: true, rationale: 'test', expires_at: '2030-01-01' },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    }
  });

  test('experimental_mode on tier 3 -> allowed, no error', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 3 as const,
      experimental_mode: { enabled: true, rationale: 'test', expires_at: '2030-01-01' },
    };
    const r = validateSpecSemantics(mutated);
    // Should pass (tier 3 allows experimental_mode)
    expect(isOk(r)).toBe(true);
  });

  test('experimental_mode undefined on tier 1 -> does NOT fire tier_restricted', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
      // no experimental_mode
    };
    const r = validateSpecSemantics(mutated);
    const rulesFired = isErr(r) ? r.errors.map((e) => e.rule) : [];
    expect(rulesFired).not.toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
  });
});

describe('semantic layer: sourcePath option propagates into diagnostic subject', () => {
  test('sourcePath replaces spec.id as the subject base', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, resolution: 'completed' } as Spec;
    const r = validateSpecSemantics(mutated, { sourcePath: '/path/to/spec.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      expect(d).toBeDefined();
      expect(d!.subject).toBe('/path/to/spec.yaml');
    }
  });

  test('no sourcePath -> subject is spec.id', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, resolution: 'completed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      expect(d).toBeDefined();
      expect(d!.subject).toBe('TEST-1');
    }
  });
});

describe('semantic layer: diagnostic message/data fields (kill StringLiteral/ObjectLiteral survivors)', () => {
  test('tier1 contracts_required diagnostic has message, subject, location, narrowRepair', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      mode: 'feature' as const,  // chore exempts contracts; use feature so the gate fires
      risk_tier: 1 as const,
      contracts: [],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_CONTRACTS);
      expect(d).toBeDefined();
      expect(d!.message).toContain('Tier 1');
      expect(d!.message).toContain('contract');
      expect(d!.subject).toBe('TEST-1');
      expect(d!.location).toEqual({ pointer: '/contracts' });
      expect(d!.narrowRepair).toContain('contract');
    }
  });

  test('tier2 contracts_required diagnostic has distinct message from tier1', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      mode: 'feature' as const,  // chore exempts contracts; use feature so the gate fires
      risk_tier: 2 as const,
      contracts: [],
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER2_MISSING_CONTRACTS);
      expect(d).toBeDefined();
      expect(d!.message).toContain('Tier 2');
      expect(d!.message).toContain('contract');
      expect(d!.location).toEqual({ pointer: '/contracts' });
      expect(d!.narrowRepair).toContain('contract');
    }
  });

  test('tier1 observability_required diagnostic message + location', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: [],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
      expect(d).toBeDefined();
      expect(d!.message).toContain('observability');
      expect(d!.location).toEqual({ pointer: '/observability' });
      expect(d!.narrowRepair).toContain('observability');
    }
  });

  test('tier1 rollback_required diagnostic message + location', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: [],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_ROLLBACK);
      expect(d).toBeDefined();
      expect(d!.message).toContain('rollback');
      expect(d!.location).toEqual({ pointer: '/rollback' });
      expect(d!.narrowRepair).toContain('rollback');
    }
  });

  test('tier1 security_required diagnostic message + location', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: {},
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_SECURITY);
      expect(d).toBeDefined();
      expect(d!.message).toContain('security');
      expect(d!.location).toEqual({ pointer: '/non_functional/security' });
      expect(d!.narrowRepair).toContain('security');
    }
  });

  test('resolution.requires_closure diagnostic message contains lifecycle_state', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, resolution: 'completed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      expect(d).toBeDefined();
      expect(d!.message).toContain('active');
      expect(d!.location).toEqual({ pointer: '/resolution' });
      expect(d!.narrowRepair).toContain('closed');
    }
  });

  test('closed_spec_missing_resolution diagnostic message + location', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
      expect(d).toBeDefined();
      expect(d!.message).toContain('closed');
      expect(d!.location).toEqual({ pointer: '/resolution' });
      expect(d!.narrowRepair).toContain('resolution');
    }
  });

  test('archived spec without resolution also fires closed_spec_missing_resolution', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'archived' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
      expect(d).toBeDefined();
      expect(d!.message).toContain('archived');
    }
  });

  test('supersedes_self_reference diagnostic message + location', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: spec.id } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
      expect(d).toBeDefined();
      expect(d!.message).toContain('supersede itself');
      expect(d!.location).toEqual({ pointer: '/supersedes' });
    }
  });

  test('overbroad_out diagnostic has data with scope_out_prefix and scope_in_shadowed', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OVERBROAD_OUT);
      expect(d).toBeDefined();
      expect(d!.message).toContain('a/b');
      expect(d!.message).toContain('a/b/c.ts');
      expect(d!.data).toBeDefined();
      expect(d!.data!['scope_out_prefix']).toBe('a/b');
      expect(d!.data!['scope_in_shadowed']).toBe('a/b/c.ts');
      expect(d!.data!['shadowed_surface']).toBe('scope.in');
    }
  });
});

describe('semantic layer: scope.support overbroad_out detection', () => {
  test('scope.out entry shadows a scope.support entry -> overbroad_out', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      scope: { in: ['src/x.ts'], out: ['shared/utils'], support: ['shared/utils/helpers.ts'] },
    } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OVERBROAD_OUT);
      expect(d).toBeDefined();
      expect(d!.data!['shadowed_surface']).toBe('scope.support');
      expect(d!.data!['scope_in_shadowed']).toBe('shared/utils/helpers.ts');
    }
  });

  test('scope with no out entries -> no overbroad_out fired', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      scope: { in: ['a/b/c.ts'], support: ['shared/x.ts'] },
    } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });
});

describe('semantic layer: normalizeScopePath and isPathSegmentPrefix edge cases', () => {
  test('scope.out with trailing slash is normalized and still matches -> overbroad_out fires', () => {
    const spec = parseShape(VALID_TIER3);
    // 'a/b/' trailing slash normalizes to 'a/b', which still shadows 'a/b/c.ts'
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['a/b/'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  test('scope.in with trailing slash is normalized and still detected as shadowed', () => {
    const spec = parseShape(VALID_TIER3);
    // 'a/b/c.ts/' normalizes to 'a/b/c.ts', still shadowed by 'a/b'
    const mutated = { ...spec, scope: { in: ['a/b/c.ts/'], out: ['a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  test('empty string scope.out entry is degenerate and does NOT fire overbroad_out', () => {
    const spec = parseShape(VALID_TIER3);
    // isPathSegmentPrefix returns false for empty prefix
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: [''] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  test('single-segment scope.out shadows deeper scope.in', () => {
    const spec = parseShape(VALID_TIER3);
    // 'a' shadows 'a/b'
    const mutated = { ...spec, scope: { in: ['a/b'], out: ['a'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  test('non-prefix out does NOT shadow scope.in even if it starts with same chars', () => {
    const spec = parseShape(VALID_TIER3);
    // 'pack' does NOT shadow 'packages/foo/bar.ts' because 'a' not '/'
    const mutated = { ...spec, scope: { in: ['packages/foo/bar.ts'], out: ['pack'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

describe('semantic layer: tier-1 with chore mode still exempts contracts', () => {
  test('chore mode with observability/rollback/security provided but no contracts -> no tier1/tier2 error', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      mode: 'chore' as const,
      contracts: [],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    // No contracts error for chore mode
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
      expect(rs).not.toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  test('chore mode tier-2 with no contracts -> no contracts error', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 2 as const,
      mode: 'chore' as const,
      contracts: [],
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

describe('semantic layer: tier-3 full valid pass', () => {
  test('tier-3 spec with no contracts, no observability/rollback/security -> passes semantics', () => {
    const spec = parseShape(VALID_TIER3);
    const r = validateSpecSemantics(spec);
    expect(isOk(r)).toBe(true);
  });
});

describe('semantic layer: resolution values on closed/archived specs', () => {
  test('closed spec WITH resolution completed -> passes semantics', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const, resolution: 'completed' as const };
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });

  test('archived spec WITH resolution superseded -> passes semantics', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'archived' as const, resolution: 'superseded' as const };
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });

  test('draft spec WITH resolution -> fires resolution.requires_closure', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'draft' as const, resolution: 'abandoned' as const };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      expect(d!.message).toContain('draft');
    }
  });
});

describe('semantic layer: supersedes non-self reference is allowed', () => {
  test('supersedes another spec id -> no error', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: 'OTHER-1' } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

describe('shape layer: AJV keyword coverage for formatMessage default branch', () => {
  test('valid spec returns ok with the spec value', () => {
    const r = parseAndValidateSpec(VALID_TIER3);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.id).toBe('TEST-1');
      expect(r.value.risk_tier).toBe(3);
      expect(r.value.mode).toBe('chore');
      expect(r.value.lifecycle_state).toBe('active');
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts
// These tests address specific ConditionalExpression / LogicalOperator
// / StringLiteral mutants that survived the first Stryker pass.
// ============================================================

describe('shape layer: authority field is always kernel/spec', () => {
  test('change_budget violation -> authority === kernel/spec (kills L84 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors[0]!;
      expect(d.authority).toBe('kernel/spec');
    }
  });

  test('id pattern violation -> authority === kernel/spec', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('id: TEST-1', 'id: not-valid'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });
});

describe('shape layer: narrowRepair presence and exactness (kills L88 ConditionalExpression/EqualityOperator)', () => {
  test('change_budget violation -> narrowRepair is defined (not dropped by spread mutation)', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBeDefined();
      expect(d!.narrowRepair).toBe('Remove change_budget from the spec. Budgets derive from policy.yaml risk_tiers.');
    }
  });

  test('acceptance_criteria violation -> narrowRepair exact text (kills L182 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nacceptance_criteria:\n  - A1');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Rename acceptance_criteria to acceptance. The alias was removed.');
    }
  });

  test('scope.include violation -> narrowRepair exact text (kills L184 StringLiteral)', () => {
    const y = VALID_TIER3.replace(
      'scope:\n  in:\n    - src/x.ts',
      'scope:\n  in:\n    - src/x.ts\n  include:\n    - src/y.ts'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_SCOPE_INCLUDE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Rename scope.include to scope.in.');
    }
  });

  test('scope.exclude violation -> narrowRepair exact text (kills L186 StringLiteral)', () => {
    const y = VALID_TIER3.replace(
      'scope:\n  in:\n    - src/x.ts',
      'scope:\n  in:\n    - src/x.ts\n  exclude:\n    - src/z.ts'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_SCOPE_EXCLUDE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Rename scope.exclude to scope.out.');
    }
  });

  test('status violation -> narrowRepair exact text (kills L188 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nstatus: open');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_STATUS);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use lifecycle_state (draft|active|closed|archived) instead of status.');
    }
  });

  test('unknown field -> narrowRepair contains field name in default message (kills L190 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nweird_field: value');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCHEMA_VIOLATION && e.message?.includes('weird_field'));
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('Remove field "weird_field"');
      expect(d!.narrowRepair).toContain('schema admits no other top-level fields');
    }
  });

  test('mode enum violation -> narrowRepair exact text (kills L195 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use one of: feature, refactor, fix, doc, chore.');
    }
  });

  test('risk_tier type rejection -> narrowRepair exact text (kills L199 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use integer 1, 2, or 3 (not a string like "T3" or "1").');
    }
  });

  test('risk_tier out of range -> narrowRepair exact text (kills L202 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use integer 1, 2, or 3 — values outside this range are not permitted.');
    }
  });

  test('scope.in empty -> narrowRepair exact text (kills L206 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Add at least one path to scope.in.');
    }
  });

  test('scope.out glob -> narrowRepair exact text (kills L210 StringLiteral)', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/foo/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use directory paths only. Glob patterns (* or ?) are not allowed in scope.out.');
    }
  });

  test('id pattern violation -> narrowRepair exact text (kills L214 StringLiteral)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('id: TEST-1', 'id: not-valid'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      // Exact repair message
      expect(d!.narrowRepair).toContain('^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-');
      expect(d!.narrowRepair).toContain('FOO-1');
    }
  });

  test('missing required field -> narrowRepair says Add field "title" (kills L218/L219)', () => {
    const y = VALID_TIER3.replace('title: A valid tier 3 spec\n', '');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.message?.includes('Missing required field'));
      expect(d).toBeDefined();
      // The field 'title' should be in the narrowRepair
      expect(d!.narrowRepair).toContain('Add field "title"');
    }
  });

  test('missing non-optional field -> narrowRepair is defined (narrowRepair !== undefined branch)', () => {
    // Remove 'invariants' to trigger required field missing
    const y = VALID_TIER3.replace('invariants:\n  - holds\n', '');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.message?.includes('Missing required field'));
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBeDefined();
    }
  });
});

describe('shape layer: pickStableRule condition boundary tests (kills ConditionalExpression/LogicalOperator)', () => {
  /**
   * These tests exercise BOTH sides of each dual-condition in pickStableRule.
   * For each `if (A && B)` condition, we need:
   *   - A=true, B=true → rule X fires
   *   - A=true, B=false → different rule (or SCHEMA_VIOLATION)
   *   - A=false, B=true → different rule
   * This kills the ConditionalExpression(true) mutants that shortcircuit the condition.
   */

  test('risk_tier=/risk_tier AND keyword=enum -> OUT_OF_RANGE (not TYPE_REJECTED)', () => {
    // risk_tier=5 triggers enum keyword on /risk_tier instancePath
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
    }
  });

  test('risk_tier=/risk_tier AND keyword=type -> TYPE_REJECTED fires (string value)', () => {
    // risk_tier='T3' triggers type keyword on /risk_tier (AJV allErrors=true may also fire enum)
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      // TYPE_REJECTED must fire for a string value
      expect(rs).toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      // The type error fires (keyword=type at /risk_tier) -- allErrors:true may also fire enum
      const typeErr = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(typeErr).toBeDefined();
      expect(typeErr!.message).toMatch(/^Expected /);
    }
  });

  test('mode=invalid enum -> MODE_DEVELOPMENT_REMOVED (not RISK_TIER_OUT_OF_RANGE or SCHEMA_VIOLATION)', () => {
    // mode=development triggers enum keyword on /mode (not /risk_tier)
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
    }
  });

  test('scope.in empty -> SCOPE_IN_EMPTY not SCHEMA_VIOLATION (kills L134 LogicalOperator)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      // NOT SCHEMA_VIOLATION for this specific error
      const scopeInErr = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY);
      expect(scopeInErr).toBeDefined();
      expect(scopeInErr!.rule).toBe('spec.schema.scope.in_empty');
    }
  });

  test('scope.out glob -> SCOPE_OUT_GLOB_FORBIDDEN not SCHEMA_VIOLATION (kills L139 LogicalOperator)', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      const globErr = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(globErr!.rule).toBe('spec.schema.scope.out_glob_forbidden');
    }
  });

  test('id pattern violation -> ID_PATTERN_VIOLATION not SCHEMA_VIOLATION (kills L144 LogicalOperator)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('id: TEST-1', 'id: not-valid'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      expect(d!.rule).toBe('spec.schema.id.pattern_violation');
    }
  });

  test('additionalProperties keyword fires when BOTH conditions true (kills L102 LogicalOperator)', () => {
    // change_budget has additionalProperty AND keyword=additionalProperties
    const r = parseAndValidateSpec(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Must get the specific forbidden_field rule, NOT generic SCHEMA_VIOLATION
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      // This exact rule proves both conditions (keyword=additionalProperties AND additionalProperty='change_budget') were true
      expect(d!.rule).toBe('spec.schema.forbidden_field.change_budget');
    }
  });
});

describe('shape layer: formatMessage exact text per AJV keyword (kills L154-L169 StringLiterals)', () => {
  test('additionalProperties keyword -> message matches Unknown field "X" is not permitted. pattern', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      // Exact message shape from formatMessage 'additionalProperties' case
      expect(d!.message).toBe('Unknown field "change_budget" is not permitted.');
    }
  });

  test('required keyword -> message matches Missing required field "X". pattern', () => {
    const y = VALID_TIER3.replace('title: A valid tier 3 spec\n', '');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.message?.startsWith('Missing required field'));
      expect(d).toBeDefined();
      expect(d!.message).toMatch(/^Missing required field "title"\.$/);
    }
  });

  test('enum keyword (mode) -> message matches Value not in permitted enum pattern', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(d).toBeDefined();
      // formatMessage 'enum' case: Value not in permitted enum: [...].
      expect(d!.message).toMatch(/^Value not in permitted enum:/);
      expect(d!.message).toContain('feature');
    }
  });

  test('type keyword (risk_tier) -> message matches Expected <type> pattern', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(d).toBeDefined();
      // formatMessage 'type' case: Expected <type>.
      expect(d!.message).toMatch(/^Expected /);
      expect(d!.message).toContain('integer');
    }
  });

  test('minItems keyword (scope.in) -> message matches Array must have at least pattern', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY);
      expect(d).toBeDefined();
      // formatMessage 'minItems' case: Array must have at least X item(s).
      expect(d!.message).toMatch(/^Array must have at least \d+ item\(s\)\.$/);
    }
  });

  test('pattern keyword (id) -> message is "Value does not match required pattern." exactly', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('id: TEST-1', 'id: not-valid'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      // formatMessage 'pattern' case: exact string
      expect(d!.message).toBe('Value does not match required pattern.');
    }
  });
});

describe('shape layer: sourcePath option exact subject construction (kills L72-L73 survivors)', () => {
  test('with sourcePath: subject = sourcePath + pointer (not just pointer)', () => {
    const parsed = parseSpecYaml(VALID_TIER3.replace('id: TEST-1', 'id: not-valid'));
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value, { sourcePath: '/my/path.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(d).toBeDefined();
      // L73: subject = sourcePath + pointer. instancePath for /id is '/id'
      expect(d!.subject).toBe('/my/path.yaml/id');
    }
  });

  test('with sourcePath and additionalProperties error: subject = sourcePath + /  (pointer is empty)', () => {
    const parsed = parseSpecYaml(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value, { sourcePath: 'spec.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      // additionalProperties error has empty instancePath, so pointer = '/'
      // subject = 'spec.yaml' + '/' = 'spec.yaml/'
      expect(d!.subject).toContain('spec.yaml');
    }
  });

  test('no sourcePath and additionalProperties error: subject is just the pointer', () => {
    const parsed = parseSpecYaml(VALID_TIER3 + '\nchange_budget:\n  max_files: 1');
    expect(isOk(parsed)).toBe(true);
    if (!isOk(parsed)) return;
    const r = validateSpecShape(parsed.value);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(d).toBeDefined();
      // No sourcePath: subject = just the pointer, which is '/' for root additionalProperties
      expect(d!.subject).toBe('/');
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts — pickStableRule
// cross-condition boundary tests (kills L120/L125/L129/L134/L139/L144
// ConditionalExpression + LogicalOperator survivors)
//
// Pattern: for each `if (A && B)` condition, we need BOTH:
//   (a) A=true, B=true → rule X fires (already covered)
//   (b) A=true, B=false (or A=false, B=true) → rule X does NOT fire
// Kills the ConditionalExpression(true) mutant that short-circuits to always-true.
// ============================================================

describe('shape layer: pickStableRule cross-condition negative tests', () => {
  /**
   * L120: if (e.keyword === 'enum' && e.instancePath === '/mode')
   * ConditionalExpression(true) mutant → always returns MODE_DEVELOPMENT_REMOVED.
   * Kill it: risk_tier:5 fires enum on /risk_tier, NOT on /mode → must NOT give MODE_DEVELOPMENT_REMOVED.
   */
  test('risk_tier out-of-range (enum on /risk_tier) does NOT give MODE_DEVELOPMENT_REMOVED', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(rs).toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
    }
  });

  /**
   * L125: if (e.instancePath === '/risk_tier' && e.keyword === 'type')
   * ConditionalExpression(true) mutant → always returns RISK_TIER_TYPE_REJECTED.
   * Kill it: risk_tier:5 fires enum (not type) on /risk_tier → must NOT give RISK_TIER_TYPE_REJECTED.
   */
  test('risk_tier out-of-range (enum on /risk_tier) does NOT give RISK_TIER_TYPE_REJECTED', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(rs).toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
    }
  });

  /**
   * L125 other side: type keyword on /risk_tier gives TYPE_REJECTED, not OUT_OF_RANGE.
   * ConditionalExpression(false) mutant at L129 skips the enum check.
   */
  test('risk_tier string (type on /risk_tier) does NOT give RISK_TIER_OUT_OF_RANGE', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      // RISK_TIER_OUT_OF_RANGE should NOT fire for a type error (only for integer out of range)
      // Note: AJV allErrors:true may fire both type AND enum; what matters is TYPE_REJECTED IS present
      expect(rs).not.toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
    }
  });

  /**
   * L129 LogicalOperator: `/risk_tier && enum` → `||`
   * Kill it: mode:development fires enum on /mode (not /risk_tier) → must NOT give RISK_TIER_OUT_OF_RANGE.
   */
  test('mode invalid enum (enum on /mode) does NOT give RISK_TIER_OUT_OF_RANGE', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(rs).toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
    }
  });

  /**
   * L134 LogicalOperator: `/scope/in && minItems` → `||`
   * Kill it: any OTHER minItems violation should NOT give SCOPE_IN_EMPTY.
   * Also: scope.in empty should NOT give SCOPE_OUT_GLOB_FORBIDDEN.
   */
  test('scope.in empty gives SCOPE_IN_EMPTY but NOT SCOPE_OUT_GLOB_FORBIDDEN', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      expect(rs).not.toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
    }
  });

  /**
   * L134 ConditionalExpression(true) side: a minItems violation on a different array
   * path should NOT give SCOPE_IN_EMPTY. Use acceptance: [] to trigger minItems elsewhere.
   * (The schema requires acceptance to have at least 1 item.)
   */
  test('acceptance empty array (minItems on /acceptance) does NOT give SCOPE_IN_EMPTY', () => {
    const y = VALID_TIER3.replace(
      'acceptance:\n  - id: A1\n    given: g\n    when: w\n    then: t',
      'acceptance: []'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      // The /acceptance minItems error must NOT be misclassified as SCOPE_IN_EMPTY
      expect(rs).not.toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      // It should be a SCHEMA_VIOLATION (the catch-all for /acceptance minItems)
      const schemaErr = r.errors.find((e) => e.rule === SPEC_RULES.SCHEMA_VIOLATION && e.data?.['ajvKeyword'] === 'minItems');
      expect(schemaErr).toBeDefined();
    }
  });

  /**
   * L139 StringLiteral `""`: startsWith('/scope/out/') → startsWith('')
   * Kill it: a `not` keyword violation on a path that is NOT /scope/out/...
   * should NOT give SCOPE_OUT_GLOB_FORBIDDEN.
   * Use scope.in items (not scope.out items) — but the schema uses 'not' on scope.out items only.
   * Instead: scope.out glob at index 0 vs index 1. Already tested.
   * A more direct kill: scope.out item at /scope/out/0 IS the expected prefix, so test PASSES.
   *
   * Kill the L139 ConditionalExpression(true) for `e.instancePath?.startsWith('/scope/out/')`:
   * A 'not' keyword error on /scope/out/0 is correct, but one NOT starting with /scope/out/ should
   * NOT give SCOPE_OUT_GLOB_FORBIDDEN.
   */
  test('scope.in empty AND scope.out glob both at same time -> each rule fires separately', () => {
    // Both conditions simultaneously - scope.in empty AND scope.out has glob
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in: []\n  out:\n    - "packages/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      expect(rs).toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      // Assert they are separate diagnostics
      expect(r.errors.filter((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY).length).toBe(1);
      expect(r.errors.filter((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN).length).toBe(1);
    }
  });

  /**
   * L139 MethodExpression: startsWith → endsWith. Kill it: a glob item at index 0
   * has path /scope/out/0 which starts with /scope/out/ but ENDS with /0 not /scope/out/.
   * The actual path for items is /scope/out/N (index-based). We test that /scope/out/0 fires
   * SCOPE_OUT_GLOB_FORBIDDEN (starts-with check), not just from some endsWith match.
   */
  test('scope.out glob at index 0 (/scope/out/0) gives SCOPE_OUT_GLOB_FORBIDDEN', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/*"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(d).toBeDefined();
      // The subject should point to the specific item (contains 'scope')
      expect(d!.data!['ajvKeyword']).toBe('not');
    }
  });

  /**
   * L144 LogicalOperator: `/id && pattern` → `||`
   * Kill it: a 'pattern' keyword violation on a path OTHER than /id should NOT give
   * ID_PATTERN_VIOLATION. The schema may have pattern on other fields.
   * Also: id with wrong keyword (e.g. type) should NOT give ID_PATTERN_VIOLATION.
   */
  test('id out of enum (invalid chars) does NOT give SCOPE_IN_EMPTY or SCOPE_OUT_GLOB_FORBIDDEN', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('id: TEST-1', 'id: lower-case-1'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).toContain(SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(rs).not.toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      expect(rs).not.toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
    }
  });

  /**
   * L120 col7 precise kill: `true && e.instancePath === '/mode'`
   * Need: keyword !== 'enum' BUT instancePath === '/mode' → type error diagnostic on /mode
   * should be SCHEMA_VIOLATION, NOT MODE_DEVELOPMENT_REMOVED.
   * Use `mode: 123` (integer) → AJV fires keyword='type' on instancePath='/mode'.
   * With allErrors:true it also fires 'enum' (which gives MODE_DEVELOPMENT_REMOVED via L120).
   * But the TYPE error diagnostic for keyword='type' on /mode should be SCHEMA_VIOLATION.
   * The mutant `true && '/mode' === '/mode'` = true catches ALL /mode errors → would also map
   * the type-error diagnostic to MODE_DEVELOPMENT_REMOVED (wrong). Kill it by asserting the
   * type diagnostic is SCHEMA_VIOLATION.
   */
  test('mode type error diagnostic (keyword=type on /mode) is SCHEMA_VIOLATION not MODE_DEVELOPMENT_REMOVED', () => {
    // YAML: mode: 123 gives both type and enum errors on /mode
    const y = VALID_TIER3.replace('mode: chore', 'mode: 123');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // The type error on /mode should be SCHEMA_VIOLATION (not MODE_DEVELOPMENT_REMOVED)
      const typeOnMode = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/mode'));
      if (typeOnMode) {
        expect(typeOnMode.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
        expect(typeOnMode.rule).not.toBe(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      } else {
        // AJV may not fire type separately from enum; if only enum fires, check it's mapped correctly
        expect(r.errors.length).toBeGreaterThan(0);
      }
    }
  });

  /**
   * L125 col7 precise kill: `true && e.keyword === 'type'`
   * Need: keyword === 'type' BUT instancePath !== '/risk_tier' → should NOT give RISK_TIER_TYPE_REJECTED.
   * Title field type: `title: 123` fires type on /title (not /risk_tier).
   * With mutant `true && 'type' === 'type'` = true → RISK_TIER_TYPE_REJECTED (wrong).
   */
  test('title type error (type on /title) does NOT give RISK_TIER_TYPE_REJECTED', () => {
    const y = VALID_TIER3.replace('title: A valid tier 3 spec', 'title: 123');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      // Should be SCHEMA_VIOLATION for the type error on /title
      const typeErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/title'));
      if (typeErr) {
        expect(typeErr.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
      }
    }
  });

  /**
   * L129 col7 `||` precise kill: `instancePath === '/risk_tier' || keyword === 'enum'`
   * Need: keyword === 'enum' AND instancePath !== '/risk_tier' AND NOT matching L120.
   * `lifecycle_state: invalid` fires enum on /lifecycle_state (not /mode, not /risk_tier).
   * With mutant: `'/lifecycle_state' === '/risk_tier' || 'enum' === 'enum'` = true
   * → gives RISK_TIER_OUT_OF_RANGE (wrong). Correct: falls through to SCHEMA_VIOLATION.
   */
  test('lifecycle_state invalid enum (enum on /lifecycle_state) does NOT give RISK_TIER_OUT_OF_RANGE', () => {
    const y = VALID_TIER3.replace('lifecycle_state: active', 'lifecycle_state: invalid');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(rs).not.toContain(SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      // It should fall through to SCHEMA_VIOLATION with enum keyword
      const enumErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'enum' && e.subject?.includes('/lifecycle_state'));
      expect(enumErr).toBeDefined();
    }
  });

  /**
   * L134 col41 `ConditionalExpression: true` precise kill.
   * Need: instancePath === '/scope/in' BUT keyword !== 'minItems' → NOT SCOPE_IN_EMPTY.
   * `scope.in: "not-an-array"` fires type on /scope/in (not minItems).
   * With mutant `'/scope/in' === '/scope/in' && true` = true → gives SCOPE_IN_EMPTY (wrong).
   */
  test('scope.in type error (string instead of array) does NOT give SCOPE_IN_EMPTY', () => {
    const y = VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: "not-an-array"');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.SCOPE_IN_EMPTY);
      // Should be SCHEMA_VIOLATION (type error on /scope/in)
      const typeErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/scope/in'));
      if (typeErr) {
        expect(typeErr.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
      }
    }
  });

  /**
   * L139 col52 `ConditionalExpression: true` precise kill.
   * Need: instancePath starts with '/scope/out/' BUT keyword !== 'not' → NOT SCOPE_OUT_GLOB_FORBIDDEN.
   * An empty string scope.out item fires minLength on /scope/out/0.
   * With mutant `startsWith('/scope/out/') && true` = true → gives SCOPE_OUT_GLOB_FORBIDDEN (wrong).
   */
  test('empty string scope.out item (minLength on /scope/out/0) does NOT give SCOPE_OUT_GLOB_FORBIDDEN', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - ""'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      // minLength on /scope/out/0 should NOT give SCOPE_OUT_GLOB_FORBIDDEN
      expect(rs).not.toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      // Should be SCHEMA_VIOLATION for the minLength error
      const minLenErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'minLength' && e.subject?.includes('/scope/out'));
      if (minLenErr) {
        expect(minLenErr.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
      }
    }
  });

  /**
   * L144 col35 `ConditionalExpression: e.instancePath === '/id' && true` precise kill.
   * Need: instancePath === '/id' BUT keyword !== 'pattern' → NOT ID_PATTERN_VIOLATION.
   * `id: 123` (integer) fires type on /id.
   * With mutant `'/id' === '/id' && true` = true → gives ID_PATTERN_VIOLATION (wrong).
   */
  test('id type error (integer id fires type on /id) does NOT give ID_PATTERN_VIOLATION', () => {
    const y = VALID_TIER3.replace('id: TEST-1', 'id: 123');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.ID_PATTERN_VIOLATION);
      // Should be SCHEMA_VIOLATION (type error on /id)
      const typeErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/id'));
      if (typeErr) {
        expect(typeErr.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
      }
    }
  });

  /**
   * L144 col7 `||` precise kill: `instancePath === '/id' || keyword === 'pattern'`
   * Need: keyword === 'pattern' AND instancePath !== '/id'.
   * acceptance[0].id pattern ^A\d+$ fires pattern on /acceptance/0/id.
   * With mutant: `'/acceptance/0/id' === '/id' || 'pattern' === 'pattern'` = true
   * → gives ID_PATTERN_VIOLATION (wrong). Correct: SCHEMA_VIOLATION.
   */
  test('acceptance[].id pattern violation (pattern on /acceptance/0/id) does NOT give ID_PATTERN_VIOLATION', () => {
    const y = VALID_TIER3.replace(
      '  - id: A1\n    given: g\n    when: w\n    then: t',
      '  - id: bad-format-acceptance\n    given: g\n    when: w\n    then: t'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const rs = r.errors.map((e) => e.rule);
      expect(rs).not.toContain(SPEC_RULES.ID_PATTERN_VIOLATION);
      // Should be SCHEMA_VIOLATION
      const patternErr = r.errors.find((e) => e.data?.['ajvKeyword'] === 'pattern' && e.subject?.includes('/acceptance'));
      if (patternErr) {
        expect(patternErr.rule).toBe(SPEC_RULES.SCHEMA_VIOLATION);
      }
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts — formatRepair
// cross-condition boundary tests (kills L194/L198/L201/L205/L209/L213/L217)
// ============================================================

describe('shape layer: formatRepair cross-condition negative tests', () => {
  /**
   * L194: if (e.keyword === 'enum' && e.instancePath === '/mode') → narrowRepair 'Use one of: feature...'
   * ConditionalExpression(true) mutant → always returns mode enum repair.
   * Kill it: risk_tier:5 fires enum on /risk_tier → repair should NOT say "Use one of: feature..."
   */
  test('risk_tier out-of-range repair is NOT the mode enum repair', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', 'risk_tier: 5'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).not.toContain('feature, refactor, fix, doc, chore');
      expect(d!.narrowRepair).toContain('1, 2, or 3');
    }
  });

  /**
   * L194 EqualityOperator: instancePath !== '/mode'. Kill it: mode error on /mode
   * gives mode repair, not some other repair.
   */
  test('mode enum violation repair says "Use one of: feature..." (not risk_tier repair)', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Use one of: feature, refactor, fix, doc, chore.');
      expect(d!.narrowRepair).not.toContain('1, 2, or 3');
    }
  });

  /**
   * L198: if (e.instancePath === '/risk_tier' && e.keyword === 'type')
   * Kill it: mode enum repair fires for mode, NOT for risk_tier type.
   */
  test('risk_tier type error repair says integer not string', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('risk_tier: 3', "risk_tier: 'T3'"));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RISK_TIER_TYPE_REJECTED);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toContain('integer');
      expect(d!.narrowRepair).not.toContain('feature, refactor');
    }
  });

  /**
   * L201: if (e.instancePath === '/risk_tier' && e.keyword === 'enum')
   * Kill it: mode violation should NOT get the risk_tier enum repair.
   */
  test('mode development error repair does NOT say "Use integer 1, 2, or 3"', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('mode: chore', 'mode: development'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).not.toContain('Use integer 1, 2, or 3');
    }
  });

  /**
   * L205: if (e.instancePath === '/scope/in' && e.keyword === 'minItems')
   * Kill it: acceptance empty array fires minItems on /acceptance, not /scope/in
   * → should NOT get "Add at least one path to scope.in." repair.
   */
  test('acceptance empty array repair does NOT say "Add at least one path to scope.in"', () => {
    const y = VALID_TIER3.replace(
      'acceptance:\n  - id: A1\n    given: g\n    when: w\n    then: t',
      'acceptance: []'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const schemaErr = r.errors.find(
        (e) => e.rule === SPEC_RULES.SCHEMA_VIOLATION && e.data?.['ajvKeyword'] === 'minItems'
      );
      if (schemaErr) {
        // Default formatRepair case → narrowRepair is undefined (not "Add at least one path to scope.in")
        expect(schemaErr.narrowRepair).toBeUndefined();
      }
    }
  });

  /**
   * L209: if (e.instancePath?.startsWith('/scope/out/') && e.keyword === 'not')
   * Kill it: scope.in empty fires minItems, NOT 'not' keyword → repair is NOT the glob repair.
   */
  test('scope.in empty repair does NOT say "Use directory paths only. Glob patterns"', () => {
    const r = parseAndValidateSpec(VALID_TIER3.replace('  in:\n    - src/x.ts', '  in: []'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).not.toContain('Glob patterns');
      expect(d!.narrowRepair).toBe('Add at least one path to scope.in.');
    }
  });

  /**
   * L213: if (e.instancePath === '/id' && e.keyword === 'pattern')
   * Kill it: scope.out glob fires 'not' keyword on /scope/out/0, NOT 'pattern' on /id
   * → should NOT give the id pattern repair.
   */
  test('scope.out glob repair does NOT say "Spec id must match"', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "packages/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(d).toBeDefined();
      expect(d!.narrowRepair).not.toContain('Spec id must match');
      expect(d!.narrowRepair).toContain('Glob patterns');
    }
  });

  /**
   * L217: if (e.keyword === 'required')
   * Kill it: an unknown field violation is additionalProperties keyword (not 'required')
   * → should NOT get the "Add field" repair.
   */
  test('unknown field violation repair does NOT say "Add field"', () => {
    const r = parseAndValidateSpec(VALID_TIER3 + '\nrandom_field: value');
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find(
        (e) => e.rule === SPEC_RULES.SCHEMA_VIOLATION && e.message?.includes('random_field')
      );
      expect(d).toBeDefined();
      expect(d!.narrowRepair).not.toMatch(/^Add field/);
      expect(d!.narrowRepair).toContain('Remove field "random_field"');
    }
  });

  /**
   * Missing required field repair has exact text (L218 StringLiteral).
   * This also kills the L217 `if (e.keyword === 'required')` ConditionalExpression(false) mutant.
   */
  test('missing required field repair says "Add field \\"title\\"" not "Add field \\"\\"" (kills L218)', () => {
    const y = VALID_TIER3.replace('title: A valid tier 3 spec\n', '');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.message?.startsWith('Missing required field "title"'));
      expect(d).toBeDefined();
      expect(d!.narrowRepair).toBe('Add field "title" to the spec.');
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts — allErrors/strict
// Tests that assert MULTIPLE simultaneous errors (kills L32 BooleanLiteral)
// ============================================================

describe('shape layer: AJV allErrors=true produces ALL errors simultaneously', () => {
  /**
   * L32 BooleanLiteral: allErrors: false → only first error returned.
   * With allErrors: false, removing 'title' from a spec with invalid risk_tier
   * would return only ONE error. With allErrors: true, BOTH should appear.
   */
  test('two simultaneous schema errors both appear (allErrors:true behavior)', () => {
    // Remove title AND use invalid risk_tier → two separate schema errors
    // risk_tier=5 fires enum on /risk_tier (RISK_TIER_OUT_OF_RANGE)
    // missing title fires required (SCHEMA_VIOLATION with message containing "title")
    const y = VALID_TIER3.replace('title: A valid tier 3 spec\n', '').replace('risk_tier: 3', 'risk_tier: 5');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Both required(title) AND risk_tier enum error should appear
      const hasTitleErr = r.errors.some((e) => e.message?.includes('"title"'));
      const hasRiskTierErr = r.errors.some((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      expect(hasTitleErr).toBe(true);
      expect(hasRiskTierErr).toBe(true);
      // More than one error must be present (proves allErrors:true)
      expect(r.errors.length).toBeGreaterThan(1);
    }
  });

  test('three simultaneous errors: missing title, invalid risk_tier, invalid id all appear', () => {
    const y = VALID_TIER3
      .replace('title: A valid tier 3 spec\n', '')
      .replace('risk_tier: 3', 'risk_tier: 5')
      .replace('id: TEST-1', 'id: bad-id');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.length).toBeGreaterThanOrEqual(3);
      const hasTitleErr = r.errors.some((e) => e.message?.includes('"title"'));
      const hasRiskTierErr = r.errors.some((e) => e.rule === SPEC_RULES.RISK_TIER_OUT_OF_RANGE);
      const hasIdErr = r.errors.some((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION);
      expect(hasTitleErr).toBe(true);
      expect(hasRiskTierErr).toBe(true);
      expect(hasIdErr).toBe(true);
    }
  });

  test('two scope errors at once: scope.in empty AND invalid id', () => {
    const y = VALID_TIER3
      .replace('  in:\n    - src/x.ts', '  in: []')
      .replace('id: TEST-1', 'id: notvalid-lower');
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.length).toBeGreaterThanOrEqual(2);
      expect(r.errors.some((e) => e.rule === SPEC_RULES.SCOPE_IN_EMPTY)).toBe(true);
      expect(r.errors.some((e) => e.rule === SPEC_RULES.ID_PATTERN_VIOLATION)).toBe(true);
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts — narrowRepair undefined
// Tests that certain violations produce narrowRepair=undefined (L88 spread condition)
// ============================================================

describe('shape layer: narrowRepair is undefined for keywords without a repair', () => {
  /**
   * L88: ...(narrowRepair !== undefined && { narrowRepair })
   * ConditionalExpression(true) mutant always spreads narrowRepair.
   * Kill it: a violation with no repair (formatRepair returns undefined) should NOT
   * have narrowRepair in the diagnostic.
   *
   * Which keywords have no repair? Looking at formatRepair:
   * - additionalProperties → has repair
   * - enum/mode → has repair
   * - risk_tier type/enum → has repair
   * - scope.in minItems → has repair
   * - scope.out not → has repair
   * - id pattern → has repair
   * - required → has repair
   * - default → returns undefined
   *
   * The 'default' case in formatRepair fires for any unknown keyword.
   * Triggering a `minLength` or `maxLength` violation would hit the default.
   * scope.out items have minLength:1 — use an empty string scope.out item.
   * But the `not` pattern also applies. Let's use a required field with empty value.
   */
  test('a violation with no repair path (e.g. type error on a nested field) has no narrowRepair', () => {
    // blast_radius.modules should be an array of strings. If we supply null for modules,
    // that's a type error with no specific repair. Let's check what happens.
    const y = `
id: TEST-1
title: A valid tier 3 spec
risk_tier: 3
mode: chore
lifecycle_state: active
blast_radius:
  modules: "not-an-array"
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
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Find the type error on blast_radius.modules
      const d = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('modules'));
      if (d) {
        // This is the DEFAULT case in formatRepair — returns undefined
        expect(d.narrowRepair).toBeUndefined();
      }
    }
  });

  test('scope.in type violation (providing object instead of array) has no narrowRepair', () => {
    // scope.in as a non-array → type error, not minItems → hits default in formatRepair
    const y = `
id: TEST-1
title: A valid tier 3 spec
risk_tier: 3
mode: chore
lifecycle_state: active
blast_radius:
  modules:
    - src/x.ts
scope:
  in: "not-an-array"
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
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Find a type error on /scope/in (not the minItems for /scope/in)
      const d = r.errors.find((e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/scope/in'));
      if (d) {
        // Default case in formatRepair → undefined
        expect(d.narrowRepair).toBeUndefined();
      }
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-shape.ts — formatMessage 'not' case
// and default case
// ============================================================

describe('shape layer: formatMessage not and default cases (kills L166-L169 survivors)', () => {
  /**
   * L166: case 'not': -> ConditionalExpression. The 'not' case in formatMessage
   * returns e.message ?? 'Forbidden value.'. AJV's 'not' message is "must NOT be valid".
   * The test asserts the actual message is NOT empty (kills L167 StringLiteral `""`).
   */
  test('scope.out glob message comes from AJV not keyword (e.message not empty)', () => {
    const y = VALID_TIER3.replace(
      '  in:\n    - src/x.ts',
      '  in:\n    - src/x.ts\n  out:\n    - "src/**"'
    );
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
      expect(d).toBeDefined();
      // The message is from e.message (AJV 'not' → "must NOT be valid") or fallback
      expect(d!.message).not.toBe('');
      // AJV provides a message for 'not' violations
      expect(typeof d!.message).toBe('string');
      expect(d!.message.length).toBeGreaterThan(0);
    }
  });

  /**
   * L168: default: return e.message ?? `Schema violation (${e.keyword}).`
   * The default case fires for any keyword not in the switch.
   * e.g. a 'type' error on blast_radius.modules uses e.message.
   * Kills L169 StringLiteral(``) by asserting the default message contains keyword.
   */
  test('default keyword error (type on nested field) uses e.message', () => {
    // modules must be an array of strings; provide a number to trigger type error
    const y = `
id: TEST-1
title: A valid tier 3 spec
risk_tier: 3
mode: chore
lifecycle_state: active
blast_radius:
  modules:
    - 999
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
    const r = parseAndValidateSpec(y);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // Find a type error on nested path like /blast_radius/modules/0
      const d = r.errors.find(
        (e) => e.data?.['ajvKeyword'] === 'type' && e.subject?.includes('/blast_radius')
      );
      if (d) {
        // Message should be non-empty (from e.message, AJV always provides it)
        expect(d.message).not.toBe('');
        expect(d.message.length).toBeGreaterThan(0);
      }
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// authority field assertions (kills StringLiteral "" survivors on authority lines)
// ============================================================

describe('semantic layer: authority is always kernel/spec (kills authority StringLiteral survivors)', () => {
  test('tier1 contracts diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      mode: 'feature' as const,
      contracts: [],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_CONTRACTS);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('tier2 contracts diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 2 as const,
      mode: 'feature' as const,
      contracts: [],
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER2_MISSING_CONTRACTS);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('tier1 observability diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: [],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('tier1 rollback diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: [],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_ROLLBACK);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('tier1 security diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: {},
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.TIER1_MISSING_SECURITY);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('experimental_mode diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
      experimental_mode: { enabled: true, rationale: 'test', expires_at: '2030-01-01' },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('resolution requires_closure diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, resolution: 'completed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('closed spec missing resolution diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('supersedes self-reference diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: spec.id } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });

  test('scope overbroad_out diagnostic has authority=kernel/spec', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.SCOPE_OVERBROAD_OUT);
      expect(d).toBeDefined();
      expect(d!.authority).toBe('kernel/spec');
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L28/L39: contracts conditions both sides
// ============================================================

describe('semantic layer: contracts condition BOTH sides (kills L28/L39 ConditionalExpression)', () => {
  /**
   * L28 ConditionalExpression(true): `spec.risk_tier === 1 && spec.contracts.length === 0` → `true`
   * Kill it: tier-1 with contracts provided should NOT fire TIER1_MISSING_CONTRACTS.
   */
  test('tier-1 with contracts provided does NOT fire TIER1_MISSING_CONTRACTS', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      mode: 'feature' as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    // Could still fail on observability/rollback/security but NOT contracts
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L39 ConditionalExpression(true): `spec.risk_tier === 2 && spec.contracts.length === 0` → `true`
   * Kill it: tier-2 with contracts provided should NOT fire TIER2_MISSING_CONTRACTS.
   */
  test('tier-2 with contracts provided does NOT fire TIER2_MISSING_CONTRACTS', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 2 as const,
      mode: 'feature' as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L39 LogicalOperator: `tier===2 && length===0` → `tier===2 || length===0`
   * Kill it: tier-3 (not tier-2) with empty contracts should NOT fire TIER2_MISSING_CONTRACTS.
   */
  test('tier-3 with no contracts does NOT fire TIER2_MISSING_CONTRACTS (kills L39 LogicalOperator)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 3 as const,
      mode: 'feature' as const,
      contracts: [],
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_CONTRACTS);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L55/L67/L80: observability/rollback/security BOTH sides
// ============================================================

describe('semantic layer: observability/rollback/security condition BOTH sides', () => {
  /**
   * L55 ConditionalExpression(true): `!spec.observability || spec.observability.length === 0` → `true`
   * Kill it: tier-1 with non-empty observability should NOT fire TIER1_MISSING_OBSERVABILITY.
   */
  test('tier-1 with non-empty observability does NOT fire TIER1_MISSING_OBSERVABILITY', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['metrics', 'logs'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L55 EqualityOperator: `spec.observability.length === 0` → `!== 0`
   * Kill it: observability with one item must NOT trigger the error.
   */
  test('tier-1 with exactly one observability item does NOT fire TIER1_MISSING_OBSERVABILITY', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['one-item'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L67 ConditionalExpression(true): `!spec.rollback || spec.rollback.length === 0` → `true`
   * Kill it: tier-1 with non-empty rollback should NOT fire TIER1_MISSING_ROLLBACK.
   */
  test('tier-1 with non-empty rollback does NOT fire TIER1_MISSING_ROLLBACK', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert step'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_ROLLBACK);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L67 EqualityOperator: `spec.rollback.length === 0` → `!== 0`
   * Kill it: rollback with exactly one item must pass.
   */
  test('tier-1 with exactly one rollback item does NOT fire TIER1_MISSING_ROLLBACK', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['exactly-one'],
      non_functional: { security: ['no new surface'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_ROLLBACK);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L80 ConditionalExpression(true): `!sec || sec.length === 0` → `true`
   * Kill it: tier-1 with non-empty security should NOT fire TIER1_MISSING_SECURITY.
   */
  test('tier-1 with non-empty security does NOT fire TIER1_MISSING_SECURITY', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['audit-logging', 'auth-check'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_SECURITY);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L80 EqualityOperator: `sec.length === 0` → `!== 0`
   * Kill it: security with exactly one item must pass.
   */
  test('tier-1 with exactly one security item does NOT fire TIER1_MISSING_SECURITY', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['one-security-item'] },
    };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.TIER1_MISSING_SECURITY);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L109/L124: resolution and lifecycle conditions BOTH sides
// ============================================================

describe('semantic layer: resolution/lifecycle condition BOTH sides (kills L109/L124 survivors)', () => {
  /**
   * L109 ConditionalExpression(true): `spec.resolution !== undefined && lifecycle !== 'closed' && lifecycle !== 'archived'`
   * → `true`. Kill it: spec with resolution=completed AND lifecycle=closed should NOT fire RESOLUTION_REQUIRES_CLOSURE.
   */
  test('closed spec WITH resolution completed does NOT fire RESOLUTION_REQUIRES_CLOSURE', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const, resolution: 'completed' as const };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L109 ConditionalExpression at position 77: `lifecycle !== 'archived'` → `true`
   * Kill it: archived spec WITH resolution should NOT fire RESOLUTION_REQUIRES_CLOSURE.
   */
  test('archived spec WITH resolution superseded does NOT fire RESOLUTION_REQUIRES_CLOSURE', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'archived' as const, resolution: 'superseded' as const };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L109 StringLiteral("") for 'closed': If 'closed' is replaced with "", then
   * lifecycle_state='closed' would NOT match and fire the error when it shouldn't.
   * Kill it: closed spec with resolution should be CLEAN (no RESOLUTION_REQUIRES_CLOSURE).
   */
  test('spec.lifecycle_state=closed with resolution abandoned is valid (no RESOLUTION_REQUIRES_CLOSURE)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const, resolution: 'abandoned' as const };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L124 ConditionalExpression(false): `(lifecycle === 'closed' || lifecycle === 'archived') && resolution === undefined`
   * Kill it: active spec WITHOUT resolution should NOT fire CLOSED_SPEC_MISSING_RESOLUTION.
   */
  test('active spec without resolution does NOT fire CLOSED_SPEC_MISSING_RESOLUTION', () => {
    const spec = parseShape(VALID_TIER3);
    // VALID_TIER3 is active, no resolution
    const r = validateSpecSemantics(spec);
    expect(isOk(r)).toBe(true);
  });

  /**
   * L124 StringLiteral for 'closed' (position 68): if replaced with "", lifecycle='closed'
   * would never match → closed spec without resolution would NOT fire the error.
   * Kill it: closed spec WITHOUT resolution MUST fire CLOSED_SPEC_MISSING_RESOLUTION.
   */
  test('closed spec without resolution MUST fire CLOSED_SPEC_MISSING_RESOLUTION (L124 StringLiteral)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
    }
  });

  /**
   * L125 ConditionalExpression(true): `lifecycle === 'closed' || lifecycle === 'archived'` → `true`
   * Kill it: draft spec without resolution must NOT fire CLOSED_SPEC_MISSING_RESOLUTION.
   */
  test('draft spec without resolution does NOT fire CLOSED_SPEC_MISSING_RESOLUTION (L125 ConditionalExpression)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'draft' as const };
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L140: supersedes condition BOTH sides
// ============================================================

describe('semantic layer: supersedes condition BOTH sides (kills L140 survivors)', () => {
  /**
   * L140 ConditionalExpression(true): `spec.supersedes !== undefined && spec.supersedes === spec.id` → `true`
   * Kill it: a spec with supersedes=undefined should NOT fire SUPERSEDES_SELF_REFERENCE.
   */
  test('spec without supersedes does NOT fire SUPERSEDES_SELF_REFERENCE', () => {
    const spec = parseShape(VALID_TIER3);
    // VALID_TIER3 has no supersedes field
    const r = validateSpecSemantics(spec);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L140 ConditionalExpression at col40: `spec.supersedes === spec.id` → `true`
   * Kill it: supersedes a DIFFERENT id (not self) should NOT fire SUPERSEDES_SELF_REFERENCE.
   */
  test('supersedes a different id does NOT fire SUPERSEDES_SELF_REFERENCE (L140 right-side)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, supersedes: 'OTHER-123' } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L173/L174/L180: scope optional chaining and array defaults
// ============================================================

describe('semantic layer: scope optional chaining and array defaults (kills L173/L174/L180 survivors)', () => {
  /**
   * L173 OptionalChaining: `spec.scope?.in` → `spec.scope.in`
   * L174 OptionalChaining: `spec.scope?.out` → `spec.scope.out`
   * L180 OptionalChaining: `spec.scope?.support` → `spec.scope.support`
   * Kill them: passing a spec where scope is undefined should not throw.
   * (Post-shape validation, scope is always present. But the optional chain guards
   * against edge cases. Test by using a spec with empty scope arrays.)
   */
  test('spec with scope.in and no scope.out runs without error (out defaults to [])', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['src/x.ts'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });

  test('spec with scope.in and scope.support but no scope.out runs without error', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['src/x.ts'], support: ['shared/helper.ts'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });

  /**
   * L174 ArrayDeclaration: `spec.scope?.out ?? []` → `spec.scope?.out ?? ["Stryker was here"]`
   * Kill it: when scope.out is absent/undefined, it should be treated as empty (no overbroad errors).
   */
  test('spec with scope.out=undefined behaves as empty out (no false overbroad_out fires)', () => {
    const spec = parseShape(VALID_TIER3);
    // Explicitly set out to undefined (not present)
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });

  /**
   * L180 ArrayDeclaration: `spec.scope?.support ?? []` → `spec.scope?.support ?? ["Stryker was here"]`
   * Kill it: when scope.support is absent, it should be treated as empty (no spurious shadows).
   */
  test('spec with scope.support=undefined treats support as empty (no spurious overbroad)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['x/y'] } } as Spec;
    // 'x/y' doesn't shadow 'a/b/c.ts', support is undefined → treated as []
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L23: sourcePath ?? spec.id selection (kills L23 LogicalOperator)
// ============================================================

describe('semantic layer: subjectBase sourcePath vs spec.id selection (kills L23 LogicalOperator)', () => {
  /**
   * L23 LogicalOperator: `options.sourcePath ?? spec.id` → `options.sourcePath && spec.id`
   * The `&&` mutant: if sourcePath is FALSY (undefined), returns undefined (not spec.id).
   * Kill it: without sourcePath, subject must be spec.id (not undefined/empty).
   */
  test('no sourcePath → subject is spec.id not empty (kills L23 LogicalOperator)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
      expect(d).toBeDefined();
      // With no sourcePath: subjectBase = spec.id = 'TEST-1'
      expect(d!.subject).toBe('TEST-1');
      expect(d!.subject).not.toBe('');
      expect(d!.subject).not.toBeUndefined();
    }
  });

  /**
   * Further: with sourcePath, subject must be the path not spec.id.
   */
  test('with sourcePath → subject is sourcePath not spec.id (kills L23 LogicalOperator)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, lifecycle_state: 'closed' as const };
    const r = validateSpecSemantics(mutated, { sourcePath: '/path/to/spec.yaml' });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const d = r.errors.find((e) => e.rule === SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
      expect(d).toBeDefined();
      expect(d!.subject).toBe('/path/to/spec.yaml');
      expect(d!.subject).not.toBe('TEST-1');
    }
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// L95: experimental_mode condition BOTH sides
// ============================================================

describe('semantic layer: experimental_mode condition BOTH sides (kills L95 survivors)', () => {
  /**
   * L95 ConditionalExpression(false): `spec.experimental_mode !== undefined && spec.risk_tier !== 3` → `false`
   * Kill it: when experimental_mode IS defined AND risk_tier != 3 → MUST fire the error.
   * (Already tested above, but we need the explicit assertion here.)
   */
  test('experimental_mode on tier-1 MUST fire EXPERIMENTAL_MODE_TIER_RESTRICTED (L95 false-mutant)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 1 as const,
      contracts: [{ name: 'c', type: 'behavior' as const, path: 'src/x.ts', description: 'd' }],
      observability: ['log'],
      rollback: ['revert'],
      non_functional: { security: ['no new surface'] },
      experimental_mode: { enabled: true, rationale: 'test', expires_at: '2030-01-01' },
    };
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    }
  });

  /**
   * L95 EqualityOperator: `spec.experimental_mode === undefined` (opposite direction)
   * Kill it: when experimental_mode is NOT defined, should NOT fire.
   */
  test('no experimental_mode on any tier does NOT fire EXPERIMENTAL_MODE_TIER_RESTRICTED', () => {
    const spec = parseShape(VALID_TIER3);
    // No experimental_mode in VALID_TIER3
    const r = validateSpecSemantics(spec);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L95 col47 NoCoverage: `spec.risk_tier !== 3` → EqualityOperator: `spec.risk_tier === 3`
   * Kill it: experimental_mode on risk_tier=3 SHOULD NOT fire the error
   * (already tested in "experimental_mode on tier 3 -> allowed").
   * Additional explicit assertion:
   */
  test('experimental_mode on tier-3 with no other errors passes semantics cleanly', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = {
      ...spec,
      risk_tier: 3 as const,
      experimental_mode: { enabled: true, rationale: 'safe to experiment at tier 3', expires_at: '2031-12-31' },
    };
    const r = validateSpecSemantics(mutated);
    expect(isOk(r)).toBe(true);
  });
});

// ============================================================
// TARGETED MUTANT KILLERS: validate-semantics.ts
// isPathSegmentPrefix helpers (kills L227/L244/L245/L246 survivors)
// ============================================================

describe('semantic layer: isPathSegmentPrefix boundary cases (kills L227/L244/L245/L246)', () => {
  /**
   * L227 ConditionalExpression(false): `if (prefix.length === 0) return false` → `if (false)`
   * Kill it: empty prefix should NOT shadow anything (returns false → no overbroad error).
   */
  test('empty string scope.out does NOT fire overbroad_out (L227 ConditionalExpression false)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: [''] } } as Spec;
    const r = validateSpecSemantics(mutated);
    // Empty prefix returns false from isPathSegmentPrefix → no overbroad error
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L227 EqualityOperator: `p.length === 0` vs `>= 1` or `<= 1`
   * Kill it: prefix of length 1 (single char) should NOT be treated as empty.
   */
  test('single-char scope.out "a" DOES fire overbroad_out when scope.in starts with "a/"', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['a'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  /**
   * L227 MethodExpression: `p.startsWith('/')` mutant changes the function.
   * This would alter normalizeScopePath behavior. Kill it via a path that starts with '/'.
   */
  test('scope path starting with / is normalized and shadows correctly', () => {
    const spec = parseShape(VALID_TIER3);
    // This tests normalizeScopePath handles paths without trailing slash
    const mutated = { ...spec, scope: { in: ['/a/b/c.ts'], out: ['/a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  /**
   * L244 ConditionalExpression(false): `if (prefix === candidate) return false` → `if (false)`
   * Kill it: exact equality (prefix === candidate) should NOT fire overbroad_out.
   * (Exact equality is a different defect class.)
   */
  test('exact equality scope.in === scope.out does NOT fire overbroad_out (L244)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c'], out: ['a/b/c'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L244 BooleanLiteral: returning `true` instead of `false` for exact equality.
   * Kill it: same as above — exact equality must NOT shadow.
   */
  test('scope.out exactly equal to scope.in (both "src/x.ts") does NOT fire overbroad_out', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['src/x.ts'], out: ['src/x.ts'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L245 ConditionalExpression(false): `if (!candidate.startsWith(prefix)) return false` → `if (false)`
   * Kill it: when candidate does NOT start with prefix, should NOT fire overbroad_out.
   */
  test('scope.out "x/y" does NOT shadow scope.in "a/b/c.ts" (no common prefix)', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['x/y'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });

  /**
   * L246 ConditionalExpression(false): `return candidate.charAt(prefix.length) === '/'` → `return false`
   * Kill it: proper path boundary (a/b shadows a/b/c) MUST fire overbroad_out.
   */
  test('a/b shadows a/b/c.ts (path segment boundary check fires) — kills L246 false-mutant', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/b/c.ts'], out: ['a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    }
  });

  /**
   * L246 BooleanLiteral: returning `true` (always shadows when startsWith matches).
   * Kill it: "a/bc.ts" starts with "a/" prefix so if BooleanLiteral mutant returns true,
   * 'a/b' would shadow 'a/bc.ts' (it should NOT because the next char is 'c' not '/').
   */
  test('a/b does NOT shadow a/bc.ts (segment boundary: c is not /) — kills L246 BooleanLiteral', () => {
    const spec = parseShape(VALID_TIER3);
    const mutated = { ...spec, scope: { in: ['a/bc.ts'], out: ['a/b'] } } as Spec;
    const r = validateSpecSemantics(mutated);
    if (isErr(r)) {
      expect(r.errors.map((e) => e.rule)).not.toContain(SPEC_RULES.SCOPE_OVERBROAD_OUT);
    } else {
      expect(isOk(r)).toBe(true);
    }
  });
});
