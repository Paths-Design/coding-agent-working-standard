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

  try {
    const setup = cawsSetup || initializeGlobalSetup();
    if (setup?.hasTemplateDir && setup?.templateDir) {
      const { generateProvenance, saveProvenance } = require(
        path.join(setup.templateDir, 'apps/tools/caws/provenance.js')
      );
      provenanceTools = { generateProvenance, saveProvenance };
      console.log('✅ Loaded provenance tools from:', setup.templateDir);
    }
  } catch (error) {
    // Fallback for environments without template
    provenanceTools = null;
    console.warn('⚠️  Provenance tools not available:', error.message);
  }

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
