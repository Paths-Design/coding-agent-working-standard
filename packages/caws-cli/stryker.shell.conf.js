/**
 * Stryker mutation testing config — the CLI shell mutation gate.
 *
 * CAWS-TEST-SHELL-MUTATION-001. Separate from stryker.conf.js (the store gate)
 * so each surface runs its own tests and stays independently fast: this config
 * mutates the shell pure-logic dist files against tests/shell only.
 *
 * SURFACE: the 5 shell decision-logic modules the shell suite (52 tests)
 * covers — push-range (E18 commit attribution), gates (block/warn disposition
 * + waiver filtering), and binding resolution (bound/unbound/one_sided). These
 * are pure decision functions (no I/O), the right mutation surface. NOTE: init
 * is deliberately NOT mutation-gated — its manifests are static data and its
 * install logic is FS-side-effect code tested behaviorally (per the
 * CAWS-TEST-SHELL-MUTATION-001 decision); hooks are bats/pytest (Stryker is
 * JS-only).
 *
 * MUTATE DIST, NOT SRC: CLI jest loads implementation from dist/ (compiled
 * before tests run), so Stryker must mutate dist/ or every mutant reports
 * killed regardless of test quality (same contract as the store config).
 *
 * COMPILER-PREAMBLE EXCLUSION: resolve-binding.js uses `import * as fs/path`,
 * which compiles to the tsc `__importStar`/`__createBinding` interop preamble
 * (~lines 1-63) plus the sourceMappingURL trailer. That preamble is NON-source
 * compiler boilerplate no unit test can or should kill, so resolve-binding's
 * mutate range is restricted to its real-logic lines (64-334). This is a
 * non-source exclusion (same discipline as the store config), NOT an
 * equivalent-mutant exclusion — the 80 floor applies to every line we wrote.
 * The other 4 files use require() (no preamble) and mutate whole-file.
 *
 * thresholds.break = 80: every gated shell file must clear 80% raw by tests.
 *
 * Run prerequisite: `npm run build` must succeed before `npx stryker run`.
 */
module.exports = {
  mutate: [
    // push-range — E18 commit-attribution guard (require(), whole-file).
    'dist/shell/push-range/classify-range.js',
    'dist/shell/push-range/scope-match.js',
    // gates — block/warn disposition + waiver filtering (require(), whole-file).
    'dist/shell/gates/disposition.js',
    'dist/shell/gates/waiver-filter.js',
    // binding resolution — uses import*; skip the tsc interop preamble.
    'dist/shell/binding/resolve-binding.js:64-334',
  ],
  testRunner: 'jest',
  testRunnerNodeArgs: [],
  reporters: ['clear-text', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation-shell/index.html' },
  jsonReporter: { fileName: 'reports/mutation-shell/mutation-report.json' },
  coverageAnalysis: 'off',
  concurrency: 2,
  timeoutMS: 120000,
  dryRunTimeoutMinutes: 15,
  incremental: true,
  incrementalFile: 'reports/stryker-shell-incremental.json',
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  ignorePatterns: ['reports', 'coverage', 'tmp', 'node_modules', '.stryker-tmp', 'src'],
  tempDirName: '.stryker-shell-tmp',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: false,
    config: {
      testMatch: ['<rootDir>/tests/shell/*.test.js'],
    },
  },
};
