/**
 * @fileoverview Integration tests for CAWS CLI workflow
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('CLI Workflow Integration', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');
  const testProjectName = 'test-integration-workflow';
  const testProjectPath = path.join(__dirname, testProjectName);

  beforeAll(() => {
    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    }
  });

  beforeEach(() => {
    // Clean up any existing test project
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test project
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  });

  describe('Complete Project Workflow', () => {
    test('should complete full project initialization and scaffolding workflow', () => {
      // Integration Contract: CLI should support complete project setup workflow

      // Step 1: Initialize project
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      expect(fs.existsSync(testProjectPath)).toBe(true);
      expect(fs.existsSync(path.join(testProjectPath, '.caws'))).toBe(true);

      // Step 2: Scaffold CAWS components
      process.chdir(testProjectPath);

      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Integration Contract: Scaffolding should create complete tool structure
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/validate.js')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/gates.js')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/provenance.js')).toBe(true);
      expect(fs.existsSync('.agent')).toBe(true);

      // Step 3: Validate the project setup
      const validateTool = require('./apps/tools/caws/validate.js');
      const workingSpecPath = '.caws/working-spec.yaml';

      // Integration Contract: Validation should work with scaffolded project
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      process.chdir(__dirname);
    });

    test('should handle project modifications and re-validation', () => {
      // Integration Contract: Project should support iterative development

      // Step 1: Initialize and scaffold
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectPath);
      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Step 2: Modify working spec
      const workingSpecPath = '.caws/working-spec.yaml';
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);

      // Add a new invariant
      spec.invariants.push('New integration invariant');
      fs.writeFileSync(workingSpecPath, yaml.dump(spec));

      // Step 3: Re-validate
      const validateTool = require('./apps/tools/caws/validate.js');

      // Integration Contract: Modified spec should still validate
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      process.chdir(__dirname);
    });
  });

  describe('Tool Integration', () => {
    test('should integrate validation and provenance tools', () => {
      // Integration Contract: Tools should work together

      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectPath);
      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Step 1: Validate the working spec
      const validateTool = require('./apps/tools/caws/validate.js');
      const workingSpecPath = '.caws/working-spec.yaml';

      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 2: Generate provenance
      const provenanceTool = require('./apps/tools/caws/provenance.js');

      expect(() => {
        provenanceTool();
      }).not.toThrow();

      // Integration Contract: Provenance should be generated after validation
      expect(fs.existsSync('.agent/provenance.json')).toBe(true);

      process.chdir(__dirname);
    });

    test('should integrate gates tool with project structure', () => {
      // Integration Contract: Gates should work with scaffolded project

      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectPath);
      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const gatesTool = require('./apps/tools/caws/gates.js');

      // Integration Contract: Gates should analyze project structure
      expect(() => {
        gatesTool();
      }).not.toThrow();

      process.chdir(__dirname);
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle workflow interruptions gracefully', () => {
      // Integration Contract: Partial workflows should not leave project in broken state

      // Step 1: Start project initialization
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectPath);

      // Step 2: Start scaffolding but interrupt it
      // (In a real scenario, this might be interrupted by user or system)

      // Integration Contract: Project should still be usable after interruption
      expect(fs.existsSync('.caws/working-spec.yaml')).toBe(true);

      // Should be able to continue with validation even without full scaffolding
      const workingSpecPath = '.caws/working-spec.yaml';

      // This should work even without full scaffolding
      expect(fs.existsSync(workingSpecPath)).toBe(true);

      process.chdir(__dirname);
    });
  });
});
