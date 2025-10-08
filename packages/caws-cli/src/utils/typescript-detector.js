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
 * Check if TypeScript project needs test configuration
 * @param {string} projectDir - Project directory path
 * @returns {Object} Configuration status
 */
function checkTypeScriptTestConfig(projectDir = process.cwd()) {
  const tsDetection = detectTypeScript(projectDir);
  const testDetection = detectTestFramework(projectDir, tsDetection.packageJson);
  
  const needsConfig = 
    tsDetection.isTypeScript && 
    testDetection.framework === 'jest' &&
    !testDetection.hasTsJest;
  
  return {
    ...tsDetection,
    testFramework: testDetection,
    needsJestConfig: tsDetection.isTypeScript && !testDetection.isConfigured,
    needsTsJest: needsConfig,
    recommendations: generateRecommendations(tsDetection, testDetection),
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
  checkTypeScriptTestConfig,
  generateRecommendations,
  displayTypeScriptDetection,
};

