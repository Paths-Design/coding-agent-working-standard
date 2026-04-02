/**
 * @fileoverview Tests for Scope Conflict Detection
 * Tests the scope conflict detection functionality for multi-agent workflows
 * @author @darianrosebrook
 */

// Create a chalk mock that handles chaining (chalk.blue(), chalk.red.bold(), etc.)
const chalkHandler = {
  get(target, prop) {
    if (typeof prop === 'string') {
      // Return a function that returns its argument (passthrough)
      const fn = (...args) => args.join(' ');
      // Make the function itself chainable
      return new Proxy(fn, {
        get(fnTarget, fnProp) {
          if (fnProp === 'call' || fnProp === 'apply' || fnProp === 'bind') {
            return fnTarget[fnProp].bind(fnTarget);
          }
          return new Proxy((...args) => args.join(' '), chalkHandler);
        },
      });
    }
    return target[prop];
  },
};
const mockChalk = new Proxy({}, chalkHandler);

// Mock chalk before any module that uses it gets loaded
jest.mock('chalk', () => mockChalk);

// Mock fs-extra
jest.mock('fs-extra');

// Mock js-yaml with real load/dump but as jest.fn for spy capability
jest.mock('js-yaml', () => ({
  load: jest.fn(),
  dump: jest.fn(),
}));

// Mock detection to provide a stable project root
jest.mock('../src/utils/detection', () => ({
  findProjectRoot: jest.fn(() => '/mock/project'),
}));

// Mock spec-types to avoid its chalk dependency chain
jest.mock('../src/constants/spec-types', () => ({
  SPEC_TYPES: {
    feature: { label: 'Feature', description: 'Feature spec' },
    bugfix: { label: 'Bugfix', description: 'Bug fix spec' },
  },
}));

// Mock error-handler for command tests
jest.mock('../src/error-handler', () => ({
  safeAsync: jest.fn(async (operation) => {
    return await operation();
  }),
  outputResult: jest.fn((data) => data),
  isJsonOutput: jest.fn(() => false),
  formatJsonOutput: jest.fn((data) => JSON.stringify(data)),
}));

// Mock promise-utils (used by specs.js)
jest.mock('../src/utils/promise-utils', () => ({
  question: jest.fn(),
  closeReadline: jest.fn(),
}));

// Mock spec-validation (used by validate.js)
jest.mock('../src/validation/spec-validation', () => ({
  validateWorkingSpecWithSuggestions: jest.fn(() => ({
    valid: true,
    errors: [],
    warnings: [],
  })),
}));

describe('Scope Conflict Detection', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset module cache so each test gets fresh requires
    jest.resetModules();

    // Re-apply mocks that were cleared by resetModules
    // (jest.mock calls at file top are re-applied automatically by Jest)

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
      const fs = require('fs-extra');
      const yaml = require('js-yaml');
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const spec1 = {
        id: 'auth-spec',
        scope: { in: ['src/auth/', 'src/common/'] },
      };
      const spec2 = {
        id: 'user-spec',
        scope: { in: ['src/users/', 'src/common/'] },
      };

      const mockRegistry = {
        specs: {
          'auth-spec': { path: 'auth-spec.yaml' },
          'user-spec': { path: 'user-spec.yaml' },
        },
      };

      // loadSpecsRegistry checks pathExists then readJson
      fs.pathExists.mockResolvedValue(true);
      fs.readJson.mockResolvedValue(mockRegistry);
      // checkScopeConflicts reads each spec file with fs.readFile
      fs.readFile.mockResolvedValueOnce('spec1 yaml content').mockResolvedValueOnce('spec2 yaml content');
      yaml.load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['auth-spec', 'user-spec']);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toEqual({
        spec1: 'auth-spec',
        spec2: 'user-spec',
        conflicts: ['src/common/ \u2194 src/common/'],
        severity: 'warning',
      });
    });

    test('should handle specs without scope definitions', async () => {
      const fs = require('fs-extra');
      const yaml = require('js-yaml');
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const spec1 = { id: 'no-scope-spec' };
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
      fs.readJson.mockResolvedValue(mockRegistry);
      fs.readFile.mockResolvedValueOnce('spec1 content').mockResolvedValueOnce('spec2 content');
      yaml.load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['no-scope-spec', 'scoped-spec']);

      expect(conflicts).toHaveLength(0);
    });

    test('should handle complex scope patterns', async () => {
      const fs = require('fs-extra');
      const yaml = require('js-yaml');
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
          in: ['src/auth/login.js', 'src/admin/**/*.js'],
        },
      };

      const mockRegistry = {
        specs: {
          'complex-spec1': { path: 'complex-spec1.yaml' },
          'complex-spec2': { path: 'complex-spec2.yaml' },
        },
      };

      fs.pathExists.mockResolvedValue(true);
      fs.readJson.mockResolvedValue(mockRegistry);
      fs.readFile.mockResolvedValueOnce('spec1 content').mockResolvedValueOnce('spec2 content');
      yaml.load.mockReturnValueOnce(spec1).mockReturnValueOnce(spec2);

      const conflicts = await checkScopeConflicts(['complex-spec1', 'complex-spec2']);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].conflicts).toContain('src/auth/**/*.js \u2194 src/auth/login.js');
    });

    test('should handle empty spec arrays', async () => {
      const { checkScopeConflicts } = require('../src/utils/spec-resolver');

      const conflicts = await checkScopeConflicts([]);

      expect(conflicts).toHaveLength(0);
    });

    test('should handle single spec', async () => {
      const fs = require('fs-extra');
      const yaml = require('js-yaml');
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
      fs.readJson.mockResolvedValue(mockRegistry);
      fs.readFile.mockResolvedValueOnce('spec1 content');
      yaml.load.mockReturnValueOnce(spec1);

      const conflicts = await checkScopeConflicts(['single-spec']);

      expect(conflicts).toHaveLength(0);
    });
  });

  describe('Specs Conflicts Command', () => {
    test('should call scope conflict detection', async () => {
      // Mock checkScopeConflicts at the module level before requiring specs
      const mockConflicts = [
        {
          spec1: 'spec1',
          spec2: 'spec2',
          conflicts: ['src/auth/ \u2194 src/auth/'],
          severity: 'warning',
        },
      ];

      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      // Set up fs mocks for loadSpecsRegistry in specs.js
      const fs = require('fs-extra');
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(mockRegistry));

      // Mock spec-resolver's checkScopeConflicts
      const specResolver = require('../src/utils/spec-resolver');
      specResolver.checkScopeConflicts = jest.fn().mockResolvedValue(mockConflicts);

      // Mock loadSpecsRegistry on the specs module
      const specsModule = require('../src/commands/specs');
      specsModule.loadSpecsRegistry = jest.fn().mockResolvedValue(mockRegistry);

      // The specsCommand function uses its own loadSpecsRegistry (local scope),
      // so we need to also mock the fs calls it makes internally
      const { specsCommand } = specsModule;

      const result = await specsCommand('conflicts', {});

      expect(specResolver.checkScopeConflicts).toHaveBeenCalledWith([
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
      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
          spec2: { path: 'spec2.yaml' },
        },
      };

      const fs = require('fs-extra');
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(mockRegistry));

      const specResolver = require('../src/utils/spec-resolver');
      specResolver.checkScopeConflicts = jest.fn().mockResolvedValue([]);

      const specsModule = require('../src/commands/specs');
      specsModule.loadSpecsRegistry = jest.fn().mockResolvedValue(mockRegistry);

      const { specsCommand } = specsModule;
      const result = await specsCommand('conflicts', {});

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No scope conflicts detected')
      );

      expect(result.conflictCount).toBe(0);
    });

    test('should handle fewer than 2 specs', async () => {
      const mockRegistry = {
        specs: {
          spec1: { path: 'spec1.yaml' },
        },
      };

      const fs = require('fs-extra');
      fs.pathExists.mockResolvedValue(true);
      fs.readFile.mockResolvedValue(JSON.stringify(mockRegistry));

      const specsModule = require('../src/commands/specs');
      specsModule.loadSpecsRegistry = jest.fn().mockResolvedValue(mockRegistry);

      const { specsCommand } = specsModule;
      const result = await specsCommand('conflicts', {});

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('No scope conflicts possible with fewer than 2 specs')
      );

      expect(result.conflictCount).toBe(0);
    });
  });

  describe('Validation Integration', () => {
    test('should include scope conflicts in validation output', async () => {
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

      const mockConflicts = [
        {
          spec1: 'test-spec',
          spec2: 'other-spec',
          conflicts: ['src/auth/ \u2194 src/auth/'],
        },
      ];

      // validateCommand captures its deps at module load time via require().
      // jest.resetModules() clears the cache, but mutating the module exports
      // after require() won't affect validate.js's captured references.
      // Instead, we must intercept the module BEFORE validate.js loads it.
      // jest.doMock is scoped to the current test and works after resetModules.
      jest.doMock('../src/utils/spec-resolver', () => {
        const actual = jest.requireActual('../src/utils/spec-resolver');
        return {
          ...actual,
          resolveSpec: jest.fn().mockResolvedValue(mockResolved),
          checkMultiSpecStatus: jest.fn().mockResolvedValue({
            specCount: 2,
            registry: {
              specs: {
                'test-spec': { path: 'test-spec.yaml' },
                'other-spec': { path: 'other-spec.yaml' },
              },
            },
          }),
          checkScopeConflicts: jest.fn().mockResolvedValue(mockConflicts),
        };
      });

      const { validateCommand } = require('../src/commands/validate');
      // Use JSON format to capture the structured result including featureValidation
      await validateCommand(null, { specId: 'test-spec', format: 'json' });

      // validateCommand collects scope conflicts into featureValidation in the JSON output.
      // In text mode, scope conflicts are stored but not displayed when validation passes
      // (implementation gap — the display code only shows them in the result object).
      const jsonOutput = console.log.mock.calls.find((call) => {
        try { const parsed = JSON.parse(call[0]); return parsed.featureValidation; } catch { return false; }
      });
      expect(jsonOutput).toBeDefined();
      const result = JSON.parse(jsonOutput[0]);
      expect(result.featureValidation).toBeDefined();
      expect(result.featureValidation.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ message: 'Scope conflicts detected with other specs' }),
        ])
      );
    });
  });
});
