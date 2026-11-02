'use strict';

/**
 * Shared Stryker configuration derived from mutation-policy.json.
 *
 * Store and shell tests execute compiled dist code, so those surfaces mutate
 * authored TypeScript and use buildCommand to compile the instrumented source
 * inside Stryker's sandbox. This removes every compiled-line range and makes a
 * growing source file remain fully gated without hand-maintained offsets.
 *
 * [CAWS-CI-MUTATION-PROOF-DURABILITY-001]
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const packageRoot = path.resolve(__dirname, '..');
const policy = JSON.parse(fs.readFileSync(path.join(packageRoot, 'mutation-policy.json'), 'utf8'));

function createJestConfig(surfaceId, tests) {
  const config = {
    rootDir: '.',
    testEnvironment: 'node',
    setupFiles: ['<rootDir>/tests/helpers/isolate-session-env.js'],
    testMatch: tests.map((file) => `<rootDir>/${file}`),
    testPathIgnorePatterns: ['/node_modules/'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    restoreMocks: true,
    verbose: false,
  };
  if (surfaceId === 'kernel') {
    config.transform = {
      '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.kernel-test.json' }],
    };
  }
  return config;
}

function createStrykerConfig(surfaceId) {
  const surface = policy.surfaces[surfaceId];
  if (!surface) {
    throw new Error(
      `Unknown mutation surface "${surfaceId}". Expected one of: ${Object.keys(policy.surfaces).join(', ')}`
    );
  }

  // stage-consumer-docs resolves ../.. from the sandbox package. A sandbox
  // nested under the package would resolve to the original package instead
  // of the canonical repository and consume staged transports as sources.
  const repoRoot = path.resolve(packageRoot, '../..');
  const tempDirName =
    process.env.CAWS_MUTATION_TEMP_DIR ||
    path.join(repoRoot, `.stryker-${surfaceId}-${process.pid}-${randomUUID()}-tmp`);
  if (
    path.dirname(tempDirName) !== repoRoot ||
    !path.basename(tempDirName).startsWith(`.stryker-${surfaceId}-`)
  ) {
    throw new Error('Mutation sandbox parent must be a salted direct child of the repository');
  }
  let ancestor = path.parse(tempDirName).root;
  for (const part of tempDirName.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    const stat = fs.lstatSync(ancestor, { throwIfNoEntry: false });
    if (!stat) {
      if (ancestor !== tempDirName)
        throw new Error(`Missing mutation sandbox ancestor: ${ancestor}`);
      break;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(`Uncertain mutation sandbox ancestry: ${ancestor}`);
    if (ancestor === tempDirName)
      throw new Error(`Mutation sandbox parent already exists: ${ancestor}`);
  }
  const config = {
    mutate: surface.targets.map((target) => target.source),
    testFiles: surface.tests,
    // Only instrumented targets require type-check suppression. The default
    // rewrites every JS/TS file, including the runtime asset generator and
    // its digest inputs, which makes its ordinary --check build fail. Keep
    // authored generators, non-target sources and tests byte-identical.
    disableTypeChecks:
      surface.targets.length === 1
        ? surface.targets[0].source
        : `{${surface.targets.map((target) => target.source).join(',')}}`,
    // Surfaces can run concurrently. Stryker excludes only its own tempDirName
    // by default, so sibling sandboxes would be copied while being removed.
    // Keep authored source/tests; exclude only generated run artifacts.
    ignorePatterns: [
      '.stryker*-tmp',
      '/reports',
      '/coverage',
      '/tmp',
      '.venv',
      '/.license-transport.json',
      '/.license-transport.lock',
    ],
    testRunner: 'jest',
    testRunnerNodeArgs: [],
    // Retained CI/local logs need progress during long mutation runs, not only
    // a baseline line followed by silence until the final report.
    reporters: ['progress-append-only', 'clear-text', 'json', 'html'],
    htmlReporter: { fileName: `${surface.reportDir}/index.html` },
    jsonReporter: { fileName: `${surface.reportDir}/mutation-report.json` },
    coverageAnalysis: surface.coverageAnalysis,
    concurrency: 2,
    timeoutMS: surfaceId === 'kernel' ? 60000 : 120000,
    dryRunTimeoutMinutes: 15,
    // Authoritative mutation evidence must be recomputed from the declared
    // topology. Stryker incremental reports retain removed test metadata and
    // can otherwise make a local report look current after policy drift.
    incremental: false,
    // The per-file report assertion owns the build verdict. An aggregate
    // break threshold could let one strong file hide a weak file.
    thresholds: {
      high: 90,
      low: surface.threshold,
      break: null,
    },
    // Salted per process. Two concurrent runs of the SAME surface (a retry
    // racing a live job, or two local invocations) would otherwise share one
    // sandbox directory, and `cleanTempDir: 'always'` means one run deletes
    // the tree the other is executing from. The ignorePatterns glob above
    // still matches the salted name. Report paths are deliberately NOT
    // salted: they are the contract with assert-mutation-report.mjs and the
    // CI artifact upload.
    tempDirName,
    cleanTempDir: 'always',
    jest: {
      projectType: 'custom',
      // package.json has no Jest block. Loading it deliberately bypasses the
      // repository's multi-project jest.config.js, whose `projects` expansion
      // otherwise defeats a surface's exact test selection.
      configFile: 'package.json',
      enableFindRelatedTests: false,
      config: createJestConfig(surfaceId, surface.tests),
    },
  };
  if (surface.buildCommand) {
    config.buildCommand = surface.buildCommand;
    if (process.env.CAWS_MUTATION_RUN_CONTEXT) {
      if (!/^[a-z0-9-]+$/.test(surfaceId)) throw new Error('Unsafe mutation surface identifier');
      // No caller-controlled filesystem path enters the shell command. The
      // copied helper and the Node selected by PATH are checked by its input
      // capture against the runner's context before the build executes.
      config.buildCommand = `node scripts/mutation-input-identity.mjs sandbox-build ${surfaceId}`;
    }
  }
  return config;
}

module.exports = { createStrykerConfig };
