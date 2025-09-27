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
};
