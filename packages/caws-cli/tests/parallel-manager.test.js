/**
 * @fileoverview Tests for CAWS Parallel Workspace Manager
 */

const path = require('path');
const fs = require('fs-extra');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const { createTemplateRepo, cloneFixture, cleanupTestDir, cleanupTemplate } = require('./helpers/git-fixture');

// Modules under test
const {
  loadPlan,
  setupParallel,
  getParallelStatus,
  mergeParallel,
  teardownParallel,
  loadParallelRegistry,
} = require('../src/parallel/parallel-manager');


describe('parallel-manager', () => {
  let templateDir;
  let testDir;
  let originalCwd;

  beforeAll(() => {
    templateDir = createTemplateRepo({
      files: {
        'src/auth/login.js': 'module.exports = {};',
        'src/payments/stripe.js': 'module.exports = {};',
      },
    });
  });

  afterAll(() => {
    cleanupTemplate(templateDir);
  });

  beforeEach(() => {
    originalCwd = process.cwd();
    testDir = cloneFixture(templateDir, 'caws-parallel-test-');
    fs.ensureDirSync(path.join(testDir, '.caws'));
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanupTestDir(testDir);
  });

  // Helper to write a plan file
  function writePlan(planObj, filename = 'plan.yaml') {
    const planPath = path.join(testDir, filename);
    fs.writeFileSync(planPath, yaml.dump(planObj));
    return planPath;
  }

  describe('loadPlan', () => {
    test('loads a valid plan file', () => {
      const planPath = writePlan({
        version: 1,
        base_branch: 'main',
        agents: [
          { name: 'agent-auth', scope: 'src/auth/**' },
          { name: 'agent-payments', scope: 'src/payments/**' },
        ],
      });

      const plan = loadPlan(planPath);
      expect(plan.version).toBe(1);
      expect(plan.baseBranch).toBe('main');
      expect(plan.agents).toHaveLength(2);
      expect(plan.mergeStrategy).toBe('merge');
    });

    test('rejects missing file', () => {
      expect(() => loadPlan('/nonexistent/plan.yaml')).toThrow('not found');
    });

    test('rejects invalid YAML', () => {
      const planPath = path.join(testDir, 'bad.yaml');
      fs.writeFileSync(planPath, '{ invalid yaml: [');
      expect(() => loadPlan(planPath)).toThrow('Invalid YAML');
    });

    test('rejects wrong version', () => {
      const planPath = writePlan({ version: 99, agents: [{ name: 'a' }] });
      expect(() => loadPlan(planPath)).toThrow('Unsupported plan version');
    });

    test('rejects empty agents', () => {
      const planPath = writePlan({ version: 1, agents: [] });
      expect(() => loadPlan(planPath)).toThrow('at least one agent');
    });

    test('rejects missing agent name', () => {
      const planPath = writePlan({ version: 1, agents: [{ scope: 'src/' }] });
      expect(() => loadPlan(planPath)).toThrow('must have a name');
    });

    test('rejects invalid agent name', () => {
      const planPath = writePlan({ version: 1, agents: [{ name: 'bad name!' }] });
      expect(() => loadPlan(planPath)).toThrow('Invalid agent name');
    });

    test('rejects duplicate agent names', () => {
      const planPath = writePlan({
        version: 1,
        agents: [{ name: 'dupe' }, { name: 'dupe' }],
      });
      expect(() => loadPlan(planPath)).toThrow('Duplicate agent name');
    });

    test('rejects invalid merge strategy', () => {
      const planPath = writePlan({
        version: 1,
        merge_strategy: 'yolo',
        agents: [{ name: 'a' }],
      });
      expect(() => loadPlan(planPath)).toThrow('Invalid merge_strategy');
    });

    test('defaults baseBranch to null when not specified', () => {
      const planPath = writePlan({ version: 1, agents: [{ name: 'a' }] });
      const plan = loadPlan(planPath);
      expect(plan.baseBranch).toBeNull();
    });
  });

  describe('setupParallel', () => {
    test('creates worktrees and writes parallel registry', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [
            { name: 'agent-auth', scope: 'src/auth/' },
            { name: 'agent-payments', scope: 'src/payments/' },
          ],
        })
      );

      const results = setupParallel(plan);
      expect(results).toHaveLength(2);
      expect(results[0].name).toBe('agent-auth');
      expect(results[1].name).toBe('agent-payments');

      // Verify worktrees exist
      expect(fs.existsSync(results[0].path)).toBe(true);
      expect(fs.existsSync(results[1].path)).toBe(true);

      // Verify branches
      expect(results[0].branch).toBe('caws/agent-auth');
      expect(results[1].branch).toBe('caws/agent-payments');

      // Verify parallel registry
      const reg = loadParallelRegistry(testDir);
      expect(reg).not.toBeNull();
      expect(reg.agents).toHaveLength(2);
    });

    test('rejects when parallel run already active', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'first' }] })
      );
      setupParallel(plan);

      const plan2 = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'second' }] }, 'plan2.yaml')
      );
      expect(() => setupParallel(plan2)).toThrow('already active');
    });

    test('uses current branch as base when not specified', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'auto-base' }] })
      );
      setupParallel(plan);

      const reg = loadParallelRegistry(testDir);
      // Should be whatever the current branch is (main or master)
      expect(reg.baseBranch).toBeTruthy();
    });

    test('propagates canonical feature specs into agent worktrees', () => {
      fs.ensureDirSync(path.join(testDir, '.caws', 'specs'));
      const canonicalSpec = [
        'id: auth-feature',
        'title: Auth Feature',
        'risk_tier: 2',
        'mode: feature',
        'acceptance:',
        '  - id: A1',
        '    given: auth is configured',
        '    when: the agent enters its worktree',
        '    then: it should see the canonical feature spec',
      ].join('\n');
      fs.writeFileSync(path.join(testDir, '.caws', 'specs', 'auth-feature.yaml'), canonicalSpec);

      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'agent-auth', spec_id: 'auth-feature' }],
        })
      );

      const results = setupParallel(plan);
      const worktreeSpecPath = path.join(results[0].path, '.caws', 'working-spec.yaml');

      expect(fs.readFileSync(worktreeSpecPath, 'utf8')).toBe(canonicalSpec);
    });
  });

  describe('getParallelStatus', () => {
    test('returns null when no parallel run exists', () => {
      expect(getParallelStatus()).toBeNull();
    });

    test('returns status for active parallel run', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'status-agent', intent: 'test intent' }],
        })
      );
      setupParallel(plan);

      const status = getParallelStatus();
      expect(status).not.toBeNull();
      expect(status.agents).toHaveLength(1);
      expect(status.agents[0].name).toBe('status-agent');
      // No commits yet → 'fresh' (transitions to 'active' once divergent commits exist)
      expect(status.agents[0].status).toBe('fresh');
      expect(status.agents[0].commitCount).toBe(0);
      expect(status.agents[0].dirty).toBe(false);
    });

    test('detects commits in worktree branches', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'committer' }] })
      );
      const results = setupParallel(plan);

      // Make a commit in the worktree
      const wtPath = results[0].path;
      fs.writeFileSync(path.join(wtPath, 'new-file.js'), 'console.log("hello");');
      execFileSync('git', ['add', '.'], { cwd: wtPath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'test commit'], { cwd: wtPath, stdio: 'pipe' });

      const status = getParallelStatus();
      expect(status.agents[0].commitCount).toBe(1);
    });

    test('detects dirty worktrees', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'dirty-agent' }] })
      );
      const results = setupParallel(plan);

      // Create untracked file
      fs.writeFileSync(path.join(results[0].path, 'dirty.txt'), 'dirty');

      const status = getParallelStatus();
      expect(status.agents[0].dirty).toBe(true);
    });
  });

  describe('detectFileConflicts', () => {
    test('detects no conflicts for non-overlapping changes', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'a1' }, { name: 'a2' }],
        })
      );
      const results = setupParallel(plan);

      // Agent 1 modifies auth file
      fs.writeFileSync(path.join(results[0].path, 'src', 'auth', 'login.js'), 'updated');
      execFileSync('git', ['add', '.'], { cwd: results[0].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'auth change'], { cwd: results[0].path, stdio: 'pipe' });

      // Agent 2 modifies payments file
      fs.writeFileSync(path.join(results[1].path, 'src', 'payments', 'stripe.js'), 'updated');
      execFileSync('git', ['add', '.'], { cwd: results[1].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'payments change'], { cwd: results[1].path, stdio: 'pipe' });

      const status = getParallelStatus();
      expect(status.conflicts).toHaveLength(0);
    });

    test('detects conflicts when agents modify same file', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'c1' }, { name: 'c2' }],
        })
      );
      const results = setupParallel(plan);

      // Both agents modify the same file
      fs.writeFileSync(path.join(results[0].path, 'README.md'), 'agent 1 change');
      execFileSync('git', ['add', '.'], { cwd: results[0].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'c1 change'], { cwd: results[0].path, stdio: 'pipe' });

      fs.writeFileSync(path.join(results[1].path, 'README.md'), 'agent 2 change');
      execFileSync('git', ['add', '.'], { cwd: results[1].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'c2 change'], { cwd: results[1].path, stdio: 'pipe' });

      const status = getParallelStatus();
      expect(status.conflicts.length).toBeGreaterThan(0);
      expect(status.conflicts[0].file).toBe('README.md');
      expect(status.conflicts[0].agents).toContain('c1');
      expect(status.conflicts[0].agents).toContain('c2');
    });
  });

  describe('mergeParallel', () => {
    test('rejects when no parallel run exists', () => {
      expect(() => mergeParallel()).toThrow('No active parallel run');
    });

    test('merges non-conflicting branches', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'm1' }, { name: 'm2' }],
        })
      );
      const results = setupParallel(plan);

      // Agent 1: modify auth
      fs.writeFileSync(path.join(results[0].path, 'src', 'auth', 'login.js'), 'agent 1');
      execFileSync('git', ['add', '.'], { cwd: results[0].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'auth update'], { cwd: results[0].path, stdio: 'pipe' });

      // Agent 2: modify payments
      fs.writeFileSync(path.join(results[1].path, 'src', 'payments', 'stripe.js'), 'agent 2');
      execFileSync('git', ['add', '.'], { cwd: results[1].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'payments update'], { cwd: results[1].path, stdio: 'pipe' });

      const result = mergeParallel();
      expect(result.merged).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(result.conflicts).toHaveLength(0);
    });

    test('blocks merge when conflicts detected (without --force)', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 'mc1' }, { name: 'mc2' }],
        })
      );
      const results = setupParallel(plan);

      // Both modify README
      fs.writeFileSync(path.join(results[0].path, 'README.md'), 'mc1');
      execFileSync('git', ['add', '.'], { cwd: results[0].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'mc1'], { cwd: results[0].path, stdio: 'pipe' });

      fs.writeFileSync(path.join(results[1].path, 'README.md'), 'mc2');
      execFileSync('git', ['add', '.'], { cwd: results[1].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'mc2'], { cwd: results[1].path, stdio: 'pipe' });

      const result = mergeParallel();
      expect(result.conflicts.length).toBeGreaterThan(0);
      expect(result.merged).toHaveLength(0);
    });

    test('dry run shows what would be merged', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'dry' }] })
      );
      const results = setupParallel(plan);

      fs.writeFileSync(path.join(results[0].path, 'src', 'auth', 'login.js'), 'updated');
      execFileSync('git', ['add', '.'], { cwd: results[0].path, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', 'change'], { cwd: results[0].path, stdio: 'pipe' });

      const result = mergeParallel({ dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.merged).toContain('dry');
    });

    test('blocks merge when worktree is dirty', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'dirty-merge' }] })
      );
      const results = setupParallel(plan);

      // Make worktree dirty without committing
      fs.writeFileSync(path.join(results[0].path, 'dirty.txt'), 'uncommitted');
      execFileSync('git', ['add', 'dirty.txt'], { cwd: results[0].path, stdio: 'pipe' });

      expect(() => mergeParallel()).toThrow('uncommitted changes');
    });
  });

  describe('teardownParallel', () => {
    test('rejects when no parallel run exists', () => {
      expect(() => teardownParallel()).toThrow('No active parallel run');
    });

    test('destroys all worktrees and removes registry', () => {
      const plan = loadPlan(
        writePlan({
          version: 1,
          agents: [{ name: 't1' }, { name: 't2' }],
        })
      );
      setupParallel(plan);

      const result = teardownParallel({ force: true });
      expect(result.destroyed).toHaveLength(2);
      expect(result.failed).toHaveLength(0);

      // Parallel registry should be gone
      expect(loadParallelRegistry(testDir)).toBeNull();
    });

    test('deletes branches when requested', () => {
      const plan = loadPlan(
        writePlan({ version: 1, agents: [{ name: 'branch-del' }] })
      );
      setupParallel(plan);

      teardownParallel({ deleteBranches: true, force: true });

      // Branch should be deleted
      const branches = execFileSync('git', ['branch', '--list', 'caws/branch-del'], {
        cwd: testDir,
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim();
      expect(branches).toBe('');
    });
  });
});
