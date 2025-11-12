/**
 * @fileoverview Tests for Migration Tools
 * Tests the legacy to multi-spec migration functionality
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');

// Mock js-yaml but delegate to real implementation for dump/load
// Note: We need to ensure load works correctly for migration tests
jest.mock('js-yaml', () => {
  const actualYaml = jest.requireActual('js-yaml');
  return {
    ...actualYaml,
    dump: jest.fn((...args) => actualYaml.dump(...args)),
    load: jest.fn((...args) => {
      const result = actualYaml.load(...args);
      // If load returns null/undefined, it means the YAML is invalid or empty
      // This helps us catch mock issues in tests
      return result;
    }),
  };
});

// Don't mock the specs module - we want to test the real functions

describe('Migration Tools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetAllMocks();

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock process.exit
    jest.spyOn(process, 'exit').mockImplementation(() => {});

    // Reset fs mocks to default implementations
    fs.pathExists.mockResolvedValue(false);
    // Reset readFile mock - each test will set up its own implementation
    // Use mockReset to clear previous implementations but keep the mock structure
    fs.readFile.mockReset();
    fs.writeFile.mockResolvedValue(undefined);
    fs.ensureDir.mockResolvedValue(undefined);
    fs.readdir.mockResolvedValue([]);
    fs.remove.mockResolvedValue(undefined);

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
      const yaml = require('js-yaml');

      // Legacy spec with multiple features (auth and payment)
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

      // Convert to YAML string
      const legacySpecYaml = yaml.dump(legacySpec);

      // Mock fs.pathExists - return true for legacy spec
      fs.pathExists.mockImplementation((filePath) => {
        return Promise.resolve(String(filePath).includes('working-spec.yaml'));
      });

      // Mock fs.readFile - simple: if path contains 'working-spec.yaml', return YAML
      fs.readFile.mockImplementation(async (filePath, encoding) => {
        if (String(filePath).includes('working-spec.yaml')) {
          return legacySpecYaml;
        }
        if (String(filePath).includes('registry.json')) {
          return JSON.stringify({
            version: '1.0.0',
            specs: {},
            lastUpdated: new Date().toISOString(),
          });
        }
        return '';
      });

      // Mock fs.writeFile and fs.ensureDir
      fs.writeFile.mockResolvedValue(undefined);
      fs.ensureDir.mockResolvedValue(undefined);

      // Mock createSpec to track what gets created
      const createdSpecs = [];
      const originalCreateSpec = require('../src/commands/specs').createSpec;
      require('../src/commands/specs').createSpec = jest.fn(async (id, options) => {
        createdSpecs.push({ id, options });
        return { id, type: options.type, title: options.title };
      });

      // Run migration with only 'auth' feature
      const result = await specsCommand('migrate', { features: ['auth'] });

      // Verify only auth feature was migrated
      expect(result.migrated).toBe(1);
      expect(createdSpecs.length).toBe(1);
      expect(createdSpecs[0].options.title).toBe('Authentication');
      expect(fs.writeFile).toHaveBeenCalled();

      // Restore createSpec
      require('../src/commands/specs').createSpec = originalCreateSpec;
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
      const yaml = require('js-yaml');

      // Legacy spec with auth feature
      const legacySpec = {
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

      // Convert to YAML string
      const legacySpecYaml = yaml.dump(legacySpec);

      // Mock fs.pathExists - return true for legacy spec
      fs.pathExists.mockImplementation((filePath) => {
        return Promise.resolve(String(filePath).includes('working-spec.yaml'));
      });

      // Mock fs.readFile - simple: if path contains 'working-spec.yaml', return YAML
      fs.readFile.mockImplementation(async (filePath, encoding) => {
        if (String(filePath).includes('working-spec.yaml')) {
          return legacySpecYaml;
        }
        if (String(filePath).includes('registry.json')) {
          return JSON.stringify({
            version: '1.0.0',
            specs: {},
            lastUpdated: new Date().toISOString(),
          });
        }
        return '';
      });

      // Mock fs.writeFile and fs.ensureDir
      fs.writeFile.mockResolvedValue(undefined);
      fs.ensureDir.mockResolvedValue(undefined);

      // Mock createSpec to track what gets created
      const createdSpecs = [];
      const originalCreateSpec = require('../src/commands/specs').createSpec;
      require('../src/commands/specs').createSpec = jest.fn(async (id, options) => {
        createdSpecs.push({ id, options });
        return { id, type: options.type, title: options.title };
      });

      // Run migration with interactive and features options
      const result = await specsCommand('migrate', {
        interactive: true,
        features: ['auth'],
      });

      // Verify migration completed and options were used
      expect(result.migrated).toBe(1);
      expect(createdSpecs.length).toBe(1);
      expect(createdSpecs[0].options.title).toBe('Authentication');
      expect(fs.writeFile).toHaveBeenCalled();

      // Restore createSpec
      require('../src/commands/specs').createSpec = originalCreateSpec;
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
