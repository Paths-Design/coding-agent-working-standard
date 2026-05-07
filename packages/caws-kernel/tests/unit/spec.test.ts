import * as fs from 'fs';
import * as path from 'path';
import {
  parseAndValidateSpec,
  parseSpecYaml,
  validateSpecShape,
  validateSpecSemantics,
  SPEC_RULES,
} from '../../src/spec';
import type { Diagnostic } from '../../src/diagnostics/types';
import {
  VALID_T3_SPEC,
  SPEC_WITH_CHANGE_BUDGET,
  SPEC_WITH_ACCEPTANCE_CRITERIA,
  SPEC_WITH_SCOPE_INCLUDE,
  SPEC_WITH_SCOPE_EXCLUDE,
  SPEC_WITH_MODE_DEVELOPMENT,
  SPEC_WITH_STRING_RISK_TIER,
  SPEC_WITH_EMPTY_SCOPE_IN,
  SPEC_WITH_GLOB_IN_SCOPE_OUT,
  SPEC_WITH_LEGACY_STATUS_FIELD,
  SPEC_TIER2_NO_CONTRACTS,
  SPEC_TIER2_CHORE_NO_CONTRACTS,
  SPEC_TIER1_FULL,
  SPEC_TIER1_MISSING_SUPPORT,
  SPEC_TIER1_EXPERIMENTAL,
  SPEC_TIER3_EXPERIMENTAL,
  SPEC_ACTIVE_WITH_BLOCKERS,
  SPEC_ACTIVE_WITH_RESOLUTION,
  SPEC_CLOSED_NO_RESOLUTION,
  SPEC_SUPERSEDES_SELF,
} from '../fixtures/spec-fixtures';

const CORPUS_DIR = path.resolve(__dirname, '../../../../docs/rewrite/corpus/negative-fixtures');

function rules(errors: readonly Diagnostic[]): string[] {
  return errors.map((e) => e.rule);
}

function authorities(errors: readonly Diagnostic[]): string[] {
  return [...new Set(errors.map((e) => e.authority))];
}

describe('parseSpecYaml (parse layer)', () => {
  it('parses a valid YAML object', () => {
    const r = parseSpecYaml(VALID_T3_SPEC);
    expect(r.ok).toBe(true);
  });

  it('returns parse_failed Err with location for malformed YAML', () => {
    const malformed = 'id: FOO\n  bad: indentation\n: weird';
    const r = parseSpecYaml(malformed, { sourcePath: '/tmp/bad.yaml' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SPEC_RULES.YAML_PARSE_FAILED);
      expect(r.errors[0]?.authority).toBe('kernel/spec');
      expect(r.errors[0]?.subject).toBe('/tmp/bad.yaml');
    }
  });

  it('returns empty_document for empty/null YAML', () => {
    const r = parseSpecYaml('');
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SPEC_RULES.EMPTY_DOCUMENT);
    } else {
      // some yaml parsers return null which we map to empty_document via Err
      throw new Error('expected Err for empty document');
    }
  });

  it('returns not_an_object for an array document', () => {
    const r = parseSpecYaml('- foo\n- bar');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SPEC_RULES.NOT_AN_OBJECT);
    }
  });
});

describe('validateSpecShape (schema layer)', () => {
  it('accepts a minimal valid T3 spec', () => {
    const parsed = parseSpecYaml(VALID_T3_SPEC);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const r = validateSpecShape(parsed.value);
      expect(r.ok).toBe(true);
    }
  });

  it('rejects change_budget with stable rule id', () => {
    const r = parseAndValidateSpec(SPEC_WITH_CHANGE_BUDGET);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(authorities(r.errors)).toEqual(['kernel/spec']);
      const cb = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET);
      expect(cb?.narrowRepair).toMatch(/policy.yaml/);
    }
  });

  it('rejects acceptance_criteria with stable rule id and rename repair', () => {
    const r = parseAndValidateSpec(SPEC_WITH_ACCEPTANCE_CRITERIA);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const ac = r.errors.find((e) => e.rule === SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA);
      expect(ac).toBeDefined();
      expect(ac?.narrowRepair).toMatch(/Rename.*acceptance/i);
    }
  });

  it('rejects scope.include alias', () => {
    const r = parseAndValidateSpec(SPEC_WITH_SCOPE_INCLUDE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.FORBIDDEN_FIELD_SCOPE_INCLUDE);
    }
  });

  it('rejects scope.exclude alias', () => {
    const r = parseAndValidateSpec(SPEC_WITH_SCOPE_EXCLUDE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.FORBIDDEN_FIELD_SCOPE_EXCLUDE);
    }
  });

  it('rejects mode: development with stable rule id', () => {
    const r = parseAndValidateSpec(SPEC_WITH_MODE_DEVELOPMENT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const mode = r.errors.find((e) => e.rule === SPEC_RULES.MODE_DEVELOPMENT_REMOVED);
      expect(mode).toBeDefined();
      expect(mode?.narrowRepair).toMatch(/feature, refactor, fix, doc, chore/);
    }
  });

  it('rejects string risk_tier "T3"', () => {
    const r = parseAndValidateSpec(SPEC_WITH_STRING_RISK_TIER);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.RISK_TIER_STRING_REJECTED);
    }
  });

  it('rejects empty scope.in', () => {
    const r = parseAndValidateSpec(SPEC_WITH_EMPTY_SCOPE_IN);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.SCOPE_IN_EMPTY);
    }
  });

  it('rejects glob characters in scope.out', () => {
    const r = parseAndValidateSpec(SPEC_WITH_GLOB_IN_SCOPE_OUT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.SCOPE_OUT_GLOB_FORBIDDEN);
    }
  });

  it('rejects legacy "status" field at the top level', () => {
    const r = parseAndValidateSpec(SPEC_WITH_LEGACY_STATUS_FIELD);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.FORBIDDEN_FIELD_STATUS);
    }
  });

  it('returns multiple diagnostics in one pass when allErrors is enabled', () => {
    // Combines change_budget + acceptance_criteria — both should surface in
    // a single pass. Avoids YAML duplicate-key collapse by using two distinct
    // forbidden top-level fields.
    const yamlSource = `
id: TEST-MULTI-1
title: Test spec
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - src/test/**
invariants:
  - test invariant
acceptance:
  - id: A1
    given: g
    when: w
    then: t
non_functional: {}
contracts: []
change_budget:
  max_files: 25
  max_loc: 1000
acceptance_criteria:
  - id: AC1
    description: legacy alias
`;
    const r = parseAndValidateSpec(yamlSource);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const ruleSet = new Set(rules(r.errors));
      expect(ruleSet.has(SPEC_RULES.FORBIDDEN_FIELD_CHANGE_BUDGET)).toBe(true);
      expect(ruleSet.has(SPEC_RULES.FORBIDDEN_FIELD_ACCEPTANCE_CRITERIA)).toBe(true);
      // Confirms allErrors is doing real work — at least 2 distinct rules.
      expect(ruleSet.size).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('validateSpecSemantics (tier-gated layer)', () => {
  it('rejects T2 with empty contracts unless mode=chore', () => {
    const r = parseAndValidateSpec(SPEC_TIER2_NO_CONTRACTS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.TIER2_MISSING_CONTRACTS);
    }
  });

  it('accepts T2 with empty contracts when mode=chore', () => {
    const r = parseAndValidateSpec(SPEC_TIER2_CHORE_NO_CONTRACTS);
    expect(r.ok).toBe(true);
  });

  it('accepts a fully-spec\'d T1', () => {
    const r = parseAndValidateSpec(SPEC_TIER1_FULL);
    expect(r.ok).toBe(true);
  });

  it('rejects T1 missing observability/rollback/security as three separable diagnostics', () => {
    const r = parseAndValidateSpec(SPEC_TIER1_MISSING_SUPPORT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const ruleSet = new Set(rules(r.errors));
      expect(ruleSet.has(SPEC_RULES.TIER1_MISSING_OBSERVABILITY)).toBe(true);
      expect(ruleSet.has(SPEC_RULES.TIER1_MISSING_ROLLBACK)).toBe(true);
      expect(ruleSet.has(SPEC_RULES.TIER1_MISSING_SECURITY)).toBe(true);
    }
  });

  it('rejects experimental_mode on T1', () => {
    const r = parseAndValidateSpec(SPEC_TIER1_EXPERIMENTAL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.EXPERIMENTAL_MODE_TIER_RESTRICTED);
    }
  });

  it('accepts experimental_mode on T3', () => {
    const r = parseAndValidateSpec(SPEC_TIER3_EXPERIMENTAL);
    expect(r.ok).toBe(true);
  });
});

describe('lifecycle shape', () => {
  it('accepts active spec with blockers (blocked is operational metadata, not a state)', () => {
    const r = parseAndValidateSpec(SPEC_ACTIVE_WITH_BLOCKERS);
    expect(r.ok).toBe(true);
  });

  it('rejects active spec with resolution (resolution requires closure)', () => {
    const r = parseAndValidateSpec(SPEC_ACTIVE_WITH_RESOLUTION);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.RESOLUTION_REQUIRES_CLOSURE);
    }
  });

  it('rejects closed spec without resolution', () => {
    const r = parseAndValidateSpec(SPEC_CLOSED_NO_RESOLUTION);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.CLOSED_SPEC_MISSING_RESOLUTION);
    }
  });

  it('rejects supersedes self-reference', () => {
    const r = parseAndValidateSpec(SPEC_SUPERSEDES_SELF);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(SPEC_RULES.SUPERSEDES_SELF_REFERENCE);
    }
  });
});

describe('corpus negative fixtures', () => {
  // The captured pathological state of the legacy CAWS implementation. Every
  // fixture in this directory MUST fail under the new schema for at least
  // one documented reason.
  const corpus = fs
    .readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  it('every corpus fixture exists', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of corpus) {
    it(`rejects ${file}`, () => {
      const source = fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8');
      const r = parseAndValidateSpec(source, { sourcePath: file });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // Authority should always be kernel/spec for this layer.
        expect(authorities(r.errors)).toEqual(['kernel/spec']);
        // Every error has a stable rule id.
        for (const e of r.errors) {
          expect(typeof e.rule).toBe('string');
          expect(e.rule.length).toBeGreaterThan(0);
        }
      }
    });
  }

  it('CAWSFIX-14 fails specifically at the YAML parse layer', () => {
    const source = fs.readFileSync(path.join(CORPUS_DIR, 'CAWSFIX-14.yaml'), 'utf8');
    const r = parseAndValidateSpec(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SPEC_RULES.YAML_PARSE_FAILED);
    }
  });

  it('CAWSFIX-15 fails specifically at the YAML parse layer', () => {
    const source = fs.readFileSync(path.join(CORPUS_DIR, 'CAWSFIX-15.yaml'), 'utf8');
    const r = parseAndValidateSpec(source);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(SPEC_RULES.YAML_PARSE_FAILED);
    }
  });
});

describe('layer separation (rule namespaces)', () => {
  it('parse-layer errors carry spec.yaml.* rule prefix', () => {
    const r = parseAndValidateSpec(': bad yaml :');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) {
        expect(e.rule.startsWith('spec.yaml.')).toBe(true);
      }
    }
  });

  it('schema-layer errors carry spec.schema.* rule prefix', () => {
    const r = parseAndValidateSpec(SPEC_WITH_CHANGE_BUDGET);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) {
        expect(e.rule.startsWith('spec.schema.')).toBe(true);
      }
    }
  });

  it('semantic-layer errors carry spec.semantic.* rule prefix', () => {
    // SPEC_TIER1_MISSING_SUPPORT is structurally valid; only semantic checks fail.
    const r = parseAndValidateSpec(SPEC_TIER1_MISSING_SUPPORT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) {
        expect(e.rule.startsWith('spec.semantic.')).toBe(true);
      }
    }
  });
});

describe('validateSpecSemantics direct API', () => {
  it('can be called independently with a known-shape Spec', () => {
    // Round-trip: parse + shape-validate + then call semantics directly.
    const r1 = parseSpecYaml(SPEC_TIER1_MISSING_SUPPORT);
    if (!r1.ok) throw new Error('parse failed unexpectedly');
    const r2 = validateSpecShape(r1.value);
    if (!r2.ok) throw new Error('shape validation failed unexpectedly');
    const r3 = validateSpecSemantics(r2.value);
    expect(r3.ok).toBe(false);
    if (!r3.ok) {
      expect(rules(r3.errors)).toContain(SPEC_RULES.TIER1_MISSING_OBSERVABILITY);
    }
  });
});
