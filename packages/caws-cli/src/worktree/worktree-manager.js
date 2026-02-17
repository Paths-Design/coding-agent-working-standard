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

    return {
      ...entry,
      status: exists && inGit ? 'active' : exists ? 'orphaned' : 'missing',
    };
  });

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

  const entry = registry.worktrees[name];
  if (!entry) {
    throw new Error(`Worktree '${name}' not found in registry`);
  }

  // Remove git worktree
  try {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push(entry.path);
    execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  } catch (error) {
    if (force) {
      // Force cleanup: remove directory manually
      if (fs.existsSync(entry.path)) {
        fs.removeSync(entry.path);
      }
      // Prune git worktree list
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
      } catch {
        // Non-fatal
      }
    } else {
      throw new Error(`Failed to remove worktree: ${error.message}. Use --force to override.`);
    }
  }

  // Optionally delete branch
  if (deleteBranch && entry.branch) {
    try {
      execFileSync('git', ['branch', '-d', entry.branch], { cwd: root, stdio: 'pipe' });
    } catch {
      if (force) {
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
 * Prune stale worktree entries
 * @param {Object} options - Prune options
 * @param {number} [options.maxAgeDays] - Remove entries older than this many days
 * @returns {Array} Pruned entries
 */
function pruneWorktrees(options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { maxAgeDays = 30 } = options;

  const now = new Date();
  const pruned = [];

  for (const [name, entry] of Object.entries(registry.worktrees)) {
    const created = new Date(entry.createdAt);
    const ageDays = (now - created) / (1000 * 60 * 60 * 24);

    const shouldPrune =
      entry.status === 'destroyed' ||
      (!fs.existsSync(entry.path) && ageDays > maxAgeDays) ||
      (maxAgeDays === 0 && entry.status === 'destroyed');

    if (shouldPrune) {
      // Clean up filesystem if still exists
      if (fs.existsSync(entry.path)) {
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
  return pruned;
}

module.exports = {
  createWorktree,
  listWorktrees,
  destroyWorktree,
  pruneWorktrees,
  loadRegistry,
  getRepoRoot,
  WORKTREES_DIR,
  REGISTRY_FILE,
  BRANCH_PREFIX,
};
