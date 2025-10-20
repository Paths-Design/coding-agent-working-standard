/**
 * @fileoverview Tests for Enhanced Spec Creation with Conflict Resolution
 * Tests the conflict resolution and safe spec creation functionality
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('js-yaml');

describe('Enhanced Spec Creation with Conflict Resolution', () => {
  const SPECS_DIR = '.caws/specs';

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock process.exit
    jest.spyOn(process, 'exit').mockImplementation(() => {});

    // Mock readline for interactive tests
    jest.spyOn(require('readline'), 'createInterface').mockReturnValue({
      question: jest.fn((prompt, callback) => {
        // Default to 'cancel' for tests unless specified
        callback('1'); // Cancel
      }),
      close: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createSpec with conflict detection', () => {
    test('should create new spec when no conflicts exist', async () => {
      const { createSpec } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await createSpec('new-spec', {
        type: 'feature',
        title: 'New Feature',
        risk_tier: 2,
      });

      expect(result).toEqual({
        id: 'new-spec',
        path: 'new-spec.yaml',
        type: 'feature',
        title: 'New Feature',
        status: 'draft',
        risk_tier: 2,
        mode: 'development',
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });

      expect(fs.ensureDir).toHaveBeenCalledWith(SPECS_DIR);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should detect existing spec conflict', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true); // Spec exists
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      await expect(createSpec('existing-spec', {})).rejects.toThrow(
        "Spec 'existing-spec' already exists. Use --force to override."
      );

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Spec 'existing-spec' already exists")
      );
    });

    test('should handle force override of existing spec', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true); // Spec exists
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      const result = await createSpec('existing-spec', { force: true });

      expect(result.id).toBe('existing-spec');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Overriding existing spec'));
    });

    test('should handle interactive conflict resolution - cancel', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      // Mock readline to return '1' (cancel)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('1'); // Cancel
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('existing-spec', { interactive: true });

      expect(result).toBeNull();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Spec creation canceled'));
    });

    test('should handle interactive conflict resolution - rename', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists
        .mockResolvedValueOnce(true) // First call: existing spec exists
        .mockResolvedValueOnce(false); // Second call: new spec doesn't exist

      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      // Mock readline to return '2' (rename)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('2'); // Rename
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('existing-spec', { interactive: true });

      expect(result.id).toContain('existing-spec-');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Creating spec with new name')
      );
    });

    test('should handle interactive conflict resolution - merge (not implemented)', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      // Mock readline to return '3' (merge)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('3'); // Merge
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('existing-spec', { interactive: true });

      expect(result).toBeNull();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Merge functionality not yet implemented')
      );
    });

    test('should handle interactive conflict resolution - override', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'existing-spec',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));
      fs.ensureDir.mockResolvedValue(undefined);
      fs.writeFile.mockResolvedValue(undefined);

      // Mock readline to return '4' (override)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('4'); // Override
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('existing-spec', { interactive: true });

      expect(result.id).toBe('existing-spec');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Overriding existing spec'));
    });
  });

  describe('askConflictResolution', () => {
    test('should return cancel for choice 1', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('1');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('cancel');
    });

    test('should return rename for choice 2', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('2');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('rename');
    });

    test('should return merge for choice 3', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('3');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('merge');
    });

    test('should return override for choice 4', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('4');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('override');
    });

    test('should handle text input', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('cancel');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('cancel');
    });

    test('should default to cancel for invalid input', async () => {
      const { askConflictResolution } = require('../src/commands/specs');

      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('invalid');
        }),
        close: jest.fn(),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await askConflictResolution();

      expect(result).toBe('cancel');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Invalid choice. Defaulting to cancel')
      );
    });
  });

  describe('specsCommand integration with conflict resolution', () => {
    test('should pass force option to createSpec', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock createSpec to capture options
      const mockCreateSpec = jest.fn().mockResolvedValue({
        id: 'test-spec',
        title: 'Test Spec',
        status: 'draft',
      });
      require('../src/commands/specs').createSpec = mockCreateSpec;

      await specsCommand('create', { id: 'test-spec', force: true });

      expect(mockCreateSpec).toHaveBeenCalledWith('test-spec', {
        type: 'feature',
        title: 'New feature',
        risk_tier: 'T3',
        mode: 'development',
        force: true,
        interactive: false,
      });
    });

    test('should pass interactive option to createSpec', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock createSpec to capture options
      const mockCreateSpec = jest.fn().mockResolvedValue({
        id: 'test-spec',
        title: 'Test Spec',
        status: 'draft',
      });
      require('../src/commands/specs').createSpec = mockCreateSpec;

      await specsCommand('create', { id: 'test-spec', interactive: true });

      expect(mockCreateSpec).toHaveBeenCalledWith('test-spec', {
        type: 'feature',
        title: 'New feature',
        risk_tier: 'T3',
        mode: 'development',
        force: false,
        interactive: true,
      });
    });

    test('should handle createSpec returning null (canceled)', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock createSpec to return null (canceled)
      const mockCreateSpec = jest.fn().mockResolvedValue(null);
      require('../src/commands/specs').createSpec = mockCreateSpec;

      const result = await specsCommand('create', { id: 'test-spec' });

      expect(result).toEqual({
        command: 'specs create',
        canceled: true,
        message: 'Spec creation was canceled or failed',
      });

      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Created spec'));
    });
  });

  describe('CLI integration', () => {
    test('should pass force option from CLI to specsCommand', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock createSpec to capture options
      const mockCreateSpec = jest.fn().mockResolvedValue({
        id: 'test-spec',
        title: 'Test Spec',
        status: 'draft',
      });
      require('../src/commands/specs').createSpec = mockCreateSpec;

      // Simulate CLI call with --force
      await specsCommand('create', { id: 'test-spec', force: true });

      expect(mockCreateSpec).toHaveBeenCalledWith(
        'test-spec',
        expect.objectContaining({
          force: true,
        })
      );
    });

    test('should pass interactive option from CLI to specsCommand', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock createSpec to capture options
      const mockCreateSpec = jest.fn().mockResolvedValue({
        id: 'test-spec',
        title: 'Test Spec',
        status: 'draft',
      });
      require('../src/commands/specs').createSpec = mockCreateSpec;

      // Simulate CLI call with --interactive
      await specsCommand('create', { id: 'test-spec', interactive: true });

      expect(mockCreateSpec).toHaveBeenCalledWith(
        'test-spec',
        expect.objectContaining({
          interactive: true,
        })
      );
    });
  });
});



