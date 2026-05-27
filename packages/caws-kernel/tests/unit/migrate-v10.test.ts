// CAWS-MIGRATE-V10-SPECS-001 — kernel transformer unit tests.
//
// Covers acceptance A1-A7 from the spec. Every test runs against
// hand-constructed v10 input objects (no filesystem fixtures); fixture
// corpus tests live in the CLI store layer (A8+).

import {
  detectSpecVersion,
  KNOWN_REPORT_ONLY_TOP_LEVEL,
  MIGRATE_RULES,
  migrateSpecV10,
  NF_SUBKEY_RENAMES,
  RISK_TIER_COERCIONS,
  SAFE_RENAMES,
  V11_LIFECYCLE_STATES,
  V11_MODES,
} from '../../src/spec/migrate-v10';

// --- A1: surface exports + zero-import guarantee --------------------------

describe('A1: kernel surface', () => {
  it('exports the discriminated-union constructor migrateSpecV10', () => {
    expect(typeof migrateSpecV10).toBe('function');
  });

  it('exports the pure classifier detectSpecVersion', () => {
    expect(typeof detectSpecVersion).toBe('function');
  });

  it('exposes SAFE_RENAMES, NF_SUBKEY_RENAMES, RISK_TIER_COERCIONS as stable constants', () => {
    expect(SAFE_RENAMES.map((r) => r.from)).toEqual([
      'status', 'acceptance_criteria', 'created',
    ]);
    expect(SAFE_RENAMES.map((r) => r.to)).toEqual([
      'lifecycle_state', 'acceptance', 'created_at',
    ]);
    expect(NF_SUBKEY_RENAMES).toEqual([
      { from: 'a11y', to: 'accessibility' },
      { from: 'perf', to: 'performance' },
    ]);
    expect(RISK_TIER_COERCIONS.get('T1')).toBe(1);
    expect(RISK_TIER_COERCIONS.get('T3')).toBe(3);
    expect(RISK_TIER_COERCIONS.size).toBe(6);
  });

  it('exposes V11 mode and lifecycle enums', () => {
    expect([...V11_MODES].sort()).toEqual(['chore', 'doc', 'feature', 'fix', 'refactor']);
    expect([...V11_LIFECYCLE_STATES].sort()).toEqual(['active', 'archived', 'closed', 'draft']);
  });

  it('exposes MIGRATE_RULES with namespaced refusal/warning codes', () => {
    for (const v of Object.values(MIGRATE_RULES)) {
      expect(v).toMatch(/^spec\.migrate\./);
    }
  });

  it('KNOWN_REPORT_ONLY_TOP_LEVEL includes Sterling-observed dropped fields (recon + 7.1 smoke)', () => {
    // Round 1 — Sterling 27-spec recon (commit 2 / 3.1)
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('change_budget')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('bounded_claim')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('description')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('type')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('feature_id')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('success_criteria')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('human_override')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('reasoning_engine')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('tools')).toBe(true);
    // Round 2 — commit 7 Sterling real-checkout smoke (560 specs).
    // Before 7.1 these caused 38/38 migratable specs to PWF on
    // spec.schema.violation. Adding them to the allowlist routes
    // them through the delete + warning + reportOnly branch.
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('target')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('migrations')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('threats')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('dependencies')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('related_specs')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('related_docs')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('kind')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('test_strategy')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('closure_path')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('determinism')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('fail_closed')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('byte_identity')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('acceptance_criteria_summary')).toBe(true);
    expect(KNOWN_REPORT_ONLY_TOP_LEVEL.has('authority_boundary')).toBe(true);
  });

  it('migrate-v10 module has zero filesystem/network/process imports', () => {
    // Static check: load the source and grep for forbidden imports.
    // Per invariant 2 the transformer is pure.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/spec/migrate-v10.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]node:fs['"]/);
    expect(src).not.toMatch(/from ['"]node:path['"]/);
    expect(src).not.toMatch(/from ['"]node:child_process['"]/);
    expect(src).not.toMatch(/from ['"]node:os['"]/);
    expect(src).not.toMatch(/from ['"]node:net['"]/);
    expect(src).not.toMatch(/from ['"]node:https?['"]/);
    expect(src).not.toMatch(/process\.env/);
    expect(src).not.toMatch(/process\.cwd/);
    expect(src).not.toMatch(/Date\.now/);
  });
});

// --- detectSpecVersion ----------------------------------------------------

describe('detectSpecVersion', () => {
  it('classifies a typical v10 spec by status alone', () => {
    expect(detectSpecVersion({ id: 'X', status: 'draft' })).toBe('v10');
  });

  it('classifies a typical v10 spec by acceptance_criteria alone', () => {
    expect(detectSpecVersion({ id: 'X', acceptance_criteria: [] })).toBe('v10');
  });

  it('classifies as v10 when mixed (v10 wins on any v10 marker)', () => {
    expect(
      detectSpecVersion({
        id: 'X',
        status: 'draft',
        lifecycle_state: 'active',
      }),
    ).toBe('v10');
  });

  it('classifies a v11 spec by lifecycle_state alone', () => {
    expect(
      detectSpecVersion({ id: 'X', lifecycle_state: 'active' }),
    ).toBe('v11');
  });

  it('classifies a v11 spec by mode alone', () => {
    expect(detectSpecVersion({ id: 'X', mode: 'feature' })).toBe('v11');
  });

  it('returns unknown for empty object', () => {
    expect(detectSpecVersion({})).toBe('unknown');
  });

  it('returns unknown for non-object inputs', () => {
    expect(detectSpecVersion(null)).toBe('unknown');
    expect(detectSpecVersion(undefined)).toBe('unknown');
    expect(detectSpecVersion('string')).toBe('unknown');
    expect(detectSpecVersion(42)).toBe('unknown');
    expect(detectSpecVersion([])).toBe('unknown');
  });

  it('treats bare type field as v10 only when no v11 markers present', () => {
    expect(detectSpecVersion({ id: 'X', type: 'feature' })).toBe('v10');
    expect(detectSpecVersion({ id: 'X', type: 'feature', mode: 'feature' })).toBe('v11');
  });
});

// --- A2: safe-rename happy path -------------------------------------------

describe('A2: safe-rename happy path', () => {
  const v10Input = {
    id: 'TEST-001',
    title: 'happy path',
    status: 'active',
    acceptance_criteria: [{ id: 'A1', given: 'x', when: 'y', then: 'z' }],
    created: '2026-01-01',
    risk_tier: 'T2',
    mode: 'feature',
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    non_functional: {
      a11y: ['some a11y requirement'],
      perf: ['some perf requirement'],
    },
    contracts: [],
    invariants: [],
  };

  it('renames top-level v10 fields to v11 equivalents', () => {
    const r = migrateSpecV10(v10Input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('migrated_with_warnings');
    if (r.value.kind !== 'migrated_with_warnings') return;
    const out = r.value.value;
    expect(out['lifecycle_state']).toBe('active');
    expect(out['acceptance']).toEqual([
      { id: 'A1', given: 'x', when: 'y', then: 'z' },
    ]);
    // Bare-date created → coerced to ISO date-time at midnight UTC
    // (commit 3.1 hardening). Original date-only input is preserved
    // in outcome.coercions and a CREATED_AT_COERCED warning is emitted.
    expect(out['created_at']).toBe('2026-01-01T00:00:00.000Z');
    expect('status' in out).toBe(false);
    expect('acceptance_criteria' in out).toBe(false);
    expect('created' in out).toBe(false);
  });

  it('renames non_functional subkeys a11y → accessibility, perf → performance', () => {
    const r = migrateSpecV10(v10Input);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    const nf = r.value.value['non_functional'] as Record<string, unknown>;
    expect(nf['accessibility']).toEqual(['some a11y requirement']);
    expect(nf['performance']).toEqual(['some perf requirement']);
    expect('a11y' in nf).toBe(false);
    expect('perf' in nf).toBe(false);
  });

  it('coerces risk_tier T2 → integer 2', () => {
    const r = migrateSpecV10(v10Input);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    expect(r.value.value['risk_tier']).toBe(2);
    // Both risk_tier T2→2 and created_at bare-date→ISO coercions are
    // recorded (commit 3.1 added the bare-date coercion). Order is
    // determined by the transformer's processing sequence: renames →
    // created_at coercion → non_functional renames → risk_tier
    // coercion. Assert presence, not exact order, to keep the test
    // resilient to future ordering changes that don't affect semantics.
    expect(r.value.coercions).toContainEqual({
      field: 'risk_tier',
      from: 'T2',
      to: 2,
    });
    expect(r.value.coercions).toContainEqual({
      field: 'created_at',
      from: '2026-01-01',
      to: '2026-01-01T00:00:00.000Z',
    });
  });

  it('records each safe rename in safe_renames', () => {
    const r = migrateSpecV10(v10Input);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    const renames = r.value.safe_renames.map((s) => `${s.from}→${s.to}`).sort();
    expect(renames).toEqual([
      'acceptance_criteria→acceptance',
      'created→created_at',
      'non_functional.a11y→non_functional.accessibility',
      'non_functional.perf→non_functional.performance',
      'status→lifecycle_state',
    ]);
  });

  it('captures unhandled v10 fields verbatim in report_only_fields', () => {
    const inputWithCruft = {
      ...v10Input,
      change_budget: { max_files: 10, max_loc: 500 },
      bounded_claim: 'something narrow',
      description: 'long description',
    };
    const r = migrateSpecV10(inputWithCruft);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    expect(r.value.report_only_fields['change_budget']).toEqual({
      max_files: 10,
      max_loc: 500,
    });
    expect(r.value.report_only_fields['bounded_claim']).toBe('something narrow');
    expect(r.value.report_only_fields['description']).toBe('long description');
    // And they should NOT appear in the output spec.
    expect('change_budget' in r.value.value).toBe(false);
    expect('bounded_claim' in r.value.value).toBe(false);
    expect('description' in r.value.value).toBe(false);
  });

  // --- 7.1 Sterling report-only allowlist extension --------------------
  //
  // Before this fix, the 14 Sterling-surfaced v10-only top-level names
  // fell through to the post-write validator which rejected them via
  // spec.v1 additionalProperties:false. That produced PWF=38/38 on the
  // commit 7 real-checkout smoke. Adding them to the allowlist routes
  // them through the delete + warning + reportOnly branch identically
  // to the round-1 names.
  //
  // This test asserts the new behavior for the 14 added fields at once:
  //   (a) the migration succeeds with kind=migrated_with_warnings
  //   (b) every added field is DELETED from the migrated output
  //   (c) every added field is preserved verbatim under
  //       report_only_fields
  //   (d) every added field produces exactly one
  //       spec.migrate.unhandled_field_preserved warning
  //   (e) schema strictness is preserved: the migrated output (with
  //       these fields stripped) is a valid v11 spec (proved via the
  //       post-write validator at the store layer; here we assert the
  //       transformer doesn't smuggle the fields back into output).
  it('routes 7.1 Sterling-surfaced v10 fields through delete + warning + reportOnly', () => {
    const round2Fields = {
      target: { canonical: 'src/foo' },
      migrations: [{ id: 'm1', from: 'old', to: 'new' }],
      threats: ['stride: T-001'],
      dependencies: ['legacy-shim'],
      related_specs: ['SPEC-OTHER-001'],
      related_docs: ['docs/migration.md'],
      kind: 'feature',
      test_strategy: { coverage: '80%' },
      closure_path: { merges_into: 'main' },
      determinism: { seed_locked: true },
      fail_closed: true,
      byte_identity: 'sha256:abc',
      acceptance_criteria_summary: 'two AC, one happy + one error',
      authority_boundary: { kernel: false, store: true },
    };
    const inputWithRound2 = {
      ...v10Input,
      ...round2Fields,
    };
    const r = migrateSpecV10(inputWithRound2);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error(
        `unexpected outcome: ${r.ok ? r.value.kind : JSON.stringify(r.error)}`,
      );
    }

    const out = r.value.value as Record<string, unknown>;
    const reportOnly = r.value.report_only_fields;
    const warningFields = r.value.warnings
      .filter((w) => w.rule === 'spec.migrate.unhandled_field_preserved')
      .map((w) => (w.data as { field: string }).field);

    for (const [field, value] of Object.entries(round2Fields)) {
      // (b) deleted from output
      expect(field in out).toBe(false);
      // (c) preserved verbatim under report_only_fields
      expect(reportOnly[field]).toEqual(value);
      // (d) exactly one unhandled-field warning per field
      expect(warningFields.filter((f) => f === field).length).toBe(1);
    }

    // (e) None of the round-2 names leak back into output via any route
    // (renames, coercions, NF subkeys). Explicitly assert the migrated
    // output's top-level key set is disjoint from round-2 field names.
    const outKeys = new Set(Object.keys(out));
    for (const field of Object.keys(round2Fields)) {
      expect(outKeys.has(field)).toBe(false);
    }
  });
});

// --- created_at bare-date coercion (hardening commit 3.1) ----------------

describe('created_at bare-date coercion', () => {
  const baseV10WithBareDate = {
    id: 'TEST-DATE-001',
    title: 'bare date',
    status: 'active',
    mode: 'feature',
    risk_tier: 3,
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    contracts: [],
    invariants: ['invariant-one'],
    non_functional: {},
    acceptance_criteria: [],
    created: '2026-01-01',
  };

  it('coerces bare YYYY-MM-DD to ISO date-time at midnight UTC', () => {
    const r = migrateSpecV10(baseV10WithBareDate);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('expected migrated_with_warnings');
    }
    expect(r.value.value['created_at']).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records the coercion in outcome.coercions', () => {
    const r = migrateSpecV10(baseV10WithBareDate);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    const coercion = r.value.coercions.find((c) => c.field === 'created_at');
    expect(coercion).toEqual({
      field: 'created_at',
      from: '2026-01-01',
      to: '2026-01-01T00:00:00.000Z',
    });
  });

  it('emits a created_at_coerced warning naming both values', () => {
    const r = migrateSpecV10(baseV10WithBareDate);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    const warning = r.value.warnings.find(
      (d) => d.rule === MIGRATE_RULES.CREATED_AT_COERCED,
    );
    expect(warning).toBeDefined();
    expect(warning?.data).toEqual({
      from: '2026-01-01',
      to: '2026-01-01T00:00:00.000Z',
    });
  });

  it('leaves a valid ISO date-time unchanged (no coercion)', () => {
    const v10 = { ...baseV10WithBareDate, created: '2026-01-01T12:34:56.789Z' };
    const r = migrateSpecV10(v10);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    expect(r.value.value['created_at']).toBe('2026-01-01T12:34:56.789Z');
    // No CREATED_AT_COERCED warning since nothing was coerced.
    const warning = r.value.warnings.find(
      (d) => d.rule === MIGRATE_RULES.CREATED_AT_COERCED,
    );
    expect(warning).toBeUndefined();
    // Coercions list should not have a created_at entry.
    const coercion = r.value.coercions.find((c) => c.field === 'created_at');
    expect(coercion).toBeUndefined();
  });

  it('leaves non-date strings unchanged (post-write validator will reject them)', () => {
    const v10 = { ...baseV10WithBareDate, created: 'yesterday' };
    const r = migrateSpecV10(v10);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    // Transformer does NOT coerce; the post-write validator owns that decision.
    expect(r.value.value['created_at']).toBe('yesterday');
    const coercion = r.value.coercions.find((c) => c.field === 'created_at');
    expect(coercion).toBeUndefined();
  });

  it('rejects impossible bare dates (Feb 30) by returning the value unchanged', () => {
    const v10 = { ...baseV10WithBareDate, created: '2026-02-30' };
    const r = migrateSpecV10(v10);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    // Date.parse returns NaN for invalid dates — coercion declines.
    expect(r.value.value['created_at']).toBe('2026-02-30');
    const coercion = r.value.coercions.find((c) => c.field === 'created_at');
    expect(coercion).toBeUndefined();
  });

  it('does not coerce when created_at is absent', () => {
    const v10 = { ...baseV10WithBareDate };
    delete (v10 as Record<string, unknown>)['created'];
    const r = migrateSpecV10(v10);
    if (!r.ok) throw new Error('expected ok');
    // No created_at in output, no coercion.
    if (r.value.kind === 'refused') throw new Error('unexpected refusal');
    expect('created_at' in r.value.value).toBe(false);
  });
});

// --- A3: mode 'development' footgun + type fallback -----------------------

describe('A3: mode development → type fallback', () => {
  const v10WithDevMode = {
    id: 'TEST-A3',
    title: 'dev mode footgun',
    status: 'active',
    type: 'feature',
    mode: 'development',
    risk_tier: 3,
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    contracts: [],
    invariants: [],
    non_functional: {},
    acceptance_criteria: [],
  };

  it('falls back to type when mode is not in v11 enum', () => {
    const r = migrateSpecV10(v10WithDevMode);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    expect(r.value.value['mode']).toBe('feature');
    expect(r.value.mode_source).toBe('type');
  });

  it('emits mode_overridden_from_type warning naming both values', () => {
    const r = migrateSpecV10(v10WithDevMode);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    const w = r.value.warnings.find(
      (d) => d.rule === MIGRATE_RULES.MODE_OVERRIDDEN_FROM_TYPE,
    );
    expect(w).toBeDefined();
    expect(w?.data).toEqual({
      original_mode: 'development',
      resolved_mode: 'feature',
      source: 'type',
    });
  });

  it('preserves spec.type in report_only_fields and drops it from output', () => {
    const r = migrateSpecV10(v10WithDevMode);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    expect(r.value.report_only_fields['type']).toBe('feature');
    expect('type' in r.value.value).toBe(false);
  });
});

// --- A4: valid mode + valid type that disagree ----------------------------

describe('A4: mode/type disagreement preserves mode', () => {
  const v10Disagreement = {
    id: 'REAL-LEGALITY-B-REVERT-01',
    title: 'mode/type disagree',
    status: 'active',
    type: 'fix',
    mode: 'chore',
    risk_tier: 3,
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    contracts: [],
    invariants: [],
    non_functional: {},
    acceptance_criteria: [],
  };

  it('preserves mode (chore) per v11 authority', () => {
    const r = migrateSpecV10(v10Disagreement);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('unexpected outcome');
    }
    expect(r.value.value['mode']).toBe('chore');
    expect(r.value.mode_source).toBe('mode');
  });

  it('emits mode_type_disagreement warning naming both', () => {
    const r = migrateSpecV10(v10Disagreement);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    const w = r.value.warnings.find(
      (d) => d.rule === MIGRATE_RULES.MODE_TYPE_DISAGREEMENT,
    );
    expect(w).toBeDefined();
    expect(w?.data).toEqual({ mode: 'chore', type: 'fix' });
  });

  it('preserves type verbatim in report_only_fields', () => {
    const r = migrateSpecV10(v10Disagreement);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    expect(r.value.report_only_fields['type']).toBe('fix');
  });
});

// --- A5: blast_radius.modules empty refusal -------------------------------

describe('A5: blast_radius.modules empty → refused, no synthesis', () => {
  const v10EmptyModules = {
    id: 'TEST-A5',
    title: 'empty modules',
    status: 'active',
    mode: 'feature',
    risk_tier: 2,
    blast_radius: { modules: [] },
    scope: { in: ['pkg/x/a.ts', 'pkg/x/b.ts', 'pkg/x/c.ts'] },
    contracts: [],
    invariants: [],
    non_functional: {},
    acceptance_criteria: [],
  };

  it('refuses the spec with blast_radius_modules_empty', () => {
    const r = migrateSpecV10(v10EmptyModules);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe('refused');
    if (r.value.kind !== 'refused') return;
    expect(r.value.reasons.some(
      (d) => d.rule === MIGRATE_RULES.BLAST_RADIUS_MODULES_EMPTY,
    )).toBe(true);
  });

  it('does NOT synthesize modules from scope.in (invariant 1)', () => {
    const r = migrateSpecV10(v10EmptyModules);
    if (!r.ok || r.value.kind !== 'refused') return;
    // Re-attempt with the value extracted — the transformer never
    // produces a `value` field on the refused variant.
    expect('value' in r.value).toBe(false);
  });

  it('includes a narrowRepair explaining synthesis is forbidden', () => {
    const r = migrateSpecV10(v10EmptyModules);
    if (!r.ok || r.value.kind !== 'refused') return;
    const refusal = r.value.reasons.find(
      (d) => d.rule === MIGRATE_RULES.BLAST_RADIUS_MODULES_EMPTY,
    );
    expect(refusal?.narrowRepair).toContain('auto-synthesis from scope.in');
    expect(refusal?.narrowRepair).toContain('intentionally refused');
  });

  it('records spec_id on the refused outcome', () => {
    const r = migrateSpecV10(v10EmptyModules);
    if (!r.ok || r.value.kind !== 'refused') return;
    expect(r.value.spec_id).toBe('TEST-A5');
  });

  it('also refuses when blast_radius itself is missing', () => {
    const noBR = { ...v10EmptyModules };
    delete (noBR as Record<string, unknown>)['blast_radius'];
    const r = migrateSpecV10(noBR);
    if (!r.ok || r.value.kind !== 'refused') {
      throw new Error('expected refused outcome');
    }
    expect(r.value.reasons.some(
      (d) => d.rule === MIGRATE_RULES.BLAST_RADIUS_MODULES_MISSING,
    )).toBe(true);
  });

  it('also refuses when blast_radius.modules is not an array', () => {
    const badBR = { ...v10EmptyModules, blast_radius: { modules: 'pkg/x' } };
    const r = migrateSpecV10(badBR);
    if (!r.ok || r.value.kind !== 'refused') {
      throw new Error('expected refused outcome');
    }
    expect(r.value.reasons.some(
      (d) => d.rule === MIGRATE_RULES.BLAST_RADIUS_MODULES_MISSING,
    )).toBe(true);
  });
});

// --- A6: lifecycle outside v11 enum without mapping → refused -------------

describe('A6: lifecycle unmapped vs. mapped', () => {
  const v10Superseded = {
    id: 'TEST-A6',
    title: 'superseded spec',
    status: 'superseded',
    mode: 'feature',
    risk_tier: 2,
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    contracts: [],
    invariants: [],
    non_functional: {},
    acceptance_criteria: [],
  };

  it('refuses with lifecycle_unmapped when no mapping supplied', () => {
    const r = migrateSpecV10(v10Superseded);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'refused') {
      throw new Error('expected refused outcome');
    }
    const lr = r.value.reasons.find(
      (d) => d.rule === MIGRATE_RULES.LIFECYCLE_UNMAPPED,
    );
    expect(lr).toBeDefined();
    expect(lr?.data).toEqual({ value: 'superseded', spec_id: 'TEST-A6' });
  });

  it('migrates with mapping when operator supplies one', () => {
    const r = migrateSpecV10(v10Superseded, {}, {
      lifecycleMapping: {
        'TEST-A6': {
          lifecycle_state: 'archived',
          closure_notes: 'superseded by Y',
        },
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') {
      throw new Error('expected migrated_with_warnings outcome');
    }
    expect(r.value.value['lifecycle_state']).toBe('archived');
    expect(r.value.value['closure_notes']).toBe('superseded by Y');
    expect(r.value.lifecycle_mapping_used).toEqual({
      lifecycle_state: 'archived',
      closure_notes: 'superseded by Y',
    });
  });

  it('emits lifecycle_mapping_applied warning naming source=mapping', () => {
    const r = migrateSpecV10(v10Superseded, {}, {
      lifecycleMapping: {
        'TEST-A6': { lifecycle_state: 'closed' },
      },
    });
    if (!r.ok || r.value.kind !== 'migrated_with_warnings') return;
    const w = r.value.warnings.find(
      (d) => d.rule === MIGRATE_RULES.LIFECYCLE_MAPPING_APPLIED,
    );
    expect(w).toBeDefined();
    expect(w?.data).toMatchObject({
      original_value: 'superseded',
      source: 'mapping',
    });
  });

  it('ignores mapping for a different spec id (no auto-default leakage)', () => {
    const r = migrateSpecV10(v10Superseded, {}, {
      lifecycleMapping: {
        'OTHER-SPEC': { lifecycle_state: 'closed' },
      },
    });
    if (!r.ok || r.value.kind !== 'refused') {
      throw new Error('expected refused — mapping did not match');
    }
    expect(r.value.reasons.some(
      (d) => d.rule === MIGRATE_RULES.LIFECYCLE_UNMAPPED,
    )).toBe(true);
  });
});

// --- A7: already-v11 idempotency guard ------------------------------------

describe('A7: already-v11 idempotency guard', () => {
  const v11Spec = {
    id: 'TEST-A7',
    title: 'already v11',
    lifecycle_state: 'active',
    mode: 'feature',
    risk_tier: 3,
    blast_radius: { modules: ['pkg/x'] },
    scope: { in: ['pkg/x/foo.ts'] },
    contracts: [],
    invariants: [],
    non_functional: {},
    acceptance: [],
  };

  it('detectSpecVersion returns v11', () => {
    expect(detectSpecVersion(v11Spec)).toBe('v11');
  });

  it('migrateSpecV10 refuses with already_v11_no_migration_needed', () => {
    const r = migrateSpecV10(v11Spec);
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.kind !== 'refused') {
      throw new Error('expected refused');
    }
    expect(r.value.reasons.some(
      (d) => d.rule === MIGRATE_RULES.ALREADY_V11,
    )).toBe(true);
  });

  it('uses severity=info for the idempotency refusal (not error)', () => {
    const r = migrateSpecV10(v11Spec);
    if (!r.ok || r.value.kind !== 'refused') return;
    const refusal = r.value.reasons.find(
      (d) => d.rule === MIGRATE_RULES.ALREADY_V11,
    );
    expect(refusal?.severity).toBe('info');
  });

  it('records spec_id on the idempotency refusal', () => {
    const r = migrateSpecV10(v11Spec);
    if (!r.ok || r.value.kind !== 'refused') return;
    expect(r.value.spec_id).toBe('TEST-A7');
  });
});

// --- Input gate (non-object) ----------------------------------------------

describe('input gate', () => {
  it('returns err for non-object inputs (programmer error class)', () => {
    const r = migrateSpecV10('not an object');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].rule).toBe(MIGRATE_RULES.NOT_AN_OBJECT);
  });

  it('returns err for array inputs', () => {
    const r = migrateSpecV10([1, 2, 3]);
    expect(r.ok).toBe(false);
  });
});

// --- Purity microbenchmark (informational, not enforced) ------------------

describe('purity', () => {
  it('produces identical output for identical input (referential)', () => {
    const input = {
      id: 'PURE-001',
      title: 'pure',
      status: 'active',
      mode: 'feature',
      risk_tier: 2,
      blast_radius: { modules: ['x'] },
      scope: { in: ['x/y.ts'] },
      contracts: [],
      invariants: [],
      non_functional: {},
      acceptance_criteria: [],
    };
    const r1 = migrateSpecV10(input);
    const r2 = migrateSpecV10(input);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
