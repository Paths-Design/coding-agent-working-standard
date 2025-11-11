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

/**
 * Detect if project publishes packages to registries
 * Checks for publishing configuration in package.json, pyproject.toml, etc.
 * @param {string} cwd - Current working directory
 * @returns {boolean} Whether project appears to publish packages
 */
function detectsPublishing(cwd = process.cwd()) {
  const files = fs.readdirSync(cwd);

  // Check package.json for npm publishing
  if (files.includes('package.json')) {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')
      );

      // Indicators of publishing:
      // - Has publishConfig
      // - Has scripts that include "publish"
      // - Has name that suggests it's a published package
      // - Has repository field (often indicates published package)
      const hasPublishConfig = packageJson.publishConfig;
      const hasPublishScript =
        packageJson.scripts &&
        Object.keys(packageJson.scripts).some((key) =>
          key.toLowerCase().includes('publish')
        );
      const hasScopedName = packageJson.name && packageJson.name.startsWith('@');
      const hasRepository = packageJson.repository;

      if (hasPublishConfig || hasPublishScript || (hasScopedName && hasRepository)) {
        return true;
      }
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Check pyproject.toml for PyPI publishing
  if (files.includes('pyproject.toml')) {
    try {
      const pyprojectContent = fs.readFileSync(
        path.join(cwd, 'pyproject.toml'),
        'utf8'
      );

      // Check for build system and project metadata (indicates publishable package)
      const hasBuildSystem = pyprojectContent.includes('[build-system]');
      const hasProjectMetadata = pyprojectContent.includes('[project]');
      const hasToolPublish = pyprojectContent.includes('[tool.publish]') ||
                            pyprojectContent.includes('[tool.twine]');

      if ((hasBuildSystem && hasProjectMetadata) || hasToolPublish) {
        return true;
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  // Check for Maven publishing (pom.xml)
  if (files.includes('pom.xml')) {
    return true; // Maven projects typically publish
  }

  // Check for .csproj (NuGet publishing)
  const csprojFiles = files.filter((f) => f.endsWith('.csproj'));
  if (csprojFiles.length > 0) {
    return true; // .NET projects typically publish
  }

  // Check for GitHub Actions workflows that publish
  const workflowsPath = path.join(cwd, '.github', 'workflows');
  if (fs.existsSync(workflowsPath)) {
    try {
      const workflowFiles = fs.readdirSync(workflowsPath);
      for (const workflowFile of workflowFiles) {
        if (workflowFile.endsWith('.yml') || workflowFile.endsWith('.yaml')) {
          const workflowContent = fs.readFileSync(
            path.join(workflowsPath, workflowFile),
            'utf8'
          );
          // Check for common publishing actions/commands
          if (
            workflowContent.includes('npm publish') ||
            workflowContent.includes('pypa/gh-action-pypi-publish') ||
            workflowContent.includes('publish-to-npm') ||
            workflowContent.includes('semantic-release') ||
            workflowContent.includes('publish')
          ) {
            return true;
          }
        }
      }
    } catch (e) {
      // Ignore read errors
    }
  }

  return false;
}

module.exports = {
  detectProjectType,
  shouldInitInCurrentDirectory,
  detectsPublishing,
};
