/**
 * @fileoverview Integration tests for CAWS tools working together
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('CAWS Tools Integration', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');
  const testProjectName = `test-tools-integration-${Date.now()}`;

  // Helper function to run CLI commands with better error handling
  const runCLICommand = (command, options = {}) => {
    try {
      return execSync(command, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: path.join(__dirname, '../..'), // Run from CLI package directory
        ...options,
      });
    } catch (error) {
      console.error(`Command failed: ${command}`);
      console.error('Error:', error.message);
      if (error.stderr) console.error('stderr:', error.stderr.toString());
      if (error.stdout) console.log('stdout:', error.stdout.toString());
      throw error;
    }
  };

  beforeAll(() => {
    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    }
  });

  beforeEach(() => {
    // Clean up any existing test project directories
    const timestampPattern = /^test-tools-integration(-\d+)?$/;

    // Clean up CLI package location
    try {
      const cliItems = fs.readdirSync(path.join(__dirname, '../..'));
      cliItems.forEach((item) => {
        if (timestampPattern.test(item)) {
          const itemPath = path.join(__dirname, '../..', item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              fs.rmSync(itemPath, { recursive: true, force: true });
              console.log(`🧹 Cleaned up: ${item} (cli dir)`);
            }
          } catch (_err) {
            // Ignore errors during cleanup
          }
        }
      });
    } catch (_error) {
      // Ignore errors if directory doesn't exist or can't be read
    }
  });

  afterEach(() => {
    // Clean up test project
    const cliTestProjectPath = path.join(__dirname, '../../', testProjectName);
    if (fs.existsSync(cliTestProjectPath)) {
      fs.rmSync(cliTestProjectPath, { recursive: true, force: true });
    }
  });

  describe('Validation and Gates Integration', () => {
    test('should validate spec and run gates together', () => {
      // Integration Contract: Validation and gates should work together

      // Step 1: Initialize project
      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      const cliTestProjectPath = path.join(__dirname, '../../', testProjectName);
      expect(fs.existsSync(cliTestProjectPath)).toBe(true);

      // Step 2: Scaffold project
      runCLICommand(`node "${cliPath}" scaffold`, { cwd: cliTestProjectPath });

      // Step 3: Verify tools exist
      const validatePath = path.join(cliTestProjectPath, 'apps/tools/caws/validate.js');
      const gatesPath = path.join(cliTestProjectPath, 'apps/tools/caws/gates.js');

      expect(fs.existsSync(validatePath)).toBe(true);
      expect(fs.existsSync(gatesPath)).toBe(true);

      // Step 4: Test tool integration
      const validateTool = require(validatePath);
      const gatesTool = require(gatesPath);

      expect(() => {
        validateTool('.caws/working-spec.yaml');
      }).not.toThrow();

      expect(() => {
        gatesTool.enforceCoverageGate(0.8, 0.7);
      }).not.toThrow();
    });
  });

  describe('Provenance Integration', () => {
    test('should generate provenance after successful validation', () => {
      // Integration Contract: Provenance should be generated after validation

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      const cliTestProjectPath = path.join(__dirname, '../../', testProjectName);
      expect(fs.existsSync(cliTestProjectPath)).toBe(true);

      runCLICommand(`node "${cliPath}" scaffold`, { cwd: cliTestProjectPath });

      const provenancePath = path.join(cliTestProjectPath, 'apps/tools/caws/provenance.js');
      expect(fs.existsSync(provenancePath)).toBe(true);

      // Change to project directory before generating provenance
      const originalCwd = process.cwd();
      process.chdir(cliTestProjectPath);

      const provenanceTool = require(provenancePath);
      expect(() => {
        provenanceTool.generateProvenance();
      }).not.toThrow();

      // Restore directory
      process.chdir(originalCwd);

      const provenanceFile = path.join(cliTestProjectPath, '.agent/provenance.json');
      expect(fs.existsSync(provenanceFile)).toBe(true);

      const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
      expect(provenance).toHaveProperty('agent');
      expect(provenance).toHaveProperty('results');
    });
  });
});
