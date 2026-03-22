/**
 * @fileoverview Scope enforcement gate
 * Validates staged files against spec.scope.in and spec.scope.out patterns.
 * @author @darianrosebrook
 */

const picomatch = require('picomatch');

const name = 'scope_boundary';

/**
 * Check if a file path matches any of the given glob patterns.
 * Uses picomatch for correct glob semantics (** matches zero or more segments).
 * @param {string} filePath - File path to check
 * @param {string[]} patterns - Glob patterns
 * @returns {boolean} Whether the file matches any pattern
 */
function matchesAny(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return picomatch.isMatch(filePath, patterns, { dot: true });
}

/**
 * Check if a file is an infrastructure file that always passes scope checks.
 * Root-level files are exempt UNLESS they match an explicit scope.out pattern.
 * @param {string} filePath - File path to check
 * @returns {boolean} Whether the file is exempt from scope.in checks
 */
function isExempt(filePath) {
  // .caws and .claude directories always pass (infrastructure)
  if (filePath.startsWith('.caws/') || filePath.startsWith('.claude/')) return true;
  return false;
}

/**
 * Check if a file is a root-level file (no directory separator).
 * Root-level files skip scope.in checks but still respect scope.out.
 * @param {string} filePath - File path to check
 * @returns {boolean} Whether the file is root-level
 */
function isRootLevel(filePath) {
  return !filePath.includes('/');
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
    // Infrastructure dirs are always exempt
    if (isExempt(file)) continue;

    // Check scope.out first (explicit exclusion) — applies to ALL files including root-level
    if (scopeOut.length > 0 && matchesAny(file, scopeOut)) {
      violations.push(file);
      messages.push(`Out of scope (excluded): ${file}`);
      continue;
    }

    // Root-level files skip scope.in checks (but scope.out above still applies)
    if (isRootLevel(file)) continue;

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
