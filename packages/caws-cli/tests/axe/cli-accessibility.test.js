/**
 * @fileoverview Accessibility tests for CAWS CLI interface
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// Strip ANSI escape codes for accessibility testing
function stripAnsiCodes(str) {
  // Remove all ANSI escape sequences including cursor movement codes
  const esc = String.fromCharCode(27);
  return str
    .replace(new RegExp(esc + '\\[[0-9;]*[A-Za-z]', 'g'), '')
    .replace(new RegExp(esc + '\\[[0-9;]*m', 'g'), '');
}

describe('CLI Accessibility Tests', () => {
  let testTempDir;

  beforeAll(() => {
    try {
      // Create a temporary directory for accessibility tests
      testTempDir = path.join(require('os').tmpdir(), 'caws-cli-accessibility-tests-' + Date.now());
      if (fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
      fs.mkdirSync(testTempDir, { recursive: true });
    } catch (error) {
      console.log('Accessibility test setup failed:', error.message);
      testTempDir = null;
    }
  });

  afterAll(() => {
    try {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  const cliPath = path.join(__dirname, '../../dist/index.js');

  describe('CLI Help Accessibility', () => {
    test('should provide accessible help text structure', () => {
      if (!testTempDir) {
        console.log('Skipping accessibility test - setup failed');
        return;
      }

      // Accessibility Contract: Help text should be well-structured and readable

      const helpOutput = stripAnsiCodes(execSync(`node "${cliPath}" --help`, { encoding: 'utf8' }));

      // Accessibility Contract: Help should have clear sections
      expect(helpOutput).toContain('Commands:');
      expect(helpOutput).toContain('Options:');

      // Accessibility Contract: Commands should be clearly listed
      const lines = helpOutput.split('\n');
      const commandSection = lines.findIndex((line) => line.includes('Commands:'));

      if (commandSection !== -1) {
        // Should have commands after the Commands: header
        const commandsStart = commandSection + 1;
        let foundCommand = false;

        for (let i = commandsStart; i < lines.length; i++) {
          if (lines[i].trim() === '' || lines[i].includes('Options:')) break;
          if (lines[i].match(/^\s+\w+/)) {
            foundCommand = true;
            break;
          }
        }

        expect(foundCommand).toBe(true);
      }
    });

    test('should use consistent formatting for better readability', () => {
      // Accessibility Contract: Output should use consistent formatting.
      // We only check command-row indentation here, not description-wrap
      // indentation. Commander wraps long descriptions onto continuation
      // lines that begin with deep whitespace, which would otherwise match
      // a naive "indented line" regex.

      const helpOutput = stripAnsiCodes(execSync(`node "${cliPath}" --help`, { encoding: 'utf8' }));

      const lines = helpOutput.split('\n');

      // A command row is two-space-indented and starts with an identifier
      // followed by either whitespace+`[options]` or whitespace+description.
      // Continuation lines start with many more spaces (they are aligned
      // to the description column) and do NOT match this pattern.
      const COMMAND_ROW = /^ {2}[a-z][a-z0-9-]*(?: \[[^\]]+\])? {2,}\S/;
      const commandLines = lines.filter((line) => COMMAND_ROW.test(line));

      if (commandLines.length > 1) {
        const indentations = commandLines.map((line) => line.length - line.trimStart().length);
        const firstIndent = indentations[0];
        const consistent = indentations.every((indent) => indent === firstIndent);
        expect(consistent).toBe(true);
      }
    });
  });

  describe('Error Message Accessibility', () => {
    test('should provide clear and helpful error messages', () => {
      // Accessibility Contract: Error messages should be clear and actionable.
      //
      // v11 `caws init` takes NO project-name positional argument (Usage:
      // `caws init [options]`), so the v10 "Project name is required" error
      // no longer exists. The real v11 init error surface we exercise here is
      // an unknown --agent-surface value, which emits a structured, bounded,
      // actionable diagnostic. Run with an explicit cwd so the invocation can
      // never inherit the jest CWD (the live initialized CAWS repo).

      let errorOutput;

      try {
        execSync(`node "${cliPath}" init --agent-surface bogus-surface`, {
          encoding: 'utf8',
          cwd: testTempDir,
          stdio: 'pipe',
        });
      } catch (error) {
        errorOutput = (error.stdout || '') + (error.stderr || '');
      }

      // The unknown-surface path must fail with diagnostic output.
      expect(errorOutput).toBeTruthy();

      // Accessibility Contract: Error messages should explain the problem.
      expect(errorOutput).toMatch(/unknown --agent-surface/i);

      // Accessibility Contract: Error messages should suggest valid choices.
      expect(errorOutput).toMatch(/known values:/i);
      expect(errorOutput).toContain('claude-code');

      // Accessibility Contract: Error messages should be concise but complete.
      const errorLines = errorOutput.split('\n').filter((line) => line.trim());
      expect(errorLines.length).toBeGreaterThan(0);
      expect(errorLines.length).toBeLessThanOrEqual(10); // Shouldn't be overwhelming
    });

    test('init in an already-governed directory reports the no-op accessibly', () => {
      // Accessibility Contract: an idempotent re-init should communicate its
      // no-op clearly rather than erroring or going silent.
      //
      // v11 has no project-name validation/sanitization (that was a removed
      // v10 scaffolding concern), so this replaces the old "invalid project
      // names" test. We initialize a fresh isolated repo, then re-init it and
      // assert the second run's message is clear and bounded. Explicit cwd
      // keeps every invocation off the live repo.

      const repo = path.join(
        require('os').tmpdir(),
        'caws-axe-init-noop-' + Date.now()
      );
      fs.mkdirSync(repo, { recursive: true });
      try {
        execSync('git init --quiet', { cwd: repo });
        execSync('git config user.email t@t.com', { cwd: repo });
        execSync('git config user.name T', { cwd: repo });
        execSync('git commit --quiet --allow-empty -m init', { cwd: repo });

        // First init: bootstraps canonical .caws/ in the isolated repo.
        const first = execSync(`node "${cliPath}" init --agent-surface none`, {
          encoding: 'utf8',
          cwd: repo,
          stdio: 'pipe',
        });
        expect(first).toMatch(/created \d+ path/i);

        // Second init: idempotent no-op with a clear message.
        const second = execSync(`node "${cliPath}" init --agent-surface none`, {
          encoding: 'utf8',
          cwd: repo,
          stdio: 'pipe',
        });

        // Accessibility Contract: the no-op is communicated, not silent.
        expect(second.trim().length).toBeGreaterThan(10);
        expect(second).toMatch(/already initialized|no changes|unchanged/i);

        // Accessibility Contract: concise but complete.
        const lines = second.split('\n').filter((line) => line.trim());
        expect(lines.length).toBeGreaterThan(0);
      } finally {
        if (fs.existsSync(repo)) {
          fs.rmSync(repo, { recursive: true, force: true });
        }
      }
    });
  });

  describe('Output Readability', () => {
    test('should use appropriate line lengths for readability', () => {
      // Accessibility Contract: Output should be readable in standard terminals

      const helpOutput = stripAnsiCodes(execSync(`node "${cliPath}" --help`, { encoding: 'utf8' }));
      const lines = helpOutput.split('\n');

      // Accessibility Contract: Lines should be reasonable length (under 80-100 chars)
      const longLines = lines.filter((line) => line.length > 100);

      // Should have very few overly long lines
      expect(longLines.length).toBeLessThan(lines.length * 0.15); // Less than 15% long lines
    });

    test('should use clear visual hierarchy', () => {
      // Accessibility Contract: Output should have clear visual structure

      const helpOutput = stripAnsiCodes(execSync(`node "${cliPath}" --help`, { encoding: 'utf8' }));
      const lines = helpOutput.split('\n');

      // Accessibility Contract: Should have section headers
      const headers = lines.filter(
        (line) =>
          line.match(/^[A-Z][a-z]+:/) || // Title Case headers
          line.match(/^\s*[A-Z\s]+:$/) || // UPPERCASE headers
          line.match(/^\s*Commands?:$/i) ||
          line.match(/^\s*Options?:$/i)
      );

      expect(headers.length).toBeGreaterThan(0);
    });
  });

  describe('Terminal Interface Accessibility', () => {
    test('should work with screen readers and assistive technology', () => {
      // Accessibility Contract: CLI should be usable with assistive technology

      const helpOutput = stripAnsiCodes(execSync(`node "${cliPath}" --help`, { encoding: 'utf8' }));

      // Accessibility Contract: Should use plain text without complex formatting
      expect(helpOutput).not.toMatch(/\[[\d;]*m/); // No ANSI color codes in help

      // Accessibility Contract: Should use standard Unicode characters
      // Basic check for problematic control characters (simplified to avoid regex issues)
      const hasNullByte = helpOutput.includes('\0');
      const hasBasicControlChars =
        helpOutput.includes('\x01') || helpOutput.includes('\x02') || helpOutput.includes('\x7f');
      expect(hasNullByte || hasBasicControlChars).toBe(false);
    });

    test('should provide version information accessibly', () => {
      // Accessibility Contract: Version should be clearly accessible

      const versionOutput = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' });

      // Accessibility Contract: Version should be semantic versioning format
      const versionMatch = versionOutput.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);

      if (versionMatch) {
        const [, major, minor, patch] = versionMatch.map(Number);

        // Accessibility Contract: Version should follow semantic versioning
        expect(major).toBeGreaterThanOrEqual(0);
        expect(minor).toBeGreaterThanOrEqual(0);
        expect(patch).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Spec File Accessibility', () => {
    test('should generate accessible v11 spec format via caws specs create', () => {
      // Accessibility Contract: Generated v11 specs should be readable
      // and well-formatted. v11 specs live at .caws/specs/<id>.yaml and
      // are created via `caws specs create <id>` (not via init wizard).

      const testProjectPath = path.join(testTempDir, `axe-spec-${Date.now()}`);
      fs.mkdirSync(testProjectPath, { recursive: true });

      try {
        // git init so caws init can succeed
        execSync(`git init -q`, { cwd: testProjectPath });
        execSync(`git config user.email t@t.com`, { cwd: testProjectPath });
        execSync(`git config user.name T`, { cwd: testProjectPath });
        execSync(`git commit --allow-empty -q -m init`, { cwd: testProjectPath });

        // v11 init is in-place (no project-name arg, no --non-interactive)
        execSync(`node "${cliPath}" init`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testProjectPath,
        });

        // Create a feature spec via the canonical v11 path
        execSync(`node "${cliPath}" specs create FEAT-001 --title axe-test --mode feature --risk-tier 3`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testProjectPath,
        });

        const specPath = path.join(testProjectPath, '.caws/specs/FEAT-001.yaml');
        expect(fs.existsSync(specPath)).toBe(true);

        const specContent = fs.readFileSync(specPath, 'utf8');

        // Accessibility Contract: YAML should be valid and readable
        expect(() => yaml.load(specContent)).not.toThrow();

        // Accessibility Contract: Should use consistent indentation
        const lines = specContent.split('\n');
        const indentedLines = lines.filter((line) => line.match(/^\s+/));

        if (indentedLines.length > 1) {
          const indentations = indentedLines.map((line) => line.length - line.trimStart().length);
          // Consistent 2-space indentation (YAML standard)
          const consistentIndentation = indentations.every((indent) => indent % 2 === 0);
          expect(consistentIndentation).toBe(true);
        }
      } finally {
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }
    });
  });
});
