/**
 * @fileoverview Tests for Enhanced Spec Creation with Conflict Resolution
 * Tests the conflict resolution and safe spec creation functionality
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');

// Mock js-yaml but delegate to real implementation for dump/load
jest.mock('js-yaml', () => {
  const actualYaml = jest.requireActual('js-yaml');
  return {
    ...actualYaml,
    dump: jest.fn((...args) => actualYaml.dump(...args)),
    load: jest.fn((...args) => actualYaml.load(...args)),
  };
});

// Mock worktree-manager to avoid git calls and control registry state
const mockWorktreeRegistry = { version: 1, worktrees: {} };
jest.mock('../src/worktree/worktree-manager', () => ({
  loadRegistry: jest.fn(() => mockWorktreeRegistry),
  getRepoRoot: jest.fn(() => '/mock/repo'),
}));

// Don't mock the specs module - we want to test the real createSpec function

describe('Enhanced Spec Creation with Conflict Resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset worktree registry to empty (no active worktrees)
    mockWorktreeRegistry.worktrees = {};

    // Ensure fs.writeFile and fs.readFile are jest mock functions
    if (!jest.isMockFunction(fs.writeFile)) {
      fs.writeFile = jest.fn();
    }
    if (!jest.isMockFunction(fs.readFile)) {
      fs.readFile = jest.fn();
    }

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
      once: jest.fn((event, callback) => {
        // Simulate event emission for 'close' event
        if (event === 'close') {
          process.nextTick(() => callback());
        }
      }),
    });

    // No need to clear mocks for createSpec since we're testing the real function
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createSpec with conflict detection', () => {
    test('should create new spec when no conflicts exist', async () => {
      const { createSpec } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      // Use a shared Map to store written content
      const writtenFiles = new Map();

      // Mock fs.writeFile to store content
      fs.writeFile.mockImplementation(async (filePath, content) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Store by multiple keys for flexible matching
        writtenFiles.set(resolvedPath, content);
        writtenFiles.set(filePath, content);
        writtenFiles.set(fileName, content);
      });

      // Mock fs.readFile to return stored content
      fs.readFile.mockImplementation(async (filePath, _encoding) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Try multiple keys
        return (
          writtenFiles.get(resolvedPath) ||
          writtenFiles.get(filePath) ||
          writtenFiles.get(fileName) ||
          ''
        );
      });

      const result = await createSpec('FEAT-001', {
        type: 'feature',
        title: 'New Feature',
        risk_tier: 2,
      });

      expect(result).toEqual({
        id: 'FEAT-001',
        path: 'FEAT-001.yaml',
        type: 'feature',
        title: 'New Feature',
        status: 'draft',
        risk_tier: 2,
        mode: 'development',
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });

      expect(fs.ensureDir).toHaveBeenCalledWith(expect.stringContaining('.caws/specs'));
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should record the current worktree in created spec yaml', async () => {
      jest.spyOn(process, 'cwd').mockReturnValue('/mock/repo/.caws/worktrees/p02-capability-gate');
      const { createSpec } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false);
      fs.ensureDir.mockResolvedValue(undefined);

      let writtenYaml = '';
      fs.writeFile.mockImplementation(async (filePath, content) => {
        if (filePath.endsWith('.yaml')) {
          writtenYaml = content;
        }
      });
      fs.readFile.mockImplementation(async () => writtenYaml);

      await createSpec('FEAT-001', {
        type: 'feature',
        title: 'Feature in worktree',
        risk_tier: 2,
      });

      expect(writtenYaml).toContain('worktree: p02-capability-gate');
    });

    test('should detect existing spec conflict', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true); // Spec exists
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      await expect(createSpec('FEAT-002', {})).rejects.toThrow(
        "Spec 'FEAT-002' already exists. Use --force to override."
      );

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Spec 'FEAT-002' already exists")
      );
    });

    test('should handle force override of existing spec', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true); // Spec exists
      fs.ensureDir.mockResolvedValue(undefined);

      // Capture written content and return it when read
      let writtenContent = '';
      fs.writeFile.mockImplementation(async (_filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async (_filePath) => {
        // Return existing spec on first read (conflict check), then written content
        if (writtenContent) {
          return writtenContent;
        }
        return yaml.dump(existingSpec);
      });

      const result = await createSpec('FEAT-002', { force: true });

      expect(result.id).toBe('FEAT-002');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Overriding existing spec'));
    });

    test('should handle interactive conflict resolution - cancel', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('FEAT-002', { interactive: true });

      expect(result).toBeNull();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Spec creation canceled'));
    });

    test('should handle interactive conflict resolution - rename', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists
        .mockResolvedValueOnce(true) // First call: existing spec exists
        .mockResolvedValueOnce(false); // Second call: new spec doesn't exist

      fs.ensureDir.mockResolvedValue(undefined);

      // Capture written content and return it when read
      let writtenContent = '';
      fs.writeFile.mockImplementation(async (_filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async (_filePath) => {
        // Return existing spec on first read (conflict check), then written content
        if (writtenContent) {
          return writtenContent;
        }
        return yaml.dump(existingSpec);
      });

      // Mock readline to return '2' (rename)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('2'); // Rename
        }),
        close: jest.fn(),
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('FEAT-002', { interactive: true });

      expect(result.id).toMatch(/^FEAT-\d+$/);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Creating spec with new name')
      );
    });

    test('should handle interactive conflict resolution - merge', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      // Mock registry with the existing spec
      const mockRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-002': {
            path: 'FEAT-002.yaml',
            title: 'Existing Feature',
            status: 'active',
          },
        },
        lastUpdated: new Date().toISOString(),
      };

      fs.pathExists.mockResolvedValue(true);
      let writtenContent = '';
      fs.readFile.mockImplementation(async (filePath) => {
        if (String(filePath).includes('registry.json')) {
          return JSON.stringify(mockRegistry);
        }
        return writtenContent || yaml.dump(existingSpec);
      });
      fs.writeFile.mockImplementation(async (filePath, content) => {
        if (String(filePath).endsWith('.yaml')) {
          writtenContent = content;
        }
      });
      fs.ensureDir.mockResolvedValue(undefined);

      // Mock readline to return '3' (merge)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('3'); // Merge
        }),
        close: jest.fn(),
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('FEAT-002', { interactive: true });

      // Merge should complete and return the merged spec
      expect(result).not.toBeNull();
      expect(result.id).toBe('FEAT-002');
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Merging')
      );
    });

    test('should handle interactive conflict resolution - override', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Mock existing spec
      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);

      // Capture written content and return it when read
      let writtenContent = '';
      fs.writeFile.mockImplementation(async (_filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async (_filePath) => {
        // Return existing spec on first read (conflict check), then written content
        if (writtenContent) {
          return writtenContent;
        }
        return yaml.dump(existingSpec);
      });

      // Mock readline to return '4' (override)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('4'); // Override
        }),
        close: jest.fn(),
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
      };
      jest.spyOn(require('readline'), 'createInterface').mockReturnValue(mockRl);

      const result = await createSpec('FEAT-002', { interactive: true });

      expect(result.id).toBe('FEAT-002');
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
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

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      // Use a shared Map to store written content
      const writtenFiles = new Map();

      // Mock fs.writeFile to store content
      fs.writeFile.mockImplementation(async (filePath, content) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Store by multiple keys for flexible matching
        writtenFiles.set(resolvedPath, content);
        writtenFiles.set(filePath, content);
        writtenFiles.set(fileName, content);
      });

      // Mock fs.readFile to return stored content
      fs.readFile.mockImplementation(async (filePath, _encoding) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Try multiple keys
        return (
          writtenFiles.get(resolvedPath) ||
          writtenFiles.get(filePath) ||
          writtenFiles.get(fileName) ||
          ''
        );
      });

      const result = await specsCommand('create', { id: 'FEAT-003', force: true });

      expect(result.command).toBe('specs create');
      expect(result.spec).toBeDefined();
      expect(result.spec.id).toBe('FEAT-003');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should pass interactive option to createSpec', async () => {
      const { specsCommand } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      // Use a shared Map to store written content
      const writtenFiles = new Map();

      // Mock fs.writeFile to store content
      fs.writeFile.mockImplementation(async (filePath, content) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Store by multiple keys for flexible matching
        writtenFiles.set(resolvedPath, content);
        writtenFiles.set(filePath, content);
        writtenFiles.set(fileName, content);
      });

      // Mock fs.readFile to return stored content
      fs.readFile.mockImplementation(async (filePath, _encoding) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Try multiple keys
        return (
          writtenFiles.get(resolvedPath) ||
          writtenFiles.get(filePath) ||
          writtenFiles.get(fileName) ||
          ''
        );
      });

      const result = await specsCommand('create', { id: 'FEAT-003', interactive: true });

      expect(result.command).toBe('specs create');
      expect(result.spec).toBeDefined();
      expect(result.spec.id).toBe('FEAT-003');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should handle createSpec returning null (canceled)', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock existing spec to trigger conflict resolution
      const existingSpec = {
        id: 'FEAT-003',
        title: 'Existing Spec',
        status: 'active',
      };

      fs.pathExists.mockResolvedValue(true); // Spec exists
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      // Mock readline to return '1' (cancel)
      const mockRl = {
        question: jest.fn((prompt, callback) => {
          callback('1'); // Cancel
        }),
        close: jest.fn(),
        once: jest.fn((event, callback) => {
          if (event === 'close') {
            process.nextTick(() => callback());
          }
        }),
      };
      require('readline').createInterface.mockReturnValue(mockRl);

      const result = await specsCommand('create', { id: 'FEAT-003', interactive: true });

      expect(result.command).toBe('specs create');
      expect(result.canceled).toBe(true);
      expect(result.message).toBe('Spec creation was canceled or failed');
    });
  });

  describe('CLI integration', () => {
    test('should pass force option from CLI to specsCommand', async () => {
      const { specsCommand } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      // Use a shared Map to store written content
      const writtenFiles = new Map();

      // Mock fs.writeFile to store content
      fs.writeFile.mockImplementation(async (filePath, content) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Store by multiple keys for flexible matching
        writtenFiles.set(resolvedPath, content);
        writtenFiles.set(filePath, content);
        writtenFiles.set(fileName, content);
      });

      // Mock fs.readFile to return stored content
      fs.readFile.mockImplementation(async (filePath, _encoding) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Try multiple keys
        return (
          writtenFiles.get(resolvedPath) ||
          writtenFiles.get(filePath) ||
          writtenFiles.get(fileName) ||
          ''
        );
      });

      // Simulate CLI call with --force
      const result = await specsCommand('create', { id: 'FEAT-003', force: true });

      expect(result.command).toBe('specs create');
      expect(result.spec).toBeDefined();
      expect(result.spec.id).toBe('FEAT-003');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('should pass interactive option from CLI to specsCommand', async () => {
      const { specsCommand } = require('../src/commands/specs');

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      // Use a shared Map to store written content
      const writtenFiles = new Map();

      // Mock fs.writeFile to store content
      fs.writeFile.mockImplementation(async (filePath, content) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Store by multiple keys for flexible matching
        writtenFiles.set(resolvedPath, content);
        writtenFiles.set(filePath, content);
        writtenFiles.set(fileName, content);
      });

      // Mock fs.readFile to return stored content
      fs.readFile.mockImplementation(async (filePath, _encoding) => {
        const resolvedPath = path.resolve(filePath);
        const fileName = path.basename(filePath);
        // Try multiple keys
        return (
          writtenFiles.get(resolvedPath) ||
          writtenFiles.get(filePath) ||
          writtenFiles.get(fileName) ||
          ''
        );
      });

      // Simulate CLI call with --interactive
      const result = await specsCommand('create', { id: 'FEAT-003', interactive: true });

      expect(result.command).toBe('specs create');
      expect(result.spec).toBeDefined();
      expect(result.spec.id).toBe('FEAT-003');
      expect(fs.writeFile).toHaveBeenCalled();
    });
  });

  describe('worktree-association guards', () => {
    test('should block --force override when active worktree references the spec', async () => {
      const { createSpec } = require('../src/commands/specs');

      // Simulate an active worktree referencing FEAT-002
      mockWorktreeRegistry.worktrees = {
        'my-feature': {
          name: 'my-feature',
          specId: 'FEAT-002',
          status: 'active',
          branch: 'caws/my-feature',
        },
      };

      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      await expect(createSpec('FEAT-002', { force: true })).rejects.toThrow(
        /Cannot override spec 'FEAT-002': active worktree\(s\) \[my-feature\] reference it/
      );
    });

    test('should block --force override when fresh worktree references the spec', async () => {
      const { createSpec } = require('../src/commands/specs');

      // "fresh" worktrees (no commits yet) should still be protected
      mockWorktreeRegistry.worktrees = {
        'wbatlas-03': {
          name: 'wbatlas-03',
          specId: 'WBATLAS-03',
          status: 'fresh',
          branch: 'caws/wbatlas-03',
        },
      };

      const existingSpec = {
        id: 'WBATLAS-03',
        title: 'Workbench stabilization',
        status: 'draft',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      await expect(createSpec('WBATLAS-03', { force: true })).rejects.toThrow(
        /Cannot override spec 'WBATLAS-03': active worktree\(s\) \[wbatlas-03\] reference it/
      );
    });

    test('should allow --force override when worktree is destroyed', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Destroyed worktrees should NOT block override
      mockWorktreeRegistry.worktrees = {
        'old-feature': {
          name: 'old-feature',
          specId: 'FEAT-002',
          status: 'destroyed',
          branch: 'caws/old-feature',
        },
      };

      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);

      let writtenContent = '';
      fs.writeFile.mockImplementation(async (filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async () => {
        if (writtenContent) return writtenContent;
        return yaml.dump(existingSpec);
      });

      const result = await createSpec('FEAT-002', { force: true });
      expect(result.id).toBe('FEAT-002');
    });

    test('should allow --force override when worktree is merged', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      // Merged worktrees should NOT block override
      mockWorktreeRegistry.worktrees = {
        'done-feature': {
          name: 'done-feature',
          specId: 'FEAT-002',
          status: 'merged',
          branch: 'caws/done-feature',
        },
      };

      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);

      let writtenContent = '';
      fs.writeFile.mockImplementation(async (filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async () => {
        if (writtenContent) return writtenContent;
        return yaml.dump(existingSpec);
      });

      const result = await createSpec('FEAT-002', { force: true });
      expect(result.id).toBe('FEAT-002');
    });

    test('should list multiple conflicting worktrees in error', async () => {
      const { createSpec } = require('../src/commands/specs');

      mockWorktreeRegistry.worktrees = {
        'agent-a': {
          name: 'agent-a',
          specId: 'FEAT-002',
          status: 'active',
          branch: 'caws/agent-a',
        },
        'agent-b': {
          name: 'agent-b',
          specId: 'FEAT-002',
          status: 'fresh',
          branch: 'caws/agent-b',
        },
      };

      const existingSpec = {
        id: 'FEAT-002',
        title: 'Existing Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(require('js-yaml').dump(existingSpec));

      await expect(createSpec('FEAT-002', { force: true })).rejects.toThrow(
        /active worktree\(s\) \[agent-a, agent-b\]/
      );
    });

    test('deleteSpec should block when active worktree references the spec', async () => {
      const { deleteSpec } = require('../src/commands/specs');

      mockWorktreeRegistry.worktrees = {
        'my-feature': {
          name: 'my-feature',
          specId: 'FEAT-005',
          status: 'active',
          branch: 'caws/my-feature',
        },
      };

      // loadSpecsRegistry uses fs.pathExists then fs.readFile
      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-005': { path: 'FEAT-005.yaml', type: 'feature', status: 'draft' },
        },
      };
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(specsRegistry));

      await expect(deleteSpec('FEAT-005')).rejects.toThrow(
        /Cannot delete spec 'FEAT-005': active worktree\(s\) \[my-feature\] reference it/
      );

      // File should NOT have been removed
      expect(fs.remove).not.toHaveBeenCalled();
    });

    test('closeSpec should block when active worktree references the spec', async () => {
      const { closeSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      mockWorktreeRegistry.worktrees = {
        'my-feature': {
          name: 'my-feature',
          specId: 'FEAT-006',
          status: 'active',
          branch: 'caws/my-feature',
        },
      };

      const spec = {
        id: 'FEAT-006',
        title: 'Active Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      // First pathExists call: registry check; second: spec file check
      // readFile calls: first returns registry JSON, then spec YAML
      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-006': { path: 'FEAT-006.yaml', type: 'feature', status: 'active' },
        },
      };
      fs.pathExists.mockResolvedValue(true);
      fs.readFile
        .mockResolvedValueOnce(JSON.stringify(specsRegistry)) // loadSpecsRegistry (loadSpec)
        .mockResolvedValueOnce(yaml.dump(spec)) // loadSpec reads the YAML file
        .mockResolvedValueOnce(JSON.stringify(specsRegistry)); // loadSpecsRegistry (ownership check)

      const result = await closeSpec('FEAT-006');

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Cannot close spec 'FEAT-006'")
      );
    });
  });

  describe('session ownership guards', () => {
    const ORIGINAL_SESSION = process.env.CLAUDE_SESSION_ID;

    afterEach(() => {
      // Restore original session ID
      if (ORIGINAL_SESSION !== undefined) {
        process.env.CLAUDE_SESSION_ID = ORIGINAL_SESSION;
      } else {
        delete process.env.CLAUDE_SESSION_ID;
      }
    });

    test('should block --force override when spec is owned by another session', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      process.env.CLAUDE_SESSION_ID = 'session-agent-b';

      const existingSpec = {
        id: 'FEAT-010',
        title: 'Agent A Feature',
        status: 'draft',
        created_at: '2025-01-01T00:00:00Z',
      };

      // Registry has owner from a different session
      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-010': {
            path: 'FEAT-010.yaml',
            type: 'feature',
            status: 'draft',
            owner: 'session-agent-a',
          },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);
      fs.readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('registry.json')) return JSON.stringify(specsRegistry);
        return yaml.dump(existingSpec);
      });

      await expect(createSpec('FEAT-010', { force: true })).rejects.toThrow(
        /Cannot override spec 'FEAT-010': owned by another session/
      );
    });

    test('should allow --force override when spec is owned by current session', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      process.env.CLAUDE_SESSION_ID = 'session-agent-a';

      const existingSpec = {
        id: 'FEAT-010',
        title: 'My Feature',
        status: 'draft',
        created_at: '2025-01-01T00:00:00Z',
      };

      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-010': {
            path: 'FEAT-010.yaml',
            type: 'feature',
            status: 'draft',
            owner: 'session-agent-a',
          },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);

      let writtenContent = '';
      fs.writeFile.mockImplementation(async (filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('registry.json')) return JSON.stringify(specsRegistry);
        if (writtenContent) return writtenContent;
        return yaml.dump(existingSpec);
      });

      const result = await createSpec('FEAT-010', { force: true });
      expect(result.id).toBe('FEAT-010');
    });

    test('should allow --force override when spec has no owner (legacy spec)', async () => {
      const { createSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      process.env.CLAUDE_SESSION_ID = 'session-agent-b';

      const existingSpec = {
        id: 'FEAT-010',
        title: 'Legacy Feature',
        status: 'draft',
        created_at: '2025-01-01T00:00:00Z',
      };

      // Registry has no owner (legacy entry)
      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-010': {
            path: 'FEAT-010.yaml',
            type: 'feature',
            status: 'draft',
            // no owner field
          },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.ensureDir.mockResolvedValue(undefined);

      let writtenContent = '';
      fs.writeFile.mockImplementation(async (filePath, content) => {
        writtenContent = content;
      });
      fs.readFile.mockImplementation(async (filePath) => {
        if (filePath.endsWith('registry.json')) return JSON.stringify(specsRegistry);
        if (writtenContent) return writtenContent;
        return yaml.dump(existingSpec);
      });

      const result = await createSpec('FEAT-010', { force: true });
      expect(result.id).toBe('FEAT-010');
    });

    test('deleteSpec should block when owned by another session', async () => {
      const { deleteSpec } = require('../src/commands/specs');

      process.env.CLAUDE_SESSION_ID = 'session-agent-b';

      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-011': {
            path: 'FEAT-011.yaml',
            type: 'feature',
            status: 'draft',
            owner: 'session-agent-a',
          },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(specsRegistry));

      await expect(deleteSpec('FEAT-011')).rejects.toThrow(
        /Cannot delete spec 'FEAT-011': owned by another session/
      );
      expect(fs.remove).not.toHaveBeenCalled();
    });

    test('closeSpec should block when owned by another session', async () => {
      const { closeSpec } = require('../src/commands/specs');
      const yaml = require('js-yaml');

      process.env.CLAUDE_SESSION_ID = 'session-agent-b';

      const spec = {
        id: 'FEAT-012',
        title: 'Other Agent Feature',
        status: 'active',
        created_at: '2025-01-01T00:00:00Z',
      };

      const specsRegistry = {
        version: '1.0.0',
        specs: {
          'FEAT-012': {
            path: 'FEAT-012.yaml',
            type: 'feature',
            status: 'active',
            owner: 'session-agent-a',
          },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readFile
        .mockResolvedValueOnce(JSON.stringify(specsRegistry)) // loadSpecsRegistry (loadSpec)
        .mockResolvedValueOnce(yaml.dump(spec)) // loadSpec reads YAML
        .mockResolvedValueOnce(JSON.stringify(specsRegistry)); // loadSpecsRegistry (ownership check)

      const result = await closeSpec('FEAT-012');

      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("Cannot close spec 'FEAT-012': owned by another session")
      );
    });

    test('createSpec should store owner in registry entry', async () => {
      const { createSpec } = require('../src/commands/specs');

      process.env.CLAUDE_SESSION_ID = 'session-test-123';

      fs.pathExists.mockResolvedValue(false); // No existing spec
      fs.ensureDir.mockResolvedValue(undefined);

      const writtenFiles = new Map();
      fs.writeFile.mockImplementation(async (filePath, content) => {
        writtenFiles.set(path.basename(filePath), content);
      });
      fs.readFile.mockImplementation(async (filePath) => {
        const basename = path.basename(filePath);
        return writtenFiles.get(basename) || '';
      });

      await createSpec('FEAT-020', {
        type: 'feature',
        title: 'Owner Test',
        risk_tier: 2,
      });

      // Check that registry was written with owner field
      const registryContent = writtenFiles.get('registry.json');
      expect(registryContent).toBeDefined();
      const registry = JSON.parse(registryContent);
      expect(registry.specs['FEAT-020'].owner).toBe('session-test-123');
    });
  });
});
