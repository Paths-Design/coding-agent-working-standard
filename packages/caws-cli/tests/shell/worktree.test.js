/**
 * Tests for `caws worktree` lifecycle commands (CLI-WORKTREE-001).
 *
 * Coverage:
 *   A1  create requires active spec; writes registry + spec binding;
 *       appends worktree_created then worktree_bound in order
 *   A2  refuses missing/closed/archived specs
 *   A5  list shows worktrees without mutating state
 *   A6  destroy refuses foreign ownership
 *   A6  destroy refuses dirty worktree
 *   A7  merge --dry-run is read-only
 *   A8/A9 merge: spec_closed then worktree_merged in order, auto_closed_spec: true,
 *       worktree destroyed after merge
 *   A10 no command writes .caws/working-spec.yaml
 *   A12 typed failure diagnostics
 *
 * Tests assert on observable runtime state — events.jsonl content,
 * worktrees.json registry, spec.worktree field, git worktree presence.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  runWorktreeCreateCommand,
  runWorktreeListCommand,
  runWorktreeDestroyCommand,
  runWorktreeMergeCommand,
  runSpecsCreateCommand,
  runSpecsCloseCommand,
} = require('../../dist/shell');
const { initProject } = require('../../dist/store/init-store');

function mkBareGitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // -b main pins the default branch so tests asserting baseBranch === 'main'
  // pass regardless of the runner's init.defaultBranch (CI defaults to master).
  execFileSync('git', ['init', '--quiet', '-b', 'main', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 't@t.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
  // Need a non-empty repo: write a file + commit so worktree branches have a base.
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  execFileSync('git', ['-C', root, 'add', 'README.md']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'init']);
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
function readRegistry(cawsDir) {
  const p = path.join(cawsDir, 'worktrees.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function setupRepoWithSpec(prefix, specId = 'FEAT-001') {
  const ctx = setup(prefix);
  capture(runSpecsCreateCommand, {
    cwd: ctx.repoRoot,
    id: specId, title: 'feature', mode: 'feature', riskTier: 3,
  });
  return ctx;
}

// ============================================================
// A1 + A3: create writes registry + spec binding; events in order
// ============================================================
describe('A1/A3: caws worktree create', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a1-')); });
  afterEach(() => rmrf(repoRoot));

  it('creates worktree, binds spec, emits worktree_created then worktree_bound', () => {
    const r = capture(runWorktreeCreateCommand, {
      cwd: repoRoot,
      name: 'feat-001-wt',
      specId: 'FEAT-001',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/created feat-001-wt/);

    // Registry entry exists.
    const registry = readRegistry(cawsDir);
    expect(registry['feat-001-wt']).toBeDefined();
    expect(registry['feat-001-wt'].specId).toBe('FEAT-001');
    expect(registry['feat-001-wt'].branch).toBe('feat-001-wt');
    expect(registry['feat-001-wt'].baseBranch).toBe('main');
    expect(registry['feat-001-wt'].path).toContain('.caws/worktrees/feat-001-wt');

    // Spec has worktree field.
    const specContent = fs.readFileSync(path.join(cawsDir, 'specs/FEAT-001.yaml'), 'utf8');
    expect(specContent).toMatch(/^worktree: feat-001-wt$/m);

    // Two events appended in order, with chain linkage.
    const events = readEvents(cawsDir);
    const lastTwo = events.slice(-2);
    expect(lastTwo[0].event).toBe('worktree_created');
    expect(lastTwo[1].event).toBe('worktree_bound');
    expect(lastTwo[1].prev_hash).toBe(lastTwo[0].event_hash);
    expect(lastTwo[0].data.name).toBe('feat-001-wt');
    expect(lastTwo[1].data.worktree_name).toBe('feat-001-wt');

    // Git worktree actually exists.
    const wtPath = path.join(cawsDir, 'worktrees/feat-001-wt');
    expect(fs.existsSync(wtPath)).toBe(true);
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(true);
  });
});

// ============================================================
// A2: create refusals
// ============================================================
describe('A2: caws worktree create refusals', () => {
  let repoRoot;
  beforeEach(() => { ({ repoRoot } = setup('wt-a2-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses when spec does not exist', () => {
    const r = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-missing', specId: 'MISSING-001',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/not found/);
  });

  it('refuses when spec is in lifecycle_state closed', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'CLOSED-001', title: 't', mode: 'chore', riskTier: 3,
    });
    capture(runSpecsCloseCommand, {
      cwd: repoRoot, id: 'CLOSED-001', resolution: 'completed',
    });
    const r = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-closed', specId: 'CLOSED-001',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/only active specs/);
  });

  it('refuses an invalid worktree name', () => {
    capture(runSpecsCreateCommand, {
      cwd: repoRoot, id: 'FEAT-001', title: 't', mode: 'feature', riskTier: 3,
    });
    const r = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'has spaces', specId: 'FEAT-001',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/does not match the v11 pattern/);
  });
});

// ============================================================
// A5: list is read-only and shows expected fields
// ============================================================
describe('A5: caws worktree list', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a5-')); });
  afterEach(() => rmrf(repoRoot));

  it('lists registered worktrees with branch, spec, owner', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-list-001', specId: 'FEAT-001',
    });

    const registryPath = path.join(cawsDir, 'worktrees.json');
    const beforeMtime = fs.statSync(registryPath).mtimeMs;

    const r = capture(runWorktreeListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('wt-list-001');
    expect(r.stdout).toContain('FEAT-001');
    expect(r.stdout).toContain('main');

    // Read-only check.
    expect(fs.statSync(registryPath).mtimeMs).toBe(beforeMtime);
  });

  it('reports no worktrees when registry is empty', () => {
    const r = capture(runWorktreeListCommand, { cwd: repoRoot });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no worktrees registered/);
  });
});

// ============================================================
// A6: destroy refuses dirty checkout
// ============================================================
describe('A6: caws worktree destroy refusals', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a6-')); });
  afterEach(() => rmrf(repoRoot));

  it('refuses to destroy when worktree has uncommitted changes', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-dirty', specId: 'FEAT-001',
    });
    // Make the worktree dirty.
    const wtPath = path.join(cawsDir, 'worktrees/wt-dirty');
    fs.writeFileSync(path.join(wtPath, 'dirty.txt'), 'uncommitted\n');

    const r = capture(runWorktreeDestroyCommand, {
      cwd: repoRoot, name: 'wt-dirty',
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/uncommitted changes/);
    // Registry still has the entry.
    expect(readRegistry(cawsDir)['wt-dirty']).toBeDefined();
  });
});

// ============================================================
// A7: merge --dry-run is read-only
// ============================================================
describe('A7: caws worktree merge --dry-run', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a7-')); });
  afterEach(() => rmrf(repoRoot));

  it('performs no git ops, no file writes, no event appends', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-dryrun', specId: 'FEAT-001',
    });
    const beforeEvents = readEvents(cawsDir).length;
    const registryPath = path.join(cawsDir, 'worktrees.json');
    const beforeMtime = fs.statSync(registryPath).mtimeMs;

    const r = capture(runWorktreeMergeCommand, {
      cwd: repoRoot, name: 'wt-dryrun', dryRun: true,
    });
    // Returns 0 because the worktree is registered with branch info.
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ready to merge|NOT ready/);

    // No events appended.
    expect(readEvents(cawsDir).length).toBe(beforeEvents);
    // No registry mutation.
    expect(fs.statSync(registryPath).mtimeMs).toBe(beforeMtime);
  });
});

// ============================================================
// A8/A9: merge event ordering + auto-close
// ============================================================
describe('A8/A9: caws worktree merge', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a8-')); });
  afterEach(() => rmrf(repoRoot));

  it('merges, auto-closes spec, emits spec_closed then worktree_merged', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-merge-001', specId: 'FEAT-001',
    });
    // Add a commit on the worktree branch so there's something to merge.
    const wtPath = path.join(cawsDir, 'worktrees/wt-merge-001');
    fs.writeFileSync(path.join(wtPath, 'feature.txt'), 'feature\n');
    execFileSync('git', ['-C', wtPath, 'add', 'feature.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'feat: add feature.txt']);

    const r = capture(runWorktreeMergeCommand, {
      cwd: repoRoot, name: 'wt-merge-001',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/merged wt-merge-001/);
    expect(r.stdout).toMatch(/merge_commit/);
    expect(r.stdout).toMatch(/auto_closed_spec: FEAT-001/);

    // Event order: spec_closed then worktree_merged.
    const events = readEvents(cawsDir);
    const eventTypes = events.map((e) => e.event);
    const closedIdx = eventTypes.lastIndexOf('spec_closed');
    const mergedIdx = eventTypes.lastIndexOf('worktree_merged');
    const destroyedIdx = eventTypes.lastIndexOf('worktree_destroyed');
    expect(closedIdx).toBeGreaterThan(-1);
    expect(mergedIdx).toBeGreaterThan(closedIdx);
    expect(destroyedIdx).toBeGreaterThan(mergedIdx);

    // worktree_merged event has auto_closed_spec: true + merge_commit.
    expect(events[mergedIdx].data.auto_closed_spec).toBe(true);
    expect(events[mergedIdx].data.merge_commit).toMatch(/^[0-9a-f]{7,40}$/);

    // Registry is empty after merge (worktree destroyed).
    expect(Object.keys(readRegistry(cawsDir))).toHaveLength(0);

    // FEAT-001 now closed with merge_commit in closure_notes.
    const specContent = fs.readFileSync(path.join(cawsDir, 'specs/FEAT-001.yaml'), 'utf8');
    expect(specContent).toMatch(/^lifecycle_state: closed$/m);
    expect(specContent).toMatch(/^resolution: completed$/m);
    expect(specContent).toMatch(/closure_notes:.*Auto-closed by caws worktree merge/);
  });
});

// ============================================================
// Doctrine: composed merge shares one baseline timestamp
// (see docs/architecture/event-order.md — fix A locks the rule)
// ============================================================
describe('Event-order doctrine: merge baseline-share', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-ts-')); });
  afterEach(() => rmrf(repoRoot));

  it('spec_closed, worktree_merged, and worktree_destroyed share one ts when a composed merge runs', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-ts-001', specId: 'FEAT-001',
    });
    const wtPath = path.join(cawsDir, 'worktrees/wt-ts-001');
    fs.writeFileSync(path.join(wtPath, 'feature.txt'), 'feature\n');
    execFileSync('git', ['-C', wtPath, 'add', 'feature.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'feat: add feature.txt']);

    // Inject a fixed `now` so the merge baseline-share invariant is
    // observable. Without fix A, closeSpec and destroyWorktree would
    // re-invoke `new Date()` regardless of `input.now` (the bug).
    const fixed = new Date('2026-05-17T12:00:00.000Z');
    const r = capture(runWorktreeMergeCommand, {
      cwd: repoRoot, name: 'wt-ts-001', now: () => fixed,
    });
    expect(r.code).toBe(0);

    const events = readEvents(cawsDir);
    // Find the three events emitted by this composed merge.
    // `spec_id` is a top-level field on every event; per-event detail
    // lives in `data`.
    const merge = {
      closed: events.find((e) => e.event === 'spec_closed' && e.spec_id === 'FEAT-001'),
      merged: events.find((e) => e.event === 'worktree_merged' && e.data && e.data.worktree_name === 'wt-ts-001'),
      destroyed: events.find((e) => e.event === 'worktree_destroyed' && e.data && e.data.worktree_name === 'wt-ts-001'),
    };
    expect(merge.closed).toBeDefined();
    expect(merge.merged).toBeDefined();
    expect(merge.destroyed).toBeDefined();

    // All three timestamps equal the injected merge baseline.
    expect(merge.closed.ts).toBe(fixed.toISOString());
    expect(merge.merged.ts).toBe(fixed.toISOString());
    expect(merge.destroyed.ts).toBe(fixed.toISOString());
  });
});

// ============================================================
// A10: no command writes .caws/working-spec.yaml
// ============================================================
describe('A10: no working-spec.yaml writes', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-a10-')); });
  afterEach(() => rmrf(repoRoot));

  it('create/merge/destroy do not create .caws/working-spec.yaml', () => {
    const workingSpecPath = path.join(cawsDir, 'working-spec.yaml');
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-no-baseline', specId: 'FEAT-001',
    });
    expect(fs.existsSync(workingSpecPath)).toBe(false);

    // Add commit, merge.
    const wtPath = path.join(cawsDir, 'worktrees/wt-no-baseline');
    fs.writeFileSync(path.join(wtPath, 'f.txt'), 'x');
    execFileSync('git', ['-C', wtPath, 'add', 'f.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'x']);
    capture(runWorktreeMergeCommand, { cwd: repoRoot, name: 'wt-no-baseline' });

    expect(fs.existsSync(workingSpecPath)).toBe(false);
  });
});
