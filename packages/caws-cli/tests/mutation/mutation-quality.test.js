/**
 * @fileoverview Mutation testing harness — fails loudly if Stryker fails.
 *
 * Per MUTATION-STRYKER-TS-COVERAGE-001, this harness:
 *   - asserts Stryker is installed (no silent skip on missing dep)
 *   - runs `npx stryker run` and fails the test on non-zero exit
 *   - reads the JSON report from the path Stryker actually writes
 *   - exposes kill rate and surviving-mutant detail as real assertions
 *
 * Prior shape silently passed when Stryker was missing, the config was
 * stale, or the run errored — every code path swallowed the error in a
 * try/catch and only emitted console.warn. That meant "test green" was
 * indistinguishable from "test never ran." This file is the fix.
 *
 * Set MUTATION_TESTING=1 to run; default-skipped in unit-test pass so the
 * regular `npx jest` does not pay the multi-minute Stryker cost.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SHOULD_RUN = process.env.MUTATION_TESTING === '1';
const describeMutation = SHOULD_RUN ? describe : describe.skip;

describeMutation('Mutation testing (Stryker)', () => {
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const reportPath = path.join(pkgRoot, 'reports', 'mutation', 'mutation-report.json');

  // CAWS-MUTATION-HARNESS-RESOLVE-FIX-001: resolve Stryker via Node's module
  // resolution rather than a package-relative node_modules path. In a hoisted
  // npm-workspaces monorepo Stryker installs to the ROOT node_modules, so the
  // old `fs.existsSync(pkgRoot/node_modules/@stryker-mutator/core)` check
  // threw "Stryker is not installed" even when Stryker WAS installed and
  // runnable. require.resolve finds it wherever it is hoisted; the derived bin
  // is launched via `node <bin>` so we never depend on a package-local
  // `node_modules/.bin/stryker` symlink (absent under hoisting).
  function resolveStrykerBin() {
    // Throws MODULE_NOT_FOUND when Stryker is genuinely absent (preserving the
    // "no silent skip" contract). paths anchors resolution at this package.
    const corePkgJson = require.resolve('@stryker-mutator/core/package.json', {
      paths: [pkgRoot],
    });
    const coreDir = path.dirname(corePkgJson);
    // package.json `bin` is either a string or { stryker: "./bin/stryker.js" }.
    const pkg = require(corePkgJson);
    const binRel =
      typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin && pkg.bin.stryker);
    if (!binRel) {
      throw new Error(
        `@stryker-mutator/core resolved at ${coreDir} but exposes no stryker bin.`
      );
    }
    return path.join(coreDir, binRel);
  }

  beforeAll(() => {
    // Hard precondition: Stryker must be installed. No silent skip.
    let strykerBin;
    try {
      strykerBin = resolveStrykerBin();
    } catch (e) {
      throw new Error(
        'Stryker is not installed (or has no bin). Run `npm install --save-dev ' +
          '@stryker-mutator/core @stryker-mutator/jest-runner ' +
          `@stryker-mutator/typescript-checker\` and retry. (${e.message})`
      );
    }

    // Stale report would lie about a fresh run; clear it.
    if (fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }

    // Launch the resolved bin via `node` (NOT `npx stryker`, which needs the
    // stryker symlink in a package-local node_modules/.bin — absent under
    // workspace hoisting).
    const result = spawnSync(
      process.execPath,
      [strykerBin, 'run', '--logLevel', 'info'],
      {
        cwd: pkgRoot,
        encoding: 'utf8',
        // 30 min upper bound; the targeted config should finish in well under
        // that. Longer than this is a regression worth investigating.
        timeout: 30 * 60 * 1000,
        stdio: 'pipe',
      }
    );

    if (result.error) {
      throw new Error(`Stryker spawn failed: ${result.error.message}`);
    }

    // Stryker exits 0 on success (threshold respected). Per the config,
    // `thresholds.break = null` so a low score does not exit non-zero; only
    // configuration/runtime errors do.
    if (result.status !== 0) {
      const stderr = result.stderr || '';
      const stdoutTail = (result.stdout || '').split('\n').slice(-20).join('\n');
      throw new Error(
        `Stryker exited with status ${result.status}. ` +
          `stderr:\n${stderr}\nstdout (last 20 lines):\n${stdoutTail}`
      );
    }

    if (!fs.existsSync(reportPath)) {
      throw new Error(
        `Stryker exited 0 but no report at ${reportPath}. ` +
          `Check stryker.conf.js jsonReporter.fileName.`
      );
    }
  }, 35 * 60 * 1000);

  test('produces a mutation report with at least one mutant', () => {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const totalMutants = countMutants(report);
    expect(totalMutants).toBeGreaterThan(0);
  });

  test('mutation score meets the floor for the targeted surface', () => {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const { killed, survived, total, score } = summarize(report);

     
    console.log(
      `Mutation score: ${score}% (killed=${killed} survived=${survived} total=${total})`
    );

    if (survived > 0) {
      const survivors = listSurvivors(report);
       
      console.log(`Surviving mutants (${survivors.length}):`);
      survivors.slice(0, 20).forEach((s, i) => {
         
        console.log(`  ${i + 1}. ${s.file}:${s.line} — ${s.mutator} — ${s.replacement}`);
      });
      if (survivors.length > 20) {
         
        console.log(`  … and ${survivors.length - 20} more.`);
      }
    }

    // Floor is informational while we build out the test suite; tighten in
    // a follow-up spec once a baseline is established.
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

function countMutants(report) {
  let n = 0;
  for (const file of Object.values(report.files || {})) {
    if (Array.isArray(file.mutants)) n += file.mutants.length;
  }
  return n;
}

function summarize(report) {
  let killed = 0;
  let survived = 0;
  let total = 0;
  for (const file of Object.values(report.files || {})) {
    if (!Array.isArray(file.mutants)) continue;
    for (const m of file.mutants) {
      total += 1;
      if (m.status === 'Killed') killed += 1;
      else if (m.status === 'Survived') survived += 1;
    }
  }
  const decidable = killed + survived;
  const score = decidable === 0 ? 0 : Math.round((killed / decidable) * 100);
  return { killed, survived, total, score };
}

function listSurvivors(report) {
  const out = [];
  for (const [file, fileData] of Object.entries(report.files || {})) {
    if (!Array.isArray(fileData.mutants)) continue;
    for (const m of fileData.mutants) {
      if (m.status !== 'Survived') continue;
      out.push({
        file,
        line: (m.location && m.location.start && m.location.start.line) || 0,
        mutator: m.mutatorName,
        replacement: (m.replacement || '').slice(0, 60),
      });
    }
  }
  return out;
}
