/**
 * @fileoverview CAWS Configuration Module
 * Global configuration and provenance tools management
 * @author @darianrosebrook
 */

const path = require('path');
const chalk = require('chalk');

// Import detection utilities
const { detectCAWSSetup } = require('../utils/detection');

// CLI version from package.json
const CLI_VERSION = require('../../package.json').version;

// Global state
let provenanceTools = null;
let cawsSetup = null;
let languageSupport = null;

/**
 * Initialize global setup detection
 * @returns {Object} Setup configuration
 */
function initializeGlobalSetup() {
  if (cawsSetup) return cawsSetup;

  try {
    cawsSetup = detectCAWSSetup();
  } catch (error) {
    console.warn(chalk.yellow('⚠️  Failed to detect CAWS setup:'), error.message);
    cawsSetup = {
      type: 'unknown',
      hasCAWSDir: false,
      cawsDir: null,
      capabilities: [],
      hasTemplateDir: false,
      templateDir: null,
    };
  }

  return cawsSetup;
}

/**
 * Load provenance tools dynamically
 * @returns {Object|null} Provenance tools or null if not available
 */
function loadProvenanceTools() {
  if (provenanceTools) return provenanceTools; // Already loaded

  // Try multiple possible locations for provenance tools
  const possiblePaths = [
    // 1. Bundled templates in CLI package (for global installs)
    path.join(__dirname, '../../templates/apps/tools/caws/provenance.js'),
    // 2. Local project templates
    path.join(process.cwd(), 'apps/tools/caws/provenance.js'),
    // 3. Template package in monorepo
    path.join(__dirname, '../../../caws-template/apps/tools/caws/provenance.js'),
    // 4. Detected setup template directory
    null, // Will be set from setup if available
  ];

  // Add detected template directory if available
  try {
    const setup = cawsSetup || initializeGlobalSetup();
    if (setup?.hasTemplateDir && setup?.templateDir) {
      possiblePaths[3] = path.join(setup.templateDir, 'apps/tools/caws/provenance.js');
    }
  } catch (setupError) {
    // Continue without detected setup
  }

  // Try each path until one works
  for (const testPath of possiblePaths) {
    if (!testPath) continue;

    try {
      const { generateProvenance, saveProvenance } = require(testPath);
      provenanceTools = { generateProvenance, saveProvenance };
      return provenanceTools;
    } catch (pathError) {
      // Continue to next path
    }
  }

  // If all paths fail, return null (don't warn during init - templates aren't ready yet)
  provenanceTools = null;
  return provenanceTools;
}

/**
 * Initialize language support tools
 * @returns {Object|null} Language support tools or null if not available
 */
function initializeLanguageSupport() {
  if (languageSupport) return languageSupport;

  try {
    // Try multiple possible locations for language support
    const possiblePaths = [
      path.join(__dirname, '../../../caws-template/apps/tools/caws/language-support.js'),
      path.join(__dirname, '../../../../caws-template/apps/tools/caws/language-support.js'),
      path.join(process.cwd(), 'packages/caws-template/apps/tools/caws/language-support.js'),
      path.join(process.cwd(), 'caws-template/apps/tools/caws/language-support.js'),
    ];

    for (const testPath of possiblePaths) {
      try {
        languageSupport = require(testPath);
        // Only log if not running version command
        if (!process.argv.includes('--version') && !process.argv.includes('-V')) {
          console.log(`✅ Loaded language support from: ${testPath}`);
        }
        break;
      } catch (pathError) {
        // Continue to next path
      }
    }
  } catch (error) {
    console.warn(chalk.yellow('⚠️  Language support tools not available'));
    console.warn(chalk.blue('💡 This may limit language-specific configuration features'));
    console.warn(
      chalk.blue('💡 For full functionality, ensure caws-template package is available')
    );
  }

  return languageSupport;
}

/**
 * Get global CAWS setup
 * @returns {Object} CAWS setup configuration
 */
function getGlobalCAWSSetup() {
  return cawsSetup || initializeGlobalSetup();
}

/**
 * Set global CAWS setup (for testing or override)
 * @param {Object} setup - Setup configuration
 */
function setGlobalCAWSSetup(setup) {
  cawsSetup = setup;
}

module.exports = {
  CLI_VERSION,
  initializeGlobalSetup,
  loadProvenanceTools,
  initializeLanguageSupport,
  getGlobalCAWSSetup,
  setGlobalCAWSSetup,
};
