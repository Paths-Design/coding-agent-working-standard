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
 * COMPILER-BOILERPLATE EXCLUSION (line ranges): files that use `import * as`
 * (apply-patch, atomic-write) compile to a ~40-line tsc ESM-interop preamble
 * (`__createBinding` / `__setModuleDefault` / `__importStar`) plus the
 * `Object.defineProperty(exports, ...)` / `exports.X = X` / `require(...)`
 * cluster. That preamble is NOT this module's source logic — it is identical
 * downlevel-emit boilerplate present in every TS file that uses a namespace
 * import, and no unit test can (or should) kill mutations inside it. Measuring
 * it as if it were source depressed the score with non-source noise
 * (atomic-write: real logic 43%, but boilerplate dragged the total to 32%;
 * yaml-patch hit 80% only because it uses `require()` and has no such preamble).
 * We therefore restrict each `import *` file's mutate range to its real-logic
 * lines (first declaration after the preamble through the last statement before
 * the sourceMappingURL comment). This excludes NON-SOURCE compiler emit — it is
 * NOT an equivalent-mutant exclusion (the doctrine forbids those): the 80%
 * floor still applies to every line of code we actually wrote.
 *
 * The line ranges are tied to the compiled dist; the tsc preamble is stable
 * (it only shifts if the import style changes), but if a build moves the first
 * real declaration, re-derive the start line. events-store is measured under
 * its own slice (CAWS-TEST-EVENTS-STORE-MUTATION-001), not here.
 *
 * Run prerequisite: `npm run build` must succeed before `npx stryker run`.
 * Remaining areas (shell, hooks, init) get their own mutation slices — the bar
 * is everything-covered-at->=80%, reached incrementally.
 */
module.exports = {
  mutate: [
    // yaml-patch uses require(); real logic starts at the first function.
    'dist/store/yaml-patch.js:47-296',
    // apply-patch / atomic-write use `import *`; skip the tsc interop preamble.
    'dist/store/apply-patch.js:76-205',
    'dist/store/atomic-write.js:58-173',
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
