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
  // Coverage targets the COMPILED vNext surface (dist/store + dist/shell), the
  // real SUT. istanbul remaps via the emitted .js.map sidecars
  // (tsconfig.vnext.json: sourceMap: true) so the report lists src/**/*.ts
  // rows. The five legacy src JS files are the JS the runtime genuinely loads
  // (scripts/build-cli.js JS_ALLOWLIST). [CAWS-CLI-COVERAGE-HONESTY-001]
  collectCoverageFrom: [
    'dist/store/**/*.js',
    'dist/shell/**/*.js',
    '!dist/**/*.d.ts',
    'src/index.js',
    'src/config/index.js',
    'src/error-handler.js',
    'src/utils/detection.js',
    'src/utils/error-categories.js',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  coverageDirectory: 'coverage',
  // Thresholds are 0 during the rebuild (zero tests exist). Slices 1-3 (kernel,
  // store, shell) and slice 8 (CI wiring) ratchet these back toward and above
  // the prior honest baseline. Do NOT set a non-zero floor until tests exist.
  coverageThreshold: {
    global: {
      statements: 0,
      branches: 0,
      functions: 0,
      lines: 0,
    },
  },
  verbose: true,
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
  collectCoverageFrom: ['src/kernel/**/*.ts', '!src/kernel/**/*.d.ts', '!src/kernel/index.ts'],
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  projects: [mainProject, kernelProject],
};
