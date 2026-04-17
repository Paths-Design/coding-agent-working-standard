/**
 * @fileoverview CAWSFIX-06 — contracts warning on feature spec creation
 *
 * Covers acceptance criteria A3 and A4 from .caws/specs/CAWSFIX-06.yaml:
 *   A3: `caws specs create <id> --type feature` with empty contracts:
 *       - The spec is created successfully (no throw).
 *       - A warning is emitted to stderr (console.warn) mentioning the spec
 *         id, mode=feature, and suggesting `caws specs update <id>` to add
 *         a contract reference.
 *       - The command does NOT fail.
 *   A4: `caws specs create <id> --type fix` (or any non-feature mode):
 *       - No contracts-related warning is emitted.
 *
 * Follows the mocking pattern established in tests/spec-creation.test.js —
 * fs-extra and worktree-manager are mocked; js-yaml delegates to the real
 * implementation; the real createSpec is exercised end-to-end through its
 * in-memory write-then-read cycle.
 *
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

// Mock fs-extra to control spec file writes
jest.mock('fs-extra');

// Delegate js-yaml dump/load to the real implementation so round-tripping works
jest.mock('js-yaml', () => {
  const actualYaml = jest.requireActual('js-yaml');
  return {
    ...actualYaml,
    dump: jest.fn((...args) => actualYaml.dump(...args)),
    load: jest.fn((...args) => actualYaml.load(...args)),
  };
});

// Mock worktree-manager to avoid git calls
const mockWorktreeRegistry = { version: 1, worktrees: {} };
jest.mock('../src/worktree/worktree-manager', () => ({
  loadRegistry: jest.fn(() => mockWorktreeRegistry),
  getRepoRoot: jest.fn(() => '/mock/repo'),
}));

describe('CAWSFIX-06: contracts warning on feature spec creation', () => {
  let warnSpy;
  let errorSpy;
  let logSpy;
  let writtenFiles;

  beforeEach(() => {
    jest.clearAllMocks();
    mockWorktreeRegistry.worktrees = {};

    // Ensure fs mock methods are jest mock functions
    if (!jest.isMockFunction(fs.writeFile)) {
      fs.writeFile = jest.fn();
    }
    if (!jest.isMockFunction(fs.readFile)) {
      fs.readFile = jest.fn();
    }

    // In-memory file store used by all mock writes/reads
    writtenFiles = new Map();
    fs.pathExists.mockResolvedValue(false); // No pre-existing spec
    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeFile.mockImplementation(async (filePath, content) => {
      const resolvedPath = path.resolve(filePath);
      const fileName = path.basename(filePath);
      writtenFiles.set(resolvedPath, content);
      writtenFiles.set(filePath, content);
      writtenFiles.set(fileName, content);
    });
    fs.readFile.mockImplementation(async (filePath) => {
      const resolvedPath = path.resolve(filePath);
      const fileName = path.basename(filePath);
      return (
        writtenFiles.get(resolvedPath) ||
        writtenFiles.get(filePath) ||
        writtenFiles.get(fileName) ||
        ''
      );
    });

    // Spy on console methods
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ------------------------------------------------------------------
  // A3: feature mode + empty contracts → warning (but spec is created)
  // ------------------------------------------------------------------
  describe('A3: feature spec with empty contracts emits warning', () => {
    test('createSpec succeeds (spec is created, not rejected)', async () => {
      const { createSpec } = require('../src/commands/specs');
      const result = await createSpec('FEAT-999', {
        type: 'feature',
        title: 'Feature without contracts',
        risk_tier: 3,
      });

      expect(result).not.toBeNull();
      expect(result.id).toBe('FEAT-999');
      expect(result.type).toBe('feature');
      // Prove the spec file itself was actually written.
      expect(fs.writeFile).toHaveBeenCalled();
    });

    test('console.warn is invoked with a contracts-related warning', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('FEAT-999', {
        type: 'feature',
        title: 'Feature without contracts',
        risk_tier: 3,
      });

      // Collect all warn messages as plain strings
      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /contracts/i.test(w));
      expect(contractsWarning).toBeDefined();
    });

    test('warning mentions the spec id, mode=feature, and suggests specs update', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('FEAT-999', {
        type: 'feature',
        title: 'Feature without contracts',
        risk_tier: 3,
      });

      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /contracts/i.test(w));
      expect(contractsWarning).toBeDefined();

      // Contains the spec id
      expect(contractsWarning).toMatch(/FEAT-999/);
      // Mentions mode=feature
      expect(contractsWarning).toMatch(/mode=feature/i);
      // Suggests the remediation command
      expect(contractsWarning).toMatch(/caws specs update FEAT-999/);
    });

    test('warning does not cause process.exit or throw', async () => {
      const { createSpec } = require('../src/commands/specs');
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

      await expect(
        createSpec('FEAT-999', {
          type: 'feature',
          title: 'Feature without contracts',
          risk_tier: 3,
        })
      ).resolves.not.toBeNull();

      expect(exitSpy).not.toHaveBeenCalled();
      // console.error is NOT used for this warning (it's non-fatal)
      const errors = errorSpy.mock.calls.map((args) => args.join(' '));
      const contractsError = errors.find((e) => /mode=feature.*contracts/i.test(e));
      expect(contractsError).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // A4: non-feature modes → no warning
  // ------------------------------------------------------------------
  describe('A4: non-feature spec modes do NOT emit contracts warning', () => {
    test('type=fix: no contracts warning', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('FIX-001', {
        type: 'fix',
        title: 'Bug fix without contracts',
        risk_tier: 3,
      });

      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /mode=feature.*contracts/i.test(w));
      expect(contractsWarning).toBeUndefined();
    });

    test('type=refactor: no contracts warning', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('REFACT-001', {
        type: 'refactor',
        title: 'Refactor without contracts',
        risk_tier: 3,
      });

      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /mode=feature.*contracts/i.test(w));
      expect(contractsWarning).toBeUndefined();
    });

    test('type=chore: no contracts warning', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('CHORE-001', {
        type: 'chore',
        title: 'Chore without contracts',
        risk_tier: 3,
      });

      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /mode=feature.*contracts/i.test(w));
      expect(contractsWarning).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // Sanity: warning text does not leak filesystem paths beyond the spec id
  // (non_functional.security invariant from the spec)
  // ------------------------------------------------------------------
  describe('security: warning does not leak filesystem paths', () => {
    test('warning mentions only the spec id, not the full spec file path', async () => {
      const { createSpec } = require('../src/commands/specs');
      await createSpec('FEAT-777', {
        type: 'feature',
        title: 'Sec check feature',
        risk_tier: 3,
      });

      const warnings = warnSpy.mock.calls.map((args) => args.join(' '));
      const contractsWarning = warnings.find((w) => /mode=feature.*contracts/i.test(w));
      expect(contractsWarning).toBeDefined();

      // Must not contain absolute paths like /Users, /mock/repo/.caws/specs, etc.
      expect(contractsWarning).not.toMatch(/\/Users\//);
      expect(contractsWarning).not.toMatch(/\.caws\/specs/);
    });
  });

  // Keep lint happy — logSpy is intentionally created to silence console.log
  // output during tests without asserting on its calls.
  afterAll(() => {
    void logSpy;
  });
});
