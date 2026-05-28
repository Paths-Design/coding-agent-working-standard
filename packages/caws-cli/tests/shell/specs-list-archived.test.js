/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001 — A6, A7 verification.
 *
 * `caws specs list`:
 *   A6: default (no --include-archived) → active + draft only;
 *       archived specs NOT listed even when events exist.
 *   A7: --include-archived → reads from event log (not .archive/
 *       directory walk), shows the archived section with blob_sha
 *       prefix + recover hint per entry.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsCloseCommand,
  runSpecsArchiveCommand,
  runSpecsListCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store');

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

function capture(fn, opts) {
  const out = [];
  const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

/**
 * Seed a fixture with 2 active specs + 1 archived spec.
 *   ACTIVE-001, ACTIVE-002: active (created + still alive).
 *   ARCHIVED-001: created → closed → archived (tombstone shape;
 *                 body gone from disk).
 */
function seedMixed(prefix) {
  const fixture = mkCawsGitRepo(prefix);
  for (const id of ['ACTIVE-001', 'ACTIVE-002']) {
    capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id,
      title: `${id} title`,
      mode: 'chore',
      riskTier: 3,
    });
  }
  capture(runSpecsCreateCommand, {
    cwd: fixture.root,
    id: 'ARCHIVED-001',
    title: 'will-be-archived',
    mode: 'chore',
    riskTier: 3,
  });
  capture(runSpecsCloseCommand, {
    cwd: fixture.root,
    id: 'ARCHIVED-001',
    resolution: 'completed',
  });
  capture(runSpecsArchiveCommand, {
    cwd: fixture.root,
    id: 'ARCHIVED-001',
  });
  return fixture;
}

// ─── A6: list default (no --include-archived) ───────────────────────────

describe('A6: caws specs list (default)', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('lists active specs only; archived specs are NOT shown', () => {
    fixture = seedMixed('a6-');

    const r = capture(runSpecsListCommand, { cwd: fixture.root });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('ACTIVE-001');
    expect(r.stdout).toContain('ACTIVE-002');
    expect(r.stdout).not.toContain('ARCHIVED-001');
    expect(r.stdout).not.toContain('archived');
  });
});

// ─── A7: list --include-archived ───────────────────────────────────────

describe('A7: caws specs list --include-archived', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('shows active + a separate archived section with blob_sha + recover hint', () => {
    fixture = seedMixed('a7-');

    const r = capture(runSpecsListCommand, {
      cwd: fixture.root,
      includeArchived: true,
    });

    expect(r.code).toBe(0);
    // Active specs present.
    expect(r.stdout).toContain('ACTIVE-001');
    expect(r.stdout).toContain('ACTIVE-002');
    // Archived section header.
    expect(r.stdout).toContain('-- archived (recoverable from history) --');
    // Archived entry: shows id + blob prefix + recover hint.
    expect(r.stdout).toContain('ARCHIVED-001');
    expect(r.stdout).toMatch(/blob [0-9a-f]{8}/);
    expect(r.stdout).toContain('recover: caws specs recover ARCHIVED-001');
  });

  it('does NOT walk .caws/specs/.archive/ — reads from event log only', () => {
    fixture = seedMixed('a7b-');
    // Post-tombstone, .archive/ should not exist; even if it does
    // (legacy migration in progress), the list command does NOT
    // surface it. We simulate the worst case: a hand-written legacy
    // body in .archive/ that is NOT in the event log → list should
    // still NOT report it as archived.
    const archiveDir = path.join(fixture.cawsDir, 'specs', '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveDir, 'LEGACY-ONLY-001.yaml'),
      `id: LEGACY-ONLY-001\ntitle: x\nrisk_tier: 3\nmode: chore\nlifecycle_state: archived\n`
    );

    const r = capture(runSpecsListCommand, {
      cwd: fixture.root,
      includeArchived: true,
    });

    expect(r.code).toBe(0);
    // ARCHIVED-001 (in event log) appears.
    expect(r.stdout).toContain('ARCHIVED-001');
    // LEGACY-ONLY-001 (only on disk, no event) does NOT appear.
    expect(r.stdout).not.toContain('LEGACY-ONLY-001');
  });

  it('tombstone identity: re-creating an archived spec_id is refused; archived entry remains visible in list --include-archived', () => {
    // CAWS-SPECS-ARCHIVE-COLLISION-REFUSAL-001 supersedes the previous
    // latest-write-wins behavior. Archived spec ids are tombstoned
    // identities — `caws specs create <id>` refuses if the id has a
    // prior spec_archived event, regardless of whether an active file
    // or registry entry exists. recover is the legitimate path for
    // archived ids.
    fixture = mkCawsGitRepo('a7c-');
    capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id: 'REBORN-001',
      title: 'first incarnation',
      mode: 'chore',
      riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: fixture.root,
      id: 'REBORN-001',
      resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, {
      cwd: fixture.root,
      id: 'REBORN-001',
    });

    // Attempt to re-create with the same id. This MUST refuse.
    const recreate = capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id: 'REBORN-001',
      title: 'second incarnation',
      mode: 'chore',
      riskTier: 3,
    });
    expect(recreate.code).not.toBe(0);
    expect(recreate.stderr).toContain('REBORN-001');
    expect(recreate.stderr).toContain('caws specs recover');

    const r = capture(runSpecsListCommand, {
      cwd: fixture.root,
      includeArchived: true,
    });

    expect(r.code).toBe(0);
    // Active section does NOT contain REBORN-001 (re-create was refused).
    const activeSection = r.stdout.split('-- archived')[0];
    expect(activeSection).not.toContain('second incarnation');
    // Archived section DOES list REBORN-001 (still archived; identity intact).
    const archivedSection = r.stdout.split('-- archived')[1] || '';
    expect(archivedSection).toContain('REBORN-001');
  });
});
