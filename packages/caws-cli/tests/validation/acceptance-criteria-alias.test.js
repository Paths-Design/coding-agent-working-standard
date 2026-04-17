/**
 * @fileoverview CAWSFIX-09 — acceptance_criteria alias tests
 *
 * Covers acceptance criteria A1-A4 + A6 for the defect where the semantic
 * validator rejected specs using the modern `acceptance_criteria:` shape
 * (as shipped in Sterling's P03-IMPL-01) with "Missing required field: acceptance".
 *
 * @author @darianrosebrook
 */

const {
  validateWorkingSpec,
  validateWorkingSpecWithSuggestions,
} = require('../../src/validation/spec-validation');

describe('CAWSFIX-09: acceptance_criteria alias', () => {
  /**
   * Shared base spec — fully valid EXCEPT for the acceptance-shape choice,
   * which each test case overrides. Using a single base minimizes drift
   * between tests.
   */
  const baseSpec = () => ({
    id: 'FEAT-001',
    title: 'Alias test',
    risk_tier: 3,
    mode: 'feature',
    blast_radius: { modules: ['src/'], data_migration: false },
    operational_rollback_slo: '5m',
    scope: {
      in: ['src/'],
      out: ['node_modules/'],
    },
    invariants: ['System remains stable'],
    non_functional: { a11y: [], perf: {}, security: [] },
    contracts: [],
  });

  describe('A1: modern acceptance_criteria shape is accepted', () => {
    it('should NOT emit "Missing required field: acceptance" for acceptance_criteria-only spec', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [
        {
          id: 'AC-01',
          description: 'User can log in',
          test_nodeids: ['tests/auth/login.test.js::test_login'],
          status: 'passing',
        },
      ];

      const result = validateWorkingSpecWithSuggestions(spec);

      // Assertion evidence: errors array contains no "Missing required field: acceptance"
      const hasMissingAcceptanceErr = result.errors.some(
        (e) => e.message === 'Missing required field: acceptance'
      );
      expect(hasMissingAcceptanceErr).toBe(false);
    });

    it('should NOT emit "No acceptance criteria defined" warning for acceptance_criteria-only spec', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [
        { id: 'AC-01', description: 'Behavior X', status: 'passing' },
      ];

      const result = validateWorkingSpecWithSuggestions(spec);

      // Assertion evidence: warnings array contains no "No acceptance criteria defined"
      const hasEmptyWarn = result.warnings.some(
        (w) => w.message === 'No acceptance criteria defined'
      );
      expect(hasEmptyWarn).toBe(false);
    });

    it('should pass validateWorkingSpec (basic) for acceptance_criteria-only spec', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [
        { id: 'AC-01', description: 'Behavior X', status: 'passing' },
      ];

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(true);
    });
  });

  describe('A2: legacy acceptance shape still works (regression)', () => {
    it('validateWorkingSpec passes with legacy {id,given,when,then}', () => {
      const spec = baseSpec();
      spec.acceptance = [
        {
          id: 'A1',
          given: 'User is logged in',
          when: 'User clicks save',
          then: 'Data persists',
        },
      ];

      const result = validateWorkingSpec(spec);
      expect(result.valid).toBe(true);
    });

    it('validateWorkingSpecWithSuggestions emits no acceptance-related errors for legacy shape', () => {
      const spec = baseSpec();
      spec.acceptance = [
        { id: 'A1', given: 'X', when: 'Y', then: 'Z' },
      ];

      const result = validateWorkingSpecWithSuggestions(spec);
      const accErrs = result.errors.filter((e) => /acceptance/i.test(e.message));
      const accWarns = result.warnings.filter((w) =>
        /No acceptance criteria defined/i.test(w.message)
      );
      expect(accErrs).toHaveLength(0);
      expect(accWarns).toHaveLength(0);
    });
  });

  describe('A3: when both keys present, acceptance wins', () => {
    it('uses acceptance (legacy) as source of truth, ignores acceptance_criteria', () => {
      const spec = baseSpec();
      spec.acceptance = [
        { id: 'A1', given: 'a', when: 'b', then: 'c' },
        { id: 'A2', given: 'd', when: 'e', then: 'f' },
        { id: 'A3', given: 'g', when: 'h', then: 'i' },
      ];
      spec.acceptance_criteria = [
        { id: 'AC-01', description: 'x1' },
        { id: 'AC-02', description: 'x2' },
        { id: 'AC-03', description: 'x3' },
        { id: 'AC-04', description: 'x4' },
        { id: 'AC-05', description: 'x5' },
      ];

      const result = validateWorkingSpec(spec);

      // A3 says: no duplicate-key error, no acceptance warning, legacy wins.
      // We can't directly observe "which one was read" from the validator's
      // return (it doesn't expose spec.acceptance length), but we CAN assert:
      //   - validation passes
      //   - no error mentions duplicate acceptance keys
      expect(result.valid).toBe(true);
      if (result.errors) {
        const dupErr = result.errors.find((e) => /duplicate/i.test(e.message));
        expect(dupErr).toBeUndefined();
      }
    });
  });

  describe('A4: per-item shape — modern items do not require given/when/then', () => {
    it('accepts acceptance_criteria items with {id, description, status} only', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [
        { id: 'AC-01', description: 'user visible behavior', status: 'passing' },
        { id: 'AC-02', description: 'another behavior', status: 'pending' },
      ];

      const result = validateWorkingSpecWithSuggestions(spec);

      // Evidence: NO per-item field error mentioning given/when/then
      const perItemErrs = result.errors.filter((e) =>
        /given|when|then/i.test(e.message)
      );
      expect(perItemErrs).toHaveLength(0);
    });

    it('accepts the full modern shape with test_nodeids', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [
        {
          id: 'AC-01',
          description: 'User can create a record',
          test_nodeids: [
            'packages/caws-cli/tests/records.test.js::test_create',
            'packages/caws-cli/tests/records.test.js::test_create_with_tags',
          ],
          status: 'passing',
        },
      ];

      const result = validateWorkingSpec(spec);
      expect(result.valid).toBe(true);
    });
  });

  describe('A6: Sterling P03-IMPL-01 reproduction', () => {
    it('validates a spec shaped like P03-IMPL-01 (modern acceptance_criteria, 12+ items)', () => {
      // Shape mirrors Sterling's P03-IMPL-01: 12+ acceptance_criteria entries
      // in the {id, description, test_nodeids, status} form.
      const spec = baseSpec();
      spec.id = 'PTRUTH-001'; // single-segment, to isolate from CAWSFIX-10
      spec.acceptance_criteria = Array.from({ length: 12 }, (_, i) => ({
        id: `AC-${String(i + 1).padStart(2, '0')}`,
        description: `Behavior ${i + 1}`,
        test_nodeids: [`tests/spec_${i + 1}.test.js::test_${i + 1}`],
        status: i < 10 ? 'passing' : 'pending',
      }));

      const result = validateWorkingSpecWithSuggestions(spec);

      // The two Sterling-observed false negatives must be absent.
      const fn1 = result.errors.some(
        (e) => e.message === 'Missing required field: acceptance'
      );
      const fn2 = result.warnings.some(
        (w) => w.message === 'No acceptance criteria defined'
      );

      expect(fn1).toBe(false);
      expect(fn2).toBe(false);
      expect(result.valid).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('rejects spec with NEITHER acceptance nor acceptance_criteria', () => {
      const spec = baseSpec();
      // Note: baseSpec() does not set either, so this is the test.

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
      const missingAcc = result.errors.find(
        (e) => e.message === 'Missing required field: acceptance'
      );
      expect(missingAcc).toBeDefined();
    });

    it('treats empty acceptance_criteria array as no-alias (falls back to missing)', () => {
      const spec = baseSpec();
      spec.acceptance_criteria = [];

      const result = validateWorkingSpec(spec);

      // Empty modern array should NOT count as satisfying acceptance —
      // otherwise we'd be lying about test coverage.
      expect(result.valid).toBe(false);
    });
  });
});
