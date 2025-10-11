/**
 * @fileoverview Comprehensive Tests for Spec Validation
 * Tests working spec validation with auto-fix capabilities
 * Ported from agent-agency TypeScript implementation
 * @author @darianrosebrook
 */

const {
  validateWorkingSpec,
  validateWorkingSpecWithSuggestions,
} = require('../../src/validation/spec-validation');

describe('SpecValidator', () => {
  /**
   * Helper to create a valid working spec
   * @returns {Object} Valid working spec
   */
  const createValidSpec = () => ({
    id: 'FEAT-001',
    title: 'Test Feature',
    risk_tier: 2,
    mode: 'feature',
    blast_radius: {
      modules: ['src/features'],
      data_migration: false,
    },
    operational_rollback_slo: '5m',
    scope: {
      in: ['src/features/', 'tests/'],
      out: ['node_modules/', 'dist/'],
    },
    invariants: ['System remains stable', 'Data consistency maintained'],
    acceptance: [
      {
        id: 'A1',
        given: 'User is logged in',
        when: 'User clicks submit',
        then: 'Data is saved',
      },
    ],
    non_functional: {
      a11y: ['keyboard-navigation'],
      perf: {
        api_p95_ms: 250,
      },
      security: ['input-validation'],
    },
    contracts: [
      {
        type: 'openapi',
        path: 'docs/api.yaml',
      },
    ],
  });

  describe('validateWorkingSpec', () => {
    it('should pass with valid spec', () => {
      const spec = createValidSpec();
      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    it('should fail with missing required fields', () => {
      const spec = {
        title: 'Test',
      };

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should fail with invalid ID format', () => {
      const spec = createValidSpec();
      spec.id = 'invalid';

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should accept valid ID formats', () => {
      const validIds = ['FEAT-001', 'FIX-123', 'REFACTOR-999', 'DOC-042'];

      for (const id of validIds) {
        const spec = createValidSpec();
        spec.id = id;
        const result = validateWorkingSpec(spec);

        expect(result.valid).toBe(true);
      }
    });

    it('should fail with invalid risk tier', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
    });

    it('should accept valid risk tiers (1, 2, 3)', () => {
      const tiers = [1, 2, 3];

      for (const tier of tiers) {
        const spec = createValidSpec();
        spec.risk_tier = tier;
        const result = validateWorkingSpec(spec);

        expect(result.valid).toBe(true);
      }
    });

    it('should fail with empty scope.in', () => {
      const spec = createValidSpec();
      spec.scope.in = [];

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
    });

    it('should fail with missing scope', () => {
      const spec = createValidSpec();
      delete spec.scope;

      const result = validateWorkingSpec(spec);

      expect(result.valid).toBe(false);
    });
  });

  describe('validateWorkingSpecWithSuggestions', () => {
    it('should provide suggestions for missing fields', () => {
      const spec = {
        title: 'Test',
      };

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      const idError = result.errors.find((e) => e.instancePath === '/id');
      expect(idError).toBeDefined();
      expect(idError.suggestion).toBeDefined();
      expect(idError.suggestion).toContain('PROJ-001');
    });

    it('should suggest auto-fix for invalid risk tier', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.fixes).toBeDefined();
      expect(result.fixes.length).toBeGreaterThan(0);
      const fix = result.fixes.find((f) => f.field === 'risk_tier');
      expect(fix).toBeDefined();
      expect(fix.value).toBe(3);
      expect(fix.description).toBeDefined();
      expect(fix.reason).toBeDefined();
    });

    it('should provide warnings for missing non-critical fields', () => {
      const spec = createValidSpec();
      spec.invariants = [];

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.warnings).toBeDefined();
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should apply auto-fixes when requested', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.risk_tier).toBe(3);
      expect(result.appliedFixes).toBeDefined();
      expect(result.appliedFixes.length).toBeGreaterThan(0);
    });

    it('should preview fixes in dry-run mode', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;
      const originalRiskTier = spec.risk_tier;

      const result = validateWorkingSpecWithSuggestions(spec, {
        autoFix: true,
        dryRun: true,
      });

      // Spec should not be modified in dry-run
      expect(spec.risk_tier).toBe(originalRiskTier);
      expect(result.dryRun).toBe(true);
      expect(result.fixes).toBeDefined();
    });

    it('should auto-fix missing mode field', () => {
      const spec = createValidSpec();
      delete spec.mode;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.mode).toBe('feature');
      expect(result.appliedFixes).toBeDefined();
      const fix = result.appliedFixes.find((f) => f.field === 'mode');
      expect(fix).toBeDefined();
      expect(fix.description).toContain('default mode');
    });

    it('should auto-fix missing scope.out', () => {
      const spec = createValidSpec();
      delete spec.scope.out;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.scope.out).toBeDefined();
      expect(Array.isArray(spec.scope.out)).toBe(true);
      expect(spec.scope.out).toContain('node_modules/');
    });

    it('should auto-fix missing blast_radius', () => {
      const spec = createValidSpec();
      delete spec.blast_radius;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.blast_radius).toBeDefined();
      expect(spec.blast_radius.modules).toBeDefined();
      expect(spec.blast_radius.data_migration).toBe(false);
    });

    it('should auto-fix missing non_functional', () => {
      const spec = createValidSpec();
      delete spec.non_functional;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.non_functional).toBeDefined();
      expect(spec.non_functional.a11y).toBeDefined();
      expect(spec.non_functional.perf).toBeDefined();
      expect(spec.non_functional.security).toBeDefined();
    });

    it('should auto-fix empty invariants array', () => {
      const spec = createValidSpec();
      spec.invariants = [];

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.invariants).toBeDefined();
      expect(spec.invariants.length).toBeGreaterThan(0);
      expect(spec.invariants[0]).toContain('operational');
    });

    it('should auto-fix empty acceptance array', () => {
      const spec = createValidSpec();
      spec.acceptance = [];

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.acceptance).toBeDefined();
      expect(spec.acceptance.length).toBeGreaterThan(0);
      expect(spec.acceptance[0].id).toBe('A1');
      expect(spec.acceptance[0].given).toBeDefined();
      expect(spec.acceptance[0].when).toBeDefined();
      expect(spec.acceptance[0].then).toBeDefined();
    });

    it('should auto-fix missing contracts', () => {
      const spec = createValidSpec();
      delete spec.contracts;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(spec.contracts).toBeDefined();
      expect(Array.isArray(spec.contracts)).toBe(true);
    });
  });

  describe('Tier-Specific Validation', () => {
    it('should require contracts for Tier 1', () => {
      const spec = createValidSpec();
      spec.risk_tier = 1;
      spec.contracts = [];

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/contracts')).toBe(true);
    });

    it('should require contracts for Tier 2', () => {
      const spec = createValidSpec();
      spec.risk_tier = 2;
      spec.contracts = [];

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/contracts')).toBe(true);
    });

    it('should allow empty contracts for Tier 3', () => {
      const spec = createValidSpec();
      spec.risk_tier = 3;
      spec.contracts = [];

      const result = validateWorkingSpecWithSuggestions(spec);

      // Should not fail on contracts
      const contractsError = result.errors?.find((e) => e.instancePath === '/contracts');
      expect(contractsError).toBeUndefined();
    });

    it('should require observability for Tier 1', () => {
      const spec = createValidSpec();
      spec.risk_tier = 1;
      delete spec.observability;

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/observability')).toBe(true);
    });

    it('should require rollback for Tier 1', () => {
      const spec = createValidSpec();
      spec.risk_tier = 1;
      delete spec.rollback;

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/rollback')).toBe(true);
    });

    it('should require security requirements for Tier 1', () => {
      const spec = createValidSpec();
      spec.risk_tier = 1;
      spec.non_functional.security = [];

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/non_functional/security')).toBe(true);
    });

    it('should not require observability for Tier 2', () => {
      const spec = createValidSpec();
      spec.risk_tier = 2;
      delete spec.observability;

      const result = validateWorkingSpecWithSuggestions(spec);

      // Should not fail on observability for Tier 2
      const obsError = result.errors?.find((e) => e.instancePath === '/observability');
      expect(obsError).toBeUndefined();
    });
  });

  describe('Waiver Validation', () => {
    it('should validate waiver ID format', () => {
      const spec = createValidSpec();
      spec.waiver_ids = ['INVALID'];

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/waiver_ids')).toBe(true);
    });

    it('should accept valid waiver IDs', () => {
      const spec = createValidSpec();
      spec.waiver_ids = ['WV-0001', 'WV-0002'];

      const result = validateWorkingSpecWithSuggestions(spec);

      // Should not fail on waiver IDs format
      const waiverError = result.errors?.find((e) => e.instancePath === '/waiver_ids');
      expect(waiverError).toBeUndefined();
    });

    it('should reject non-array waiver_ids', () => {
      const spec = createValidSpec();
      spec.waiver_ids = 'WV-0001';

      const result = validateWorkingSpecWithSuggestions(spec);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.instancePath === '/waiver_ids')).toBe(true);
    });
  });

  describe('Multiple Auto-Fixes', () => {
    it('should apply multiple fixes at once', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;
      delete spec.mode;
      delete spec.blast_radius;

      const result = validateWorkingSpecWithSuggestions(spec, { autoFix: true });

      expect(result.appliedFixes).toBeDefined();
      expect(result.appliedFixes.length).toBeGreaterThanOrEqual(3);
      expect(spec.risk_tier).toBe(3);
      expect(spec.mode).toBe('feature');
      expect(spec.blast_radius).toBeDefined();
    });

    it('should preview multiple fixes in dry-run', () => {
      const spec = createValidSpec();
      spec.risk_tier = 5;
      delete spec.mode;
      delete spec.blast_radius;

      const originalSpec = { ...spec };

      const result = validateWorkingSpecWithSuggestions(spec, {
        autoFix: true,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.fixes).toBeDefined();
      expect(result.fixes.length).toBeGreaterThanOrEqual(3);
      // Spec should remain unchanged
      expect(spec.risk_tier).toBe(originalSpec.risk_tier);
    });
  });
});

