/**
 * CAWS Quality Gates Command (Legacy Alias)
 *
 * Forwards to the unified gates command (src/commands/gates.js)
 * which uses the v2 pipeline (src/gates/pipeline.js).
 *
 * @author @darianrosebrook
 */

const { gatesCommand } = require('./gates');

/**
 * Legacy quality-gates command — delegates to gates command
 * @param {Object} options - Command options
 */
async function qualityGatesCommand(options = {}) {
  return gatesCommand({
    ...options,
    context: options.context || 'cli',
  });
}

module.exports = {
  qualityGatesCommand,
};
