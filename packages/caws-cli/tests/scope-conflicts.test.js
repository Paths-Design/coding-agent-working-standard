/**
 * @fileoverview Tests for Scope Conflict Detection
 * Tests the scope conflict detection functionality for multi-agent workflows
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock dependencies
jest.mock('fs-extra');
jest.mock('js-yaml');

describe('Scope Conflict Detection', () => {
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

  describe('pathsOverlap function', () => {
    test('should detect exact path overlap', () => {
      const { pathsOverlap } = require('../src/utils/spec-resolver');

      expect(pathsOverlap('src/auth/', 'src/auth/')).toBe(true);
      expect(pathsOverlap('src/users/', 'src/users/')).toBe(true);
    });

    test('should detect substring overlap', () => {
      const { pathsOverlap } = require('../src/utils/spec-resolver');

      expect(pathsOverlap('src/', 'src/auth/')).toBe(true);
      expect(pathsOverlap('src/auth/', 'src/')).toBe(true);
    });

    test('should detect no overlap for distinct paths', () => {
      const { pathsOverlap } = require('../src/utils/spec-resolver');

      expect(pathsOverlap('src/auth/', 'src/users/')).toBe(false);
      expect(pathsOverlap('src/payments/', 'src/dashboard/')).toBe(false);
    });

    test('should handle wildcard patterns', () => {
      const { pathsOverlap } = require('../src/utils/spec-resolver');

      expect(pathsOverlap('src/*/', 'src/auth/')).toBe(true);
      expect(pathsOverlap('src/auth/', 'src/*/')).toBe(true);
    });

    test('should normalize paths', () => {
      const { pathsOverlap } = require('../src/utils/spec-resolver');

      expect(pathsOverlap('/src/auth/', 'src/auth/')).toBe(true);
      expect(pathsOverlap('src/auth/', '/src/auth/')).toBe(true);
    });
  });

  describe('checkScopeConflicts integration', () => {
    test('should detect conflicts in specs conflicts command', async () => {
      // This test would integrate with the actual specs command
      // For now, we'll test the core logic through the resolver

      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      // Mock two specs with overlapping scopes
      const spec1 = {
        id: 'auth-spec',
        scope: { in: ['src/auth/', 'src/common/'] },
      };
      const spec2 = {
        id: 'user-spec',
        scope: { in: ['src/users/', 'src/common/'] }, // Overlap on src/common/
      };

      const mockRegistry = {
        specs: {
          'auth-spec': { path: 'auth-spec.yaml' },
          'user-spec': { path: 'user-spec.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['auth-spec', 'user-spec']);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual({
        spec1: 'auth-spec',
        spec2: 'user-spec',
        conflicts: ['src/common/ ↔ src/common/'],
        severity: 'warning',
      });
    });

    test('should handle specs without scope definitions', async () => {
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const spec1 = { id: 'no-scope-spec' }; // No scope
      const spec2 = {
        id: 'scoped-spec',
        scope: { in: ['src/test/'] },
      };

      const mockRegistry = {
        specs: {
          'no-scope-spec': { path: 'no-scope-spec.yaml' },
          'scoped-spec': { path: 'scoped-spec.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['no-scope-spec', 'scoped-spec']);

      expect(conflicts).toHaveLength(0);
    });

    test('should handle complex scope patterns', async () => {
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const spec1 = {
        id: 'complex-spec1',
        scope: {
          in: ['src/auth/**/*.js', 'src/users/**/*.ts', 'src/shared/'],
        },
      };
      const spec2 = {
        id: 'complex-spec2',
        scope: {
          in: ['src/auth/login.js', 'src/admin/**/*.js'], // Overlap on src/auth/
        },
      };

      const mockRegistry = {
        specs: {
          'complex-spec1': { path: 'complex-spec1.yaml' },
          'complex-spec2': { path: 'complex-spec2.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['complex-spec1', 'complex-spec2']);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflicts).toContain('src/auth/**/*.js ↔ src/auth/login.js');
    });

    test('should handle empty spec arrays', async () => {
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const conflicts = await checkScopeConflicts([]);

      expect(conflicts).toHaveLength(0);
    });

    test('should handle single spec', async () => {
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const spec1 = {
        id: 'single-spec',
        scope: { in: ['src/auth/'] },
      };

      const mockRegistry = {
        specs: {
          'single-spec': { path: 'single-spec.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      require('fs-extra').readJson = jest.fn().mockResolvedValue(mockRegistry);
      require('js-yaml').load.mockReturnValueOnce(spec1);

      const conflicts = await checkScopeConflicts(['single-spec']);

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('Specs Conflicts Command', () => {
    test('should call scope conflict detection', async () => {
      const { specsCommand } = require('../src/commands/specs');

      // Mock registry with multiple specs
      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      // Mock scope conflict detection
      const mockConflicts = [
        {
          spec1: 'spec1',
          spec2: 'spec2',
          conflicts: ['src/auth/ ↔ src/auth/'],
          severity: 'warning',
        },
      ];

      require('../src/utils/spec-resolver').checkScopeConflicts = jest
        .fn()
        .mockResolvedValue(mockConflicts);
      require('../src/commands/specs').loadSpecsRegistry = jest
        .fn()
        .mockResolvedValue(mockRegistry);

      const result = await specsCommand('conflicts', {});

      expect(require('../src/utils/spec-resolver').checkScopeConflicts).toHaveBeenCalledWith([
        'spec1',
        'spec2',
      ]);

      expect(result).toEqual({
        command: 'specs conflicts',
        conflictCount: 1,
        conflicts: mockConflicts,
      });
    });

    test('should handle no conflicts gracefully', async () => {
      const { specsCommand } = require('../src/commands/specs');

      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      require('../src/utils/spec-resolver').checkScopeConflicts = jest.fn().mockResolvedValue([]);
      require('../src/commands/specs').loadSpecsRegistry = jest
        .fn()
        .mockResolvedValue(mockRegistry);

      const result = await specsCommand('conflicts', {});

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No scope conflicts detected')
      );

      expect(result.conflictCount).toBe(0);
    });

    test('should handle fewer than 2 specs', async () => {
      const { specsCommand } = require('../src/commands/specs');

      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
        },
      };

      require('../src/commands/specs').loadSpecsRegistry = jest
        .fn()
        .mockResolvedValue(mockRegistry);

      const result = await specsCommand('conflicts', {});

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No scope conflicts possible with fewer than 2 specs')
      );

      expect(result.conflictCount).toBe(0);
    });
  });

  describe('Validation Integration', () => {
    test('should include scope conflicts in validation output', async () => {
      const { validateCommand } = require('../src/commands/validate');

      const mockSpec = {
        id: 'test-spec',
        title: 'Test Spec',
        scope: { in: ['src/auth/'] },
      };

      const mockResolved = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      require('../src/utils/spec-resolver').resolveSpec = jest.fn().mockResolvedValue(mockResolved);

      // Mock multi-spec status with conflicts
      require('../src/utils/spec-resolver').checkMultiSpecStatus = jest.fn().mockResolvedValue({
        specCount: 2,
      });

      // Mock conflicts
      const mockConflicts = [
        {
          spec1: 'test-spec',
          spec2: 'other-spec',
          conflicts: ['src/auth/ ↔ src/auth/'],
        },
      ];

      require('../src/utils/spec-resolver').checkScopeConflicts = jest
        .fn()
        .mockResolvedValue(mockConflicts);

      const mockValidation = {
        valid: true,
        errors: [],
        warnings: [],
      };

      require('../src/validation/spec-validation').validateWorkingSpecWithSuggestions = jest
        .fn()
        .mockReturnValue(mockValidation);

      await validateCommand(null, { specId: 'test-spec' });

      // Should show scope conflict warning
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Scope conflicts detected'));
    });
  });
});



