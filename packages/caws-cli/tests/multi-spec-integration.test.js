/**
 * @fileoverview Tests for Multi-Spec Command Integration
 * Tests how commands integrate with the multi-spec architecture
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('js-yaml');
jest.mock('../src/utils/spec-resolver');

describe('Multi-Spec Command Integration', () => {
  const mockSpec = {
    id: 'test-spec',
    title: 'Test Spec',
    risk_tier: 2,
    mode: 'feature',
    acceptance_criteria: [
      {
        id: 'A1',
        given: 'Valid input',
        when: 'Action performed',
        then: 'Expected result',
      },
    ],
  };

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Validate Command Integration', () => {
    test('should use spec resolver for multi-spec validation', async () => {
      const { validateCommand } = require('../src/commands/validate');

      // Mock spec resolver to return feature spec
      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock validation function
      const mockValidation = {
        valid: true,
        errors: [],
        warnings: [],
        suggestions: ['Add more tests'],
      };

      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue(mockValidation);

      await validateCommand(null, { specId: 'test-spec' });

      // Verify spec resolver was called with correct options
      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: true,
        interactive: false,
      });

      // Verify validation was called with resolved spec
      expect(
        require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions
      ).toHaveBeenCalledWith(mockSpec, expect.any(Object));
    });

    test('should handle legacy spec validation', async () => {
      const { validateCommand } = require('../src/commands/validate');

      // Mock spec resolver to return legacy spec
      const mockResolved = {
        path: '.caws/working-spec.yaml',
        type: 'legacy',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      const mockValidation = {
        valid: true,
        errors: [],
        warnings: [],
      };

      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue(mockValidation);

      await validateCommand(null, {});

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Using legacy working-spec.yaml')
      );
    });
  });

  describe('Status Command Integration', () => {
    test('should use spec resolver for multi-spec status', async () => {
      const { statusCommand } = require('../src/commands/status');

      // Mock spec resolver
      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock other status functions
      require('../src/commands/status').checkGitHooks = jest.fn().mockResolvedValue({
        installed: true,
        count: 4,
        total: 6,
      });

      await statusCommand({ visual: true, specId: 'test-spec' });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: undefined,
      });
    });
  });

  describe('Iterate Command Integration', () => {
    test('should use spec resolver for multi-spec iteration', async () => {
      const { iterateCommand } = require('../src/commands/iterate');

      // Mock spec resolver
      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      await iterateCommand(null, {
        specId: 'test-spec',
        currentState: JSON.stringify({ description: 'Test state' }),
      });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: false,
      });
    });
  });

  describe('Plan Command Integration', () => {
    test('should use spec resolver for multi-spec planning', async () => {
      const { planCommand } = require('../src/commands/plan');

      // Mock spec resolver
      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock plan generation functions
      require('../src/commands/plan').generateImplementationPlan = jest.fn().mockReturnValue({
        sections: ['Overview', 'Implementation'],
        tasks: ['Task 1', 'Task 2'],
      });

      require('../src/commands/plan').writePlanToFile = jest.fn();
      require('../src/commands/plan').displayGeneratedPlan = jest.fn();

      await planCommand('generate', { specId: 'test-spec' });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: false,
      });
    });

    test('should auto-detect single spec for plan generation', async () => {
      const { planCommand } = require('../src/commands/plan');

      // Mock single spec scenario
      const mockRegistry = {
        specs: {
          'single-spec': { path: 'single-spec.yaml' },
        },
      };

      require('../src/utils/spec-resolver').checkMultiSpecStatus = jest.fn().mockResolvedValue({
        specCount: 1,
        registry: mockRegistry,
      });

      require('../src/utils/spec-resolver').loadSpecsRegistry = jest
        .fn()
        .mockResolvedValue(mockRegistry);

      const mockResolved = {
        path: '.caws/specs/single-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      require('../src/commands/plan').generateImplementationPlan = jest.fn().mockReturnValue({
        sections: ['Overview'],
        tasks: ['Task 1'],
      });

      require('../src/commands/plan').writePlanToFile = jest.fn();
      require('../src/commands/plan').displayGeneratedPlan = jest.fn();

      await planCommand('generate', {});

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'single-spec',
        specFile: null,
        warnLegacy: false,
      });
    });

    test('should require spec ID for multiple specs', async () => {
      const { planCommand } = require('../src/commands/plan');

      // Mock multiple specs scenario
      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      require('../src/utils/spec-resolver').checkMultiSpecStatus = jest.fn().mockResolvedValue({
        specCount: 2,
        registry: mockRegistry,
      });

      await expect(planCommand('generate', {})).rejects.toThrow(
        'Multiple specs detected. Please specify which one'
      );
    });
  });

  describe('Archive Command Integration', () => {
    test('should use spec resolver for multi-spec archiving', async () => {
      const { archiveCommand } = require('../src/commands/archive');

      // Mock spec resolver
      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock other archive functions
      require('../src/commands/archive').loadChange = jest.fn().mockResolvedValue({
        id: 'FEAT-001',
        workingSpec: mockSpec,
      });

      require('../src/commands/archive').validateAcceptanceCriteria = jest.fn().mockResolvedValue({
        valid: true,
      });

      require('../src/commands/archive').validateQualityGates = jest.fn().mockResolvedValue({
        passed: true,
      });

      await archiveCommand('FEAT-001', { specId: 'test-spec' });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: false,
      });
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle spec resolution errors gracefully', async () => {
      const { validateCommand } = require('../src/commands/validate');

      // Mock spec resolver to throw error
      require('../src/utils/spec-resolver').resolveSpec = jest
        .fn()
        .mockRejectedValue(new Error('Spec not found'));

      await expect(validateCommand(null, {})).rejects.toThrow('Spec not found');
    });

    test('should handle validation errors with resolved spec context', async () => {
      const { validateCommand } = require('../src/commands/validate');

      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock validation to return errors
      const mockValidation = {
        valid: false,
        errors: [
          {
            message: 'Missing required field',
            suggestion: 'Add the field',
          },
        ],
      };

      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue(mockValidation);

      await expect(validateCommand(null, { specId: 'test-spec' })).rejects.toThrow();

      // Should show spec context in error output
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Validating feature spec'));
    });
  });

  describe('CLI Option Integration', () => {
    test('should pass specId option to spec resolver', async () => {
      const { validateCommand } = require('../src/commands/validate');

      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);
      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue({ valid: true, errors: [], warnings: [] });

      await validateCommand(null, { specId: 'test-spec' });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: true,
        interactive: false,
      });
    });

    test('should pass interactive option to spec resolver', async () => {
      const { validateCommand } = require('../src/commands/validate');

      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);
      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue({ valid: true, errors: [], warnings: [] });

      await validateCommand(null, { interactive: true });

      expect(require('../src/utils/spec-resolver').resolveSpec).toHaveBeenCalledWith({
        specId: undefined,
        specFile: null,
        warnLegacy: true,
        interactive: true,
      });
    });
  });
});



