/**
 * @fileoverview Tests for the burnup command handler
 * Covers regression prevention for known bugs:
 *   - deriveBudget() must be awaited (was called synchronously, returned Promise)
 *   - resolved.path must be used (not resolved.specPath)
 *   - --spec-id must route correctly through resolveSpec
 * Also covers graceful degradation when optional spec fields are missing.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('fs-extra', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue(''),
}));

jest.mock('js-yaml', () => ({
  load: jest.fn(),
}));

jest.mock('../../src/utils/spec-resolver', () => ({
  resolveSpec: jest.fn(),
}));

jest.mock('../../src/budget-derivation', () => ({
  deriveBudget: jest.fn(),
  generateBurnupReport: jest.fn().mockReturnValue('mock burn-up report'),
}));

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSpec(overrides = {}) {
  return {
    id: 'TEST-01',
    title: 'Test Spec',
    risk_tier: 2,
    mode: 'feature',
    ...overrides,
  };
}

function makeDerivedBudget(overrides = {}) {
  return {
    baseline: { max_files: 50, max_loc: 2000 },
    effective: { max_files: 50, max_loc: 2000 },
    waivers_applied: [],
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('burnupCommand', () => {
  let resolveSpec;
  let deriveBudget;
  let generateBurnupReport;
  let execSync;
  let burnupCommand;
  let exitSpy;

  beforeEach(() => {
    jest.resetModules();

    resolveSpec = require('../../src/utils/spec-resolver').resolveSpec;
    ({ deriveBudget, generateBurnupReport } = require('../../src/budget-derivation'));
    ({ execSync } = require('child_process'));
    ({ burnupCommand } = require('../../src/commands/burnup'));

    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});

    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('regression: deriveBudget must be awaited', () => {
    test('resolves budget correctly when deriveBudget returns a Promise', async () => {
      const spec = makeSpec();
      const budget = makeDerivedBudget();

      resolveSpec.mockResolvedValue({ path: '/project/.caws/specs/TEST-01.yaml', spec });
      // deriveBudget is async — must be awaited or result is a Promise not an object
      deriveBudget.mockResolvedValue(budget);
      execSync.mockReturnValue('');

      await burnupCommand(undefined, { specId: 'TEST-01' });

      // generateBurnupReport receives the resolved budget, not a Promise
      expect(generateBurnupReport).toHaveBeenCalledWith(budget, expect.any(Object));
    });

    test('does not crash when deriveBudget resolves with valid budget', async () => {
      const spec = makeSpec();
      resolveSpec.mockResolvedValue({ path: '/p/.caws/specs/TEST-01.yaml', spec });
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockReturnValue('');

      await expect(burnupCommand(undefined, { specId: 'TEST-01' })).resolves.not.toThrow();
    });
  });

  describe('regression: resolved.path (not resolved.specPath)', () => {
    test('passes dirname of resolved.path to deriveBudget as projectRoot', async () => {
      const spec = makeSpec();
      resolveSpec.mockResolvedValue({ path: '/my/project/.caws/specs/TEST-01.yaml', spec });
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockReturnValue('');

      await burnupCommand(undefined, { specId: 'TEST-01' });

      expect(deriveBudget).toHaveBeenCalledWith(spec, '/my/project/.caws/specs');
    });
  });

  describe('--spec-id routing', () => {
    test('passes specId to resolveSpec when no positional file given', async () => {
      const spec = makeSpec({ id: 'FEAT-99' });
      resolveSpec.mockResolvedValue({ path: '/p/.caws/specs/FEAT-99.yaml', spec });
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockReturnValue('');

      await burnupCommand(undefined, { specId: 'FEAT-99' });

      expect(resolveSpec).toHaveBeenCalledWith({ specId: 'FEAT-99' });
    });

    test('uses positional file directly without calling resolveSpec', async () => {
      const fs = require('fs-extra');
      const yaml = require('js-yaml');
      const spec = makeSpec();

      fs.existsSync.mockReturnValue(true);
      yaml.load.mockReturnValue(spec);
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockReturnValue('');

      await burnupCommand('/explicit/spec.yaml', {});

      expect(resolveSpec).not.toHaveBeenCalled();
      expect(deriveBudget).toHaveBeenCalledWith(spec, '/explicit');
    });
  });

  describe('graceful degradation', () => {
    test('handles missing change_budget field without crashing', async () => {
      // Spec without change_budget — deriveBudget falls back to policy defaults
      const spec = makeSpec(); // no change_budget
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec });
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockReturnValue('');

      await expect(burnupCommand(undefined, { specId: 'TEST-01' })).resolves.not.toThrow();
    });

    test('handles git not available (execSync throws) without crashing', async () => {
      const spec = makeSpec();
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec });
      deriveBudget.mockResolvedValue(makeDerivedBudget());
      execSync.mockImplementation(() => { throw new Error('not a git repo'); });

      await expect(burnupCommand(undefined, { specId: 'TEST-01' })).resolves.not.toThrow();
      // Should still print zero-value fallback message
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Could not analyze git history'),
      );
    });

    test('shows warning when approaching file budget limit (>90%)', async () => {
      const spec = makeSpec();
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec });
      deriveBudget.mockResolvedValue({
        baseline: { max_files: 10, max_loc: 1000 },
        effective: { max_files: 10, max_loc: 1000 },
        waivers_applied: [],
      });

      // 10 files changed out of budget of 10 = 100% → should warn
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--name-only')) return 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n';
        if (cmd.includes('--numstat')) return '5\t2\tfile1\n3\t1\tfile2\n';
        if (cmd.includes('describe')) throw new Error('no tags');
        if (cmd.includes('rev-list')) return 'abc123';
        return '';
      });

      await burnupCommand(undefined, { specId: 'TEST-01' });

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Approaching budget limits'),
      );
    });

    test('shows within-budget message when usage is low', async () => {
      const spec = makeSpec();
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec });
      deriveBudget.mockResolvedValue({
        baseline: { max_files: 50, max_loc: 2000 },
        effective: { max_files: 50, max_loc: 2000 },
        waivers_applied: [],
      });

      // 1 file changed — well within budget
      execSync.mockImplementation((cmd) => {
        if (cmd.includes('--name-only')) return 'one-file.js\n';
        if (cmd.includes('--numstat')) return '10\t2\tone-file.js\n';
        if (cmd.includes('describe')) throw new Error('no tags');
        if (cmd.includes('rev-list')) return 'abc123';
        return '';
      });

      await burnupCommand(undefined, { specId: 'TEST-01' });

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Within budget limits'),
      );
    });

    test('shows applied waivers when spec has waiver_ids', async () => {
      const spec = makeSpec({ waiver_ids: ['WVR-001', 'WVR-002'] });
      resolveSpec.mockResolvedValue({ path: '/p/spec.yaml', spec });
      deriveBudget.mockResolvedValue({
        baseline: { max_files: 50, max_loc: 2000 },
        effective: { max_files: 60, max_loc: 2500 },
        waivers_applied: ['WVR-001', 'WVR-002'],
      });
      execSync.mockReturnValue('');

      await burnupCommand(undefined, { specId: 'TEST-01' });

      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('Waivers Applied'),
      );
    });

    test('exits with code 1 when spec file not found', async () => {
      const fs = require('fs-extra');
      fs.existsSync.mockReturnValue(false);

      await expect(burnupCommand('/nonexistent/spec.yaml', {})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
