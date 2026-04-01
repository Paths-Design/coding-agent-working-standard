/**
 * @fileoverview Spec Drift Analysis Sidecar
 * Compares implementation evidence (files_touched, AC results, gate results)
 * against spec scope and acceptance criteria.
 * @author @darianrosebrook
 */

const _minimatch = require('minimatch');
const minimatch = typeof _minimatch === 'function'
  ? _minimatch
  : (_minimatch.minimatch || (() => { throw new Error('minimatch export not found — expected v3 default or v5+ named export'); }));
const { createSidecarOutput, createNoStateOutput } = require('./schema');
const { getRecurrence } = require('../gates/feedback');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file path is within the spec's declared scope.
 * A file is in scope if it matches at least one scope.in pattern
 * and does not match any scope.out pattern.
 * @param {string} file
 * @param {string[]} scopeIn
 * @param {string[]} scopeOut
 * @returns {boolean}
 */
function isInScope(file, scopeIn, scopeOut) {
  if (scopeIn.length === 0) return true; // No scope.in means everything is allowed
  const matchesIn = scopeIn.some(pattern => minimatch(file, pattern));
  if (!matchesIn) return false;
  const matchesOut = scopeOut.some(pattern => minimatch(file, pattern));
  return !matchesOut;
}

/**
 * Build a set of file paths that are referenced by any acceptance criterion.
 * This is a rough heuristic: ACs that have results with file references, or
 * whose descriptions mention paths present in files_touched.
 * @param {object[]} acResults - state.acceptance_criteria.results
 * @param {string[]} filesTouched
 * @returns {Set<string>}
 */
function filesWithACCoverage(acResults, filesTouched) {
  const covered = new Set();
  if (!acResults || !filesTouched) return covered;

  for (const result of acResults) {
    // If a result references files explicitly, mark them covered
    if (result.files) {
      result.files.forEach(f => covered.add(f));
    }
    // Heuristic: any file_touched whose basename appears in the AC description
    // is considered loosely covered
    if (result.description) {
      for (const file of filesTouched) {
        const basename = file.split('/').pop();
        if (result.description.includes(basename)) {
          covered.add(file);
        }
      }
    }
  }
  return covered;
}

/**
 * Gather gate corroboration: how many scope_boundary failures exist in history.
 * @param {object|null} state
 * @returns {{ scope_failures: number, last_failure: string|null }}
 */
function getGateCorroboration(state) {
  const recurrence = getRecurrence('scope_boundary', state);
  if (!recurrence) return { scope_failures: 0, last_failure: null };
  return { scope_failures: recurrence.count, last_failure: recurrence.lastSeen };
}

// ---------------------------------------------------------------------------
// Main analysis
// ---------------------------------------------------------------------------

/**
 * Analyze spec drift by comparing implementation evidence against spec intent.
 * Pure function -- no side effects, no writes.
 * @param {object|null} state - Working state (from loadState)
 * @param {object} spec - Resolved spec object
 * @returns {object} Sidecar output envelope
 */
function analyzeSpecDrift(state, spec) {
  if (!state) {
    return createNoStateOutput('drift', spec.id);
  }

  const scopeIn = (spec.scope && spec.scope.in) || [];
  const scopeOut = (spec.scope && spec.scope.out) || [];
  const filesTouched = state.files_touched || [];
  const acceptance = spec.acceptance || [];
  const acResults = (state.acceptance_criteria && state.acceptance_criteria.results) || [];

  // 1. Scope analysis -- find files outside declared scope
  const outOfScopeFiles = filesTouched.filter(f => !isInScope(f, scopeIn, scopeOut));

  // 2. Acceptance criteria cross-reference
  const acResultMap = new Map();
  for (const r of acResults) {
    acResultMap.set(r.id, r);
  }

  const failingCriteria = [];
  const missingEvidence = [];

  for (const ac of acceptance) {
    const result = acResultMap.get(ac.id);
    if (!result || result.status === 'UNCHECKED') {
      missingEvidence.push({ id: ac.id, description: ac.description || ac.text || '' });
    } else if (result.status === 'FAIL') {
      failingCriteria.push({ id: ac.id, description: ac.description || ac.text || '' });
    }
  }

  // 3. Scope creep -- files with no AC coverage
  const covered = filesWithACCoverage(acResults, filesTouched);
  const scopeCreepFiles = filesTouched.filter(f => !covered.has(f));

  // 4. Gate corroboration
  const gateCorroboration = getGateCorroboration(state);

  // 5. Drift detection
  const driftDetected = outOfScopeFiles.length > 0 ||
    failingCriteria.length > 0 ||
    missingEvidence.length > 0;

  // 6. Summary
  const parts = [];
  if (outOfScopeFiles.length > 0) parts.push(`${outOfScopeFiles.length} file(s) outside scope`);
  if (failingCriteria.length > 0) parts.push(`${failingCriteria.length} AC failing`);
  if (missingEvidence.length > 0) parts.push(`${missingEvidence.length} AC unchecked`);
  const summary = parts.length > 0 ? parts.join(', ') : 'No drift detected';

  return createSidecarOutput('drift', spec.id, {
    drift_detected: driftDetected,
    out_of_scope_files: outOfScopeFiles,
    failing_criteria: failingCriteria,
    missing_evidence: missingEvidence,
    scope_creep_files: scopeCreepFiles,
    gate_corroboration: gateCorroboration,
    summary,
  });
}

module.exports = { analyzeSpecDrift };
