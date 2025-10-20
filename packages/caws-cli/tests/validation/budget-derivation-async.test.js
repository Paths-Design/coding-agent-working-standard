/**
 * @fileoverview Async Budget Derivation Tests
 * Updated to work with PolicyManager's async loading
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const {
  deriveBudget,
  checkBudgetCompliance,
  calculateBudgetUtilization,
  isApproachingBudgetLimit,
} = require('../../src/budget-derivation');

describe('Budget Derivation (Async)', () => {
  let tempDir;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = path.join(os.tmpdir(), `caws-budget-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });
  });

  afterEach(async () => {
    // Ensure we're not in the temp directory before deleting it
    try {
      const cwd = process.cwd();
      if (cwd.startsWith(tempDir)) {
        process.chdir(__dirname);
      }
    } catch (e) {
      // Can't get cwd, try to change anyway
      try {
        process.chdir(__dirname);
      } catch (e2) {
        // Continue with cleanup
      }
    }

    // Cleanup
    await fs.remove(tempDir);
  });

  const createMockPolicy = () => ({
    version: 1,
    risk_tiers: {
      1: {
        max_files: 25,
        max_loc: 1000,
        coverage_threshold: 90,
        mutation_threshold: 70,
      },
      2: {
        max_files: 50,
        max_loc: 2000,
        coverage_threshold: 80,
        mutation_threshold: 50,
      },
      3: {
        max_files: 100,
        max_loc: 5000,
        coverage_threshold: 70,
        mutation_threshold: 30,
      },
    },
    waiver_approval: {
      required_approvers: 1,
      max_duration_days: 90,
    },
  });

  const createValidSpec = (tier) => ({
    id: 'TEST-001',
    title: 'Test Spec',
    risk_tier: tier,
    scope: {
      in: ['src/'],
      out: ['tests/'],
    },
  });

  const createMockWaiver = (id, overrides = {}) => ({
    id,
    title: 'Test Waiver',
    reason: 'test',
    status: 'active',
    gates: ['budget_limit'],
    expires_at: new Date(Date.now() + 86400000).toISOString(), // +1 day
    approvers: ['test@example.com'],
    delta: {
      max_files: overrides.max_files || 0,
      max_loc: overrides.max_loc || 0,
    },
    ...overrides,
  });

  describe('deriveBudget', () => {
    test('should derive budget from policy for Tier 1', async () => {
      const spec = createValidSpec(1);
      const policy = createMockPolicy();

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.baseline.max_files).toBe(25);
      expect(budget.baseline.max_loc).toBe(1000);
      expect(budget.effective.max_files).toBe(25);
      expect(budget.effective.max_loc).toBe(1000);
      expect(budget.waivers_applied).toEqual([]);
    });

    test('should derive budget from policy for Tier 2', async () => {
      const spec = createValidSpec(2);
      const policy = createMockPolicy();

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.baseline.max_files).toBe(50);
      expect(budget.baseline.max_loc).toBe(2000);
    });

    test('should derive budget from policy for Tier 3', async () => {
      const spec = createValidSpec(3);
      const policy = createMockPolicy();

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.baseline.max_files).toBe(100);
      expect(budget.baseline.max_loc).toBe(5000);
    });

    test('should use default policy when policy.yaml not found', async () => {
      const spec = createValidSpec(2);

      // Don't create policy.yaml - should use default

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.baseline.max_files).toBe(50);
      expect(budget.baseline.max_loc).toBe(2000);
    });

    test('should apply single waiver delta to budget', async () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const waiver = createMockWaiver('WV-0001', {
        max_files: 10,
        max_loc: 500,
      });

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'), yaml.dump(waiver));

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.baseline.max_files).toBe(50);
      expect(budget.baseline.max_loc).toBe(2000);
      expect(budget.effective.max_files).toBe(60); // 50 + 10
      expect(budget.effective.max_loc).toBe(2500); // 2000 + 500
      expect(budget.waivers_applied).toContain('WV-0001');
    });

    test('should apply multiple waivers cumulatively', async () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001', 'WV-0002'];
      const policy = createMockPolicy();
      const waiver1 = createMockWaiver('WV-0001', {
        max_files: 10,
        max_loc: 500,
      });
      const waiver2 = createMockWaiver('WV-0002', {
        max_files: 5,
        max_loc: 200,
      });

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'),
        yaml.dump(waiver1)
      );
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', 'WV-0002.yaml'),
        yaml.dump(waiver2)
      );

      const budget = await deriveBudget(spec, tempDir);

      expect(budget.effective.max_files).toBe(65); // 50 + 10 + 5
      expect(budget.effective.max_loc).toBe(2700); // 2000 + 500 + 200
      expect(budget.waivers_applied).toContain('WV-0001');
      expect(budget.waivers_applied).toContain('WV-0002');
    });

    test('should ignore expired waivers', async () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const expiredWaiver = createMockWaiver('WV-0001', {
        expires_at: '2020-01-01T00:00:00Z', // Expired
        max_files: 10,
        max_loc: 500,
      });

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'),
        yaml.dump(expiredWaiver)
      );

      const budget = await deriveBudget(spec, tempDir);

      // Waiver should not be applied
      expect(budget.effective.max_files).toBe(50);
      expect(budget.effective.max_loc).toBe(2000);
    });

    test('should ignore revoked waivers', async () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const revokedWaiver = createMockWaiver('WV-0001', {
        status: 'revoked',
        max_files: 10,
        max_loc: 500,
      });

      await fs.writeFile(path.join(tempDir, '.caws', 'policy.yaml'), yaml.dump(policy));
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml'),
        yaml.dump(revokedWaiver)
      );

      const budget = await deriveBudget(spec, tempDir);

      // Waiver should not be applied
      expect(budget.effective.max_files).toBe(50);
      expect(budget.effective.max_loc).toBe(2000);
    });

    test('should throw error for invalid risk tier', async () => {
      const spec = createValidSpec(5); // Invalid tier

      await expect(deriveBudget(spec, tempDir)).rejects.toThrow('Risk tier 5 not defined');
    });
  });

  describe('checkBudgetCompliance', () => {
    test('should pass when within budget', () => {
      const budget = {
        baseline: { max_files: 50, max_loc: 2000 },
        effective: { max_files: 50, max_loc: 2000 },
        waivers_applied: [],
      };

      const stats = {
        files_changed: 25,
        lines_changed: 1000,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    test('should fail when files exceed budget', () => {
      const budget = {
        baseline: { max_files: 50, max_loc: 2000 },
        effective: { max_files: 50, max_loc: 2000 },
        waivers_applied: [],
      };

      const stats = {
        files_changed: 75, // Exceeds
        lines_changed: 1000,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe('max_files');
    });

    test('should fail when LOC exceeds budget', () => {
      const budget = {
        baseline: { max_files: 50, max_loc: 2000 },
        effective: { max_files: 50, max_loc: 2000 },
        waivers_applied: [],
      };

      const stats = {
        files_changed: 25,
        lines_changed: 3000, // Exceeds
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].type).toBe('max_loc');
    });
  });

  describe('calculateBudgetUtilization', () => {
    test('should calculate utilization percentages', () => {
      const budgetCompliance = {
        budget: {
          baseline: { max_files: 50, max_loc: 2000 },
          effective: { max_files: 50, max_loc: 2000 },
        },
      };

      const utilization = calculateBudgetUtilization(budgetCompliance);

      expect(utilization.files).toBe(100);
      expect(utilization.loc).toBe(100);
      expect(utilization.overall).toBe(100);
    });
  });

  describe('isApproachingBudgetLimit', () => {
    test('should return true when approaching limit', () => {
      const budgetCompliance = {
        budget: {
          baseline: { max_files: 50, max_loc: 2000 },
          effective: { max_files: 50, max_loc: 2000 },
        },
      };

      const result = isApproachingBudgetLimit(budgetCompliance, 80);

      expect(result).toBe(true);
    });

    test('should return false when not approaching limit', () => {
      const budgetCompliance = {
        budget: {
          baseline: { max_files: 40, max_loc: 1600 }, // 40% of effective
          effective: { max_files: 100, max_loc: 5000 },
        },
      };

      const result = isApproachingBudgetLimit(budgetCompliance, 80);

      expect(result).toBe(false);
    });
  });
});
