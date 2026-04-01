/**
 * @fileoverview CAWS Sidecar Command
 * CLI interface for bounded governance sidecars — advisory analysis modules
 * that consume working state and produce structured recommendations.
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const { resolveSpec } = require('../utils/spec-resolver');
const { loadState } = require('../utils/working-state');
const { commandWrapper } = require('../utils/command-wrapper');
const { SIDECARS, formatSidecarText } = require('../sidecars');

/**
 * Run a sidecar analysis.
 * @param {string} subcommand - Sidecar name (drift, gaps, waiver-draft, provenance)
 * @param {Object} options - Command options
 * @param {string} [options.specId] - Target spec ID
 * @param {boolean} [options.json] - Output as JSON
 * @param {string} [options.gate] - Gate name filter (waiver-draft only)
 */
async function sidecarCommand(subcommand, options = {}) {
  return commandWrapper(
    async () => {
      const sidecar = SIDECARS[subcommand];
      if (!sidecar) {
        const available = Object.keys(SIDECARS).join(', ');
        console.error(chalk.red(`Unknown sidecar: ${subcommand}`));
        console.error(chalk.yellow(`Available: ${available}`));
        process.exit(1);
      }

      // Resolve spec
      let spec = null;
      try {
        const resolved = await resolveSpec({
          specId: options.specId,
          warnLegacy: false,
          quiet: Boolean(options.json),
        });
        spec = resolved.spec;
      } catch (err) {
        console.error(chalk.red(`Could not resolve spec: ${err.message}`));
        console.error(chalk.yellow('Use --spec-id <id> to target a specific spec.'));
        process.exit(1);
      }

      // Load working state (may be null — sidecars handle that)
      const state = loadState(spec.id);

      // Build sidecar-specific options
      const sidecarOptions = {};
      if (options.gate) sidecarOptions.gateName = options.gate;

      // Run sidecar
      const result = sidecar.fn(state, spec, sidecarOptions);

      // Output
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatSidecarText(result));
      }

      return result;
    },
    { commandName: `sidecar ${subcommand}` }
  );
}

module.exports = { sidecarCommand };
