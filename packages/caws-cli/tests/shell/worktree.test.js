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
  runWorktreeRepairSparseCommand,
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

// ============================================================
// WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 — terminal-transition
// clearance of spec.worktree binding.
// ============================================================
describe('WORKTREE-MERGE-CLEARS-SPEC-BINDING-001 — spec.worktree clearance on terminal transitions', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-wmcsb-')); });
  afterEach(() => rmrf(repoRoot));

  it('A1: caws worktree merge clears spec.worktree (byte-level: no ^worktree: remains) and records prior_worktree on spec_closed', () => {
    // Create + bind worktree.
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'feat-001-wt', specId: 'FEAT-001',
    });
    const specPath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    let specContent = fs.readFileSync(specPath, 'utf8');
    expect(/^worktree: feat-001-wt$/m.test(specContent)).toBe(true);

    // Add commit so merge has something to integrate.
    const wtPath = path.join(cawsDir, 'worktrees/feat-001-wt');
    fs.writeFileSync(path.join(wtPath, 'a.txt'), 'a');
    execFileSync('git', ['-C', wtPath, 'add', 'a.txt']);
    execFileSync('git', ['-C', wtPath, 'commit', '--quiet', '-m', 'add a']);

    // Merge — this triggers auto-close path via closeSpec.
    const r = capture(runWorktreeMergeCommand, { cwd: repoRoot, name: 'feat-001-wt' });
    expect(r.code).toBe(0);

    // Byte-level invariant: grep '^worktree:' returns no match.
    specContent = fs.readFileSync(specPath, 'utf8');
    expect(/^worktree:/m.test(specContent)).toBe(false);

    // Spec is closed. Match `lifecycle_state: closed` tolerant of whitespace.
    expect(/^lifecycle_state:\s*closed\b/m.test(specContent)).toBe(true);
    expect(/^resolution:\s*completed\b/m.test(specContent)).toBe(true);

    // spec_closed event includes prior_worktree.
    const events = readEvents(cawsDir);
    const specClosed = events.find(e => e.event === 'spec_closed' && e.spec_id === 'FEAT-001');
    expect(specClosed).toBeDefined();
    expect(specClosed.data.prior_worktree).toBe('feat-001-wt');
  });

  it('A2: caws specs close on an active spec with a stale worktree: binding clears the binding in the same YAML patch', () => {
    // Create + bind, then manually delete the worktree directory (simulating
    // `git worktree remove` outside CAWS or another drift cause). We leave
    // the spec's worktree: field present + the registry entry; closeSpec
    // must clear the spec field.
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'feat-001-wt', specId: 'FEAT-001',
    });
    const specPath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    expect(/^worktree: feat-001-wt$/m.test(fs.readFileSync(specPath, 'utf8'))).toBe(true);

    // Run closeSpec directly. This bypasses the merge path; tests A2's
    // drift-recovery case.
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot,
      id: 'FEAT-001',
      resolution: 'completed',
      reason: 'A2 test — close active spec with stale worktree binding',
    });
    expect(r.code).toBe(0);

    // Byte-level invariant.
    const after = fs.readFileSync(specPath, 'utf8');
    expect(/^worktree:/m.test(after)).toBe(false);
    expect(/^lifecycle_state: closed$/m.test(after)).toBe(true);

    // spec_closed event includes prior_worktree (binding was cleared).
    const events = readEvents(cawsDir);
    const specClosed = events.find(e => e.event === 'spec_closed' && e.spec_id === 'FEAT-001');
    expect(specClosed).toBeDefined();
    expect(specClosed.data.prior_worktree).toBe('feat-001-wt');
  });

  it('A3: caws worktree destroy on a still-active spec removes the registry entry AND clears spec.worktree (byte-level), spec stays active', () => {
    capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'feat-001-wt', specId: 'FEAT-001',
    });
    const specPath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    expect(/^worktree: feat-001-wt$/m.test(fs.readFileSync(specPath, 'utf8'))).toBe(true);

    // Destroy without merging. Worktree must be clean — it is, since we
    // never wrote to it.
    const r = capture(runWorktreeDestroyCommand, { cwd: repoRoot, name: 'feat-001-wt' });
    expect(r.code).toBe(0);

    // Byte-level invariant on spec.
    const after = fs.readFileSync(specPath, 'utf8');
    expect(/^worktree:/m.test(after)).toBe(false);

    // Spec remains active (destroy does not auto-close).
    expect(/^lifecycle_state: active$/m.test(after)).toBe(true);

    // Registry no longer has the active entry (may have status: destroyed
    // as an audit record — either way, no live binding).
    const registry = readRegistry(cawsDir);
    const entry = registry.worktrees ? registry.worktrees['feat-001-wt'] : registry['feat-001-wt'];
    // Accept either absent or marked destroyed; the contract is no live binding.
    if (entry !== undefined) {
      expect(entry.status).toBe('destroyed');
    }
  });

  it('A5: closeSpec on a spec with NO prior worktree binding works (no spurious prior_worktree, no errors)', () => {
    // The setupRepoWithSpec helper created FEAT-001 with NO worktree binding.
    // Confirm the precondition.
    const specPath = path.join(cawsDir, 'specs/FEAT-001.yaml');
    expect(/^worktree:/m.test(fs.readFileSync(specPath, 'utf8'))).toBe(false);

    // Close it.
    const r = capture(runSpecsCloseCommand, {
      cwd: repoRoot,
      id: 'FEAT-001',
      resolution: 'completed',
      reason: 'A5 test — close spec with no prior binding',
    });
    expect(r.code).toBe(0);

    // Still no worktree line.
    const after = fs.readFileSync(specPath, 'utf8');
    expect(/^worktree:/m.test(after)).toBe(false);
    expect(/^lifecycle_state: closed$/m.test(after)).toBe(true);

    // spec_closed event must NOT include prior_worktree.
    const events = readEvents(cawsDir);
    const specClosed = events.find(e => e.event === 'spec_closed' && e.spec_id === 'FEAT-001');
    expect(specClosed).toBeDefined();
    expect(specClosed.data.prior_worktree).toBeUndefined();
  });
});

// ============================================================
// WORKTREE-SPEC-CANONICAL-ACCESS-GUARD-001
//   A4: repair-sparse restores sparse invariant + is idempotent
//   A5: refuses missing-registry / missing-path / canonical-target /
//       not-a-worktree / dirty-specs without destructive cleanup
// ============================================================
describe('A4/A5: caws worktree repair-sparse', () => {
  let repoRoot, cawsDir;
  beforeEach(() => { ({ repoRoot, cawsDir } = setupRepoWithSpec('wt-repair-sparse-')); });
  afterEach(() => rmrf(repoRoot));

  // Helper: write a spec file to the canonical .caws/specs/ so create's
  // sparse-checkout configuration has something to exclude.
  function ensureSpecAuthority(specId) {
    const specPath = path.join(cawsDir, 'specs', `${specId}.yaml`);
    if (!fs.existsSync(specPath)) {
      throw new Error(`expected spec ${specPath} to exist (setupRepoWithSpec creates it)`);
    }
    // Commit the spec so it's part of HEAD. createWorktree's sparse-
    // checkout init runs against HEAD, so unchecked spec files would
    // be irrelevant. Stage and commit.
    execFileSync('git', ['-C', repoRoot, 'add', '.caws/'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, '-c', 'user.email=t@t', '-c', 'user.name=t',
      'commit', '--quiet', '-m', 'add spec authority'], { stdio: 'ignore' });
  }

  it('A4: repair-sparse restores sparse invariant after manual disable + is idempotent', () => {
    ensureSpecAuthority('FEAT-001');

    // Create the worktree (which configures sparse-checkout by design).
    const cr = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a4', specId: 'FEAT-001',
    });
    expect(cr.code).toBe(0);
    const wtPath = path.join(cawsDir, 'worktrees/wt-a4');

    // Pre-condition: sparse on, .caws/specs absent in the worktree.
    expect(execFileSync('git', ['-C', wtPath, 'config', 'core.sparseCheckout'], { encoding: 'utf8' }).trim())
      .toBe('true');
    expect(fs.existsSync(path.join(wtPath, '.caws/specs'))).toBe(false);

    // Simulate the agent-bypass scenario: disable sparse-checkout
    // manually (e.g., via the very command this slice's hook upgrade
    // refuses for agents but a human could still run).
    execFileSync('git', ['-C', wtPath, 'sparse-checkout', 'disable'], { stdio: 'ignore' });
    expect(fs.existsSync(path.join(wtPath, '.caws/specs/FEAT-001.yaml'))).toBe(true);

    // First repair: should succeed.
    const r1 = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'wt-a4',
    });
    expect(r1.code).toBe(0);
    expect(r1.stdout).toMatch(/sparse invariant restored/);

    // Post-condition: sparse on, .caws/specs absent again.
    expect(execFileSync('git', ['-C', wtPath, 'config', 'core.sparseCheckout'], { encoding: 'utf8' }).trim())
      .toBe('true');
    expect(fs.existsSync(path.join(wtPath, '.caws/specs'))).toBe(false);

    // Idempotency: second repair on the now-healthy worktree is a no-op.
    const r2 = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'wt-a4',
    });
    expect(r2.code).toBe(0);
    expect(r2.stdout).toMatch(/already has the sparse invariant/);
    expect(r2.stdout).toMatch(/No action taken/);
  });

  it('A5a: refuses missing-registry (name not in worktrees.json)', () => {
    const r = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'does-not-exist',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/missing-registry/);
    expect(r.stderr).toMatch(/'does-not-exist' is not in \.caws\/worktrees\.json/);
    // Recovery guidance present.
    expect(r.stderr).toMatch(/caws worktree list/);
  });

  it('A5b: refuses missing-path (registry entry present, on-disk path absent)', () => {
    ensureSpecAuthority('FEAT-001');
    const cr = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a5b', specId: 'FEAT-001',
    });
    expect(cr.code).toBe(0);

    // Remove the on-disk worktree directory while leaving the registry entry.
    // (Not via caws worktree destroy — that would also clean up the registry.)
    const wtPath = path.join(cawsDir, 'worktrees/wt-a5b');
    fs.rmSync(wtPath, { recursive: true, force: true });

    const r = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'wt-a5b',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/missing-path/);
    expect(r.stderr).toMatch(/does not exist on disk/);
  });

  it('A5c: refuses canonical-target (recorded path equals canonical checkout root)', () => {
    // Write a registry entry whose path points at canonical itself.
    const registryPath = path.join(cawsDir, 'worktrees.json');
    const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : {};
    registry['canonical-ish'] = {
      specId: 'FEAT-001',
      branch: 'main',
      baseBranch: 'main',
      path: repoRoot,
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const r = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'canonical-ish',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/canonical-target-refused/);
    expect(r.stderr).toMatch(/canonical checkout IS spec authority/);
  });

  it('A5d: refuses not-a-worktree (path exists but no .git)', () => {
    // Write a registry entry pointing at a real directory that is not
    // a git worktree.
    const fakePath = path.join(repoRoot, 'not-a-worktree-dir');
    fs.mkdirSync(fakePath);
    const registryPath = path.join(cawsDir, 'worktrees.json');
    const registry = fs.existsSync(registryPath) ? JSON.parse(fs.readFileSync(registryPath, 'utf8')) : {};
    registry['wt-a5d'] = {
      specId: 'FEAT-001',
      branch: 'irrelevant',
      baseBranch: 'main',
      path: fakePath,
    };
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

    const r = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'wt-a5d',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not-a-worktree/);
    expect(r.stderr).toMatch(/not a git worktree/);
    // Manual-recovery guidance, and no PROMISE of destructive auto-cleanup
    // (the diagnostic may WARN against destructive recovery, but must not
    // claim to perform any).
    expect(r.stderr).toMatch(/investigate manually/);
    expect(r.stderr).not.toMatch(/will (stash|clean|reset|delete|remove)/i);
    expect(r.stderr).not.toMatch(/auto-(cleanup|recover|delete|remove)/i);
  });

  it('A5e: refuses dirty-specs without stash, clean, reset, or deletion', () => {
    ensureSpecAuthority('FEAT-001');
    const cr = capture(runWorktreeCreateCommand, {
      cwd: repoRoot, name: 'wt-a5e', specId: 'FEAT-001',
    });
    expect(cr.code).toBe(0);
    const wtPath = path.join(cawsDir, 'worktrees/wt-a5e');

    // Disable sparse to materialize .caws/specs/, then dirty it.
    execFileSync('git', ['-C', wtPath, 'sparse-checkout', 'disable'], { stdio: 'ignore' });
    const dirtySpec = path.join(wtPath, '.caws/specs/FEAT-001.yaml');
    expect(fs.existsSync(dirtySpec)).toBe(true);
    // Append unstaged content — makes the file dirty per git status.
    fs.appendFileSync(dirtySpec, '\n# unauthorized edit from inside worktree\n');
    // Also create an untracked file under .caws/specs/.
    fs.writeFileSync(path.join(wtPath, '.caws/specs/DRAFT-XYZ.yaml'), 'id: DRAFT-XYZ\n');

    // Capture state-before for the negative invariant.
    const dirtySpecBytesBefore = fs.readFileSync(dirtySpec, 'utf8');
    const draftExistsBefore = fs.existsSync(path.join(wtPath, '.caws/specs/DRAFT-XYZ.yaml'));

    const r = capture(runWorktreeRepairSparseCommand, {
      cwd: repoRoot, name: 'wt-a5e',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/dirty-specs-refused/);
    expect(r.stderr).toMatch(/uncommitted changes/);
    // Diagnostic must name the specific dirty paths so the user can
    // act on them.
    expect(r.stderr).toMatch(/FEAT-001\.yaml/);
    expect(r.stderr).toMatch(/DRAFT-XYZ\.yaml/);
    // Diagnostic explicitly disclaims destructive cleanup.
    expect(r.stderr).toMatch(/will NOT stash, clean, reset, or delete/);
    // Recovery guidance is manual: commit-or-remove THEN re-run.
    expect(r.stderr).toMatch(/commit or remove the dirty files first/);

    // CRITICAL negative invariant: the dirty file's bytes are unchanged,
    // and the untracked file still exists. No stash/clean/reset/delete
    // happened.
    expect(fs.readFileSync(dirtySpec, 'utf8')).toBe(dirtySpecBytesBefore);
    expect(fs.existsSync(path.join(wtPath, '.caws/specs/DRAFT-XYZ.yaml'))).toBe(draftExistsBefore);
    // And sparse-checkout is still disabled (we did not flip it back).
    let sparseFlag;
    try {
      sparseFlag = execFileSync('git', ['-C', wtPath, 'config', 'core.sparseCheckout'], { encoding: 'utf8' }).trim();
    } catch {
      sparseFlag = '(absent)';
    }
    expect(sparseFlag === 'false' || sparseFlag === '(absent)').toBe(true);
  });
});
