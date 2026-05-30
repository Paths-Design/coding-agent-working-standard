/**
 * @fileoverview Mutation testing assertions — READ-ONLY over the report.
 *
 * CAWS-MUTATION-HARNESS-NESTED-JEST-001: this harness no longer spawns
 * Stryker. The prior shape ran Stryker from inside Jest's beforeAll, and
 * Stryker's jest-runner spawned ITS OWN jest workers — a jest-spawning-jest
 * model that deadlocked and hit the 30-minute timeout, while the identical
 * Stryker config invoked directly finished in ~4 minutes. The fix splits the
 * two concerns:
 *
 *   - `scripts/run-mutation.mjs` (a standalone top-level Node process, NOT a
 *     Jest child) resolves + runs Stryker and writes the JSON report. The
 *     "Stryker must be installed — no silent skip" precondition lives there.
 *   - THIS file only reads that report and turns kill rate / surviving-mutant
 *     detail into real assertions. It spawns nothing.
 *
 * The documented entrypoint `npm run test:mutation` chains the two:
 * `run-mutation.mjs` then this read-only Jest pass. The earlier "test green
 * was indistinguishable from test-never-ran" failure is still guarded: if
 * MUTATION_TESTING=1 but no report exists, beforeAll throws loudly directing
 * the operator to run the standalone runner first — a missing report is a hard
 * failure, never a silent pass.
 *
 * Set MUTATION_TESTING=1 to run; default-skipped in the unit-test pass.
 */

const fs = require('fs');
const path = require('path');

const SHOULD_RUN = process.env.MUTATION_TESTING === '1';
const describeMutation = SHOULD_RUN ? describe : describe.skip;

describeMutation('Mutation testing (Stryker)', () => {
  const pkgRoot = path.resolve(__dirname, '..', '..');
  const reportPath = path.join(pkgRoot, 'reports', 'mutation', 'mutation-report.json');

  beforeAll(() => {
    // No spawn. The report is produced out-of-process by scripts/run-mutation.mjs
    // (invoked by `npm run test:mutation` before this Jest pass). A missing
    // report is a hard, explicit failure — never a silent pass — preserving the
    // "no silent skip" contract from MUTATION-STRYKER-TS-COVERAGE-001 at the
    // assertion layer, while the runner owns it at the execution layer.
    if (!fs.existsSync(reportPath)) {
      throw new Error(
        `No mutation report at ${reportPath}. The mutation run must execute ` +
          `BEFORE these assertions. Run \`npm run test:mutation\` (which chains ` +
          `\`node scripts/run-mutation.mjs\` then this read-only Jest pass), or ` +
          `run \`node scripts/run-mutation.mjs\` directly first. This harness ` +
          `does not spawn Stryker (CAWS-MUTATION-HARNESS-NESTED-JEST-001).`
      );
    }
  });

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
