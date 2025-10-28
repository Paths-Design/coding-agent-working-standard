/**
 * @fileoverview Tests for Migration Tools
 * Tests the legacy to multi-spec migration functionality
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('js-yaml');

// Don't mock the specs module - we want to test the real functions

describe('Migration Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock process.exit
    jest.spyOn(process, 'exit').mockImplementation(() => {});

    // No need to clear mocks for createSpec since we're testing the real function
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('suggestFeatureBreakdown', () => {
    test('should suggest features based on acceptance criteria keywords', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        acceptance: [
          {
            id: 'A1',
            given: 'User provides valid login credentials',
            when: 'Login is attempted',
            then: 'User is authenticated',
          },
          {
            id: 'A2',
            given: 'User selects payment method',
            when: 'Payment is processed',
            then: 'Payment is completed successfully',
          },
          {
            id: 'A3',
            given: 'Admin views dashboard',
            when: 'Dashboard loads',
            then: 'Metrics and insights are displayed',
          },
        ],
      };

      const features = suggestFeatureBreakdown(legacySpec);

      expect(features).toHaveLength(3);

      // Should identify auth feature
      const authFeature = features.find((f) => f.id === 'auth');
      expect(authFeature).toBeDefined();
      expect(authFeature.title).toBe('Authentication');
      expect(authFeature.criteria).toHaveLength(1);
      expect(authFeature.scope.in).toEqual(['src/auth/', 'tests/auth/']);

      // Should identify payment feature
      const paymentFeature = features.find((f) => f.id === 'payment');
      expect(paymentFeature).toBeDefined();
      expect(paymentFeature.title).toBe('Payment System');
      expect(paymentFeature.criteria).toHaveLength(1);

      // Should identify dashboard feature
      const dashboardFeature = features.find((f) => f.id === 'dashboard');
      expect(dashboardFeature).toBeDefined();
      expect(dashboardFeature.title).toBe('Dashboard');
      expect(dashboardFeature.criteria).toHaveLength(1);
    });

    test('should handle empty acceptance criteria', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        acceptance: [],
        title: 'Empty Spec',
      };

      const features = suggestFeatureBreakdown(legacySpec);

      expect(features).toHaveLength(1);
      expect(features[0].id).toBe('main-feature');
      expect(features[0].title).toBe('Empty Spec');
    });

    test('should handle spec without acceptance criteria', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        title: 'No Criteria Spec',
      };

      const features = suggestFeatureBreakdown(legacySpec);

      expect(features).toHaveLength(1);
      expect(features[0].id).toBe('main-feature');
      expect(features[0].title).toBe('No Criteria Spec');
    });

    test('should handle criteria without recognizable keywords', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        acceptance: [
          {
            id: 'A1',
            given: 'Generic condition',
            when: 'Generic action',
            then: 'Generic result',
          },
        ],
      };

      const features = suggestFeatureBreakdown(legacySpec);

      expect(features).toHaveLength(1);
      expect(features[0].id).toBe('general');
      expect(features[0].title).toBe('General Features');
    });
  });

  describe('migrateFromLegacy', () => {
    test('should handle migration command', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock legacy spec
      const legacySpec = {
        id: 'PROJ-001',
        title: 'Legacy Project',
        acceptance: [
          {
            id: 'A1',
            given: 'User authenticates with login',
            when: 'Login is attempted',
            then: 'User is authenticated',
          },
        ],
      };

      fs.pathExists.mockResolvedValue(true);
      require('js-yaml').load = jest.fn().mockReturnValue(legacySpec);

      // Mock spec creation
      require('../src/commands/specs').createSpec = jest.fn().mockResolvedValue({
        id: 'auth',
        title: 'Authentication',
        status: 'draft',
      });

      const result = await specsCommand('migrate', {});

      expect(result).toBeDefined();
      expect(result.command).toBe('specs migrate');
    });

    test('should handle missing legacy spec', async () => {
      const { specsCommand } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false);

      // Should throw for missing legacy spec
      await expect(specsCommand('migrate', {})).rejects.toThrow(
        'No legacy working-spec.yaml found to migrate'
      );
    });

    test('should handle selective feature migration', async () => {
      const { specsCommand } = require('../src/commands/specs');

      const legacySpec = {
        id: 'PROJ-001',
        acceptance: [
          {
            id: 'A1',
            given: 'User authentication',
            when: 'Login attempted',
            then: 'User logged in',
          },
          {
            id: 'A2',
            given: 'Payment processing',
            when: 'Payment submitted',
            then: 'Payment completed',
          },
        ],
      };

      // Mock fs.pathExists to return true for legacy spec, false for new specs
      fs.pathExists.mockImplementation((filePath) => {
        if (filePath.includes('working-spec.yaml')) {
          return Promise.resolve(true);
        }
        // Return false for spec files to allow creation
        return Promise.resolve(false);
      });
      fs.readFile.mockResolvedValue('id: PROJ-001\nacceptance: []');
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);
      require('js-yaml').load = jest.fn().mockReturnValue(legacySpec);

      const result = await specsCommand('migrate', { features: ['auth'] });

      expect(result.migrated).toBe(1);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should handle migration creation failures', async () => {
      const { specsCommand } = require('../src/commands/specs');

      const legacySpec = {
        id: 'PROJ-001',
        acceptance: [
          {
            id: 'A1',
            given: 'Authentication',
            when: 'Login',
            then: 'Success',
          },
        ],
      };

      fs.pathExists.mockResolvedValue(true);
      require('js-yaml').load = jest.fn().mockReturnValue(legacySpec);

      // Mock creation failure
      require('../src/commands/specs').createSpec = jest
        .fn()
        .mockRejectedValue(new Error('Creation failed'));

      const result = await specsCommand('migrate', {});

      expect(result.migrated).toBe(0);
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Failed to create spec'));
    });
  });

  describe('Migration Command Integration', () => {
    test('should pass options to migration function', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock fs.pathExists to return true for legacy spec, false for new specs
      fs.pathExists.mockImplementation((filePath) => {
        if (filePath.includes('working-spec.yaml')) {
          return Promise.resolve(true);
        }
        // Return false for spec files to allow creation
        return Promise.resolve(false);
      });
      fs.readFile.mockResolvedValue('id: PROJ-001\nacceptance: []');
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const mockLegacySpec = {
        id: 'PROJ-001',
        acceptance: [
          {
            id: 'A1',
            given: 'User authentication test',
            when: 'User logs in',
            then: 'User is authenticated',
          },
        ],
      };

      require('js-yaml').load = jest.fn().mockReturnValue(mockLegacySpec);

      const result = await specsCommand('migrate', {
        interactive: true,
        features: ['auth'],
      });

      expect(result.migrated).toBe(1);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should handle unknown migration options', async () => {
      const { specsCommand } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false);

      // This should throw for missing legacy spec, not handle unknown options
      await expect(specsCommand('migrate', { unknownOption: true })).rejects.toThrow(
        'No legacy working-spec.yaml found to migrate'
      );
    });
  });

  describe('Feature Detection Logic', () => {
    test('should detect multiple features from keywords', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        acceptance: [
          { id: 'A1', given: 'User logs in with credentials', when: 'Login', then: 'Success' },
          { id: 'A2', given: 'User makes payment', when: 'Payment', then: 'Success' },
          { id: 'A3', given: 'Admin views dashboard', when: 'Dashboard', then: 'Success' },
          { id: 'A4', given: 'User registers account', when: 'Registration', then: 'Success' },
        ],
      };

      const features = suggestFeatureBreakdown(legacySpec);

      // Should find multiple distinct features
      const featureIds = features.map((f) => f.id);
      expect(featureIds).toContain('login'); // "login" keyword maps to "login" ID
      expect(featureIds).toContain('payment');
      expect(featureIds).toContain('dashboard');
    });

    test('should assign correct scopes to detected features', () => {
      const { suggestFeatureBreakdown } = require('../src/utils/spec-resolver');

      const legacySpec = {
        acceptance: [{ id: 'A1', given: 'Authentication works', when: 'Login', then: 'Success' }],
      };

      const features = suggestFeatureBreakdown(legacySpec);

      expect(features[0].scope.in).toEqual(['src/auth/', 'tests/auth/']);
      expect(features[0].scope.out).toEqual(['src/payments/', 'src/admin/']);
    });
  });
});
