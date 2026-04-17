/**
 * @fileoverview CAWSFIX-10 — multi-segment spec-ID regex tests
 *
 * Covers acceptance criteria A1-A3 + A5 for the defect where the semantic
 * validator's hardcoded /^[A-Z]+-\d+$/ rejected multi-segment IDs like
 * P03-IMPL-01 and ALG-001A-HARDEN-01 (Sterling P03-TEST-THROWAWAY reproduction).
 *
 * @author @darianrosebrook
 */

const {
  validateWorkingSpec,
  validateWorkingSpecWithSuggestions,
  SPEC_ID_PATTERN,
  SPEC_ID_ERROR_MESSAGE,
} = require('../../src/validation/spec-validation');

describe('CAWSFIX-10: multi-segment spec-ID regex', () => {
  /**
   * Baseline valid spec; each test overrides only `id` so we isolate the
   * regex behavior from every other validator rule.
   */
  const specWith = (id) => ({
    id,
    title: 'Regex test',
    risk_tier: 3,
    mode: 'feature',
    blast_radius: { modules: ['src/'], data_migration: false },
    operational_rollback_slo: '5m',
    scope: { in: ['src/'], out: ['node_modules/'] },
    invariants: ['Stable'],
    acceptance: [{ id: 'A1', given: 'x', when: 'y', then: 'z' }],
    non_functional: { a11y: [], perf: {}, security: [] },
    contracts: [],
  });

  describe('A1/A2: accepts single-segment AND multi-segment IDs', () => {
    const accepted = [
      // Single-segment (existing contract — must not regress)
      'FEAT-001',
      'EVLOG-002',
      'CAWSFIX-06',
      'FIX-123',
      'REFACTOR-999',
      'DOC-042',
      // Multi-segment (the new contract)
      'P03-IMPL-01',
      'ALG-001A-HARDEN-01',
      'CAWS-FIX-03',
      'CAWSFIX-PARALLEL-IMPL-001',
      // Edge-shaped but legal: single-letter prefix
      'A-1',
      // Numeric inside segment (legal per [A-Z0-9]+)
      'EVLOG-002A-01',
    ];

    it.each(accepted)('SPEC_ID_PATTERN accepts: %s', (id) => {
      expect(SPEC_ID_PATTERN.test(id)).toBe(true);
    });

    it.each(accepted)('validateWorkingSpec accepts id=%s', (id) => {
      const result = validateWorkingSpec(specWith(id));
      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it.each(accepted)('validateWorkingSpecWithSuggestions: no /id error for: %s', (id) => {
      const result = validateWorkingSpecWithSuggestions(specWith(id));
      const idErrors = result.errors.filter((e) => e.instancePath === '/id');
      expect(idErrors).toHaveLength(0);
    });
  });

  describe('A3: rejects junk IDs', () => {
    const rejected = [
      'feat-001', // lowercase
      '01-FEAT', // leading digit
      'FEAT-', // no number suffix
      'FEAT-01-', // trailing hyphen
      '--FEAT-01', // leading double hyphen
      'FEAT--001', // empty segment
      '', // empty string
      'NO_UNDERSCORES-01', // underscores not permitted
      'feat-IMPL-01', // mixed case in prefix
      'P03-impl-01', // mixed case in segment
      'JUSTPREFIX', // no number
      '123-456', // no letter prefix
    ];

    it.each(rejected)('SPEC_ID_PATTERN rejects: %j', (id) => {
      expect(SPEC_ID_PATTERN.test(id)).toBe(false);
    });

    it.each(rejected)('validateWorkingSpec fails for id=%j with /id error', (id) => {
      const result = validateWorkingSpec(specWith(id));
      expect(result.valid).toBe(false);
      // Evidence: the /id error exists. Empty strings hit the
      // "Missing required field: id" branch (runs before regex check),
      // so we accept either error as long as it's keyed to /id.
      const idErr = result.errors.find((e) => e.instancePath === '/id');
      expect(idErr).toBeDefined();
      if (id !== '') {
        // Non-empty junk IDs must get the format error specifically
        expect(idErr.message).toBe(SPEC_ID_ERROR_MESSAGE);
      }
    });
  });

  describe('A5: user-facing error message reflects new shape', () => {
    it('SPEC_ID_ERROR_MESSAGE mentions PREFIX-SEGMENT-NUMBER and includes P03-IMPL-01 example', () => {
      expect(SPEC_ID_ERROR_MESSAGE).toMatch(/PREFIX-NUMBER/);
      expect(SPEC_ID_ERROR_MESSAGE).toMatch(/PREFIX-SEGMENT-NUMBER/);
      expect(SPEC_ID_ERROR_MESSAGE).toMatch(/P03-IMPL-01/);
    });

    it('does NOT say "FEAT-1234" anymore (pre-fix placeholder)', () => {
      expect(SPEC_ID_ERROR_MESSAGE).not.toMatch(/FEAT-1234/);
    });
  });

  describe('A4 proxy: regex is exported once (DRY)', () => {
    it('exports SPEC_ID_PATTERN as a RegExp', () => {
      expect(SPEC_ID_PATTERN).toBeInstanceOf(RegExp);
    });

    it('SPEC_ID_PATTERN source matches the documented grammar', () => {
      // Exact source match — if someone duplicates the regex inline,
      // this assertion will still pass; the real DRY evidence is the
      // grep audit noted in the spec. But at least verify the exported
      // source is what we expect.
      expect(SPEC_ID_PATTERN.source).toBe('^[A-Z][A-Z0-9]*(-[A-Z0-9]+)*-\\d+$');
    });
  });

  describe('A6: Sterling P03-TEST-THROWAWAY reproduction', () => {
    it('accepts P03-TEST-THROWAWAY-01 (the repro ID)', () => {
      // Note: Sterling hit the error on `caws specs create P03-TEST-THROWAWAY`
      // (no numeric suffix). That's actually a separate concern (spec creation
      // format), but the validator-side reproduction uses a numeric suffix.
      const id = 'P03-TEST-THROWAWAY-01';
      expect(SPEC_ID_PATTERN.test(id)).toBe(true);
      const result = validateWorkingSpec(specWith(id));
      expect(result.valid).toBe(true);
    });

    it('accepts P03-IMPL-01 (Sterling fallback spec ID)', () => {
      const result = validateWorkingSpec(specWith('P03-IMPL-01'));
      expect(result.valid).toBe(true);
    });
  });
});
