/**
 * Stryker mutation testing config.
 *
 * Scoped per MUTATION-STRYKER-TS-COVERAGE-001 to the tombstone-enforcement
 * surface added by CAWS-SPECS-ARCHIVE-COLLISION-REFUSAL-001 in specs-writer.
 *
 * IMPORTANT: this repo's Jest tests load implementation from `dist/`
 * (e.g. `require('../../dist/store/specs-writer')`), not from src/, because
 * the vNext TS layer is compiled before tests run (`test:unit` does
 * `npm run build && jest`). Stryker must therefore mutate the compiled
 * `dist/store/specs-writer.js`, not the .ts source, or the tests will run
 * against the unmodified compiled file and report every mutant as killed
 * regardless of test quality.
 *
 * The dist file is per-file `tsc` output (not a bundle); mutating it
 * preserves the same line-level semantics as the source.
 *
 * Mutation surface is narrowed to two line ranges in dist/store/specs-writer.js:
 *   - 122-133: function isArchivedViaTombstone (the tombstone detector)
 *   - 300-380: the two call sites inside createSpec that refuse on tombstone
 *
 * Test surface is narrowed to the three tests that exercise this code path,
 * keeping the dry-run timeout tractable.
 *
 * Run prerequisite: `npm run build` must succeed before `npx stryker run`.
 */
module.exports = {
  mutate: [
    'dist/store/specs-writer.js:122-133',
    'dist/store/specs-writer.js:300-380',
  ],
  testRunner: 'jest',
  testRunnerNodeArgs: [],
  reporters: ['clear-text', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  // perTest would require Stryker to inject coverage probes; the compiled
  // dist code is plain JS without ts-jest in the path, so 'off' is the
  // safe default. With the narrow line ranges + narrow test set, the
  // mutant count stays in the dozens.
  coverageAnalysis: 'off',
  concurrency: 2,
  // 60s per mutant test run; the three relevant tests together take ~27s
  // baseline, so 60s leaves headroom for slower mutants.
  timeoutMS: 120000,
  // The initial dry run runs the full test set once to baseline. 5 min was
  // not enough on this codebase; raise it.
  dryRunTimeoutMinutes: 15,
  thresholds: {
    high: 80,
    low: 60,
    break: null,
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
  // Restrict Jest to only the tests that exercise the tombstone surface.
  // Without this, the dry run executes ~100 test files and exceeds the
  // dry-run timeout.
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: false,
    config: {
      testMatch: [
        '<rootDir>/tests/shell/specs-archive-edge-cases.test.js',
        '<rootDir>/tests/shell/specs-archive-collision-refusal.test.js',
        '<rootDir>/tests/store/specs-writer-archive-tombstone.test.js',
      ],
    },
  },
};
