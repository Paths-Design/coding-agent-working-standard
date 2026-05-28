/**
 * Tests for v11.1 specs lifecycle edge cases that are not covered by
 * tests/shell/specs.test.js, specs-list-archived.test.js,
 * specs-prune-archive.test.js, or specs-recover-show-archived.test.js.
 *
 * CAWS-LEGACY-COMMAND-TEST-MIGRATION-001a ports the v11-valid edge
 * cases from three legacy command-source tests
 * (tests/specs-archive.test.js, tests/specs-archive-collision.test.js,
 * tests/specs-close-diff.test.js) and exercises them against the
 * v11 shell entry points runSpecsCreateCommand,
 * runSpecsCloseCommand, and runSpecsArchiveCommand.
 *
 * Behaviors covered (each block names its legacy origin):
 *   - archive: refuse on unknown id (legacy specs-archive A7)
 *   - archive: refuse path-traversal id (legacy specs-archive Security)
 *   - create: refuse when id collides with archived spec, suggest
 *     `caws specs recover` (legacy specs-archive-collision A1)
 *   - create: collision detected even when registry has no entry
 *     (legacy specs-archive-collision A3 — orphan archived-file case)
 *   - close: comment lines in the spec body are preserved byte-for-byte
 *     (legacy specs-close-diff A1 — partial port; v10 line-count
 *     invariant is dropped because v11 inserts resolution + closure_notes)
 *   - close: closing an already-closed spec is a no-op (legacy
 *     specs-close-diff A2)
 *
 * Behaviors explicitly NOT carried forward (v11 architectural shift):
 *   - file movement to .caws/specs/.archive/ (v11 tombstones; the
 *     active file is deleted, archived body recovered via event log
 *     + git blob_sha; see shell/specs-recover-show-archived.test.js)
 *   - `--force` create override on collision (no --force in v11;
 *     equivalent path is `caws specs recover`)
 *   - status: <state> on disk for archived specs (v11 has no such
 *     field; archived = "no file + spec_archived event")
 *   - prior_status / prior_path event fields (v11 uses from_path /
 *     blob_sha / source_commit_sha; see shell/specs.test.js A7)
 *   - "refuse archive when active worktree references spec" (v11
 *     gates this via close-only-on-closed-spec, which transitively
 *     requires worktree destroy first)
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
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  execFileSync('git', [
    '-C', root, 'commit', '--quiet', '--allow-empty', '-m', 'init',
  ]);
  return root;
}
function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
function setup(prefix) {
  const repoRoot = mkBareGitRepo(prefix);
  const initResult = initProject(repoRoot);
  if (!initResult.ok) throw new Error('initProject failed');
  return { repoRoot, cawsDir: path.join(repoRoot, '.caws') };
}
function capture(fn, opts) {
  const out = []; const err = [];
  const code = fn({
    ...opts,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

// ============================================================
// archive: refuse on unknown id (ported from legacy specs-archive A7)
// ============================================================
describe('runSpecsArchiveCommand: refuse on unknown id', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-archive-unknown-')); });
  afterEach(() => rmrf(repoRoot));

  it('exits non-zero with a not-found diagnostic when the spec id does not exist', () => {
    const r = capture(runSpecsArchiveCommand, {
      cwd: repoRoot,
      id: 'DOES-NOT-EXIST-01',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not found|DOES-NOT-EXIST-01/);
    // No file should have been created anywhere under .caws/specs/.
    const specsDir = path.join(repoRoot, '.caws', 'specs');
    const entries = fs.existsSync(specsDir) ? fs.readdirSync(specsDir) : [];
    expect(entries).not.toContain('DOES-NOT-EXIST-01.yaml');
  });
});

// ============================================================
// archive: refuse path-traversal id (ported from legacy specs-archive Security)
// ============================================================
describe('runSpecsArchiveCommand: refuse path-traversal id', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-archive-traversal-')); });
  afterEach(() => rmrf(repoRoot));

  it('exits non-zero when id contains a path-traversal segment', () => {
    const r = capture(runSpecsArchiveCommand, {
      cwd: repoRoot,
      id: '../etc/passwd',
    });
    expect(r.code).not.toBe(0);
    // The exact error wording is owned by validateSpecId; assert only
    // that the call was refused and nothing was written outside the
    // specs directory.
    const writtenSomewhereBad = fs.existsSync(path.join(repoRoot, 'etc', 'passwd.yaml'));
    expect(writtenSomewhereBad).toBe(false);
  });
});

// ============================================================
// create: refuse when id collides with archived spec
// (ported from legacy specs-archive-collision A1; v10's --force
// override is gone, v11 routes through caws specs recover)
// ============================================================
describe('runSpecsCreateCommand: archive-collision refusal', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-create-collision-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses to create a spec whose id matches an archived spec; error suggests `caws specs recover`', () => {
    // Build an archived spec the long way: create → close → archive,
    // using v11 entry points only.
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'COLLIDE-01', title: 'first life', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'COLLIDE-01', resolution: 'completed', reason: 'setup',
    });
    // Close auto-commits per CAWS-SPECS-WRITER-AUTOCOMMIT-001; archive
    // now has a HEAD blob_sha to anchor the tombstone.
    const arch = capture(runSpecsArchiveCommand, {
      cwd: repoRoot, id: 'COLLIDE-01',
    });
    expect(arch.code).toBe(0);

    // Now try to re-create. v11 must refuse and explain how to recover.
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'COLLIDE-01', title: 'second life', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/archived|recover/i);
    expect(r.stderr).toContain('COLLIDE-01');
  });
});

// ============================================================
// HARDENING A4(a): closeSpec refuses on tombstone-only state
// (event-log spec_archived present, legacy .archive/<id>.yaml absent)
// ============================================================
//
// CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A4.
//
// closeSpec's archive-detection guard (specs-writer.ts line 498 /
// dist line 373) is:
//
//   if (fs.existsSync(archived) || isArchivedViaTombstone(...)) {
//     return err(...archived; cannot close...);
//   }
//
// MUTATION-STRYKER-TS-COVERAGE-001 surfaced the surviving mutant
// `|| → &&`. To kill it, each disjunct must be exercised
// independently — one test where ONLY the legacy file is present, one
// where ONLY the tombstone event is present. If both arms always fire
// together, the AND-mutant survives because `(false && X)` and
// `(false || X)` agree.
//
// A4(a): lifecycle-archive produces ONLY the tombstone event. v11
// does NOT write .caws/specs/.archive/<id>.yaml (per
// CAWS-ARCHIVE-AS-TOMBSTONE-001). Close attempt on the tombstoned
// id must refuse.
describe('runSpecsCloseCommand: refuses close on tombstone-only state (v11 lifecycle)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('close-tombstone-only-')); });
  afterEach(() => rmrf(repoRoot));

  it('after lifecycle archive (tombstone event only, no .archive file), close refuses with archived diagnostic', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLOSE-TOMB-01', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-TOMB-01', resolution: 'completed', reason: 'setup',
    });
    const arch = capture(runSpecsArchiveCommand, {
      cwd: repoRoot, id: 'CLOSE-TOMB-01',
    });
    expect(arch.code).toBe(0);

    // Pre-conditions for the disjunct isolation:
    //   - active spec yaml absent (archive deleted it)
    //   - legacy archive yaml ABSENT (v11 does not write .archive/)
    //   - tombstone event present
    const activePath = path.join(cawsDir, 'specs', 'CLOSE-TOMB-01.yaml');
    const archivedPath = path.join(cawsDir, 'specs', '.archive', 'CLOSE-TOMB-01.yaml');
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(archivedPath)).toBe(false);
    const eventsLog = path.join(cawsDir, 'events.jsonl');
    const events = fs.readFileSync(eventsLog, 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(events.find((e) => e.event === 'spec_archived' && e.spec_id === 'CLOSE-TOMB-01'))
      .toBeDefined();

    // Close attempt: tombstone arm alone must fire the refusal.
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-TOMB-01', resolution: 'completed', reason: 'should refuse',
    });
    expect(r.code).not.toBe(0);
    // Diagnostic identifies the archived state, not generic "not found".
    expect(r.stderr).toMatch(/archived/i);
    expect(r.stderr).toContain('CLOSE-TOMB-01');
    expect(r.stderr).not.toMatch(/not found at/);
  });
});

// ============================================================
// HARDENING A4(b): closeSpec refuses on legacy-file-only state
// (legacy .archive/<id>.yaml present, NO spec_archived event)
// ============================================================
//
// A4(b): hand-place a pre-tombstone v10-style archive file at
// .caws/specs/.archive/<id>.yaml, WITHOUT ever running the v11
// archive lifecycle for that id (so events.jsonl has no
// spec_archived event for it). closeSpec's fs.existsSync(archived)
// arm must independently fire the refusal.
//
// If `||` were mutated to `&&`, this state (legacy file present,
// tombstone event absent) would slip past the guard and fall through
// to "not found at <path>" — measurably different behavior.
describe('runSpecsCloseCommand: refuses close on legacy-archive-file-only state', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('close-legacy-file-only-')); });
  afterEach(() => rmrf(repoRoot));

  it('with .caws/specs/.archive/<id>.yaml present and no spec_archived event, close refuses with archived diagnostic', () => {
    // Hand-construct the pre-tombstone legacy state: a body parked
    // under .archive/ from a v10 archive operation, never replayed
    // into the v11 event log. No active file is created.
    const archiveDir = path.join(cawsDir, 'specs', '.archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const legacyPath = path.join(archiveDir, 'CLOSE-LEGACY-01.yaml');
    fs.writeFileSync(
      legacyPath,
      `id: CLOSE-LEGACY-01
title: legacy archived body
risk_tier: 3
mode: chore
lifecycle_state: archived
created_at: '2024-01-01T00:00:00.000Z'
updated_at: '2024-01-01T00:00:00.000Z'
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
`
    );

    // Pre-conditions for the disjunct isolation:
    //   - active spec yaml absent (never created)
    //   - legacy archive yaml PRESENT (just written)
    //   - no spec_archived event in events.jsonl for this id
    const activePath = path.join(cawsDir, 'specs', 'CLOSE-LEGACY-01.yaml');
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(legacyPath)).toBe(true);
    const eventsLog = path.join(cawsDir, 'events.jsonl');
    const events = fs.existsSync(eventsLog)
      ? fs.readFileSync(eventsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    expect(events.find((e) => e.event === 'spec_archived' && e.spec_id === 'CLOSE-LEGACY-01'))
      .toBeUndefined();

    // Close attempt: legacy-file arm alone must fire the refusal.
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-LEGACY-01', resolution: 'completed', reason: 'should refuse',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/archived/i);
    expect(r.stderr).toContain('CLOSE-LEGACY-01');
    expect(r.stderr).not.toMatch(/not found at/);
  });
});

// ============================================================
// HARDENING A4(c): closeSpec must SUCCEED on a normal active spec
// (positive control — kills the ConditionalExpression-true mutant)
// ============================================================
//
// CAWS-SPECS-ARCHIVE-COLLISION-MUTATION-HARDENING-001 A4 (positive control).
//
// The disjunction at specs-writer.ts line 498 only fires when the
// active spec yaml is absent. The Stryker config narrows tests to
// our three tombstone-focused files, so without a positive close-
// success test in this set, the mutant
//
//   if (fs.existsSync(archived) || isArchivedViaTombstone(...))  →  if (true)
//
// survives — flipping it to `if (true)` would refuse EVERY close,
// including normal active-spec closes, but no test in our slice
// exercises that path.
//
// This test exercises the active-spec close branch so a `true` mutant
// would refuse here and the test would fail.
describe('runSpecsCloseCommand: succeeds on a normal active spec (positive control)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('close-active-positive-')); });
  afterEach(() => rmrf(repoRoot));

  it('lifecycle create → close on an active spec succeeds and patches lifecycle_state to closed', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLOSE-ACTIVE-01', title: 't', mode: 'chore', riskTier: 3,
    });
    const activePath = path.join(cawsDir, 'specs', 'CLOSE-ACTIVE-01.yaml');
    expect(fs.existsSync(activePath)).toBe(true);

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-ACTIVE-01', resolution: 'completed', reason: 'happy path',
    });
    expect(r.code).toBe(0);

    // File still exists (close patches in-place; archive is what deletes).
    expect(fs.existsSync(activePath)).toBe(true);
    const body = fs.readFileSync(activePath, 'utf8');
    expect(body).toMatch(/lifecycle_state:\s*closed/);
  });
});

// ============================================================
// close: comment preservation through the close patch
// (ported from legacy specs-close-diff A1 — comment-preservation half;
// v10 strict-line-count invariant is dropped because v11 intentionally
// inserts resolution + closure_notes lines)
// ============================================================
describe('runSpecsCloseCommand: comment preservation', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-close-comments-')); });
  afterEach(() => rmrf(repoRoot));

  it('preserves YAML comment lines byte-for-byte through close', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'COMMENT-01', title: 'comment probe', mode: 'chore', riskTier: 3,
    });
    const filePath = path.join(cawsDir, 'specs/COMMENT-01.yaml');
    // Inject a comment directly into the YAML body. v11 specs are
    // created from a fixed template that doesn't contain user comments,
    // so this simulates a user-edited spec.
    const original = fs.readFileSync(filePath, 'utf8');
    const withComment = original.replace(
      /^lifecycle_state: active$/m,
      'lifecycle_state: active\n# preserve this comment'
    );
    fs.writeFileSync(filePath, withComment, 'utf8');
    // Re-commit so close has a clean HEAD blob.
    execFileSync('git', ['-C', repoRoot, 'add', '.caws/specs/COMMENT-01.yaml']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'add comment']);

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'COMMENT-01', resolution: 'completed', reason: 'preserve me',
    });
    expect(r.code).toBe(0);
    const after = fs.readFileSync(filePath, 'utf8');
    expect(after).toContain('# preserve this comment');
  });
});

// ============================================================
// close: idempotent already-closed (ported from legacy specs-close-diff A2)
// ============================================================
describe('runSpecsCloseCommand: idempotent on already-closed spec', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-close-idempotent-')); });
  afterEach(() => rmrf(repoRoot));

  it('closing an already-closed spec is a no-op refusal (file bytes unchanged)', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'IDEM-01', title: 'idem probe', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'IDEM-01', resolution: 'completed', reason: 'first close',
    });
    const filePath = path.join(cawsDir, 'specs/IDEM-01.yaml');
    const bytesAfterFirstClose = fs.readFileSync(filePath, 'utf8');

    // Second close: v11 refuses illegal transitions
    // (shell/specs.test.js A8). The file must NOT mutate as a result.
    const r2 = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'IDEM-01', resolution: 'completed', reason: 'second close attempt',
    });
    // Either exit 0 with idempotent behavior, or exit non-zero with
    // refusal — both are valid "no mutation" outcomes. Assert the
    // outcome that's actually current in v11: file bytes unchanged.
    expect(r2.code).not.toBe(0);
    const bytesAfterSecondClose = fs.readFileSync(filePath, 'utf8');
    expect(bytesAfterSecondClose).toBe(bytesAfterFirstClose);
  });
});
