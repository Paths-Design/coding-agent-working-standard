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

const packageRoot = path.resolve(__dirname, '..');
const policy = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'mutation-policy.json'), 'utf8')
);

function createJestConfig(surfaceId, tests) {
  const config = {
    rootDir: '.',
    testEnvironment: 'node',
    testMatch: tests.map((file) => `<rootDir>/${file}`),
    testPathIgnorePatterns: ['/node_modules/'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    clearMocks: true,
    restoreMocks: true,
    verbose: false,
  };
  if (surfaceId === 'kernel') {
    config.transform = {
      '^.+\\.ts$': [
        'ts-jest',
        { tsconfig: '<rootDir>/tsconfig.kernel-test.json' },
      ],
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

  const config = {
    mutate: surface.targets.map((target) => target.source),
    testFiles: surface.tests,
    // Surfaces can run concurrently. Stryker excludes only its own tempDirName
    // by default, so sibling sandboxes would be copied while being removed.
    // Keep authored source/tests; exclude only generated run artifacts.
    ignorePatterns: ['.stryker*-tmp', '/reports', '/coverage', '/tmp', '.venv'],
    testRunner: 'jest',
    testRunnerNodeArgs: [],
    reporters: ['clear-text', 'json', 'html'],
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
    tempDirName: `.stryker-${surfaceId}-${process.pid}-tmp`,
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
  if (surface.buildCommand) config.buildCommand = surface.buildCommand;
  return config;
}

module.exports = { createStrykerConfig };
