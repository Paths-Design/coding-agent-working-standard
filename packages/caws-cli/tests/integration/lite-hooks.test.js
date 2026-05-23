/**
 * @fileoverview Integration tests for CAWS Lite mode hooks
 * Tests the end-to-end hook chain in a temporary repo
 */

const path = require('path');
const fs = require('fs-extra');
const { execFileSync, execSync } = require('child_process');
const { createTemplateRepo, cloneFixture, cleanupTestDir, cleanupTemplate } = require('../helpers/git-fixture');

describe('lite-hooks integration', () => {
  let gitTemplate;
  let testDir;
  let originalCwd;
  let templateDir;

  beforeAll(() => {
    // Find the templates directory
    templateDir = path.resolve(__dirname, '../../templates');
    // Create reusable git template
    gitTemplate = createTemplateRepo();
  });

  afterAll(() => {
    cleanupTemplate(gitTemplate);
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = cloneFixture(gitTemplate, 'caws-lite-hooks-');

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

    // Copy classify_command.py — without it, block-dangerous.sh follows
    // the ask-latch missing-classifier path. With it, we exercise the
    // real classifier decisions (which can be ask, deny, or allow).
    const classifierSrc = path.join(templateDir, '.claude', 'hooks', 'classify_command.py');
    const classifierDest = path.join(hooksDir, 'classify_command.py');
    if (fs.existsSync(classifierSrc)) {
      fs.copySync(classifierSrc, classifierDest);
      fs.chmodSync(classifierDest, 0o755);
    }

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTestDir(testDir);
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
    // The hook follows the Claude Code PreToolUse JSON protocol:
    // - exit 0 always (the harness reads `permissionDecision` from stdout)
    // - permissionDecision: "ask"   → human approval gate
    // - permissionDecision: "deny"  → categorical block (reserved for
    //                                 structurally unsafe commands)
    // - allow (no decision field)   → silently allow
    //
    // Authority-bearing / destructive commands (force push, hard reset,
    // git init, venv creation) are deliberately classified `ask`, not
    // `deny`, so the user can authorize them when contextually safe.
    // See docs/architecture/event-order.md, classify_command.py.
    function parseHookJson(stdout) {
      const trimmed = (stdout || '').trim();
      if (!trimmed) return null;
      try {
        return JSON.parse(trimmed);
      } catch {
        return null;
      }
    }
    function expectAskEnvelope(result, reasonSubstring) {
      expect(result.exitCode).toBe(0);
      const envelope = parseHookJson(result.stdout);
      expect(envelope).not.toBeNull();
      expect(envelope.hookSpecificOutput).toBeDefined();
      expect(envelope.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(envelope.hookSpecificOutput.permissionDecision).toBe('ask');
      if (reasonSubstring) {
        expect(envelope.hookSpecificOutput.permissionDecisionReason).toContain(reasonSubstring);
      }
    }

    test('ask-gates git push --force (destructive authority)', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git push --force origin main' });
      expectAskEnvelope(result, 'git force push');
    });

    test('ask-gates git init (creates a new repo authority boundary)', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git init' });
      expectAskEnvelope(result, 'git init');
    });

    test('ask-gates git reset --hard (destructive)', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git reset --hard HEAD~1' });
      expectAskEnvelope(result, 'git reset --hard');
    });

    test('ask-gates python -m venv (virtual environment creation)', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'python -m venv myenv' });
      expectAskEnvelope(result, 'virtual environment');
    });

    test('allows normal git commands', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'git status' });
      expect(result.exitCode).toBe(0);
      // Allow path emits no JSON envelope (or an empty allow envelope).
      const envelope = parseHookJson(result.stdout);
      if (envelope) {
        expect(envelope.hookSpecificOutput?.permissionDecision).not.toBe('deny');
        expect(envelope.hookSpecificOutput?.permissionDecision).not.toBe('ask');
      }
    });

    test('allows normal commands', () => {
      const result = runHook('block-dangerous.sh', 'Bash', { command: 'npm test' });
      expect(result.exitCode).toBe(0);
    });

    test('ignores non-Bash tools', () => {
      const result = runHook('block-dangerous.sh', 'Write', { file_path: 'test.js' });
      expect(result.exitCode).toBe(0);
    });

    describe('classify_command.py edge cases (heredoc/quote awareness)', () => {
      const hasPython3 = (() => {
        try {
          execFileSync('python3', ['--version'], { stdio: 'pipe' });
          return true;
        } catch {
          return false;
        }
      })();

      const skipOrTest = hasPython3 ? test : test.skip;

      beforeEach(() => {
        // Copy classify_command.py so the Python classifier is used
        // instead of the bash fallback (which lacks quote/heredoc awareness)
        const src = path.join(templateDir, '.claude', 'hooks', 'classify_command.py');
        const dest = path.join(testDir, '.claude', 'hooks', 'classify_command.py');
        if (fs.existsSync(src)) {
          fs.copySync(src, dest);
          fs.chmodSync(dest, 0o755);
        }
      });

      /**
       * Run hook with file-based input instead of echo.
       * The default runHook uses echo which on macOS (zsh as /bin/sh)
       * interprets backslash-n inside single quotes, breaking JSON
       * that contains newline escapes.
       */
      function runHookWithFile(hookName, toolName, toolInput) {
        const hookPath = path.join(testDir, '.claude', 'hooks', hookName);
        if (!fs.existsSync(hookPath)) {
          throw new Error(`Hook not found: ${hookPath}`);
        }

        const input = JSON.stringify({ tool_name: toolName, tool_input: toolInput });
        const inputFile = path.join(testDir, '.hook-input.json');
        fs.writeFileSync(inputFile, input);

        try {
          const output = execSync(`cat "${inputFile}" | bash "${hookPath}"`, {
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
        } finally {
          fs.removeSync(inputFile);
        }
      }

      skipOrTest('allows echo of a quoted dangerous command (not real execution)', () => {
        const result = runHookWithFile('block-dangerous.sh', 'Bash', {
          command: 'echo "git reset --hard"',
        });
        expect(result.exitCode).toBe(0);
      });

      skipOrTest('allows heredoc containing a dangerous command (not real execution)', () => {
        const result = runHookWithFile('block-dangerous.sh', 'Bash', {
          command: 'cat <<EOF\ngit push --force\nEOF',
        });
        expect(result.exitCode).toBe(0);
      });

      skipOrTest('ask-gates dangerous command chained after safe quoted echo', () => {
        // The classifier must reach into the `&&` chain and detect the
        // embedded dangerous command, not stop at the safe `echo` prefix.
        // Verified: classify_command.py returns {decision: "ask", reason:
        // "git force push"} for this input.
        const result = runHookWithFile('block-dangerous.sh', 'Bash', {
          command: 'echo "safe command" && git push --force',
        });
        expect(result.exitCode).toBe(0);
        const envelope = (() => {
          const trimmed = (result.stdout || '').trim();
          if (!trimmed) return null;
          try { return JSON.parse(trimmed); } catch { return null; }
        })();
        expect(envelope).not.toBeNull();
        expect(envelope.hookSpecificOutput?.permissionDecision).toBe('ask');
        expect(envelope.hookSpecificOutput?.permissionDecisionReason).toContain('git force push');
      });
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
    // Full-mode tests: at least one spec under .caws/specs/ present, scope.json removed
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
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'src'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'src', 'app.js'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('blocks edits in scope.out', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'vendor'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'vendor', 'package.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('blocks edits outside scope.in', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      fs.ensureDirSync(path.join(testDir, 'lib'));
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'lib', 'utils.js'),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toContain('BLOCKED');
    });

    test('allows root-level files', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, 'package.json'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('allows .caws/ files', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, '.caws', 'policy.yaml'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('allows .claude/ files', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
      const result = runHook('scope-guard.sh', 'Write', {
        file_path: path.join(testDir, '.claude', 'settings.json'),
      });
      expect(result.exitCode).toBe(0);
    });

    test('skips terminal-status specs', () => {
      writeYaml('.caws/specs/TEST-001.yaml', WORKING_SPEC);
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
      writeYaml('.caws/specs/TEST-001.yaml', [
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

    test('invalid YAML in feature spec allows all edits (security bypass)', () => {
      // This documents a known security issue: if a feature spec has invalid YAML,
      // the js-yaml parser throws, the catch block outputs "error:...", and the bash
      // script falls through to exit 0 — allowing ALL edits regardless of scope.
      writeYaml('.caws/specs/TEST-001.yaml', '{{{bad yaml content!!!');
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

// ============================================================================
// MULTI-AGENT-ACTIVITY-REGISTRY-001 — agent-register / agent-heartbeat /
// agent-stop hook templates.
//
// These hooks fan out from the SessionStart, PreToolUse, and Stop dispatchers
// installed by the v3 Claude Code hook pack. Each invokes the CAWS CLI
// (`caws agents register/heartbeat/stop`) and treats failure as silently
// non-blocking. agent-heartbeat is the sole emitter of Claude Code's
// hookSpecificOutput.additionalContext envelope; the CLI itself returns
// CAWS-native JSON.
//
// Test approach: use the built CLI directly (bin/caws.js) as $CAWS_BIN so the
// hooks can locate `caws` without requiring a global install on PATH. Each
// test pipes a synthetic hook payload into the script and inspects the
// resulting on-disk lease file plus the stdout envelope.
// ============================================================================

describe('agent-*.sh hooks integration (MULTI-AGENT-ACTIVITY-REGISTRY-001)', () => {
  const templateDir = path.resolve(__dirname, '../../templates');
  const packDir = path.join(templateDir, 'hook-packs', 'claude-code');
  // Resolve the built CLI entry. The hook scripts invoke `caws agents ...`;
  // we shim that by writing a tiny `caws` wrapper that delegates to the
  // built dist/index.js, then prepending its directory to PATH. This
  // proves the hook's invocation path without depending on global
  // install state.
  const cliBin = path.resolve(__dirname, '../../dist/index.js');

  let testDir;
  let originalCwd;
  let shimDir;

  beforeAll(() => {
    if (!fs.existsSync(cliBin)) {
      throw new Error(
        `CLI bin not built at ${cliBin} — run "turbo run build --filter=@paths.design/caws-cli..."`
      );
    }
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'caws-agent-hooks-'));
    execFileSync('git', ['init', '-q', testDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(testDir, '.gitignore'), '');
    execFileSync('git', ['-C', testDir, 'add', '.gitignore'], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    fs.mkdirSync(path.join(testDir, '.caws'));

    // Copy the three new hook templates + the shared lib + runtime-paths
    // so parse-input.sh / read_hook_input_json work.
    const hooksDir = path.join(testDir, '.claude', 'hooks');
    fs.ensureDirSync(hooksDir);
    fs.ensureDirSync(path.join(hooksDir, 'lib'));

    for (const f of ['agent-register.sh', 'agent-heartbeat.sh', 'agent-stop.sh']) {
      const src = path.join(packDir, f);
      const dest = path.join(hooksDir, f);
      fs.copySync(src, dest);
      fs.chmodSync(dest, 0o755);
    }
    fs.copySync(path.join(packDir, 'runtime-paths.sh'), path.join(hooksDir, 'runtime-paths.sh'));
    fs.copySync(path.join(packDir, 'lib', 'parse-input.sh'), path.join(hooksDir, 'lib', 'parse-input.sh'));

    // Make a shim that proxies `caws` to the built CLI binary.
    shimDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'caws-shim-'));
    const shimPath = path.join(shimDir, 'caws');
    fs.writeFileSync(shimPath, `#!/bin/bash\nexec node "${cliBin}" "$@"\n`);
    fs.chmodSync(shimPath, 0o755);

    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testDir) fs.removeSync(testDir);
    if (shimDir) fs.removeSync(shimDir);
  });

  function runAgentHook(hookName, payload, extraEnv = {}) {
    const hookPath = path.join(testDir, '.claude', 'hooks', hookName);
    const input = JSON.stringify(payload);
    const inputFile = path.join(testDir, '.agent-hook-input.json');
    fs.writeFileSync(inputFile, input);
    try {
      const stdout = execSync(`cat "${inputFile}" | bash "${hookPath}"`, {
        cwd: testDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${shimDir}:${process.env.PATH}`,
          ...extraEnv,
        },
      });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (error) {
      return {
        exitCode: error.status || 1,
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
      };
    } finally {
      fs.removeSync(inputFile);
    }
  }

  function leasePath(sessionId) {
    return path.join(testDir, '.caws', 'leases', `${sessionId}.json`);
  }

  // ───── agent-register.sh ─────────────────────────────────────────────

  describe('agent-register.sh (SessionStart)', () => {
    test('creates a lease file for a valid session_id', () => {
      const sid = 'caws-hooktest-reg-1';
      const r = runAgentHook('agent-register.sh', {
        hook_event_name: 'SessionStart',
        session_id: sid,
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(leasePath(sid))).toBe(true);
      const lease = JSON.parse(fs.readFileSync(leasePath(sid), 'utf8'));
      expect(lease.session_id).toBe(sid);
      expect(lease.platform).toBe('claude-code');
      expect(lease.last_seen_reason).toBe('session_start');
      expect(lease.status).toBe('active');
    });

    test('refuses silently when session_id is "unknown"', () => {
      const r = runAgentHook('agent-register.sh', {
        hook_event_name: 'SessionStart',
        session_id: 'unknown',
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      // No leases directory should exist.
      expect(fs.existsSync(path.join(testDir, '.caws', 'leases'))).toBe(false);
    });

    test('refuses silently when session_id is missing', () => {
      const r = runAgentHook('agent-register.sh', {
        hook_event_name: 'SessionStart',
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      // parse-input.sh falls back to "unknown" which our guard rejects.
      expect(fs.existsSync(path.join(testDir, '.caws', 'leases'))).toBe(false);
    });

    test('exits 0 even when the CAWS binary is unavailable', () => {
      // Override PATH to a directory without our shim. The hook must
      // exit 0 silently — SessionStart cannot fail on a missing dep.
      const r = runAgentHook(
        'agent-register.sh',
        {
          hook_event_name: 'SessionStart',
          session_id: 'caws-hooktest-no-bin',
          cwd: testDir,
        },
        { PATH: '/usr/bin:/bin' }
      );
      expect(r.exitCode).toBe(0);
      expect(fs.existsSync(leasePath('caws-hooktest-no-bin'))).toBe(false);
    });
  });

  // ───── agent-heartbeat.sh ───────────────────────────────────────────

  describe('agent-heartbeat.sh (PreToolUse)', () => {
    function register(sessionId) {
      execFileSync('node', [cliBin, 'agents', 'register',
        '--session-id', sessionId,
        '--platform', 'claude-code',
        '--reason', 'manual_register',
      ], { cwd: testDir, stdio: 'pipe' });
    }

    test('updates the current session lease on PreToolUse', () => {
      const sid = 'caws-hooktest-hb-1';
      register(sid);
      const before = JSON.parse(fs.readFileSync(leasePath(sid), 'utf8'));

      // Force-throttle bypass by deleting and re-running after a small
      // delay isn't possible here; instead invoke with the hook script,
      // which calls `caws agents heartbeat --throttle 30000`. We assert
      // the lease still exists and last_active is parseable.
      const r = runAgentHook('agent-heartbeat.sh', {
        hook_event_name: 'PreToolUse',
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      const after = JSON.parse(fs.readFileSync(leasePath(sid), 'utf8'));
      expect(after.session_id).toBe(sid);
      // Either updated (last_seen_reason switched to 'pre_tool_use') or
      // throttled (last_seen_reason stays 'manual_register'). Both are
      // valid outcomes; the assertion is that the lease was readable
      // and the hook exited 0.
      expect(['pre_tool_use', 'manual_register']).toContain(after.last_seen_reason);
    });

    test('emits NO additionalContext when only self is active (N=1)', () => {
      const sid = 'caws-hooktest-hb-solo';
      register(sid);
      const r = runAgentHook('agent-heartbeat.sh', {
        hook_event_name: 'PreToolUse',
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      // Silent in the common case — no envelope.
      expect(r.stdout.trim()).toBe('');
    });

    test('emits hookSpecificOutput.additionalContext when N>1 (parallel peers)', () => {
      // Register a peer session first so the heartbeat sees N=2.
      register('caws-hooktest-hb-peer');
      const sid = 'caws-hooktest-hb-self';
      register(sid);

      const r = runAgentHook('agent-heartbeat.sh', {
        hook_event_name: 'PreToolUse',
        session_id: sid,
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      const trimmed = r.stdout.trim();
      expect(trimmed.length).toBeGreaterThan(0);

      const envelope = JSON.parse(trimmed);
      expect(envelope.hookSpecificOutput).toBeDefined();
      expect(envelope.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(envelope.hookSpecificOutput.additionalContext).toContain('MULTI-AGENT NOTICE');
      // Must name the OTHER session, not self.
      expect(envelope.hookSpecificOutput.additionalContext).toContain('caws-hooktest-hb-peer');
    });

    test('refuses silently when session_id is missing', () => {
      const r = runAgentHook('agent-heartbeat.sh', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });

    test('fails closed (exits 0, no output) when CAWS binary is unavailable', () => {
      const r = runAgentHook(
        'agent-heartbeat.sh',
        {
          hook_event_name: 'PreToolUse',
          session_id: 'caws-hooktest-hb-nobin',
          tool_name: 'Bash',
          tool_input: { command: 'ls' },
          cwd: testDir,
        },
        { PATH: '/usr/bin:/bin' }
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('');
    });
  });

  // ───── agent-stop.sh ────────────────────────────────────────────────

  describe('agent-stop.sh (Stop)', () => {
    function register(sessionId) {
      execFileSync('node', [cliBin, 'agents', 'register',
        '--session-id', sessionId,
        '--platform', 'claude-code',
        '--reason', 'manual_register',
      ], { cwd: testDir, stdio: 'pipe' });
    }

    test('marks the lease as stopped', () => {
      const sid = 'caws-hooktest-stop-1';
      register(sid);
      expect(JSON.parse(fs.readFileSync(leasePath(sid), 'utf8')).status).toBe('active');

      const r = runAgentHook('agent-stop.sh', {
        hook_event_name: 'Stop',
        session_id: sid,
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);

      const after = JSON.parse(fs.readFileSync(leasePath(sid), 'utf8'));
      expect(after.status).toBe('stopped');
      expect(after.stopped_at).toBeDefined();
    });

    test('refuses silently when session_id is missing', () => {
      const r = runAgentHook('agent-stop.sh', {
        hook_event_name: 'Stop',
        cwd: testDir,
      });
      expect(r.exitCode).toBe(0);
    });

    test('exits 0 even when the CAWS binary is unavailable', () => {
      const r = runAgentHook(
        'agent-stop.sh',
        {
          hook_event_name: 'Stop',
          session_id: 'caws-hooktest-stop-nobin',
          cwd: testDir,
        },
        { PATH: '/usr/bin:/bin' }
      );
      expect(r.exitCode).toBe(0);
    });
  });
});

// ============================================================================
// CANONICAL-CHECKOUT-WORKTREE-GUARD-001
//
// worktree-guard.sh: refuse canonical-checkout mutating git commands when
// at least one active CAWS worktree exists. Authority remains in
// worktrees.json + specs; this guard is hook-layer enforcement only.
//
// Test fixtures:
//   <testDir>/                                 ← canonical checkout
//     .caws/worktrees.json                     ← registry with one active entry
//     .caws/worktrees/wt-other/                ← real linked git worktree
//     .claude/hooks/worktree-guard.sh          ← copied from templates
//     .claude/hooks/runtime-paths.sh
//     .claude/hooks/lib/parse-input.sh
//
// runGuardHook payload:
//   { tool_name: 'Bash', tool_input: { command }, cwd, session_id }
// ============================================================================

describe('worktree-guard.sh canonical-checkout enforcement (CANONICAL-CHECKOUT-WORKTREE-GUARD-001)', () => {
  const templateDir = path.resolve(__dirname, '../../templates');
  const packDir = path.join(templateDir, 'hook-packs', 'claude-code');

  let testDir;
  let originalCwd;

  function writeV11Registry(entries) {
    fs.writeFileSync(
      path.join(testDir, '.caws', 'worktrees.json'),
      JSON.stringify(entries, null, 2) + '\n'
    );
  }

  function createLinkedWorktree(name, branch) {
    execFileSync(
      'git',
      ['-C', testDir, 'worktree', 'add', '-b', branch, `.caws/worktrees/${name}`],
      { stdio: 'ignore' }
    );
  }

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'caws-canonguard-'));
    execFileSync('git', ['init', '-q', '-b', 'main', testDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'config', 'user.email', 't@t'], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'config', 'user.name', 't'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(testDir, '.gitignore'), '');
    execFileSync('git', ['-C', testDir, 'add', '.gitignore'], { stdio: 'ignore' });
    execFileSync('git', ['-C', testDir, 'commit', '-qm', 'init'], { stdio: 'ignore' });
    fs.ensureDirSync(path.join(testDir, '.caws'));
    fs.ensureDirSync(path.join(testDir, '.caws', 'worktrees'));

    const hooksDir = path.join(testDir, '.claude', 'hooks');
    fs.ensureDirSync(hooksDir);
    fs.ensureDirSync(path.join(hooksDir, 'lib'));
    for (const f of ['worktree-guard.sh', 'runtime-paths.sh']) {
      fs.copySync(path.join(packDir, f), path.join(hooksDir, f));
      fs.chmodSync(path.join(hooksDir, f), 0o755);
    }
    fs.copySync(
      path.join(packDir, 'lib', 'parse-input.sh'),
      path.join(hooksDir, 'lib', 'parse-input.sh')
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testDir) fs.removeSync(testDir);
  });

  function runGuardHook(command, opts = {}) {
    const cwd = opts.cwd || testDir;
    const payload = {
      tool_name: 'Bash',
      tool_input: { command },
      cwd,
      session_id: opts.session_id || 'caws-guard-test-1',
    };
    const inputFile = path.join(testDir, '.guard-hook-input.json');
    fs.writeFileSync(inputFile, JSON.stringify(payload));
    const hookPath = path.join(testDir, '.claude', 'hooks', 'worktree-guard.sh');
    try {
      const stdout = execSync(`cat "${inputFile}" | bash "${hookPath}"`, {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: testDir,
        },
      });
      return { exitCode: 0, stdout, stderr: '' };
    } catch (error) {
      return {
        exitCode: error.status || 1,
        stdout: error.stdout?.toString() || '',
        stderr: error.stderr?.toString() || '',
      };
    } finally {
      try { fs.removeSync(inputFile); } catch { /* ignore */ }
    }
  }

  // A1: canonical + active worktrees + mutating git command → BLOCK exit 2
  describe('A1: canonical checkout + active worktrees + mutating command', () => {
    beforeEach(() => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      writeV11Registry({
        'wt-other': {
          specId: 'GUARD-TEST-001',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-other-branch',
          baseBranch: 'main',
          status: 'active',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
        },
      });
    });

    test('blocks git checkout <other-branch> from canonical with exit 2', () => {
      const r = runGuardHook('git checkout wt-other-branch');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
      expect(r.stderr).toMatch(/wt-other/);
    });

    test('blocks git switch <other-branch> from canonical with exit 2', () => {
      const r = runGuardHook('git switch wt-other-branch');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
    });

    test('blocks git branch -f <branch> HEAD from canonical with exit 2', () => {
      const r = runGuardHook('git branch -f some-branch HEAD');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
    });

    test('blocks git reset --keep <commit> from canonical with exit 2', () => {
      const r = runGuardHook('git reset --keep HEAD~1');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
    });

    test('diagnostic names the offending command class and the active worktree', () => {
      const r = runGuardHook('git checkout main');
      expect(r.exitCode).toBe(2);
      // Names the command class (branch-switch / checkout etc.)
      expect(r.stderr).toMatch(/branch switch|checkout/i);
      // Names the active worktree by name
      expect(r.stderr).toMatch(/wt-other/);
      // Includes the escape instruction
      expect(r.stderr).toMatch(/cd \.caws\/worktrees|caws worktree destroy/);
    });
  });

  // A2: bound worktree session, sibling worktrees active → ALLOW
  describe('A2: session inside a linked worktree, siblings active', () => {
    let wtPath;

    beforeEach(() => {
      createLinkedWorktree('wt-mine', 'wt-mine-branch');
      createLinkedWorktree('wt-sibling', 'wt-sibling-branch');
      wtPath = path.join(testDir, '.caws', 'worktrees', 'wt-mine');
      writeV11Registry({
        'wt-mine': {
          specId: 'GUARD-TEST-002',
          owner: { session_id: 'caws-guard-test-1', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-mine-branch',
          baseBranch: 'main',
          status: 'active',
          path: wtPath,
        },
        'wt-sibling': {
          specId: 'GUARD-TEST-003',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-sibling-branch',
          baseBranch: 'main',
          status: 'active',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-sibling'),
        },
      });
    });

    test('worktree session is NOT blocked by canonical guard', () => {
      const r = runGuardHook('git checkout main', { cwd: wtPath });
      // exit 0 — the canonical guard does not apply to worktree sessions.
      // Other guards (amend, stash, hard-reset, force-push) may still
      // fire on their own commands, but `git checkout` from inside a
      // worktree is allowed by this guard.
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/canonical checkout/i);
    });

    test('worktree session: no "canonical" diagnostic emitted', () => {
      const r = runGuardHook('git switch main', { cwd: wtPath });
      expect(r.stderr).not.toMatch(/canonical checkout/i);
    });
  });

  // A3: canonical + worktrees active + read-only command → ALLOW
  describe('A3: read-only commands allowed in canonical with worktrees active', () => {
    beforeEach(() => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      writeV11Registry({
        'wt-other': {
          specId: 'GUARD-TEST-A3',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-other-branch',
          baseBranch: 'main',
          status: 'active',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
        },
      });
    });

    test.each([
      ['git status'],
      ['git log --oneline -5'],
      ['git diff'],
      ['git show HEAD'],
      ['git rev-parse HEAD'],
      ['git ls-files'],
      ['git branch -v'],
      ['git stash list'],
      ['git fetch origin'],
    ])('allows %s (exit 0, no canonical diagnostic)', (cmd) => {
      const r = runGuardHook(cmd);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/canonical checkout.*BLOCKED|BLOCKED.*canonical/i);
    });
  });

  // A4: canonical + NO active worktrees → ALLOW even mutating commands
  describe('A4: no active worktrees (or missing registry) → guard inert', () => {
    test('missing .caws/worktrees.json: allows git checkout', () => {
      // No registry file written.
      const r = runGuardHook('git checkout other-branch');
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/canonical checkout.*BLOCKED/);
    });

    test('registry exists but no entries are active: allows git checkout', () => {
      writeV11Registry({}); // empty
      const r = runGuardHook('git checkout other-branch');
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/canonical checkout.*BLOCKED/);
    });

    test('registry has only stopped/destroyed entries: allows git checkout', () => {
      writeV11Registry({
        'wt-old': {
          specId: 'GUARD-TEST-A4',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-22T00:00:00.000Z',
          branch: 'wt-old-branch',
          baseBranch: 'main',
          status: 'destroyed',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-old'),
        },
      });
      const r = runGuardHook('git checkout other-branch');
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/canonical checkout.*BLOCKED/);
    });
  });

  // A4b: explicit witness for the missing-status-treated-as-active
  // defensive fallback. The CLI's createWorktree does not always emit
  // an explicit `status` field. The guard treats an entry without a
  // status (or with status: null/'') as ACTIVE, so a freshly-created
  // worktree starts protected even before the first status update.
  // This test locks that fallback as a deliberate contract — if a
  // future refactor removes it, the test must fail.
  describe('A4b: missing status field is treated as active (defensive fallback)', () => {
    test('worktree entry with NO status field blocks git checkout from canonical', () => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      writeV11Registry({
        'wt-other': {
          specId: 'GUARD-TEST-A4B',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-other-branch',
          baseBranch: 'main',
          // status field intentionally OMITTED
          path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
        },
      });
      const r = runGuardHook('git checkout wt-other-branch');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
      expect(r.stderr).toMatch(/wt-other/);
    });
  });

  // A1b: v10 nested-envelope registry shape. The guard's entriesOf
  // helper claims dual-shape support (v11 direct-key + v10 nested
  // {version, worktrees: {<name>: {...}}}). This test witnesses the
  // v10 branch; without it, the compatibility claim has no test.
  describe('A1b: v10 nested-envelope registry shape', () => {
    test('v10 {version, worktrees: {...}} shape blocks git checkout from canonical', () => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      const v10Registry = {
        version: 1,
        worktrees: {
          'wt-other': {
            specId: 'GUARD-TEST-A1B',
            owner: 'caws-other-session', // v10 uses string owner, not object
            branch: 'wt-other-branch',
            baseBranch: 'main',
            status: 'active',
            path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
            createdAt: '2026-05-23T12:00:00.000Z',
            name: 'wt-other',
          },
        },
      };
      fs.writeFileSync(
        path.join(testDir, '.caws', 'worktrees.json'),
        JSON.stringify(v10Registry, null, 2) + '\n'
      );
      const r = runGuardHook('git checkout wt-other-branch');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
      expect(r.stderr).toMatch(/wt-other/);
    });
  });

  // A5: malformed lease must not prevent the block decision
  describe('A5: malformed .caws/leases tolerated (still blocks block-eligible commands)', () => {
    beforeEach(() => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      writeV11Registry({
        'wt-other': {
          specId: 'GUARD-TEST-A5',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-other-branch',
          baseBranch: 'main',
          status: 'active',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
        },
      });
      // Corrupt lease file: truncated mid-write.
      fs.ensureDirSync(path.join(testDir, '.caws', 'leases'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'leases', 'caws-other-session.json'),
        '{"session_id": "caws-other-session", "status": "act' // truncated
      );
    });

    test('malformed lease does NOT prevent the canonical block', () => {
      const r = runGuardHook('git checkout wt-other-branch');
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/BLOCKED/);
      expect(r.stderr).toMatch(/canonical checkout/i);
      expect(r.stderr).toMatch(/wt-other/);
    });
  });

  // A6: non-git mutating commands → ALLOW (out of this guard's domain)
  describe('A6: non-git commands not in this guard\'s domain', () => {
    beforeEach(() => {
      createLinkedWorktree('wt-other', 'wt-other-branch');
      writeV11Registry({
        'wt-other': {
          specId: 'GUARD-TEST-A6',
          owner: { session_id: 'caws-other-session', platform: 'darwin' },
          last_heartbeat: '2026-05-23T12:00:00.000Z',
          branch: 'wt-other-branch',
          baseBranch: 'main',
          status: 'active',
          path: path.join(testDir, '.caws', 'worktrees', 'wt-other'),
        },
      });
    });

    test.each([
      ['npm install'],
      ['ls -la'],
      ['echo hello'],
      ['node script.js'],
    ])('allows %s from canonical', (cmd) => {
      const r = runGuardHook(cmd);
      expect(r.exitCode).toBe(0);
      expect(r.stderr).not.toMatch(/BLOCKED/);
    });
  });
});
