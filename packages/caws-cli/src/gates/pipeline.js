/**
 * @fileoverview Central gate evaluation pipeline
 * Auto-discovers gate modules and evaluates them against policy configuration.
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const { PolicyManager } = require('../policy/PolicyManager');
const WaiversManager = require('../waivers-manager');

/**
 * Auto-discover gate modules from the gates directory
 * Skips pipeline.js and format.js; requires each module to export `name` and `run`.
 * @returns {Object} Map of gate name to gate module
 */
function loadGates() {
  const gateDir = __dirname;
  const gates = {};
  for (const file of fs.readdirSync(gateDir)) {
    if (file === 'pipeline.js' || file === 'format.js' || !file.endsWith('.js')) continue;
    try {
      const gate = require(path.join(gateDir, file));
      if (gate.name && typeof gate.run === 'function') {
        gates[gate.name] = gate;
      }
    } catch { /* skip broken gate modules */ }
  }
  return gates;
}

/**
 * Evaluate all configured gates against staged files and spec
 * @param {Object} params - Evaluation parameters
 * @param {string} params.projectRoot - Project root directory
 * @param {string[]} params.stagedFiles - List of staged file paths
 * @param {Object} [params.spec] - Working spec object
 * @param {Object} [params.context] - Additional context
 * @returns {Promise<Object>} Evaluation report with gate results and summary
 */
async function evaluateGates({ projectRoot, stagedFiles, spec, context }) {
  const policyManager = new PolicyManager();
  const policy = await policyManager.loadPolicy(projectRoot);
  const riskTier = spec?.risk_tier || policy?.risk_tiers?.default || 2;
  const usingDefaults = !!policy?._isDefault;

  const availableGates = loadGates();
  const gateConfigs = policy?.gates || {};
  const results = [];
  const waiversManager = new WaiversManager({ projectRoot });

  for (const [gateName, config] of Object.entries(gateConfigs)) {
    if (!config.enabled) continue;

    const mode = config.mode || 'warn';
    if (mode === 'skip') {
      results.push({ name: gateName, mode, status: 'skipped', waived: false, messages: [], duration: 0 });
      continue;
    }

    // Check waivers
    let waived = false;
    let waiverId = null;
    try {
      const waiverResult = await waiversManager.getActiveWaiverForGate(gateName);
      if (waiverResult) {
        waived = true;
        waiverId = waiverResult.waiverId;
        results.push({ name: gateName, mode, status: 'pass', waived: true, waiverId, messages: [`Waived: ${waiverResult.reason}`], duration: 0 });
        continue;
      }
    } catch (err) {
      // Waiver check failed — log it so the failure is visible, then proceed without waiver
      results.push({
        name: gateName, mode, status: 'fail', waived: false,
        messages: [`Waiver check error (fail-closed): ${err.message}`], duration: 0,
      });
      continue;
    }

    const gate = availableGates[gateName];
    if (!gate) {
      // Fail-closed for block/warn mode: a gate referenced in policy but not found is a config error
      const status = mode === 'block' ? 'fail' : 'warn';
      results.push({
        name: gateName, mode, status, waived: false,
        messages: [`Gate "${gateName}" is configured in policy but not implemented. Check for typos in policy.yaml.`],
        duration: 0,
      });
      continue;
    }

    const start = Date.now();
    try {
      const result = await gate.run({ stagedFiles, spec, policy, projectRoot, riskTier, thresholds: config.thresholds, context });
      results.push({
        name: gateName,
        mode,
        status: result.status,
        waived,
        waiverId,
        messages: result.messages || [],
        duration: Date.now() - start,
      });
    } catch (err) {
      results.push({
        name: gateName,
        mode,
        status: 'fail',
        waived: false,
        messages: [`Gate error: ${err.message}`],
        duration: Date.now() - start,
      });
    }
  }

  const blocked = results.filter(r => r.mode === 'block' && r.status === 'fail' && !r.waived);
  const warned = results.filter(r => r.status === 'warn' || (r.mode === 'warn' && r.status === 'fail'));
  const passed = results.filter(r => r.status === 'pass');
  const skipped = results.filter(r => r.status === 'skipped');
  const waivedGates = results.filter(r => r.waived);

  const report = {
    passed: blocked.length === 0,
    gates: results,
    summary: {
      blocked: blocked.length,
      warned: warned.length,
      passed: passed.length,
      skipped: skipped.length,
      waived: waivedGates.length,
    },
  };

  if (usingDefaults) {
    report.warnings = report.warnings || [];
    report.warnings.push('No policy.yaml found — using built-in defaults. Create .caws/policy.yaml for project-specific gate configuration.');
  }

  return report;
}

module.exports = { evaluateGates, loadGates };
