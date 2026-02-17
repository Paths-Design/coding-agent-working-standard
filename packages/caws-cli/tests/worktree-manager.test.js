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
  pruneWorktrees,
  loadRegistry,
  WORKTREES_DIR,
  REGISTRY_FILE,
  BRANCH_PREFIX,
} = require('../src/worktree/worktree-manager');

describe('worktree-manager', () => {
  let testDir;
  let originalCwd;

  beforeEach(async () => {
    originalCwd = process.cwd();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'caws-worktree-test-'));

    // Initialize a git repo
    execFileSync('git', ['init'], { cwd: testDir, stdio: 'pipe' });
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

    test('detects missing worktrees', () => {
      const entry = createWorktree('to-vanish');
      // Manually remove the directory
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const entries = listWorktrees();
      expect(entries[0].status).toBe('missing');
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
  });

  describe('pruneWorktrees', () => {
    test('prunes destroyed entries', () => {
      createWorktree('prune-me');
      destroyWorktree('prune-me', { force: true });

      const pruned = pruneWorktrees({ maxAgeDays: 0 });
      expect(pruned).toHaveLength(1);
      expect(pruned[0].name).toBe('prune-me');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['prune-me']).toBeUndefined();
    });

    test('preserves active entries', () => {
      createWorktree('keep-me');

      const pruned = pruneWorktrees({ maxAgeDays: 0 });
      expect(pruned).toHaveLength(0);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['keep-me']).toBeDefined();
    });
  });
});
