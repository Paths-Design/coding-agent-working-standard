/**
 * Tests for specs-store: multi-spec-only loading, working-spec.yaml
 * forbidden, duplicate-id detection, non-YAML skipped.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadSpecs, STORE_RULES } = require('../../dist/store');

function mkTempCawsDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-specs-store-'));
  fs.mkdirSync(path.join(root, 'specs'), { recursive: true });
  return root;
}

function writeSpec(cawsDir, name, body) {
  fs.writeFileSync(path.join(cawsDir, 'specs', name), body);
}

const VALID_SPEC = (id) => `
id: ${id}
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
    when: an action
    then: an outcome
non_functional: {}
contracts: []
`;

describe('loadSpecs — happy path', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('loads multiple valid specs from .caws/specs/*.yaml', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'FOO-1.yaml', VALID_SPEC('FOO-1'));
    writeSpec(cawsDir, 'BAR-2.yaml', VALID_SPEC('BAR-2'));
    const r = loadSpecs(cawsDir);
    expect(r.specs).toHaveLength(2);
    expect(r.specs.map((s) => s.id).sort()).toEqual(['BAR-2', 'FOO-1']);
    expect(r.diagnostics).toEqual([]);
  });

  it('returns empty when .caws/specs/ does not exist', () => {
    cawsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-specs-empty-'));
    // intentionally do NOT create specs/
    const r = loadSpecs(cawsDir);
    expect(r.specs).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });

  it('returns empty when .caws/specs/ exists but is empty', () => {
    cawsDir = mkTempCawsDir();
    const r = loadSpecs(cawsDir);
    expect(r.specs).toEqual([]);
    expect(r.diagnostics).toEqual([]);
  });
});

describe('loadSpecs — failure modes', () => {
  let cawsDir;
  afterEach(() => fs.rmSync(cawsDir, { recursive: true, force: true }));

  it('explicitly refuses working-spec.yaml', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'working-spec.yaml', VALID_SPEC('LEGACY-1'));
    const r = loadSpecs(cawsDir);
    expect(r.specs).toEqual([]);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0].rule).toBe(STORE_RULES.SPECS_NON_YAML_SKIPPED);
    expect(r.diagnostics[0].message).toMatch(/working spec/i);
  });

  it('skips non-YAML files with a soft diagnostic', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'FOO-1.yaml', VALID_SPEC('FOO-1'));
    writeSpec(cawsDir, 'README.md', '# readme');
    const r = loadSpecs(cawsDir);
    expect(r.specs.map((s) => s.id)).toEqual(['FOO-1']);
    expect(
      r.diagnostics.some(
        (d) => d.rule === STORE_RULES.SPECS_NON_YAML_SKIPPED && d.subject.endsWith('README.md')
      )
    ).toBe(true);
  });

  it('reports duplicate spec ids; first occurrence wins', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'AA-FIRST.yaml', VALID_SPEC('DUPE-1'));
    writeSpec(cawsDir, 'ZZ-SECOND.yaml', VALID_SPEC('DUPE-1'));
    const r = loadSpecs(cawsDir);
    expect(r.specs).toHaveLength(1);
    const dupe = r.diagnostics.find((d) => d.rule === STORE_RULES.SPECS_DUPLICATE_ID);
    expect(dupe).toBeDefined();
    expect(dupe.data.spec_id).toBe('DUPE-1');
    expect(dupe.data.first_seen).toMatch(/AA-FIRST\.yaml$/);
    expect(dupe.data.duplicate).toMatch(/ZZ-SECOND\.yaml$/);
  });

  it('collects kernel validation diagnostics for invalid specs and continues', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'GOOD.yaml', VALID_SPEC('GOOD-1'));
    writeSpec(cawsDir, 'BROKEN.yaml', 'this: : is: not: valid: yaml: :');
    const r = loadSpecs(cawsDir);
    // The valid spec still made it through.
    expect(r.specs.map((s) => s.id)).toEqual(['GOOD-1']);
    // Some diagnostic was raised for the broken file.
    expect(r.diagnostics.length).toBeGreaterThan(0);
    const found = r.diagnostics.find((d) =>
      typeof d.subject === 'string' && d.subject.endsWith('BROKEN.yaml')
    );
    expect(found).toBeDefined();
  });

  it('determinism: same inputs → same output order', () => {
    cawsDir = mkTempCawsDir();
    writeSpec(cawsDir, 'A.yaml', VALID_SPEC('A-1'));
    writeSpec(cawsDir, 'B.yaml', VALID_SPEC('B-1'));
    writeSpec(cawsDir, 'C.yaml', VALID_SPEC('C-1'));
    const a = loadSpecs(cawsDir);
    const b = loadSpecs(cawsDir);
    expect(a.specs.map((s) => s.id)).toEqual(b.specs.map((s) => s.id));
  });
});
