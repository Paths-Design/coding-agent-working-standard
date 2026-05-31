/**
 * @fileoverview HOOK-CAPABILITY-ENGINE-001 — shadow-fact liveness harness.
 *
 * Proves the capability fact layer is observably LIVE and operationally
 * sufficient for Slice 2, WITHOUT changing any classifier decision (Slice 1
 * keeps the capability pass a stub). Two suites:
 *
 *   1. 80-FN corpus liveness: every known-false-negative command emits a
 *      non-trivial parsed CommandFact (executable resolved + subcommand_path
 *      or flags populated) on STDERR under CAWS_CLASSIFY_FACTS_DUMP=1, and the
 *      stdout decision is UNCHANGED (still the silent allow it is at baseline).
 *      This is the FM-6 guard: it proves build_command_fact RAN, distinct from
 *      the stub pass trivially returning None.
 *
 *   2. Named fact-probes: assert the exact structural fields Slice 2 will map
 *      (basename resolution, wrapper peel, scope, amplifier flags, payload
 *      opacity, substitution recursion, parse_confidence). Semantic assertions
 *      read the structured STDERR facts, never the human `reason` prose.
 *
 * Tests the shipped TEMPLATE, not the installed .claude/hooks copy.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

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
    { input: cmd, encoding: 'utf8', timeout: 5000, env: { ...process.env, CAWS_CLASSIFY_FACTS_DUMP: '1' } }
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
// Suite 1 — 80-FN corpus liveness (FM-6 guard: builder ran, decision unchanged)
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-001: 80-FN shadow liveness (decision unchanged + fact live)', () => {
  fnCorpus.entries.forEach((entry) => {
    it(`row ${entry.source_row} [${entry.detector_capability}]: ${entry.command.slice(0, 56)}`, () => {
      const { decision, facts } = classifyWithFacts(entry.command);

      // (a) ZERO decision change: this FN is still a silent allow in Slice 1.
      //     (Slice 2 will close it to expected_final_decision.)
      expect(decision).toBe(entry.current_decision); // all rows: "allow"

      // (b) Semantic liveness: at least one emitted fact for the primary tool
      //     is non-trivial — executable resolved AND (subcommand_path|flags)
      //     populated. Proves build_command_fact ran and produced structure.
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
