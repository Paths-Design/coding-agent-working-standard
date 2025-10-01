/**
 * @fileoverview Contract tests for CAWS CLI interface
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

describe('CLI Interface Contracts', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');
  const testProjectName = 'test-cli-contract';

  beforeAll(() => {
    // Ensure CLI is built
    if (!fs.existsSync(cliPath)) {
      execSync('npm run build', { cwd: path.join(__dirname, '../..'), stdio: 'pipe' });
    }
  });

  beforeEach(() => {
    // Clean up any existing test project
    if (fs.existsSync(testProjectName)) {
      fs.rmSync(testProjectName, { recursive: true, force: true });
      console.log(`🧹 Cleaned up: ${testProjectName}`);
    }
  });

  afterAll(() => {
    // Clean up test project
    if (fs.existsSync(testProjectName)) {
      fs.rmSync(testProjectName, { recursive: true, force: true });
    }
  });

  describe('CLI Command Contracts', () => {
    test('init command should create valid project structure', () => {
      // Contract: init should create .caws directory with working-spec.yaml
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      expect(fs.existsSync(testProjectName)).toBe(true);
      expect(fs.existsSync(path.join(testProjectName, '.caws'))).toBe(true);

      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      expect(fs.existsSync(workingSpecPath)).toBe(true);

      // Validate the generated spec conforms to expected schema
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);

      // Contract: Must have these required fields
      expect(spec).toHaveProperty('id');
      expect(spec).toHaveProperty('title');
      expect(spec).toHaveProperty('risk_tier');
      expect(spec).toHaveProperty('mode');
      expect(spec).toHaveProperty('scope');
      expect(spec).toHaveProperty('invariants');
      expect(spec).toHaveProperty('acceptance');

      // Contract: ID should follow pattern
      expect(spec.id).toMatch(/^[A-Z]+-[A-Z]+-[A-Z]+-\d+$/);

      // Contract: Risk tier should be valid
      expect([1, 2, 3]).toContain(spec.risk_tier);

      // Contract: Mode should be valid
      expect(['feature', 'refactor', 'fix', 'doc', 'chore']).toContain(spec.mode);
    });

    test('scaffold command should create valid tool structure', () => {
      // Create a basic project first
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectName);

      try {
        // Contract: scaffold should create apps/tools/caws structure
        execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });

        expect(fs.existsSync('apps/tools/caws')).toBe(true);
        expect(fs.existsSync('apps/tools/caws/validate.js')).toBe(true);
        expect(fs.existsSync('apps/tools/caws/gates.js')).toBe(true);
        expect(fs.existsSync('apps/tools/caws/provenance.js')).toBe(true);
        expect(fs.existsSync('.agent')).toBe(true);
      } finally {
        process.chdir(__dirname);
      }
    });

    test('CLI should handle invalid arguments gracefully', () => {
      // Contract: CLI should provide helpful error messages for invalid input
      expect(() => {
        try {
          execSync(`node "${cliPath}" init ""`, { encoding: 'utf8' });
        } catch (error) {
          expect(error.message).toContain('Project name is required');
          throw error;
        }
      }).toThrow();
    });

    test('CLI version should follow semantic versioning', () => {
      // Contract: Version should be semantic versioning format
      const output = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' });
      // Extract just the version number from the output
      const versionMatch = output.match(/(\d+\.\d+\.\d+)/);
      const version = versionMatch ? versionMatch[1] : output.trim();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    });
  });

  describe('Configuration Schema Contracts', () => {
    test('working spec should validate against schema requirements', () => {
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);

      // Contract: Required fields should be present and valid
      expect(typeof spec.id).toBe('string');
      expect(typeof spec.title).toBe('string');
      expect(typeof spec.risk_tier).toBe('number');
      expect(typeof spec.mode).toBe('string');

      // Contract: Arrays should be properly formatted
      expect(Array.isArray(spec.invariants)).toBe(true);
      expect(Array.isArray(spec.acceptance)).toBe(true);

      // Contract: Scope should have required fields
      expect(spec.scope).toHaveProperty('in');
      expect(spec.scope).toHaveProperty('out');
    });

    test('tool configurations should have valid interfaces', () => {
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      process.chdir(testProjectName);

      try {
        execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });

        // Contract: Tool files should export expected interfaces
        const validateTool = require(
          path.join(__dirname, '../../../caws-template/apps/tools/caws/validate.js')
        );
        const gatesTool = require(
          path.join(__dirname, '../../../caws-template/apps/tools/caws/gates.js')
        );
        const provenanceTool = require(
          path.join(__dirname, '../../../caws-template/apps/tools/caws/provenance.js')
        );

        // Each tool should be a function or have a main export
        expect(typeof validateTool).toBe('function');
        expect(typeof gatesTool).toBe('function');
        expect(typeof provenanceTool).toBe('function');
      } finally {
        process.chdir(__dirname);
      }
    });
  });

  describe('Working Spec Schema Contract', () => {
    test('generated spec should conform to documented schema', () => {
      // This test validates that the working spec generation follows
      // the documented schema contract
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      const specContent = fs.readFileSync(workingSpecPath, 'utf8');
      const spec = yaml.load(specContent);

      // Contract: Schema should include all documented fields
      const expectedFields = [
        'id',
        'title',
        'risk_tier',
        'mode',
        'scope',
        'invariants',
        'acceptance',
        'threats',
        'migrations',
        'rollback',
      ];

      expectedFields.forEach((field) => {
        expect(spec).toHaveProperty(field);
      });

      // Contract: Field types should match expectations
      expect(typeof spec.id).toBe('string');
      expect(typeof spec.title).toBe('string');
      expect(typeof spec.risk_tier).toBe('number');
      expect(typeof spec.mode).toBe('string');
      expect(Array.isArray(spec.invariants)).toBe(true);
      expect(Array.isArray(spec.acceptance)).toBe(true);
    });
  });
});
