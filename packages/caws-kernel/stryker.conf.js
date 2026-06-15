/**
 * Stryker mutation testing config — the kernel mutation gate.
 *
 * CAWS-TEST-KERNEL-MUTATION-GATE-001 adds the kernel Stryker config that
 * CAWS-TEST-MUTATION-GATE-001's acceptance criterion A2 claimed but never
 * shipped (the kernel had ZERO mutation pressure: no config, no script, and
 * run-mutation.mjs runs only in caws-cli). The kernel is the load-bearing
 * safety surface — the scope-authority evaluator and the audit hash-chain
 * verifier — so it must be gated at least as hard as the CLI store.
 *
 * MUTATE THE SOURCE, NOT A DIST BUILD: the kernel jest preset is ts-jest
 * running src/ directly (unlike the CLI, whose jest loads compiled dist/). So
 * Stryker mutates the .ts source here. The mutate-target (src) and the
 * test-load-target (src via ts-jest) agree — if they disagreed, every mutant
 * would report killed regardless of test quality.
 *
 * MUTATE SET = DIRECTLY-TESTED SURFACE ONLY: we list the specific src files a
 * tests/unit file imports as its system under test. Mutating a file with no
 * covering test yields guaranteed survivors that falsely depress the score —
 * the gate measures TEST QUALITY on covered code, not coverage breadth. New
 * covered files join this list as their tests land (e.g. verify.ts joined when
 * CAWS-TEST-KERNEL-VERIFYCHAIN-001 added its test).
 *
 * INCREMENTAL: incremental mode is on. Stryker hashes each source + test file
 * and, on a warm run, only re-tests mutants whose covering bytes changed. The
 * incrementalFile lives under reports/ (gitignored) — it is runtime cache, not
 * committed state. This is the "cache on hashed bytes" speedup: a one-file
 * change re-mutates ~that file, not the whole surface.
 *
 * thresholds.break = 80: a kernel score below 80% FAILS the run. The floor is
 * never lowered to pass; surviving mutants are killed by added tests (a
 * separate test-scope spec) or documented as equivalent with rationale.
 *
 * Run prerequisite: none beyond installed deps — ts-jest compiles in-process.
 */
module.exports = {
  mutate: [
    // Audit integrity (E9/E20) — the chain verifier + canonical serializer.
    // NOTE: src/evidence/hash.ts is intentionally NOT in the mutate set. It is a
    // linear, branchless crypto wrapper (createHash -> update -> update -> digest)
    // with exactly 4 mutants: 2 are killed by evidence-hash.test.ts, and 2 are
    // PROVEN EQUIVALENT — the `h.update(x, 'utf8')` encoding arg, where
    // `'utf8' -> ''` yields a byte-identical digest because Node's crypto
    // Hash.update() defaults empty/unknown string encoding to utf8 (verified).
    // Stryker has no native single-line exclusion to drop only those two
    // equivalents (they sit between killable lines, and multi-range-same-file
    // mutate specs instrument 0 mutants in Stryker 9.6), so gating hash.ts would
    // peg it at a permanent 50% equivalent-mutant ceiling and red the per-file
    // bar dishonestly. Its BEHAVIOR is fully mutation-covered transitively:
    // verify.ts (95.73%) re-hashes every event via computeEventHash, and
    // evidence-hash.test.ts asserts the exact domain-separated recipe byte-for-byte.
    'src/evidence/verify.ts',
    'src/evidence/canonical-json.ts',
    // Scope authority (E8/E12) — admit/refuse/no-authority decision.
    'src/scope/evaluate.ts',
    // Spec validation (E13/E14) — shape + semantics gates.
    'src/spec/validate-shape.ts',
    'src/spec/validate-semantics.ts',
    // Policy budgets.
    'src/policy/derive-budget.ts',
    // Worktree lifecycle transitions + freshness doctrine.
    'src/worktree/transitions.ts',
    'src/worktree/freshness.ts',
    // Result combinators (the error-accumulation substrate everything uses).
    'src/result/combinators.ts',
  ],
  testRunner: 'jest',
  testRunnerNodeArgs: [],
  reporters: ['clear-text', 'json', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation-report.json' },
  coverageAnalysis: 'perTest',
  concurrency: 2,
  timeoutMS: 60000,
  dryRunTimeoutMinutes: 10,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  thresholds: {
    high: 90,
    low: 80,
    break: 80,
  },
  ignorePatterns: ['reports', 'coverage', 'tmp', 'node_modules', '.stryker-tmp', 'dist'],
  tempDirName: '.stryker-tmp',
  jest: {
    projectType: 'custom',
    configFile: 'jest.config.js',
    enableFindRelatedTests: false,
    config: {
      testMatch: ['<rootDir>/tests/unit/*.test.ts'],
    },
  },
};
