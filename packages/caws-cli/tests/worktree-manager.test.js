/**
 * @fileoverview Tests for CAWS Git Worktree Manager
 */

const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const { execFileSync } = require('child_process');

// Module under test
const {
  createWorktree,
  listWorktrees,
  destroyWorktree,
  mergeWorktree,
  pruneWorktrees,
  loadRegistry,
  getLastCommitInfo,
  isBranchMerged,
  discoverUnregisteredWorktrees,
  autoRegisterWorktree,
  repairWorktrees,
  reconcileRegistry,
  getRepoRoot,
  WORKTREES_DIR,
  REGISTRY_FILE,
  BRANCH_PREFIX,
} = require('../src/worktree/worktree-manager');

describe('worktree-manager', () => {
  let testDir;
  let originalCwd;
  let originalSessionId;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalSessionId = process.env.CLAUDE_SESSION_ID;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-worktree-test-'));

    // Initialize a git repo
    execFileSync('git', ['init', '-b', 'main'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: testDir, stdio: 'pipe' });

    // Create initial commit
    fs.writeFileSync(path.join(testDir, 'README.md'), '# Test');
    fs.ensureDirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'index.js'), 'module.exports = {};');
    execFileSync('git', ['add', '.'], { cwd: testDir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'pipe' });

    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    // Restore session ID
    if (originalSessionId !== undefined) {
      process.env.CLAUDE_SESSION_ID = originalSessionId;
    } else {
      delete process.env.CLAUDE_SESSION_ID;
    }
    // Clean up worktrees first (required before deleting dir)
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });
    } catch {
      // ignore
    }
    fs.removeSync(testDir);
  });

  describe('createWorktree', () => {
    test('creates a worktree and registers it', () => {
      const entry = createWorktree('test-feature');

      expect(entry.name).toBe('test-feature');
      expect(entry.branch).toBe(`${BRANCH_PREFIX}test-feature`);
      expect(entry.status).toBe('active');
      expect(fs.existsSync(entry.path)).toBe(true);

      // Check registry
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['test-feature']).toBeDefined();
    });

    test('rejects invalid names', () => {
      expect(() => createWorktree('bad name!')).toThrow('must contain only');
      expect(() => createWorktree('')).toThrow('must contain only');
    });

    test('rejects duplicate names', () => {
      createWorktree('dupe-test');
      expect(() => createWorktree('dupe-test')).toThrow('already exists');
    });

    test('creates worktree with scope', () => {
      const entry = createWorktree('scoped', { scope: 'src/' });
      expect(entry.scope).toBe('src/');
    });

    test('creates worktree with glob scope using --no-cone sparse checkout', () => {
      // Glob patterns (containing *?[]) require --no-cone mode.
      // --cone mode rejects them with "specify directories rather than patterns".
      const entry = createWorktree('glob-scoped', { scope: 'src/**' });
      expect(entry.scope).toBe('src/**');
      expect(fs.existsSync(entry.path)).toBe(true);

      // Verify sparse checkout is active and in no-cone mode
      const sparseConfig = execFileSync(
        'git',
        ['config', '--worktree', 'core.sparseCheckoutCone'],
        { cwd: entry.path, stdio: 'pipe', encoding: 'utf8' }
      ).trim();
      expect(sparseConfig).toBe('false');
    });

    test('creates worktree with directory scope using --cone sparse checkout', () => {
      const entry = createWorktree('dir-scoped', { scope: 'src/' });
      expect(entry.scope).toBe('src/');
      expect(fs.existsSync(entry.path)).toBe(true);

      // Verify sparse checkout is in cone mode
      const sparseConfig = execFileSync(
        'git',
        ['config', '--worktree', 'core.sparseCheckoutCone'],
        { cwd: entry.path, stdio: 'pipe', encoding: 'utf8' }
      ).trim();
      expect(sparseConfig).toBe('true');
    });

    test('creates worktree with specId', () => {
      const entry = createWorktree('with-spec', { specId: 'FEAT-001' });
      expect(entry.specId).toBe('FEAT-001');
    });
  });

  describe('listWorktrees', () => {
    test('returns empty for no worktrees', () => {
      const entries = listWorktrees();
      expect(entries).toHaveLength(0);
    });

    test('lists created worktrees', () => {
      createWorktree('wt-one');
      createWorktree('wt-two');

      const entries = listWorktrees();
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.name).sort()).toEqual(['wt-one', 'wt-two']);
    });

    test('detects stale-merged worktrees when branch has no divergent commits', () => {
      const entry = createWorktree('to-vanish');
      // Manually remove the directory — branch has no divergent commits
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const entries = listWorktrees();
      // No divergent commits means branch is merged, so status is stale-merged
      expect(entries[0].status).toBe('stale-merged');
    });

    test('detects missing worktrees when branch has divergent commits', () => {
      const entry = createWorktree('to-vanish-diverged');
      // Make a divergent commit
      fs.writeFileSync(path.join(entry.path, 'diverge.txt'), 'diverged');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'diverge'], { cwd: entry.path, stdio: 'pipe' });

      // Remove the directory but keep the branch
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'to-vanish-diverged');
      expect(wt.status).toBe('missing');
    });

    test('includes lastCommit info for active worktrees', () => {
      const entry = createWorktree('with-commits');
      // Make a commit in the worktree
      fs.writeFileSync(path.join(entry.path, 'new-file.txt'), 'content');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'worktree commit'], {
        cwd: entry.path,
        stdio: 'pipe',
      });

      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'with-commits');
      expect(wt.lastCommit).toBeDefined();
      expect(wt.lastCommit.sha).toBeDefined();
      expect(wt.lastCommit.age).toBeDefined();
    });

    test('includes merged status for worktrees', () => {
      createWorktree('not-merged');
      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'not-merged');
      // No divergent commits, so branch is technically merged
      expect(wt.merged).toBe(true);
    });

    test('preserves owner from creation', () => {
      process.env.CLAUDE_SESSION_ID = 'test-session-abc123';
      const entry = createWorktree('owned-wt');
      expect(entry.owner).toBe('test-session-abc123');

      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'owned-wt');
      expect(wt.owner).toBe('test-session-abc123');
    });
  });

  describe('destroyWorktree', () => {
    test('destroys an existing worktree', () => {
      const entry = createWorktree('to-destroy');
      expect(fs.existsSync(entry.path)).toBe(true);

      destroyWorktree('to-destroy');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['to-destroy'].status).toBe('destroyed');
    });

    test('throws for unknown worktree', () => {
      expect(() => destroyWorktree('nonexistent')).toThrow('not found');
    });

    test('force destroys dirty worktree', () => {
      const entry = createWorktree('dirty-wt');
      // Create untracked file to make it "dirty"
      fs.writeFileSync(path.join(entry.path, 'dirty.txt'), 'dirty');

      destroyWorktree('dirty-wt', { force: true });
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['dirty-wt'].status).toBe('destroyed');
    });

    test('blocks destroying another session worktree without force', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner';
      createWorktree('owned-by-other');

      process.env.CLAUDE_SESSION_ID = 'session-destroyer';
      expect(() => destroyWorktree('owned-by-other')).toThrow('belongs to another session');
    });

    test('allows destroying another session worktree with force', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner';
      createWorktree('force-destroy-other');

      process.env.CLAUDE_SESSION_ID = 'session-destroyer';
      destroyWorktree('force-destroy-other', { force: true });

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['force-destroy-other'].status).toBe('destroyed');
    });

    test('allows destroying own worktree without force', () => {
      process.env.CLAUDE_SESSION_ID = 'same-session';
      createWorktree('own-wt');
      destroyWorktree('own-wt');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['own-wt'].status).toBe('destroyed');
    });

    test('auto-forces destroy when branch is already merged', () => {
      const entry = createWorktree('merged-dirty');
      // Add dirty file but branch has no divergent commits (so it's "merged")
      fs.writeFileSync(path.join(entry.path, 'dirty.txt'), 'dirty');

      // Should succeed without --force because branch is merged to base
      destroyWorktree('merged-dirty');
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['merged-dirty'].status).toBe('destroyed');
    });
  });

  describe('mergeWorktree', () => {
    test('merges a clean worktree branch to base', () => {
      const entry = createWorktree('to-merge');

      // Make a commit in the worktree
      fs.writeFileSync(path.join(entry.path, 'feature.js'), 'const x = 1;');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add feature'], {
        cwd: entry.path,
        stdio: 'pipe',
      });

      const result = mergeWorktree('to-merge');

      expect(result.merged).toBe(true);
      expect(result.conflicts).toHaveLength(0);

      // Verify file exists on base branch
      expect(fs.existsSync(path.join(testDir, 'feature.js'))).toBe(true);

      // Verify worktree is destroyed
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['to-merge'].status).toBe('destroyed');
    });

    test('dry-run detects no conflicts for clean merge', () => {
      const entry = createWorktree('dry-run-clean');

      fs.writeFileSync(path.join(entry.path, 'new-file.js'), 'clean');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'clean change'], {
        cwd: entry.path,
        stdio: 'pipe',
      });

      const result = mergeWorktree('dry-run-clean', { dryRun: true });

      expect(result.wouldMerge).toBe(true);
      expect(result.conflicts).toHaveLength(0);

      // Worktree should NOT be destroyed in dry-run
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['dry-run-clean'].status).toBe('active');
    });

    test('refuses to merge worktree with uncommitted changes', () => {
      const entry = createWorktree('dirty-merge');
      fs.writeFileSync(path.join(entry.path, 'uncommitted.js'), 'dirty');

      expect(() => mergeWorktree('dirty-merge')).toThrow('uncommitted changes');
    });

    test('uses custom merge message', () => {
      const entry = createWorktree('custom-msg');
      fs.writeFileSync(path.join(entry.path, 'custom.js'), 'custom');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'custom work'], {
        cwd: entry.path,
        stdio: 'pipe',
      });

      mergeWorktree('custom-msg', { message: 'merge(worktree): custom merge message' });

      const log = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      expect(log).toBe('merge(worktree): custom merge message');
    });

    test('throws for unknown worktree', () => {
      expect(() => mergeWorktree('nonexistent')).toThrow('not found');
    });
  });

  describe('pruneWorktrees', () => {
    test('prunes destroyed entries', () => {
      createWorktree('prune-me');
      destroyWorktree('prune-me', { force: true });

      const result = pruneWorktrees({ maxAgeDays: 0 });
      expect(result.pruned).toHaveLength(1);
      expect(result.pruned[0].name).toBe('prune-me');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['prune-me']).toBeUndefined();
    });

    test('preserves active entries', () => {
      createWorktree('keep-me');

      const result = pruneWorktrees({ maxAgeDays: 0 });
      expect(result.pruned).toHaveLength(0);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['keep-me']).toBeDefined();
    });
  });

  describe('getLastCommitInfo', () => {
    test('returns commit info for existing branch', () => {
      createWorktree('commit-info');
      const info = getLastCommitInfo(`${BRANCH_PREFIX}commit-info`, testDir);
      expect(info).not.toBeNull();
      expect(info.sha).toMatch(/^[0-9a-f]+$/);
      expect(info.age).toBeDefined();
      expect(info.timestamp).toBeInstanceOf(Date);
    });

    test('returns null for nonexistent branch', () => {
      const info = getLastCommitInfo('nonexistent-branch', testDir);
      expect(info).toBeNull();
    });
  });

  describe('isBranchMerged', () => {
    test('returns true for branch with no divergent commits', () => {
      createWorktree('no-diverge');
      const merged = isBranchMerged(`${BRANCH_PREFIX}no-diverge`, 'main', testDir);
      expect(merged).toBe(true);
    });

    test('returns false for branch with divergent commits', () => {
      const entry = createWorktree('diverged');
      fs.writeFileSync(path.join(entry.path, 'diverge.js'), 'diverged');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'diverge'], {
        cwd: entry.path,
        stdio: 'pipe',
      });

      const merged = isBranchMerged(`${BRANCH_PREFIX}diverged`, 'main', testDir);
      expect(merged).toBe(false);
    });
  });

  describe('discoverUnregisteredWorktrees', () => {
    test('returns empty when all worktrees are registered', () => {
      createWorktree('registered-wt');
      const registry = loadRegistry(testDir);
      const unregistered = discoverUnregisteredWorktrees(testDir, registry);
      expect(unregistered).toHaveLength(0);
    });

    test('discovers worktree created via git directly', () => {
      // Create worktree bypassing CAWS registry
      const wtPath = path.join(testDir, WORKTREES_DIR, 'manual-wt');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/manual-wt', wtPath, 'main'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      const registry = loadRegistry(testDir);
      const unregistered = discoverUnregisteredWorktrees(testDir, registry);
      expect(unregistered).toHaveLength(1);
      expect(unregistered[0].name).toBe('manual-wt');
      expect(unregistered[0].branch).toBe('caws/manual-wt');
    });

    test('ignores worktrees outside .caws/worktrees/', () => {
      // Create worktree in a different location
      const wtPath = path.join(testDir, 'other-location', 'outside-wt');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'other-branch', wtPath, 'main'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      const registry = loadRegistry(testDir);
      const unregistered = discoverUnregisteredWorktrees(testDir, registry);
      expect(unregistered).toHaveLength(0);

      // Cleanup
      execFileSync('git', ['worktree', 'remove', wtPath], { cwd: testDir, stdio: 'pipe' });
    });
  });

  describe('unregistered worktree recovery', () => {
    test('mergeWorktree auto-registers and merges unregistered worktree', () => {
      // Create worktree bypassing CAWS registry
      const wtPath = path.join(testDir, WORKTREES_DIR, 'unreg-merge');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/unreg-merge', wtPath, 'main'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      // Make a commit in the unregistered worktree
      fs.writeFileSync(path.join(wtPath, 'unreg-feature.js'), 'const y = 2;');
      execFileSync('git', ['add', '.'], { cwd: wtPath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'unreg feature'], { cwd: wtPath, stdio: 'pipe' });

      // Merge should auto-register and succeed
      const result = mergeWorktree('unreg-merge');
      expect(result.merged).toBe(true);
      expect(result.conflicts).toHaveLength(0);

      // File should exist on base branch
      expect(fs.existsSync(path.join(testDir, 'unreg-feature.js'))).toBe(true);
    });

    test('destroyWorktree auto-registers and destroys unregistered worktree', () => {
      // Create worktree bypassing CAWS registry
      const wtPath = path.join(testDir, WORKTREES_DIR, 'unreg-destroy');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/unreg-destroy', wtPath, 'main'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      // Destroy should auto-register and succeed
      destroyWorktree('unreg-destroy', { force: true });

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['unreg-destroy'].status).toBe('destroyed');
      expect(registry.worktrees['unreg-destroy'].autoRegistered).toBe(true);
    });

    test('listWorktrees shows unregistered worktrees with status', () => {
      // Create worktree bypassing CAWS registry
      const wtPath = path.join(testDir, WORKTREES_DIR, 'unreg-list');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/unreg-list', wtPath, 'main'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      const entries = listWorktrees();
      const unreg = entries.find((e) => e.name === 'unreg-list');
      expect(unreg).toBeDefined();
      expect(unreg.status).toBe('unregistered');
      expect(unreg.branch).toBe('caws/unreg-list');

      // Cleanup
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: testDir, stdio: 'pipe' });
    });

    test('merge still throws for completely nonexistent worktree', () => {
      expect(() => mergeWorktree('totally-fake')).toThrow('not found in registry or git');
    });

    test('destroy still throws for completely nonexistent worktree', () => {
      expect(() => destroyWorktree('totally-fake')).toThrow('not found in registry or git');
    });
  });


  describe('getRepoRoot from linked worktree', () => {
    test('resolves to main repo root when CWD is inside a linked worktree', () => {
      const entry = createWorktree('cwd-test');
      const mainRoot = process.cwd(); // We're in testDir (main repo)

      // Change into the linked worktree
      process.chdir(entry.path);

      // getRepoRoot should still return the main repo, not the worktree
      const resolved = getRepoRoot();
      expect(path.resolve(resolved)).toBe(path.resolve(mainRoot));

      // Restore CWD
      process.chdir(mainRoot);
    });
  });

  describe('reconcileRegistry', () => {
    test('classifies active, missing, and unregistered entries', () => {
      const entry = createWorktree('recon-active');
      createWorktree('recon-vanish');

      // Remove one worktree's directory to make it missing/stale-merged
      fs.removeSync(path.join(testDir, WORKTREES_DIR, 'recon-vanish'));
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const { entries } = reconcileRegistry(testDir);
      const active = entries.find((e) => e.name === 'recon-active');
      const vanished = entries.find((e) => e.name === 'recon-vanish');

      expect(active.status).toBe('active');
      // No divergent commits, so stale-merged
      expect(vanished.status).toBe('stale-merged');
    });

    test('does not mutate registry', () => {
      createWorktree('recon-readonly');
      fs.removeSync(path.join(testDir, WORKTREES_DIR, 'recon-readonly'));
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const registryBefore = JSON.stringify(loadRegistry(testDir));
      reconcileRegistry(testDir);
      const registryAfter = JSON.stringify(loadRegistry(testDir));

      expect(registryAfter).toBe(registryBefore);
    });
  });

  describe('repairWorktrees', () => {
    test('auto-registers unregistered worktrees', () => {
      // Create worktree via git directly
      const wtPath = path.join(testDir, WORKTREES_DIR, 'repair-unreg');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/repair-unreg', wtPath, 'main'], {
        cwd: testDir, stdio: 'pipe',
      });

      const result = repairWorktrees({ dryRun: false });
      expect(result.repaired.length).toBeGreaterThanOrEqual(1);
      const registered = result.repaired.find((r) => r.name === 'repair-unreg');
      expect(registered).toBeDefined();
      expect(registered.action).toBe('registered');

      // Cleanup
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: testDir, stdio: 'pipe' });
    });

    test('dry-run does not persist changes', () => {
      const wtPath = path.join(testDir, WORKTREES_DIR, 'repair-dry');
      fs.ensureDirSync(path.dirname(wtPath));
      execFileSync('git', ['worktree', 'add', '-b', 'caws/repair-dry', wtPath, 'main'], {
        cwd: testDir, stdio: 'pipe',
      });

      const registryBefore = JSON.stringify(loadRegistry(testDir));
      repairWorktrees({ dryRun: true });
      const registryAfter = JSON.stringify(loadRegistry(testDir));

      expect(registryAfter).toBe(registryBefore);

      // Cleanup
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: testDir, stdio: 'pipe' });
    });

    test('prune flag removes destroyed entries', () => {
      createWorktree('repair-prune');
      destroyWorktree('repair-prune', { force: true });

      const result = repairWorktrees({ prune: true });
      expect(result.pruned.some((p) => p.name === 'repair-prune')).toBe(true);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['repair-prune']).toBeUndefined();
    });
  });

});
