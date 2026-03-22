/**
 * @fileoverview Integration tests for CAWS Lite mode hooks
 * Tests the end-to-end hook chain in a temporary repo
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { execFileSync, execSync } = require('child_process');

describe('lite-hooks integration', () => {
  let testDir;
  let originalCwd;
  let templateDir;

  beforeAll(() => {
    // Find the templates directory
    templateDir = path.resolve(__dirname, '../../templates');
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lite-hooks-'));

    // Initialize git repo
    execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });

    // Create initial commit
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'pipe' });

    // Setup lite mode config
    fs.ensureDirSync(path.join(testDir, '.caws'));
    fs.writeJsonSync(path.join(testDir, '.caws', 'scope.json'), {
      version: 1,
      allowedDirectories: ['src/', 'tests/'],
      bannedPatterns: {
        files: ['*-enhanced.*', '*-final.*', '*-v2.*', '*-copy.*'],
        directories: ['*venv*'],
        docs: ['*-summary.md'],
      },
      maxNewFilesPerCommit: 10,
      designatedVenvPath: '.venv',
    });

    fs.writeJsonSync(path.join(testDir, '.caws', 'mode.json'), {
      current: 'lite',
      initialized: true,
    });

    // Copy hook scripts
    const hooksDir = path.join(testDir, '.claude', 'hooks');
    fs.ensureDirSync(hooksDir);

    const hooksToCopy = [
      'block-dangerous.sh',
      'scope-guard.sh',
      'lite-sprawl-check.sh',
      'simplification-guard.sh',
    ];

    for (const hook of hooksToCopy) {
      const src = path.join(templateDir, '.claude', 'hooks', hook);
      const dest = path.join(hooksDir, hook);
      if (fs.existsSync(src)) {
        fs.copySync(src, dest);
        fs.chmodSync(dest, 0o755);
      }
    }

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(testDir);
  });

  /**
   * Simulate a Claude Code hook invocation
   */
  function runHook(hookName, toolName, toolInput) {
    const hookPath = path.join(testDir, '.claude', 'hooks', hookName);
    if (!fs.existsSync(hookPath)) {
      throw new Error(`Hook not found: ${hookPath}`);
    }

    const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });

    try {
      const output = execSync(`echo '${input.replace(/'/g, "'\\''")}' | bash "${hookPath}"`, {
        cwd: testDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: testDir,
        },
      });
      return { exitCode: 0, stdout: output, stderr: '' };
    } catch (error) {
      return {
        exitCode: error.status || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
      };
    }
  }

  describe('block-dangerous.sh', () => {
    test('blocks git push --force', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git push --force origin main' });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('BLOCKED');
    });

    test('blocks git init', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git init' });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('BLOCKED');
    });

    test('blocks git reset --hard', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git reset --hard HEAD~1' });
      expect(result.exitCode).toBe(2);
    });

    test('blocks venv creation', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'python -m venv myenv' });
      expect(result.exitCode).toBe(2);
    });

    test('allows normal git commands', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git status' });
      expect(result.exitCode).toBe(0);
    });

    test('allows normal commands', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'npm test' });
      expect(result.exitCode).toBe(0);
    });

    test('ignores non-Bash tools', () => {
      const result = runHook('block-dangerous.sh', 'Write', { file_path: 'test.js' });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('scope-guard.sh (lite mode)', () => {
    test('allows edits in allowed directories', () => {
      // Create the src dir so realpath works
      fs.ensureDirSync(path.join(testDir, 'src'));
      fs.writeFileSync(path.join(testDir, 'src', 'index.js'), '');
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'index.js'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('blocks out-of-scope edits', () => {
      fs.ensureDirSync(path.join(testDir, 'vendor'));
      fs.writeFileSync(path.join(testDir, 'vendor', 'package.js'), '');
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'vendor', 'package.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('ignores non-Write/Edit tools', () => {
      const result = runHook('scope-guard.sh', 'Bash', { command: 'ls' });
      expect(result.exitCode).toBe(0);
    });
  });

  describe('lite-sprawl-check.sh', () => {
    test('blocks banned file patterns', () => {
      const result = runHook('lite-sprawl-check.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'utils-enhanced.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('BLOCKED');
      expect(result.stderr).toContain('sprawl');
    });

    test('blocks banned doc patterns', () => {
      const result = runHook('lite-sprawl-check.sh', 'Write', {
        file_path: path.join(testDir, 'docs', 'feature-summary.md'),
      });
      expect(result.exitCode).toBe(2);
    });

    test('allows normal files', () => {
      const result = runHook('lite-sprawl-check.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'utils.js'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('ignores non-Write tools', () => {
      const result = runHook('lite-sprawl-check.sh', 'Edit', {
        file_path: path.join(testDir, 'src', 'utils-enhanced.js'),
      });
      expect(result.exitCode).toBe(0);
    });
  });
});
