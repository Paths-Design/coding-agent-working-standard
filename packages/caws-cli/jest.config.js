module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  maxWorkers: 4,
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/src/**/*.test.js'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js'],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: 'coverage',
  verbose: true,
  transformIgnorePatterns: ['node_modules/(?!(inquirer)/)'],
  moduleNameMapper: {
    '^inquirer$': '<rootDir>/tests/mocks/inquirer.js',
  },
  // Handle errors gracefully to avoid circular structure issues
  testEnvironmentOptions: {
    error: false,
  },
  // Fix CI working directory issues with more robust approach
  setupFiles: ['<rootDir>/tests/pre-setup.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // Skip environmental tests in CI (browser-driven a11y, mutation, contract,
  // perf budget gates, cursor IDE integration). Every path below must
  // resolve to an existing file on disk — stale entries are scrubbed.
  testPathIgnorePatterns: process.env.CI
    ? [
        '<rootDir>/tests/integration/cursor-hooks.test.js',
        '<rootDir>/tests/perf-budgets.test.js',
        '<rootDir>/tests/axe/cli-accessibility.test.js',
        '<rootDir>/tests/contract/schema-contract.test.js',
        '<rootDir>/tests/mutation/mutation-quality.test.js',
      ]
    : [],
};
