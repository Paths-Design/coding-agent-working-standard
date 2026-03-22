/**
 * @fileoverview Scope enforcement gate
 * Validates staged files against spec.scope.in and spec.scope.out patterns.
 * @author @darianrosebrook
 */

const path = require('path');

const name = 'scope_boundary';

/**
 * Convert a glob pattern to a RegExp
 * Supports *, **, and ? wildcards.
 * @param {string} pattern - Glob pattern
 * @returns {RegExp} Compiled regex
 */
function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (except * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')       // placeholder for **
    .replace(/\*/g, '[^/]*')                // * matches anything except /
    .replace(/\?/g, '[^/]')                 // ? matches single non-/ char
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /

  return new RegExp(`^${regex}$`);
}

/**
 * Check if a file path matches any of the given glob patterns
 * @param {string} filePath - File path to check
 * @param {string[]} patterns - Glob patterns
 * @returns {boolean} Whether the file matches any pattern
 */
function matchesAny(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => globToRegex(p).test(filePath));
}

/**
 * Check if a file is a root-level or infrastructure file that always passes
 * @param {string} filePath - File path to check
 * @returns {boolean} Whether the file is exempt from scope checks
 */
function isExempt(filePath) {
  // Root-level files (no directory separator)
  if (!filePath.includes('/')) return true;
  // .caws and .claude directories always pass
  if (filePath.startsWith('.caws/') || filePath.startsWith('.claude/')) return true;
  return false;
}

/**
 * Run the scope boundary gate
 * @param {Object} params - Gate parameters
 * @param {string[]} params.stagedFiles - Staged file paths
 * @param {Object} params.spec - Working spec with scope.in/scope.out
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, spec }) {
  const messages = [];
  const violations = [];

  const scopeIn = spec?.scope?.in || [];
  const scopeOut = spec?.scope?.out || [];

  // If no scope defined, pass
  if (scopeIn.length === 0 && scopeOut.length === 0) {
    return { status: 'pass', messages: ['No scope boundaries defined'] };
  }

  for (const file of stagedFiles) {
    if (isExempt(file)) continue;

    // Check scope.out first (explicit exclusion)
    if (scopeOut.length > 0 && matchesAny(file, scopeOut)) {
      violations.push(file);
      messages.push(`Out of scope (excluded): ${file}`);
      continue;
    }

    // Check scope.in (must match if defined)
    if (scopeIn.length > 0 && !matchesAny(file, scopeIn)) {
      violations.push(file);
      messages.push(`Out of scope (not in allowed paths): ${file}`);
    }
  }

  if (violations.length > 0) {
    messages.unshift(`${violations.length} file(s) outside spec scope boundaries`);
    return { status: 'fail', messages };
  }

  return { status: 'pass', messages };
}

module.exports = { name, run };
