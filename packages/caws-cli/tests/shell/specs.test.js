/**
 * Tests for `caws specs` lifecycle commands (CLI-SPECS-001).
 *
 * Coverage:
 *   A1  create writes v11 spec with lifecycle_state: active + spec_created event
 *   A2  duplicate id refuses; invalid mode refuses
 *   A3  list excludes archived by default; --archived includes them
 *   A4  show by id; missing id surfaces typed not-found
 *   A5  close non-destructive raw-byte patch (comments preserved)
 *   A6  close appends spec_closed event with chain linkage
 *   A7  archive performs filesystem move with from_path/to_path
 *   A8  close on archived refuses; archive on active refuses
 *   A9  create with invalid plan refuses pre-write (no event, no file)
 *   A10 read-only commands do not rewrite YAML bytes
 *
 * Tests assert on observable runtime state — file content, on-disk
 * event payloads, chain linkage — not just exit codes.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runSpecsCreateCommand,
  runSpecsListCommand,
  runSpecsShowCommand,
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
function readEvents(cawsDir) {
  const p = path.join(cawsDir, 'events.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ============================================================
// A1: create writes active spec + spec_created event
// ============================================================
describe('A1: caws specs create', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a1-')); });
  afterEach(() => rmrf(repoRoot));

  it('creates a v11-shape spec with lifecycle_state: active', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-001',
      title: 'first feature',
      mode: 'feature',
      riskTier: 3,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created FEAT-001/);
    // CAWS-SPECS-CREATE-SCOPE-IN-001 A4: with no --scope-in, the post-create
    // guidance must route scope-setting through the GOVERNED mutation
    // (`caws specs amend-scope`), NOT a raw YAML hand-edit — the hand-edit
    // instruction was the silent-failure surface this slice removes.
    expect(r.stdout).toMatch(/caws specs amend-scope FEAT-001 --add/);
    expect(r.stdout).not.toMatch(/open the spec and replace/);
    // CAWS-SPEC-CREATE-FIRSTTIMER-UX-001 A3: the guidance must NOT over-promise
    // that scope-guard rejects edits — on the unbound main checkout it fails
    // open. It must instead say scope.in is enforced inside the bound worktree,
    // that base-branch writes are governed by the worktree-write-guard, and
    // point at the contracts guide.
    expect(r.stdout).not.toMatch(/scope-guard rejects every edit/);
    expect(r.stdout).toMatch(/worktree-write-guard/);
    expect(r.stdout).toMatch(/caws-contracts\.md/);

    // CAWS-SPECS-CREATE-COMMIT-BEFORE-WORKTREE-GUIDANCE-001 A2: the no-scope-in
    // guidance must tell the first-timer to COMMIT the spec before
    // `caws worktree create`, so the guided happy path does not walk a dirty
    // (hand-edited) spec into worktree create and hit the confusing "the
    // transition was applied but NOT committed" warning observed in the probe.
    // The commit instruction must precede the worktree-create line.
    expect(r.stdout).toMatch(/git add[\s\S]*commit/i);
    const commitIdx = r.stdout.search(/git add/i);
    const wtIdx = r.stdout.search(/caws worktree create/);
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(wtIdx);
    // A3: it names a way to inspect/validate the filled-in spec before
    // proceeding (there is intentionally no `caws specs validate` verb in v11).
    expect(r.stdout).toMatch(/caws specs show FEAT-001|caws doctor/);

    const filePath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toMatch(/^id: FEAT-001/m);
    expect(content).toMatch(/^lifecycle_state: active/m);
    expect(content).toMatch(/^mode: feature/m);
    expect(content).toMatch(/^risk_tier: 3/m);
  });

  // CAWS-SPECS-CREATE-COMMIT-BEFORE-WORKTREE-GUIDANCE-001 A1: the --scope-in
  // branch of the guidance must ALSO instruct committing the spec before
  // worktree create (and naming a validate path), not only the no-scope-in
  // branch. The probe used --scope-in, so this is the branch it actually hit.
  it('A1: --scope-in guidance commits the spec before worktree create + names a validate path', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-009',
      title: 'scope-in feature',
      mode: 'feature',
      riskTier: 3,
      scopeIn: ['src/'],
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created FEAT-009/);
    // The commit instruction precedes the worktree-create line.
    expect(r.stdout).toMatch(/git add[\s\S]*commit/i);
    const commitIdx = r.stdout.search(/git add/i);
    const wtIdx = r.stdout.search(/caws worktree create/);
    expect(commitIdx).toBeGreaterThanOrEqual(0);
    expect(wtIdx).toBeGreaterThanOrEqual(0);
    expect(commitIdx).toBeLessThan(wtIdx);
    // Names a way to inspect/validate the spec.
    expect(r.stdout).toMatch(/caws specs show FEAT-009|caws doctor/);
    // The existing scope-in-branch guidance is preserved.
    expect(r.stdout).toMatch(/caws specs amend-scope FEAT-009 --add/);
    expect(r.stdout).toMatch(/caws-contracts\.md/);
  });

  it('appends a spec_created event with correct shape', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'FEAT-002', title: 'second', mode: 'feature', riskTier: 3,
    });
    const events = readEvents(cawsDir);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('spec_created');
    expect(events[0].spec_id).toBe('FEAT-002');
    expect(events[0].data).toMatchObject({
      title: 'second', risk_tier: 3, mode: 'feature', lifecycle_state: 'active',
    });
    expect(events[0].prev_hash).toBe(null);
    expect(events[0].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ============================================================
// A2: duplicate id refuses; invalid mode refuses
// ============================================================
describe('A2: create refusals', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a2-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses a duplicate spec id', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'DUP-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'DUP-001', title: 't2', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
  });

  it('refuses an invalid --mode', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'BAD-001', title: 't', mode: 'docs', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --mode/);
  });

  it('refuses an invalid --risk-tier', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'BAD-002', title: 't', mode: 'chore', riskTier: 5,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --risk-tier/);
  });

  it('batches missing create options with a copyable v11 invocation shape', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'MISSING-001',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(
      /missing required options: --title, --mode, --risk-tier/
    );
    expect(r.stderr).toMatch(
      /caws specs create <id> --title "<short title>" --mode <feature\|refactor\|fix\|doc\|chore> --risk-tier <1\|2\|3>/
    );
    expect(r.stderr).toMatch(/--type is not supported in v11/);
    expect(r.stderr).toMatch(/Risk tier 3 is appropriate/);
    // CAWS-SPECS-CREATE-SCOPE-IN-001: usage advertises the --scope-in flag and
    // names amend-scope as the governed widening path (no YAML hand-edit).
    expect(r.stderr).toMatch(/--scope-in \(repeatable\) writes scope\.in/);
    expect(r.stderr).toMatch(/caws specs amend-scope <id> --add/);
  });

  it('refuses legacy --type with explicit --mode guidance', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'TYPE-001',
      title: 't',
      mode: 'feature',
      riskTier: 3,
      legacyType: 'feature',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--type is not supported in v11/);
    expect(r.stderr).toMatch(/Use --mode instead/);
  });

  it('refuses an invalid spec id pattern', () => {
    const r = capture(runSpecsCreateCommand, {
      cwd: repoRoot,
      id: 'lowercase-id', title: 't', mode: 'chore', riskTier: 3,
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the v11 pattern/);
  });
});

// ============================================================
// A3: list excludes archived by default
// ============================================================
describe('A3: caws specs list', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a3-')); });
  afterEach(() => rmrf(repoRoot));

  it('lists active specs', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'A-001', title: 'a', mode: 'feature', riskTier: 3,
    });
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'B-001', title: 'b', mode: 'fix', riskTier: 3,
    });
    const r = capture(runSpecsListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('A-001');
    expect(r.stdout).toContain('B-001');
    expect(r.stdout).toContain('active');
  });

  it('does NOT include archived specs by default', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARCH-001', title: 'a', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARCH-001', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARCH-001' });

    const r = capture(runSpecsListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/ARCH-001/);
  });

  it('--archived includes archived specs', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARCH-002', title: 'a', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARCH-002', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARCH-002' });

    const r = capture(runSpecsListCommand, { cwd: repoRoot, includeArchived: true });
    expect(r.code).toBe(0);
    // TOMBSTONE-SHELL-TEST-RECONCILIATION-001 A4: section header
    // updated to match the post-tombstone CLI output, which discloses
    // that archived bodies are recoverable from git history (not the
    // legacy .caws/specs/.archive/<id>.yaml file).
    expect(r.stdout).toContain('-- archived (recoverable from history) --');
    expect(r.stdout).toContain('ARCH-002');
  });
});

// ============================================================
// A4: show command
// ============================================================
describe('A4: caws specs show', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a4-')); });
  afterEach(() => rmrf(repoRoot));

  it('shows an existing spec by id', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'SHOW-001', title: 'show me', mode: 'feature', riskTier: 3,
    });
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'SHOW-001' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id: SHOW-001');
    expect(r.stdout).toContain("title: 'show me'");
  });

  it('surfaces a typed not-found error for missing id', () => {
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'NOPE-999' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not found in \.caws\/specs/);
  });

  it('finds archived specs via explicit --archived flag', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'FOUND-001', title: 'fnd', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'FOUND-001', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'FOUND-001' });
    // TOMBSTONE-SHELL-TEST-RECONCILIATION-001 A5: post-tombstone,
    // `runSpecsShowCommand` walks ONLY the active path by default
    // (per src/shell/commands/specs.ts:248). Recovery of archived
    // bodies requires the explicit `archived: true` flag, which
    // routes through `recoverArchivedSpec` (event-log + git blob).
    // The pre-tombstone implicit-fallback behavior is gone by design.
    const r = capture(runSpecsShowCommand, { cwd: repoRoot, id: 'FOUND-001', archived: true });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('id: FOUND-001');
    // The recovered body is the YAML snapshot taken just before
    // archive — lifecycle_state at the time of archive was 'closed',
    // since archive requires `lifecycle_state: closed`. The tombstone
    // event marks the id as archived in the event log; the body
    // itself is the pre-archive body, NOT a synthetic
    // `lifecycle_state: archived` rewrite.
    expect(r.stdout).toContain('lifecycle_state: closed');
  });
});

// ============================================================
// A5: close is a non-destructive raw-byte patch
// ============================================================
describe('A5: caws specs close (non-destructive)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a5-')); });
  afterEach(() => rmrf(repoRoot));

  it('preserves field order and unrelated lines byte-for-byte', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLOSE-001', title: 'preserve me', mode: 'feature', riskTier: 3,
    });
    const filePath = path.join(cawsDir, 'specs/CLOSE-001.yaml');
    const before = fs.readFileSync(filePath, 'utf8');

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSE-001', resolution: 'completed', reason: 'A5 test',
    });
    expect(r.code).toBe(0);

    const after = fs.readFileSync(filePath, 'utf8');

    // Mutations: lifecycle_state, resolution (inserted), closure_notes
    // (inserted), updated_at.
    expect(after).toMatch(/^lifecycle_state: closed$/m);
    expect(after).toMatch(/^resolution: completed$/m);
    expect(after).toMatch(/^closure_notes: 'A5 test'$/m);

    // Non-mutated lines remain byte-identical (sample a few load-bearing
    // ones).
    expect(after).toContain('id: CLOSE-001');
    expect(after).toContain("title: 'preserve me'");
    expect(after).toContain('mode: feature');
    expect(after).toContain('risk_tier: 3');
    expect(after).toContain('blast_radius:');
    expect(after).toContain('scope:');
    expect(after).toContain('acceptance:');

    // Diff size sanity: compute Levenshtein-style line diff (lines
    // present in 'before' but not in 'after', and vice versa). This
    // accounts for inserted lines shifting line numbers in a naive
    // index-by-index comparison.
    const beforeLines = new Set(before.split('\n'));
    const afterLines = new Set(after.split('\n'));
    const removed = [...beforeLines].filter((l) => !afterLines.has(l));
    const added = [...afterLines].filter((l) => !beforeLines.has(l));
    // Expected: lifecycle_state line changed (1 removed, 1 added);
    // updated_at line changed (1 removed, 1 added); resolution +
    // closure_notes inserted (2 added). Total: 2 removed, 4 added.
    expect(removed.length).toBeLessThanOrEqual(3);
    expect(added.length).toBeLessThanOrEqual(5);
  });
});

// ============================================================
// A6: close appends spec_closed event with chain linkage
// ============================================================
describe('A6: caws specs close (event)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a6-')); });
  afterEach(() => rmrf(repoRoot));

  it('appends spec_closed with prev_hash = previous tail event_hash', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'EVT-001', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'EVT-001', resolution: 'completed', reason: 'done',
    });

    const events = readEvents(cawsDir);
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('spec_created');
    expect(events[1].event).toBe('spec_closed');
    expect(events[1].spec_id).toBe('EVT-001');
    expect(events[1].data).toEqual({
      resolution: 'completed', closure_notes: 'done',
    });
    expect(events[1].prev_hash).toBe(events[0].event_hash);
    expect(events[1].event_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ============================================================
// CAWS-AUTOCOMMIT-INTEGRITY-001 A3/A4: close surfaces a
// non-landed audit commit (refused_dirty) instead of silently
// reporting success; clean close is unchanged.
// ============================================================
describe('CAWS-AUTOCOMMIT-INTEGRITY-001: audit-commit surfacing on close', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-autocommit-')); });
  afterEach(() => rmrf(repoRoot));

  it('A3: surfaces refused_dirty (warning, exit 0) when the audit commit does not land', () => {
    // Create the spec, then COMMIT it clean so it is tracked at HEAD.
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'DIRTY-001', title: 't', mode: 'chore', riskTier: 3,
    });
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'add spec']);

    // Make the spec file dirty BEFORE the close (unrelated uncommitted edit).
    // closeSpec sees wasDirtyBeforeWrite=true → autoCommit returns refused_dirty.
    const specPath = path.join(cawsDir, 'specs/DIRTY-001.yaml');
    fs.appendFileSync(specPath, '\n# unrelated local edit\n');

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'DIRTY-001', resolution: 'completed', reason: 'done',
    });

    // The lifecycle YAML change still landed on disk (close is not rolled back).
    expect(fs.readFileSync(specPath, 'utf8')).toMatch(/lifecycle_state:\s*closed/);
    // The command surfaces the non-landed audit commit on stderr (not silent)...
    expect(r.stderr).toMatch(/applied but NOT committed/);
    expect(r.stderr).toMatch(/commit it manually|git log/i);
    // ...but exits 0: the close OPERATION succeeded; a non-landed audit
    // commit is a warning, not a command failure (CAWS-AUTOCOMMIT-INTEGRITY-002).
    expect(r.code).toBe(0);
  });

  it('A4: clean close commits, prints success, exits 0 (no regression)', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLEAN-001', title: 't', mode: 'chore', riskTier: 3,
    });
    execFileSync('git', ['-C', repoRoot, 'add', '-A']);
    execFileSync('git', ['-C', repoRoot, 'commit', '--quiet', '-m', 'add spec']);

    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLEAN-001', resolution: 'completed', reason: 'done',
    });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/closed CLEAN-001 \(resolution: completed\)/);
    expect(r.stderr).not.toMatch(/applied but NOT committed/);
    // The audit commit landed: working tree is clean of the spec change.
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    expect(status).not.toMatch(/specs\/CLEAN-001\.yaml/);
  });
});

// ============================================================
// A7: archive performs filesystem move
// ============================================================
describe('A7: caws specs archive (tombstone event)', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a7-')); });
  afterEach(() => rmrf(repoRoot));

  // TOMBSTONE-SHELL-TEST-RECONCILIATION-001 A3: post-tombstone
  // archive is a deletion + spec_archived event carrying
  // `from_path`, `blob_sha`, and optional `source_commit_sha`. No
  // body is written to .caws/specs/.archive/; recovery is via the
  // event log's blob_sha + `git show`. The legacy `to_path` field
  // is gone.
  it('deletes the active file and emits a tombstone spec_archived event', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ARC-001', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ARC-001', resolution: 'completed',
    });

    const beforePath = path.join(cawsDir, 'specs/ARC-001.yaml');
    const legacyArchivePath = path.join(cawsDir, 'specs/.archive/ARC-001.yaml');
    expect(fs.existsSync(beforePath)).toBe(true);
    expect(fs.existsSync(legacyArchivePath)).toBe(false);

    const r = capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ARC-001' });
    expect(r.code).toBe(0);
    // Active path is deleted.
    expect(fs.existsSync(beforePath)).toBe(false);
    // NO body written under the legacy archive directory.
    expect(fs.existsSync(legacyArchivePath)).toBe(false);

    const events = readEvents(cawsDir);
    const archEvent = events.find((e) => e.event === 'spec_archived');
    expect(archEvent).toBeDefined();
    expect(archEvent.spec_id).toBe('ARC-001');
    // Tombstone event shape: from_path + blob_sha; no to_path.
    expect(archEvent.data.from_path).toBe('.caws/specs/ARC-001.yaml');
    expect(typeof archEvent.data.blob_sha).toBe('string');
    expect(archEvent.data.blob_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(archEvent.data.to_path).toBeUndefined();
    // source_commit_sha is optional but, when present, must be a SHA.
    if (archEvent.data.source_commit_sha !== undefined) {
      expect(archEvent.data.source_commit_sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

// ============================================================
// A8: illegal lifecycle transitions refuse
// ============================================================
describe('A8: illegal transition refusals', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('specs-a8-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses archive on an active spec', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ILL-001' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/only closed specs can be archived/);
  });

  it('refuses close on an archived spec', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-002', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-002', resolution: 'completed',
    });
    capture(runSpecsArchiveCommand, { cwd: repoRoot, id: 'ILL-002' });
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-002', resolution: 'completed',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/archived; cannot close/);
  });

  it('refuses close with invalid --resolution', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'ILL-003', title: 't', mode: 'chore', riskTier: 3,
    });
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'ILL-003', resolution: 'finished',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/invalid --resolution/);
  });
});

// ============================================================
// CAWS-SPECS-CLOSE-DEFAULT-RESOLUTION-001: Commander-layer default
// ============================================================
//
// The Sterling-reported defect: `caws specs close FOO-1 --reason "..."`
// invoked without `--resolution` failed at Commander's option-parse
// layer with "error: required option '--resolution <r>' not specified"
// BEFORE runSpecsCloseCommand was invoked. This suite exercises the
// fix at the Commander parser surface — the only layer where the
// .requiredOption → .option(... , 'completed') change is visible.
//
// The action-handler-level tests above (A8 etc.) already prove that
// resolution: 'completed' produces a correct close; this suite proves
// that omitting --resolution at the argv layer now resolves to that
// same default before the handler runs.
describe('CAWS-SPECS-CLOSE-DEFAULT-RESOLUTION-001: --resolution defaults to completed', () => {
  const { Command } = require('commander');
  const { registerShellCommands } = require('../../dist/shell');

  /**
   * Build a Commander program with only the shell command registration,
   * matching the pattern in register.test.js. Returns the close
   * subcommand of the specs group so tests can read its declared
   * options + parse argv.
   */
  function getSpecsCloseSubcommand() {
    const program = new Command();
    program.exitOverride();
    program.name('caws').version('test');
    registerShellCommands(program, { exit: () => {} });
    const specsCmd = program.commands.find((c) => c.name() === 'specs');
    expect(specsCmd).toBeDefined();
    const closeCmd = specsCmd.commands.find((c) => c.name() === 'close');
    expect(closeCmd).toBeDefined();
    return closeCmd;
  }

  it('--resolution is declared as a non-required option with default "completed"', () => {
    const closeCmd = getSpecsCloseSubcommand();
    const resolutionOpt = closeCmd.options.find((o) => o.long === '--resolution');
    expect(resolutionOpt).toBeDefined();
    // Pre-fix: this would be a required option (mandatory === true).
    // Post-fix: optional with default 'completed'.
    expect(resolutionOpt.mandatory).toBe(false);
    expect(resolutionOpt.defaultValue).toBe('completed');
  });

  it('specs create options are parsed by the action layer for batched diagnostics', () => {
    const program = new Command();
    program.exitOverride();
    program.name('caws').version('test');
    registerShellCommands(program, { exit: () => {} });
    const specsCmd = program.commands.find((c) => c.name() === 'specs');
    const createCmd = specsCmd.commands.find((c) => c.name() === 'create');

    for (const long of ['--title', '--mode', '--risk-tier']) {
      const opt = createCmd.options.find((o) => o.long === long);
      expect(opt).toBeDefined();
      expect(opt.mandatory).toBe(false);
    }

    const typeOpt = createCmd.options.find((o) => o.long === '--type');
    expect(typeOpt).toBeDefined();
    expect(typeOpt.mandatory).toBe(false);
  });

  // CAWS-SPECS-CREATE-HIDE-LEGACY-TYPE-001: the removed-v10 `--type` alias must
  // stay REGISTERED (so `caws specs create --type feature` still routes to the
  // handler's helpful "use --mode" migration error rather than Commander's
  // generic "unknown option"), but it must NOT appear in `--help` — a first-timer
  // scanning the options list should not read a removed alias as a current flag.
  it('A1: --type is hidden from create --help but the live flags remain visible', () => {
    const { Help } = require('commander');
    const program = new Command();
    program.exitOverride();
    program.name('caws').version('test');
    registerShellCommands(program, { exit: () => {} });
    const specsCmd = program.commands.find((c) => c.name() === 'specs');
    const createCmd = specsCmd.commands.find((c) => c.name() === 'create');

    // Commander renders --help via Help.visibleOptions(); a hideHelp()'d option
    // is excluded there. Assert on the same surface the help text is built from.
    const visibleLongs = new Help().visibleOptions(createCmd).map((o) => o.long);
    expect(visibleLongs).not.toContain('--type');

    // ...while every current option still renders in help.
    for (const long of ['--title', '--mode', '--risk-tier', '--scope-in']) {
      expect(visibleLongs).toContain(long);
    }

    // And the rendered help text itself omits --type but keeps --mode.
    const helpText = createCmd.helpInformation();
    expect(helpText).not.toMatch(/--type/);
    expect(helpText).toMatch(/--mode/);
  });

  it('A3: --type is still REGISTERED (parseable) so the migration error path is preserved', () => {
    const program = new Command();
    program.exitOverride();
    program.name('caws').version('test');
    registerShellCommands(program, { exit: () => {} });
    const specsCmd = program.commands.find((c) => c.name() === 'specs');
    const createCmd = specsCmd.commands.find((c) => c.name() === 'create');

    // Present on the command (Commander parses --type <value>) and marked hidden.
    const typeOpt = createCmd.options.find((o) => o.long === '--type');
    expect(typeOpt).toBeDefined();
    expect(typeOpt.mandatory).toBe(false);
    expect(typeOpt.hidden).toBe(true);
  });

  it('Commander populates opts.resolution with "completed" when --resolution is omitted', () => {
    const closeCmd = getSpecsCloseSubcommand();
    // Parse argv that omits --resolution. The action handler in
    // register.ts would normally invoke runSpecsCloseCommand and exit;
    // we intercept the action so the test never touches the filesystem.
    let capturedOpts;
    closeCmd.action((id, opts) => {
      capturedOpts = { id, opts };
    });
    // Argv shape Commander expects: ['node', 'caws', 'specs', 'close', '<id>', '--reason', '...']
    closeCmd.parent.parent.parse(
      ['node', 'caws', 'specs', 'close', 'FOO-1', '--reason', 'done'],
      { from: 'node' }
    );
    expect(capturedOpts).toBeDefined();
    expect(capturedOpts.id).toBe('FOO-1');
    expect(capturedOpts.opts.resolution).toBe('completed');
    expect(capturedOpts.opts.reason).toBe('done');
  });

  it('Commander preserves explicit --resolution (default does NOT override the flag)', () => {
    const closeCmd = getSpecsCloseSubcommand();
    let capturedOpts;
    closeCmd.action((id, opts) => {
      capturedOpts = { id, opts };
    });
    closeCmd.parent.parent.parse(
      [
        'node', 'caws', 'specs', 'close', 'FOO-2',
        '--resolution', 'superseded',
        '--superseded-by', 'FOO-3',
        '--reason', 'moved',
      ],
      { from: 'node' }
    );
    expect(capturedOpts.opts.resolution).toBe('superseded');
    expect(capturedOpts.opts.supersededBy).toBe('FOO-3');
    expect(capturedOpts.opts.reason).toBe('moved');
  });

  it('zero-flag invocation: `caws specs close <id>` resolves resolution to "completed"', () => {
    // A3 from the spec: bare close with no flags should not fail at the
    // Commander layer. This proves the --reason independence: omitting
    // both --reason AND --resolution still parses.
    const closeCmd = getSpecsCloseSubcommand();
    let capturedOpts;
    closeCmd.action((id, opts) => {
      capturedOpts = { id, opts };
    });
    closeCmd.parent.parent.parse(
      ['node', 'caws', 'specs', 'close', 'FOO-3'],
      { from: 'node' }
    );
    expect(capturedOpts.opts.resolution).toBe('completed');
    expect(capturedOpts.opts.reason).toBeUndefined();
  });

  it('action handler accepts resolution="completed" end-to-end (A1 behavioral proof)', () => {
    // A1: the defaulted "completed" must round-trip through the action
    // handler to a successful close. This is the action-handler-level
    // proof that the Commander default produces the same observable
    // outcome as an explicit --resolution completed.
    const { repoRoot } = setup('specs-close-default-');
    try {
      capture(runSpecsCreateCommand, {
        cwd: repoRoot, id: 'DEF-001', title: 't', mode: 'chore', riskTier: 3,
      });
      // Invoke with the value Commander would have defaulted to.
      const r = capture(runSpecsCloseCommand, {
        cwd: repoRoot, id: 'DEF-001', resolution: 'completed', reason: 'done',
      });
      expect(r.code).toBe(0);
      const specPath = path.join(repoRoot, '.caws/specs/DEF-001.yaml');
      const yaml = fs.readFileSync(specPath, 'utf8');
      expect(yaml).toMatch(/lifecycle_state: closed/);
      expect(yaml).toMatch(/resolution: completed/);
      // YAML serializer quotes string scalars: closure_notes: 'done'.
      expect(yaml).toMatch(/closure_notes: ['"]?done['"]?/);
      const events = readEvents(path.join(repoRoot, '.caws'));
      const closeEv = events.find((e) => e.event === 'spec_closed' && e.spec_id === 'DEF-001');
      expect(closeEv).toBeDefined();
      expect(closeEv.data.resolution).toBe('completed');
    } finally {
      rmrf(repoRoot);
    }
  });
});

// ============================================================
// A10: read-only commands do not rewrite YAML
// ============================================================
describe('A10: read-only commands are non-mutating', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setup('specs-a10-')); });
  afterEach(() => rmrf(repoRoot));

  it('show does not modify the spec file', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'RO-001', title: 't', mode: 'chore', riskTier: 3,
    });
    const filePath = path.join(cawsDir, 'specs/RO-001.yaml');
    const before = fs.readFileSync(filePath, 'utf8');
    const beforeMtime = fs.statSync(filePath).mtimeMs;

    capture(runSpecsShowCommand, { cwd: repoRoot, id: 'RO-001' });
    capture(runSpecsListCommand, { cwd: repoRoot });

    const after = fs.readFileSync(filePath, 'utf8');
    expect(after).toBe(before);
    // mtime unchanged (no atomic-write run on read paths).
    expect(fs.statSync(filePath).mtimeMs).toBe(beforeMtime);
  });
});
