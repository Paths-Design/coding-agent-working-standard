/**
 * Stryker mutation testing config — the CLI store mutation gate.
 *
 * CAWS-TEST-MUTATION-GATE-001 widened this from the original 2-line tombstone
 * range to the store surface the test-reconciliation campaign covered:
 * yaml-patch, atomic-write, apply-patch, events-store. The mutation floor is
 * thresholds.break = 80 — a tier-1 gate that FAILS the build below 80% (a
 * deliberate change from the prior break:null non-gating posture).
 *
 * IMPORTANT: this repo's Jest tests load implementation from `dist/`
 * (e.g. `require('../../dist/store/yaml-patch')`), not from src/, because the
 * vNext TS layer is compiled before tests run. Stryker must therefore mutate
 * the compiled `dist/store/*.js`, not the .ts source, or the tests will run
 * against the unmodified compiled file and report every mutant as killed
 * regardless of test quality. The dist file is per-file `tsc` output (not a
 * bundle); mutating it preserves the same line-level semantics as the source.
 *
 * Run prerequisite: `npm run build` must succeed before `npx stryker run`.
 * Remaining areas (shell, hooks, init) get their own mutation slices — the bar
 * is everything-covered-at->=80%, reached incrementally.
 */
module.exports = {
  mutate: [
    'dist/store/yaml-patch.js',
    'dist/store/atomic-write.js',
    'dist/store/apply-patch.js',
    'dist/store/events-store.js',
  ],
  testRunner: 'jest',
  testRunnerNodeArgs: [],
  reporters: ['clear-text', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  coverageAnalysis: 'off',
  concurrency: 2,
  timeoutMS: 120000,
  dryRunTimeoutMinutes: 15,
  // Tier-1 mutation gate: a score below 80% FAILS the build (was break: null).
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  ignorePatterns: [
    'reports',
    'coverage',
    'tmp',
    'node_modules',
    '.stryker-tmp',
    'src',
  ],
  tempDirName: '.stryker-tmp',
  // Restrict Jest to the store suite that exercises the mutated modules so the
  // dry run + per-mutant runs stay tractable.
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: false,
    config: {
      testMatch: ['<rootDir>/tests/store/*.test.js'],
    },
  },
};
