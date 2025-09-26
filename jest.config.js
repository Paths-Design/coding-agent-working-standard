module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: [
    '**/__tests__/**/*.test.{js,ts}',
    '**/?(*.)+(spec|test).{js,ts}'
  ],
  collectCoverageFrom: [
    'packages/*/src/**/*.{js,ts}',
    'packages/*/apps/**/*.{js,ts}',
    '!packages/*/src/**/*.test.{js,ts}',
    '!packages/*/src/**/*.d.ts'
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: '<rootDir>/coverage',
  verbose: true,
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/build/'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
    '^.+\\.js$': 'babel-jest'
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@caws/(.*)$': '<rootDir>/packages/$1/src'
  }
};
