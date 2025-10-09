/**
 * @fileoverview TypeScript Project Detection and Configuration
 * Auto-detects TypeScript projects and configures testing frameworks
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Detect if project is using TypeScript
 * @param {string} projectDir - Project directory path
 * @returns {Object} TypeScript detection result
 */
function detectTypeScript(projectDir = process.cwd()) {
  const tsconfigPath = path.join(projectDir, 'tsconfig.json');
  const packageJsonPath = path.join(projectDir, 'package.json');

  const hasTsConfig = fs.existsSync(tsconfigPath);

  let hasTypeScriptDep = false;
  let packageJson = null;

  if (fs.existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const allDeps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      hasTypeScriptDep = 'typescript' in allDeps;
    } catch (error) {
      // Ignore parse errors
    }
  }

  const isTypeScript = hasTsConfig || hasTypeScriptDep;

  return {
    isTypeScript,
    hasTsConfig,
    hasTypeScriptDep,
    packageJson,
    tsconfigPath: hasTsConfig ? tsconfigPath : null,
  };
}

/**
 * Detect testing framework in use
 * @param {string} projectDir - Project directory path
 * @param {Object} packageJson - Parsed package.json (optional)
 * @returns {Object} Testing framework detection result
 */
function detectTestFramework(projectDir = process.cwd(), packageJson = null) {
  if (!packageJson) {
    const packageJsonPath = path.join(projectDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    }
  }

  const hasJestConfig =
    fs.existsSync(path.join(projectDir, 'jest.config.js')) ||
    fs.existsSync(path.join(projectDir, 'jest.config.ts')) ||
    fs.existsSync(path.join(projectDir, 'jest.config.json')) ||
    packageJson?.jest;

  const hasVitestConfig =
    fs.existsSync(path.join(projectDir, 'vitest.config.js')) ||
    fs.existsSync(path.join(projectDir, 'vitest.config.ts'));

  const allDeps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };

  const hasJestDep = 'jest' in allDeps || '@types/jest' in allDeps;
  const hasVitestDep = 'vitest' in allDeps;
  const hasTsJest = 'ts-jest' in allDeps;

  let framework = 'none';
  let isConfigured = false;

  if (hasJestConfig || hasJestDep) {
    framework = 'jest';
    isConfigured = hasJestConfig;
  } else if (hasVitestConfig || hasVitestDep) {
    framework = 'vitest';
    isConfigured = hasVitestConfig;
  }

  return {
    framework,
    isConfigured,
    hasJest: hasJestDep,
    hasVitest: hasVitestDep,
    hasTsJest,
    needsTypeScriptConfig: false, // Will be set by checkTypeScriptTestConfig
  };
}

/**
 * Get workspace directories from package.json
 * @param {string} projectDir - Project directory path
 * @returns {string[]} Array of workspace directories
 */
/**
 * Get workspace directories from npm/yarn package.json workspaces
 * @param {string} projectDir - Project directory path
 * @returns {string[]} Array of workspace directories
 */
function getNpmWorkspaces(projectDir) {
  const packageJsonPath = path.join(projectDir, 'package.json');

  if (!fs.existsSync(packageJsonPath)) {
    return [];
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const workspaces = packageJson.workspaces || [];

    // Convert glob patterns to actual directories (simple implementation)
    const workspaceDirs = [];
    for (const ws of workspaces) {
      // Handle simple patterns like "packages/*" or "iterations/*"
      if (ws.includes('*')) {
        const baseDir = ws.split('*')[0];
        const fullBaseDir = path.join(projectDir, baseDir);

        if (fs.existsSync(fullBaseDir)) {
          const entries = fs.readdirSync(fullBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const wsPath = path.join(fullBaseDir, entry.name);
              if (fs.existsSync(path.join(wsPath, 'package.json'))) {
                workspaceDirs.push(wsPath);
              }
            }
          }
        }
      } else {
        // Direct path
        const wsPath = path.join(projectDir, ws);
        if (fs.existsSync(path.join(wsPath, 'package.json'))) {
          workspaceDirs.push(wsPath);
        }
      }
    }

    return workspaceDirs;
  } catch (error) {
    return [];
  }
}

/**
 * Get workspace directories from pnpm-workspace.yaml
 * @param {string} projectDir - Project directory path
 * @returns {string[]} Array of workspace directories
 */
function getPnpmWorkspaces(projectDir) {
  const pnpmFile = path.join(projectDir, 'pnpm-workspace.yaml');

  if (!fs.existsSync(pnpmFile)) {
    return [];
  }

  try {
    const yaml = require('js-yaml');
    const config = yaml.load(fs.readFileSync(pnpmFile, 'utf8'));
    const workspacePatterns = config.packages || [];

    // Convert glob patterns to actual directories
    const workspaceDirs = [];
    for (const pattern of workspacePatterns) {
      if (pattern.includes('*')) {
        const baseDir = pattern.split('*')[0];
        const fullBaseDir = path.join(projectDir, baseDir);

        if (fs.existsSync(fullBaseDir)) {
          const entries = fs.readdirSync(fullBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const wsPath = path.join(fullBaseDir, entry.name);
              if (fs.existsSync(path.join(wsPath, 'package.json'))) {
                workspaceDirs.push(wsPath);
              }
            }
          }
        }
      } else {
        // Direct path
        const wsPath = path.join(projectDir, pattern);
        if (fs.existsSync(path.join(wsPath, 'package.json'))) {
          workspaceDirs.push(wsPath);
        }
      }
    }

    return workspaceDirs;
  } catch (error) {
    return [];
  }
}

/**
 * Get workspace directories from lerna.json
 * @param {string} projectDir - Project directory path
 * @returns {string[]} Array of workspace directories
 */
function getLernaWorkspaces(projectDir) {
  const lernaFile = path.join(projectDir, 'lerna.json');

  if (!fs.existsSync(lernaFile)) {
    return [];
  }

  try {
    const config = JSON.parse(fs.readFileSync(lernaFile, 'utf8'));
    const workspacePatterns = config.packages || ['packages/*'];

    // Convert glob patterns to actual directories
    const workspaceDirs = [];
    for (const pattern of workspacePatterns) {
      if (pattern.includes('*')) {
        const baseDir = pattern.split('*')[0];
        const fullBaseDir = path.join(projectDir, baseDir);

        if (fs.existsSync(fullBaseDir)) {
          const entries = fs.readdirSync(fullBaseDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const wsPath = path.join(fullBaseDir, entry.name);
              if (fs.existsSync(path.join(wsPath, 'package.json'))) {
                workspaceDirs.push(wsPath);
              }
            }
          }
        }
      } else {
        // Direct path
        const wsPath = path.join(projectDir, pattern);
        if (fs.existsSync(path.join(wsPath, 'package.json'))) {
          workspaceDirs.push(wsPath);
        }
      }
    }

    return workspaceDirs;
  } catch (error) {
    return [];
  }
}

/**
 * Check if a dependency exists in hoisted node_modules
 * @param {string} depName - Dependency name to check
 * @param {string} projectDir - Project directory path
 * @returns {boolean} True if dependency found in hoisted node_modules
 */
function checkHoistedDependency(depName, projectDir) {
  const hoistedPath = path.join(projectDir, 'node_modules', depName, 'package.json');
  return fs.existsSync(hoistedPath);
}

function getWorkspaceDirectories(projectDir = process.cwd()) {
  const workspaceDirs = [
    ...getNpmWorkspaces(projectDir),
    ...getPnpmWorkspaces(projectDir),
    ...getLernaWorkspaces(projectDir),
  ];

  // Remove duplicates
  return [...new Set(workspaceDirs)];
}

/**
 * Check if TypeScript project needs test configuration
 * @param {string} projectDir - Project directory path
 * @returns {Object} Configuration status
 */
function checkTypeScriptTestConfig(projectDir = process.cwd()) {
  // First check root directory
  const rootTsDetection = detectTypeScript(projectDir);
  const rootTestDetection = detectTestFramework(projectDir, rootTsDetection.packageJson);

  // Get workspace directories and check them too
  const workspaceDirs = getWorkspaceDirectories(projectDir);
  const workspaceResults = [];

  for (const wsDir of workspaceDirs) {
    const wsTsDetection = detectTypeScript(wsDir);
    const wsTestDetection = detectTestFramework(wsDir, wsTsDetection.packageJson);

    workspaceResults.push({
      directory: path.relative(projectDir, wsDir),
      tsDetection: wsTsDetection,
      testDetection: wsTestDetection,
    });
  }

  // Determine overall status - prefer workspace results if they exist
  let primaryTsDetection = rootTsDetection;
  let primaryTestDetection = rootTestDetection;
  let primaryWorkspace = null;

  // Find the workspace with the most complete TypeScript setup
  for (const wsResult of workspaceResults) {
    if (wsResult.tsDetection.isTypeScript) {
      if (
        !primaryTsDetection.isTypeScript ||
        (wsResult.tsDetection.hasTsConfig && !primaryTsDetection.hasTsConfig) ||
        (wsResult.testDetection.framework !== 'none' && primaryTestDetection.framework === 'none')
      ) {
        primaryTsDetection = wsResult.tsDetection;
        primaryTestDetection = wsResult.testDetection;
        primaryWorkspace = wsResult.directory;
      }
    }
  }

  // Check for ts-jest in workspaces and hoisted node_modules
  let hasTsJestAnywhere = primaryTestDetection.hasTsJest;

  // If not found in primary workspace, check all workspaces
  if (!hasTsJestAnywhere) {
    hasTsJestAnywhere = workspaceResults.some((ws) => ws.testDetection.hasTsJest);
  }

  // If still not found, check hoisted node_modules
  if (!hasTsJestAnywhere) {
    hasTsJestAnywhere = checkHoistedDependency('ts-jest', projectDir);
  }

  const needsConfig =
    primaryTsDetection.isTypeScript &&
    primaryTestDetection.framework === 'jest' &&
    !hasTsJestAnywhere;

  return {
    ...primaryTsDetection,
    testFramework: primaryTestDetection,
    needsJestConfig: primaryTsDetection.isTypeScript && !primaryTestDetection.isConfigured,
    needsTsJest: needsConfig,
    recommendations: generateRecommendations(primaryTsDetection, primaryTestDetection),
    workspaceInfo: {
      hasWorkspaces: workspaceDirs.length > 0,
      workspaceCount: workspaceDirs.length,
      primaryWorkspace,
      allWorkspaces: workspaceResults.map((ws) => ws.directory),
    },
  };
}

/**
 * Generate configuration recommendations
 * @param {Object} tsDetection - TypeScript detection result
 * @param {Object} testDetection - Test framework detection result
 * @returns {string[]} Array of recommendations
 */
function generateRecommendations(tsDetection, testDetection) {
  const recommendations = [];

  if (tsDetection.isTypeScript && testDetection.framework === 'none') {
    recommendations.push('No testing framework detected');
    recommendations.push('Recommended: Install Jest with ts-jest');
    recommendations.push('Run: npm install --save-dev jest @types/jest ts-jest');
  }

  if (tsDetection.isTypeScript && testDetection.framework === 'jest' && !testDetection.hasTsJest) {
    recommendations.push('Jest detected but missing TypeScript support');
    recommendations.push('Install ts-jest: npm install --save-dev ts-jest');
    recommendations.push('Or run: caws diagnose to auto-configure');
  }

  if (tsDetection.isTypeScript && !testDetection.isConfigured) {
    recommendations.push('Testing framework not configured');
    recommendations.push('Run: caws scaffold to add test configuration');
  }

  return recommendations;
}

/**
 * Display TypeScript detection results
 * @param {Object} detection - Detection result from checkTypeScriptTestConfig
 */
function displayTypeScriptDetection(detection) {
  if (!detection.isTypeScript) {
    return;
  }

  console.log(chalk.cyan('\n📦 TypeScript Project Detected'));
  console.log(chalk.gray(`   tsconfig.json: ${detection.hasTsConfig ? '✅' : '❌'}`));
  console.log(chalk.gray(`   typescript dependency: ${detection.hasTypeScriptDep ? '✅' : '❌'}`));

  if (detection.testFramework.framework !== 'none') {
    console.log(chalk.gray(`   Test framework: ${detection.testFramework.framework}`));
    console.log(chalk.gray(`   Configured: ${detection.testFramework.isConfigured ? '✅' : '❌'}`));
  }

  if (detection.recommendations.length > 0) {
    console.log(chalk.yellow('\n💡 Recommendations:'));
    detection.recommendations.forEach((rec) => {
      console.log(chalk.yellow(`   ${rec}`));
    });
  }
}

module.exports = {
  detectTypeScript,
  detectTestFramework,
  getWorkspaceDirectories,
  getNpmWorkspaces,
  getPnpmWorkspaces,
  getLernaWorkspaces,
  checkHoistedDependency,
  checkTypeScriptTestConfig,
  generateRecommendations,
  displayTypeScriptDetection,
};
