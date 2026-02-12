/**
 * @fileoverview Tests for IDE detection and selection utilities
 */

const {
  IDE_REGISTRY,
  ALL_IDE_IDS,
  detectActiveIDEs,
  getRecommendedIDEs,
  parseIDESelection,
} = require('../src/utils/ide-detection');

describe('IDE Detection Utilities', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Clear all IDE env vars
    delete process.env.CURSOR_TRACE_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.VSCODE_PID;
    delete process.env.VSCODE_IPC_HOOK;
    delete process.env.IDEA_INITIAL_DIRECTORY;
    delete process.env.WINDSURF_WORKSPACE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('IDE_REGISTRY', () => {
    test('has 7 IDE entries', () => {
      expect(Object.keys(IDE_REGISTRY)).toHaveLength(7);
    });

    test('each entry has required fields', () => {
      for (const [id, config] of Object.entries(IDE_REGISTRY)) {
        expect(config).toHaveProperty('id', id);
        expect(config).toHaveProperty('name');
        expect(config).toHaveProperty('description');
        expect(config).toHaveProperty('envVars');
        expect(Array.isArray(config.envVars)).toBe(true);
      }
    });

    test('includes all expected IDEs', () => {
      expect(IDE_REGISTRY).toHaveProperty('cursor');
      expect(IDE_REGISTRY).toHaveProperty('claude');
      expect(IDE_REGISTRY).toHaveProperty('vscode');
      expect(IDE_REGISTRY).toHaveProperty('intellij');
      expect(IDE_REGISTRY).toHaveProperty('windsurf');
      expect(IDE_REGISTRY).toHaveProperty('copilot');
      expect(IDE_REGISTRY).toHaveProperty('junie');
    });
  });

  describe('ALL_IDE_IDS', () => {
    test('matches registry keys', () => {
      expect(ALL_IDE_IDS).toEqual(Object.keys(IDE_REGISTRY));
    });

    test('has 7 entries', () => {
      expect(ALL_IDE_IDS).toHaveLength(7);
    });
  });

  describe('detectActiveIDEs', () => {
    test('returns empty array when no IDE env vars set', () => {
      expect(detectActiveIDEs()).toEqual([]);
    });

    test('detects cursor when CURSOR_TRACE_DIR is set', () => {
      process.env.CURSOR_TRACE_DIR = '/tmp/cursor';
      expect(detectActiveIDEs()).toContain('cursor');
    });

    test('detects claude when CLAUDE_PROJECT_DIR is set', () => {
      process.env.CLAUDE_PROJECT_DIR = '/tmp/claude';
      expect(detectActiveIDEs()).toContain('claude');
    });

    test('detects vscode when VSCODE_PID is set', () => {
      process.env.VSCODE_PID = '12345';
      expect(detectActiveIDEs()).toContain('vscode');
    });

    test('detects vscode when VSCODE_IPC_HOOK is set', () => {
      process.env.VSCODE_IPC_HOOK = '/tmp/vscode.sock';
      expect(detectActiveIDEs()).toContain('vscode');
    });

    test('detects intellij when IDEA_INITIAL_DIRECTORY is set', () => {
      process.env.IDEA_INITIAL_DIRECTORY = '/projects';
      expect(detectActiveIDEs()).toContain('intellij');
    });

    test('detects windsurf when WINDSURF_WORKSPACE is set', () => {
      process.env.WINDSURF_WORKSPACE = '/workspace';
      expect(detectActiveIDEs()).toContain('windsurf');
    });

    test('detects multiple IDEs simultaneously', () => {
      process.env.CURSOR_TRACE_DIR = '/tmp/cursor';
      process.env.VSCODE_PID = '12345';
      const detected = detectActiveIDEs();
      expect(detected).toContain('cursor');
      expect(detected).toContain('vscode');
    });

    test('never detects copilot or junie (no env vars)', () => {
      // Set all other IDE vars
      process.env.CURSOR_TRACE_DIR = '/tmp';
      process.env.CLAUDE_PROJECT_DIR = '/tmp';
      process.env.VSCODE_PID = '1';
      process.env.IDEA_INITIAL_DIRECTORY = '/tmp';
      process.env.WINDSURF_WORKSPACE = '/tmp';
      const detected = detectActiveIDEs();
      expect(detected).not.toContain('copilot');
      expect(detected).not.toContain('junie');
    });
  });

  describe('getRecommendedIDEs', () => {
    test('returns cursor and claude when nothing detected', () => {
      const recommended = getRecommendedIDEs();
      expect(recommended).toEqual(['cursor', 'claude']);
    });

    test('pairs cursor with claude when cursor detected', () => {
      process.env.CURSOR_TRACE_DIR = '/tmp/cursor';
      const recommended = getRecommendedIDEs();
      expect(recommended).toContain('cursor');
      expect(recommended).toContain('claude');
    });

    test('pairs vscode with copilot when vscode detected', () => {
      process.env.VSCODE_PID = '12345';
      const recommended = getRecommendedIDEs();
      expect(recommended).toContain('vscode');
      expect(recommended).toContain('copilot');
    });

    test('pairs intellij with junie when intellij detected', () => {
      process.env.IDEA_INITIAL_DIRECTORY = '/projects';
      const recommended = getRecommendedIDEs();
      expect(recommended).toContain('intellij');
      expect(recommended).toContain('junie');
    });

    test('includes detected IDE without duplication', () => {
      process.env.CURSOR_TRACE_DIR = '/tmp/cursor';
      const recommended = getRecommendedIDEs();
      const cursorCount = recommended.filter((id) => id === 'cursor').length;
      expect(cursorCount).toBe(1);
    });
  });

  describe('parseIDESelection', () => {
    let warnSpy;

    beforeEach(() => {
      warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    test('parses comma-separated string', () => {
      expect(parseIDESelection('cursor,claude')).toEqual(['cursor', 'claude']);
    });

    test('parses array input', () => {
      expect(parseIDESelection(['cursor', 'claude'])).toEqual(['cursor', 'claude']);
    });

    test('handles "all" keyword', () => {
      const result = parseIDESelection('all');
      expect(result).toEqual(ALL_IDE_IDS);
    });

    test('handles "none" keyword', () => {
      expect(parseIDESelection('none')).toEqual([]);
    });

    test('trims whitespace and lowercases', () => {
      expect(parseIDESelection(' Cursor , Claude ')).toEqual(['cursor', 'claude']);
    });

    test('filters invalid IDs and warns', () => {
      const result = parseIDESelection('cursor,fakeidee');
      expect(result).toEqual(['cursor']);
      expect(warnSpy).toHaveBeenCalled();
    });

    test('returns empty array for null input', () => {
      expect(parseIDESelection(null)).toEqual([]);
    });

    test('returns empty array for undefined input', () => {
      expect(parseIDESelection(undefined)).toEqual([]);
    });

    test('returns empty array for numeric input', () => {
      expect(parseIDESelection(42)).toEqual([]);
    });

    test('returns empty array for empty string', () => {
      expect(parseIDESelection('')).toEqual([]);
    });
  });
});
