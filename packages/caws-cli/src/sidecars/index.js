/**
 * @fileoverview Sidecar Registry
 * Central registry of all bounded governance sidecars.
 * @author @darianrosebrook
 */

const { analyzeSpecDrift } = require('./spec-drift');
const { diagnoseQualityGaps } = require('./quality-gaps');
const { draftWaiver } = require('./waiver-draft');
const { summarizeProvenance } = require('./provenance-summary');
const { createSidecarOutput, createNoStateOutput, formatSidecarText } = require('./schema');

/**
 * Registry of available sidecars.
 * Each entry has a function and a short description for help text.
 */
const SIDECARS = {
  drift: { fn: analyzeSpecDrift, description: 'Analyze spec drift vs implementation evidence' },
  gaps: { fn: diagnoseQualityGaps, description: 'Diagnose quality gaps preventing phase advancement' },
  'waiver-draft': { fn: draftWaiver, description: 'Generate pre-filled waiver templates from gate failures' },
  provenance: { fn: summarizeProvenance, description: 'Summarize work provenance for merge readiness' },
};

module.exports = {
  SIDECARS,
  analyzeSpecDrift,
  diagnoseQualityGaps,
  draftWaiver,
  summarizeProvenance,
  createSidecarOutput,
  createNoStateOutput,
  formatSidecarText,
};
