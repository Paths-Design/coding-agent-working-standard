/**
 * @fileoverview Tests for CAWS Lite Scope Configuration
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');

const {
  loadLiteScope,
  isPathAllowed,
  matchesBannedPattern,
  getLiteScopeDefaults,
} = require('../src/config/lite-scope');

describe('lite-scope', () => {
  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-lite-scope-test-'));
  });

  afterEach(() => {
    fs.removeSync(testDir);
  });

  describe('getLiteScopeDefaults', () => {
    test('returns default configuration', () => {
      const defaults = getLiteScopeDefaults();
      expect(defaults.version).toBe(1);
      expect(defaults.allowedDirectories).toContain('src/');
      expect(defaults.bannedPatterns.files).toContain('*-enhanced.*');
      expect(defaults.maxNewFilesPerCommit).toBe(10);
      expect(defaults.designatedVenvPath).toBe('.venv');
    });
  });

  describe('loadLiteScope', () => {
    test('returns defaults when no scope.json exists', () => {
      const scope = loadLiteScope(testDir);
      expect(scope).toEqual(getLiteScopeDefaults());
    });

    test('loads scope.json from disk', () => {
      const cawsDir = path.join(testDir, '.caws');
      fs.ensureDirSync(cawsDir);
      fs.writeFileSync(
        path.join(cawsDir, 'scope.json'),
        JSON.stringify({
          version: 1,
          allowedDirectories: ['lib/', 'test/'],
          bannedPatterns: { files: ['*-old.*'] },
          maxNewFilesPerCommit: 5,
        })
      );

      const scope = loadLiteScope(testDir);
      expect(scope.allowedDirectories).toEqual(['lib/', 'test/']);
      expect(scope.bannedPatterns.files).toEqual(['*-old.*']);
      expect(scope.maxNewFilesPerCommit).toBe(5);
      // Defaults should fill in missing fields
      expect(scope.bannedPatterns.directories).toEqual(getLiteScopeDefaults().bannedPatterns.directories);
    });

    test('handles malformed scope.json gracefully', () => {
      const cawsDir = path.join(testDir, '.caws');
      fs.ensureDirSync(cawsDir);
      fs.writeFileSync(path.join(cawsDir, 'scope.json'), 'not json');

      const scope = loadLiteScope(testDir);
      expect(scope).toEqual(getLiteScopeDefaults());
    });
  });

  describe('isPathAllowed', () => {
    const scope = {
      allowedDirectories: ['src/', 'tests/', 'docs/'],
    };

    test('allows files in allowed directories', () => {
      expect(isPathAllowed('src/index.js', scope)).toBe(true);
      expect(isPathAllowed('tests/test.js', scope)).toBe(true);
      expect(isPathAllowed('docs/guide.md', scope)).toBe(true);
    });

    test('blocks files outside allowed directories', () => {
      expect(isPathAllowed('lib/something.js', scope)).toBe(false);
      expect(isPathAllowed('vendor/package.js', scope)).toBe(false);
    });

    test('allows root-level files', () => {
      expect(isPathAllowed('package.json', scope)).toBe(true);
      expect(isPathAllowed('README.md', scope)).toBe(true);
    });

    test('allows .caws/ directory', () => {
      expect(isPathAllowed('.caws/scope.json', scope)).toBe(true);
    });

    test('allows everything when no directories specified', () => {
      expect(isPathAllowed('anywhere/file.js', { allowedDirectories: [] })).toBe(true);
    });

    test('handles deeply nested paths', () => {
      expect(isPathAllowed('src/components/auth/login.tsx', scope)).toBe(true);
      expect(isPathAllowed('other/deep/path/file.js', scope)).toBe(false);
    });
  });

  describe('matchesBannedPattern', () => {
    const scope = getLiteScopeDefaults();

    test('detects banned file patterns', () => {
      const result = matchesBannedPattern('src/utils-enhanced.js', scope);
      expect(result.matched).toBe(true);
      expect(result.category).toBe('files');
    });

    test('detects banned final patterns', () => {
      const result = matchesBannedPattern('src/api-final.ts', scope);
      expect(result.matched).toBe(true);
      expect(result.category).toBe('files');
    });

    test('detects banned v2 patterns', () => {
      const result = matchesBannedPattern('src/handler-v2.js', scope);
      expect(result.matched).toBe(true);
    });

    test('detects banned copy patterns', () => {
      const result = matchesBannedPattern('src/module-copy.py', scope);
      expect(result.matched).toBe(true);
    });

    test('detects banned directory patterns', () => {
      const result = matchesBannedPattern('my-venv/lib/python3/site.py', scope);
      expect(result.matched).toBe(true);
      expect(result.category).toBe('directories');
    });

    test('detects banned doc patterns', () => {
      const result = matchesBannedPattern('docs/feature-summary.md', scope);
      expect(result.matched).toBe(true);
      expect(result.category).toBe('docs');
    });

    test('allows normal files', () => {
      const result = matchesBannedPattern('src/utils.js', scope);
      expect(result.matched).toBe(false);
    });

    test('allows normal docs', () => {
      const result = matchesBannedPattern('docs/README.md', scope);
      expect(result.matched).toBe(false);
    });
  });
});
