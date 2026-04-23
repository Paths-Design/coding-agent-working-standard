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
 * Check if a file is infrastructure or lives in a policy-declared
 * non-governed zone. Exempt files bypass both scope.in and scope.out.
 *
 * @param {string} filePath - File path to check
 * @param {string[]} [nonGovernedZones=[]] - Glob patterns from
 *   policy.non_governed_zones. Paths matching any pattern are exempt
 *   from scope enforcement entirely. (CAWSFIX-26 / D9)
 * @returns {boolean} Whether the file is exempt from scope checks
 */
function isExempt(filePath, nonGovernedZones = []) {
  // .caws and .claude directories always pass (infrastructure)
  if (filePath.startsWith('.caws/') || filePath.startsWith('.claude/')) return true;

  // Policy-declared non-governed zones short-circuit scope enforcement.
  // Intentionally wins over scope.out: the contract is that these
  // subtrees are outside the governance model, not merely excluded
  // from one spec's scope.
  if (nonGovernedZones.length > 0 && matchesAny(filePath, nonGovernedZones)) {
    return true;
  }

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
 * @param {Object} [params.policy] - Optional CAWS policy. Reads
 *   policy.non_governed_zones for path exemption (CAWSFIX-26 / D9).
 *   When absent or the field is empty, only infra dirs are exempt.
 * @returns {Promise<Object>} Gate result with status and messages
 */
async function run({ stagedFiles, spec, policy }) {
  const messages = [];
  const violations = [];

  const scopeIn = spec?.scope?.in || [];
  const scopeOut = spec?.scope?.out || [];
  const nonGovernedZones = Array.isArray(policy?.non_governed_zones)
    ? policy.non_governed_zones
    : [];

  // If no scope defined, pass
  if (scopeIn.length === 0 && scopeOut.length === 0) {
    return { status: 'pass', messages: ['No scope boundaries defined'] };
  }

  for (const file of stagedFiles) {
    // Infrastructure dirs AND policy-declared non-governed zones are exempt.
    if (isExempt(file, nonGovernedZones)) continue;

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
