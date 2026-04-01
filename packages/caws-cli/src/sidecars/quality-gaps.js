/**
 * @fileoverview Quality-Gap Diagnosis Sidecar
 * Identifies specific gaps preventing phase advancement: validation failures,
 * low evaluation scores, failing/unchecked ACs, blocking gates.
 * @author @darianrosebrook
 */

const { computePhase } = require('../utils/working-state');
const { createSidecarOutput, createNoStateOutput } = require('./schema');

// ---------------------------------------------------------------------------
// Phase progression
// ---------------------------------------------------------------------------

const PHASE_ORDER = [
  'not-started',
  'spec-authoring',
  'implementation',
  'verification',
  'complete',
];

function nextPhase(current) {
  const idx = PHASE_ORDER.indexOf(current);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}

// ---------------------------------------------------------------------------
// Gap detection per transition
// ---------------------------------------------------------------------------

/**
 * Build the list of gap objects for advancing from `current` to `target`.
 * @param {object} state
 * @param {string} target
 * @returns {object[]}
 */
function detectGaps(state, target) {
  const gaps = [];
  const v = state.validation;
  const e = state.evaluation;
  const g = state.gates;
  const ac = state.acceptance_criteria;

  if (target === 'spec-authoring') {
    // Need any command to have run
    if (!v && !e && !g && !ac) {
      gaps.push({
        category: 'no_evaluation',
        severity: 'warning',
        message: 'No commands have been run yet',
        remediation: 'caws validate',
      });
    }
    return gaps;
  }

  if (target === 'implementation') {
    if (v && !v.passed) {
      gaps.push({
        category: 'validation_failure',
        severity: 'blocker',
        message: `Validation failed with ${v.error_count || 0} error(s)`,
        remediation: 'caws validate',
      });
    }
    if (!v) {
      gaps.push({
        category: 'validation_failure',
        severity: 'blocker',
        message: 'Validation has not been run',
        remediation: 'caws validate',
      });
    }
    if (e && e.percentage < 70) {
      gaps.push({
        category: 'low_evaluation',
        severity: 'blocker',
        message: `Evaluation score ${e.percentage}% is below 70% threshold`,
        remediation: 'caws evaluate',
      });
    }
    if (!e) {
      gaps.push({
        category: 'no_evaluation',
        severity: 'warning',
        message: 'No evaluation has been run',
        remediation: 'caws evaluate',
      });
    }
    return gaps;
  }

  if (target === 'verification') {
    if (ac && ac.fail > 0) {
      gaps.push({
        category: 'ac_failure',
        severity: 'blocker',
        message: `${ac.fail} acceptance criteria failing`,
        remediation: 'caws ac check',
      });
    }
    if (ac && ac.unchecked > 0) {
      gaps.push({
        category: 'ac_unchecked',
        severity: 'warning',
        message: `${ac.unchecked} acceptance criteria unchecked`,
        remediation: 'caws ac check',
      });
    }
    if (!ac || ac.total === 0) {
      gaps.push({
        category: 'no_acs',
        severity: 'warning',
        message: 'No acceptance criteria have been defined or checked',
        remediation: 'caws ac check',
      });
    }
    if (!g) {
      gaps.push({
        category: 'no_gates',
        severity: 'warning',
        message: 'Gates have not been run',
        remediation: 'caws gates',
      });
    }
    return gaps;
  }

  if (target === 'complete') {
    if (ac && ac.fail > 0) {
      gaps.push({
        category: 'ac_failure',
        severity: 'blocker',
        message: `${ac.fail} acceptance criteria failing`,
        remediation: 'caws ac check',
      });
    }
    if (ac && ac.unchecked > 0) {
      gaps.push({
        category: 'ac_unchecked',
        severity: 'warning',
        message: `${ac.unchecked} acceptance criteria unchecked`,
        remediation: 'caws ac check',
      });
    }
    if (g && !g.passed) {
      gaps.push({
        category: 'gate_failure',
        severity: 'blocker',
        message: 'Gates are not passing',
        remediation: 'caws gates',
      });
    }
    if (!g) {
      gaps.push({
        category: 'no_gates',
        severity: 'warning',
        message: 'Gates have not been run',
        remediation: 'caws gates',
      });
    }
    if (e && e.percentage < 90) {
      gaps.push({
        category: 'low_evaluation',
        severity: 'blocker',
        message: `Evaluation score ${e.percentage}% is below 90% threshold`,
        remediation: 'caws evaluate',
      });
    }
    if (!e) {
      gaps.push({
        category: 'no_evaluation',
        severity: 'warning',
        message: 'No evaluation has been run',
        remediation: 'caws evaluate',
      });
    }
    return gaps;
  }

  return gaps;
}

// ---------------------------------------------------------------------------
// Phase requirements snapshot
// ---------------------------------------------------------------------------

function buildPhaseRequirements(state, target) {
  const v = state.validation;
  const e = state.evaluation;
  const g = state.gates;
  const ac = state.acceptance_criteria;

  const reqs = {
    validation_passed: v ? v.passed === true : false,
    evaluation_pct: e ? e.percentage : null,
    evaluation_required: target === 'complete' ? 90 : (target === 'implementation' ? 70 : null),
    all_acs_pass: ac ? (ac.fail === 0 && ac.unchecked === 0 && ac.total > 0) : false,
    gates_run: !!g,
    gates_passed: g ? g.passed === true : false,
  };
  return reqs;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Diagnose quality gaps preventing phase advancement.
 * @param {object|null} state - Working state
 * @param {object} [spec] - Spec object
 * @returns {object} Sidecar envelope
 */
function diagnoseQualityGaps(state, spec) {
  if (!state) {
    return createNoStateOutput('gaps', spec?.id || 'unknown');
  }

  const currentPhase = computePhase(state, spec);
  const target = nextPhase(currentPhase);

  if (!target) {
    // Already complete
    return createSidecarOutput('gaps', spec?.id || 'unknown', {
      current_phase: currentPhase,
      next_phase: null,
      gaps: [],
      phase_requirements: buildPhaseRequirements(state, currentPhase),
      summary: 'No gaps — all phases complete',
    });
  }

  const gaps = detectGaps(state, target);
  // Sort blockers before warnings
  gaps.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'blocker' ? -1 : 1;
  });

  const blockerCount = gaps.filter(g => g.severity === 'blocker').length;
  const totalCount = gaps.length;
  const summary = totalCount === 0
    ? `No gaps blocking advancement to ${target}`
    : `${totalCount} gap${totalCount !== 1 ? 's' : ''} (${blockerCount} blocker${blockerCount !== 1 ? 's' : ''}) blocking advancement to ${target}`;

  return createSidecarOutput('gaps', spec?.id || 'unknown', {
    current_phase: currentPhase,
    next_phase: target,
    gaps,
    phase_requirements: buildPhaseRequirements(state, target),
    summary,
  });
}

module.exports = { diagnoseQualityGaps };
