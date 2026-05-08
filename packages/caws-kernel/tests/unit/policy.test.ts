import * as fs from 'fs';
import * as path from 'path';
import {
  parseAndValidatePolicy,
  parsePolicyYaml,
  validatePolicyShape,
  validatePolicySemantics,
  POLICY_RULES,
} from '../../src/policy';
import type { Diagnostic } from '../../src/diagnostics/types';
import {
  VALID_MINIMAL_POLICY,
  POLICY_WITH_LABEL_FIELDS,
  POLICY_MISPLACED_APPROVERS,
  POLICY_CORRECTED_APPROVERS,
  POLICY_UNKNOWN_GATE,
  POLICY_UNKNOWN_GATE_MODE,
  POLICY_MISSING_REQUIRED_GATE,
  POLICY_BROAD_NON_GOVERNED_ZONE,
  POLICY_BROAD_NON_GOVERNED_ZONE_FORCED,
  POLICY_NON_MONOTONIC_FILES,
  POLICY_NON_MONOTONIC_LOC,
  POLICY_CRITICAL_GATE_NOT_BLOCK,
  POLICY_RISKY_ROOT_PASSTHROUGH,
  POLICY_ROOT_PASSTHROUGH_WITH_SLASH,
} from '../fixtures/policy-fixtures';

const CORPUS_LIVE_POLICY = path.resolve(__dirname, '../../../../docs/rewrite/corpus/policy/policy.yaml.live');

function rules(diags: readonly Diagnostic[]): string[] {
  return diags.map((d) => d.rule);
}

function authorities(diags: readonly Diagnostic[]): string[] {
  return [...new Set(diags.map((d) => d.authority))];
}

describe('parsePolicyYaml (parse layer)', () => {
  it('parses a valid policy YAML', () => {
    const r = parsePolicyYaml(VALID_MINIMAL_POLICY);
    expect(r.ok).toBe(true);
  });

  it('returns parse_failed Err for malformed YAML', () => {
    const r = parsePolicyYaml('version: 1\n  bad: [unclosed', { sourcePath: '/tmp/p.yaml' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(POLICY_RULES.YAML_PARSE_FAILED);
      expect(r.errors[0]?.authority).toBe('kernel/policy');
    }
  });

  it('returns empty_document for empty input', () => {
    const r = parsePolicyYaml('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(POLICY_RULES.EMPTY_DOCUMENT);
    }
  });

  it('returns not_an_object for an array', () => {
    const r = parsePolicyYaml('- 1\n- 2');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.rule).toBe(POLICY_RULES.NOT_AN_OBJECT);
    }
  });
});

describe('validatePolicyShape (schema layer)', () => {
  it('accepts a minimal valid policy', () => {
    const r = parseAndValidatePolicy(VALID_MINIMAL_POLICY);
    expect(r.ok).toBe(true);
  });

  it('rejects label: on tier objects with stable rule id', () => {
    const r = parseAndValidatePolicy(POLICY_WITH_LABEL_FIELDS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.FORBIDDEN_TIER_LABEL);
      const labelDiag = r.errors.find((e) => e.rule === POLICY_RULES.FORBIDDEN_TIER_LABEL);
      expect(labelDiag?.narrowRepair).toMatch(/description.*instead of.*label/);
    }
  });

  it('rejects misplaced min_approvers_for_budget_raise under edit_rules', () => {
    const r = parseAndValidatePolicy(POLICY_MISPLACED_APPROVERS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.MISPLACED_APPROVERS_FIELD);
      const diag = r.errors.find((e) => e.rule === POLICY_RULES.MISPLACED_APPROVERS_FIELD);
      expect(diag?.narrowRepair).toMatch(/Move.*from edit_rules to waivers/);
    }
  });

  it('accepts the corrected approver placement under waivers', () => {
    const r = parseAndValidatePolicy(POLICY_CORRECTED_APPROVERS);
    expect(r.ok).toBe(true);
  });

  it('rejects unknown gate name', () => {
    const r = parseAndValidatePolicy(POLICY_UNKNOWN_GATE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.UNKNOWN_GATE);
    }
  });

  it('rejects unknown gate mode', () => {
    const r = parseAndValidatePolicy(POLICY_UNKNOWN_GATE_MODE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.UNKNOWN_GATE_MODE);
    }
  });

  it('rejects missing required gate', () => {
    const r = parseAndValidatePolicy(POLICY_MISSING_REQUIRED_GATE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.MISSING_REQUIRED_GATE);
    }
  });

  it('rejects broad non_governed_zone "**" without force flag', () => {
    const r = parseAndValidatePolicy(POLICY_BROAD_NON_GOVERNED_ZONE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.BROAD_NON_GOVERNED_ZONE);
    }
  });

  it('accepts broad non_governed_zone "**" when non_governed_zones_force=true', () => {
    const r = parseAndValidatePolicy(POLICY_BROAD_NON_GOVERNED_ZONE_FORCED);
    expect(r.ok).toBe(true);
    // ...but emits a semantic warning (covered below).
  });

  it('rejects root_passthrough entry containing a slash', () => {
    const r = parseAndValidatePolicy(POLICY_ROOT_PASSTHROUGH_WITH_SLASH);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.ROOT_PASSTHROUGH_HAS_SLASH);
    }
  });
});

describe('validatePolicySemantics (semantic layer)', () => {
  it('rejects non-monotonic max_files (T1 > T2)', () => {
    const r = parseAndValidatePolicy(POLICY_NON_MONOTONIC_FILES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.TIER_NON_MONOTONIC_FILES);
    }
  });

  it('rejects non-monotonic max_loc (T1 > T2)', () => {
    const r = parseAndValidatePolicy(POLICY_NON_MONOTONIC_LOC);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(rules(r.errors)).toContain(POLICY_RULES.TIER_NON_MONOTONIC_LOC);
    }
  });

  it('emits a warning when a critical gate is not in block mode', () => {
    const r = parseAndValidatePolicy(POLICY_CRITICAL_GATE_NOT_BLOCK);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.warnings ?? [];
      expect(w.some((d) => d.rule === POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING)).toBe(true);
      const diag = w.find((d) => d.rule === POLICY_RULES.CRITICAL_GATE_NOT_BLOCKING);
      expect(diag?.severity).toBe('warning');
    }
  });

  it('emits a warning when non_governed_zones_force is enabled', () => {
    const r = parseAndValidatePolicy(POLICY_BROAD_NON_GOVERNED_ZONE_FORCED);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.warnings ?? [];
      expect(w.some((d) => d.rule === POLICY_RULES.NON_GOVERNED_FORCE_USED)).toBe(true);
    }
  });

  it('emits warnings for risky root_passthrough entries', () => {
    const r = parseAndValidatePolicy(POLICY_RISKY_ROOT_PASSTHROUGH);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.warnings ?? [];
      const risky = w.filter((d) => d.rule === POLICY_RULES.ROOT_PASSTHROUGH_RISKY_FILE);
      // package.json AND .gitignore are risky; README.md is not
      expect(risky.length).toBeGreaterThanOrEqual(2);
      const subjects = risky.map((d) => d.location?.pointer ?? '');
      expect(subjects.some((s) => s.includes('/root_passthrough/'))).toBe(true);
    }
  });

  it('does not warn when root_passthrough contains only safe files', () => {
    const safe = `${VALID_MINIMAL_POLICY}\nroot_passthrough:\n  - README.md\n  - CHANGELOG.md\n`;
    const r = parseAndValidatePolicy(safe);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const w = r.warnings ?? [];
      expect(w.some((d) => d.rule === POLICY_RULES.ROOT_PASSTHROUGH_RISKY_FILE)).toBe(false);
    }
  });

  it('callable independently with a known-shape Policy', () => {
    const parsed = parsePolicyYaml(VALID_MINIMAL_POLICY);
    if (!parsed.ok) throw new Error('parse failed');
    const shape = validatePolicyShape(parsed.value);
    if (!shape.ok) throw new Error('shape failed');
    const sem = validatePolicySemantics(shape.value);
    expect(sem.ok).toBe(true);
  });
});

describe('layer separation (rule namespaces)', () => {
  it('parse-layer errors carry policy.yaml.* prefix', () => {
    const r = parseAndValidatePolicy(': bad :');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) expect(e.rule.startsWith('policy.yaml.')).toBe(true);
    }
  });

  it('schema-layer errors carry policy.schema.* prefix', () => {
    const r = parseAndValidatePolicy(POLICY_WITH_LABEL_FIELDS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) expect(e.rule.startsWith('policy.schema.')).toBe(true);
    }
  });

  it('semantic-layer errors carry policy.semantic.* prefix', () => {
    const r = parseAndValidatePolicy(POLICY_NON_MONOTONIC_FILES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      for (const e of r.errors) expect(e.rule.startsWith('policy.semantic.')).toBe(true);
    }
  });
});

describe('corpus: live policy.yaml', () => {
  it('fails with both label drift and misplaced approvers', () => {
    const source = fs.readFileSync(CORPUS_LIVE_POLICY, 'utf8');
    const r = parseAndValidatePolicy(source, { sourcePath: 'policy.yaml.live' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const ruleSet = new Set(rules(r.errors));
      expect(ruleSet.has(POLICY_RULES.FORBIDDEN_TIER_LABEL)).toBe(true);
      expect(ruleSet.has(POLICY_RULES.MISPLACED_APPROVERS_FIELD)).toBe(true);
      expect(authorities(r.errors)).toEqual(['kernel/policy']);
    }
  });
});
