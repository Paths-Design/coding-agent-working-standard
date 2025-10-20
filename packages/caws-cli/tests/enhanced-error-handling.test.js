/**
 * @fileoverview Tests for Enhanced Error Handling
 * Tests the enhanced error handling and user guidance in multi-agent scenarios
 * @author @darianrosebrook
 */

const fs = require('fs-extra');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('js-yaml');

describe('Enhanced Error Handling', () => {
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

  describe('Multiple Specs Error Handling', () => {
    test('should provide detailed guidance for multiple specs', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      // Mock multiple specs scenario
      const mockRegistry = {
        specs: {
          'user-auth': { path: 'user-auth.yaml' },
          'payment-system': { path: 'payment-system.yaml' },
          'dashboard-ui': { path: 'dashboard-ui.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);

      // Mock spec loading with details
      const specs = {
        'user-auth': {
          id: 'user-auth',
          type: 'feature',
          status: 'active',
          title: 'User Authentication System',
        },
        'payment-system': {
          id: 'payment-system',
          type: 'feature',
          status: 'draft',
          title: 'Payment Processing',
        },
        'dashboard-ui': {
          id: 'dashboard-ui',
          type: 'feature',
          status: 'completed',
          title: 'Admin Dashboard UI',
        },
      };

      require('js-yaml')
        .load.mockReturnValueOnce(specs['user-auth'])
        .mockReturnValueOnce(specs['payment-system'])
        .mockReturnValueOnce(specs['dashboard-ui']);

      await expect(resolveSpec({})).rejects.toThrow('Spec ID required when multiple specs exist');

      // Should show detailed spec information
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Multiple specs detected')
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('user-auth 🚀 [active] - User Authentication System')
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('payment-system 🔧 [draft] - Payment Processing')
      );

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('dashboard-ui 📚 [completed] - Admin Dashboard UI')
      );
    });

    test('should suggest most appropriate spec', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockRegistry = {
        specs: {
          'draft-spec': { path: 'draft-spec.yaml' },
          'active-spec': { path: 'active-spec.yaml' },
          'completed-spec': { path: 'completed-spec.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);

      const specs = {
        'draft-spec': { id: 'draft-spec', type: 'feature', status: 'draft', title: 'Draft' },
        'active-spec': { id: 'active-spec', type: 'feature', status: 'active', title: 'Active' },
        'completed-spec': {
          id: 'completed-spec',
          type: 'feature',
          status: 'completed',
          title: 'Completed',
        },
      };

      require('js-yaml')
        .load.mockReturnValueOnce(specs['draft-spec'])
        .mockReturnValueOnce(specs['active-spec'])
        .mockReturnValueOnce(specs['completed-spec']);

      await expect(resolveSpec({})).rejects.toThrow();

      // Should suggest active spec first (priority: active > draft > completed)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Try: caws <command> --spec-id active-spec')
      );
    });

    test('should show interactive mode suggestion', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);

      require('js-yaml')
        .load.mockReturnValueOnce({ id: 'spec1', status: 'draft' })
        .mockReturnValueOnce({ id: 'spec2', status: 'draft' });

      await expect(resolveSpec({})).rejects.toThrow();

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Interactive mode: caws <command> --interactive-spec-selection')
      );
    });
  });

  describe('Interactive Spec Selection', () => {
    test('should handle numeric selection', async () => {
      const { interactiveSpecSelection } = require('../src/utils/spec-resolver');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          // Simulate user selecting option 1
          callback('1');
        }),
        close: jest.fn(),
      };

      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await interactiveSpecSelection(['spec1', 'spec2']);

      expect(result).toBe('spec1');
      expect(mockRl.question).toHaveBeenCalledWith(
        expect.stringContaining('Enter number (1-2) or spec ID directly')
      );
    });

    test('should handle direct spec ID input', async () => {
      const { interactiveSpecSelection } = require('../src/utils/spec-resolver');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('spec2');
        }),
        close: jest.fn(),
      };

      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await interactiveSpecSelection(['spec1', 'spec2']);

      expect(result).toBe('spec2');
    });

    test('should reject invalid input', async () => {
      const { interactiveSpecSelection } = require('../src/utils/spec-resolver');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('invalid');
        }),
        close: jest.fn(),
      };

      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      await expect(interactiveSpecSelection(['spec1', 'spec2'])).rejects.toThrow(
        'Invalid selection'
      );
    });

    test('should handle out of range numbers', async () => {
      const { interactiveSpecSelection } = require('../src/utils/spec-resolver');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('5'); // Out of range for 2 specs
        }),
        close: jest.fn(),
      };

      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      await expect(interactiveSpecSelection(['spec1', 'spec2'])).rejects.toThrow(
        'Invalid selection'
      );
    });
  });

  describe('Legacy Spec Warnings', () => {
    test('should show migration suggestion for legacy spec', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockSpec = { id: 'legacy-spec', title: 'Legacy Spec' };

      // No feature specs exist, only legacy
      const mockRegistry = { specs: {} };
      fs.pathExists
        .mockResolvedValueOnce(true) // Registry exists
        .mockResolvedValueOnce(true); // Legacy spec exists

      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load = jest.fn().mockReturnValue(mockSpec);

      const result = await resolveSpec({ warnLegacy: true });

      expect(result.type).toBe('legacy');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Using legacy working-spec.yaml')
      );
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Migration Recommended'));
    });

    test('should not show warnings when warnLegacy is false', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockSpec = { id: 'legacy-spec' };
      const mockRegistry = { specs: {} };

      fs.pathExists.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load = jest.fn().mockReturnValue(mockSpec);

      const result = await resolveSpec({ warnLegacy: false });

      expect(result.type).toBe('legacy');
      expect(console.log).not.toHaveBeenCalledWith(
        expect.stringContaining('Migration Recommended')
      );
    });
  });

  describe('Command Error Handling', () => {
    test('should handle spec resolution errors in validate command', async () => {
      const { validateCommand } = require('../src/commands/validate');

      require('../src/utils/spec-resolver').resolveSpec = jest
        .fn()
        .mockRejectedValue(new Error('Spec not found'));

      await expect(validateCommand(null, {})).rejects.toThrow('Spec not found');
    });

    test('should handle validation errors with context', async () => {
      const { validateCommand } = require('../src/commands/validate');

      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: { id: 'test-spec' },
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

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

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Validating feature spec'));
    });

    test('should handle missing spec gracefully', async () => {
      const { validateCommand } = require('../src/commands/validate');

      require('../src/utils/spec-resolver').resolveSpec = jest
        .fn()
        .mockRejectedValue(new Error('No CAWS spec found'));

      await expect(validateCommand(null, {})).rejects.toThrow('No CAWS spec found');
    });
  });

  describe('Spec ID Validation', () => {
    test('should handle invalid spec ID format', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockRegistry = {
        specs: {
          'invalid spec': { path: 'invalid spec.yaml' }, // Invalid ID with spaces
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);

      // Should not throw on invalid ID, just not find the spec
      await expect(resolveSpec({ specId: 'invalid spec' })).rejects.toThrow(
        "Feature spec 'invalid spec' not found"
      );
    });

    test('should handle non-existent spec ID', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      const mockRegistry = {
        specs: {
          'existing-spec': { path: 'existing-spec.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);

      await expect(resolveSpec({ specId: 'non-existent-spec' })).rejects.toThrow(
        "Feature spec 'non-existent-spec' not found"
      );
    });
  });

  describe('File System Error Handling', () => {
    test('should handle file system errors gracefully', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      fs.pathExists.mockRejectedValue(new Error('File system error'));

      await expect(resolveSpec({})).rejects.toThrow('File system error');
    });

    test('should handle YAML parsing errors', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      fs.pathExists.mockResolvedValue(true);
      require('js-yaml').load = jest.fn().mockImplementation(() => {
        throw new Error('Invalid YAML');
      });

      await expect(resolveSpec({ specFile: '/path/to/spec.yaml' })).rejects.toThrow('Invalid YAML');
    });

    test('should handle registry JSON parsing errors', async () => {
      const { resolveSpec } = require('../src/utils/spec-resolver');

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockRejectedValue(new Error('Invalid JSON'));

      await expect(resolveSpec({})).rejects.toThrow('Invalid JSON');
    });
  });
});



