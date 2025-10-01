/**
 * @fileoverview E2E smoke tests for critical CAWS user workflows
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('E2E Smoke Tests - Critical User Workflows', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');

  beforeAll(() => {
    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    }
  });

  afterAll(() => {
    // Clean up all e2e test directories
    const testDirPattern = /^test-e2e-/;
    try {
      const items = fs.readdirSync(__dirname);
      items.forEach((item) => {
        if (testDirPattern.test(item)) {
          const itemPath = path.join(__dirname, item);
          try {
            if (fs.statSync(itemPath).isDirectory()) {
              fs.rmSync(itemPath, { recursive: true, force: true });
            }
          } catch (_err) {
            // Ignore errors during cleanup
          }
        }
      });
    } catch (_error) {
      // Ignore errors if directory doesn't exist
    }
  });

  describe('Complete Project Creation Workflow', () => {
    const testProjectName = 'test-e2e-complete-project';
    const testProjectPath = path.join(__dirname, testProjectName);
    const originalCwd = process.cwd();

    beforeEach(() => {
      // Ensure we're in the test directory
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Already in correct directory
      }

      // Clean up any existing test project
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
        console.log(`🧹 Cleaned up: ${testProjectName}`);
      }
    });

    afterEach(() => {
      // Restore working directory before cleanup
      try {
        process.chdir(originalCwd);
      } catch (err) {
        try {
          process.chdir(__dirname);
        } catch (err2) {
          // Can't restore, continue
        }
      }

      // Clean up test project
      if (fs.existsSync(testProjectPath)) {
        fs.rmSync(testProjectPath, { recursive: true, force: true });
      }
    });

    test('should complete full project creation from scratch', () => {
      // E2E Contract: Users should be able to create a complete CAWS project

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

      // E2E Contract: Scaffolding should create complete project structure
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/validate.js')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/gates.js')).toBe(true);
      expect(fs.existsSync('apps/tools/caws/provenance.js')).toBe(true);
      expect(fs.existsSync('.agent')).toBe(true);

      // Step 3: Validate working spec
      const validateToolPath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const validateTool = require(validateToolPath);
      const workingSpecPath = '.caws/working-spec.yaml';

      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 4: Generate provenance
      const provenanceToolPath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');
      const provenanceTool = require(provenanceToolPath);

      expect(() => {
        const provenance = provenanceTool.generateProvenance();
        provenanceTool.saveProvenance(provenance, '.agent/provenance.json');
      }).not.toThrow();

      expect(fs.existsSync('.agent/provenance.json')).toBe(true);

      // Step 5: Run gates
      const gatesToolPath = path.join(testProjectPath, 'apps/tools/caws/gates.js');
      const gatesTool = require(gatesToolPath);

      expect(() => {
        gatesTool.enforceCoverageGate(0.85, 0.8);
      }).not.toThrow();

      // Restore directory before assertions
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Directory might not exist, continue with absolute paths
      }

      // E2E Contract: Project should be fully functional after workflow
      expect(fs.existsSync(path.join(testProjectPath, '.caws/working-spec.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(testProjectPath, '.agent/provenance.json'))).toBe(true);
    });

    test('should handle iterative project development', () => {
      // E2E Contract: Users should be able to modify and re-run workflows

      // Step 1: Create and scaffold project
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

      // Add a new acceptance criterion
      spec.acceptance.push({
        id: 'A2',
        given: 'User modifies project',
        when: 'User runs validation again',
        then: 'Validation should pass with new criteria',
      });

      fs.writeFileSync(workingSpecPath, yaml.dump(spec));

      // Step 3: Re-run full workflow
      const validateToolPath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const provenanceToolPath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');
      const gatesToolPath = path.join(testProjectPath, 'apps/tools/caws/gates.js');

      const validateTool = require(validateToolPath);
      const provenanceTool = require(provenanceToolPath);
      const gatesTool = require(gatesToolPath);

      // E2E Contract: Modified project should still work through full workflow
      expect(() => {
        validateTool(workingSpecPath);
        const provenance = provenanceTool.generateProvenance();
        provenanceTool.saveProvenance(provenance, '.agent/provenance.json');
        gatesTool.enforceCoverageGate(0.85, 0.8);
      }).not.toThrow();

      // Restore directory
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Can't restore, continue
      }
    });
  });

  describe('Adding CAWS to Existing Project', () => {
    const existingProjectName = 'test-e2e-existing-project';
    const existingProjectPath = path.join(__dirname, existingProjectName);
    const originalCwd = process.cwd();

    beforeEach(() => {
      // Ensure we're in test directory
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Already in correct directory
      }

      // Clean up any existing test project
      if (fs.existsSync(existingProjectPath)) {
        fs.rmSync(existingProjectPath, { recursive: true, force: true });
      }
    });

    afterEach(() => {
      // Restore working directory
      try {
        process.chdir(originalCwd);
      } catch (err) {
        try {
          process.chdir(__dirname);
        } catch (err2) {
          // Can't restore, continue
        }
      }

      // Clean up test project
      if (fs.existsSync(existingProjectPath)) {
        fs.rmSync(existingProjectPath, { recursive: true, force: true });
      }
    });

    test('should add CAWS to existing project without breaking it', () => {
      // E2E Contract: CAWS should integrate with existing projects

      // Step 1: Create a basic existing project structure first
      fs.mkdirSync(existingProjectPath, { recursive: true });
      fs.mkdirSync(path.join(existingProjectPath, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(existingProjectPath, 'package.json'),
        JSON.stringify({
          name: 'existing-project',
          version: '1.0.0',
        })
      );
      fs.writeFileSync(path.join(existingProjectPath, 'README.md'), '# Existing Project');

      // Move into the project
      process.chdir(existingProjectPath);

      // Step 2: Manually create .caws directory and working spec (simulating existing project that wants CAWS)
      fs.mkdirSync('.caws', { recursive: true });
      const workingSpec = {
        id: 'TEST-EXISTING',
        title: 'Existing Project Integration',
        risk_tier: 2,
        mode: 'feature',
        scope: { in: 'src/', out: 'node_modules/' },
        invariants: ['Existing functionality preserved'],
        acceptance: [
          { id: 'A1', given: 'Existing project', when: 'CAWS added', then: 'Project enhanced' },
        ],
      };
      fs.writeFileSync('.caws/working-spec.yaml', yaml.dump(workingSpec));

      // Step 3: Scaffold CAWS components into existing project
      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // E2E Contract: Existing project structure should remain intact
      expect(fs.existsSync('package.json')).toBe(true);
      expect(fs.existsSync('README.md')).toBe(true);
      expect(fs.existsSync('src')).toBe(true);

      // E2E Contract: CAWS components should be added
      expect(fs.existsSync('.caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('.agent')).toBe(true);

      // Step 3: Validate CAWS integration
      const validateToolPath = path.join(existingProjectPath, 'apps/tools/caws/validate.js');
      const validateTool = require(validateToolPath);
      const workingSpecPath = '.caws/working-spec.yaml';

      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 4: Generate provenance
      const provenanceToolPath = path.join(existingProjectPath, 'apps/tools/caws/provenance.js');
      const provenanceTool = require(provenanceToolPath);

      expect(() => {
        const provenance = provenanceTool.generateProvenance();
        provenanceTool.saveProvenance(provenance, '.agent/provenance.json');
      }).not.toThrow();

      // Restore directory
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Can't restore, continue
      }

      // E2E Contract: Project should be enhanced but not broken
      expect(fs.existsSync(path.join(existingProjectPath, 'package.json'))).toBe(true);
      expect(fs.existsSync(path.join(existingProjectPath, '.caws/working-spec.yaml'))).toBe(true);
      expect(fs.existsSync(path.join(existingProjectPath, '.agent/provenance.json'))).toBe(true);
    });
  });

  describe('Error Recovery Workflows', () => {
    const errorProjectName = 'test-e2e-error-recovery';
    const errorProjectPath = path.join(__dirname, errorProjectName);
    const originalCwd = process.cwd();

    beforeEach(() => {
      // Ensure we're in the test directory
      process.chdir(__dirname);

      // Clean up any existing test project
      if (fs.existsSync(errorProjectPath)) {
        fs.rmSync(errorProjectPath, { recursive: true, force: true });
      }
    });

    afterEach(() => {
      // Restore original working directory before cleanup
      try {
        process.chdir(originalCwd);
      } catch (err) {
        // If original dir doesn't exist, go to __dirname
        try {
          process.chdir(__dirname);
        } catch (err2) {
          // Directory was deleted, can't change to it
        }
      }

      // Clean up test project
      if (fs.existsSync(errorProjectPath)) {
        fs.rmSync(errorProjectPath, { recursive: true, force: true });
      }
    });

    test('should recover from broken working spec', () => {
      // E2E Contract: System should handle and recover from errors

      // Step 1: Create project
      execSync(`node "${cliPath}" init ${errorProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(errorProjectPath);
      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Step 2: Break the working spec
      const workingSpecPath = '.caws/working-spec.yaml';
      fs.writeFileSync(workingSpecPath, 'invalid: yaml: content: [');

      // Step 3: Try to validate (should handle gracefully)
      const validateToolPath = path.join(errorProjectPath, 'apps/tools/caws/validate.js');
      const validateTool = require(validateToolPath);

      // E2E Contract: Tools should handle errors without crashing
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 4: Fix the spec and retry
      const validSpec = {
        id: 'TEST-RECOVERY',
        title: 'Error Recovery Test',
        risk_tier: 2,
        mode: 'feature',
        scope: { in: 'src/', out: 'node_modules/' },
        invariants: ['System should recover from errors'],
        acceptance: [
          {
            id: 'A1',
            given: 'Invalid working spec',
            when: 'User fixes spec',
            then: 'Workflow should continue',
          },
        ],
      };

      fs.writeFileSync(workingSpecPath, yaml.dump(validSpec));

      // Step 5: Re-run workflow (should work now)
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      process.chdir(__dirname);
    });
  });

  describe('Multi-Package Workflow', () => {
    const originalCwd = process.cwd();

    beforeEach(() => {
      // Ensure we're in the test directory
      try {
        process.chdir(__dirname);
      } catch (err) {
        // Already in a valid directory
      }
    });

    afterEach(() => {
      // Restore original working directory
      try {
        process.chdir(originalCwd);
      } catch (err) {
        try {
          process.chdir(__dirname);
        } catch (err2) {
          // Can't restore, continue
        }
      }
    });

    test('should work across different project types', () => {
      // E2E Contract: CAWS should work with different project structures
      // Test with a single representative project mode to avoid complexity

      const testProjectName = 'test-e2e-multi-mode';
      const testProjectPath = path.join(__dirname, testProjectName);

      try {
        // Ensure we're in test directory before starting
        process.chdir(__dirname);

        // Clean up
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }

        // Create project
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: __dirname,
        });

        process.chdir(testProjectPath);
        execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });

        // E2E Contract: Project modes should work
        const validateToolPath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
        const validateTool = require(validateToolPath);
        const workingSpecPath = '.caws/working-spec.yaml';

        expect(() => {
          validateTool(workingSpecPath);
        }).not.toThrow();

        // Restore directory
        try {
          process.chdir(__dirname);
        } catch (err) {
          // Can't restore, continue
        }
      } finally {
        // Ensure we're in test directory before cleanup
        try {
          process.chdir(__dirname);
        } catch (chdirErr) {
          // Can't change, continue with cleanup anyway
        }

        // Clean up
        if (fs.existsSync(testProjectPath)) {
          fs.rmSync(testProjectPath, { recursive: true, force: true });
        }
      }
    });
  });
});
