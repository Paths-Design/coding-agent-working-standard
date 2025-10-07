/**
 * @fileoverview Project Analysis Utilities
 * Functions for analyzing project types and structure
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');

/**
 * Detect project type from existing files and structure
 * @param {string} cwd - Current working directory
 * @returns {string} Project type
 */
function detectProjectType(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);

  // Check for various project indicators
  const hasPackageJson = files.includes('package.json');
  const hasPnpm = files.includes('pnpm-workspace.yaml');
  const hasYarn = files.includes('yarn.lock');

  let packageJson = {};
  if (hasPackageJson) {
    try {
      packageJson = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    } catch (e) {
      // Ignore parse errors
    }
  }

  // VS Code Extension detection
  const isVscodeExtension =
    packageJson.engines?.vscode ||
    packageJson.contributes ||
    packageJson.activationEvents ||
    packageJson.main?.includes('extension.js');

  // Monorepo detection
  const isMonorepo = hasPnpm || hasYarn || files.includes('packages') || files.includes('apps');

  // Library detection
  const isLibrary = packageJson.main || packageJson.module || packageJson.exports;

  // CLI detection
  const isCli = packageJson.bin || packageJson.name?.startsWith('@') === false;

  // API detection
  const isApi =
    packageJson.scripts?.start ||
    packageJson.dependencies?.express ||
    packageJson.dependencies?.fastify ||
    packageJson.dependencies?.['@types/express'];

  // Determine primary type
  if (isVscodeExtension) return 'extension';
  if (isMonorepo) return 'monorepo';
  if (isApi) return 'api';
  if (isLibrary) return 'library';
  if (isCli) return 'cli';

  // Default fallback
  return 'application';
}

/**
 * Detect if current directory appears to be a project that should be initialized directly
 * @param {string} projectName - Project name from command line
 * @param {string} currentDir - Current directory path
 * @returns {boolean} Whether to init in current directory
 */
function shouldInitInCurrentDirectory(projectName, currentDir) {
  // If explicitly '.', always init in current directory
  if (projectName === '.') return true;

  // Check for common project indicators
  const projectIndicators = [
    'package.json',
    'tsconfig.json',
    'jest.config.js',
    'eslint.config.js',
    'README.md',
    'src/',
    'lib/',
    'app/',
    'packages/',
    '.git/',
    'node_modules/', // Even if empty, suggests intent to be a project
  ];

  const files = fs.readdirSync(currentDir);
  const hasProjectIndicators = projectIndicators.some((indicator) => {
    if (indicator.endsWith('/')) {
      return files.includes(indicator.slice(0, -1));
    }
    return files.includes(indicator);
  });

  return hasProjectIndicators;
}

module.exports = {
  detectProjectType,
  shouldInitInCurrentDirectory,
};
