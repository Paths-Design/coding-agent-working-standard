// Jest config for @paths.design/caws-cli.
//
// CAWS-ABSORB-KERNEL-01: the kernel (formerly packages/caws-kernel) is now
// absorbed into this package at src/kernel/. Its ~7,900 lines of TS source
// tests (now at tests/kernel/) run against TS source via ts-jest — distinct
// from this package's own tests, which run against the COMPILED dist/ surface
// (plain jest). Jest PROJECTS keeps both in one `npx jest` invocation:
//
//   - main project:  tests/**/*.test.js + src/**/*.test.js, SUT = dist/
//     (the original caws-cli corpus; tests `require('../../dist/store/...')`)
//   - kernel project: tests/kernel/**/*.test.ts, SUT = src/kernel/ via ts-jest
//     (the absorbed kernel's unit tests, unchanged from their pre-absorption
//     shape — only their import paths were rewritten to the new location)
//
// The split preserves both testing philosophies: the CLI tests prove the
// compiled surface a consumer runs, the kernel tests prove the pure-TS
// governance primitives directly. Equivalence to the pre-absorption baselines
// (kernel: 15 suites / 605 tests; CLI: 1160 passing) is the acceptance bar.

/** @type {import('jest').Config} */
const mainProject = {
  displayName: 'caws-cli',
  testEnvironment: 'node',
  testTimeout: 60000,
  // maxWorkers stays default (parallel). The prior corpus deadlocked under
  // parallel workers; the rebuild fixes that at the fixture-isolation layer
  // (per-worker temp repos, no shared git index / .caws state) rather than
  // forcing --runInBand. See tests/helpers/git-repo-factory.js.
  maxWorkers: '50%',
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/src/**/*.test.js'],
  // tests/helpers, tests/fixtures, AND tests/kernel (the kernel project owns it)
  // are not test files for THIS project.
  testPathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/tests/helpers/',
    '<rootDir>/tests/fixtures/',
    '<rootDir>/tests/kernel/',
  ],
  // This project executes compiled code, including the kernel reached by
  // store/shell integration tests. The kernel project owns direct TS tests.
  coveragePathIgnorePatterns: ['/node_modules/', '/src/kernel/'],
  transformIgnorePatterns: ['node_modules/(?!(inquirer)/)'],
  testEnvironmentOptions: {
    error: false,
  },
};

/** @type {import('jest').Config} */
const kernelProject = {
  // The absorbed kernel's unit tests. Run against TS source via ts-jest
  // (preserving the kernel's pre-absorption test setup unchanged). Their
  // imports were rewritten from '../../src/...' to '../../../src/kernel/...'
  // to match the new location.
  displayName: 'kernel',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/kernel/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.kernel-test.json' }],
  },
  coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  rootDir: __dirname,
  verbose: true,
  projects: [mainProject, kernelProject],
  // Jest reads coverage selection and thresholds from the global config,
  // not nested project objects. Include the built runtime (including init)
  // and source-tested kernel; source maps remap compiled TS back to src/.
  collectCoverageFrom: [
    'dist/**/*.js',
    'src/kernel/**/*.ts',
    '!src/kernel/**/*.d.ts',
  ],
  coverageReporters: ['text', 'json', 'json-summary', 'lcov', 'html'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: { statements: 60, branches: 50, functions: 60, lines: 60 },
    // The shared machine installation/migration surface has its own floor;
    // broader CLI coverage cannot hide a regression here. Jest subtracts this
    // group before checking the global floor against the remaining runtime.
    [`${__dirname}/src/init/`]: { statements: 85, branches: 70, functions: 90, lines: 85 },
  },
};
