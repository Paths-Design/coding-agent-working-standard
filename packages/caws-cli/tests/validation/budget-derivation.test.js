/**
 * @fileoverview Comprehensive Tests for Budget Derivation
 * Tests budget calculation, waiver application, and compliance checking
 * Ported from agent-agency TypeScript implementation
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const {
  deriveBudget,
  loadWaiver,
  isWaiverValid,
  checkBudgetCompliance,
  calculateBudgetUtilization,
  isApproachingBudgetLimit,
} = require('../../src/budget-derivation');

// Mock fs-extra for controlled testing
jest.mock('fs-extra');

describe('Budget Derivation', () => {
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

  const createMockWaiver = (id, delta = {}) => ({
    id,
    title: `Test Waiver ${id}`,
    reason: 'emergency_hotfix',
    status: 'active',
    gates: ['budget_limit'],
    expires_at: '2025-12-31T23:59:59Z',
    approvers: ['approver@test.com'],
    impact_level: 'medium',
    mitigation_plan: 'Monitored carefully',
    delta,
    created_at: '2025-01-01T00:00:00Z',
    created_by: 'test@test.com',
  });

  const createValidSpec = (tier) => ({
    id: 'FEAT-001',
    title: 'Test Feature',
    risk_tier: tier,
    mode: 'feature',
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('deriveBudget', () => {
    it('should derive budget from policy for Tier 1', () => {
      const spec = createValidSpec(1);
      const policy = createMockPolicy();
      const policyPath = '/test/.caws/policy.yaml';

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(yaml.dump(policy));

      const budget = deriveBudget(spec, '/test');

      expect(budget.baseline.max_files).toBe(25);
      expect(budget.baseline.max_loc).toBe(1000);
      expect(budget.effective.max_files).toBe(25);
      expect(budget.effective.max_loc).toBe(1000);
      expect(budget.waivers_applied).toEqual([]);
    });

    it('should derive budget from policy for Tier 2', () => {
      const spec = createValidSpec(2);
      const policy = createMockPolicy();

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(yaml.dump(policy));

      const budget = deriveBudget(spec, '/test');

      expect(budget.baseline.max_files).toBe(50);
      expect(budget.baseline.max_loc).toBe(2000);
    });

    it('should derive budget from policy for Tier 3', () => {
      const spec = createValidSpec(3);
      const policy = createMockPolicy();

      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(yaml.dump(policy));

      const budget = deriveBudget(spec, '/test');

      expect(budget.baseline.max_files).toBe(100);
      expect(budget.baseline.max_loc).toBe(5000);
    });

    it('should apply single waiver delta to budget', () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const waiver = createMockWaiver('WV-0001', {
        max_files: 10,
        max_loc: 500,
      });

      fs.existsSync.mockImplementation((path) => {
        return true;
      });
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('policy.yaml')) {
          return yaml.dump(policy);
        }
        return yaml.dump(waiver);
      });

      const budget = deriveBudget(spec, '/test');

      expect(budget.baseline.max_files).toBe(50);
      expect(budget.baseline.max_loc).toBe(2000);
      expect(budget.effective.max_files).toBe(60); // 50 + 10
      expect(budget.effective.max_loc).toBe(2500); // 2000 + 500
      expect(budget.waivers_applied).toContain('WV-0001');
    });

    it('should apply multiple waivers cumulatively', () => {
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

      fs.existsSync.mockImplementation((path) => true);
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('policy.yaml')) {
          return yaml.dump(policy);
        }
        if (path.includes('WV-0001')) {
          return yaml.dump(waiver1);
        }
        if (path.includes('WV-0002')) {
          return yaml.dump(waiver2);
        }
      });

      const budget = deriveBudget(spec, '/test');

      expect(budget.effective.max_files).toBe(65); // 50 + 10 + 5
      expect(budget.effective.max_loc).toBe(2700); // 2000 + 500 + 200
    });

    it('should ignore expired waivers', () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const waiver = createMockWaiver('WV-0001', {
        max_files: 10,
        max_loc: 500,
      });
      waiver.expires_at = '2020-01-01T00:00:00Z'; // Expired

      fs.existsSync.mockImplementation((path) => true);
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('policy.yaml')) {
          return yaml.dump(policy);
        }
        return yaml.dump(waiver);
      });

      const budget = deriveBudget(spec, '/test');

      // Waiver should not be applied
      expect(budget.effective.max_files).toBe(50);
      expect(budget.effective.max_loc).toBe(2000);
    });

    it('should ignore inactive waivers', () => {
      const spec = createValidSpec(2);
      spec.waiver_ids = ['WV-0001'];
      const policy = createMockPolicy();
      const waiver = createMockWaiver('WV-0001', {
        max_files: 10,
        max_loc: 500,
      });
      waiver.status = 'revoked';

      fs.existsSync.mockImplementation((path) => true);
      fs.readFileSync.mockImplementation((path) => {
        if (path.includes('policy.yaml')) {
          return yaml.dump(policy);
        }
        return yaml.dump(waiver);
      });

      const budget = deriveBudget(spec, '/test');

      // Waiver should not be applied
      expect(budget.effective.max_files).toBe(50);
    });

    it('should throw error if policy file is missing', () => {
      const spec = createValidSpec(2);
      fs.existsSync.mockReturnValue(false);

      expect(() => deriveBudget(spec, '/test')).toThrow('Policy file not found');
    });

    it('should throw error if risk tier not defined in policy', () => {
      const spec = createValidSpec(5);
      const policy = createMockPolicy();
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(yaml.dump(policy));

      expect(() => deriveBudget(spec, '/test')).toThrow('Risk tier 5 not defined');
    });
  });

  describe('isWaiverValid', () => {
    const policy = createMockPolicy();

    it('should accept active waiver with valid expiry', () => {
      const waiver = createMockWaiver('WV-0001');
      expect(isWaiverValid(waiver, policy)).toBe(true);
    });

    it('should reject expired waiver', () => {
      const waiver = createMockWaiver('WV-0001');
      waiver.expires_at = '2020-01-01T00:00:00Z';
      expect(isWaiverValid(waiver, policy)).toBe(false);
    });

    it('should reject inactive waiver', () => {
      const waiver = createMockWaiver('WV-0001');
      waiver.status = 'revoked';
      expect(isWaiverValid(waiver, policy)).toBe(false);
    });

    it('should reject waiver without approvers', () => {
      const waiver = createMockWaiver('WV-0001');
      waiver.approvers = [];
      expect(isWaiverValid(waiver, policy)).toBe(false);
    });

    it('should reject waiver with insufficient approvers', () => {
      const waiver = createMockWaiver('WV-0001');
      const strictPolicy = { ...policy, waiver_approval: { required_approvers: 2 } };
      expect(isWaiverValid(waiver, strictPolicy)).toBe(false);
    });

    it('should accept waiver with sufficient approvers', () => {
      const waiver = createMockWaiver('WV-0001');
      waiver.approvers = ['approver1@test.com', 'approver2@test.com'];
      const strictPolicy = { ...policy, waiver_approval: { required_approvers: 2 } };
      expect(isWaiverValid(waiver, strictPolicy)).toBe(true);
    });

    it('should reject waiver without required fields', () => {
      const waiver = createMockWaiver('WV-0001');
      delete waiver.id;
      expect(isWaiverValid(waiver, policy)).toBe(false);
    });
  });

  describe('checkBudgetCompliance', () => {
    const createBudget = () => ({
      baseline: { max_files: 50, max_loc: 2000 },
      effective: { max_files: 60, max_loc: 2500 },
      waivers_applied: ['WV-0001'],
      derived_at: new Date().toISOString(),
    });

    it('should pass when under budget', () => {
      const budget = createBudget();
      const stats = {
        files_changed: 30,
        lines_changed: 1000,
        risk_tier: 2,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('should fail when files exceed budget', () => {
      const budget = createBudget();
      const stats = {
        files_changed: 70,
        lines_changed: 1000,
        risk_tier: 2,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].type).toBe('max_files');
    });

    it('should fail when LOC exceeds budget', () => {
      const budget = createBudget();
      const stats = {
        files_changed: 30,
        lines_changed: 3000,
        risk_tier: 2,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].type).toBe('max_loc');
    });

    it('should report multiple violations', () => {
      const budget = createBudget();
      const stats = {
        files_changed: 70,
        lines_changed: 3000,
        risk_tier: 2,
      };

      const result = checkBudgetCompliance(budget, stats);

      expect(result.compliant).toBe(false);
      expect(result.violations.length).toBe(2);
      expect(result.violations.some((v) => v.type === 'max_files')).toBe(true);
      expect(result.violations.some((v) => v.type === 'max_loc')).toBe(true);
    });

    it('should include violation details', () => {
      const budget = createBudget();
      const stats = {
        files_changed: 70,
        lines_changed: 1000,
        risk_tier: 2,
      };

      const result = checkBudgetCompliance(budget, stats);

      const violation = result.violations[0];
      expect(violation.current).toBe(70);
      expect(violation.limit).toBe(60);
      expect(violation.baseline).toBe(50);
      expect(violation.message).toBeDefined();
    });
  });

  describe('calculateBudgetUtilization', () => {
    it('should calculate utilization percentages', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 50, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      const utilization = calculateBudgetUtilization(compliance);

      expect(utilization.files).toBe(50); // 50/100 = 50%
      expect(utilization.loc).toBe(50); // 2000/4000 = 50%
      expect(utilization.overall).toBe(50);
    });

    it('should handle 100% utilization', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 100, max_loc: 4000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      const utilization = calculateBudgetUtilization(compliance);

      expect(utilization.files).toBe(100);
      expect(utilization.loc).toBe(100);
      expect(utilization.overall).toBe(100);
    });

    it('should use overall as max of files and loc', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 80, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      const utilization = calculateBudgetUtilization(compliance);

      expect(utilization.files).toBe(80); // 80/100
      expect(utilization.loc).toBe(50); // 2000/4000
      expect(utilization.overall).toBe(80); // max(80, 50)
    });

    it('should handle zero effective budget', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 0, max_loc: 0 },
          effective: { max_files: 0, max_loc: 0 },
        },
      };

      const utilization = calculateBudgetUtilization(compliance);

      expect(utilization.files).toBe(0);
      expect(utilization.loc).toBe(0);
    });
  });

  describe('isApproachingBudgetLimit', () => {
    it('should detect budget approaching at 80%', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 80, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      expect(isApproachingBudgetLimit(compliance, 80)).toBe(true);
    });

    it('should detect budget approaching at 90%', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 90, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      expect(isApproachingBudgetLimit(compliance, 90)).toBe(true);
    });

    it('should not detect if below threshold', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 50, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      expect(isApproachingBudgetLimit(compliance, 80)).toBe(false);
    });

    it('should use custom threshold', () => {
      const compliance = {
        budget: {
          baseline: { max_files: 70, max_loc: 2000 },
          effective: { max_files: 100, max_loc: 4000 },
        },
      };

      expect(isApproachingBudgetLimit(compliance, 70)).toBe(true);
      expect(isApproachingBudgetLimit(compliance, 75)).toBe(false);
    });
  });
});

