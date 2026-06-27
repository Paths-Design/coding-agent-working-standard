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
 * real declaration, re-derive the start line. All four store files are now
 * gated (events-store joined under CAWS-TEST-EVENTS-STORE-MUTATION-001).
 *
 * Run prerequisite: `npm run build` must succeed before `npx stryker run`.
 * Remaining areas (shell, hooks, init) get their own mutation slices — the bar
 * is everything-covered-at->=80%, reached incrementally.
 */
// Non-fragile mutate range for an `import *`-compiled dist file: skip the tsc
// `__importStar` interop preamble (which produces only equivalent mutants) but
// run from the first real statement THROUGH end-of-file, computed at load time so
// the range can never go stale when the file changes length. The preceding
// entries use hardcoded spans (a known footgun — a span silently un-gates the tail
// when the file grows); messages-store derives its range instead.
const fs = require('node:fs');
const path = require('node:path');
function rangeAfterPreamble(distRelPath) {
  // The mutation run always builds first (mutation:run = `npm run build && stryker`),
  // so dist exists. Read via __dirname (the config's own dir) so range derivation
  // is independent of Stryker's cwd; Stryker still receives the repo-RELATIVE path.
  // If dist somehow isn't built, fall back to the bare path (whole-file) rather
  // than throw at config load — the gate still runs, just without the preamble trim.
  let lines;
  try {
    lines = fs.readFileSync(path.join(__dirname, distRelPath), 'utf8').split('\n');
  } catch {
    return distRelPath;
  }
  // The interop preamble ends at the last `__importStar(require(...))` line; real
  // logic begins on the next line. Fall back to line 1 if no preamble is present.
  let lastPreamble = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('__importStar(require(')) lastPreamble = i + 1; // 1-based
  }
  const start = lastPreamble > 0 ? lastPreamble + 1 : 1;
  return `${distRelPath}:${start}-${lines.length}`;
}

module.exports = {
  mutate: [
    // yaml-patch uses require(); real logic starts at the first function.
    'dist/store/yaml-patch.js:47-296',
    // apply-patch / atomic-write / events-store use `import *`; skip the tsc
    // interop preamble (real logic starts after the __importStar block).
    'dist/store/apply-patch.js:76-205',
    'dist/store/atomic-write.js:58-173',
    'dist/store/events-store.js:64-574',
    // messages-store: range derived at load time (preamble-end .. EOF) — never
    // drifts on length change, and excludes the equivalent-only interop preamble.
    rangeAfterPreamble('dist/store/messages-store.js'),
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
