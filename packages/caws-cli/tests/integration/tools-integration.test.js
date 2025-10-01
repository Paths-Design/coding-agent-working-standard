/**
 * @fileoverview Integration tests for CAWS tools working together
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('CAWS Tools Integration', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');
  const testProjectName = `test-tools-integration-${Date.now()}`;
  const testProjectPath = path.join(__dirname, testProjectName);

  // Helper function to run CLI commands with better error handling
  const runCLICommand = (command, options = {}) => {
    try {
      return execSync(command, {
        encoding: 'utf8',
        stdio: 'pipe',
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

  // Helper function to scaffold project with error handling
  const scaffoldProject = (projectPath, originalDir) => {
    process.chdir(projectPath);
    try {
      runCLICommand(`node "${cliPath}" scaffold`);
    } catch (error) {
      process.chdir(originalDir);
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
    const baseTestDir = path.join(__dirname, 'test-tools-integration');
    const timestampPattern = /^test-tools-integration(-\d+)?$/;

    // Clean up the base directory
    if (fs.existsSync(baseTestDir)) {
      fs.rmSync(baseTestDir, { recursive: true, force: true });
    }

    // Clean up any timestamped variants
    try {
      const items = fs.readdirSync(__dirname);
      items.forEach((item) => {
        if (timestampPattern.test(item)) {
          const itemPath = path.join(__dirname, item);
          if (fs.statSync(itemPath).isDirectory()) {
            fs.rmSync(itemPath, { recursive: true, force: true });
          }
        }
      });
    } catch (_error) {
      // Ignore errors if directory doesn't exist or can't be read
    }
  });

  afterEach(() => {
    // Clean up test project
    if (fs.existsSync(testProjectPath)) {
      fs.rmSync(testProjectPath, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    // Final cleanup: Remove any remaining test directories
    const testDirPattern = /^test-tools-integration(-\d+)?$/;
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

  describe('Validation and Gates Integration', () => {
    test('should validate spec and run gates together', () => {
      // Integration Contract: Validation and gates should work together

      try {
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        console.error('Init failed:', error.message);
        if (error.stderr) console.error('stderr:', error.stderr.toString());
        if (error.stdout) console.log('stdout:', error.stdout.toString());
        throw error;
      }

      // Only change directory if it exists
      if (fs.existsSync(testProjectPath)) {
        const originalDir = process.cwd();
        process.chdir(testProjectPath);

        try {
          execSync(`node "${cliPath}" scaffold`, {
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch (error) {
          console.error('Scaffold failed:', error.message);
          if (error.stderr) console.error('stderr:', error.stderr.toString());
          if (error.stdout) console.log('stdout:', error.stdout.toString());
          process.chdir(originalDir);
          throw error;
        }

        // Verify files exist before requiring them
        const validatePath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
        const gatesPath = path.join(testProjectPath, 'apps/tools/caws/gates.js');

        expect(fs.existsSync(validatePath)).toBe(true);
        expect(fs.existsSync(gatesPath)).toBe(true);

        const validateTool = require(validatePath);
        const gatesTool = require(gatesPath);
        const workingSpecPath = '.caws/working-spec.yaml';

        // Step 1: Validate the working spec
        expect(() => {
          validateTool(workingSpecPath);
        }).not.toThrow();

        // Step 2: Run gates on the validated project
        expect(() => {
          gatesTool();
        }).not.toThrow();

        // Restore working directory
        process.chdir(originalDir);
      } else {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }
    });

    test('should handle validation failures gracefully in gates', () => {
      // Integration Contract: Gates should handle validation failures

      try {
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
      } catch (error) {
        console.error('Init failed:', error.message);
        throw error;
      }

      // Only change directory if it exists
      if (fs.existsSync(testProjectPath)) {
        const originalDir = process.cwd();
        process.chdir(testProjectPath);

        try {
          execSync(`node "${cliPath}" scaffold`, {
            encoding: 'utf8',
            stdio: 'pipe',
          });
        } catch (error) {
          console.error('Scaffold failed:', error.message);
          process.chdir(originalDir);
          throw error;
        }

        const gatesPath = path.join(testProjectPath, 'apps/tools/caws/gates.js');
        expect(fs.existsSync(gatesPath)).toBe(true);

        const gatesTool = require(gatesPath);

        // Step 1: Create an invalid working spec
        const workingSpecPath = '.caws/working-spec.yaml';
        const invalidSpec = {
          id: 'INVALID-ID', // Invalid format
          title: 'Test',
          risk_tier: 5, // Invalid tier
          mode: 'invalid_mode', // Invalid mode
          scope: { in: '', out: '' },
          invariants: [],
          acceptance: [],
        };

        fs.writeFileSync(workingSpecPath, yaml.dump(invalidSpec));

        // Step 2: Gates should detect issues
        // Integration Contract: Gates should work even with invalid specs
        expect(() => {
          gatesTool();
        }).not.toThrow();

        // Restore working directory
        process.chdir(originalDir);
      } else {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }
    });
  });

  describe('Provenance Integration', () => {
    test('should generate provenance after successful validation', () => {
      // Integration Contract: Provenance should be generated after validation
      const originalDir = process.cwd();

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      if (!fs.existsSync(testProjectPath)) {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }

      scaffoldProject(testProjectPath, originalDir);

      const validatePath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const provenancePath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');

      expect(fs.existsSync(validatePath)).toBe(true);
      expect(fs.existsSync(provenancePath)).toBe(true);

      const validateTool = require(validatePath);
      const provenanceTool = require(provenancePath);
      const workingSpecPath = '.caws/working-spec.yaml';

      // Step 1: Validate successfully
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow();

      // Step 2: Generate provenance
      expect(() => {
        provenanceTool.generateProvenance();
      }).not.toThrow();

      // Integration Contract: Provenance should contain validation results
      expect(fs.existsSync('.agent/provenance.json')).toBe(true);

      const provenance = JSON.parse(fs.readFileSync('.agent/provenance.json', 'utf8'));
      expect(provenance).toHaveProperty('agent');
      expect(provenance).toHaveProperty('results');

      // Restore working directory
      process.chdir(originalDir);
    });

    test('should integrate provenance with project metadata', () => {
      // Integration Contract: Provenance should include project metadata
      const originalDir = process.cwd();

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      if (!fs.existsSync(testProjectPath)) {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }

      scaffoldProject(testProjectPath, originalDir);

      const provenancePath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');
      expect(fs.existsSync(provenancePath)).toBe(true);

      const provenanceTool = require(provenancePath);

      expect(() => {
        provenanceTool.generateProvenance();
      }).not.toThrow();

      const provenance = JSON.parse(fs.readFileSync('.agent/provenance.json', 'utf8'));

      // Integration Contract: Provenance should include project context
      expect(provenance.agent).toBe('caws-cli');
      expect(provenance).toHaveProperty('timestamp');
      expect(provenance).toHaveProperty('artifacts');

      // Restore working directory
      process.chdir(originalDir);
    });
  });

  describe('Cross-Tool Data Flow', () => {
    test('should maintain data consistency across tools', () => {
      // Integration Contract: Tools should maintain consistent project state
      const originalDir = process.cwd();

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      if (!fs.existsSync(testProjectPath)) {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }

      scaffoldProject(testProjectPath, originalDir);

      const workingSpecPath = '.caws/working-spec.yaml';
      const validatePath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const provenancePath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');

      expect(fs.existsSync(validatePath)).toBe(true);
      expect(fs.existsSync(provenancePath)).toBe(true);

      const validateTool = require(validatePath);
      const provenanceTool = require(provenancePath);

      // Step 1: Validate and generate provenance
      validateTool(workingSpecPath);
      provenanceTool.generateProvenance();

      // Step 3: Verify consistency
      const provenance = JSON.parse(fs.readFileSync('.agent/provenance.json', 'utf8'));

      // Integration Contract: Provenance should reflect the actual project state
      expect(provenance).toHaveProperty('results');
      expect(typeof provenance.results).toBe('object');

      // Restore working directory
      process.chdir(originalDir);
    });

    test('should handle tool execution order dependencies', () => {
      // Integration Contract: Tools should work in various execution orders
      const originalDir = process.cwd();

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      if (!fs.existsSync(testProjectPath)) {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }

      scaffoldProject(testProjectPath, originalDir);

      const validatePath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const gatesPath = path.join(testProjectPath, 'apps/tools/caws/gates.js');
      const provenancePath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');

      expect(fs.existsSync(validatePath)).toBe(true);
      expect(fs.existsSync(gatesPath)).toBe(true);
      expect(fs.existsSync(provenancePath)).toBe(true);

      const validateTool = require(validatePath);
      const gatesTool = require(gatesPath);
      const provenanceTool = require(provenancePath);

      // Test different execution orders
      const orders = [
        [validateTool, gatesTool, provenanceTool],
        [gatesTool, validateTool, provenanceTool],
        [validateTool, provenanceTool, gatesTool],
      ];

      orders.forEach((_order) => {
        // Integration Contract: Tools should work regardless of execution order
        expect(() => {
          _order.forEach((tool) => {
            if (tool === validateTool) {
              tool('.caws/working-spec.yaml');
            } else if (tool === provenanceTool) {
              tool.generateProvenance();
            } else {
              tool();
            }
          });
        }).not.toThrow();
      });

      // Restore working directory
      process.chdir(originalDir);
    });
  });

  describe('Error Recovery Integration', () => {
    test('should recover from tool failures gracefully', () => {
      // Integration Contract: One tool failure should not prevent others from running
      const originalDir = process.cwd();

      runCLICommand(`node "${cliPath}" init ${testProjectName} --non-interactive`);

      if (!fs.existsSync(testProjectPath)) {
        throw new Error(`Test project directory not created: ${testProjectPath}`);
      }

      scaffoldProject(testProjectPath, originalDir);

      const validatePath = path.join(testProjectPath, 'apps/tools/caws/validate.js');
      const provenancePath = path.join(testProjectPath, 'apps/tools/caws/provenance.js');

      expect(fs.existsSync(validatePath)).toBe(true);
      expect(fs.existsSync(provenancePath)).toBe(true);

      const validateTool = require(validatePath);
      const provenanceTool = require(provenancePath);

      // Step 1: Break the working spec
      const workingSpecPath = '.caws/working-spec.yaml';
      fs.writeFileSync(workingSpecPath, 'invalid: yaml: content: [');

      // Step 2: Validation should fail gracefully
      expect(() => {
        validateTool(workingSpecPath);
      }).not.toThrow(); // Should handle errors gracefully

      // Step 3: Provenance should still work
      expect(() => {
        provenanceTool.generateProvenance();
      }).not.toThrow();

      // Restore working directory
      process.chdir(originalDir);
    });
  });
});
