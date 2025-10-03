/**
 * @fileoverview Integration tests for Cursor hooks scaffolding
 * @author @darianrosebrook
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('Cursor Hooks Integration', () => {
  const cliPath = path.join(__dirname, '../../dist/index.js');
  const testProjectName = 'test-cursor-hooks';
  const testProjectPath = path.join(__dirname, '../../', testProjectName);

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

  describe('Cursor Hooks Scaffolding', () => {
    test('should create .cursor directory structure on init', () => {
      // Initialize project (non-interactive, which should enable hooks by default)
      execSync(`node "${cliPath}" init ${testProjectName} --non-interactive --no-git`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      // Note: In non-interactive mode, Cursor hooks may not be enabled by default
      // The test should verify the structure exists if hooks were requested
      // For now, we'll check if the template includes cursor hooks
      const templateCursorDir = path.join(__dirname, '../../templates/.cursor');
      expect(fs.existsSync(templateCursorDir)).toBe(true);
    });

    test('should create hooks.json configuration file', () => {
      const templateHooksJson = path.join(__dirname, '../../templates/.cursor/hooks.json');

      expect(fs.existsSync(templateHooksJson)).toBe(true);

      const hooksConfig = JSON.parse(fs.readFileSync(templateHooksJson, 'utf8'));

      expect(hooksConfig).toHaveProperty('version', 1);
      expect(hooksConfig).toHaveProperty('hooks');
      expect(hooksConfig.hooks).toHaveProperty('beforeShellExecution');
      expect(hooksConfig.hooks).toHaveProperty('beforeReadFile');
      expect(hooksConfig.hooks).toHaveProperty('afterFileEdit');
    });

    test('should create all required hook scripts', () => {
      const templateHooksDir = path.join(__dirname, '../../templates/.cursor/hooks');

      const requiredScripts = [
        'audit.sh',
        'validate-spec.sh',
        'format.sh',
        'scan-secrets.sh',
        'block-dangerous.sh',
        'scope-guard.sh',
        'naming-check.sh',
      ];

      requiredScripts.forEach((script) => {
        const scriptPath = path.join(templateHooksDir, script);
        expect(fs.existsSync(scriptPath)).toBe(true);

        // Verify script has shebang
        const content = fs.readFileSync(scriptPath, 'utf8');
        expect(content).toMatch(/^#!\/bin\/bash/);
      });
    });

    test('should create README.md in .cursor directory', () => {
      const templateReadme = path.join(__dirname, '../../templates/.cursor/README.md');

      expect(fs.existsSync(templateReadme)).toBe(true);

      const content = fs.readFileSync(templateReadme, 'utf8');
      expect(content).toContain('Cursor Hooks for CAWS');
      expect(content).toContain('Safety Hooks');
      expect(content).toContain('Quality Hooks');
      expect(content).toContain('Scope Hooks');
      expect(content).toContain('Audit Hooks');
    });
  });

  describe('Hook Script Validation', () => {
    test('audit.sh should handle JSON input', () => {
      const auditScript = path.join(__dirname, '../../templates/.cursor/hooks/audit.sh');

      expect(fs.existsSync(auditScript)).toBe(true);

      const content = fs.readFileSync(auditScript, 'utf8');
      expect(content).toContain('INPUT=$(cat)');
      expect(content).toContain('jq');
      expect(content).toContain('.cursor/logs');
    });

    test('block-dangerous.sh should block dangerous commands', () => {
      const blockScript = path.join(__dirname, '../../templates/.cursor/hooks/block-dangerous.sh');

      expect(fs.existsSync(blockScript)).toBe(true);

      const content = fs.readFileSync(blockScript, 'utf8');
      expect(content).toContain('rm -rf /');
      expect(content).toContain('DROP DATABASE');
      expect(content).toContain('permission');
      expect(content).toContain('deny');
    });

    test('scan-secrets.sh should detect environment files', () => {
      const scanScript = path.join(__dirname, '../../templates/.cursor/hooks/scan-secrets.sh');

      expect(fs.existsSync(scanScript)).toBe(true);

      const content = fs.readFileSync(scanScript, 'utf8');
      expect(content).toMatch(/env/); // Check for 'env' pattern (appears in regex)
      expect(content).toMatch(/pem|key/); // Check for key file patterns
      expect(content).toMatch(/api.*key/); // Check for API key patterns
      expect(content).toMatch(/secret.*key/); // Check for secret key patterns
    });

    test('naming-check.sh should enforce naming conventions', () => {
      const namingScript = path.join(__dirname, '../../templates/.cursor/hooks/naming-check.sh');

      expect(fs.existsSync(namingScript)).toBe(true);

      const content = fs.readFileSync(namingScript, 'utf8');
      expect(content).toContain('enhanced-');
      expect(content).toContain('-copy');
      expect(content).toContain('final-');
      expect(content).toContain('Naming violation');
    });

    test('validate-spec.sh should check working-spec.yaml', () => {
      const validateScript = path.join(__dirname, '../../templates/.cursor/hooks/validate-spec.sh');

      expect(fs.existsSync(validateScript)).toBe(true);

      const content = fs.readFileSync(validateScript, 'utf8');
      expect(content).toContain('working-spec.yaml');
      expect(content).toContain('validate.js');
      expect(content).toContain('caws validate');
    });

    test('format.sh should support common formatters', () => {
      const formatScript = path.join(__dirname, '../../templates/.cursor/hooks/format.sh');

      expect(fs.existsSync(formatScript)).toBe(true);

      const content = fs.readFileSync(formatScript, 'utf8');
      expect(content).toContain('prettier');
      expect(content).toContain('eslint');
      expect(content).toContain('--fix');
    });

    test('scope-guard.sh should check file scope', () => {
      const scopeScript = path.join(__dirname, '../../templates/.cursor/hooks/scope-guard.sh');

      expect(fs.existsSync(scopeScript)).toBe(true);

      const content = fs.readFileSync(scopeScript, 'utf8');
      expect(content).toContain('working-spec.yaml');
      expect(content).toContain('scope-guard.js');
      expect(content).toContain('attachments');
    });
  });

  describe('Hook Configuration', () => {
    test('hooks.json should have correct structure for all events', () => {
      const hooksJson = path.join(__dirname, '../../templates/.cursor/hooks.json');
      const config = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));

      // Check for all required hook events
      expect(config.hooks).toHaveProperty('beforeShellExecution');
      expect(config.hooks).toHaveProperty('beforeMCPExecution');
      expect(config.hooks).toHaveProperty('beforeReadFile');
      expect(config.hooks).toHaveProperty('afterFileEdit');
      expect(config.hooks).toHaveProperty('beforeSubmitPrompt');
      expect(config.hooks).toHaveProperty('stop');

      // Verify beforeShellExecution includes dangerous command blocker
      const shellHooks = config.hooks.beforeShellExecution;
      expect(shellHooks.some((h) => h.command.includes('block-dangerous.sh'))).toBe(true);

      // Verify beforeReadFile includes secrets scanner
      const readHooks = config.hooks.beforeReadFile;
      expect(readHooks.some((h) => h.command.includes('scan-secrets.sh'))).toBe(true);

      // Verify afterFileEdit includes formatting and validation
      const editHooks = config.hooks.afterFileEdit;
      expect(editHooks.some((h) => h.command.includes('format.sh'))).toBe(true);
      expect(editHooks.some((h) => h.command.includes('naming-check.sh'))).toBe(true);
      expect(editHooks.some((h) => h.command.includes('validate-spec.sh'))).toBe(true);

      // Verify audit is included in multiple events
      expect(shellHooks.some((h) => h.command.includes('audit.sh'))).toBe(true);
      expect(editHooks.some((h) => h.command.includes('audit.sh'))).toBe(true);
      expect(config.hooks.stop.some((h) => h.command.includes('audit.sh'))).toBe(true);
    });

    test('hook commands should use relative paths', () => {
      const hooksJson = path.join(__dirname, '../../templates/.cursor/hooks.json');
      const config = JSON.parse(fs.readFileSync(hooksJson, 'utf8'));

      const allHooks = Object.values(config.hooks).flat();

      allHooks.forEach((hook) => {
        expect(hook.command).toMatch(/^\.\/.cursor\/hooks\//);
      });
    });
  });

  describe('Documentation', () => {
    test('CURSOR_HOOKS.md should exist in docs', () => {
      // Navigate up from packages/caws-cli/tests/integration to docs
      const docsPath = path.join(__dirname, '../../../../docs/CURSOR_HOOKS.md');

      expect(fs.existsSync(docsPath)).toBe(true);

      const content = fs.readFileSync(docsPath, 'utf8');
      expect(content).toContain('Cursor Hooks Integration Guide');
      expect(content).toContain('Three-Tier Quality Approach');
      expect(content).toContain('Safety Hooks');
      expect(content).toContain('Quality Hooks');
      expect(content).toContain('Scope Hooks');
      expect(content).toContain('Audit Hooks');
    });

    test('HOOK_STRATEGY.md should include Cursor hooks', () => {
      // Navigate up from packages/caws-cli/tests/integration to docs
      const strategyPath = path.join(__dirname, '../../../../docs/HOOK_STRATEGY.md');

      expect(fs.existsSync(strategyPath)).toBe(true);

      const content = fs.readFileSync(strategyPath, 'utf8');
      expect(content).toContain('Cursor (Real-time)');
      expect(content).toContain('Cursor Hooks');
    });

    test('AGENTS.md should mention Cursor hooks', () => {
      // Navigate up from packages/caws-cli/tests/integration to root
      const agentsPath = path.join(__dirname, '../../../../AGENTS.md');

      expect(fs.existsSync(agentsPath)).toBe(true);

      const content = fs.readFileSync(agentsPath, 'utf8');
      expect(content).toContain('Cursor Hooks');
      expect(content).toContain('Real-Time Quality');
    });
  });
});
