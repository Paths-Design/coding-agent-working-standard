/**
 * @fileoverview Tests for CAWS Git Worktree Manager
 */

const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');
const { createTemplateRepo, cloneFixture, cleanupTestDir, cleanupTemplate } = require('./helpers/git-fixture');

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
  hasDivergentCommits,
  hasDirtyFiles,
  discoverUnregisteredWorktrees,
  autoRegisterWorktree,
  repairWorktrees,
  reconcileRegistry,
  getRepoRoot,
  WORKTREES_DIR,
  BRANCH_PREFIX,
  inferSpecIdForWorktree,
  findSpecByWorktreeName,
  saveRegistry,
} = require('../src/worktree/worktree-manager');

describe('worktree-manager', () => {
  let templateDir;
  let testDir;
  let originalCwd;
  let originalSessionId;

  // Create template repo once for all tests
  beforeAll(() => {
    templateDir = createTemplateRepo();
  });

  afterAll(() => {
    cleanupTemplate(templateDir);
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSessionId = process.env.CLAUDE_SESSION_ID;
    testDir = cloneFixture(templateDir, 'caws-worktree-test-');
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSessionId !== undefined) {
      process.env.CLAUDE_SESSION_ID = originalSessionId;
    } else {
      delete process.env.CLAUDE_SESSION_ID;
    }
    cleanupTestDir(testDir);
  });

  describe('createWorktree', () => {
    test('creates a worktree and registers it', () => {
      const entry = createWorktree('test-feature');

      expect(entry.name).toBe('test-feature');
      expect(entry.branch).toBe(`${BRANCH_PREFIX}test-feature`);
      expect(entry.status).toBe('fresh');
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

    test('rejects creating worktree when branch exists and is owned by another session', () => {
      // Simulate: Agent A creates worktree, destroys it, branch still exists
      const original = process.env.CLAUDE_SESSION_ID;
      process.env.CLAUDE_SESSION_ID = 'session-agent-A';
      createWorktree('owned-branch');
      destroyWorktree('owned-branch');

      // Agent B tries to create same name
      process.env.CLAUDE_SESSION_ID = 'session-agent-B';
      expect(() => createWorktree('owned-branch')).toThrow('owned by session');

      // Restore
      if (original) process.env.CLAUDE_SESSION_ID = original;
      else delete process.env.CLAUDE_SESSION_ID;
    });

    test('allows reusing name when branch is gone and entry is destroyed', () => {
      const entry = createWorktree('reusable');
      const branchName = entry.branch;
      destroyWorktree('reusable');

      // Manually delete the branch to simulate full cleanup
      try {
        execFileSync('git', ['branch', '-D', branchName], { cwd: testDir, stdio: 'pipe' });
      } catch (_) {
        // Expected: branch may not exist
      }

      // Should succeed — both registry entry destroyed and branch gone
      const reused = createWorktree('reusable');
      expect(reused.name).toBe('reusable');
      expect(reused.status).toBe('fresh');
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

    test('infers specId from a worktree-local spec copy', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'FEAT-123.yaml'),
        ['id: FEAT-123', 'title: Feature 123', 'acceptance: []'].join('\n')
      );

      const entry = createWorktree('with-inferred-spec', { specId: 'FEAT-123' });
      expect(inferSpecIdForWorktree(entry.path)).toBe('FEAT-123');
    });

    test('derives worktree working spec from canonical feature spec when available', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      const canonicalSpec = [
        'id: FEAT-001',
        'title: Canonical Feature',
        'risk_tier: 2',
        'mode: feature',
        'acceptance:',
        '  - id: A1',
        '    given: user is in worktree',
        '    when: the feature spec is resolved',
        '    then: the worktree should use canonical content',
      ].join('\n');
      fs.writeFileSync(path.join(testDir, '.caws', 'specs', 'FEAT-001.yaml'), canonicalSpec);

      const entry = createWorktree('with-canonical-spec', { specId: 'FEAT-001' });
      const worktreeWorkingSpec = path.join(entry.path, '.caws', 'working-spec.yaml');
      const worktreeFeatureSpec = path.join(entry.path, '.caws', 'specs', 'FEAT-001.yaml');

      expect(fs.existsSync(worktreeWorkingSpec)).toBe(true);
      expect(fs.existsSync(worktreeFeatureSpec)).toBe(true);
      const canonicalAfter = fs.readFileSync(path.join(testDir, '.caws', 'specs', 'FEAT-001.yaml'), 'utf8');
      const worktreeWorkingContent = fs.readFileSync(worktreeWorkingSpec, 'utf8');
      const worktreeFeatureContent = fs.readFileSync(worktreeFeatureSpec, 'utf8');

      expect(canonicalAfter).toContain('worktree: with-canonical-spec');
      expect(worktreeWorkingContent).toBe(canonicalAfter);
      expect(worktreeFeatureContent).toBe(canonicalAfter);
    });

    test('auto-commits only the canonical spec before creating a bound worktree', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'FEAT-900.yaml'),
        [
          'id: FEAT-900',
          'title: Dirty canonical spec',
          'risk_tier: 2',
          'mode: feature',
          'acceptance: []',
          'notes: pending bind',
        ].join('\n')
      );
      fs.writeFileSync(path.join(testDir, 'unrelated-dirty.txt'), 'leave me dirty\n');

      const entry = createWorktree('auto-commit-spec', { specId: 'FEAT-900' });
      const specPath = path.join(testDir, '.caws', 'specs', 'FEAT-900.yaml');
      const worktreeSpecPath = path.join(entry.path, '.caws', 'specs', 'FEAT-900.yaml');
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe',
      });
      const lastSubject = execFileSync('git', ['log', '-1', '--format=%s'], {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();

      expect(fs.readFileSync(specPath, 'utf8')).toContain('worktree: auto-commit-spec');
      expect(fs.readFileSync(worktreeSpecPath, 'utf8')).toContain('worktree: auto-commit-spec');
      expect(status).toContain('?? unrelated-dirty.txt');
      expect(status).not.toContain('.caws/specs/FEAT-900.yaml');
      expect(lastSubject).toBe('chore(caws): bind spec FEAT-900 to worktree auto-commit-spec');
    });

    test('adds worktree field to generated fallback working spec', () => {
      const entry = createWorktree('generated-spec', { specId: 'FEAT-404' });
      const worktreeWorkingSpec = path.join(entry.path, '.caws', 'working-spec.yaml');

      expect(fs.existsSync(worktreeWorkingSpec)).toBe(true);
      expect(fs.readFileSync(worktreeWorkingSpec, 'utf8')).toContain('worktree: generated-spec');
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

  describe('autoRegisterWorktree', () => {
    test('recovers specId from worktree-local spec files', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'FEAT-777.yaml'),
        ['id: FEAT-777', 'title: Recovered spec', 'acceptance: []'].join('\n')
      );

      const created = createWorktree('recover-spec', { specId: 'FEAT-777' });
      const registry = loadRegistry(testDir);
      delete registry.worktrees['recover-spec'];

      const registered = autoRegisterWorktree(testDir, registry, {
        name: 'recover-spec',
        path: created.path,
        branch: created.branch,
      });

      expect(registered.specId).toBe('FEAT-777');
      expect(registry.worktrees['recover-spec'].specId).toBe('FEAT-777');
    });
  });

  describe('destroyWorktree', () => {
    test('destroys an existing worktree', () => {
      const entry = createWorktree('to-destroy');
      expect(fs.existsSync(entry.path)).toBe(true);

      destroyWorktree('to-destroy');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['to-destroy'].status).toBe('destroyed');
      // C1: Verify directory is actually removed from disk
      expect(fs.existsSync(entry.path)).toBe(false);
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
      // C1: Verify directory is actually removed from disk
      expect(fs.existsSync(entry.path)).toBe(false);
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
      // C1: Verify directory is actually removed from disk
      expect(fs.existsSync(entry.path)).toBe(false);
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
      expect(registry.worktrees['dry-run-clean'].status).toBe('fresh');
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
    test('classifies fresh, active, missing, and unregistered entries', () => {
      createWorktree('recon-fresh');
      const activeEntry = createWorktree('recon-active');
      createWorktree('recon-vanish');

      // Make a commit in recon-active to make it truly active
      fs.writeFileSync(path.join(activeEntry.path, 'work.txt'), 'work');
      execFileSync('git', ['add', '.'], { cwd: activeEntry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'real work'], { cwd: activeEntry.path, stdio: 'pipe' });

      // Remove one worktree's directory to make it missing/stale-merged
      fs.removeSync(path.join(testDir, WORKTREES_DIR, 'recon-vanish'));
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const { entries } = reconcileRegistry(testDir);
      const fresh = entries.find((e) => e.name === 'recon-fresh');
      const active = entries.find((e) => e.name === 'recon-active');
      const vanished = entries.find((e) => e.name === 'recon-vanish');

      // No commits yet → fresh
      expect(fresh.status).toBe('fresh');
      // Has divergent commits → active
      expect(active.status).toBe('active');
      // No divergent commits, directory gone → stale-merged
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

    test('prune flag removes missing entries (branch gone, directory gone)', () => {
      const entry = createWorktree('repair-missing');
      // Make a divergent commit so it's not stale-merged
      fs.writeFileSync(path.join(entry.path, 'work.txt'), 'work');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'diverge'], { cwd: entry.path, stdio: 'pipe' });

      // Remove directory and delete branch — simulates ghost entry
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });
      execFileSync('git', ['branch', '-D', `${BRANCH_PREFIX}repair-missing`], { cwd: testDir, stdio: 'pipe' });

      const result = repairWorktrees({ prune: true });
      expect(result.pruned.some((p) => p.name === 'repair-missing')).toBe(true);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['repair-missing']).toBeUndefined();
    });

    test('skips pruning entries owned by another session', () => {
      process.env.CLAUDE_SESSION_ID = 'session-creator';
      createWorktree('repair-owned');
      destroyWorktree('repair-owned', { force: true });

      process.env.CLAUDE_SESSION_ID = 'session-cleaner';
      const result = repairWorktrees({ prune: true });
      expect(result.skipped.some((s) => s.name === 'repair-owned')).toBe(true);
      expect(result.pruned.some((p) => p.name === 'repair-owned')).toBe(false);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['repair-owned']).toBeDefined();
    });

    test('force flag overrides ownership check for prune', () => {
      process.env.CLAUDE_SESSION_ID = 'session-creator';
      createWorktree('repair-force-owned');
      destroyWorktree('repair-force-owned', { force: true });

      process.env.CLAUDE_SESSION_ID = 'session-cleaner';
      const result = repairWorktrees({ prune: true, force: true });
      expect(result.pruned.some((p) => p.name === 'repair-force-owned')).toBe(true);

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['repair-force-owned']).toBeUndefined();
    });

    test('repair output includes owner info for status-updated entries', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner-abc';
      const entry = createWorktree('repair-owner-info');
      // Remove directory to trigger status update
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      const result = repairWorktrees({ dryRun: true });
      const repaired = result.repaired.find((r) => r.name === 'repair-owner-info');
      expect(repaired).toBeDefined();
      expect(repaired.owner).toBe('session-owner-abc');
    });
  });

  describe('pruneWorktrees ownership', () => {
    test('skips pruning entries owned by another session', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner';
      const entry = createWorktree('prune-owned');
      // Remove directory so it becomes prunable
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      process.env.CLAUDE_SESSION_ID = 'session-other';
      const result = pruneWorktrees({ maxAgeDays: 0 });
      expect(result.skipped.some((s) => s.name === 'prune-owned')).toBe(true);
      expect(result.pruned).toHaveLength(0);
    });

    test('force flag allows pruning other session entries', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner';
      const entry = createWorktree('prune-force-owned');
      // Remove directory
      fs.removeSync(entry.path);
      execFileSync('git', ['worktree', 'prune'], { cwd: testDir, stdio: 'pipe' });

      process.env.CLAUDE_SESSION_ID = 'session-other';
      const result = pruneWorktrees({ maxAgeDays: 0, force: true });
      expect(result.pruned.some((e) => e.name === 'prune-force-owned')).toBe(true);
    });

    test('always prunes destroyed entries regardless of owner', () => {
      process.env.CLAUDE_SESSION_ID = 'session-owner';
      createWorktree('prune-destroyed-owned');
      destroyWorktree('prune-destroyed-owned', { force: true });

      process.env.CLAUDE_SESSION_ID = 'session-other';
      const result = pruneWorktrees({ maxAgeDays: 0 });
      expect(result.pruned.some((e) => e.name === 'prune-destroyed-owned')).toBe(true);
    });
  });

  describe('status lifecycle', () => {
    test('fresh worktree has no divergent commits and no dirty files', () => {
      createWorktree('lifecycle-fresh');
      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'lifecycle-fresh');
      expect(wt.status).toBe('fresh');
      expect(wt.divergent).toBe(false);
      expect(wt.dirty).toBe(false);
    });

    test('worktree with dirty files shows as active', () => {
      const entry = createWorktree('lifecycle-dirty');
      // Create untracked file — makes it dirty
      fs.writeFileSync(path.join(entry.path, 'dirty.txt'), 'dirty');
      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'lifecycle-dirty');
      expect(wt.status).toBe('active');
      expect(wt.dirty).toBe(true);
    });

    test('worktree with divergent commits shows as active', () => {
      const entry = createWorktree('lifecycle-diverged');
      fs.writeFileSync(path.join(entry.path, 'feature.js'), 'const x = 1;');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'feature work'], { cwd: entry.path, stdio: 'pipe' });

      const entries = listWorktrees();
      const wt = entries.find((e) => e.name === 'lifecycle-diverged');
      expect(wt.status).toBe('active');
      expect(wt.divergent).toBe(true);
    });

    test('hasDivergentCommits returns false for branch at same point as base', () => {
      createWorktree('no-diverge-check');
      expect(hasDivergentCommits(`${BRANCH_PREFIX}no-diverge-check`, 'main', testDir)).toBe(false);
    });

    test('hasDivergentCommits returns true for branch ahead of base', () => {
      const entry = createWorktree('diverge-check');
      fs.writeFileSync(path.join(entry.path, 'ahead.txt'), 'ahead');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'ahead'], { cwd: entry.path, stdio: 'pipe' });
      expect(hasDivergentCommits(`${BRANCH_PREFIX}diverge-check`, 'main', testDir)).toBe(true);
    });

    test('hasDirtyFiles detects untracked and modified files', () => {
      const entry = createWorktree('dirty-check');
      expect(hasDirtyFiles(entry.path)).toBe(false);
      fs.writeFileSync(path.join(entry.path, 'new.txt'), 'new');
      expect(hasDirtyFiles(entry.path)).toBe(true);
    });

    test('full lifecycle: fresh -> active -> merged', () => {
      const entry = createWorktree('lifecycle-full');

      // Step 1: Just created → fresh
      let entries = listWorktrees();
      let wt = entries.find((e) => e.name === 'lifecycle-full');
      expect(wt.status).toBe('fresh');

      // Step 2: Make a commit → active (listWorktrees persists this)
      fs.writeFileSync(path.join(entry.path, 'feature.js'), 'const x = 1;');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'feature work'], { cwd: entry.path, stdio: 'pipe' });

      entries = listWorktrees();
      wt = entries.find((e) => e.name === 'lifecycle-full');
      expect(wt.status).toBe('active');

      // Verify registry persisted the active status
      const registryAfterActive = loadRegistry(testDir);
      expect(registryAfterActive.worktrees['lifecycle-full'].status).toBe('active');

      // Step 3: Merge the branch to main (simulating the work being merged)
      execFileSync('git', ['merge', '--no-ff', entry.branch, '-m', 'merge feature'], {
        cwd: testDir,
        stdio: 'pipe',
      });

      // Now branch is merged to base, no divergent commits → merged (not fresh)
      entries = listWorktrees();
      wt = entries.find((e) => e.name === 'lifecycle-full');
      expect(wt.status).toBe('merged');
    });
  });

  describe('C2/H3: mergeWorktree conflict path', () => {
    test('returns merged:false on real merge conflict and preserves branch for recovery', () => {
      const entry = createWorktree('conflict-wt');

      // On main, modify a file at a specific line
      fs.writeFileSync(path.join(testDir, 'src', 'index.js'), 'module.exports = { main: true };');
      execFileSync('git', ['add', '.'], { cwd: testDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'main changes index.js'], { cwd: testDir, stdio: 'pipe' });

      // In the worktree, modify the SAME file at the SAME line with different content
      fs.writeFileSync(path.join(entry.path, 'src', 'index.js'), 'module.exports = { worktree: true };');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'worktree changes index.js'], { cwd: entry.path, stdio: 'pipe' });

      const branchName = entry.branch;

      // Attempt merge — should detect conflict
      const result = mergeWorktree('conflict-wt');

      expect(result.merged).toBe(false);
      expect(result.conflicts.length).toBeGreaterThan(0);

      // H3: Verify the worktree directory is gone (destroyed before merge attempt)
      expect(fs.existsSync(entry.path)).toBe(false);

      // H3: Verify the branch still exists for recovery
      const branchCheck = execFileSync(
        'git',
        ['rev-parse', '--verify', branchName],
        { cwd: testDir, encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      expect(branchCheck).toMatch(/^[0-9a-f]+$/);

      // Clean up merge state if present
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: testDir, stdio: 'pipe' });
      } catch {
        // No merge in progress — that's fine (merge-tree based detection may not leave state)
      }

      // H3: Verify a new worktree can be created from the surviving branch
      // The branch exists and the old entry is destroyed, but same-session owns it
      // so re-creation should work (it reuses the existing branch)
      const recovered = createWorktree('conflict-wt');
      expect(recovered.name).toBe('conflict-wt');
      expect(fs.existsSync(recovered.path)).toBe(true);

      // Cleanup
      destroyWorktree('conflict-wt', { force: true, deleteBranch: true });
    });
  });

  describe('C3: destroyWorktree without force on dirty+divergent worktree', () => {
    test('throws when worktree is dirty and has divergent commits (no auto-force)', () => {
      const entry = createWorktree('dirty-divergent');

      // Make a divergent commit so branch is NOT merged (prevents auto-force)
      fs.writeFileSync(path.join(entry.path, 'feature.js'), 'const x = 1;');
      execFileSync('git', ['add', 'feature.js'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'divergent commit'], { cwd: entry.path, stdio: 'pipe' });

      // Add a dirty (untracked) file so git worktree remove refuses without --force
      fs.writeFileSync(path.join(entry.path, 'uncommitted.txt'), 'dirty');

      // Without force, and branch is divergent (not merged), auto-force won't kick in
      // git worktree remove should fail on the dirty worktree
      expect(() => destroyWorktree('dirty-divergent')).toThrow();

      // Verify directory still exists (removal failed)
      expect(fs.existsSync(entry.path)).toBe(true);

      // Cleanup
      destroyWorktree('dirty-divergent', { force: true });
    });
  });

  describe('H4: deleteBranch option', () => {
    test('deleteBranch removes the git branch after destroy', () => {
      const entry = createWorktree('delete-branch-test');
      const branchName = entry.branch;

      // Make a commit so the branch has content
      fs.writeFileSync(path.join(entry.path, 'work.js'), 'const y = 2;');
      execFileSync('git', ['add', '.'], { cwd: entry.path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'branch work'], { cwd: entry.path, stdio: 'pipe' });

      destroyWorktree('delete-branch-test', { deleteBranch: true, force: true });

      // Verify the branch no longer exists in git
      expect(() => {
        execFileSync('git', ['rev-parse', '--verify', branchName], {
          cwd: testDir,
          stdio: 'pipe',
        });
      }).toThrow();
    });
  });

  describe('H5: collision with null CLAUDE_SESSION_ID', () => {
    test('worktree lifecycle works when CLAUDE_SESSION_ID is undefined', () => {
      // Delete all agent session sources — owner will be null
      delete process.env.CLAUDE_SESSION_ID;
      const savedTraceId = process.env.CURSOR_TRACE_ID;
      delete process.env.CURSOR_TRACE_ID;

      const entry = createWorktree('null-owner');
      expect(entry.owner).toBeNull();

      destroyWorktree('null-owner');
      const registry = loadRegistry(testDir);
      expect(registry.worktrees['null-owner'].status).toBe('destroyed');

      // Branch still exists after destroy (no deleteBranch option)
      const branchName = entry.branch;
      const branchExists = (() => {
        try {
          execFileSync('git', ['rev-parse', '--verify', branchName], {
            cwd: testDir,
            stdio: 'pipe',
          });
          return true;
        } catch {
          return false;
        }
      })();
      expect(branchExists).toBe(true);

      // Re-creating with same name while branch exists and owner is null:
      // The registry entry has owner=null, and current session has CLAUDE_SESSION_ID=undefined (null).
      // Since null === null is false in the ownership check (both are null, not strings),
      // the code path `existing.owner && existing.owner !== currentSession` is falsy
      // because existing.owner is null (falsy). So it should succeed.
      const recreated = createWorktree('null-owner');
      expect(recreated.name).toBe('null-owner');
      expect(recreated.owner).toBeNull();
      expect(fs.existsSync(recreated.path)).toBe(true);

      // Cleanup
      destroyWorktree('null-owner', { force: true, deleteBranch: true });

      // Restore env
      if (savedTraceId !== undefined) {
        process.env.CURSOR_TRACE_ID = savedTraceId;
      }
    });
  });

  describe('findSpecByWorktreeName', () => {
    test('returns spec id when a spec declares matching worktree field', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'BIND-001.yaml'),
        ['id: BIND-001', 'title: Bindable spec', 'worktree: bind-target'].join('\n')
      );

      const result = findSpecByWorktreeName(testDir, 'bind-target');
      expect(result).toBe('BIND-001');
    });

    test('returns null when no spec matches the worktree name', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'BIND-002.yaml'),
        ['id: BIND-002', 'title: Other spec', 'worktree: other-wt'].join('\n')
      );

      const result = findSpecByWorktreeName(testDir, 'no-match');
      expect(result).toBeNull();
    });

    test('returns null when .caws/specs/ does not exist', () => {
      const result = findSpecByWorktreeName(testDir, 'anything');
      expect(result).toBeNull();
    });
  });

  describe('createWorktree auto-bind', () => {
    test('auto-binds specId from spec worktree field when no explicit specId given', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'AUTO-BIND.yaml'),
        ['id: AUTO-BIND', 'title: Auto bind test', 'worktree: auto-bind-wt'].join('\n')
      );
      // Commit the spec so ensureCanonicalSpecCommitted doesn't fail
      execFileSync('git', ['add', '.caws/specs/AUTO-BIND.yaml'], { cwd: testDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add auto-bind spec'], { cwd: testDir, stdio: 'pipe' });

      const entry = createWorktree('auto-bind-wt');
      expect(entry.specId).toBe('AUTO-BIND');

      const registry = loadRegistry(testDir);
      expect(registry.worktrees['auto-bind-wt']).toBeDefined();
      expect(registry.worktrees['auto-bind-wt'].specId).toBe('AUTO-BIND');
    });
  });

  describe('saveRegistry and bind workflow', () => {
    test('saveRegistry persists specId update to worktree entry', () => {
      const entry = createWorktree('bind-target');
      expect(entry.specId).toBeNull();

      // Simulate bind: update specId in registry
      const registry = loadRegistry(testDir);
      registry.worktrees['bind-target'].specId = 'BOUND-001';
      saveRegistry(testDir, registry);

      // Verify persistence
      const reloaded = loadRegistry(testDir);
      expect(reloaded.worktrees['bind-target'].specId).toBe('BOUND-001');
    });

    test('full bind workflow updates both registry and spec YAML', () => {
      const yaml = require('js-yaml');

      // Create a spec file without worktree field
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      fs.writeFileSync(
        path.join(testDir, '.caws', 'specs', 'BIND-FULL.yaml'),
        ['id: BIND-FULL', 'title: Full bind test', 'status: draft'].join('\n')
      );
      execFileSync('git', ['add', '.caws/specs/BIND-FULL.yaml'], { cwd: testDir, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'add bind-full spec'], { cwd: testDir, stdio: 'pipe' });

      // Create worktree (no specId)
      const entry = createWorktree('bind-full-wt');
      expect(entry.specId).toBeNull();

      // Simulate bind: update registry
      const registry = loadRegistry(testDir);
      registry.worktrees['bind-full-wt'].specId = 'BIND-FULL';
      saveRegistry(testDir, registry);

      // Simulate bind: update spec YAML
      const specPath = path.join(testDir, '.caws', 'specs', 'BIND-FULL.yaml');
      const specData = yaml.load(fs.readFileSync(specPath, 'utf8'));
      specData.worktree = 'bind-full-wt';
      fs.writeFileSync(specPath, yaml.dump(specData, { lineWidth: 120, noRefs: true }));

      // Verify both sides
      const reloaded = loadRegistry(testDir);
      expect(reloaded.worktrees['bind-full-wt'].specId).toBe('BIND-FULL');

      const updatedSpec = yaml.load(fs.readFileSync(specPath, 'utf8'));
      expect(updatedSpec.worktree).toBe('bind-full-wt');

      // findSpecByWorktreeName should now resolve this
      expect(findSpecByWorktreeName(testDir, 'bind-full-wt')).toBe('BIND-FULL');
    });
  });

});
