/**
 * @fileoverview Governance Lifecycle Events
 *
 * A lightweight event system for governance-significant moments in CAWS.
 * Events fire synchronously within command execution and are consumed by
 * the working-state layer, feedback enrichment, and future sidecar flows.
 *
 * This is NOT the same as IDE hooks (shell scripts in .claude/hooks/).
 * These are internal CAWS events emitted by CLI commands and gates.
 *
 * @author @darianrosebrook
 */

const { EventEmitter } = require('events');

/**
 * Singleton lifecycle event emitter.
 * @type {EventEmitter}
 */
const lifecycle = new EventEmitter();
lifecycle.setMaxListeners(20);

/**
 * Event name constants.
 *
 * @typedef {Object} GatesBlockedPayload
 * @property {string|null} specId
 * @property {string} gateName
 * @property {string} mode
 * @property {string[]} messages
 * @property {string} context - cli | commit | edit
 * @property {string} timestamp - ISO 8601
 *
 * @typedef {Object} GatesPassedPayload
 * @property {string|null} specId
 * @property {Object} summary - { blocked, warned, passed, skipped, waived }
 * @property {string} context
 * @property {string} timestamp
 *
 * @typedef {Object} ValidationFailedPayload
 * @property {string} specId
 * @property {Object[]} errors
 * @property {number} errorCount
 * @property {number} warningCount
 * @property {string} timestamp
 *
 * @typedef {Object} ValidationPassedPayload
 * @property {string} specId
 * @property {string} grade
 * @property {number} complianceScore
 * @property {string} timestamp
 *
 * @typedef {Object} BudgetPressurePayload
 * @property {string|null} specId
 * @property {number} filesUsed
 * @property {number} filesLimit
 * @property {number} locUsed
 * @property {number} locLimit
 * @property {number} percentUsed
 * @property {string} timestamp
 *
 * @typedef {Object} PhaseTransitionPayload
 * @property {string} specId
 * @property {string} oldPhase
 * @property {string} newPhase
 * @property {string} timestamp
 *
 * @typedef {Object} MergePrePayload
 * @property {string} worktreeName
 * @property {string} branch
 * @property {string} baseBranch
 * @property {string[]} conflicts
 * @property {string} timestamp
 *
 * @typedef {Object} MergePostPayload
 * @property {string} worktreeName
 * @property {string} branch
 * @property {string} baseBranch
 * @property {boolean} merged
 * @property {string[]} conflicts
 * @property {string} timestamp
 */
const EVENTS = {
  GATES_BLOCKED: 'gates:blocked',
  GATES_PASSED: 'gates:passed',
  VALIDATION_FAILED: 'validation:failed',
  VALIDATION_PASSED: 'validation:passed',
  BUDGET_PRESSURE: 'budget:pressure',
  PHASE_TRANSITION: 'phase:transition',
  MERGE_PRE: 'merge:pre',
  MERGE_POST: 'merge:post',
};

module.exports = { lifecycle, EVENTS };
