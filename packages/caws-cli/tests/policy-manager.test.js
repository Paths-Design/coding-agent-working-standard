/**
 * @fileoverview Tests for PolicyManager - Policy loading with caching
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const os = require('os');
const { PolicyManager } = require('../src/policy/PolicyManager');

describe('PolicyManager', () => {
  let tempDir;
  let policyManager;

  beforeEach(async () => {
    // Create temp directory for tests
    tempDir = path.join(os.tmpdir(), `caws-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    // Create .caws directory
    await fs.mkdir(path.join(tempDir, '.caws'), { recursive: true });

    policyManager = new PolicyManager({
      enableCaching: true,
      cacheTTL: 100, // Short TTL for tests (100ms)
    });
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
    policyManager.clearCache();
  });

  describe('loadPolicy', () => {
    test('should load policy from file', async () => {
      const testPolicy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      const result = await policyManager.loadPolicy(tempDir);

      expect(result.version).toBe(1);
      expect(result.risk_tiers[1].max_files).toBe(10);
      expect(result._cacheHit).toBe(false);
    });

    test('should use cache on second load', async () => {
      const testPolicy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      // First load
      const result1 = await policyManager.loadPolicy(tempDir);
      expect(result1._cacheHit).toBe(false);

      // Second load (cached)
      const result2 = await policyManager.loadPolicy(tempDir);
      expect(result2._cacheHit).toBe(true);
      expect(result2.version).toBe(1);
    });

    test('should cache expire after TTL', async () => {
      const testPolicy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      // First load
      const result1 = await policyManager.loadPolicy(tempDir);
      expect(result1._cacheHit).toBe(false);

      // Wait for cache to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should reload from file
      const result2 = await policyManager.loadPolicy(tempDir);
      expect(result2._cacheHit).toBe(false);
    });

    test('should return default policy when file missing', async () => {
      const result = await policyManager.loadPolicy(tempDir);

      expect(result.version).toBe(1);
      expect(result.risk_tiers[1].max_files).toBe(25);
      expect(result._isDefault).toBe(true);
    });

    test('should throw on invalid policy', async () => {
      const invalidPolicy = {
        version: 1,
        // Missing risk_tiers
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(invalidPolicy));

      await expect(policyManager.loadPolicy(tempDir)).rejects.toThrow(
        'Policy missing risk_tiers configuration'
      );
    });
  });

  describe('applyWaivers', () => {
    beforeEach(async () => {
      // Create waivers directory
      await fs.mkdir(path.join(tempDir, '.caws', 'waivers'), { recursive: true });
    });

    test('should apply valid waiver delta', async () => {
      const waiver = {
        id: 'WV-0001',
        title: 'Test Waiver',
        reason: 'test',
        status: 'active',
        gates: ['budget_limit'],
        expires_at: new Date(Date.now() + 86400000).toISOString(), // +1 day
        approvers: ['test@example.com'],
        delta: {
          max_files: 10,
          max_loc: 500,
        },
      };

      const waiverPath = path.join(tempDir, '.caws', 'waivers', 'WV-0001.yaml');
      await fs.writeFile(waiverPath, yaml.dump(waiver));

      const baseline = { max_files: 50, max_loc: 2000 };
      const result = await policyManager.applyWaivers(baseline, ['WV-0001'], tempDir);

      expect(result.effective.max_files).toBe(60); // 50 + 10
      expect(result.effective.max_loc).toBe(2500); // 2000 + 500
      expect(result.applied).toContain('WV-0001');
    });

    test('should ignore expired waivers', async () => {
      const waiver = {
        id: 'WV-0002',
        title: 'Expired Waiver',
        reason: 'test',
        status: 'active',
        gates: ['budget_limit'],
        expires_at: new Date(Date.now() - 86400000).toISOString(), // -1 day (expired)
        approvers: ['test@example.com'],
        delta: {
          max_files: 10,
          max_loc: 500,
        },
      };

      const waiverPath = path.join(tempDir, '.caws', 'waivers', 'WV-0002.yaml');
      await fs.writeFile(waiverPath, yaml.dump(waiver));

      const baseline = { max_files: 50, max_loc: 2000 };
      const result = await policyManager.applyWaivers(baseline, ['WV-0002'], tempDir);

      expect(result.effective.max_files).toBe(50); // No change
      expect(result.effective.max_loc).toBe(2000); // No change
      expect(result.applied).toHaveLength(0);
    });

    test('should ignore inactive waivers', async () => {
      const waiver = {
        id: 'WV-0003',
        title: 'Revoked Waiver',
        reason: 'test',
        status: 'revoked',
        gates: ['budget_limit'],
        expires_at: new Date(Date.now() + 86400000).toISOString(),
        approvers: ['test@example.com'],
        delta: {
          max_files: 10,
          max_loc: 500,
        },
      };

      const waiverPath = path.join(tempDir, '.caws', 'waivers', 'WV-0003.yaml');
      await fs.writeFile(waiverPath, yaml.dump(waiver));

      const baseline = { max_files: 50, max_loc: 2000 };
      const result = await policyManager.applyWaivers(baseline, ['WV-0003'], tempDir);

      expect(result.effective.max_files).toBe(50); // No change
      expect(result.effective.max_loc).toBe(2000); // No change
      expect(result.applied).toHaveLength(0);
    });

    test('should handle missing waiver files', async () => {
      const baseline = { max_files: 50, max_loc: 2000 };
      const result = await policyManager.applyWaivers(baseline, ['WV-9999'], tempDir);

      expect(result.effective.max_files).toBe(50);
      expect(result.effective.max_loc).toBe(2000);
      expect(result.applied).toHaveLength(0);
    });
  });

  describe('validatePolicy', () => {
    test('should validate correct policy', () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      expect(() => policyManager.validatePolicy(policy)).not.toThrow();
    });

    test('should reject policy without version', () => {
      const policy = {
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
        },
      };

      expect(() => policyManager.validatePolicy(policy)).toThrow('Policy missing version field');
    });

    test('should reject policy without risk_tiers', () => {
      const policy = {
        version: 1,
      };

      expect(() => policyManager.validatePolicy(policy)).toThrow(
        'Policy missing risk_tiers configuration'
      );
    });

    test('should reject policy with missing tier', () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          // Missing tier 3
        },
      };

      expect(() => policyManager.validatePolicy(policy)).toThrow(
        'Policy missing risk tier 3 configuration'
      );
    });

    test('should reject policy with invalid budget limits', () => {
      const policy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10 }, // Missing max_loc
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      expect(() => policyManager.validatePolicy(policy)).toThrow(
        'Risk tier 1 missing or invalid budget limits'
      );
    });
  });

  describe('cache management', () => {
    test('should clear cache for specific project', async () => {
      const testPolicy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      // Load and cache
      await policyManager.loadPolicy(tempDir);

      let status = policyManager.getCacheStatus(tempDir);
      expect(status.cached).toBe(true);

      // Clear cache
      policyManager.clearCache(tempDir);

      status = policyManager.getCacheStatus(tempDir);
      expect(status.cached).toBe(false);
    });

    test('should reload policy bypassing cache', async () => {
      const testPolicy = {
        version: 1,
        risk_tiers: {
          1: { max_files: 10, max_loc: 250 },
          2: { max_files: 50, max_loc: 2000 },
          3: { max_files: 100, max_loc: 5000 },
        },
      };

      const policyPath = path.join(tempDir, '.caws', 'policy.yaml');
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      // Load and cache
      await policyManager.loadPolicy(tempDir);

      // Modify file
      testPolicy.version = 2;
      await fs.writeFile(policyPath, yaml.dump(testPolicy));

      // Reload (bypasses cache)
      const result = await policyManager.reloadPolicy(tempDir);
      expect(result.version).toBe(2);
    });

    test('should get cache stats', async () => {
      const stats = policyManager.getCacheStats();
      expect(stats.totalCached).toBe(0);
      expect(stats.validCaches).toBe(0);
      expect(stats.expiredCaches).toBe(0);
    });
  });

  describe('getDefaultPolicy', () => {
    test('should return valid default policy', () => {
      const defaultPolicy = policyManager.getDefaultPolicy();

      expect(defaultPolicy.version).toBe(1);
      expect(defaultPolicy.risk_tiers[1].max_files).toBe(25);
      expect(defaultPolicy.risk_tiers[1].max_loc).toBe(1000);
      expect(defaultPolicy.risk_tiers[2].max_files).toBe(50);
      expect(defaultPolicy.risk_tiers[2].max_loc).toBe(2000);
      expect(defaultPolicy.risk_tiers[3].max_files).toBe(100);
      expect(defaultPolicy.risk_tiers[3].max_loc).toBe(5000);
      expect(defaultPolicy.edit_rules.policy_and_code_same_pr).toBe(false);
    });
  });
});
