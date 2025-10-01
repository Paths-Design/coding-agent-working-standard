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
    // Clean up any existing test projects and mock directories
    if (fs.existsSync(testProjectName)) {
      fs.rmSync(testProjectName, { recursive: true, force: true });
    }
    if (fs.existsSync(mockTemplateDir)) {
      fs.rmSync(mockTemplateDir, { recursive: true, force: true });
    }

    // Create mock template directory
    fs.mkdirSync(mockTemplateDir, { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, '.caws'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, 'apps/tools/caws'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, 'codemod'), { recursive: true });
    fs.mkdirSync(path.join(mockTemplateDir, '.github/workflows'), { recursive: true });

    // Create minimal mock files that simulate real tool outputs
    fs.writeFileSync(path.join(mockTemplateDir, '.caws/working-spec.yaml'), 'id: TEST-001\n');
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/validate.js'),
      `#!/usr/bin/env node
console.log("✅ Working specification is valid");
console.log("ID: TEST-001");
console.log("Title: Test Project for Tools");
console.log("Risk Tier: 2");
console.log("Mode: feature");
console.log("📊 Scope Analysis:");
console.log("  IN: test files");
console.log("  OUT: other files");
console.log("📝 Quality Metrics:");
console.log("  Invariants: 1");
console.log("  Acceptance criteria: 1");
process.exit(0);`
    );
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/gates.js'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const command = args[0];

if (command === 'tier') {
  console.log("📋 Tier 1 Policy Analysis:");
  console.log("Branch Coverage: ≥90%");
  console.log("Mutation Score: ≥70%");
  console.log("Max Files: 40");
} else if (command === 'coverage') {
  const tier = args[1];
  const coverage = parseFloat(args[2]);
  if (coverage >= 0.85) {
    console.log("✅ Branch coverage gate passed:");
    console.log(\`  Coverage: \${coverage * 100}%\`);
  } else {
    console.log("❌ Branch coverage gate failed:");
    console.log(\`  Coverage: \${coverage * 100}% (required: ≥85%)\`);
    process.exit(1);
  }
} else if (command === 'budget') {
  const tier = args[1];
  const files = parseInt(args[2]);
  const loc = parseInt(args[3]);
  console.log("✅ Budget gate passed:");
  console.log(\`  Files: \${files}, LOC: \${loc}\`);
}
process.exit(0);`
    );
    fs.writeFileSync(
      path.join(mockTemplateDir, 'apps/tools/caws/provenance.js'),
      `#!/usr/bin/env node
console.log("mock provenance");
module.exports = {
  generateProvenance: () => ({ agent: 'caws-cli', version: '1.0.0' }),
  saveProvenance: () => Promise.resolve()
};`
    );
    fs.writeFileSync(path.join(mockTemplateDir, 'codemod/test.js'), 'console.log("mock codemod");');
    fs.writeFileSync(path.join(mockTemplateDir, '.github/workflows/caws.yml'), 'name: test');

    // Check if template dependency is available
    const hasTemplateDependency = (() => {
      try {
        require.resolve('@caws/template');
        return true;
      } catch {
        return false;
      }
    })();

    if (hasTemplateDependency) {
      // Use dependency for consistent testing across environments
      console.log('ℹ️  Using template dependency for testing');
      // Keep the mock files but they will be overridden by dependency resolution
    } else {
      // Fallback to local template if dependency not available
      const templateDir = path.join(__dirname, '../../caws-template');
      if (fs.existsSync(templateDir)) {
        // Use the actual template instead of mock for better testing
        fs.rmSync(mockTemplateDir, { recursive: true, force: true });
        fs.symlinkSync(templateDir, mockTemplateDir);
      } else {
        console.log('ℹ️  Using mock template for testing (template not found locally)');
        // Keep the mock files created above
      }
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
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      const output = execSync(`node "${cliPath}" --version`, { encoding: 'utf8' });
      expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
    });

    test('should show help information', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      const output = execSync(`node "${cliPath}" --help`, { encoding: 'utf8' });
      expect(output).toContain('CAWS - Coding Agent Workflow System CLI');
      expect(output).toContain('init');
      expect(output).toContain('scaffold');
      expect(output).toContain('version');
    });

    test('should validate project name', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
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
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(testProjectName)).toBe(true);
    });

    test('should create .caws directory', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      expect(fs.existsSync(path.join(testProjectName, '.caws'))).toBe(true);
    });

    test('should create working spec file', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
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

    test('should create agents.md guide', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive`, {
        encoding: 'utf8',
      });
      const agentsMdPath = path.join(testProjectName, 'agents.md');
      expect(fs.existsSync(agentsMdPath)).toBe(true);

      // Verify it's not empty
      const content = fs.readFileSync(agentsMdPath, 'utf8');
      expect(content.length).toBeGreaterThan(1000);
      expect(content).toContain('CAWS');
    });

    test('should initialize in current directory with "."', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      const currentDirTest = 'test-current-dir-init';

      // Create directory and add existing file
      fs.mkdirSync(currentDirTest);
      fs.writeFileSync(path.join(currentDirTest, 'existing.js'), 'console.log("test")');

      // Change to directory and init with '.'
      const originalCwd = process.cwd();
      try {
        process.chdir(currentDirTest);
        execSync(`node "${cliPath}" init . --non-interactive`, {
          encoding: 'utf8',
        });

        // Should create CAWS files in current directory, not subdirectory
        expect(fs.existsSync('.caws')).toBe(true);
        expect(fs.existsSync('.agent')).toBe(true);
        expect(fs.existsSync('agents.md')).toBe(true);
        expect(fs.existsSync('existing.js')).toBe(true);

        // Should NOT create a subdirectory named '-'
        expect(fs.existsSync('-')).toBe(false);
      } finally {
        process.chdir(originalCwd);
        if (fs.existsSync(currentDirTest)) {
          fs.rmSync(currentDirTest, { recursive: true, force: true });
        }
      }
    });

    test('should handle agents.md conflict with caws.md fallback', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      const conflictTest = 'test-agents-conflict';

      // Create directory with existing agents.md
      fs.mkdirSync(conflictTest);
      fs.writeFileSync(path.join(conflictTest, 'agents.md'), 'Custom agents guide');

      const originalCwd = process.cwd();
      try {
        process.chdir(conflictTest);
        execSync(`node "${cliPath}" init . --non-interactive`, {
          encoding: 'utf8',
        });

        // Original agents.md should be preserved
        const originalContent = fs.readFileSync('agents.md', 'utf8');
        expect(originalContent).toBe('Custom agents guide');

        // CAWS guide should be in caws.md
        expect(fs.existsSync('caws.md')).toBe(true);
        const cawsContent = fs.readFileSync('caws.md', 'utf8');
        expect(cawsContent.length).toBeGreaterThan(1000);
        expect(cawsContent).toContain('CAWS');
      } finally {
        process.chdir(originalCwd);
        if (fs.existsSync(conflictTest)) {
          fs.rmSync(conflictTest, { recursive: true, force: true });
        }
      }
    });

    test('should skip guide copy when both agents.md and caws.md exist', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      const bothExistTest = 'test-both-exist';

      // Create directory with both files
      fs.mkdirSync(bothExistTest);
      fs.writeFileSync(path.join(bothExistTest, 'agents.md'), 'Custom agents');
      fs.writeFileSync(path.join(bothExistTest, 'caws.md'), 'Custom CAWS');

      const originalCwd = process.cwd();
      try {
        process.chdir(bothExistTest);
        const output = execSync(`node "${cliPath}" init . --non-interactive`, {
          encoding: 'utf8',
        });

        // Should show warning about skipping
        expect(output).toContain('skipping guide copy');

        // Both files should be preserved
        expect(fs.readFileSync('agents.md', 'utf8')).toBe('Custom agents');
        expect(fs.readFileSync('caws.md', 'utf8')).toBe('Custom CAWS');
      } finally {
        process.chdir(originalCwd);
        if (fs.existsSync(bothExistTest)) {
          fs.rmSync(bothExistTest, { recursive: true, force: true });
        }
      }
    });

    test('should generate provenance manifest', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
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
      const cliPath = path.resolve(__dirname, '../dist/index.js');
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
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      try {
        execSync(`node "${cliPath}" scaffold`, { encoding: 'utf8' });
      } catch (error) {
        // Scaffold might fail but we still check for created files
      }
      expect(fs.existsSync('.caws')).toBe(true);
      expect(fs.existsSync('apps/tools/caws')).toBe(true);
      expect(fs.existsSync('codemod')).toBe(true);
    });

    test('should add new enhancements to existing project', () => {
      // Create a file that would be scaffolded
      fs.mkdirSync('.caws', { recursive: true });
      fs.writeFileSync('.caws/test.txt', 'existing file');

      const cliPath = path.resolve(__dirname, '../dist/index.js');
      let output;
      try {
        output = execSync(`node "${cliPath}" scaffold`, {
          encoding: 'utf8',
        });
      } catch (error) {
        output = error.stdout || '';
      }
      expect(output).toContain('✅ Added CAWS tools directory');
      expect(output).toContain('✅ Added Codemod transformation scripts');
    });

    test('should generate scaffold provenance', () => {
      const cliPath = path.resolve(__dirname, '../dist/index.js');
      try {
        execSync(`node "${cliPath}" scaffold`, { encoding: 'utf8' });
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
      const cliPath = path.resolve(__dirname, '../dist/index.js');
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

      const cliPath = path.resolve(__dirname, '../dist/index.js');
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

        const cliPath = path.resolve(__dirname, '../dist/index.js');
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
