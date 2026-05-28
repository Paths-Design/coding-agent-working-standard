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
