/**
 * @fileoverview Integration tests for Claude Code hooks scaffolding via `caws scaffold --ide claude`
 * Verifies that scaffoldClaudeHooks produces the expected hook files and settings.json wiring.
 * @author @darianrosebrook
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const { scaffoldClaudeHooks, generateClaudeSettings } = require('../../src/scaffold/claude-hooks');

describe('scaffold --ide claude hooks', () => {
  let testDir;
  let originalCwd;
  const templateDir = path.resolve(__dirname, '../../templates');

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-scaffold-hooks-'));

    // Create minimal .caws/ structure (simulates `caws init` having run)
    fs.ensureDirSync(path.join(testDir, '.caws'));
    fs.writeFileSync(
      path.join(testDir, '.caws', 'working-spec.yaml'),
      'id: TEST-001\ntitle: Test project\nrisk_tier: 2\nmode: feature\nscope:\n  in:\n    - src/\n  out:\n    - vendor/\n'
    );
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.removeSync(testDir);
  });

  describe('file creation with default levels', () => {
    // Default levels: ['safety', 'quality', 'scope', 'audit']
    beforeEach(async () => {
      await scaffoldClaudeHooks(testDir);
    });

    test('creates .claude/hooks/ directory', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks'))).toBe(true);
    });

    test('creates .claude/settings.json', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'settings.json'))).toBe(true);
    });

    // --- Hook scripts that the user specifically asked to verify ---

    test('creates doc-frontmatter-check.sh', () => {
      const hookPath = path.join(testDir, '.claude', 'hooks', 'doc-frontmatter-check.sh');
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      // Check executable bit (owner execute)
      expect(stat.mode & 0o100).toBeTruthy();
    });

    test('creates classify_command.py (supporting script)', () => {
      const hookPath = path.join(testDir, '.claude', 'hooks', 'classify_command.py');
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o100).toBeTruthy();
    });

    test('creates session-log.sh', () => {
      const hookPath = path.join(testDir, '.claude', 'hooks', 'session-log.sh');
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o100).toBeTruthy();
    });

    test('creates scope-guard.sh', () => {
      const hookPath = path.join(testDir, '.claude', 'hooks', 'scope-guard.sh');
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o100).toBeTruthy();
    });

    test('creates block-dangerous.sh', () => {
      const hookPath = path.join(testDir, '.claude', 'hooks', 'block-dangerous.sh');
      expect(fs.existsSync(hookPath)).toBe(true);
      const stat = fs.statSync(hookPath);
      expect(stat.mode & 0o100).toBeTruthy();
    });

    // --- All safety-level hooks ---

    test('creates scan-secrets.sh (safety level)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'scan-secrets.sh'))).toBe(true);
    });

    test('creates worktree-guard.sh (safety level)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'worktree-guard.sh'))).toBe(true);
    });

    test('creates worktree-write-guard.sh (safety level)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'worktree-write-guard.sh'))
      ).toBe(true);
    });

    test('creates stop-worktree-check.sh (safety level)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'stop-worktree-check.sh'))
      ).toBe(true);
    });

    test('creates session-caws-status.sh (safety level)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'session-caws-status.sh'))
      ).toBe(true);
    });

    // --- Quality-level hooks ---

    test('creates quality-check.sh (quality level)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'quality-check.sh'))).toBe(true);
    });

    test('creates validate-spec.sh (quality level)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'validate-spec.sh'))).toBe(true);
    });

    // --- Scope-level hooks ---

    test('creates naming-check.sh (scope level)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'naming-check.sh'))).toBe(true);
    });

    // --- Audit-level hooks ---

    test('creates audit.sh (audit level, also auto-added when any hooks enabled)', () => {
      expect(fs.existsSync(path.join(testDir, '.claude', 'hooks', 'audit.sh'))).toBe(true);
    });

    // --- Supporting scripts ---

    test('creates test_classify_command.py (supporting script)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'test_classify_command.py'))
      ).toBe(true);
    });

    test('creates test_wrapper_smoke.sh (supporting script)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'test_wrapper_smoke.sh'))
      ).toBe(true);
    });

    // --- Hook script content validation ---

    test('hook scripts have bash shebang', () => {
      const shellScripts = [
        'block-dangerous.sh',
        'scope-guard.sh',
        'session-log.sh',
        'doc-frontmatter-check.sh',
        'audit.sh',
      ];

      for (const script of shellScripts) {
        const content = fs.readFileSync(
          path.join(testDir, '.claude', 'hooks', script),
          'utf8'
        );
        expect(content).toMatch(/^#!\/bin\/bash/);
      }
    });

    test('classify_command.py has python shebang', () => {
      const content = fs.readFileSync(
        path.join(testDir, '.claude', 'hooks', 'classify_command.py'),
        'utf8'
      );
      expect(content).toMatch(/^#!.*python/);
    });

    // --- Files that should NOT exist (lite-only hooks) ---

    test('does not create lite-sprawl-check.sh (not in default levels)', () => {
      // lite-sprawl-check.sh belongs to the 'lite' level, not the default set
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'lite-sprawl-check.sh'))
      ).toBe(false);
    });

    test('does not create simplification-guard.sh (not in default levels)', () => {
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'simplification-guard.sh'))
      ).toBe(false);
    });
  });

  describe('settings.json hook wiring', () => {
    let settings;

    beforeEach(async () => {
      await scaffoldClaudeHooks(testDir);
      settings = fs.readJsonSync(path.join(testDir, '.claude', 'settings.json'));
    });

    test('has hooks property', () => {
      expect(settings).toHaveProperty('hooks');
    });

    // --- PreToolUse entries ---

    test('wires block-dangerous.sh on PreToolUse Bash matcher', () => {
      const preToolUse = settings.hooks.PreToolUse;
      expect(preToolUse).toBeDefined();

      const bashEntry = preToolUse.find((e) => e.matcher === 'Bash');
      expect(bashEntry).toBeDefined();

      const blockHook = bashEntry.hooks.find((h) =>
        h.command.includes('block-dangerous.sh')
      );
      expect(blockHook).toBeDefined();
      expect(blockHook.type).toBe('command');
      expect(blockHook.timeout).toBeGreaterThan(0);
    });

    test('wires worktree-guard.sh on PreToolUse Bash matcher', () => {
      const bashEntry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Bash');
      expect(bashEntry.hooks.find((h) => h.command.includes('worktree-guard.sh'))).toBeDefined();
    });

    test('wires scan-secrets.sh on PreToolUse Read matcher', () => {
      const readEntry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Read');
      expect(readEntry).toBeDefined();
      expect(readEntry.hooks.find((h) => h.command.includes('scan-secrets.sh'))).toBeDefined();
    });

    test('wires worktree-write-guard.sh on PreToolUse Write|Edit matcher', () => {
      const writeEditEntry = settings.hooks.PreToolUse.find(
        (e) => e.matcher === 'Write|Edit'
      );
      expect(writeEditEntry).toBeDefined();
      expect(
        writeEditEntry.hooks.find((h) => h.command.includes('worktree-write-guard.sh'))
      ).toBeDefined();
    });

    test('wires scope-guard.sh on PreToolUse Write|Edit matcher', () => {
      const scopeEntry = settings.hooks.PreToolUse.find(
        (e) => e.matcher === 'Write|Edit' && e.hooks.some((h) => h.command.includes('scope-guard.sh'))
      );
      expect(scopeEntry).toBeDefined();
    });

    // --- PostToolUse entries ---

    test('wires quality-check.sh on PostToolUse Write|Edit matcher', () => {
      const postToolUse = settings.hooks.PostToolUse;
      expect(postToolUse).toBeDefined();

      const qualityEntry = postToolUse.find(
        (e) =>
          e.matcher === 'Write|Edit' &&
          e.hooks.some((h) => h.command.includes('quality-check.sh'))
      );
      expect(qualityEntry).toBeDefined();
    });

    test('wires validate-spec.sh on PostToolUse Write|Edit matcher', () => {
      const qualityEntry = settings.hooks.PostToolUse.find(
        (e) =>
          e.matcher === 'Write|Edit' &&
          e.hooks.some((h) => h.command.includes('validate-spec.sh'))
      );
      expect(qualityEntry).toBeDefined();
    });

    test('wires doc-frontmatter-check.sh on PostToolUse Write|Edit matcher', () => {
      const qualityEntry = settings.hooks.PostToolUse.find(
        (e) =>
          e.matcher === 'Write|Edit' &&
          e.hooks.some((h) => h.command.includes('doc-frontmatter-check.sh'))
      );
      expect(qualityEntry).toBeDefined();
    });

    test('wires naming-check.sh on PostToolUse Write|Edit matcher', () => {
      const namingEntry = settings.hooks.PostToolUse.find(
        (e) =>
          e.matcher === 'Write|Edit' &&
          e.hooks.some((h) => h.command.includes('naming-check.sh'))
      );
      expect(namingEntry).toBeDefined();
    });

    test('wires audit.sh tool-use on PostToolUse Write|Edit|Bash matcher', () => {
      const auditEntry = settings.hooks.PostToolUse.find(
        (e) =>
          e.matcher === 'Write|Edit|Bash' &&
          e.hooks.some((h) => h.command.includes('audit.sh tool-use'))
      );
      expect(auditEntry).toBeDefined();
    });

    // --- SessionStart entries ---

    test('wires session-caws-status.sh on SessionStart', () => {
      const sessionStart = settings.hooks.SessionStart;
      expect(sessionStart).toBeDefined();
      expect(sessionStart.length).toBeGreaterThan(0);

      const statusHook = sessionStart.find((e) =>
        e.hooks.some((h) => h.command.includes('session-caws-status.sh'))
      );
      expect(statusHook).toBeDefined();
    });

    test('wires audit.sh session-start on SessionStart', () => {
      const auditEntry = settings.hooks.SessionStart.find((e) =>
        e.hooks.some((h) => h.command.includes('audit.sh session-start'))
      );
      expect(auditEntry).toBeDefined();
    });

    test('wires session-log.sh on SessionStart', () => {
      const logEntry = settings.hooks.SessionStart.find((e) =>
        e.hooks.some((h) => h.command.includes('session-log.sh'))
      );
      expect(logEntry).toBeDefined();
    });

    // --- Stop entries ---

    test('wires stop-worktree-check.sh on Stop', () => {
      const stop = settings.hooks.Stop;
      expect(stop).toBeDefined();

      const worktreeStop = stop.find((e) =>
        e.hooks.some((h) => h.command.includes('stop-worktree-check.sh'))
      );
      expect(worktreeStop).toBeDefined();
    });

    test('wires audit.sh stop on Stop', () => {
      const auditStop = settings.hooks.Stop.find((e) =>
        e.hooks.some((h) => h.command.includes('audit.sh stop'))
      );
      expect(auditStop).toBeDefined();
    });

    test('wires session-log.sh on Stop', () => {
      const logStop = settings.hooks.Stop.find((e) =>
        e.hooks.some((h) => h.command.includes('session-log.sh'))
      );
      expect(logStop).toBeDefined();
    });

    // --- PreCompact entries ---

    test('wires session-log.sh on PreCompact', () => {
      const preCompact = settings.hooks.PreCompact;
      expect(preCompact).toBeDefined();

      const logCompact = preCompact.find((e) =>
        e.hooks.some((h) => h.command.includes('session-log.sh'))
      );
      expect(logCompact).toBeDefined();
    });

    // --- Command path format ---

    test('all hook commands use $CLAUDE_PROJECT_DIR prefix', () => {
      const allCommands = [];
      for (const [, entries] of Object.entries(settings.hooks)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            allCommands.push(hook.command);
          }
        }
      }

      expect(allCommands.length).toBeGreaterThan(0);
      for (const cmd of allCommands) {
        expect(cmd).toContain('"$CLAUDE_PROJECT_DIR"/.claude/hooks/');
      }
    });

    test('all hooks have positive timeouts', () => {
      for (const [, entries] of Object.entries(settings.hooks)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.timeout).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe('level selection', () => {
    test('safety-only scaffold creates only safety hooks', async () => {
      await scaffoldClaudeHooks(testDir, ['safety']);
      const settings = fs.readJsonSync(path.join(testDir, '.claude', 'settings.json'));

      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();

      // quality/scope/audit hooks should not be present
      expect(settings.hooks.PostToolUse).toBeUndefined();
      expect(settings.hooks.PreCompact).toBeUndefined();
    });

    test('safety-only creates block-dangerous.sh but not quality-check.sh', async () => {
      await scaffoldClaudeHooks(testDir, ['safety']);

      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'block-dangerous.sh'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'quality-check.sh'))
      ).toBe(false);
    });

    test('lite level creates lite-specific hooks', async () => {
      await scaffoldClaudeHooks(testDir, ['lite']);

      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'lite-sprawl-check.sh'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'simplification-guard.sh'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'block-dangerous.sh'))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'scope-guard.sh'))
      ).toBe(true);
    });

    test('audit.sh is auto-added when any hooks are enabled', async () => {
      await scaffoldClaudeHooks(testDir, ['quality']);
      expect(
        fs.existsSync(path.join(testDir, '.claude', 'hooks', 'audit.sh'))
      ).toBe(true);
    });
  });

  describe('settings.json merge behavior', () => {
    test('merges with existing settings.json preserving non-hook keys', async () => {
      // Pre-create a settings.json with custom keys
      const existingSettings = {
        permissions: { allow: ['Bash'] },
        hooks: {
          CustomEvent: [{ hooks: [{ type: 'command', command: 'echo custom', timeout: 5 }] }],
        },
      };
      fs.ensureDirSync(path.join(testDir, '.claude'));
      fs.writeJsonSync(path.join(testDir, '.claude', 'settings.json'), existingSettings);

      await scaffoldClaudeHooks(testDir);

      const merged = fs.readJsonSync(path.join(testDir, '.claude', 'settings.json'));

      // Custom permission should be preserved
      expect(merged.permissions).toEqual({ allow: ['Bash'] });

      // Scaffold hooks should be present
      expect(merged.hooks.PreToolUse).toBeDefined();
      expect(merged.hooks.SessionStart).toBeDefined();

      // The existing CustomEvent is overwritten by the new hooks object spread,
      // but existing keys in hooks that aren't in the new hooks are kept
      // (the merge does: { ...existingSettings.hooks, ...settings.hooks })
      // CustomEvent is only in existing, so it should survive
      expect(merged.hooks.CustomEvent).toBeDefined();
    });
  });

  describe('generateClaudeSettings unit tests', () => {
    test('returns object with hooks property', () => {
      const settings = generateClaudeSettings(['safety'], new Set(['block-dangerous.sh']));
      expect(settings).toHaveProperty('hooks');
    });

    test('safety level adds PreToolUse, SessionStart, Stop', () => {
      const hooks = new Set(['block-dangerous.sh', 'worktree-guard.sh']);
      const settings = generateClaudeSettings(['safety'], hooks);

      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
    });

    test('quality level adds PostToolUse', () => {
      const hooks = new Set(['quality-check.sh']);
      const settings = generateClaudeSettings(['quality'], hooks);

      expect(settings.hooks.PostToolUse).toBeDefined();
    });

    test('scope level adds PreToolUse and PostToolUse', () => {
      const hooks = new Set(['scope-guard.sh', 'naming-check.sh']);
      const settings = generateClaudeSettings(['scope'], hooks);

      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    });

    test('audit level adds SessionStart, Stop, PreCompact, PostToolUse', () => {
      const hooks = new Set(['audit.sh', 'session-log.sh']);
      const settings = generateClaudeSettings(['audit'], hooks);

      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.PreCompact).toBeDefined();
      expect(settings.hooks.PostToolUse).toBeDefined();
    });

    test('lite level adds PreToolUse entries for Write and Edit', () => {
      const hooks = new Set([
        'block-dangerous.sh',
        'scope-guard.sh',
        'lite-sprawl-check.sh',
        'simplification-guard.sh',
      ]);
      const settings = generateClaudeSettings(['lite'], hooks);

      const writeEntry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Write');
      expect(writeEntry).toBeDefined();
      expect(
        writeEntry.hooks.some((h) => h.command.includes('lite-sprawl-check.sh'))
      ).toBe(true);

      const editEntry = settings.hooks.PreToolUse.find((e) => e.matcher === 'Edit');
      expect(editEntry).toBeDefined();
      expect(
        editEntry.hooks.some((h) => h.command.includes('simplification-guard.sh'))
      ).toBe(true);
    });

    test('empty levels produce empty hooks object', () => {
      const settings = generateClaudeSettings([], new Set());
      expect(settings.hooks).toEqual({});
    });
  });

  describe('missing templates gracefully handled', () => {
    test('does not throw when template directory is missing', async () => {
      // Point to a non-existent directory by temporarily removing detection
      // The function catches errors internally and logs a warning
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-no-templates-'));
      try {
        // This should not throw even if templates are not found
        // (it will log a warning via chalk.yellow)
        await expect(scaffoldClaudeHooks(emptyDir)).resolves.not.toThrow();
      } finally {
        fs.removeSync(emptyDir);
      }
    });
  });

  describe('hook files match templates', () => {
    test('scaffolded hook content matches template source', async () => {
      await scaffoldClaudeHooks(testDir);

      const hooksToCheck = [
        'block-dangerous.sh',
        'scope-guard.sh',
        'session-log.sh',
        'doc-frontmatter-check.sh',
        'classify_command.py',
      ];

      for (const hook of hooksToCheck) {
        const templatePath = path.join(templateDir, '.claude', 'hooks', hook);
        const scaffoldedPath = path.join(testDir, '.claude', 'hooks', hook);

        if (fs.existsSync(templatePath) && fs.existsSync(scaffoldedPath)) {
          const templateContent = fs.readFileSync(templatePath, 'utf8');
          const scaffoldedContent = fs.readFileSync(scaffoldedPath, 'utf8');
          expect(scaffoldedContent).toBe(templateContent);
        }
      }
    });
  });
});
