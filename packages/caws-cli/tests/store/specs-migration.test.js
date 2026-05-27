/**
 * Tests for specs-migration — CAWS-MIGRATE-V10-SPECS-001 acceptance A8-A11.
 *
 * Covers the CLI store layer of the specs migrator:
 *   A8: runSpecsMigrateScan — read-only scan, three-bucket distribution,
 *       non_yaml observations (markdown_sidecar + unknown_non_yaml),
 *       skips registry.json, skips .archive/ subdir, refuses on
 *       unreadable specs dir.
 *   A9: runSpecsMigrateApply with apply=true, partial=false refuses
 *       when any verdict is 'refused'; zero writes; directory byte-
 *       identical before and after.
 *   A10: apply=true, partial=true writes only migratable, skips
 *       refused, writes the durable report per the contract schema.
 *   A11: post-write validation guard — a migrated spec that fails
 *       parseAndValidateSpec is rolled back (file byte-identical to
 *       pre-call) and the report records verdict=
 *       'post_write_validation_failed'.
 *
 * Test discipline:
 *   - All fixtures are constructed inline as YAML strings (no
 *     committed fixture files — that's commit 5).
 *   - Each test gets its own tmpdir via os.tmpdir() + a per-test
 *     subdirectory; cleanup via fs.rmSync(..., { recursive: true }).
 *   - Time injection: opts.now is always a fixed Date so the report
 *     filename is deterministic.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  runSpecsMigrateScan,
  runSpecsMigrateApply,
  MIGRATION_REPORT_SCHEMA_VERSION,
} = require('../../dist/store/specs-migration');

const FIXED_NOW = new Date('2026-05-26T20:45:00.000Z');

// ─── Test fixtures ──────────────────────────────────────────────────────

// A v10 spec with every safe-rename source field — should migrate
// cleanly (kind: migrated_with_warnings — the warnings are the renames).
// risk_tier: T3 (coerces to integer 3) chosen deliberately — T1/T2 would
// trigger the v11 semantic gate TIER{1,2}_MISSING_CONTRACTS at post-write
// validation when contracts: [] (see A11 test for the deliberate-fail
// counterpart).
// `created:` is set to a full ISO date-time because the v11 schema
// requires `created_at` (the renamed field) to be `format: date-time`.
// Real Sterling-shape v10 specs often use bare dates (YYYY-MM-DD),
// which would fail post-write validation under the current transformer.
// Follow-up: commit 5 fixture corpus should include at least one bare-
// date case so we can decide whether to add a v10→v11 date-time
// coercion in the transformer, or document it as a manual operator edit.
const V10_HAPPY = `
id: TEST-V10-001
title: a happy v10 spec
status: active
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
created: '2026-01-01T00:00:00.000Z'
risk_tier: T3
blast_radius:
  modules:
    - pkg/foo
scope:
  in:
    - pkg/foo/bar.ts
non_functional:
  a11y:
    - keyboard navigation
  perf:
    - p95 < 500ms
contracts: []
invariants:
  - the migrator preserves authority intent
`.trim();

// A v10 spec with blast_radius.modules: [] — A5 refusal class.
const V10_REFUSED = `
id: TEST-V10-REFUSED
title: a refused v10 spec
status: active
type: feature
mode: feature
acceptance_criteria: []
risk_tier: 2
blast_radius:
  modules: []
scope:
  in:
    - pkg/x/a.ts
    - pkg/x/b.ts
non_functional: {}
contracts: []
invariants: []
`.trim();

// An already-v11 spec — scan should silently exclude it (A7
// idempotency guard at the kernel level + store-side
// detectSpecVersion check).
const V11_NOOP = `
id: TEST-V11-NOOP
title: already v11
lifecycle_state: active
mode: feature
risk_tier: 3
blast_radius:
  modules:
    - pkg/y
scope:
  in:
    - pkg/y/foo.ts
non_functional: {}
contracts: []
invariants: []
acceptance: []
`.trim();

// ─── Test helpers ──────────────────────────────────────────────────────

function makeTempCaws() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-migrate-test-'));
  const cawsDir = path.join(dir, '.caws');
  fs.mkdirSync(path.join(cawsDir, 'specs'), { recursive: true });
  return { rootDir: dir, cawsDir };
}

function writeSpec(cawsDir, name, content) {
  fs.writeFileSync(path.join(cawsDir, 'specs', name), content);
}

function readSpec(cawsDir, name) {
  return fs.readFileSync(path.join(cawsDir, 'specs', name), 'utf8');
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function cleanup(rootDir) {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {}
}

// ─── A8: Scan ───────────────────────────────────────────────────────────

describe('A8: runSpecsMigrateScan', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  it('classifies a v10 happy-path spec as migrated_with_warnings', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.distribution).toEqual({
      migrated: 0,
      migrated_with_warnings: 1,
      refused: 0,
      total: 1,
    });
    expect(r.value.entries[0].spec_id).toBe('TEST-V10-001');
    expect(r.value.entries[0].outcome.kind).toBe('migrated_with_warnings');
  });

  it('classifies a v10 spec with empty modules as refused', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'refused.yaml', V10_REFUSED);

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.distribution).toEqual({
      migrated: 0,
      migrated_with_warnings: 0,
      refused: 1,
      total: 1,
    });
    expect(r.value.entries[0].outcome.kind).toBe('refused');
  });

  it('silently excludes already-v11 specs from the distribution counts', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    writeSpec(tmp.cawsDir, 'noop.yaml', V11_NOOP);

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.distribution.total).toBe(1);
    expect(r.value.entries.map((e) => e.spec_id)).toEqual(['TEST-V10-001']);
  });

  it('reports *.md files as markdown_sidecar non_yaml observations', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    fs.writeFileSync(path.join(tmp.cawsDir, 'specs', 'README.md'), '# notes');

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.non_yaml).toEqual([
      { file: '.caws/specs/README.md', kind: 'markdown_sidecar' },
    ]);
  });

  it('reports non-.md non-.yaml files as unknown_non_yaml', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    fs.writeFileSync(path.join(tmp.cawsDir, 'specs', 'leftover.txt'), 'x');

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.non_yaml).toEqual([
      { file: '.caws/specs/leftover.txt', kind: 'unknown_non_yaml' },
    ]);
  });

  it('silently ignores registry.json (CLI bookkeeping, not an observation)', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    fs.writeFileSync(path.join(tmp.cawsDir, 'specs', 'registry.json'), '{}');

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    expect(r.value.non_yaml).toEqual([]);
  });

  it('does NOT recurse into subdirectories (skips .archive/)', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    fs.mkdirSync(path.join(tmp.cawsDir, 'specs', '.archive'));
    fs.writeFileSync(
      path.join(tmp.cawsDir, 'specs', '.archive', 'old.yaml'),
      V10_HAPPY,
    );

    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.ok).toBe(true);
    // Only one entry — the .archive/old.yaml is NOT visited.
    expect(r.value.distribution.total).toBe(1);
    expect(r.value.entries[0].file).toBe('.caws/specs/happy.yaml');
  });

  it('returns err with SPECS_MIGRATE_SCAN_FAILED on unreadable specs dir', () => {
    tmp = makeTempCaws();
    // Point to a non-existent directory.
    const r = runSpecsMigrateScan({
      cawsDir: path.join(tmp.rootDir, 'no-such-dir'),
      from: 'v10',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.scan_failed');
  });

  it('returns a deterministic sha256 old_digest for each entry', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.value.entries[0].old_digest).toBe(sha256(V10_HAPPY));
  });
});

// ─── A9: Apply refuses on any refused (without --partial) ──────────────

describe('A9: apply without --partial refuses if any spec is refused', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  it('returns err when at least one spec is refused; zero files written', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    writeSpec(tmp.cawsDir, 'refused.yaml', V10_REFUSED);
    const happyBefore = readSpec(tmp.cawsDir, 'happy.yaml');
    const refusedBefore = readSpec(tmp.cawsDir, 'refused.yaml');

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: false,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.refusals_present');
    // Files byte-identical to pre-call state.
    expect(readSpec(tmp.cawsDir, 'happy.yaml')).toBe(happyBefore);
    expect(readSpec(tmp.cawsDir, 'refused.yaml')).toBe(refusedBefore);
    // No report directory created.
    expect(
      fs.existsSync(path.join(tmp.cawsDir, 'migrations', 'v10-specs')),
    ).toBe(false);
  });

  it('error data includes refused count and first refused file', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'refused.yaml', V10_REFUSED);
    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: false,
      now: FIXED_NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].data).toEqual({
      refused_count: 1,
      total: 1,
      first_refused: '.caws/specs/refused.yaml',
    });
  });
});

// ─── A10: Apply --partial writes migratable, skips refused, durable report ─

describe('A10: apply --partial writes migratable, skips refused', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  it('rewrites only the auto-migratable specs in place', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    writeSpec(tmp.cawsDir, 'refused.yaml', V10_REFUSED);
    const refusedBefore = readSpec(tmp.cawsDir, 'refused.yaml');

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    // refused.yaml is byte-identical.
    expect(readSpec(tmp.cawsDir, 'refused.yaml')).toBe(refusedBefore);
    // happy.yaml is NOT byte-identical (it was migrated).
    expect(readSpec(tmp.cawsDir, 'happy.yaml')).not.toBe(V10_HAPPY);
    // The migrated file has v11 fields, not v10.
    const migrated = readSpec(tmp.cawsDir, 'happy.yaml');
    expect(migrated).toContain('lifecycle_state:');
    expect(migrated).toContain('acceptance:');
    expect(migrated).not.toContain('\nstatus:');
    expect(migrated).not.toContain('\nacceptance_criteria:');
  });

  it('writes a durable report to .caws/migrations/v10-specs/<ISO>.json', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.report_path).not.toBeNull();
    expect(fs.existsSync(r.value.report_path)).toBe(true);
    // Filename uses Windows-safe ISO (colons → hyphens).
    expect(r.value.report_path).toMatch(/2026-05-26T20-45-00\.000Z\.json$/);
  });

  it('report contents match the contract schema (schema_version, command, distribution, entries)', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    writeSpec(tmp.cawsDir, 'refused.yaml', V10_REFUSED);

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    const reportJson = JSON.parse(fs.readFileSync(r.value.report_path, 'utf8'));
    expect(reportJson.schema_version).toBe(MIGRATION_REPORT_SCHEMA_VERSION);
    expect(reportJson.generated_at).toBe('2026-05-26T20:45:00.000Z');
    expect(reportJson.command).toBe('caws specs migrate --from v10 --apply --partial');
    expect(reportJson.distribution).toEqual({
      migrated: 0,
      migrated_with_warnings: 1,
      refused: 1,
      total: 2,
      post_write_validation_failed: 0,
    });
    expect(reportJson.entries).toHaveLength(2);
    const happyEntry = reportJson.entries.find((e) => e.spec_id === 'TEST-V10-001');
    const refusedEntry = reportJson.entries.find((e) => e.spec_id === 'TEST-V10-REFUSED');
    expect(happyEntry.verdict).toBe('migrated_with_warnings');
    expect(happyEntry.new_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(happyEntry.safe_renames.length).toBeGreaterThan(0);
    expect(refusedEntry.verdict).toBe('refused');
    expect(refusedEntry.new_digest).toBeNull();
    expect(refusedEntry.refusal_reasons).toContain(
      'spec.migrate.blast_radius_modules_empty',
    );
  });

  it('dry-run (apply=false) writes NOTHING to disk but produces a report in memory', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'happy.yaml', V10_HAPPY);
    const before = readSpec(tmp.cawsDir, 'happy.yaml');

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: false,
      partial: false,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    expect(r.value.report_path).toBeNull();
    expect(readSpec(tmp.cawsDir, 'happy.yaml')).toBe(before);
    expect(
      fs.existsSync(path.join(tmp.cawsDir, 'migrations')),
    ).toBe(false);
    // In-memory report still has the entries.
    expect(r.value.report.entries).toHaveLength(1);
    expect(r.value.report.entries[0].verdict).toBe('migrated_with_warnings');
  });
});

// ─── A11: Post-write validation rollback ────────────────────────────────

describe('A11: post-write validation rollback', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  // To deterministically trigger post-write validation failure, supply a
  // v10 spec with a transformer-output mode/lifecycle combination that
  // the canonical v11 validator will reject. Tier-2 specs require
  // contracts; a tier-2 spec with contracts: [] will pass the
  // transformer but fail parseAndValidateSpec (semantic layer
  // TIER2_MISSING_CONTRACTS). This proves the canonical validator IS
  // what runs as the post-write gate (not a softer copy).
  const V10_TIER2_NO_CONTRACTS = `
id: TEST-A11
title: tier 2 missing contracts
status: active
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
risk_tier: 2
blast_radius:
  modules:
    - pkg/foo
scope:
  in:
    - pkg/foo/bar.ts
non_functional: {}
contracts: []
invariants: []
`.trim();

  it('records post_write_validation_failed and rolls back the file', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'bad.yaml', V10_TIER2_NO_CONTRACTS);
    const before = readSpec(tmp.cawsDir, 'bad.yaml');
    const beforeDigest = sha256(before);

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    // File byte-identical to pre-call state.
    expect(readSpec(tmp.cawsDir, 'bad.yaml')).toBe(before);
    expect(sha256(readSpec(tmp.cawsDir, 'bad.yaml'))).toBe(beforeDigest);
    // Report records the rollback.
    const reportJson = JSON.parse(fs.readFileSync(r.value.report_path, 'utf8'));
    const entry = reportJson.entries[0];
    expect(entry.verdict).toBe('post_write_validation_failed');
    expect(entry.new_digest).toBeNull();
    expect(entry.post_write_validation_errors.length).toBeGreaterThan(0);
    expect(reportJson.distribution.post_write_validation_failed).toBe(1);
  });
});

// ─── Hardening commit 3.1: substrate assertion ────────────────────────

describe('substrate assertion (commit 3.1)', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  it('refuses cawsDir whose basename is not ".caws"', () => {
    tmp = makeTempCaws();
    // Pass the repo root (parent of .caws) — basename is the tmpdir name.
    const r = runSpecsMigrateScan({
      cawsDir: tmp.rootDir,
      from: 'v10',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.scan_failed');
    expect(r.errors[0].data.expected).toBe('.caws');
  });

  it('refuses empty cawsDir', () => {
    const r = runSpecsMigrateScan({ cawsDir: '', from: 'v10' });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.scan_failed');
  });

  it('refuses cawsDir pointing at a subdirectory of .caws (e.g. specs/)', () => {
    tmp = makeTempCaws();
    const r = runSpecsMigrateScan({
      cawsDir: path.join(tmp.cawsDir, 'specs'),
      from: 'v10',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.scan_failed');
    expect(r.errors[0].data.basename).toBe('specs');
  });

  it('apply inherits the substrate refusal (does not write anything)', () => {
    tmp = makeTempCaws();
    const r = runSpecsMigrateApply({
      cawsDir: tmp.rootDir, // wrong
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0].rule).toBe('store.specs.migrate.scan_failed');
    // Nothing under tmp.rootDir/.caws/migrations was created.
    expect(
      fs.existsSync(path.join(tmp.cawsDir, 'migrations')),
    ).toBe(false);
  });
});

// ─── Hardening commit 3.1: end-to-end apply with lifecycle mapping ─────

describe('end-to-end apply with lifecycle mapping (commit 3.1)', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  // Same shape as V10_HAPPY but with status: superseded so a mapping
  // is required. id is v11-pattern-valid (TEST-LIFECYCLE-002) and
  // every field is filled so post-write validation passes after the
  // mapping is applied.
  const V10_SUPERSEDED_FULL = `
id: TEST-LIFECYCLE-002
title: superseded but mappable
status: superseded
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
created: '2026-01-01T00:00:00.000Z'
risk_tier: T3
blast_radius:
  modules:
    - pkg/x
scope:
  in:
    - pkg/x/foo.ts
non_functional: {}
contracts: []
invariants:
  - the mapping is operator-controlled
`.trim();

  it('apply --partial with mapping writes the migrated file with mapped lifecycle_state', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'mapped.yaml', V10_SUPERSEDED_FULL);

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
      lifecycleMapping: {
        'TEST-LIFECYCLE-002': {
          lifecycle_state: 'archived',
          // v11 schema semantic rule: closed/archived specs require a
          // resolution. The mapping is operator-owned; operators must
          // supply resolution alongside lifecycle_state when they map
          // a v10 'superseded'/'proven'/'frozen' to a v11 terminal state.
          resolution: 'superseded',
          closure_notes: 'superseded by Y',
        },
      },
    });

    expect(r.ok).toBe(true);
    // The on-disk file has lifecycle_state: archived + closure_notes.
    const written = readSpec(tmp.cawsDir, 'mapped.yaml');
    expect(written).toContain('lifecycle_state: archived');
    expect(written).toContain('resolution: superseded');
    expect(written).toContain('closure_notes: superseded by Y');
    expect(written).not.toContain('status:');
    // Report records lifecycle_mapping_used.
    const reportJson = JSON.parse(fs.readFileSync(r.value.report_path, 'utf8'));
    const entry = reportJson.entries[0];
    expect(entry.verdict).toBe('migrated_with_warnings');
    expect(entry.lifecycle_mapping_used).toEqual({
      lifecycle_state: 'archived',
      resolution: 'superseded',
      closure_notes: 'superseded by Y',
    });
    // No false post-write-validation failure.
    expect(reportJson.distribution.post_write_validation_failed).toBe(0);
  });
});

// ─── Hardening commit 3.1: bare-date created coercion end-to-end ───────

describe('bare-date created coercion end-to-end (commit 3.1)', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  const V10_BARE_DATE = `
id: TEST-BARE-DATE-001
title: bare date created
status: active
type: feature
mode: feature
acceptance_criteria:
  - id: A1
    given: x
    when: y
    then: z
created: '2026-01-01'
risk_tier: T3
blast_radius:
  modules:
    - pkg/x
scope:
  in:
    - pkg/x/foo.ts
non_functional: {}
contracts: []
invariants:
  - bare-date coercion is deterministic
`.trim();

  it('apply --partial coerces bare-date created to ISO date-time on disk', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'bare.yaml', V10_BARE_DATE);

    const r = runSpecsMigrateApply({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      apply: true,
      partial: true,
      now: FIXED_NOW,
    });

    expect(r.ok).toBe(true);
    const written = readSpec(tmp.cawsDir, 'bare.yaml');
    // Coerced to midnight UTC.
    expect(written).toContain("'2026-01-01T00:00:00.000Z'");
    // Bare date NOT present (it was replaced, not appended).
    expect(written).not.toMatch(/created_at: '2026-01-01'\n/);
    // Report records the coercion + zero post-write failures.
    const reportJson = JSON.parse(fs.readFileSync(r.value.report_path, 'utf8'));
    expect(reportJson.distribution.post_write_validation_failed).toBe(0);
    expect(reportJson.distribution.migrated_with_warnings).toBe(1);
    const entry = reportJson.entries[0];
    const createdAtCoercion = entry.coercions.find(
      (c) => c.field === 'created_at',
    );
    expect(createdAtCoercion).toEqual({
      field: 'created_at',
      from: '2026-01-01',
      to: '2026-01-01T00:00:00.000Z',
    });
  });
});

// ─── Sanity: lifecycle mapping plumbed through to the kernel ──────────

describe('lifecycle mapping plumbed through to transformer', () => {
  let tmp;
  afterEach(() => tmp && cleanup(tmp.rootDir));

  const V10_SUPERSEDED = `
id: TEST-LIFECYCLE
title: superseded spec
status: superseded
type: feature
mode: feature
acceptance_criteria: []
risk_tier: 3
blast_radius:
  modules:
    - pkg/x
scope:
  in:
    - pkg/x/foo.ts
non_functional: {}
contracts: []
invariants: []
`.trim();

  it('without mapping: refuses with lifecycle_unmapped', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'superseded.yaml', V10_SUPERSEDED);
    const r = runSpecsMigrateScan({ cawsDir: tmp.cawsDir, from: 'v10' });
    expect(r.value.distribution.refused).toBe(1);
    const reasons = r.value.entries[0].outcome.reasons.map((d) => d.rule);
    expect(reasons).toContain('spec.migrate.lifecycle_unmapped');
  });

  it('with mapping: migrates successfully', () => {
    tmp = makeTempCaws();
    writeSpec(tmp.cawsDir, 'superseded.yaml', V10_SUPERSEDED);
    const r = runSpecsMigrateScan({
      cawsDir: tmp.cawsDir,
      from: 'v10',
      lifecycleMapping: {
        'TEST-LIFECYCLE': { lifecycle_state: 'archived' },
      },
    });
    expect(r.value.distribution.refused).toBe(0);
    expect(r.value.distribution.migrated_with_warnings).toBe(1);
  });
});
