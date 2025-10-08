module.exports = {
  testEnvironment: 'node',
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
  // Fix CI working directory issues
  setupFilesAfterEnv: ['<rootDir>/tests/setup.js'],
  // Ensure proper working directory in CI
  globalSetup: '<rootDir>/tests/global-setup.js',
  globalTeardown: '<rootDir>/tests/global-teardown.js',
};
