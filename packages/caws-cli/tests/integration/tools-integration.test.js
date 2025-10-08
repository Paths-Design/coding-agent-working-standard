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
  let testTempDir;

  beforeAll(() => {
    // Create a temporary directory OUTSIDE the monorepo to avoid conflicts
    testTempDir = path.join(require('os').tmpdir(), 'caws-cli-tools-integration-tests-' + Date.now());
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testTempDir, { recursive: true });
  });

  afterAll(() => {
    // Clean up temp directory
    try {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch (_error) {
      // Ignore errors if directory doesn't exist
    }
  });

  // Helper function to run CLI commands with better error handling
  const runCLICommand = (command, options = {}) => {
    try {
      return execSync(command, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: testTempDir, // Run from temp directory
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


  beforeEach(() => {
    // Clean up any existing test project directories in temp directory
    try {
      const tempItems = fs.readdirSync(testTempDir);
      tempItems.forEach((item) => {
        const itemPath = path.join(testTempDir, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            fs.rmSync(itemPath, { recursive: true, force: true });
            console.log(`🧹 Cleaned up: ${item} (temp dir)`);
          }
        } catch (_err) {
          // Ignore errors during cleanup
        }
      });
    } catch (_error) {
      // Ignore errors if directory doesn't exist or can't be read
    }
  });

  afterEach(() => {
    // Clean up test project in temp directory
    const tempTestProjectPath = path.join(testTempDir, testProjectName);
    if (fs.existsSync(tempTestProjectPath)) {
      fs.rmSync(tempTestProjectPath, { recursive: true, force: true });
    }
  });

  describe('Validation and Gates Integration', () => {
    test('should validate spec and run gates together', () => {
      // Integration Contract: Validation and gates should work together

      const uniqueTestProjectName = `${testProjectName}-validation`;

      // Step 1: Initialize project
      runCLICommand(`node "${cliPath}" init ${uniqueTestProjectName} --non-interactive`);

      const tempTestProjectPath = path.join(testTempDir, uniqueTestProjectName);
      expect(fs.existsSync(tempTestProjectPath)).toBe(true);

      // Step 2: Scaffold project
      runCLICommand(`node "${cliPath}" scaffold`, { cwd: tempTestProjectPath });

      // Step 3: Verify tools exist
      const validatePath = path.join(tempTestProjectPath, 'apps/tools/caws/validate.js');
      const gatesPath = path.join(tempTestProjectPath, 'apps/tools/caws/gates.js');

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

      const uniqueTestProjectName = `${testProjectName}-provenance`;

      runCLICommand(`node "${cliPath}" init ${uniqueTestProjectName} --non-interactive`);

      const tempTestProjectPath = path.join(testTempDir, uniqueTestProjectName);
      expect(fs.existsSync(tempTestProjectPath)).toBe(true);

      runCLICommand(`node "${cliPath}" scaffold`, { cwd: tempTestProjectPath });

      const provenancePath = path.join(tempTestProjectPath, 'apps/tools/caws/provenance.js');
      expect(fs.existsSync(provenancePath)).toBe(true);

      // Change to project directory before generating provenance
      const originalCwd = process.cwd();
      process.chdir(tempTestProjectPath);

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
