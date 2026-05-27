/**
 * CAWS-ARCHIVE-AS-TOMBSTONE-001 — A8, A9 verification.
 *
 * Exercises caws specs prune-archive:
 *   A8: dry-run reports per-id recoverable/unrecoverable status with
 *       no mutation.
 *   A9: --apply removes recoverable bodies, quarantines unrecoverable
 *       bodies, emits one spec_archive_pruned event per id.
 *
 * The prove-recovery-or-quarantine invariant is asserted absolute:
 * there is no flag that would let prune delete an unrecoverable body.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsPruneArchiveCommand,
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

function readEvents(cawsDir) {
  const log = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(log)) return [];
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const SPEC_BODY = (id) => `id: ${id}
title: 'legacy archive fixture for prune-archive'
risk_tier: 3
mode: chore
lifecycle_state: archived
resolution: completed
created_at: '2026-05-01T00:00:00.000Z'
updated_at: '2026-05-15T00:00:00.000Z'
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
  - placeholder
acceptance:
  - id: A1
    given: x
    when: x
    then: x
non_functional: {}
contracts: []
`;

/**
 * Seed a fixture with 2 recoverable + 1 unrecoverable archive bodies.
 *   - RECOV-001, RECOV-002: created via the real CLI then their YAML
 *     copies are dropped into .archive/ (simulating the legacy archive
 *     state); they remain reachable via git log because the active
 *     create-and-commit is still in history.
 *   - UNREC-001: a yaml is written directly into .archive/ without
 *     ever being committed at .caws/specs/UNREC-001.yaml — git history
 *     has no commit containing it.
 */
function seedMixedArchive(prefix) {
  const fixture = mkCawsGitRepo(prefix);
  // Recoverable specs: real create commits the active path; we then
  // manually create the legacy .archive/ copy.
  for (const id of ['RECOV-001', 'RECOV-002']) {
    capture(runSpecsCreateCommand, {
      cwd: fixture.root,
      id,
      title: 'recoverable',
      mode: 'chore',
      riskTier: 3,
    });
  }
  // Now drop legacy archive copies (mimics post-legacy-archive state):
  const archiveDir = path.join(fixture.cawsDir, 'specs', '.archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  for (const id of ['RECOV-001', 'RECOV-002']) {
    fs.writeFileSync(
      path.join(archiveDir, `${id}.yaml`),
      SPEC_BODY(id)
    );
  }
  // Unrecoverable: write directly into .archive/, no active commit.
  fs.writeFileSync(
    path.join(archiveDir, 'UNREC-001.yaml'),
    SPEC_BODY('UNREC-001')
  );
  return fixture;
}

// ─── A8: dry-run ───────────────────────────────────────────────────────

describe('A8: caws specs prune-archive (dry-run)', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('reports per-id recoverable/unrecoverable status; no mutation', () => {
    fixture = seedMixedArchive('a8-');
    const archiveDirBefore = fs.readdirSync(
      path.join(fixture.cawsDir, 'specs', '.archive')
    ).sort();
    const eventsBefore = readEvents(fixture.cawsDir).length;

    const r = capture(runSpecsPruneArchiveCommand, {
      cwd: fixture.root,
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Would prune 3 legacy archive bodies');
    expect(r.stdout).toContain('2 recoverable');
    expect(r.stdout).toContain('1 unrecoverable');
    expect(r.stdout).toContain('RECOV-001: RECOVERABLE');
    expect(r.stdout).toContain('would remove');
    expect(r.stdout).toContain('UNREC-001: UNRECOVERABLE');
    expect(r.stdout).toContain('would quarantine');
    expect(r.stdout).toContain('Dry-run complete');

    // No mutation.
    const archiveDirAfter = fs.readdirSync(
      path.join(fixture.cawsDir, 'specs', '.archive')
    ).sort();
    expect(archiveDirAfter).toEqual(archiveDirBefore);
    expect(readEvents(fixture.cawsDir).length).toBe(eventsBefore);
  });

  it('returns 0 with an explanatory message when .archive/ is empty', () => {
    fixture = mkCawsGitRepo('a8b-');
    // No archive dir created.

    const r = capture(runSpecsPruneArchiveCommand, {
      cwd: fixture.root,
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('no legacy .caws/specs/.archive/ bodies');
  });
});

// ─── A9: --apply ───────────────────────────────────────────────────────

describe('A9: caws specs prune-archive --apply', () => {
  let fixture;
  afterEach(() => fixture && rmrf(fixture.root));

  it('removes recoverable bodies, quarantines unrecoverable, emits events', () => {
    fixture = seedMixedArchive('a9-');
    const eventsBefore = readEvents(fixture.cawsDir).length;

    const r = capture(runSpecsPruneArchiveCommand, {
      cwd: fixture.root,
      apply: true,
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Pruned 3 legacy archive bodies');
    expect(r.stdout).toContain('REMOVED');
    expect(r.stdout).toContain('QUARANTINED');
    expect(r.stdout).toContain('Appended 3 spec_archive_pruned events');

    // Recoverable bodies are gone from .archive/.
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', '.archive', 'RECOV-001.yaml'))
    ).toBe(false);
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', '.archive', 'RECOV-002.yaml'))
    ).toBe(false);

    // Unrecoverable body was moved to .unrecoverable/ (preserved on disk).
    const quarantinePath = path.join(
      fixture.cawsDir,
      'specs',
      '.archive',
      '.unrecoverable',
      'UNREC-001.yaml'
    );
    expect(fs.existsSync(quarantinePath)).toBe(true);
    // The original UNREC-001.yaml is no longer at the top of .archive/.
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', '.archive', 'UNREC-001.yaml'))
    ).toBe(false);

    // Events: 3 new spec_archive_pruned (2 removed + 1 quarantined).
    const eventsAfter = readEvents(fixture.cawsDir);
    expect(eventsAfter.length).toBe(eventsBefore + 3);
    const prunedEvents = eventsAfter.filter((e) => e.event === 'spec_archive_pruned');
    expect(prunedEvents).toHaveLength(3);
    const removed = prunedEvents.filter((e) => e.data.action === 'removed');
    const quarantined = prunedEvents.filter((e) => e.data.action === 'quarantined');
    expect(removed).toHaveLength(2);
    expect(quarantined).toHaveLength(1);
    for (const e of removed) {
      expect(e.data.blob_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(e.data.from_commit_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(['RECOV-001', 'RECOV-002']).toContain(e.spec_id);
    }
    expect(quarantined[0].spec_id).toBe('UNREC-001');
    expect(quarantined[0].data.to_path).toMatch(/\.unrecoverable\/UNREC-001\.yaml$/);
  });

  it('absolute quarantine invariant: no override flag exists to delete unrecoverable', () => {
    // The invariant under test is structural — there is no
    // --force / --allow-unrecoverable-delete option. We verify by
    // asserting the runSpecsPruneArchiveCommand opts shape only
    // accepts known fields.
    fixture = seedMixedArchive('a9b-');

    // Passing a nonsense flag has no effect on behavior; the
    // unrecoverable body still ends up in .unrecoverable/.
    const r = capture(runSpecsPruneArchiveCommand, {
      cwd: fixture.root,
      apply: true,
      // Intentionally pass a made-up flag — the command should ignore it.
      force: true,
      allowUnrecoverableDelete: true,
    });

    expect(r.code).toBe(0);
    // UNREC-001.yaml is preserved in quarantine, NOT deleted.
    const quarantinePath = path.join(
      fixture.cawsDir,
      'specs',
      '.archive',
      '.unrecoverable',
      'UNREC-001.yaml'
    );
    expect(fs.existsSync(quarantinePath)).toBe(true);
    // The original is gone from top-of-archive (moved, not deleted).
    expect(
      fs.existsSync(path.join(fixture.cawsDir, 'specs', '.archive', 'UNREC-001.yaml'))
    ).toBe(false);
    // The quarantined body's content matches the seeded body.
    expect(fs.readFileSync(quarantinePath, 'utf8')).toBe(SPEC_BODY('UNREC-001'));
  });
});
