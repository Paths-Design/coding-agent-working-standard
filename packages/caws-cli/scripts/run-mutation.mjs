#!/usr/bin/env node
/**
 * Standalone mutation-test runner.
 *
 * CAWS-MUTATION-HARNESS-NESTED-JEST-001: Stryker must NOT be spawned from
 * inside a Jest process. The previous harness ran
 * `MUTATION_TESTING=1 jest tests/mutation/mutation-quality.test.js`, whose
 * beforeAll spawned `stryker run`, and Stryker's jest-runner in turn spawned
 * ITS OWN jest workers. That jest-spawning-jest model deadlocked/starved and
 * the harness timed out at its 30-minute ceiling, while the identical Stryker
 * config invoked DIRECTLY finished in ~4 minutes.
 *
 * This runner is that direct invocation, as a first-class top-level Node
 * process (no Jest parent). It:
 *   - resolves Stryker via Node module resolution (hoisted-monorepo safe;
 *     CAWS-MUTATION-HARNESS-RESOLVE-FIX-001), failing loudly with the install
 *     instruction when Stryker is genuinely absent — the "no silent skip"
 *     precondition from MUTATION-STRYKER-TS-COVERAGE-001 lives HERE now.
 *   - clears any stale report so a fresh run can be distinguished from a
 *     prior one.
 *   - runs `node <stryker bin> run`, inheriting stdio so the operator sees
 *     live progress, and exits with Stryker's own status.
 *
 * The Jest harness (tests/mutation/mutation-quality.test.js) is now READ-ONLY:
 * it asserts against the report this runner writes and never spawns Stryker.
 * The documented entrypoint `npm run test:mutation` chains run -> assert.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const pkgRoot = path.resolve(path.dirname(__filename), '..');
const require = createRequire(import.meta.url);
const reportPath = path.join(pkgRoot, 'reports', 'mutation', 'mutation-report.json');

/**
 * Resolve the Stryker bin via Node resolution (finds it wherever it is hoisted
 * in a workspace), then derive the executable from the package's `bin` field.
 * Throws when Stryker is genuinely absent — preserving the "no silent skip"
 * contract: a missing dependency is a loud, explicit failure, not a quiet pass.
 */
function resolveStrykerBin() {
  const corePkgJson = require.resolve('@stryker-mutator/core/package.json', {
    paths: [pkgRoot],
  });
  const coreDir = path.dirname(corePkgJson);
  const pkg = require(corePkgJson);
  const binRel =
    typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && pkg.bin.stryker;
  if (!binRel) {
    throw new Error(
      `@stryker-mutator/core resolved at ${coreDir} but exposes no stryker bin.`
    );
  }
  return path.join(coreDir, binRel);
}

let strykerBin;
try {
  strykerBin = resolveStrykerBin();
} catch (e) {
  console.error(
    'Stryker is not installed (or has no bin). Run `npm install --save-dev ' +
      '@stryker-mutator/core @stryker-mutator/jest-runner ' +
      `@stryker-mutator/typescript-checker\` and retry. (${e.message})`
  );
  process.exit(1);
}

// A stale report would lie about a fresh run; clear it before launching.
if (fs.existsSync(reportPath)) {
  fs.unlinkSync(reportPath);
}

// Top-level Node process — NOT a Jest child. Inherit stdio for live progress.
const result = spawnSync(
  process.execPath,
  [strykerBin, 'run', '--logLevel', 'info'],
  {
    cwd: pkgRoot,
    stdio: 'inherit',
    // No artificial timeout: this is a standalone process, not a Jest hook,
    // so it cannot starve a Jest worker pool. The targeted config completes in
    // ~4 minutes; a genuine hang surfaces as a hung process the operator can
    // see and kill, not a silent 30-minute jest ceiling.
  }
);

if (result.error) {
  console.error(`Stryker spawn failed: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  // Stryker exits 0 on success (config sets thresholds.break = null, so a low
  // score does not fail); a non-zero status is a configuration/runtime error.
  console.error(`Stryker exited with status ${result.status}.`);
  process.exit(result.status || 1);
}

if (!fs.existsSync(reportPath)) {
  console.error(
    `Stryker exited 0 but no report at ${reportPath}. ` +
      `Check stryker.conf.js jsonReporter.fileName.`
  );
  process.exit(1);
}

console.log(`Mutation report written to ${reportPath}`);
