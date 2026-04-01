/**
 * @fileoverview Sidecar Lifecycle Listeners
 * Registers lightweight event handlers that print hints to run sidecars
 * at governance-significant moments. Non-blocking, non-fatal.
 * @author @darianrosebrook
 */

const { lifecycle, EVENTS } = require('../utils/lifecycle-events');

/**
 * Register sidecar hint listeners on the lifecycle emitter.
 * Call once during CLI startup.
 */
function registerSidecarListeners() {
  // On gate blocked → suggest waiver draft
  lifecycle.on(EVENTS.GATES_BLOCKED, (payload) => {
    try {
      if (process.env.CAWS_QUIET === '1') return;
      const specFlag = payload.specId ? ` --spec-id ${payload.specId}` : '';
      const gateFlag = payload.gateName ? ` --gate ${payload.gateName}` : '';
      console.log(
        `\n  [Sidecar] Waiver draft available: caws sidecar waiver-draft${specFlag}${gateFlag}`
      );
    } catch { /* non-fatal */ }
  });

  // On phase transition (non-complete) → suggest quality gap analysis
  lifecycle.on(EVENTS.PHASE_TRANSITION, (payload) => {
    try {
      if (process.env.CAWS_QUIET === '1') return;
      if (payload.newPhase === 'complete') return;
      const specFlag = payload.specId ? ` --spec-id ${payload.specId}` : '';
      console.log(
        `\n  [Sidecar] Phase changed to ${payload.newPhase}. Run: caws sidecar gaps${specFlag}`
      );
    } catch { /* non-fatal */ }
  });
}

module.exports = { registerSidecarListeners };
