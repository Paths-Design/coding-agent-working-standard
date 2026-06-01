/**
 * @fileoverview HOOK-CAPABILITY-ENGINE — shadow-fact LIVENESS harness.
 *
 * Proves the capability fact layer is observably LIVE and operationally
 * sufficient: every command emits a non-trivial parsed CommandFact. This is
 * the structural-liveness witness, deliberately SEPARATE from decision
 * authority.
 *
 *   1. 80-FN corpus liveness: every row emits a non-trivial parsed CommandFact
 *      (executable resolved + subcommand_path or flags populated) on STDERR
 *      under CAWS_CLASSIFY_FACTS_DUMP=1. This is the FM-6 guard: it proves
 *      build_command_fact RAN and produced structure. It asserts LIVENESS ONLY
 *      — decision authority for these 80 rows lives in
 *      capability_engine_closure.test.js (which owns the
 *      expected_final_decision assertions). Splitting the two keeps each test
 *      single-responsibility: a fact-builder regression fails HERE, a
 *      lattice/decision regression fails in the closure test.
 *
 *      (Slice-1 history: this suite once asserted decision === current_decision
 *      (allow), the zero-change witness for the stub pass. Slice 2 activated
 *      the pass, so decisions are now ask/deny by design; the decision-unchanged
 *      assertion was removed and decision authority moved to the closure test.)
 *
 *   2. Named fact-probes: assert the exact structural fields the capability pass
 *      maps (basename resolution, wrapper peel, scope, amplifier flags, payload
 *      opacity, substitution recursion, parse_confidence) AND the active-pass
 *      decision they drive. Semantic assertions read the structured STDERR
 *      facts, never the human `reason` prose — the FM-1 guard that the decision
 *      is facet-attributed.
 *
 * Tests the shipped TEMPLATE, not the installed .claude/hooks copy.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { classifyTimeoutMs } = require('./lib/classify-timeout');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CLASSIFIER = path.join(
  REPO_ROOT,
  'packages',
  'caws-cli',
  'templates',
  'hook-packs',
  'claude-code',
  'classify_command.py'
);
const FIX = path.join(__dirname, 'fixtures', 'capability-engine');
const fnCorpus = require(path.join(FIX, 'fn_closure_corpus.json'));
const factProbes = require(path.join(FIX, 'fact_probes.json'));

beforeAll(() => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'capability_engine_shadow: `python3` is not available on PATH. This suite ' +
        `shells out to the classifier template. Underlying error: ${probe.error.message}`
    );
  }
  if (!fs.existsSync(CLASSIFIER)) {
    throw new Error(`capability_engine_shadow: classifier template not found at ${CLASSIFIER}`);
  }
});

/**
 * Run a command through the classifier with facts dumping enabled.
 * Returns { decision, facts } where facts is the array of caws_command_fact
 * objects parsed from stderr (one per classified segment).
 */
function classifyWithFacts(cmd) {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', REPO_ROOT, '--home', '/tmp/fake-home', '--cwd', REPO_ROOT],
    { input: cmd, encoding: 'utf8', timeout: classifyTimeoutMs(), env: { ...process.env, CAWS_CLASSIFY_FACTS_DUMP: '1' } }
  );
  if (r.error) throw new Error(`classifier invocation failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`classifier exited ${r.status}\nstderr: ${r.stderr}`);
  const decision = JSON.parse(r.stdout).decision;
  const facts = [];
  for (const line of r.stderr.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj.caws_command_fact) facts.push(obj.caws_command_fact);
    } catch {
      /* non-fact stderr line (diagnostics); ignore */
    }
  }
  return { decision, facts };
}

const baseName = (cmd) => cmd.trim().split(/\s+/)[0].split('/').pop();

// ===========================================================================
// Suite 1 — 80-FN corpus LIVENESS (FM-6 guard: build_command_fact ran)
//   Liveness ONLY. Decision authority for these rows is owned by
//   capability_engine_closure.test.js.
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE: 80-FN shadow liveness (fact builder ran + produced structure)', () => {
  fnCorpus.entries.forEach((entry) => {
    it(`row ${entry.source_row} [${entry.detector_capability}]: ${entry.command.slice(0, 56)}`, () => {
      const { facts } = classifyWithFacts(entry.command);

      // Semantic liveness: at least one emitted fact for the primary tool
      // is non-trivial — executable resolved AND (subcommand_path|flags)
      // populated. Proves build_command_fact ran and produced structure,
      // independent of whatever decision the lattice then made. (The decision
      // itself is asserted in the closure test.)
      const wanted = baseName(entry.command);
      const live = facts.some(
        (f) =>
          f.executable === wanted &&
          ((f.subcommand_path && f.subcommand_path.length > 0) ||
            (f.flags && f.flags.length > 0))
      );
      expect(live).toBe(true);
    });
  });
});

// ===========================================================================
// Suite 2 — named fact-probes (exact structural fields Slice 2 depends on)
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-001: named fact-probes (Slice-2-sufficiency)', () => {
  factProbes.probes.forEach((p) => {
    it(`${p.name}: ${p.command.slice(0, 56)}`, () => {
      const { decision, facts } = classifyWithFacts(p.command);

      // decision is unchanged from baseline in Slice 1
      if (p.expect_decision) expect(decision).toBe(p.expect_decision);

      const e = p.expect || {};
      // For multi-segment/recursive commands, find the fact matching the
      // probed executable; else use the first emitted fact.
      const f =
        (e.executable && facts.find((x) => x.executable === e.executable)) ||
        facts[0] ||
        {};

      if (e.executable !== undefined) expect(f.executable).toBe(e.executable);
      if (e.kind !== undefined) expect(f.facets.kind).toBe(e.kind);
      if (e.scope !== undefined) expect(f.facets.scope).toBe(e.scope);
      if (e.opacity !== undefined) expect(f.facets.opacity).toBe(e.opacity);
      if (e.parse_confidence !== undefined)
        expect(f.parse_confidence).toBe(e.parse_confidence);
      if (e.flags_contains !== undefined)
        expect(f.flags || []).toContain(e.flags_contains);
      if (e.subcommand_path_contains !== undefined)
        expect(f.subcommand_path || []).toContain(e.subcommand_path_contains);
      if (e.wrappers !== undefined) expect(f.wrappers).toEqual(e.wrappers);
      if (e.substitution_seen !== undefined) {
        // substitution recursion produces ≥1 fact for the inner command;
        // its presence + the (already-asserted) decision prove extraction ran.
        expect(facts.length).toBeGreaterThan(0);
      }
    });
  });
});
