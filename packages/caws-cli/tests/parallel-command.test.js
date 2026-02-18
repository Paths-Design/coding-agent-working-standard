/**
 * @fileoverview Smoke tests for CAWS parallel command registration
 * Verifies the parallel command group is registered in the CLI and
 * that all expected subcommands are present.
 */

const path = require('path');
const { execSync } = require('child_process');

const cliPath = path.resolve(__dirname, '../dist/index.js');

/**
 * Run a CLI command and return its output (stdout + stderr combined).
 * Commander writes help to stdout; some init output goes to stderr.
 * We capture both and return combined output so assertions don't depend
 * on which stream a given line lands on.
 */
function runCli(args) {
  try {
    return execSync(`node "${cliPath}" ${args}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // Commander exits with code 1 when no subcommand is provided, but
    // still writes the help text we need to assert on.
    return (err.stdout || '') + (err.stderr || '');
  }
}

describe('parallel command registration', () => {
  describe('top-level help', () => {
    test('parallel command is listed in caws --help output', () => {
      const output = runCli('--help');
      expect(output).toContain('parallel');
    });

    test('parallel is described as orchestrating multi-agent workspaces', () => {
      const output = runCli('--help');
      expect(output).toMatch(/parallel.*Orchestrate parallel multi-agent workspaces/);
    });
  });

  describe('parallel --help subcommands', () => {
    let helpOutput;

    beforeAll(() => {
      helpOutput = runCli('parallel --help');
    });

    test('setup subcommand is listed', () => {
      expect(helpOutput).toContain('setup');
    });

    test('status subcommand is listed', () => {
      expect(helpOutput).toContain('status');
    });

    test('merge subcommand is listed', () => {
      expect(helpOutput).toContain('merge');
    });

    test('teardown subcommand is listed', () => {
      expect(helpOutput).toContain('teardown');
    });

    test('all four subcommands appear together', () => {
      expect(helpOutput).toContain('setup');
      expect(helpOutput).toContain('status');
      expect(helpOutput).toContain('merge');
      expect(helpOutput).toContain('teardown');
    });
  });

  describe('parallel without subcommand', () => {
    test('shows usage information when called without a subcommand', () => {
      const output = runCli('parallel');
      // Commander prints usage when no subcommand is provided
      expect(output).toMatch(/Usage: caws parallel/);
    });

    test('output includes Commands section listing subcommands', () => {
      const output = runCli('parallel');
      expect(output).toContain('Commands:');
      expect(output).toContain('setup');
      expect(output).toContain('status');
      expect(output).toContain('merge');
      expect(output).toContain('teardown');
    });
  });

  describe('setup subcommand help', () => {
    test('setup --help shows plan-file argument', () => {
      const output = runCli('parallel setup --help');
      expect(output).toContain('plan-file');
    });

    test('setup --help shows --base-branch option', () => {
      const output = runCli('parallel setup --help');
      expect(output).toContain('base-branch');
    });
  });

  describe('merge subcommand help', () => {
    test('merge --help shows --strategy option', () => {
      const output = runCli('parallel merge --help');
      expect(output).toContain('strategy');
    });

    test('merge --help shows --dry-run option', () => {
      const output = runCli('parallel merge --help');
      expect(output).toContain('dry-run');
    });

    test('merge --help shows --force option', () => {
      const output = runCli('parallel merge --help');
      expect(output).toContain('force');
    });
  });

  describe('teardown subcommand help', () => {
    test('teardown --help shows --delete-branches option', () => {
      const output = runCli('parallel teardown --help');
      expect(output).toContain('delete-branches');
    });

    test('teardown --help shows --force option', () => {
      const output = runCli('parallel teardown --help');
      expect(output).toContain('force');
    });
  });
});
