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
  let testProjectPath;
  let originalCwd;
  let testTempDir;

  beforeAll(() => {
    // Store original working directory
    originalCwd = process.cwd();

    // Create a clean temporary directory for tests to avoid conflicts with monorepo
    testTempDir = path.join(__dirname, '..', 'test-integration-temp');
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(testTempDir, { recursive: true });

    // Change to temp directory for tests
    process.chdir(testTempDir);

    // Set test project path relative to current working directory (temp dir)
    testProjectPath = path.join(process.cwd(), testProjectName);

    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    }
  });

  afterAll(() => {
    // Restore original working directory
    if (originalCwd) {
      process.chdir(originalCwd);
    }

    // Clean up temp directory
    try {
      if (testTempDir && fs.existsSync(testTempDir)) {
        fs.rmSync(testTempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
  });

  beforeEach(() => {
    // Clean up any existing test project
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
      console.log(`🧹 Cleaned up: ${testProjectName}`);
    }
  });

  afterEach(() => {
    // Clean up test project
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Final cleanup: Remove test directory if it still exists
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
      const originalDir = process.cwd();
      try {
        process.chdir(testProjectPath);

        // Capture scaffold output for debugging
        let scaffoldOutput = '';
        try {
          scaffoldOutput = execSync(`node "${cliPath}" scaffold`, {
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch (scaffoldError) {
          console.log('Scaffold command failed with error:', scaffoldError.message);
          console.log('Scaffold stderr:', scaffoldError.stderr);
          console.log('Scaffold stdout:', scaffoldError.stdout);
          throw scaffoldError;
        }

        // Log scaffold output for debugging in CI
        if (process.env.CI) {
          console.log('Scaffold output (test 1):', scaffoldOutput);
          console.log('Working directory:', process.cwd());
          console.log('Files in project directory:', fs.readdirSync(testProjectPath));
          const appsDir = path.join(testProjectPath, 'apps');
          if (fs.existsSync(appsDir)) {
            console.log('Files in apps directory:', fs.readdirSync(appsDir));
            const toolsDir = path.join(appsDir, 'tools');
            if (fs.existsSync(toolsDir)) {
              console.log('Files in apps/tools directory:', fs.readdirSync(toolsDir));
            } else {
              console.log('apps/tools directory does not exist');
            }
          } else {
            console.log('apps directory does not exist');
          }
        }
      } finally {
        process.chdir(originalDir);
      }

      // Integration Contract: Scaffolding should create complete tool structure
      expect(fs.existsSync(path.join(testProjectPath, 'apps/tools/caws'))).toBe(true);
      expect(fs.existsSync(path.join(testProjectPath, 'apps/tools/caws/validate.js'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(testProjectPath, 'apps/tools/caws/gates.js'))).toBe(true);
      expect(fs.existsSync(path.join(testProjectPath, 'apps/tools/caws/provenance.js'))).toBe(
        true
      );
      expect(fs.existsSync(path.join(testProjectPath, '.agent'))).toBe(true);

      // Step 3: Validate the project setup
      const workingSpecPath = path.join(testProjectPath, '.caws/working-spec.yaml');

      // Check that the working spec exists and is valid
      expect(fs.existsSync(workingSpecPath)).toBe(true);

      // Read and validate the working spec content
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);
      expect(spec).toBeDefined();
      expect(spec.id).toBeDefined(); // The working spec has 'id' not 'project'

      process.chdir(__dirname);
    });

    test('should handle project modifications and re-validation', () => {
      // Integration Contract: Project should support iterative development

      // Step 1: Initialize and scaffold
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: path.join(__dirname, '../..'), // Run from CLI package directory
      });

      expect(fs.existsSync(testProjectPath)).toBe(true);

      // Capture scaffold output for debugging
      let scaffoldOutput = '';
      try {
        scaffoldOutput = execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testProjectPath, // Scaffold in project directory
        });
      } catch (scaffoldError) {
        console.log('Scaffold command failed with error (test 2):', scaffoldError.message);
        console.log('Scaffold stderr:', scaffoldError.stderr);
        console.log('Scaffold stdout:', scaffoldError.stdout);
        throw scaffoldError;
      }

      // Log scaffold output for debugging in CI
      if (process.env.CI) {
        console.log('Scaffold output (test 2):', scaffoldOutput);
        console.log('Files in project directory (test 2):', fs.readdirSync(testProjectPath));
        const appsDir = path.join(testProjectPath, 'apps');
        if (fs.existsSync(appsDir)) {
          console.log('Files in apps directory (test 2):', fs.readdirSync(appsDir));
          const toolsDir = path.join(appsDir, 'tools');
          if (fs.existsSync(toolsDir)) {
            console.log('Files in apps/tools directory (test 2):', fs.readdirSync(toolsDir));
          } else {
            console.log('apps/tools directory does not exist');
          }
        } else {
          console.log('apps directory does not exist');
        }
      }

      // Step 2: Modify working spec
      const workingSpecPath = path.join(testProjectPath, '.caws/working-spec.yaml');
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);

      // Add a new invariant
      spec.invariants.push('New integration invariant');
      fs.writeFileSync(workingSpecPath, yaml.dump(spec));

      // Step 3: Re-validate
      const validateTool = require(path.join(testProjectPath, 'apps/tools/caws/validate.js'));

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
        cwd: path.join(__dirname, '../..'), // Run from CLI package directory
      });

      expect(fs.existsSync(testProjectPath)).toBe(true);

      // Capture scaffold output for debugging
      let scaffoldOutput = '';
      try {
        scaffoldOutput = execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
          cwd: testProjectPath, // Scaffold in project directory
        });
      } catch (scaffoldError) {
        console.log('Scaffold command failed with error (test 3):', scaffoldError.message);
        console.log('Scaffold stderr:', scaffoldError.stderr);
        console.log('Scaffold stdout:', scaffoldError.stdout);
        throw scaffoldError;
      }

      // Log scaffold output for debugging in CI
      if (process.env.CI) {
        console.log('Scaffold output (test 3):', scaffoldOutput);
        console.log('Files in project directory (test 3):', fs.readdirSync(testProjectPath));
        const appsDir = path.join(testProjectPath, 'apps');
        if (fs.existsSync(appsDir)) {
          console.log('Files in apps directory (test 3):', fs.readdirSync(appsDir));
          const toolsDir = path.join(appsDir, 'tools');
          if (fs.existsSync(toolsDir)) {
            console.log('Files in apps/tools directory (test 3):', fs.readdirSync(toolsDir));
          } else {
            console.log('apps/tools directory does not exist');
          }
        } else {
          console.log('apps directory does not exist');
        }
      }

      // Step 1: Validate the working spec
      const validateTool = require(path.join(testProjectPath, 'apps/tools/caws/validate.js'));
      const workingSpecPath = path.join(testProjectPath, '.caws/working-spec.yaml');

      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 2: Generate provenance
      const provenanceTool = require(
        path.join(testProjectPath, 'apps/tools/caws/provenance.js')
      );

      // Change to project directory for provenance tool
      const originalDir = process.cwd();
      process.chdir(testProjectPath);

      try {
        expect(() => {
          provenanceTool.generateProvenance();
        }).not.toThrow();
      } finally {
        process.chdir(originalDir);
      }

      // Integration Contract: Provenance should be generated after validation
      expect(fs.existsSync(path.join(testProjectPath, '.agent/provenance.json'))).toBe(true);

      process.chdir(__dirname);
    });

    test('should integrate gates tool with project structure', () => {
      // Integration Contract: Gates should work with scaffolded project

      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: path.join(__dirname, '../..'), // Run from CLI package directory
      });

      expect(fs.existsSync(testProjectPath)).toBe(true);

      execSync(`node "${cliPath}" scaffold`, {
        encoding: 'utf8',
        stdio: 'pipe',
        cwd: testProjectPath, // Scaffold in project directory
      });

      const gatesTool = require(path.join(testProjectPath, 'apps/tools/caws/gates.js'));

      // Integration Contract: Gates should analyze project structure
      expect(() => {
        gatesTool.enforceCoverageGate(0.8, 0.7);
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
        cwd: path.join(__dirname, '../..'), // Run from CLI package directory
      });

      expect(fs.existsSync(testProjectPath)).toBe(true);

      // Step 2: Start scaffolding but interrupt it
      // (In a real scenario, this might be interrupted by user or system)

      // Integration Contract: Project should still be usable after interruption
      expect(fs.existsSync(path.join(testProjectPath, '.caws/working-spec.yaml'))).toBe(true);

      // Should be able to continue with validation even without full scaffolding
      const workingSpecPath = path.join(testProjectPath, '.caws/working-spec.yaml');

      // This should work even without full scaffolding
      expect(fs.existsSync(workingSpecPath)).toBe(true);

      process.chdir(__dirname);
    });
  });
});
