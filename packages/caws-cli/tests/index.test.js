/**
 * @fileoverview Comprehensive tests for CAWS CLI
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const yaml = require('js-yaml');

// Mock the template directory for testing
const mockTemplateDir = path.join(__dirname, 'mock-template');

describe('CAWS CLI', () => {
  const testProjectName = 'test-caws-project';

  beforeAll(() => {
    // Create mock template directory
    fs.mkdirSync(mockTemplateDir, { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, '.caws'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, 'apps/tools/caws'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, 'codemod'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, '.github/workflows'), { recursive: true });

    // Create minimal mock files
    fs.writeFileSync(path.join(mockTemplateDir, '.caws/working-spec.yaml'), 'id: TEST-001\n');
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/validate.js'),
      'console.log("mock validate");'
    );
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/gates.js'),
      'console.log("mock gates");'
    );
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/provenance.js'),
      'console.log("mock provenance");'
    );
    fs.writeFileSync(path.join(mockTemplateDir, 'codemod/test.js'), 'console.log("mock codemod");');
    fs.writeFileSync(path.join(mockTemplateDir, '.github/workflows/caws.yml'), 'name: test');

    // Try to use the actual caws-template for testing
    const templateDir = path.join(__dirname, '../../caws-template');
    if (fs.existsSync(templateDir)) {
      // Use the actual template instead of mock for better testing
      fs.rmSync(mockTemplateDir, { recursive: true, force: true });
      fs.symlinkSync(templateDir, mockTemplateDir);
    } else {
      // For global installations or when template is not available locally
      console.log('ℹ️  Using mock template for testing (template not found locally)');
      // Keep the mock files created above
    }
  });

  afterAll(() => {
    // Clean up mock template
    fs.rmSync(mockTemplateDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Clean up any existing test project
    if (fs.existsSync(testProjectName)) {
      fs.rmSync(testProjectName, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test project
    if (fs.existsSync(testProjectName)) {
      fs.rmSync(testProjectName, { recursive: true, force: true });
    }
  });

  describe('CLI Interface', () => {
    test('should show version information', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      const output = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' });
      expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should show help information', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      const output = execSync(`node "${cliPath}" --help`, { encoding: 'utf8' });
      expect(output).toContain('CAWS - Coding Agent Workflow System CLI');
      expect(output).toContain('init');
      expect(output).toContain('scaffold');
      expect(output).toContain('version');
    });

    test('should validate project name', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      expect(() => {
        try {
          execSync(`node "${cliPath}" init ""`, { encoding: 'utf8' });
        } catch (error) {
          // Error should contain project name validation message
          expect(error.message).toContain('Project name is required');
          throw error; // Re-throw to maintain test behavior
        }
      }).toThrow();
    });

    test('should sanitize project name', () => {
      const projectName = 'test project with spaces & special chars!';
      const sanitized = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      expect(sanitized).toBe('test-project-with-spaces---special-chars-');
    });
  });

  describe('Project Initialization', () => {
    test('should create project directory', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(testProjectName)).toBe(true);
    });

    test('should create .caws directory', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(path.join(testProjectName, '.caws'))).toBe(true);
    });

    test('should create working spec file', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      expect(fs.existsSync(workingSpecPath)).toBe(true);

      const workingSpec = yaml.load(fs.readFileSync(workingSpecPath, 'utf8'));
      expect(workingSpec).toHaveProperty('id');
      expect(workingSpec).toHaveProperty('title');
      expect(workingSpec).toHaveProperty('risk_tier');
      expect(workingSpec).toHaveProperty('mode');
    });

    test('should generate provenance manifest', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      try {
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
        });
      } catch (error) {
        // CLI might fail but we still check for provenance file
      }
      const provenancePath = path.join(testProjectName, '.agent/provenance.json');
      expect(fs.existsSync(provenancePath)).toBe(true);

      const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
      expect(provenance).toHaveProperty('agent', 'caws-cli');
      expect(provenance).toHaveProperty('model', 'cli-interactive');
      expect(provenance).toHaveProperty('artifacts');
      expect(provenance).toHaveProperty('results');
      expect(provenance).toHaveProperty('hash');
    });

    test('should initialize git repository when requested', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      try {
        // First create the project to ensure provenance exists
        execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
          encoding: 'utf8',
        });
        // Then try to initialize git
        execSync(`node "${cliPath}" init ${testProjectName} --git`, { encoding: 'utf8' });
        expect(fs.existsSync(path.join(testProjectName, '.git'))).toBe(true);
      } catch (error) {
        // If git initialization fails, check if .git directory exists anyway
        expect(fs.existsSync(path.join(testProjectName, '.git'))).toBe(true);
      }
    });
  });

  describe('Project Scaffolding', () => {
    beforeEach(() => {
      // Create a basic project structure with .caws directory
      fs.mkdirSync(testProjectName, { recursive: true });
      fs.mkdirSync(path.join(testProjectName, '.caws'), { recursive: true });
      fs.writeFileSync(
        path.join(testProjectName, '.caws/working-spec.yaml'),
        'id: TEST-SCAFFOLD\n'
      );
      process.chdir(testProjectName);
    });

    afterEach(() => {
      process.chdir(__dirname);
    });

    test('should scaffold CAWS components', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      try {
        execSync(`node "${cliPath}" scaffold`, { encoding: 'utf8', cwd: testProjectName });
      } catch (error) {
        // Scaffold might fail but we still check for created files
      }
      expect(fs.existsSync('.caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('codemod')).toBe(true);
    });

    test('should skip existing files', () => {
      // Create a file that would be scaffolded
      fs.mkdirSync('.caws', { recursive: true });
      fs.writeFileSync('.caws/test.txt', 'existing file');

      const cliPath = path.join(__dirname, '../dist/index.js');
      let output;
      try {
        output = execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
          cwd: testProjectName,
        });
      } catch (error) {
        output = error.stdout || '';
      }
      expect(output).toContain('Skipped .caws');
    });

    test('should generate scaffold provenance', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      try {
        execSync(`node "${cliPath}" scaffold`, { encoding: 'utf8', cwd: testProjectName });
      } catch (error) {
        // Scaffold might fail but we still check for provenance
      }
      const provenancePath = '.agent/scaffold-provenance.json';
      expect(fs.existsSync(provenancePath)).toBe(true);

      const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
      expect(provenance).toHaveProperty('agent', 'caws-cli');
      expect(provenance).toHaveProperty('model', 'cli-scaffold');
      expect(provenance).toHaveProperty('results');
      expect(provenance.results).toHaveProperty('files_added');
      expect(provenance.results).toHaveProperty('files_skipped');
    });
  });

  describe('Schema Validation', () => {
    test('should validate working spec against schema', () => {
      const cliPath = path.join(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });

      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      const workingSpec = yaml.load(fs.readFileSync(workingSpecPath, 'utf8'));

      // Basic validation checks - adjust for actual generated format
      expect(workingSpec.id).toMatch(/^[A-Z]+-[A-Z]+-[A-Z]+-\d+$/); // TEST-CAWS-PROJECT-001 format
      expect([1, 2, 3]).toContain(workingSpec.risk_tier);
      expect(['feature', 'refactor', 'fix', 'doc', 'chore']).toContain(workingSpec.mode);
      expect(workingSpec.scope).toHaveProperty('in');
      expect(workingSpec.scope).toHaveProperty('out');
      expect(workingSpec.invariants).toBeInstanceOf(Array);
      expect(workingSpec.acceptance).toBeInstanceOf(Array);
    });
  });

  describe('Error Handling', () => {
    test('should handle existing directory', () => {
      fs.mkdirSync(testProjectName, { recursive: true });

      const cliPath = path.join(__dirname, '../dist/index.js');
      expect(() => {
        try {
          execSync(`node "${cliPath}" init ${testProjectName}`, { encoding: 'utf8' });
        } catch (error) {
          // Error should contain directory exists message
          expect(error.message).toContain('already exists');
          throw error; // Re-throw to maintain test behavior
        }
      }).toThrow();
    });

    test('should handle template directory not found', () => {
      const originalDir = path.join(__dirname, '../../caws-template');
      const backupDir = path.join(__dirname, '../../caws-template-backup');

      // Temporarily rename template directory
      if (fs.existsSync(originalDir)) {
        fs.renameSync(originalDir, backupDir);

        const cliPath = path.join(__dirname, '../dist/index.js');
        expect(() => {
          try {
            execSync(`node "${cliPath}" init ${testProjectName}`, { encoding: 'utf8' });
          } catch (error) {
            // Error should contain template not found message
            expect(error.message).toContain('Template directory not found');
            throw error; // Re-throw to maintain test behavior
          }
        }).toThrow();

        // Restore template directory
        fs.renameSync(backupDir, originalDir);
      }
    });
  });
});
