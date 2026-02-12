/**
 * @fileoverview CAWS Lite-Mode Scope Configuration Loader
 * Reads and validates .caws/scope.json for guardrails-only mode
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const micromatch = require('micromatch');

const SCOPE_FILE = '.caws/scope.json';

/**
 * Default scope configuration for lite mode
 * @returns {Object} Default scope.json contents
 */
function getLiteScopeDefaults() {
  return {
    version: 1,
    allowedDirectories: ['src/', 'tests/', 'docs/'],
    bannedPatterns: {
      files: ['*-enhanced.*', '*-final.*', '*-v2.*', '*-copy.*'],
      directories: ['*venv*', '.venv', 'm-venv', 'env/'],
      docs: ['*-summary.md', '*-recap.md', '*-plan.md', 'sprint-*'],
    },
    maxNewFilesPerCommit: 10,
    designatedVenvPath: '.venv',
  };
}

/**
 * Load lite scope configuration from .caws/scope.json
 * @param {string} [projectRoot] - Project root directory (defaults to cwd)
 * @returns {Object} Scope configuration (defaults if file not found)
 */
function loadLiteScope(projectRoot) {
  const root = projectRoot || process.cwd();
  const scopePath = path.join(root, SCOPE_FILE);

  try {
    if (!fs.existsSync(scopePath)) {
      return getLiteScopeDefaults();
    }

    const raw = fs.readFileSync(scopePath, 'utf8');
    const config = JSON.parse(raw);

    // Merge with defaults for any missing fields
    const defaults = getLiteScopeDefaults();
    return {
      version: config.version || defaults.version,
      allowedDirectories: config.allowedDirectories || defaults.allowedDirectories,
      bannedPatterns: {
        files: config.bannedPatterns?.files || defaults.bannedPatterns.files,
        directories: config.bannedPatterns?.directories || defaults.bannedPatterns.directories,
        docs: config.bannedPatterns?.docs || defaults.bannedPatterns.docs,
      },
      maxNewFilesPerCommit: config.maxNewFilesPerCommit ?? defaults.maxNewFilesPerCommit,
      designatedVenvPath: config.designatedVenvPath || defaults.designatedVenvPath,
    };
  } catch (error) {
    // If file is malformed, return defaults
    return getLiteScopeDefaults();
  }
}

/**
 * Check if a file path is allowed by the scope configuration
 * @param {string} filePath - Relative file path to check
 * @param {Object} [scope] - Scope configuration (loads from disk if not provided)
 * @param {string} [projectRoot] - Project root directory
 * @returns {boolean} Whether the path is allowed
 */
function isPathAllowed(filePath, scope, projectRoot) {
  const config = scope || loadLiteScope(projectRoot);
  const dirs = config.allowedDirectories;

  // If no allowed directories specified, everything is allowed
  if (!dirs || dirs.length === 0) {
    return true;
  }

  // Normalize the file path
  const normalized = filePath.replace(/\\/g, '/');

  // Check if file is within any allowed directory
  for (const dir of dirs) {
    const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalized.startsWith(normalizedDir + '/') || normalized === normalizedDir) {
      return true;
    }
  }

  // Also allow root-level config files (package.json, etc.)
  if (!normalized.includes('/')) {
    return true;
  }

  // Allow .caws/ directory itself
  if (normalized.startsWith('.caws/')) {
    return true;
  }

  return false;
}

/**
 * Check if a filename or path matches any banned pattern
 * @param {string} filePath - File path to check
 * @param {Object} [scope] - Scope configuration (loads from disk if not provided)
 * @param {string} [projectRoot] - Project root directory
 * @returns {{ matched: boolean, pattern: string|null, category: string|null }} Match result
 */
function matchesBannedPattern(filePath, scope, projectRoot) {
  const config = scope || loadLiteScope(projectRoot);
  const banned = config.bannedPatterns;
  const basename = path.basename(filePath);
  const normalized = filePath.replace(/\\/g, '/');

  // Check file patterns
  if (banned.files && banned.files.length > 0) {
    if (micromatch.isMatch(basename, banned.files, { dot: true })) {
      const matched = banned.files.find((p) => micromatch.isMatch(basename, p, { dot: true }));
      return { matched: true, pattern: matched, category: 'files' };
    }
  }

  // Check directory patterns
  if (banned.directories && banned.directories.length > 0) {
    const parts = normalized.split('/');
    for (const part of parts) {
      if (micromatch.isMatch(part, banned.directories, { dot: true })) {
        const matched = banned.directories.find((p) =>
          micromatch.isMatch(part, p, { dot: true })
        );
        return { matched: true, pattern: matched, category: 'directories' };
      }
    }
  }

  // Check doc patterns
  if (banned.docs && banned.docs.length > 0) {
    if (micromatch.isMatch(basename, banned.docs, { dot: true })) {
      const matched = banned.docs.find((p) => micromatch.isMatch(basename, p, { dot: true }));
      return { matched: true, pattern: matched, category: 'docs' };
    }
  }

  return { matched: false, pattern: null, category: null };
}

module.exports = {
  loadLiteScope,
  isPathAllowed,
  matchesBannedPattern,
  getLiteScopeDefaults,
  SCOPE_FILE,
};
