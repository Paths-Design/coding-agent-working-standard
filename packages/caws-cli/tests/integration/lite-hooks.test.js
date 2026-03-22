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
          NODE_PATH: path.resolve(__dirname, '../../../../node_modules'),
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

    test('fails closed on invalid scope.json (exit 2, not exit 0)', () => {
      // Write invalid JSON to scope.json to trigger parse error
      fs.writeFileSync(path.join(testDir, '.caws', 'scope.json'), '{ invalid json [');
      fs.ensureDirSync(path.join(testDir, 'src'));
      fs.writeFileSync(path.join(testDir, 'src', 'index.js'), '');
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'index.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('BLOCKED');
    });
  });

  describe('scope-guard.sh (full mode)', () => {
    // Full-mode tests: working-spec.yaml present, scope.json removed
    // The hook uses js-yaml to parse YAML specs and enforce scope

    function writeYaml(relPath, content) {
      const fullPath = path.join(testDir, relPath);
      fs.ensureDirSync(path.dirname(fullPath));
      fs.writeFileSync(fullPath, content);
    }

    const WORKING_SPEC = [
      'id: TEST-001',
      'title: Test spec for scope guard',
      'risk_tier: 2',
      'mode: feature',
      'scope:',
      '  in:',
      '    - src/',
      '  out:',
      '    - vendor/',
    ].join('\n');

    beforeEach(() => {
      // Remove scope.json so we enter full-mode path (not lite mode)
      const scopeJson = path.join(testDir, '.caws', 'scope.json');
      if (fs.existsSync(scopeJson)) {
        fs.removeSync(scopeJson);
      }
    });

    test('allows edits within scope.in', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'src'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'app.js'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('blocks edits in scope.out', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'vendor'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'vendor', 'package.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('blocks edits outside scope.in', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'lib'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'lib', 'utils.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('allows root-level files', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'package.json'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('allows .caws/ files', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, '.caws', 'working-spec.yaml'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('allows .claude/ files', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, '.claude', 'settings.json'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('skips terminal-status specs', () => {
      writeYaml('.caws/working-spec.yaml', WORKING_SPEC);
      writeYaml('.caws/specs/FEAT-001.yaml', [
        'id: FEAT-001',
        'title: Completed feature',
        'status: completed',
        'scope:',
        '  in:',
        '    - tiny/',
        '  out: []',
      ].join('\n'));
      fs.ensureDirSync(path.join(testDir, 'tiny'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'tiny', 'file.js'),
      });
      // tiny/ is only in the completed spec's scope.in, not in working-spec's scope.in
      // completed spec is skipped, so tiny/ is not in any active scope
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('feature spec adds to scope union', () => {
      writeYaml('.caws/working-spec.yaml', [
        'id: TEST-001',
        'title: Test spec',
        'risk_tier: 2',
        'scope:',
        '  in:',
        '    - src/',
        '  out: []',
      ].join('\n'));
      writeYaml('.caws/specs/FEAT-002.yaml', [
        'id: FEAT-002',
        'title: Active feature',
        'status: active',
        'scope:',
        '  in:',
        '    - lib/',
        '  out: []',
      ].join('\n'));
      fs.ensureDirSync(path.join(testDir, 'lib'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'lib', 'utils.js'),
      });
      // lib/ is in the active feature spec's scope.in, so it should be allowed
      expect(result.exitCode).toBe(0);
    });

    test('invalid YAML in working-spec allows all edits (security bypass)', () => {
      // This documents a known security issue: if working-spec.yaml has invalid YAML,
      // the js-yaml parser throws, the catch block outputs "error:...", and the bash
      // script falls through to exit 0 — allowing ALL edits regardless of scope.
      writeYaml('.caws/working-spec.yaml', '{{{bad yaml content!!!');
      fs.ensureDirSync(path.join(testDir, 'anywhere'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'anywhere', 'should-be-blocked.js'),
      });
      // SECURITY BYPASS: invalid YAML causes scope-guard to allow all edits.
      // The Node.js catch block outputs "error:..." which doesn't match
      // "out_of_scope:" or "not_in_scope", so bash falls through to exit 0.
      expect(result.exitCode).toBe(0);
      // Flag: this SHOULD exit 2 in a secure implementation.
      // The hook should fail-closed (block) on parse errors, not fail-open (allow).
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
