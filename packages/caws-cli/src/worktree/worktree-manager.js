/**
 * @fileoverview CAWS Git Worktree Manager
 * Provides CRUD operations for git worktrees with scope isolation
 * @author @darianrosebrook
 */

const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

const WORKTREES_DIR = '.caws/worktrees';
const REGISTRY_FILE = '.caws/worktrees.json';
const BRANCH_PREFIX = 'caws/';

/**
 * Get the last commit info for a branch
 * @param {string} branch - Branch name
 * @param {string} root - Repository root
 * @returns {{ age: string, timestamp: Date, sha: string } | null}
 */
function getLastCommitInfo(branch, root) {
  try {
    const output = execFileSync(
      'git',
      ['log', branch, '-1', '--format=%H%n%aI%n%ar'],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    const [sha, iso, age] = output.split('\n');
    return { sha, timestamp: new Date(iso), age };
  } catch {
    return null;
  }
}

/**
 * Check if a branch has been merged into another branch
 * @param {string} branch - Branch to check
 * @param {string} target - Target branch (e.g., "main")
 * @param {string} root - Repository root
 * @returns {boolean}
 */
function isBranchMerged(branch, target, root) {
  try {
    const merged = execFileSync(
      'git',
      ['branch', '--merged', target, '--list', branch],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    return merged.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the git repository root
 * @returns {string} Absolute path to repo root
 */
function getRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Get current branch name
 * @returns {string}
 */
function getCurrentBranch() {
  return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
}

/**
 * Load the worktree registry
 * @param {string} root - Repository root
 * @returns {Object} Registry object
 */
function loadRegistry(root) {
  const registryPath = path.join(root, REGISTRY_FILE);
  try {
    if (fs.existsSync(registryPath)) {
      return JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    }
  } catch {
    // Corrupted registry, start fresh
  }
  return { version: 1, worktrees: {} };
}

/**
 * Save the worktree registry
 * @param {string} root - Repository root
 * @param {Object} registry - Registry object
 */
function saveRegistry(root, registry) {
  const registryPath = path.join(root, REGISTRY_FILE);
  fs.ensureDirSync(path.dirname(registryPath));
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Discover git worktrees under .caws/worktrees/ that are not in the registry.
 * @param {string} root - Repository root
 * @param {Object} registry - Current registry object
 * @returns {Array<{ name: string, path: string, branch: string }>}
 */
function discoverUnregisteredWorktrees(root, registry) {
  const unregistered = [];
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    let worktreesDir;
    try {
      worktreesDir = fs.realpathSync(path.resolve(root, WORKTREES_DIR));
    } catch {
      // Directory might not exist yet
      worktreesDir = path.resolve(root, WORKTREES_DIR);
    }

    const blocks = output.split('\n\n').filter(Boolean);
    for (const block of blocks) {
      const lines = block.split('\n');
      const wtLine = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l.startsWith('branch '));
      if (!wtLine) continue;

      const wtPath = wtLine.replace('worktree ', '');
      let resolvedPath;
      try {
        resolvedPath = fs.realpathSync(wtPath);
      } catch {
        resolvedPath = path.resolve(wtPath);
      }

      // Only consider worktrees under .caws/worktrees/
      if (!resolvedPath.startsWith(worktreesDir + path.sep)) continue;

      const name = path.basename(resolvedPath);
      if (registry.worktrees[name]) continue;

      const branch = branchLine
        ? branchLine.replace('branch refs/heads/', '')
        : `${BRANCH_PREFIX}${name}`;
      unregistered.push({ name, path: resolvedPath, branch });
    }
  } catch {
    // git worktree list failed
  }
  return unregistered;
}

/**
 * Auto-register an unregistered worktree. Infers baseBranch via merge-base.
 * @param {string} root - Repository root
 * @param {Object} registry - Registry object (mutated in place)
 * @param {{ name: string, path: string, branch: string }} discovered
 * @returns {Object} The registered entry
 */
function autoRegisterWorktree(root, registry, discovered) {
  let baseBranch = 'main';
  try {
    execFileSync(
      'git',
      ['merge-base', discovered.branch, 'main'],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    );
  } catch {
    try {
      execFileSync(
        'git',
        ['merge-base', discovered.branch, 'master'],
        { cwd: root, encoding: 'utf8', stdio: 'pipe' }
      );
      baseBranch = 'master';
    } catch {
      // Keep 'main' as default
    }
  }

  const entry = {
    name: discovered.name,
    path: discovered.path,
    branch: discovered.branch,
    baseBranch,
    scope: null,
    specId: null,
    owner: null,
    createdAt: new Date().toISOString(),
    status: 'active',
    autoRegistered: true,
  };

  registry.worktrees[discovered.name] = entry;
  saveRegistry(root, registry);
  return entry;
}

/**
 * Create a new git worktree with scope isolation
 * @param {string} name - Worktree name
 * @param {Object} options - Creation options
 * @param {string} [options.scope] - Sparse checkout pattern (e.g., "src/auth/**")
 * @param {string} [options.baseBranch] - Base branch to create from
 * @param {string} [options.specId] - Associated spec ID for standard+ modes
 * @returns {Object} Created worktree info
 */
function createWorktree(name, options = {}) {
  const root = getRepoRoot();
  const { scope, baseBranch, specId } = options;

  // Validate name
  if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error('Worktree name must contain only letters, numbers, hyphens, and underscores');
  }

  const registry = loadRegistry(root);

  // Check for duplicate
  if (registry.worktrees[name]) {
    throw new Error(`Worktree '${name}' already exists. Use 'caws worktree destroy ${name}' first.`);
  }

  const worktreePath = path.join(root, WORKTREES_DIR, name);
  const branchName = BRANCH_PREFIX + name;
  const base = baseBranch || getCurrentBranch();

  // Create the worktree directory
  fs.ensureDirSync(path.dirname(worktreePath));

  // Create git worktree with new branch
  try {
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, base], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (error) {
    // Branch might already exist
    if (error.message.includes('already exists')) {
      execFileSync('git', ['worktree', 'add', worktreePath, branchName], {
        cwd: root,
        stdio: 'pipe',
      });
    } else {
      throw new Error(`Failed to create worktree: ${error.message}`);
    }
  }

  // Set up sparse checkout if scope is provided
  if (scope) {
    try {
      // Parse scope patterns (comma-separated)
      const patterns = scope.split(',').map((p) => p.trim());

      // Detect glob characters — cone mode only accepts directory paths,
      // not glob patterns like "core/reasoning/**" or "*.py".
      const hasGlobs = patterns.some((p) => /[*?[\]]/.test(p));
      const coneFlag = hasGlobs ? '--no-cone' : '--cone';

      execFileSync('git', ['sparse-checkout', 'init', coneFlag], {
        cwd: worktreePath,
        stdio: 'pipe',
      });

      execFileSync('git', ['sparse-checkout', 'set', ...patterns], {
        cwd: worktreePath,
        stdio: 'pipe',
      });
    } catch (error) {
      console.warn(chalk.yellow(`Sparse checkout setup failed: ${error.message}`));
      console.warn(chalk.blue('Worktree created but without sparse checkout'));
    }
  }

  // Copy .caws/ config into worktree
  const cawsSource = path.join(root, '.caws');
  const cawsDest = path.join(worktreePath, '.caws');
  if (fs.existsSync(cawsSource)) {
    try {
      fs.copySync(cawsSource, cawsDest, {
        filter: (src) => {
          // Don't copy worktrees directory or registry into the worktree
          const rel = path.relative(cawsSource, src);
          return !rel.startsWith('worktrees') && rel !== 'worktrees.json';
        },
      });
    } catch {
      // Non-fatal
    }
  }

  // Generate working spec if in standard+ mode and specId provided
  if (specId) {
    try {
      const { generateWorkingSpec } = require('../generators/working-spec');
      const specContent = generateWorkingSpec({
        projectId: specId,
        projectTitle: `Worktree: ${name}`,
        projectDescription: `Isolated worktree for ${name}`,
        riskTier: 3,
        projectMode: 'feature',
        scopeIn: scope || 'src/',
        scopeOut: 'node_modules/, dist/, build/',
        maxFiles: 25,
        maxLoc: 1000,
        blastModules: scope || 'src',
        dataMigration: false,
        rollbackSlo: '5m',
        projectThreats: '',
        projectInvariants: 'System maintains data consistency',
        acceptanceCriteria: 'Given current state, when action occurs, then expected result',
        a11yRequirements: 'keyboard',
        perfBudget: 250,
        securityRequirements: 'validation',
        contractType: '',
        contractPath: '',
        observabilityLogs: '',
        observabilityMetrics: '',
        observabilityTraces: '',
        migrationPlan: '',
        rollbackPlan: '',
        needsOverride: false,
        isExperimental: false,
        aiConfidence: 0.8,
        uncertaintyAreas: '',
        complexityFactors: '',
      });
      const specPath = path.join(cawsDest, 'working-spec.yaml');
      fs.ensureDirSync(path.dirname(specPath));
      fs.writeFileSync(specPath, specContent);
    } catch {
      // Non-fatal: spec generation is optional
    }
  }

  // Register worktree
  const entry = {
    name,
    path: worktreePath,
    branch: branchName,
    baseBranch: base,
    scope: scope || null,
    specId: specId || null,
    owner: options.owner || process.env.CLAUDE_SESSION_ID || null,
    createdAt: new Date().toISOString(),
    status: 'active',
  };

  registry.worktrees[name] = entry;
  saveRegistry(root, registry);

  return entry;
}

/**
 * List all registered worktrees with filesystem validation
 * @returns {Array} Worktree entries with status
 */
function listWorktrees() {
  const root = getRepoRoot();
  const registry = loadRegistry(root);

  // Get actual git worktrees for validation
  let gitWorktrees = [];
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
    });
    gitWorktrees = output
      .split('\n\n')
      .filter(Boolean)
      .map((block) => {
        const lines = block.split('\n');
        const worktreeLine = lines.find((l) => l.startsWith('worktree '));
        return worktreeLine ? worktreeLine.replace('worktree ', '') : null;
      })
      .filter(Boolean);
  } catch {
    // Git worktree list failed
  }

  const entries = Object.values(registry.worktrees).map((entry) => {
    const exists = fs.existsSync(entry.path);
    const inGit = gitWorktrees.some(
      (wt) => path.resolve(wt) === path.resolve(entry.path)
    );
    const status = exists && inGit ? 'active' : exists ? 'orphaned' : 'missing';

    // Enrich with commit recency
    const lastCommit = entry.branch ? getLastCommitInfo(entry.branch, root) : null;

    // Check if branch is already merged to base
    const merged = entry.branch && entry.baseBranch
      ? isBranchMerged(entry.branch, entry.baseBranch, root)
      : false;

    return {
      ...entry,
      status,
      lastCommit,
      merged,
    };
  });

  // Append unregistered worktrees discovered from git
  const unregistered = discoverUnregisteredWorktrees(root, registry);
  for (const discovered of unregistered) {
    const lastCommit = getLastCommitInfo(discovered.branch, root);
    entries.push({
      name: discovered.name,
      path: discovered.path,
      branch: discovered.branch,
      baseBranch: null,
      scope: null,
      specId: null,
      owner: null,
      createdAt: null,
      status: 'unregistered',
      lastCommit,
      merged: false,
    });
  }

  return entries;
}

/**
 * Destroy a worktree
 * @param {string} name - Worktree name
 * @param {Object} options - Destruction options
 * @param {boolean} [options.deleteBranch] - Also delete the branch
 * @param {boolean} [options.force] - Force removal even if dirty
 */
function destroyWorktree(name, options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { deleteBranch = false, force = false } = options;

  let entry = registry.worktrees[name];
  if (!entry) {
    // Fallback: scan git for unregistered worktree and auto-register
    const unregistered = discoverUnregisteredWorktrees(root, registry);
    const discovered = unregistered.find((u) => u.name === name);
    if (discovered) {
      console.log(chalk.yellow(`Worktree '${name}' not in registry but found in git. Auto-registering.`));
      entry = autoRegisterWorktree(root, registry, discovered);
    } else {
      throw new Error(`Worktree '${name}' not found in registry or git worktree list`);
    }
  }

  // Ownership check: refuse to destroy another agent's active worktree without --force
  const currentSession = process.env.CLAUDE_SESSION_ID || null;
  if (
    !force &&
    entry.status === 'active' &&
    entry.owner &&
    currentSession &&
    entry.owner !== currentSession
  ) {
    const lastCommit = entry.branch ? getLastCommitInfo(entry.branch, root) : null;
    const recency = lastCommit ? ` (last commit: ${lastCommit.age})` : '';
    throw new Error(
      `Worktree '${name}' belongs to another session${recency}.\n` +
        `   Owner: ${entry.owner}\n` +
        `   You:   ${currentSession}\n` +
        `Another agent may be actively working here.\n` +
        `Do NOT destroy worktrees you did not create. Ask the user if cleanup is needed.`
    );
  }

  // Even with --force, warn loudly when destroying another session's worktree
  if (
    force &&
    entry.status === 'active' &&
    entry.owner &&
    currentSession &&
    entry.owner !== currentSession
  ) {
    const lastCommit = entry.branch ? getLastCommitInfo(entry.branch, root) : null;
    const recency = lastCommit ? ` (last commit: ${lastCommit.age})` : '';
    console.log(chalk.red(`\n   ⚠ WARNING: Force-destroying worktree '${name}' owned by another session${recency}`));
    console.log(chalk.red(`   Owner: ${entry.owner}`));
    console.log(chalk.red(`   You:   ${currentSession}`));
    console.log(chalk.red(`   If the other agent is still running, this WILL break their work.\n`));
  }

  // Auto-force when the branch is already merged to its base branch.
  // Dirty files in a merged worktree are definitionally stale.
  const merged = entry.branch && entry.baseBranch
    ? isBranchMerged(entry.branch, entry.baseBranch, root)
    : false;
  const effectiveForce = force || merged;
  if (merged && !force) {
    console.log(chalk.gray(`   Branch ${entry.branch} already merged to ${entry.baseBranch}, auto-forcing cleanup`));
  }

  // Remove git worktree — handle already-deleted directories gracefully
  const dirExists = fs.existsSync(entry.path);
  if (dirExists) {
    try {
      const args = ['worktree', 'remove'];
      if (effectiveForce) args.push('--force');
      args.push(entry.path);
      execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    } catch (error) {
      if (effectiveForce) {
        // Force cleanup: remove directory manually
        fs.removeSync(entry.path);
      } else {
        throw new Error(`Failed to remove worktree: ${error.message}. Use --force to override.`);
      }
    }
  } else {
    // Directory already gone — just clean up git's tracking
    console.log(`   Worktree directory already removed, cleaning up registry`);
  }

  // Always prune git's worktree list to stay in sync
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
  } catch {
    // Non-fatal
  }

  // Optionally delete branch
  if (deleteBranch && entry.branch) {
    try {
      execFileSync('git', ['branch', '-d', entry.branch], { cwd: root, stdio: 'pipe' });
    } catch {
      if (effectiveForce) {
        try {
          execFileSync('git', ['branch', '-D', entry.branch], { cwd: root, stdio: 'pipe' });
        } catch {
          // Non-fatal
        }
      }
    }
  }

  // Update registry
  registry.worktrees[name].status = 'destroyed';
  registry.worktrees[name].destroyedAt = new Date().toISOString();
  saveRegistry(root, registry);
}

/**
 * Merge a worktree branch back to base in one operation.
 * Sequence: dry-run conflict check → destroy worktree → merge → cleanup.
 * @param {string} name - Worktree name
 * @param {Object} options - Merge options
 * @param {boolean} [options.dryRun] - Preview conflicts without merging
 * @param {boolean} [options.deleteBranch] - Delete branch after merge
 * @param {string} [options.message] - Custom merge commit message
 * @returns {Object} Merge result
 */
function mergeWorktree(name, options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { dryRun = false, deleteBranch = true, message } = options;

  let entry = registry.worktrees[name];
  if (!entry) {
    // Fallback: scan git for unregistered worktree and auto-register
    const unregistered = discoverUnregisteredWorktrees(root, registry);
    const discovered = unregistered.find((u) => u.name === name);
    if (discovered) {
      console.log(chalk.yellow(`Worktree '${name}' not in registry but found in git. Auto-registering.`));
      entry = autoRegisterWorktree(root, registry, discovered);
    } else {
      throw new Error(`Worktree '${name}' not found in registry or git worktree list`);
    }
  }

  const baseBranch = entry.baseBranch || 'main';

  // Check for uncommitted work in the worktree
  if (fs.existsSync(entry.path)) {
    try {
      const status = execFileSync(
        'git',
        ['status', '--porcelain'],
        { cwd: entry.path, encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      if (status) {
        throw new Error(
          `Worktree '${name}' has uncommitted changes:\n${status}\n` +
            `Commit or discard changes before merging.`
        );
      }
    } catch (error) {
      if (error.message.includes('uncommitted changes')) throw error;
      // Non-fatal: status check failed, proceed cautiously
    }
  }

  // Dry-run: check for conflicts using git merge-tree (new-style, git 2.38+)
  let conflicts = [];
  try {
    // New-style merge-tree: takes two branches, computes merge-base automatically
    execFileSync(
      'git',
      ['merge-tree', '--write-tree', baseBranch, entry.branch],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    );
    // Exit 0 = clean merge, no conflicts
  } catch (mergeTreeError) {
    // Exit 1 = conflicts detected; parse them from output
    const output = (mergeTreeError.stdout || '') + (mergeTreeError.stderr || '');
    const conflictLines = output.split('\n').filter(
      (l) => l.includes('CONFLICT') || l.includes('conflict')
    );
    if (mergeTreeError.status === 1 && conflictLines.length > 0) {
      conflicts = conflictLines;
    } else if (mergeTreeError.status === 1) {
      conflicts = ['Merge conflicts detected (run merge manually to inspect)'];
    }
    // Other exit codes (e.g., merge-tree not supported) = can't detect, proceed
  }

  if (dryRun) {
    return {
      name,
      branch: entry.branch,
      baseBranch,
      conflicts,
      wouldMerge: conflicts.length === 0,
    };
  }

  // Destroy the worktree (auto-forces since we're about to merge)
  destroyWorktree(name, { deleteBranch: false, force: true });

  // Switch to base branch
  const currentBranch = getCurrentBranch();
  if (currentBranch !== baseBranch) {
    execFileSync('git', ['checkout', baseBranch], { cwd: root, stdio: 'pipe' });
  }

  // Merge
  const mergeMessage = message || `merge(worktree): ${name}`;
  try {
    execFileSync(
      'git',
      ['merge', '--no-ff', entry.branch, '-m', mergeMessage],
      { cwd: root, stdio: 'pipe' }
    );
  } catch (error) {
    return {
      name,
      branch: entry.branch,
      baseBranch,
      merged: false,
      conflicts: [`Merge failed: ${error.message}`],
      message: 'Merge conflicts detected. Resolve with git and commit.',
    };
  }

  // Delete branch after successful merge
  if (deleteBranch) {
    try {
      execFileSync('git', ['branch', '-d', entry.branch], { cwd: root, stdio: 'pipe' });
    } catch {
      // Non-fatal
    }
  }

  return {
    name,
    branch: entry.branch,
    baseBranch,
    merged: true,
    conflicts: [],
  };
}

/**
 * Prune stale worktree entries
 * @param {Object} options - Prune options
 * @param {number} [options.maxAgeDays] - Remove entries older than this many days
 * @param {number} [options.recentCommitMinutes] - Protect branches with commits newer than this (default: 60)
 * @returns {Array} Pruned entries
 */
function pruneWorktrees(options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { maxAgeDays = 30, recentCommitMinutes = 60 } = options;

  const now = new Date();
  const pruned = [];
  const skipped = [];

  for (const [name, entry] of Object.entries(registry.worktrees)) {
    const created = new Date(entry.createdAt);
    const ageDays = (now - created) / (1000 * 60 * 60 * 24);
    const dirExists = fs.existsSync(entry.path);

    const shouldPrune =
      // Always prune destroyed entries
      entry.status === 'destroyed' ||
      // Prune active entries whose directory is gone (filesystem-registry desync)
      (entry.status === 'active' && !dirExists) ||
      // Prune old missing entries
      (!dirExists && ageDays > maxAgeDays);

    if (shouldPrune) {
      // Before pruning a non-destroyed entry, check for recent commits
      if (entry.status !== 'destroyed' && entry.branch) {
        const lastCommit = getLastCommitInfo(entry.branch, root);
        if (lastCommit) {
          const commitAgeMinutes = (now - lastCommit.timestamp) / (1000 * 60);
          if (commitAgeMinutes < recentCommitMinutes) {
            skipped.push({ name, reason: `recent commit (${lastCommit.age})`, entry });
            continue;
          }
        }
      }

      // Clean up filesystem if still exists
      if (dirExists) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', entry.path], {
            cwd: root,
            stdio: 'pipe',
          });
        } catch {
          fs.removeSync(entry.path);
        }
      }
      pruned.push(entry);
      delete registry.worktrees[name];
    }
  }

  // Prune git's worktree list
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
  } catch {
    // Non-fatal
  }

  saveRegistry(root, registry);
  return { pruned, skipped };
}

module.exports = {
  createWorktree,
  listWorktrees,
  destroyWorktree,
  mergeWorktree,
  pruneWorktrees,
  loadRegistry,
  getRepoRoot,
  getLastCommitInfo,
  isBranchMerged,
  discoverUnregisteredWorktrees,
  autoRegisterWorktree,
  WORKTREES_DIR,
  REGISTRY_FILE,
  BRANCH_PREFIX,
};
