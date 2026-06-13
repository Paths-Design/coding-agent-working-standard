// Jest config for @paths.design/caws-cli.
//
// REBUILD NOTE (CAWS-TEST-HARNESS-FOUNDATION-001): the prior test corpus was
// deleted wholesale for a ground-up tier-1 rebuild. This config is the clean
// foundation: it references ONLY files that exist on disk, so
// `npx jest --passWithNoTests` runs green before any test is authored. Later
// slices add tests under tests/{unit,integration,store,shell,init,hooks} and
// raise the coverage thresholds (currently 0 — a non-zero floor with zero
// tests would false-fail; slices 1-3/8 ratchet it back up).
//
// The SUT is the COMPILED surface: tests `require('../../dist/store/...')`,
// not src/. `npm run build` (turbo) compiles TS -> dist before jest runs. The
// Stryker contract is preserved: tests load dist/, Stryker mutates dist/.
module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  // maxWorkers stays default (parallel). The prior corpus deadlocked under
  // parallel workers; the rebuild fixes that at the fixture-isolation layer
  // (per-worker temp repos, no shared git index / .caws state) rather than
  // forcing --runInBand. See tests/helpers/git-repo-factory.js.
  maxWorkers: '50%',
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/src/**/*.test.js'],
  // tests/helpers and tests/fixtures hold harness code, not test files.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/helpers/', '<rootDir>/tests/fixtures/'],
  // Coverage targets the COMPILED vNext surface (dist/store + dist/shell), the
  // real SUT. istanbul remaps via the emitted .js.map sidecars
  // (tsconfig.vnext.json: sourceMap: true) so the report lists src/**/*.ts
  // rows. The five legacy src JS files are the JS the runtime genuinely loads
  // (scripts/build-cli.js JS_ALLOWLIST). [CAWS-CLI-COVERAGE-HONESTY-001]
  //
  // NOTE: run --coverage from the CANONICAL checkout, not a linked worktree —
  // instrumenting the legacy chalk-importing JS is clean on canonical/CI but
  // breaks under a worktree's module resolution (a worktree-only artifact, not
  // a coverage-config defect).
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
  // the prior honest baseline (76.84 stmt / 63.98 branch / 75.61 func / 79.20
  // lines). Do NOT set a non-zero floor until tests exist for the surface, or
  // every run false-fails.
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
