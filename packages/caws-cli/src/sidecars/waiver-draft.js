/**
 * @fileoverview Waiver Drafting Assistance Sidecar
 * Generates pre-filled waiver templates from gate failure context.
 * Reduces boilerplate for the human reviewer.
 * @author @darianrosebrook
 */

const yaml = require('js-yaml');
const { getRecurrence, GATE_CATEGORIES } = require('../gates/feedback');
const { createSidecarOutput, createNoStateOutput } = require('./schema');

// ---------------------------------------------------------------------------
// Category → reason mapping
// ---------------------------------------------------------------------------

const CATEGORY_REASON_MAP = {
  scope: 'third_party_constraint',
  policy: 'infrastructure_limitation',
  quality: 'experimental_feature',
  architectural: 'legacy_integration',
};

// ---------------------------------------------------------------------------
// Impact level from recurrence count
// ---------------------------------------------------------------------------

function impactFromRecurrence(count) {
  if (count <= 1) return 'low';
  if (count <= 3) return 'medium';
  return 'high';
}

// ---------------------------------------------------------------------------
// Template generation
// ---------------------------------------------------------------------------

/**
 * Pad a description to meet the 50-char minimum.
 * @param {string} desc
 * @returns {string}
 */
function padDescription(desc) {
  if (desc.length >= 50) return desc;
  return desc + ' '.repeat(1) + 'This waiver allows temporary bypass while the issue is addressed.';
}

/**
 * Clamp a string to max length.
 * @param {string} str
 * @param {number} max
 * @returns {string}
 */
function clamp(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max - 3) + '...';
}

/**
 * Build a waiver template for one failing gate.
 * @param {object} gate - Gate result object
 * @param {object} spec - Spec object
 * @param {object} state - Working state (for recurrence)
 * @returns {object} Draft object with gate, category, recurrence, template, yaml
 */
function buildDraft(gate, spec, state) {
  const gateName = gate.name;
  const category = GATE_CATEGORIES[gateName] || 'quality';
  const reason = CATEGORY_REASON_MAP[category] || 'other';

  const recurrenceInfo = getRecurrence(gateName, state);
  const recurrenceCount = recurrenceInfo ? recurrenceInfo.count : 0;
  const impact = impactFromRecurrence(recurrenceCount);

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Build description from gate messages
  const specTitle = spec?.title || spec?.id || 'unknown';
  let rawTitle = `Waive ${gateName} for ${specTitle}`;
  // Clamp title to 10-200 chars, pad if too short
  if (rawTitle.length < 10) {
    rawTitle = rawTitle + ' — temporary bypass';
  }
  const title = clamp(rawTitle, 200);

  // Build description from messages
  const messageText = gate.messages && gate.messages.length > 0
    ? gate.messages.join('. ')
    : `Gate ${gateName} is failing`;
  let description = `Gate ${gateName} is blocking: ${messageText}. This waiver allows temporary bypass while ${gateName} is addressed.`;
  description = padDescription(description);
  description = clamp(description, 1000);

  const template = {
    id: 'WV-XXXX',
    title,
    reason,
    description,
    gates: [gateName],
    risk_assessment: {
      impact_level: impact,
      mitigation_plan: '[REQUIRED: Describe how you will address the underlying issue within the waiver period]',
      review_required: impact === 'high' || impact === 'critical',
    },
    expires_at: expiresAt.toISOString(),
    approved_by: '[REQUIRED]',
    created_at: now.toISOString(),
    metadata: { environment: 'development' },
  };

  const yamlStr = yaml.dump(template, { lineWidth: 120, noRefs: true });

  return {
    gate: gateName,
    category,
    recurrence: recurrenceCount,
    template,
    yaml: yamlStr,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Generate waiver draft templates from gate failures.
 * @param {object|null} state - Working state
 * @param {object} [spec] - Spec object
 * @param {object} [options={}] - Options
 * @param {string} [options.gateName] - Filter to a specific gate
 * @returns {object} Sidecar envelope
 */
function draftWaiver(state, spec, options = {}) {
  const specId = spec?.id || 'unknown';

  if (!state) {
    return createNoStateOutput('waiver-draft', specId);
  }

  if (!state.gates || !state.gates.results) {
    return createSidecarOutput('waiver-draft', specId, {
      drafts: [],
      instructions: '',
      summary: 'No gate results available',
    });
  }

  // Find failing gates
  let failingGates = state.gates.results.filter(g => g.status === 'fail');

  if (options.gateName) {
    failingGates = failingGates.filter(g => g.name === options.gateName);
  }

  if (failingGates.length === 0) {
    return createSidecarOutput('waiver-draft', specId, {
      drafts: [],
      instructions: '',
      summary: 'No failing gates found',
    });
  }

  const drafts = failingGates.map(gate => buildDraft(gate, spec, state));

  const gateNames = drafts.map(d => d.gate).join(', ');
  const summary = `${drafts.length} waiver draft${drafts.length !== 1 ? 's' : ''} generated for ${gateNames}`;

  return createSidecarOutput('waiver-draft', specId, {
    drafts,
    instructions: 'Review and fill [REQUIRED] fields, then run: caws waivers create --file <path>',
    summary,
  });
}

module.exports = { draftWaiver };
