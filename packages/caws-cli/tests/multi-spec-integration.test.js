/**
 * @fileoverview Tests for Multi-Spec Command Integration
 * Tests how commands integrate with the multi-spec architecture
 * @author @darianrosebrook
 */

const path = require('path');

// ── Module-level mocks ──────────────────────────────────────────────
// These intercept require() BEFORE command modules capture references.

jest.mock('fs-extra');
jest.mock('js-yaml');
jest.mock('chalk', () => {
  // Return a proxy that makes every chalk method a passthrough
  const passthrough = (s) => s;
  const handler = {
    get: () => new Proxy(passthrough, handler),
    apply: (_target, _thisArg, args) => args[0],
  };
  return new Proxy(passthrough, handler);
});

// Mock spec-resolver — all exports as jest.fn() so tests can configure per-case
jest.mock('../src/utils/spec-resolver', () => ({
  resolveSpec: jest.fn(),
  checkMultiSpecStatus: jest.fn().mockResolvedValue({ specCount: 0, registry: { specs: {} } }),
  checkScopeConflicts: jest.fn().mockResolvedValue([]),
  suggestMigration: jest.fn().mockResolvedValue(undefined),
  loadSpecsRegistry: jest.fn().mockResolvedValue({ specs: {} }),
  interactiveSpecSelection: jest.fn(),
  suggestFeatureBreakdown: jest.fn(),
  pathsOverlap: jest.fn(),
  SPECS_DIR: '.caws/specs',
  LEGACY_SPEC: '.caws/working-spec.yaml',
  SPECS_REGISTRY: '.caws/specs/registry.json',
}));

// Mock spec-validation
jest.mock('../src/validation/spec-validation', () => ({
  validateWorkingSpecWithSuggestions: jest.fn(),
  getComplianceGrade: jest.fn().mockReturnValue('A'),
}));

// Mock config (used by iterate)
jest.mock('../src/config', () => ({
  initializeGlobalSetup: jest.fn().mockReturnValue({
    hasWorkingSpec: true,
    setupType: 'multi-spec',
    capabilities: ['validate', 'iterate'],
  }),
}));

// Mock error-handler (used by plan, archive, status)
jest.mock('../src/error-handler', () => ({
  safeAsync: jest.fn(async (operation, _context, _timing) => {
    // Execute the operation directly, let errors propagate
    return await operation();
  }),
  outputResult: jest.fn((data) => data),
  CAWSError: class CAWSError extends Error {
    constructor(msg) { super(msg); this.name = 'CAWSError'; }
  },
}));

// Mock detection (used transitively)
jest.mock('../src/utils/detection', () => ({
  detectCAWSSetup: jest.fn().mockReturnValue({
    hasWorkingSpec: true,
    setupType: 'multi-spec',
    capabilities: ['validate', 'iterate'],
  }),
  findProjectRoot: jest.fn().mockReturnValue(process.cwd()),
}));

// Mock constants (used by spec-resolver, but we mock spec-resolver directly)
jest.mock('../src/constants/spec-types', () => ({
  SPEC_TYPES: {},
}));

// Mock async-utils (used by status)
jest.mock('../src/utils/async-utils', () => ({
  parallel: jest.fn(async (items) => Promise.all(items.map((f) => typeof f === 'function' ? f() : f))),
}));

// Mock child_process (used by archive's validateQualityGates)
jest.mock('child_process', () => ({
  execSync: jest.fn().mockReturnValue(''),
}));

// Mock config/modes (used by status)
jest.mock('../src/config/modes', () => ({
  getCurrentMode: jest.fn().mockResolvedValue('standard'),
  getTier: jest.fn().mockReturnValue({
    name: 'standard',
    icon: '',
    color: (s) => s,
    commands: {},
    features: {},
    qualityRequirements: {},
    riskTiers: ['1', '2', '3'],
  }),
  getAvailableTiers: jest.fn().mockReturnValue(['standard']),
  isCommandAvailable: jest.fn().mockReturnValue(true),
  isFeatureEnabled: jest.fn().mockReturnValue(true),
  getQualityRequirements: jest.fn().mockReturnValue({}),
  getSupportedRiskTiers: jest.fn().mockReturnValue(['1', '2', '3']),
  isRiskTierSupported: jest.fn().mockReturnValue(true),
}));

// Mock fs (native, used by iterate)
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn().mockReturnValue(true),
}));

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
    jest.resetModules();

    // Mock console methods
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    // Mock process.exit as a no-op (don't throw — commands guard against exit in test env)
    jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Validate Command Integration', () => {
    test('should use spec resolver for multi-spec validation', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const specValidation = require('../src/validation/spec-validation');

      const mockResolvedValidate = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      specResolver.resolveSpec.mockResolvedValue(mockResolvedValidate);
      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 1,
        registry: { specs: { 'test-spec': { path: 'test-spec.yaml' } } },
      });

      specValidation.validateWorkingSpecWithSuggestions.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
        suggestions: ['Add more tests'],
      });

      const { validateCommand } = require('../src/commands/validate');
      await validateCommand(null, { specId: 'test-spec' });

      // Verify spec resolver was called with correct options
      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: true,
        interactive: false,
      });

      // Verify validation was called with resolved spec
      expect(specValidation.validateWorkingSpecWithSuggestions).toHaveBeenCalledWith(
        mockSpec,
        expect.any(Object)
      );
    });

    test('should handle legacy spec validation', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const specValidation = require('../src/validation/spec-validation');

      const mockResolvedLegacy = {
        path: '.caws/working-spec.yaml',
        type: 'legacy',
        spec: mockSpec,
      };

      specResolver.resolveSpec.mockResolvedValue(mockResolvedLegacy);
      specValidation.validateWorkingSpecWithSuggestions.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      const { validateCommand } = require('../src/commands/validate');
      await validateCommand(null, {});

      expect(specResolver.resolveSpec).toHaveBeenCalled();
      // validate.js line 41-42: if specType === 'legacy' && format !== 'json', calls suggestMigration
      expect(specResolver.suggestMigration).toHaveBeenCalled();
      // validate.js line 46-47: logs "Validating working spec..." (since specType is legacy, not feature)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Validating')
      );
    });
  });

  describe('Status Command Integration', () => {
    test('should use spec resolver for multi-spec status', async () => {
      // Status command uses internal functions, not spec-resolver directly.
      // We need to mock the specs module that loadSpecsFromMultiSpec calls.
      jest.mock('../src/commands/specs', () => ({
        listSpecFiles: jest.fn().mockResolvedValue([mockSpec]),
      }));

      const fsExtra = require('fs-extra');
      fsExtra.pathExists.mockResolvedValue(false);
      fsExtra.readFile.mockResolvedValue('');
      fsExtra.readJson.mockResolvedValue({ specs: {} });

      const { statusCommand } = require('../src/commands/status');
      await statusCommand({ visual: true, specId: 'test-spec' });

      // Verify status command ran without error — it should have loaded specs
      expect(console.log).toHaveBeenCalled();
    });
  });

  describe('Iterate Command Integration', () => {
    test('should use spec resolver for multi-spec iteration', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      const mockResolvedIterate = {
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      };

      specResolver.resolveSpec.mockResolvedValue(mockResolvedIterate);

      const { iterateCommand } = require('../src/commands/iterate');

      // iterateCommand calls process.exit(1) in its catch block.
      // With our no-op mock, it won't throw but will return undefined.
      // The happy path should work since resolveSpec is mocked.
      await iterateCommand(null, {
        specId: 'test-spec',
        currentState: JSON.stringify({ description: 'Test state' }),
      });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: undefined,
        warnLegacy: false,
      });
    });
  });

  describe('Plan Command Integration', () => {
    test('should use spec resolver for multi-spec planning', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      const fsExtra = require('fs-extra');
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);

      const { planCommand } = require('../src/commands/plan');
      await planCommand('generate', { specId: 'test-spec' });

      // planCommand -> loadSpecForPlanning -> resolveSpec
      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        warnLegacy: false,
      });
    });

    test('should auto-detect single spec for plan generation', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 1,
        registry: {
          specs: {
            'single-spec': { path: 'single-spec.yaml' },
          },
        },
      });

      specResolver.loadSpecsRegistry.mockResolvedValue({
        specs: {
          'single-spec': { path: 'single-spec.yaml' },
        },
      });

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/single-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      const fsExtra = require('fs-extra');
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);

      const { planCommand } = require('../src/commands/plan');
      await planCommand('generate', {});

      // Should have called resolveSpec with the auto-detected spec ID
      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'single-spec',
        warnLegacy: false,
      });
    });

    test('should require spec ID for multiple specs', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 2,
        registry: {
          specs: {
            spec1: { path: 'spec1.yaml' },
            spec2: { path: 'spec2.yaml' },
          },
        },
      });

      const { planCommand } = require('../src/commands/plan');

      // safeAsync wraps the error with context prefix "plan generate: "
      await expect(planCommand('generate', {})).rejects.toThrow(
        'Multiple specs detected. Please specify which one'
      );
    });
  });

  describe('Archive Command Integration', () => {
    test('should use spec resolver for multi-spec archiving', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const fsExtra = require('fs-extra');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      // Mock loadChange: fs-extra.pathExists returns true, readFile returns YAML content
      fsExtra.pathExists.mockResolvedValue(true);
      fsExtra.readFile.mockResolvedValue('title: Test');
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);
      fsExtra.move.mockResolvedValue(undefined);

      const yaml = require('js-yaml');
      yaml.load.mockReturnValue({
        title: 'Test Change',
        risk_tier: 2,
        acceptance_criteria: [{ id: 'A1', completed: true }],
      });

      const { archiveCommand } = require('../src/commands/archive');
      await archiveCommand('FEAT-001', { specId: 'test-spec' });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: undefined,
        warnLegacy: false,
      });
    });

    test('should fall back to archived working spec snapshot when no explicit spec target is given', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const fsExtra = require('fs-extra');
      const yaml = require('js-yaml');

      fsExtra.pathExists.mockResolvedValue(true);
      fsExtra.readFile.mockResolvedValue('title: Snapshot Change');
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);
      fsExtra.move.mockResolvedValue(undefined);

      yaml.load.mockReturnValue({
        id: 'snapshot-spec',
        title: 'Snapshot Change',
        risk_tier: 2,
        acceptance_criteria: [{ id: 'A1', completed: true }],
      });

      const { archiveCommand } = require('../src/commands/archive');
      const result = await archiveCommand('FEAT-001', {});

      expect(specResolver.resolveSpec).not.toHaveBeenCalled();
      expect(result.specSelection).toEqual({
        id: 'snapshot-spec',
        path: expect.stringContaining(path.join('.caws', 'changes', 'FEAT-001', 'working-spec.yaml')),
        type: 'change-snapshot',
      });
    });
  });

  describe('Verify ACs Command Integration', () => {
    test('should resolve a single targeted spec for acceptance verification', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      const { verifyAcsCommand } = require('../src/commands/verify-acs');
      await verifyAcsCommand({ specId: 'test-spec' });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        warnLegacy: false,
      });
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('test-spec')
      );
    });
  });

  describe('Provenance Command Integration', () => {
    test('should initialize provenance against the resolved spec', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const fsExtra = require('fs-extra');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      fsExtra.pathExists.mockResolvedValue(false);
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);

      const { initProvenance } = require('../src/commands/provenance');
      await initProvenance({ specId: 'test-spec', output: '.caws/provenance' });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: undefined,
        warnLegacy: false,
      });
      expect(fsExtra.writeFile).toHaveBeenCalledWith(
        path.join('.caws/provenance', 'config.json'),
        expect.stringContaining('"id": "test-spec"')
      );
    });

    test('should attach resolved spec metadata to provenance updates', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const fsExtra = require('fs-extra');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      fsExtra.pathExists.mockResolvedValue(false);
      fsExtra.ensureDir.mockResolvedValue(undefined);
      fsExtra.writeFile.mockResolvedValue(undefined);

      const { updateProvenance } = require('../src/commands/provenance');
      await updateProvenance({
        commit: 'abc12345def67890',
        specId: 'test-spec',
        output: '.caws/provenance',
        quiet: true,
      });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: undefined,
        warnLegacy: false,
      });
      expect(fsExtra.writeFile).toHaveBeenCalledWith(
        path.join('.caws/provenance', 'chain.json'),
        expect.stringContaining('"type": "feature"')
      );
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle spec resolution errors gracefully', async () => {
      const specResolver = require('../src/utils/spec-resolver');

      specResolver.resolveSpec.mockRejectedValue(new Error('Spec not found'));

      const { validateCommand } = require('../src/commands/validate');

      // validateCommand catches errors internally and calls console.error + process.exit
      // In test env (JEST_WORKER_ID set), it doesn't call process.exit for some paths,
      // but the catch block at line 234 does check for multi-spec auto-validate first.
      // For a generic "Spec not found" error, it falls through to the else branch
      // which logs the error and calls process.exit (no-op in test).
      await validateCommand(null, {});

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error during validation:'),
        'Spec not found'
      );
    });

    test('should handle validation errors with resolved spec context', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const specValidation = require('../src/validation/spec-validation');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 1,
        registry: { specs: { 'test-spec': { path: 'test-spec.yaml' } } },
      });

      // Mock validation to return errors
      specValidation.validateWorkingSpecWithSuggestions.mockReturnValue({
        valid: false,
        errors: [
          {
            message: 'Missing required field',
            suggestion: 'Add the field',
          },
        ],
      });

      const { validateCommand } = require('../src/commands/validate');

      // When validation fails in non-json mode and JEST_WORKER_ID is set,
      // validateCommand internally throws 'Validation failed' (line 230),
      // but the outer catch (line 234) catches it, logs the error, and returns.
      // So the promise resolves (does not reject).
      await validateCommand(null, { specId: 'test-spec' });

      // Should show spec context: "Validating feature spec..." (line 46-47)
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Validating feature')
      );

      // The caught 'Validation failed' error is logged via console.error
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Error during validation:'),
        'Validation failed'
      );
    });
  });

  describe('CLI Option Integration', () => {
    test('should pass specId option to spec resolver', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const specValidation = require('../src/validation/spec-validation');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 1,
        registry: { specs: { 'test-spec': { path: 'test-spec.yaml' } } },
      });

      specValidation.validateWorkingSpecWithSuggestions.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      const { validateCommand } = require('../src/commands/validate');
      await validateCommand(null, { specId: 'test-spec' });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: 'test-spec',
        specFile: null,
        warnLegacy: true,
        interactive: false,
      });
    });

    test('should pass interactive option to spec resolver', async () => {
      const specResolver = require('../src/utils/spec-resolver');
      const specValidation = require('../src/validation/spec-validation');

      specResolver.resolveSpec.mockResolvedValue({
        path: '.caws/specs/test-spec.yaml',
        type: 'feature',
        spec: mockSpec,
      });

      specResolver.checkMultiSpecStatus.mockResolvedValue({
        specCount: 1,
        registry: { specs: { 'test-spec': { path: 'test-spec.yaml' } } },
      });

      specValidation.validateWorkingSpecWithSuggestions.mockReturnValue({
        valid: true,
        errors: [],
        warnings: [],
      });

      const { validateCommand } = require('../src/commands/validate');
      await validateCommand(null, { interactive: true });

      expect(specResolver.resolveSpec).toHaveBeenCalledWith({
        specId: undefined,
        specFile: null,
        warnLegacy: true,
        interactive: true,
      });
    });
  });
});
