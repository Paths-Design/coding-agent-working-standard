/**
 * CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A4, A5, A6
 *
 * Positive lock (A4): specs-store emits store.specs.non_yaml_skipped
 * with severity 'info' (not 'error') for non-YAML files in
 * .caws/specs/ — including the working-spec.yaml escape branch.
 *
 * Positive lock (A5): waivers-store emits store.waivers.non_yaml_skipped
 * with severity 'info' for non-YAML files in .caws/waivers/.
 *
 * Negative lock (A6): genuine load errors (malformed YAML, I/O failures)
 * retain severity 'error'. The slice did not broadly downgrade load-side
 * severity.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSpecs, loadWaivers, STORE_RULES } = require('../../dist/store');

function mkTempCawsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-severity-recal-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'waivers'), { recursive: true });
  return root;
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}

const VALID_SPEC = `
id: VALID-1
title: A reasonably long title for the feature being shipped
risk_tier: 3
mode: feature
lifecycle_state: draft
blast_radius:
  modules:
    - src/test
scope:
  in:
    - "src/**"
invariants:
  - "Some invariant statement."
acceptance:
  - id: A1
    given: a precondition
    when: an event
    then: an outcome
non_functional: {}
contracts: []
`;

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A4: specs-store non_yaml_skipped → INFO', () => {
  let cawsDir;
  beforeEach(() => { cawsDir = mkTempCawsDir(); });
  afterEach(() => rmrf(cawsDir));

  it('emits store.specs.non_yaml_skipped with severity info for registry.json', () => {
    fs.writeFileSync(path.join(cawsDir, 'specs', 'VALID-1.yaml'), VALID_SPEC);
    fs.writeFileSync(path.join(cawsDir, 'specs', 'registry.json'), '{"_": 1}');

    const result = loadSpecs(cawsDir);

    const skipped = result.diagnostics.filter(
      (d) => d.rule === STORE_RULES.SPECS_NON_YAML_SKIPPED,
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe('info');
    expect(skipped[0].message).toMatch(/registry\.json/);
    expect(result.specs).toHaveLength(1);
  });

  it('emits INFO for multiple non-YAML files (README.md, *.preflight.md)', () => {
    fs.writeFileSync(path.join(cawsDir, 'specs', 'VALID-1.yaml'), VALID_SPEC);
    fs.writeFileSync(path.join(cawsDir, 'specs', 'README.md'), '# Specs');
    fs.writeFileSync(path.join(cawsDir, 'specs', 'CAWS-FOO.preflight.md'), '## Preflight');

    const result = loadSpecs(cawsDir);

    const skipped = result.diagnostics.filter(
      (d) => d.rule === STORE_RULES.SPECS_NON_YAML_SKIPPED,
    );
    expect(skipped).toHaveLength(2);
    // ALL skipped diagnostics are INFO — no per-file severity drift.
    for (const d of skipped) {
      expect(d.severity).toBe('info');
    }
  });

  it('emits INFO for the working-spec.yaml legacy guard (vNext-forbidden path)', () => {
    // Even the explicit-guard branch (working-spec.yaml) is a
    // by-design skip — operator's expected action is to remove the
    // legacy file, NOT to treat it as a load failure.
    fs.writeFileSync(path.join(cawsDir, 'specs', 'working-spec.yaml'), 'id: LEGACY');

    const result = loadSpecs(cawsDir);

    const skipped = result.diagnostics.filter(
      (d) => d.rule === STORE_RULES.SPECS_NON_YAML_SKIPPED,
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe('info');
    expect(skipped[0].message).toMatch(/working-spec\.yaml/);
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A5: waivers-store non_yaml_skipped → INFO', () => {
  let cawsDir;
  beforeEach(() => { cawsDir = mkTempCawsDir(); });
  afterEach(() => rmrf(cawsDir));

  it('emits store.waivers.non_yaml_skipped with severity info for non-YAML files in .caws/waivers/', () => {
    fs.writeFileSync(path.join(cawsDir, 'waivers', 'README.md'), '# Waivers');

    const result = loadWaivers(cawsDir);

    const skipped = result.diagnostics.filter(
      (d) => d.rule === STORE_RULES.WAIVERS_NON_YAML_SKIPPED,
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe('info');
    expect(skipped[0].message).toMatch(/README\.md/);
  });
});

describe('CAWS-DOCTOR-SEVERITY-RECALIBRATION-001 A6: real load errors retain ERROR (negative lock)', () => {
  let cawsDir;
  beforeEach(() => { cawsDir = mkTempCawsDir(); });
  afterEach(() => rmrf(cawsDir));

  it('malformed YAML in a spec file still produces an ERROR diagnostic', () => {
    // Genuine parse failure: invalid YAML indentation + unclosed quote.
    const broken = `id: BROKEN\n  bad-indent: '\n risk_tier: 3`;
    fs.writeFileSync(path.join(cawsDir, 'specs', 'BROKEN.yaml'), broken);

    const result = loadSpecs(cawsDir);

    // The skipped-rule must NOT fire for a real YAML.
    const skipped = result.diagnostics.filter(
      (d) => d.rule === STORE_RULES.SPECS_NON_YAML_SKIPPED,
    );
    expect(skipped).toHaveLength(0);

    // At least one ERROR diagnostic must surface (rule may be a
    // parse error, validate error, or YAML source error — the
    // contract is severity, not rule id).
    const errors = result.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });
});
