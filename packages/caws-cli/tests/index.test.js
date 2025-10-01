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
      const output = execSync('node dist/index.js --version', { encoding: 'utf8' });
      expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should show help information', () => {
      const output = execSync('node dist/index.js --help', { encoding: 'utf8' });
      expect(output).toContain('CAWS - Coding Agent Workflow System CLI');
      expect(output).toContain('init');
      expect(output).toContain('scaffold');
      expect(output).toContain('version');
    });

    test('should validate project name', () => {
      expect(() => {
        execSync('node dist/index.js init ""', { encoding: 'utf8' });
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
      execSync(`node src/index.js init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(testProjectName)).toBe(true);
    });

    test('should create .caws directory', () => {
      execSync(`node src/index.js init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(path.join(testProjectName, '.caws'))).toBe(true);
    });

    test('should create working spec file', () => {
      execSync(`node src/index.js init ${testProjectName} --non-interactive`, {
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
      execSync(`node src/index.js init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
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
      execSync(`node src/index.js init ${testProjectName} --git`, { encoding: 'utf8' });
      expect(fs.existsSync(path.join(testProjectName, '.git'))).toBe(true);
    });
  });

  describe('Project Scaffolding', () => {
    beforeEach(() => {
      // Create a basic project structure
      fs.mkdirSync(testProjectName, { recursive: true });
      process.chdir(testProjectName);
    });

    afterEach(() => {
      process.chdir(__dirname);
    });

    test('should scaffold CAWS components', () => {
      execSync('node ../../src/index.js scaffold', { encoding: 'utf8', cwd: testProjectName });
      expect(fs.existsSync('.caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('codemod')).toBe(true);
    });

    test('should skip existing files', () => {
      // Create a file that would be scaffolded
      fs.mkdirSync('.caws', { recursive: true });
      fs.writeFileSync('.caws/test.txt', 'existing file');

      const output = execSync('node ../../src/index.js scaffold', {
        encoding: 'utf8',
        cwd: testProjectName,
      });
      expect(output).toContain('Skipped .caws');
    });

    test('should generate scaffold provenance', () => {
      execSync('node ../../src/index.js scaffold', { encoding: 'utf8', cwd: testProjectName });
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
      execSync(`node src/index.js init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });

      const workingSpecPath = path.join(testProjectName, '.caws/working-spec.yaml');
      const workingSpec = yaml.load(fs.readFileSync(workingSpecPath, 'utf8'));

      // Basic validation checks
      expect(workingSpec.id).toMatch(/^[A-Z]+-\d+$/);
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

      expect(() => {
        execSync(`node dist/index.js init ${testProjectName}`, { encoding: 'utf8' });
      }).toThrow();
    });

    test('should handle template directory not found', () => {
      const originalDir = path.join(__dirname, '../../caws-template');
      const backupDir = path.join(__dirname, '../../caws-template-backup');

      // Temporarily rename template directory
      if (fs.existsSync(originalDir)) {
        fs.renameSync(originalDir, backupDir);

        expect(() => {
          execSync(`node dist/index.js init ${testProjectName}`, { encoding: 'utf8' });
        }).toThrow();

        // Restore template directory
        fs.renameSync(backupDir, originalDir);
      }
    });
  });
});
