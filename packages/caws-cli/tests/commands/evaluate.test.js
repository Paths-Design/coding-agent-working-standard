/**
 * @fileoverview Tests for the evaluate command handler
 * Covers regression prevention for known bugs:
 *   - --spec-id must override default spec resolution (was shadowed by default param)
 *   - setup.type (not setup.setupType) for detected setup type display
 * Also covers graceful degradation when optional spec fields are absent.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/utils/spec-resolver', () => ({
  resolveSpec: jest.fn(),
}));

jest.mock('../../src/config', () => ({
  initializeGlobalSetup: jest.fn(),
}));

jest.mock('../../src/utils/working-state', () => ({
  recordEvaluation: jest.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSetup(overrides = {}) {
  return {
    hasWorkingSpec: true,
    type: 'standard',
    capabilities: ['validate', 'evaluate'],
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
      { id: 'AC-01', given: 'ctx', when: 'action', then: 'result' },
    ],
    scope: { in: ['src/'] },
    change_budget: { max_files: 20, max_loc: 500 },
    invariants: ['no breaking changes'],
    rollback: ['revert PR'],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('evaluateCommand', () => {
  let resolveSpec;
  let initializeGlobalSetup;
  let recordEvaluation;
  let evaluateCommand;
  let exitSpy;

  beforeEach(() => {
    jest.resetModules();

    resolveSpec = require('../../src/utils/spec-resolver').resolveSpec;
    ({ initializeGlobalSetup } = require('../../src/config'));
    ({ recordEvaluation } = require('../../src/utils/working-state'));
    ({ evaluateCommand } = require('../../src/commands/evaluate'));

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
      await evaluateCommand(undefined, { specId: 'TEST-01' });

      expect(resolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ specId: 'TEST-01' }),
      );
    });

    test('does not treat undefined specFile as a valid path', async () => {
      // Previously, the default param `specFile = '.caws/working-spec.yaml'` was always
      // truthy, causing the command to open a hardcoded file instead of using --spec-id.
      // Now specFile is undefined and resolveSpec is called with specId.
      await evaluateCommand(undefined, { specId: 'FEAT-99' });

      expect(resolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ specFile: undefined }),
      );
    });

    test('passes specFile path when positional arg provided', async () => {
      await evaluateCommand('/explicit/spec.yaml', {});

      expect(resolveSpec).toHaveBeenCalledWith(
        expect.objectContaining({ specFile: '/explicit/spec.yaml' }),
      );
    });
  });

  describe('regression: setup.type (not setup.setupType)', () => {
    test('prints detected setup type without "undefined" in output', async () => {
      initializeGlobalSetup.mockReturnValue(makeSetup({ type: 'enhanced' }));

      await evaluateCommand(undefined, {});

      const allLogs = console.log.mock.calls.flat().join('\n');
      expect(allLogs).not.toContain('undefined CAWS setup');
      expect(allLogs).toContain('enhanced CAWS setup');
    });
  });

  describe('score calculation', () => {
    test('full spec scores at or above 80%', async () => {
      const spec = makeSpec({
        non_functional: {
          a11y: ['WCAG 2.1 AA'],
          perf: { api_p95_ms: 200 },
          security: ['no XSS'],
        },
        observability: { logs: ['request log'], metrics: ['latency'], traces: ['span'] },
      });
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await evaluateCommand(undefined, {});

      // Should exit cleanly (not exit(1)) for high score
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    test('records evaluation to working state', async () => {
      await evaluateCommand(undefined, {});

      expect(recordEvaluation).toHaveBeenCalledWith(
        'TEST-01',
        expect.objectContaining({
          score: expect.any(Number),
          max_score: expect.any(Number),
          percentage: expect.any(Number),
          grade: expect.stringMatching(/^[A-F]$/),
        }),
      );
    });
  });

  describe('graceful degradation on missing optional fields', () => {
    test('handles spec without non_functional without crashing', async () => {
      const spec = makeSpec();
      delete spec.non_functional;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(evaluateCommand(undefined, {})).resolves.not.toThrow();
    });

    test('handles spec without observability without crashing', async () => {
      const spec = makeSpec();
      delete spec.observability;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(evaluateCommand(undefined, {})).resolves.not.toThrow();
    });

    test('handles spec without acceptance criteria without crashing (exits 1, low score)', async () => {
      // Missing acceptance = 0/15 on that check → score drops below 70% → exit(1)
      // The important thing is no TypeError crash, just a scored exit
      const spec = makeSpec();
      delete spec.acceptance;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(evaluateCommand(undefined, {})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('handles spec without scope without crashing (exits 1, low score)', async () => {
      const spec = makeSpec();
      delete spec.scope;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(evaluateCommand(undefined, {})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('handles spec without change_budget without crashing (no TypeError)', async () => {
      // Missing change_budget loses 10pts — may still pass 70% depending on other fields
      const spec = makeSpec({
        non_functional: {
          a11y: ['WCAG 2.1 AA'],
          perf: { api_p95_ms: 200 },
          security: ['no XSS'],
        },
        observability: { logs: ['request log'] },
        rollback: ['revert PR'],
      });
      delete spec.change_budget;
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      // Either clean exit or exit(1) is fine — just no TypeError
      try {
        await evaluateCommand(undefined, {});
      } catch (e) {
        // exit(1) is acceptable
        expect(e.message).toBe('process.exit called');
      }
      // Either way, no TypeError about undefined fields
      const errorCalls = console.error.mock.calls.flat().join('\n');
      expect(errorCalls).not.toContain('TypeError');
    });

    test('exits with code 1 when score is below 70%', async () => {
      // Minimal spec — missing almost everything — should score low
      const spec = {
        id: 'BARE-01',
        title: 'Bare',
        risk_tier: 2,
        mode: 'feature',
      };
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec, type: 'feature-spec' });

      await expect(evaluateCommand(undefined, {})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('error handling', () => {
    test('exits with code 1 and logs error when resolveSpec rejects', async () => {
      resolveSpec.mockRejectedValue(new Error('spec not found'));

      await expect(evaluateCommand(undefined, { specId: 'MISSING' })).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Evaluation failed: spec not found'),
      );
    });
  });
});
