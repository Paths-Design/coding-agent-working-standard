/**
 * @fileoverview CAWS Complexity Modes Configuration
 * Defines different tiers of CAWS complexity for different project needs
 * @author @darianrosebrook
 */

const chalk = require('chalk');

/**
 * CAWS Complexity Tiers
 */
const COMPLEXITY_TIERS = {
  simple: {
    name: 'Simple',
    description: 'Minimal CAWS for small projects and quick prototyping',
    color: chalk.green,
    icon: '🟢',
    features: {
      workingSpec: true,
      basicValidation: true,
      statusDisplay: true,
      noQualityGates: true,
      noProvenance: true,
      noWaivers: true,
      noChangeBudgets: true,
      noMultiSpec: false, // Can use multi-spec but simplified
    },
    qualityRequirements: {
      testCoverage: 70,
      mutationScore: 30,
      contracts: 'optional',
    },
    riskTiers: ['T3'], // Only T3 supported
    commands: {
      init: true,
      validate: true,
      status: true,
      specs: true, // Basic specs support
      // No: diagnose, evaluate, iterate, provenance, waivers, hooks, archive
    },
  },

  standard: {
    name: 'Standard',
    description: 'Balanced CAWS with change management and quality gates',
    color: chalk.yellow,
    icon: '🟡',
    features: {
      workingSpec: true,
      fullValidation: true,
      statusDisplay: true,
      qualityGates: true,
      provenance: true,
      waivers: true,
      changeBudgets: true,
      multiSpec: true,
      changeFolders: true,
    },
    qualityRequirements: {
      testCoverage: 80,
      mutationScore: 50,
      contracts: 'required',
    },
    riskTiers: ['T1', 'T2', 'T3'],
    commands: {
      init: true,
      validate: true,
      status: true,
      specs: true,
      diagnose: true,
      evaluate: true,
      iterate: true,
      provenance: true,
      waivers: true,
      hooks: true,
      archive: true,
    },
  },

  enterprise: {
    name: 'Enterprise',
    description: 'Full CAWS with comprehensive audit trails and compliance',
    color: chalk.red,
    icon: '🔴',
    features: {
      workingSpec: true,
      fullValidation: true,
      statusDisplay: true,
      qualityGates: true,
      provenance: true,
      waivers: true,
      changeBudgets: true,
      multiSpec: true,
      changeFolders: true,
      auditTrails: true,
      compliance: true,
      advancedMonitoring: true,
    },
    qualityRequirements: {
      testCoverage: 90,
      mutationScore: 70,
      contracts: 'required',
    },
    riskTiers: ['T1', 'T2', 'T3'],
    commands: {
      init: true,
      validate: true,
      status: true,
      specs: true,
      diagnose: true,
      evaluate: true,
      iterate: true,
      provenance: true,
      waivers: true,
      hooks: true,
      archive: true,
      troubleshoot: true,
      testAnalysis: true,
      qualityMonitor: true,
    },
  },
};

/**
 * Get tier information
 * @param {string} tier - Tier name
 * @returns {Object} Tier configuration
 */
function getTier(tier) {
  return COMPLEXITY_TIERS[tier] || COMPLEXITY_TIERS.standard;
}

/**
 * Get available tiers
 * @returns {string[]} Array of tier names
 */
function getAvailableTiers() {
  return Object.keys(COMPLEXITY_TIERS);
}

/**
 * Check if a command is available in the current tier
 * @param {string} command - Command name
 * @param {string} tier - Tier name
 * @returns {boolean} Whether command is available
 */
function isCommandAvailable(command, tier = 'standard') {
  const tierConfig = getTier(tier);
  return tierConfig.commands[command] === true;
}

/**
 * Check if a feature is enabled in the current tier
 * @param {string} feature - Feature name
 * @param {string} tier - Tier name
 * @returns {boolean} Whether feature is enabled
 */
function isFeatureEnabled(feature, tier = 'standard') {
  const tierConfig = getTier(tier);
  return tierConfig.features[feature] === true;
}

/**
 * Get quality requirements for a tier
 * @param {string} tier - Tier name
 * @returns {Object} Quality requirements
 */
function getQualityRequirements(tier = 'standard') {
  const tierConfig = getTier(tier);
  return tierConfig.qualityRequirements;
}

/**
 * Get supported risk tiers for a complexity tier
 * @param {string} tier - Tier name
 * @returns {string[]} Supported risk tiers
 */
function getSupportedRiskTiers(tier = 'standard') {
  const tierConfig = getTier(tier);
  return tierConfig.riskTiers;
}

/**
 * Validate if a risk tier is supported in the current complexity tier
 * @param {string} riskTier - Risk tier to validate
 * @param {string} complexityTier - Complexity tier
 * @returns {boolean} Whether risk tier is supported
 */
function isRiskTierSupported(riskTier, complexityTier = 'standard') {
  const supportedTiers = getSupportedRiskTiers(complexityTier);
  return supportedTiers.includes(riskTier);
}

/**
 * Display tier comparison
 */
function displayTierComparison() {
  console.log(chalk.bold.cyan('\n📊 CAWS Complexity Tiers'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Header
  console.log(
    chalk.bold(
      'Tier'.padEnd(12) +
        'Features'.padEnd(15) +
        'Coverage'.padEnd(10) +
        'Commands'.padEnd(12) +
        'Use Case'
    )
  );
  console.log(chalk.gray('─'.repeat(90)));

  Object.entries(COMPLEXITY_TIERS).forEach(([tierName, tier]) => {
    const tierColor = tier.color;
    const icon = tier.icon;

    const features = Object.entries(tier.features)
      .filter(([, enabled]) => enabled)
      .map(([feature]) => feature.replace(/([A-Z])/g, ' $1').toLowerCase())
      .slice(0, 3)
      .join(', ');

    const commands = Object.keys(tier.commands).filter((cmd) => tier.commands[cmd]).length;

    console.log(
      `${icon} ${tierColor(tierName.padEnd(10))} ${features.padEnd(13)} ${tier.qualityRequirements.testCoverage}%${' '.padEnd(8)}${commands}${' '.padEnd(10)}${tier.description}`
    );
  });

  console.log('');
}

/**
 * Get current mode from configuration
 * @returns {Promise<string>} Current mode
 */
async function getCurrentMode() {
  const fs = require('fs-extra');
  const MODE_CONFIG = '.caws/mode.json';

  try {
    if (!(await fs.pathExists(MODE_CONFIG))) {
      return 'standard'; // Default to standard mode
    }

    const config = JSON.parse(await fs.readFile(MODE_CONFIG, 'utf8'));
    return config.current || 'standard';
  } catch (error) {
    return 'standard'; // Default to standard mode on error
  }
}

/**
 * Set current mode in configuration
 * @param {string} mode - Mode to set
 * @returns {Promise<boolean>} Success status
 */
async function setCurrentMode(mode) {
  const fs = require('fs-extra');
  const path = require('path');
  const MODE_CONFIG = '.caws/mode.json';

  if (!getAvailableTiers().includes(mode)) {
    return false;
  }

  try {
    await fs.ensureDir(path.dirname(MODE_CONFIG));
    const config = {
      current: mode,
      initialized: true,
      lastChanged: new Date().toISOString(),
    };
    await fs.writeFile(MODE_CONFIG, JSON.stringify(config, null, 2));
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get tier recommendation based on project characteristics
 * @param {Object} projectInfo - Project information
 * @returns {string} Recommended tier
 */
function getTierRecommendation(projectInfo = {}) {
  const { size = 'medium', teamSize = 1, compliance = false, auditRequired = false } = projectInfo;

  // Enterprise tier for compliance/audit requirements
  if (compliance || auditRequired) {
    return 'enterprise';
  }

  // Enterprise for large teams or projects
  if (teamSize > 5 || size === 'large') {
    return 'enterprise';
  }

  // Standard for medium teams/projects
  if (teamSize > 1 || size === 'medium') {
    return 'standard';
  }

  // Simple for solo/small projects
  return 'simple';
}

module.exports = {
  COMPLEXITY_TIERS,
  getTier,
  getAvailableTiers,
  getCurrentMode,
  setCurrentMode,
  isCommandAvailable,
  isFeatureEnabled,
  getQualityRequirements,
  getSupportedRiskTiers,
  isRiskTierSupported,
  displayTierComparison,
  getTierRecommendation,
};
