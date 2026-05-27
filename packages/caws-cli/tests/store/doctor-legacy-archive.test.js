/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001 — A10 verification.
 *
 * Doctor emits a WARN finding for legacy .caws/specs/.archive/ yaml
 * bodies, pointing the operator at `caws specs prune-archive`.
 *
 * Asserts:
 *   - Finding rule:     doctor.archive.legacy_bodies_present
 *   - Severity:         warning
 *   - Message includes: file count + reference to prune-archive
 *   - .unrecoverable/   subdir is EXCLUDED from the count
 *   - When .archive/    is absent or empty → NO finding
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { initProject, composeDoctorSnapshot } = require('../../dist/store');
const { inspectProjectState } = require('@paths.design/caws-kernel');

// ─── Fixture helpers ───────────────────────────────────────────────────

function mkCawsGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@test.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test User']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  const result = initProject(root);
  if (!result.ok) throw new Error('initProject failed in fixture');
  execFileSync('git', ['-C', root, 'add', '.caws/']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'chore: bootstrap caws']);
  return { root, cawsDir: path.join(root, '.caws') };
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function runDoctor(cawsDir) {
  const { doctorInput } = composeDoctorSnapshot({
    cawsDir,
    repoRoot: path.dirname(cawsDir),
    now: new Date('2026-05-27T23:30:00.000Z'),
  });
  return inspectProjectState(doctorInput);
}

const STUB_BODY = `id: STUB-001
title: x
risk_tier: 3
mode: chore
lifecycle_state: archived
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-01T00:00:00.000Z'
blast_radius:
  modules:
    - x
  data_migration: false
operational_rollback_slo: 5m
scope:
  in:
    - x
  out: []
invariants:
  - x
acceptance:
  - id: A1
    given: x
    when: x
    then: x
non_functional: {}
contracts: []
`;

// ─── A10: legacy archive findings ──────────────────────────────────────

describe('A10: doctor surfaces legacy .caws/specs/.archive/ bodies', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('emits ARCHIVE_LEGACY_BODIES_PRESENT WARN when bodies are present', () => {
    fixture = mkCawsGitRepo('a10-');
    const archiveDir = path.join(fixture.cawsDir, 'specs', '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, 'OLD-001.yaml'), STUB_BODY);
    fs.writeFileSync(path.join(archiveDir, 'OLD-002.yaml'), STUB_BODY);
    fs.writeFileSync(path.join(archiveDir, 'OLD-003.yml'), STUB_BODY);

    const report = runDoctor(fixture.cawsDir);
    const legacy = report.findings.filter(
      (f) => f.rule === 'doctor.archive.legacy_bodies_present'
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].severity).toBe('warning');
    expect(legacy[0].message).toMatch(/3 legacy archived spec bodies/);
    expect(legacy[0].narrowRepair).toMatch(/caws specs prune-archive --dry-run/);
    expect(legacy[0].data.legacy_body_count).toBe(3);
  });

  it('EXCLUDES .unrecoverable/ subdir from the count', () => {
    fixture = mkCawsGitRepo('a10b-');
    const archiveDir = path.join(fixture.cawsDir, 'specs', '.archive');
    const unrecoverableDir = path.join(archiveDir, '.unrecoverable');
    fs.mkdirSync(unrecoverableDir, { recursive: true });
    // 1 top-of-archive body + 3 quarantined bodies. Count should be 1.
    fs.writeFileSync(path.join(archiveDir, 'TOP-001.yaml'), STUB_BODY);
    fs.writeFileSync(path.join(unrecoverableDir, 'Q-001.yaml'), STUB_BODY);
    fs.writeFileSync(path.join(unrecoverableDir, 'Q-002.yaml'), STUB_BODY);
    fs.writeFileSync(path.join(unrecoverableDir, 'Q-003.yaml'), STUB_BODY);

    const report = runDoctor(fixture.cawsDir);
    const legacy = report.findings.filter(
      (f) => f.rule === 'doctor.archive.legacy_bodies_present'
    );
    expect(legacy).toHaveLength(1);
    expect(legacy[0].data.legacy_body_count).toBe(1);
    expect(legacy[0].message).toMatch(/1 legacy archived spec body/);
  });

  it('emits NO finding when .archive/ is absent', () => {
    fixture = mkCawsGitRepo('a10c-');
    // No .archive/ dir created.

    const report = runDoctor(fixture.cawsDir);
    const legacy = report.findings.filter(
      (f) => f.rule === 'doctor.archive.legacy_bodies_present'
    );
    expect(legacy).toHaveLength(0);
  });

  it('emits NO finding when .archive/ exists but contains only .unrecoverable/', () => {
    fixture = mkCawsGitRepo('a10d-');
    fs.mkdirSync(
      path.join(fixture.cawsDir, 'specs', '.archive', '.unrecoverable'),
      { recursive: true }
    );

    const report = runDoctor(fixture.cawsDir);
    const legacy = report.findings.filter(
      (f) => f.rule === 'doctor.archive.legacy_bodies_present'
    );
    expect(legacy).toHaveLength(0);
  });
});
