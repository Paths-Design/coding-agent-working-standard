/**
 * @fileoverview Jest Configuration Generator
 * Generates Jest configuration for TypeScript projects
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Generate Jest configuration for TypeScript project
 * @param {Object} options - Configuration options
 * @returns {string} Jest configuration content
 */
function generateJestConfig(options = {}) {
  const {
    preset = 'ts-jest',
    testEnvironment = 'node',
    rootDir = '.',
    testMatch = ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
    moduleFileExtensions = ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
    collectCoverageFrom = ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/*.test.ts'],
    coverageThreshold = {
      global: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  } = options;

  const config = {
    preset,
    testEnvironment,
    rootDir,
    testMatch,
    moduleFileExtensions,
    collectCoverageFrom,
    coverageThreshold,
    transform: {
      '^.+\\.tsx?$': [
        'ts-jest',
        {
          tsconfig: 'tsconfig.json',
        },
      ],
    },
    moduleNameMapper: {
      '^@/(.*)$': '<rootDir>/src/$1',
    },
  };

  return `module.exports = ${JSON.stringify(config, null, 2)};\n`;
}

/**
 * Generate test setup file for TypeScript
 * @returns {string} Setup file content
 */
function generateTestSetup() {
  return `/**
 * Jest setup file for TypeScript tests
 * @author @darianrosebrook
 */

// Add custom matchers or global test setup here
beforeAll(() => {
  // Global setup
});

afterAll(() => {
  // Global teardown
});
`;
}

/**
 * Install Jest and TypeScript dependencies
 * @param {string} projectDir - Project directory
 * @param {Object} packageJson - Existing package.json
 * @returns {Promise<Object>} Installation result
 */
async function installJestDependencies(projectDir, packageJson) {
  const dependencies = ['jest', '@types/jest', 'ts-jest'];

  // Check which dependencies are already installed
  const allDeps = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  const toInstall = dependencies.filter((dep) => !(dep in allDeps));

  if (toInstall.length === 0) {
    return {
      installed: false,
      message: 'All Jest dependencies already installed',
      dependencies: [],
    };
  }

  return {
    installed: false,
    needsInstall: true,
    dependencies: toInstall,
    installCommand: `npm install --save-dev ${toInstall.join(' ')}`,
  };
}

/**
 * Configure Jest for TypeScript project
 * @param {string} projectDir - Project directory path
 * @param {Object} options - Configuration options
 * @returns {Promise<Object>} Configuration result
 */
async function configureJestForTypeScript(projectDir = process.cwd(), options = {}) {
  const { force = false, quiet = false } = options;

  // Check if Jest config already exists
  const jestConfigPath = path.join(projectDir, 'jest.config.js');
  if (fs.existsSync(jestConfigPath) && !force) {
    return {
      configured: false,
      skipped: true,
      message: 'Jest configuration already exists',
      path: jestConfigPath,
    };
  }

  // Generate Jest config
  const jestConfig = generateJestConfig();
  await fs.writeFile(jestConfigPath, jestConfig);

  if (!quiet) {
    console.log(chalk.green('✅ Created jest.config.js'));
  }

  // Generate test setup file
  const setupPath = path.join(projectDir, 'tests', 'setup.ts');
  await fs.ensureDir(path.join(projectDir, 'tests'));
  await fs.writeFile(setupPath, generateTestSetup());

  if (!quiet) {
    console.log(chalk.green('✅ Created tests/setup.ts'));
  }

  // Update package.json with test script if needed
  const packageJsonPath = path.join(projectDir, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));

    if (!packageJson.scripts) {
      packageJson.scripts = {};
    }

    if (!packageJson.scripts.test) {
      packageJson.scripts.test = 'jest';
      packageJson.scripts['test:coverage'] = 'jest --coverage';
      packageJson.scripts['test:watch'] = 'jest --watch';

      await fs.writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');

      if (!quiet) {
        console.log(chalk.green('✅ Added test scripts to package.json'));
      }
    }
  }

  return {
    configured: true,
    files: [jestConfigPath, setupPath],
    nextSteps: [
      'Install dependencies: npm install --save-dev jest @types/jest ts-jest',
      'Run tests: npm test',
      'Run with coverage: npm run test:coverage',
    ],
  };
}

/**
 * Get Jest configuration recommendations
 * @param {string} projectDir - Project directory path
 * @returns {Object} Recommendations
 */
function getJestRecommendations(projectDir = process.cwd()) {
  const recommendations = [];
  const hasJestConfig = fs.existsSync(path.join(projectDir, 'jest.config.js'));
  const packageJsonPath = path.join(projectDir, 'package.json');

  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    };

    if (!hasJestConfig && !('jest' in allDeps)) {
      recommendations.push({
        type: 'missing_framework',
        severity: 'high',
        message: 'No testing framework detected',
        fix: 'Install Jest: npm install --save-dev jest @types/jest ts-jest',
        autoFixable: false,
      });
    }

    if ('typescript' in allDeps && 'jest' in allDeps && !('ts-jest' in allDeps)) {
      recommendations.push({
        type: 'missing_ts_jest',
        severity: 'high',
        message: 'TypeScript project with Jest but missing ts-jest',
        fix: 'Install ts-jest: npm install --save-dev ts-jest',
        autoFixable: false,
      });
    }

    if (!hasJestConfig && 'jest' in allDeps) {
      recommendations.push({
        type: 'missing_config',
        severity: 'medium',
        message: 'Jest installed but not configured',
        fix: 'Run: caws scaffold to generate Jest configuration',
        autoFixable: true,
      });
    }
  }

  return {
    hasIssues: recommendations.length > 0,
    recommendations,
  };
}

module.exports = {
  configureJestForTypeScript,
  generateJestConfig,
  generateTestSetup,
  installJestDependencies,
  getJestRecommendations,
};
