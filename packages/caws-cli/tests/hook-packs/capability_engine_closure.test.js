/**
 * @fileoverview HOOK-CAPABILITY-ENGINE-002 — family-detector closure (Slice 2).
 *
 * The DECISION-AUTHORITY test for the activated capability pass. Where
 * capability_engine_shadow.test.js proves the facts are LIVE, this test proves
 * the lattice produces the RIGHT decision from those facts, on the admitted
 * 80-FN corpus, and that no routine dev-loop command is over-blocked.
 *
 * Closure bar (the maintainer's settled Slice-2 gates):
 *   1. 80/80 closure = NO SILENT ALLOW. Every admitted FN row resolves to its
 *      reconciled expected_final_decision (the LATTICE result), and that
 *      decision is FACET-ATTRIBUTED — proven by the emitted CommandFact's kind
 *      (non-NONE and consistent with the decision), never by a reason substring
 *      (FM-1 guard). Rows whose dangerous operand is inside a $()/pipeline carry
 *      decision_path:substitution_or_pipeline_recursion; for those, attribution
 *      is proven by a recursed inner segment carrying a non-NONE destructive kind.
 *   2. Expected FACETS match the emitted facets (the corpus was reconciled to the
 *      doc-calibrated lattice; expected_facets are the doc-correct values).
 *   3. The lattice_wins set is EXACTLY {row 7} — the one genuine corpus-vs-lattice
 *      adjudication. Any drift (a new divergence, or row 7 silently matching the
 *      corpus again) fails here until adjudication.md is updated.
 *   4. portability-negative corpus: 100% allow (no new dev-loop overblock).
 *   5. sidecar fail-closed THROUGH the active CLI path: a malformed
 *      .caws/command-adapters.json + an extension-dependent command -> ask,
 *      never allow.
 *   6. schema rejects nested policy-shaped keys (adapters map alias->facet only).
 *
 * Tests the shipped TEMPLATE, not the installed .claude/hooks copy.
 *
 * @author @darianrosebrook
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
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
const portability = require(path.join(FIX, 'portability_negative_corpus.json'));

beforeAll(() => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(
      'capability_engine_closure: `python3` is not available on PATH. This suite ' +
        `shells out to the classifier template. Underlying error: ${probe.error.message}`
    );
  }
  if (!fs.existsSync(CLASSIFIER)) {
    throw new Error(`capability_engine_closure: classifier template not found at ${CLASSIFIER}`);
  }
});

/**
 * Classify a command, returning { decision, facts } where facts is the array of
 * caws_command_fact objects emitted on stderr (one per classified segment,
 * including recursed substitution/nested-shell segments).
 * @param {string} cmd command on stdin
 * @param {string} [repoRoot] repo root passed to --repo-root (default REPO_ROOT)
 * @param {string} [home] fake home passed to --home
 */
function classify(cmd, repoRoot = REPO_ROOT, home = '/tmp/fake-home-closure') {
  const r = spawnSync(
    'python3',
    [CLASSIFIER, '--repo-root', repoRoot, '--home', home, '--cwd', repoRoot],
    {
      input: cmd,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, CAWS_CLASSIFY_FACTS_DUMP: '1' },
    }
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
      /* non-fact stderr line; ignore */
    }
  }
  return { decision, facts };
}

const DESTRUCTIVE_KINDS = new Set(['DESTROY', 'MUTATE', 'PRIV_ESC', 'SECRETS_READ', 'EXEC']);

// ===========================================================================
// Gate 1 + 2 — 80/80 closure, facet-attributed, expected facets match
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-002: 80-FN closure (no silent allow, facet-attributed)', () => {
  fnCorpus.entries.forEach((entry) => {
    it(`row ${entry.source_row} [${entry.detector_capability}] -> ${entry.expected_final_decision}: ${entry.command.slice(0, 48)}`, () => {
      const { decision, facts } = classify(entry.command);

      // (1) NO SILENT ALLOW + decision matches the reconciled lattice result.
      expect(decision).not.toBe('allow');
      expect(decision).toBe(entry.expected_final_decision);

      // (1b) FACET ATTRIBUTION (FM-1): the decision came from the capability
      //      path, proven by a destructive kind in the emitted facts — NOT by a
      //      reason substring. Two shapes:
      if (entry.decision_path === 'substitution_or_pipeline_recursion') {
        // The top-level segment fact may be kind=NONE (the dangerous operand is
        // inside $()/a pipeline); attribution is a recursed segment carrying a
        // destructive kind.
        const attributed = facts.some((f) => DESTRUCTIVE_KINDS.has(f.facets.kind));
        expect(attributed).toBe(true);
      } else {
        // The primary tool's fact carries a destructive kind that the lattice read.
        const wanted = entry.command.trim().split(/\s+/)[0].split('/').pop();
        const primary =
          facts.find((f) => f.executable === wanted) || facts[0] || { facets: {} };
        expect(DESTRUCTIVE_KINDS.has(primary.facets.kind)).toBe(true);

        // (2) expected_facets (doc-correct, reconciled) match the emitted facets.
        const ef = entry.expected_facets || {};
        for (const key of Object.keys(ef)) {
          expect(primary.facets[key]).toBe(ef[key]);
        }
      }
    });
  });

  it('de-gate: every corpus row is active (runs in the default suite, no env gate)', () => {
    // The closure assertions above iterate ALL entries unconditionally — there
    // is no `active`/CAWS_CLASSIFIER_SLICE filter, so the rows already run in the
    // default jest. This guards the fixture's self-description against drift: at
    // Slice-2 closure no row may be left active:false (which would falsely imply
    // it is still gated out of the default suite).
    const inactive = fnCorpus.entries.filter((e) => e.active !== true);
    expect(inactive.map((e) => e.source_row)).toEqual([]);
  });

  it('corpus closure summary: 80 rows, 0 silent allows, distribution recorded', () => {
    let allow = 0;
    const dist = { allow: 0, ask: 0, deny: 0 };
    for (const entry of fnCorpus.entries) {
      const { decision } = classify(entry.command);
      dist[decision] = (dist[decision] || 0) + 1;
      if (decision === 'allow') allow += 1;
    }
    expect(fnCorpus.entries.length).toBe(80);
    expect(allow).toBe(0);
    // Distribution is informational, asserted to lock the closure shape.
    expect(dist.deny + dist.ask).toBe(80);
  });
});

// ===========================================================================
// Gate 3 — the lattice_wins set is EXACTLY {row 7}
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-002: adjudication integrity (lattice_wins is exactly {row 7})', () => {
  it('exactly one row carries adjudication:lattice_wins, and it is row 7', () => {
    const wins = fnCorpus.entries.filter((e) => e.adjudication === 'lattice_wins');
    expect(wins.map((e) => e.source_row)).toEqual([7]);
  });

  it('the lattice_wins row diverges from its corpus_proposed_decision as documented', () => {
    const row7 = fnCorpus.entries.find((e) => e.source_row === 7);
    expect(row7.corpus_proposed_decision).toBe('deny');
    expect(row7.expected_final_decision).toBe('ask');
    const { decision } = classify(row7.command);
    expect(decision).toBe('ask'); // the live lattice agrees with the reconciled expectation
  });

  it('contrast: prod scope from -n production (a real token) still denies', () => {
    // row 8 — proves the lattice_wins is about a NAME substring, not prod scope
    // detection being broken: a genuine `-n production` standalone token denies.
    const { decision } = classify('kubectl delete pod app-service-1 -n production');
    expect(decision).toBe('deny');
  });
});

// ===========================================================================
// Gate 4 — portability-negative: 100% allow (no new dev-loop overblock)
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-002: portability-negative (routine dev-loop stays allow)', () => {
  portability.entries.forEach((entry) => {
    it(`[${entry.tier}] ${entry.command.slice(0, 52)} -> allow`, () => {
      const { decision } = classify(entry.command);
      expect(decision).toBe('allow');
    });
  });

  it('every portability row was baseline-allow (corpus integrity)', () => {
    // Guards the corpus name's honesty: a row that was not baseline-allow does
    // not belong in a "100% allow" portability set.
    for (const e of portability.entries) {
      expect(e.baseline_decision).toBe('allow');
      expect(e.expected_decision).toBe('allow');
    }
  });
});

// ===========================================================================
// Gate 5 — sidecar fails CLOSED through the active CLI path
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-002: sidecar fail-closed through the active pass', () => {
  let tmpRepo;

  beforeAll(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'caps-sidecar-'));
    fs.mkdirSync(path.join(tmpRepo, '.caws'), { recursive: true });
  });
  afterAll(() => {
    if (tmpRepo) fs.rmSync(tmpRepo, { recursive: true, force: true });
  });

  function writeSidecar(content) {
    fs.writeFileSync(path.join(tmpRepo, '.caws', 'command-adapters.json'), content);
  }

  it('malformed sidecar (invalid JSON) + an unknown extension-dependent command -> ask, not allow', () => {
    writeSidecar('{ this is not valid json');
    // `frobnicate deploy prod` is not covered by any built-in adapter, so absent
    // a (valid) sidecar it would be allow. With a MALFORMED sidecar the pass must
    // fail closed to ask, never silently degrade to allow.
    const { decision } = classify('frobnicate deploy prod', tmpRepo);
    expect(decision).toBe('ask');
  });

  it('malformed sidecar still lets BUILT-IN dangerous commands get their correct decision', () => {
    writeSidecar('{ broken');
    // Built-ins do not depend on the sidecar; a kubectl namespace delete must
    // still deny even while the sidecar is broken (fail-closed != fail-blind).
    const { decision } = classify('kubectl delete namespace prod', tmpRepo);
    expect(decision).toBe('deny');
  });

  it('sidecar with a nested policy-shaped key (over-authority) -> fail closed -> ask on extension cmd', () => {
    // Authority boundary: a sidecar must not carry a decision/policy key. The
    // loader rejects it into an error state, so an extension-dependent command
    // fails closed.
    writeSidecar(
      JSON.stringify({
        version: 1,
        adapters: {
          frobnicate: {
            subcommands: [
              { path: ['deploy'], facets: { kind: 'MUTATE', decision: 'allow' } },
            ],
          },
        },
      })
    );
    const { decision } = classify('frobnicate deploy prod', tmpRepo);
    expect(decision).toBe('ask');
  });

  it('a VALID sidecar adds a new adapter (alias->facet) and the lattice acts on it', () => {
    // Positive control: proves the fail-closed cases above are about the ERROR
    // state, not the sidecar being ignored wholesale.
    writeSidecar(
      JSON.stringify({
        version: 1,
        adapters: {
          frobnicate: {
            subcommands: [
              {
                path: ['deploy'],
                facets: {
                  kind: 'DESTROY',
                  domain: 'cloud',
                  reversibility: 'irreversible',
                  blast_radius: 'single',
                },
              },
            ],
          },
        },
      })
    );
    const { decision } = classify('frobnicate deploy myapp', tmpRepo);
    expect(decision).toBe('deny'); // DESTROY + irreversible -> deny, from the user adapter
  });
});

// ===========================================================================
// Gate 6 — schema rejects nested policy-shaped keys
// ===========================================================================
describe('HOOK-CAPABILITY-ENGINE-002: adapter schema rejects over-authority', () => {
  const SCHEMA = path.join(REPO_ROOT, '.caws', 'command-adapters.schema.json');

  it('the schema file exists and forbids additional properties on a facet row', () => {
    expect(fs.existsSync(SCHEMA)).toBe(true);
    const schema = JSON.parse(fs.readFileSync(SCHEMA, 'utf8'));
    // Walk to the facets object definition and assert additionalProperties:false
    // somewhere governs facet rows (defense-in-depth alongside the loader's
    // runtime nested-key rejection asserted in Gate 5).
    const text = JSON.stringify(schema);
    expect(text).toContain('additionalProperties');
    // The schema must not permit a decision/policy outcome key in facets.
    expect(text).not.toContain('"decision"');
  });
});
