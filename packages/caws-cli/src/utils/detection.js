/**
 * @fileoverview CAWS Setup Detection Utilities
 * Functions for detecting and analyzing CAWS project setups
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Detect CAWS setup in a directory
 * @param {string} cwd - Current working directory
 * @returns {Object} Setup information
 */
function detectCAWSSetup(cwd = process.cwd()) {
  // Skip logging for version/help commands
  const isQuietCommand =
    process.argv.includes('--version') ||
    process.argv.includes('-V') ||
    process.argv.includes('--help');

  if (!isQuietCommand) {
    console.log(chalk.blue('🔍 Detecting CAWS setup...'));
  }

  // Check for existing CAWS setup
  const cawsDir = path.join(cwd, '.caws');
  const hasCAWSDir = fs.existsSync(cawsDir);

  if (!hasCAWSDir) {
    if (!isQuietCommand) {
      console.log(chalk.gray('ℹ️  No .caws directory found - new project setup'));
    }
    return {
      type: 'new',
      hasCAWSDir: false,
      cawsDir: null,
      capabilities: [],
      hasTemplateDir: false,
      templateDir: null,
    };
  }

  // Analyze existing setup
  const files = fs.readdirSync(cawsDir);
  const hasWorkingSpec = fs.existsSync(path.join(cawsDir, 'working-spec.yaml'));
  const hasValidateScript = fs.existsSync(path.join(cawsDir, 'validate.js'));
  const hasPolicy = fs.existsSync(path.join(cawsDir, 'policy'));
  const hasSchemas = fs.existsSync(path.join(cawsDir, 'schemas'));
  const hasTemplates = fs.existsSync(path.join(cawsDir, 'templates'));

  // Check for multiple spec files (enhanced project pattern)
  const specFiles = files.filter((f) => f.endsWith('-spec.yaml'));
  const hasMultipleSpecs = specFiles.length > 1;

  // Check for tools directory (enhanced setup)
  const toolsDir = path.join(cwd, 'apps/tools/caws');
  const hasTools = fs.existsSync(toolsDir);

  // Determine setup type
  let setupType = 'basic';
  let capabilities = [];

  if (hasMultipleSpecs && hasWorkingSpec) {
    setupType = 'enhanced';
    capabilities.push('multiple-specs', 'working-spec', 'domain-specific');
  } else if (hasWorkingSpec) {
    setupType = 'standard';
    capabilities.push('working-spec');
  }

  if (hasValidateScript) {
    capabilities.push('validation');
  }
  if (hasPolicy) {
    capabilities.push('policies');
  }
  if (hasSchemas) {
    capabilities.push('schemas');
  }
  if (hasTemplates) {
    capabilities.push('templates');
  }
  if (hasTools) {
    capabilities.push('tools');
  }

  if (!isQuietCommand) {
    console.log(chalk.green(`✅ Detected ${setupType} CAWS setup`));
    console.log(chalk.gray(`   Capabilities: ${capabilities.join(', ')}`));
  }

  // Check for template directory - try multiple possible locations
  let templateDir = null;
  const possibleTemplatePaths = [
    // FIRST: Try bundled templates (for npm-installed CLI)
    { path: path.resolve(__dirname, '../templates'), source: 'bundled with CLI' },
    { path: path.resolve(__dirname, 'templates'), source: 'bundled with CLI (fallback)' },
    // Try relative to current working directory (for monorepo setups)
    { path: path.resolve(cwd, '../caws-template'), source: 'monorepo parent directory' },
    { path: path.resolve(cwd, '../../caws-template'), source: 'monorepo grandparent' },
    { path: path.resolve(cwd, '../../../caws-template'), source: 'workspace root' },
    { path: path.resolve(cwd, 'packages/caws-template'), source: 'packages/ subdirectory' },
    { path: path.resolve(cwd, 'caws-template'), source: 'caws-template/ subdirectory' },
    // Try relative to CLI location (for installed CLI)
    { path: path.resolve(__dirname, '../caws-template'), source: 'CLI installation' },
    { path: path.resolve(__dirname, '../../caws-template'), source: 'CLI parent directory' },
    { path: path.resolve(__dirname, '../../../caws-template'), source: 'CLI workspace root' },
    // Try absolute paths for CI environments
    { path: path.resolve(process.cwd(), 'packages/caws-template'), source: 'current packages/' },
    { path: path.resolve(process.cwd(), '../packages/caws-template'), source: 'parent packages/' },
    {
      path: path.resolve(process.cwd(), '../../packages/caws-template'),
      source: 'grandparent packages/',
    },
    {
      path: path.resolve(process.cwd(), '../../../packages/caws-template'),
      source: 'workspace packages/',
    },
    // Try from workspace root
    { path: path.resolve(process.cwd(), 'caws-template'), source: 'workspace caws-template/' },
    // Try various other common locations
    {
      path: '/home/runner/work/coding-agent-working-standard/coding-agent-working-standard/packages/caws-template',
      source: 'GitHub Actions CI',
    },
    { path: '/workspace/packages/caws-template', source: 'Docker workspace' },
    { path: '/caws/packages/caws-template', source: 'Container workspace' },
  ];

  for (const { path: testPath, source } of possibleTemplatePaths) {
    if (fs.existsSync(testPath)) {
      templateDir = testPath;
      if (!isQuietCommand) {
        console.log(`✅ Found CAWS templates in ${source}:`);
        console.log(`   ${chalk.gray(testPath)}`);
      }
      break;
    }
  }

  if (!templateDir && !isQuietCommand) {
    console.warn(chalk.yellow('⚠️  CAWS templates not found in standard locations'));
    console.warn(chalk.blue('💡 This may limit available scaffolding features'));
    console.warn(
      chalk.blue('💡 For full functionality, ensure caws-template package is available')
    );
  }

  const hasTemplateDir = templateDir !== null;

  return {
    type: setupType,
    hasCAWSDir: true,
    cawsDir,
    hasWorkingSpec,
    hasMultipleSpecs,
    hasValidateScript,
    hasPolicy,
    hasSchemas,
    hasTemplates,
    hasTools,
    hasTemplateDir,
    templateDir,
    capabilities,
    isEnhanced: setupType === 'enhanced',
    isAdvanced: hasTools || hasValidateScript,
  };
}

module.exports = {
  detectCAWSSetup,
};
