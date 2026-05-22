/**
 * SPEC-SCOPE-OVERBROAD-OUT-DETECTION-001 — A7
 *
 * Scan every spec under this repo's .caws/specs/ via loadSpecs and check
 * for spec.semantic.scope.overbroad_out diagnostics. Per A7 the test must
 * EITHER find zero offenders OR every emitting spec must be named in
 * KNOWN_OFFENDERS with a reason. This surfaces latent same-spec
 * contradictions predictably so a future agent does not get blocked by a
 * pre-existing defect mid-implementation.
 *
 * The slice deliberately does NOT amend offending specs. Surfaced latent
 * defects become operator/maintainer work after this slice closes.
 *
 * A synthetic fixture verifies that the wiring from loadSpecs through
 * the kernel's validateSpecSemantics actually surfaces the diagnostic
 * with the named-field shape; this guards against future refactors that
 * might drop the rule on the floor.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSpecs } = require('../../dist/store');

const OVERBROAD_OUT_RULE = 'spec.semantic.scope.overbroad_out';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_CAWS_DIR = path.join(REPO_ROOT, '.caws');

// Specs that are known to emit the rule and have an explicit reason. Keep
// this list empty unless a maintainer has classified the entry. The
// presence of an entry here means: "we have looked at this spec, the
// defect is real, the fix is operator work, and this slice is not the
// fix." Removing an entry once its spec is repaired is expected.
const KNOWN_OFFENDERS = Object.freeze({
  // Example shape (kept commented so the structure is obvious):
  //   'SPEC-FOO-001': 'reason: <classification>; tracked-by: <followup id>',
});

describe('A7 — repo-wide scan for spec.semantic.scope.overbroad_out', () => {
  it('every emitting spec under .caws/specs/ is classified in KNOWN_OFFENDERS', () => {
    // Hard-fail early if the repo layout has shifted in a way that would
    // silently make this test pass against the wrong directory.
    expect(fs.existsSync(path.join(REPO_CAWS_DIR, 'specs'))).toBe(true);

    const r = loadSpecs(REPO_CAWS_DIR);

    const offenders = r.diagnostics
      .filter((d) => d.rule === OVERBROAD_OUT_RULE)
      .map((d) => ({
        // Per specs-store.ts, when the kernel diagnostic does not carry
        // a subject, the store wraps it with the offending file path.
        // The kernel does set subject = the shadowed scope.in entry, so
        // we derive the spec by reading the file path from d.data when
        // present, or by falling back to subject for the file form.
        spec_in_shadowed: d.data?.scope_in_shadowed,
        spec_out_prefix: d.data?.scope_out_prefix,
        subject: d.subject,
      }));

    // Group by the underlying spec file. We don't have the file path on
    // the kernel diagnostic (subject is the shadowed scope.in entry, not
    // the spec yaml file), so we re-derive the offending spec id by
    // scanning the diagnostics array for ones whose data block fingerprint
    // matches a spec in r.specs's NOT-loaded set. Simpler: collect the
    // raw file scan independently.
    const offendingFiles = collectOffendingSpecFiles(r.diagnostics);

    const unclassified = Object.keys(offendingFiles).filter(
      (specId) => !(specId in KNOWN_OFFENDERS)
    );

    if (unclassified.length > 0) {
      // Provide a maximally useful failure message: list every unclassified
      // offender with its full diagnostic data, so the operator can either
      // (a) add it to KNOWN_OFFENDERS with a reason, or (b) repair the
      // spec. This slice itself does neither — A7 is detection only.
      const detail = unclassified
        .map(
          (specId) =>
            `  - ${specId}\n` +
            offendingFiles[specId]
              .map(
                (d) =>
                  `      scope_out_prefix="${d.scope_out_prefix}" shadows scope_in_shadowed="${d.scope_in_shadowed}"`
              )
              .join('\n')
        )
        .join('\n');
      throw new Error(
        `A7: ${unclassified.length} spec(s) under .caws/specs/ emit ${OVERBROAD_OUT_RULE} but are not in KNOWN_OFFENDERS. Either repair each spec (remove or narrow the broad scope.out, OR move the documentary exclusion to a future non_goals field) OR — if remediation is deferred — add the spec id to KNOWN_OFFENDERS in this test file with a classification reason. Detection is this slice's responsibility; remediation is separate operator work.\n${detail}`
      );
    }

    // Also count the offenders so a future spec landing the rule but
    // already being in KNOWN_OFFENDERS still surfaces as a non-zero
    // assertion if KNOWN_OFFENDERS drifts out of sync with reality.
    expect(unclassified).toEqual([]);

    // Belt-and-suspenders: if KNOWN_OFFENDERS is empty AND we found any
    // diagnostic at all, the test would have failed above. Re-state the
    // expectation in counted form for output clarity.
    if (Object.keys(KNOWN_OFFENDERS).length === 0) {
      expect(offenders).toEqual([]);
    }
  });
});

describe('A7 wiring — loadSpecs surfaces spec.semantic.scope.overbroad_out through the kernel boundary', () => {
  // This is a small synthetic guard so a future refactor of specs-store
  // or validate-semantics that drops the rule on the floor would be
  // caught here even if the real repo's specs happen to be clean.
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('emits exactly one diagnostic with named scope_out_prefix and scope_in_shadowed fields', () => {
    cawsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-a7-wiring-'));
    fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });

    // Minimal valid spec shape that hits the rule once.
    const yaml = [
      'id: TEST-OVERBROAD-001',
      "title: A reasonably long title that satisfies the schema minimum",
      'risk_tier: 3',
      'mode: chore',
      'lifecycle_state: draft',
      'blast_radius:',
      '  modules:',
      '    - src/test',
      'scope:',
      '  in:',
      '    - src/foo/bar.ts',
      '  out:',
      '    - src/foo',
      'invariants:',
      '  - "Some invariant statement."',
      'acceptance:',
      '  - id: A1',
      '    given: a precondition',
      '    when: an action',
      '    then: an outcome',
      'non_functional: {}',
      'contracts: []',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cawsDir, 'specs', 'TEST-OVERBROAD-001.yaml'), yaml);

    const r = loadSpecs(cawsDir);

    const offenders = r.diagnostics.filter((d) => d.rule === OVERBROAD_OUT_RULE);
    expect(offenders).toHaveLength(1);
    expect(offenders[0].data).toMatchObject({
      scope_out_prefix: 'src/foo',
      scope_in_shadowed: 'src/foo/bar.ts',
    });

    // The kernel marks the spec invalid when this rule fires, so it
    // should NOT appear in the loaded-specs list. (loadSpecs collects
    // validation failures into diagnostics; valid specs only land in
    // r.specs.)
    expect(r.specs.map((s) => s.id)).not.toContain('TEST-OVERBROAD-001');
  });

  it('A4 cross-spec — two separate specs with admit-vs-refuse across spec boundaries do NOT trigger the rule', () => {
    cawsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-a7-cross-'));
    fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });

    const specA = [
      'id: TEST-A4-AAA-001',
      "title: SpecA admits a/b/c.ts in scope.in, no overlap with its own scope.out",
      'risk_tier: 3',
      'mode: chore',
      'lifecycle_state: draft',
      'blast_radius:',
      '  modules:',
      '    - a/b',
      'scope:',
      '  in:',
      '    - a/b/c.ts',
      'invariants:',
      '  - "SpecA invariant."',
      'acceptance:',
      '  - id: A1',
      '    given: a precondition',
      '    when: an action',
      '    then: an outcome',
      'non_functional: {}',
      'contracts: []',
      '',
    ].join('\n');
    const specB = [
      'id: TEST-A4-BBB-001',
      "title: SpecB denies a/b in scope.out and has its own disjoint scope.in",
      'risk_tier: 3',
      'mode: chore',
      'lifecycle_state: draft',
      'blast_radius:',
      '  modules:',
      '    - other',
      'scope:',
      '  in:',
      '    - other/thing.ts',
      '  out:',
      '    - a/b',
      'invariants:',
      '  - "SpecB invariant."',
      'acceptance:',
      '  - id: A1',
      '    given: a precondition',
      '    when: an action',
      '    then: an outcome',
      'non_functional: {}',
      'contracts: []',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(cawsDir, 'specs', 'TEST-A4-AAA-001.yaml'), specA);
    fs.writeFileSync(path.join(cawsDir, 'specs', 'TEST-A4-BBB-001.yaml'), specB);

    const r = loadSpecs(cawsDir);

    // Neither spec should emit the rule: SpecA has no scope.out at all,
    // and SpecB's scope.out does not prefix SpecB's own scope.in.
    const offenders = r.diagnostics.filter((d) => d.rule === OVERBROAD_OUT_RULE);
    expect(offenders).toEqual([]);

    // Both specs should load cleanly.
    expect(r.specs.map((s) => s.id).sort()).toEqual([
      'TEST-A4-AAA-001',
      'TEST-A4-BBB-001',
    ]);
  });
});

/**
 * Re-derive the offending spec id for each SCOPE_OVERBROAD_OUT diagnostic
 * by re-reading the .caws/specs/ directory and matching diagnostic data
 * to spec contents. We do this instead of plumbing the source file
 * through the kernel diagnostic because the kernel's subject field is
 * the shadowed scope.in entry (per the rule's contract) — the file path
 * is only attached by the store when the kernel left subject unset, and
 * for this rule the kernel always sets it.
 */
function collectOffendingSpecFiles(diagnostics) {
  const overbroad = diagnostics.filter((d) => d.rule === OVERBROAD_OUT_RULE);
  if (overbroad.length === 0) return {};

  const specsDir = path.join(REPO_CAWS_DIR, 'specs');
  const files = fs.readdirSync(specsDir).filter((n) => n.endsWith('.yaml') || n.endsWith('.yml'));
  const byId = {};
  for (const f of files) {
    const full = path.join(specsDir, f);
    const text = fs.readFileSync(full, 'utf8');
    const idMatch = text.match(/^id:\s*(\S+)/m);
    if (!idMatch) continue;
    const id = idMatch[1];
    for (const d of overbroad) {
      const scopeIn = d.data?.scope_in_shadowed;
      const scopeOut = d.data?.scope_out_prefix;
      if (!scopeIn || !scopeOut) continue;
      // A spec file owns this diagnostic if both the shadowing scope.out
      // entry AND the shadowed scope.in entry appear in its text. This
      // is a heuristic (string match in the YAML source), but the
      // entries are exact strings the kernel echoed back, so collisions
      // would require literally identical scope arrays across specs.
      if (text.includes(scopeIn) && text.includes(scopeOut)) {
        if (!byId[id]) byId[id] = [];
        byId[id].push({ scope_out_prefix: scopeOut, scope_in_shadowed: scopeIn });
      }
    }
  }
  return byId;
}
