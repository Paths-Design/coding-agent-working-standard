/**
 * Tests for `runSpecsMigrateCommand` — CAWS-MIGRATE-V10-SPECS-001
 * commit 4 (shell adapter).
 *
 * Adapter discipline:
 *   - This file does NOT exercise transformer semantics directly. The
 *     kernel (tests/unit/migrate-v10.test.ts) and store
 *     (tests/store/specs-migration.test.js) own those.
 *   - These tests confirm: (1) the shell parses flags correctly,
 *     (2) delegates to the store, (3) renders output deterministically,
 *     (4) refuses --from values other than v10, (5) loads the
 *     lifecycle-mapping file from disk and surfaces composition errors,
 *     (6) preserves the store's report shape verbatim in --json mode.
 *
 * Pinned exit codes:
 *   0 = success (dry-run completed OR --apply succeeded)
 *   1 = store-layer refusal (substrate, refusals_present, --from-not-v10)
 *   2 = composition failure (repo-root resolve, lifecycle-mapping file)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { runSpecsMigrateCommand } = require('../../dist/shell');

const NOW = new Date('2026-05-26T22:30:00.000Z');

// ─── Fixtures ──────────────────────────────────────────────────────────

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
non_functional: {}
contracts: []
invariants:
  - shell adapter delegates to the store
`.trim();

const V10_REFUSED = `
id: TEST-V10-REF-001
title: blast_radius modules empty
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
non_functional: {}
contracts: []
invariants:
  - shell adapter delegates to the store
`.trim();

// ─── Helpers ───────────────────────────────────────────────────────────

function mkTempRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.mkdirSync(path.join(root, '.caws', 'specs'), { recursive: true });
  return root;
}

function writeSpec(repoRoot, name, content) {
  fs.writeFileSync(path.join(repoRoot, '.caws', 'specs', name), content);
}

function cleanup(rootDir) {
  try {
    fs.rmSync(rootDir, { recursive: true, force: true });
  } catch {}
}

function captureRun(opts) {
  const out = [];
  const err = [];
  const code = runSpecsMigrateCommand({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    now: () => NOW,
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// ─── --from validation ──────────────────────────────────────────────────

describe('--from validation', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('refuses --from value other than v10 (exit 1)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const r = captureRun({ cwd: repo, from: 'v9' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('only --from v10 is supported');
    expect(r.stderr).toContain('"v9"');
  });

  it('refuses --from empty string (exit 1)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const r = captureRun({ cwd: repo, from: '' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('only --from v10');
  });
});

// ─── Default dry-run ────────────────────────────────────────────────────

describe('default dry-run (no --apply)', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('scans, prints summary, writes nothing to disk (exit 0)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'happy.yaml', V10_HAPPY);
    const before = fs.readFileSync(path.join(repo, '.caws/specs/happy.yaml'), 'utf8');

    const r = captureRun({ cwd: repo, from: 'v10' });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[dry-run]');
    expect(r.stdout).toContain('migrated_with_warnings=1');
    expect(r.stdout).toContain('refused=0');
    expect(r.stdout).toContain('total=1');
    expect(r.stdout).toContain('(dry-run; not persisted)');
    // File byte-identical: dry-run is read-only.
    const after = fs.readFileSync(path.join(repo, '.caws/specs/happy.yaml'), 'utf8');
    expect(after).toBe(before);
    // No migrations directory created.
    expect(fs.existsSync(path.join(repo, '.caws', 'migrations'))).toBe(false);
  });

  it('renders the per-entry summary with verdict tags', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'happy.yaml', V10_HAPPY);
    writeSpec(repo, 'refused.yaml', V10_REFUSED);

    const r = captureRun({ cwd: repo, from: 'v10' });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('WARN  .caws/specs/happy.yaml (TEST-V10-001) — migrated_with_warnings');
    expect(r.stdout).toContain('REF   .caws/specs/refused.yaml (TEST-V10-REF-001) — refused');
    expect(r.stdout).toContain('reason: spec.migrate.blast_radius_modules_empty');
  });
});

// ─── --apply (no --partial) refusal ─────────────────────────────────────

describe('--apply without --partial refuses on any refused', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('refuses, writes nothing, exits 1', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'happy.yaml', V10_HAPPY);
    writeSpec(repo, 'refused.yaml', V10_REFUSED);
    const happyBefore = fs.readFileSync(path.join(repo, '.caws/specs/happy.yaml'), 'utf8');

    const r = captureRun({ cwd: repo, from: 'v10', apply: true });

    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed');
    // Spec files unchanged.
    expect(fs.readFileSync(path.join(repo, '.caws/specs/happy.yaml'), 'utf8')).toBe(happyBefore);
    // No report directory.
    expect(fs.existsSync(path.join(repo, '.caws', 'migrations'))).toBe(false);
  });
});

// ─── --apply --partial writes migratable + emits report ─────────────────

describe('--apply --partial', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('rewrites migratable, skips refused, emits durable report (exit 0)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'happy.yaml', V10_HAPPY);
    writeSpec(repo, 'refused.yaml', V10_REFUSED);
    const refusedBefore = fs.readFileSync(path.join(repo, '.caws/specs/refused.yaml'), 'utf8');

    const r = captureRun({ cwd: repo, from: 'v10', apply: true, partial: true });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('[apply]');
    expect(r.stdout).toContain('refused=1');
    expect(r.stdout).toContain('migrated_with_warnings=1');
    expect(r.stdout).toContain('report: .caws/migrations/v10-specs/');
    // Happy file was rewritten.
    const happyAfter = fs.readFileSync(path.join(repo, '.caws/specs/happy.yaml'), 'utf8');
    expect(happyAfter).toContain('lifecycle_state:');
    expect(happyAfter).not.toContain('\nstatus:');
    // Refused file untouched.
    expect(fs.readFileSync(path.join(repo, '.caws/specs/refused.yaml'), 'utf8')).toBe(refusedBefore);
    // Report on disk.
    const reportDir = path.join(repo, '.caws/migrations/v10-specs');
    expect(fs.existsSync(reportDir)).toBe(true);
    const reports = fs.readdirSync(reportDir);
    expect(reports.length).toBe(1);
  });
});

// ─── --lifecycle-mapping file loading ───────────────────────────────────

describe('--lifecycle-mapping file', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  const V10_SUPERSEDED = `
id: TEST-SUP-001
title: superseded
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
  - shell loads the mapping
`.trim();

  it('loads the mapping JSON and threads it to the store (exit 0)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'sup.yaml', V10_SUPERSEDED);
    const mappingPath = path.join(repo, 'mapping.json');
    fs.writeFileSync(
      mappingPath,
      JSON.stringify({
        'TEST-SUP-001': {
          lifecycle_state: 'archived',
          resolution: 'superseded',
          closure_notes: 'replaced by Y',
        },
      }),
    );

    const r = captureRun({
      cwd: repo,
      from: 'v10',
      apply: true,
      partial: true,
      lifecycleMappingPath: mappingPath,
    });

    expect(r.code).toBe(0);
    const written = fs.readFileSync(path.join(repo, '.caws/specs/sup.yaml'), 'utf8');
    expect(written).toContain('lifecycle_state: archived');
    expect(written).toContain('resolution: superseded');
    expect(written).toContain('closure_notes: replaced by Y');
  });

  it('exit 2 when mapping file is missing', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const r = captureRun({
      cwd: repo,
      from: 'v10',
      lifecycleMappingPath: path.join(repo, 'no-such-file.json'),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('failed to load --lifecycle-mapping');
    expect(r.stderr).toContain('Cannot read');
  });

  it('exit 2 when mapping file is malformed JSON', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const mappingPath = path.join(repo, 'bad.json');
    fs.writeFileSync(mappingPath, '{ not json');
    const r = captureRun({
      cwd: repo,
      from: 'v10',
      lifecycleMappingPath: mappingPath,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Cannot parse');
  });

  it('exit 2 when mapping is a JSON array (not an object)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const mappingPath = path.join(repo, 'arr.json');
    fs.writeFileSync(mappingPath, '[]');
    const r = captureRun({
      cwd: repo,
      from: 'v10',
      lifecycleMappingPath: mappingPath,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('must be a JSON object');
  });

  it('exit 2 when mapping entry lacks lifecycle_state', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    const mappingPath = path.join(repo, 'incomplete.json');
    fs.writeFileSync(mappingPath, JSON.stringify({ 'X-001': { foo: 'bar' } }));
    const r = captureRun({
      cwd: repo,
      from: 'v10',
      lifecycleMappingPath: mappingPath,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing required string field "lifecycle_state"');
  });
});

// ─── --json mode preserves store report shape ───────────────────────────

describe('--json mode', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('emits a single JSON object containing the store report verbatim', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'happy.yaml', V10_HAPPY);

    const r = captureRun({ cwd: repo, from: 'v10', json: true });

    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.report.schema_version).toBe(1);
    expect(parsed.report.command).toBe('caws specs migrate --from v10');
    expect(parsed.report.distribution.migrated_with_warnings).toBe(1);
    expect(parsed.report.entries[0].spec_id).toBe('TEST-V10-001');
    expect(parsed.report.entries[0].verdict).toBe('migrated_with_warnings');
    // Dry-run: no report_path.
    expect(parsed.report_path).toBeNull();
  });

  it('emits ok:false JSON on store refusal (not text to stderr)', () => {
    repo = mkTempRepo('caws-shell-migrate-');
    writeSpec(repo, 'refused.yaml', V10_REFUSED);

    const r = captureRun({ cwd: repo, from: 'v10', apply: true, json: true });

    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].rule).toBe('store.specs.migrate.refusals_present');
    expect(parsed.errors[0].data.refused_count).toBe(1);
    // Stderr should be empty in --json mode (machine readability).
    expect(r.stderr).toBe('');
  });
});

// ─── Substrate inheritance from store ───────────────────────────────────

describe('substrate refusal inherited from store', () => {
  let repo;
  afterEach(() => repo && cleanup(repo));

  it('store-layer scan failure surfaces as exit 1 with the store rule code', () => {
    // No .caws/specs/ directory at all → store SPECS_MIGRATE_SCAN_FAILED.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-shell-migrate-no-caws-'));
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@test.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test']);
    fs.mkdirSync(path.join(repo, '.caws'), { recursive: true });
    // .caws/ exists but specs/ does not.

    const r = captureRun({ cwd: repo, from: 'v10' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('failed');
  });
});
