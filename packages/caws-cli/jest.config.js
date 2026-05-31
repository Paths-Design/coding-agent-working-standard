module.exports = {
  testEnvironment: 'node',
  testTimeout: 60000,
  maxWorkers: 4,
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/src/**/*.test.js'],
  // Coverage targets the COMPILED vNext surface, not the legacy src/**/*.js
  // glob (which never intersected the store/shell code the suite actually
  // exercises). The 1450 tests require('../../dist/store/...'), so the dist
  // JS is the real SUT. istanbul reads the emitted .js.map sidecars
  // (tsconfig.vnext.json: sourceMap: true) and remaps line hits back to the
  // src/**/*.ts sources, so the report lists .ts rows. The Stryker contract
  // is untouched: tests still load dist/, Stryker still mutates dist/.
  // The five legacy src JS files below are the JS that runtime genuinely
  // loads (per scripts/build-cli.js JS_ALLOWLIST); the shell/*-command JS
  // copies live under dist/ alongside the TS output.
  //
  // NOTE: four of those legacy files `require('chalk')` (chalk@5 is pure ESM).
  // Instrumenting them is clean on the canonical checkout and in CI (verified:
  // error-handler-v11-surface 11/11 pass with these files instrumented). They
  // DO break inside a linked git worktree, but that is a worktree-only module-
  // resolution artifact (the same env class as specs-load-overbroad-scope and
  // status-kernel-feature-detect, which also fail only from worktrees) — NOT a
  // coverage-config defect. Coverage is a canonical/CI concern, so the files
  // stay in. Run --coverage from the canonical checkout, not a worktree.
  // [CAWS-CLI-COVERAGE-HONESTY-001]
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
  // Enforced floor on the vNext store/shell surface (CAWS-CLI-COVERAGE-FLOOR-001).
  // Set ABOVE the pre-backfill honest baseline (76.84 stmt / 63.98 branch /
  // 75.61 func / 79.20 lines) after a targeted backfill of the worst gap files
  // (local gate evaluators, register option-parsing, git-sparse-checkout,
  // init-hook-pack render, the legacy JS glue, json/yaml-store, scope-match,
  // gate-result-contract). CI already runs `turbo run test -- --coverage`, so a
  // miss here surfaces as a red PR check with no extra wiring. Tuned to sit just
  // under the measured post-backfill numbers so the gate bites on regression
  // without being flaky; raise it in a follow-on as more gaps are filled.
  coverageThreshold: {
    global: {
      statements: 78,
      branches: 67,
      functions: 77,
      lines: 80,
    },
  },
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
  // perf budget gates). Every path below must
  // resolve to an existing file on disk — stale entries are scrubbed.
  testPathIgnorePatterns: process.env.CI
    ? [
        '<rootDir>/tests/perf-budgets.test.js',
        '<rootDir>/tests/axe/cli-accessibility.test.js',
        '<rootDir>/tests/contract/schema-contract.test.js',
        '<rootDir>/tests/mutation/mutation-quality.test.js',
      ]
    : [],
};
