/**
 * @fileoverview Tests for the iterate command handler
 * Covers regression prevention for known bugs:
 *   - --spec-id must override default spec resolution (was shadowed by default param)
 *   - setup.type (not setup.setupType) for detected setup type display
 *   - --current-state JSON parse errors are handled gracefully
 * Also covers graceful degradation when optional spec fields are absent.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
}));

jest.mock('../../src/utils/spec-resolver', () => ({
  resolveSpec: jest.fn(),
}));

jest.mock('../../src/config', () => ({
  initializeGlobalSetup: jest.fn(),
}));

jest.mock('../../src/utils/working-state', () => ({
  loadState: jest.fn().mockReturnValue(null),
}));

jest.mock('../../src/sidecars', () => ({
  diagnoseQualityGaps: jest.fn().mockReturnValue({ data: null }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides = {}) {
  return {
    hasWorkingSpec: true,
    type: 'standard',
    capabilities: ['validate', 'iterate'],
    ...overrides,
  };
}

function makeSpec(overrides = {}) {
  return {
    id: 'TEST-01',
    title: 'Test Feature',
    risk_tier: 2,
    mode: 'feature',
    acceptance: [
      { id: 'AC-01', given: 'ctx', when: 'action', then: 'result', status: 'pending' },
    ],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('iterateCommand', () => {
  let resolveSpec;
  let initializeGlobalSetup;
  let iterateCommand;
  let exitSpy;

  beforeEach(() => {
    jest.resetModules();

    resolveSpec = require('../../src/utils/spec-resolver').resolveSpec;
    ({ initializeGlobalSetup } = require('../../src/config'));
    ({ iterateCommand } = require('../../src/commands/iterate'));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    initializeGlobalSetup.mockReturnValue(makeSetup());
    resolveSpec.mockResolvedValue({
      path: '/p/.caws/specs/TEST-01.yaml',
      spec: makeSpec(),
      type: 'feature-spec',
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('regression: --spec-id routing', () => {
    test('passes specId to resolveSpec when no positional file given', async () => {
      await iterateCommand(undefined, { specId: 'TEST-01' });

      expect(resolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ specId: 'TEST-01' }),
      );
    });

    test('does not treat undefined specFile as a valid path', async () => {
      await iterateCommand(undefined, { specId: 'FEAT-99' });

      expect(resolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ specFile: undefined }),
      );
    });
  });

  describe('regression: setup.type (not setup.setupType)', () => {
    test('prints detected setup type without "undefined" in output', async () => {
      initializeGlobalSetup.mockReturnValue(makeSetup({ type: 'enhanced' }));

      await iterateCommand(undefined, {});

      const allLogs = console.log.mock.calls.flat().join('\n');
      expect(allLogs).not.toContain('undefined CAWS setup');
      expect(allLogs).toContain('enhanced CAWS setup');
    });
  });

  describe('regression: --current-state JSON parse error handling', () => {
    test('falls back gracefully when --current-state is invalid JSON', async () => {
      // Should not crash — error is caught and default used
      await expect(
        iterateCommand(undefined, { currentState: 'not-valid-json' }),
      ).resolves.not.toThrow();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Invalid JSON'),
      );
    });

    test('uses parsed state description when --current-state is valid JSON', async () => {
      await iterateCommand(undefined, {
        currentState: JSON.stringify({ description: 'Writing tests' }),
      });

      const allLogs = console.log.mock.calls.flat().join('\n');
      expect(allLogs).toContain('Writing tests');
    });
  });

  describe('guidance generation by mode', () => {
    test.each([
      ['feature', 'Feature Development'],
      ['refactor', 'Refactoring'],
      ['fix', 'Bug Fix'],
      ['doc', 'Documentation'],
      ['chore', 'Maintenance'],
    ])('shows correct phase for mode=%s', async (mode, expectedPhase) => {
      resolveSpec.mockResolvedValue({
        path: '/p/spec.yaml',
        spec: makeSpec({ mode }),
        type: 'feature-spec',
      });

      await iterateCommand(undefined, {});

      const allLogs = console.log.mock.calls.flat().join('\n');
      expect(allLogs).toContain(expectedPhase);
    });
  });

  describe('working state overlay', () => {
    test('overlays evidence-based completed steps when state exists', async () => {
      const { loadState } = require('../../src/utils/working-state');
      loadState.mockReturnValue({
        phase: 'implementation',
        validation: { passed: true, grade: 'B' },
        evaluation: { percentage: 85, grade: 'B' },
        gates: { passed: true, context: 'full' },
        files_touched: ['src/foo.js'],
      });

      await iterateCommand(undefined, {});

      const allLogs = console.log.mock.calls.flat().join('\n');
      expect(allLogs).toContain('Implementation');
      expect(allLogs).toContain('Validation passed');
    });

    test('handles null working state gracefully', async () => {
      const { loadState } = require('../../src/utils/working-state');
      loadState.mockReturnValue(null);

      await expect(iterateCommand(undefined, {})).resolves.not.toThrow();
    });
  });

  describe('graceful degradation on missing optional fields', () => {
    test('handles spec without acceptance criteria without crashing', async () => {
      const spec = makeSpec();
      delete spec.acceptance;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(iterateCommand(undefined, {})).resolves.not.toThrow();
    });

    test('handles spec without contracts without crashing', async () => {
      const spec = makeSpec({ mode: 'refactor' });
      delete spec.contracts;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(iterateCommand(undefined, {})).resolves.not.toThrow();
    });

    test('handles spec without change_budget without crashing', async () => {
      const spec = makeSpec();
      delete spec.change_budget;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(iterateCommand(undefined, {})).resolves.not.toThrow();
    });
  });

  describe('error handling', () => {
    test('exits with code 1 and logs error when resolveSpec rejects', async () => {
      resolveSpec.mockRejectedValue(new Error('spec not found'));

      await expect(iterateCommand(undefined, { specId: 'MISSING' })).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Iteration guidance failed: spec not found'),
      );
    });
  });
});
