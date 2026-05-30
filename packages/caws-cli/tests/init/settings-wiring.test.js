/**
 * Behavior tests for caws init's .claude/settings.json wiring
 * (CAWS-INIT-SETTINGS-WIRING-001).
 *
 * Covers the spec acceptance criteria at the function level — real temp
 * dirs, real filesystem writes, asserting SEMANTICS (the resulting JSON
 * shape and which keys changed), not mocks:
 *
 *   A1  absent             → fresh settings.json with only CAWS wiring + .example
 *   A2  present-but-unwired → CAWS entries appended; user keys preserved
 *   A3  already-wired      → idempotent no-op; byte-identical across two runs
 *   A4  invalid JSON       → refuse, file untouched
 *   A5  old dispatch/ dir  → detected (leave-and-warn handled by caller)
 *   A6  namespace          → wiring references caws_dispatch/, not dispatch/
 *
 * Imports the compiled module the same way tests/init/hook-packs/install.test.js
 * does (../../../dist/init/hook-install).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mergeClaudeSettings,
  writeSettingsExample,
  detectOrphanedDispatchDir,
  CANONICAL_HOOK_ENTRIES,
  CANONICAL_SETTINGS_SNIPPET,
} = require('../../dist/init/hook-install');

function mkRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'caws-settings-wiring-'));
}

function rmRepo(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
}

function settingsPath(root) {
  return path.join(root, '.claude', 'settings.json');
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Pull every hook command string out of a settings object's hooks block. */
function allCommands(settings) {
  const cmds = [];
  const hooks = settings.hooks || {};
  for (const key of Object.keys(hooks)) {
    for (const block of hooks[key] || []) {
      for (const h of block.hooks || []) {
        if (typeof h.command === 'string') cmds.push(h.command);
      }
    }
  }
  return cmds;
}

describe('CAWS-INIT-SETTINGS-WIRING-001 settings.json merge', () => {
  let root;
  beforeEach(() => {
    root = mkRepo();
  });
  afterEach(() => rmRepo(root));

  // ── A1: absent → fresh file with only CAWS wiring ──────────────────
  test('A1: absent settings.json → creates fresh file with the four CAWS entries only', () => {
    const result = mergeClaudeSettings(root);
    expect(result.kind).toBe('created');

    const written = readJson(settingsPath(root));
    expect(Object.keys(written)).toEqual(['hooks']);
    expect(Object.keys(written.hooks).sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort()
    );
    // Each event has exactly one CAWS entry, no invented extra keys.
    for (const key of Object.keys(CANONICAL_HOOK_ENTRIES)) {
      expect(written.hooks[key]).toHaveLength(1);
    }
    // No non-CAWS commands leaked in.
    for (const cmd of allCommands(written)) {
      expect(cmd).toContain('/.claude/hooks/caws_dispatch/');
    }
  });

  test('A1: writeSettingsExample always emits a reference .example with canonical content', () => {
    const examplePath = writeSettingsExample(root);
    expect(fs.existsSync(examplePath)).toBe(true);
    expect(path.basename(examplePath)).toBe('settings.json.example');
    // The example is the canonical snippet (plus trailing newline).
    expect(fs.readFileSync(examplePath, 'utf8').trim()).toBe(
      CANONICAL_SETTINGS_SNIPPET.trim()
    );
  });

  // ── A2: present-but-unwired → append, preserve everything else ─────
  test('A2: existing user settings → CAWS entries appended; user keys & hooks preserved', () => {
    const userSettings = {
      permissions: { allow: ['Bash(ls *)'] },
      env: { FOO: 'bar' },
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/usr/local/bin/my-own-hook.sh' }],
          },
        ],
      },
    };
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(settingsPath(root), JSON.stringify(userSettings, null, 2));

    const result = mergeClaudeSettings(root);
    expect(result.kind).toBe('merged');
    // All four events gained a CAWS entry (PreToolUse existed but had no CAWS entry).
    expect(result.added.sort()).toEqual(
      ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop'].sort()
    );

    const after = readJson(settingsPath(root));
    // User keys preserved byte-equivalent.
    expect(after.permissions).toEqual({ allow: ['Bash(ls *)'] });
    expect(after.env).toEqual({ FOO: 'bar' });
    // User's own PreToolUse hook is still there...
    expect(allCommands(after)).toContain('/usr/local/bin/my-own-hook.sh');
    // ...alongside the appended CAWS one.
    expect(
      allCommands(after).some((c) =>
        c.includes('/.claude/hooks/caws_dispatch/pre_tool_use.sh')
      )
    ).toBe(true);
    // PreToolUse now has 2 entries (user's + CAWS); not clobbered.
    expect(after.hooks.PreToolUse).toHaveLength(2);
  });

  // ── A3: already-wired → idempotent no-op, byte-identical ───────────
  test('A3: running twice is idempotent and byte-identical', () => {
    const first = mergeClaudeSettings(root); // created
    expect(first.kind).toBe('created');
    const bytesAfterFirst = fs.readFileSync(settingsPath(root));

    const second = mergeClaudeSettings(root); // unchanged
    expect(second.kind).toBe('unchanged');
    const bytesAfterSecond = fs.readFileSync(settingsPath(root));

    expect(bytesAfterSecond.equals(bytesAfterFirst)).toBe(true);
  });

  // ── A4: invalid JSON → refuse, file untouched ──────────────────────
  test('A4: unparseable settings.json → refused, file left byte-identical', () => {
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const garbage = '{ this is : not valid json ]]';
    fs.writeFileSync(settingsPath(root), garbage);

    const result = mergeClaudeSettings(root);
    expect(result.kind).toBe('invalid');
    expect(result.error).toBeTruthy();
    // File untouched.
    expect(fs.readFileSync(settingsPath(root), 'utf8')).toBe(garbage);
  });

  // ── A5: old dispatch/ dir detected (leave-and-warn) ────────────────
  test('A5: pre-rename dispatch/ dir is detected and left untouched', () => {
    const oldDir = path.join(root, '.claude', 'hooks', 'dispatch');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'pre_tool_use.sh'), '# old managed script');

    const detected = detectOrphanedDispatchDir(root);
    expect(detected).toBe(oldDir);

    // Merging settings does not delete or modify the old dir.
    mergeClaudeSettings(root);
    expect(fs.existsSync(path.join(oldDir, 'pre_tool_use.sh'))).toBe(true);
  });

  test('A5: no false positive when only caws_dispatch/ is present', () => {
    fs.mkdirSync(path.join(root, '.claude', 'hooks', 'caws_dispatch'), {
      recursive: true,
    });
    expect(detectOrphanedDispatchDir(root)).toBeNull();
  });

  // ── A6: namespace — wiring references caws_dispatch/, never dispatch/ ─
  test('A6: canonical wiring uses the caws_dispatch namespace, not bare dispatch/', () => {
    for (const cmd of allCommands(JSON.parse(CANONICAL_SETTINGS_SNIPPET))) {
      expect(cmd).toContain('/.claude/hooks/caws_dispatch/');
      expect(cmd).not.toMatch(/\/\.claude\/hooks\/dispatch\//);
    }
  });
});
