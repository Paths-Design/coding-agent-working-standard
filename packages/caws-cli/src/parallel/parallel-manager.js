/**
 * @fileoverview CAWS Parallel Workspace Manager
 * Orchestrates multi-agent worktree + session setup from a plan file.
 * @author @darianrosebrook
 */

const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');

const {
  createWorktree,
  listWorktrees,
  destroyWorktree,
  getRepoRoot,
  BRANCH_PREFIX,
} = require('../worktree/worktree-manager');

const {
  listSessions,
  endSession,
} = require('../session/session-manager');

const PARALLEL_REGISTRY = '.caws/parallel.json';
const VALID_STRATEGIES = ['merge', 'rebase', 'squash'];
const NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

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
 * Load the parallel registry
 * @param {string} root - Repository root
 * @returns {Object|null} Registry or null if not found
 */
function loadParallelRegistry(root) {
  const regPath = path.join(root, PARALLEL_REGISTRY);
  try {
    if (fs.existsSync(regPath)) {
      return JSON.parse(fs.readFileSync(regPath, 'utf8'));
    }
  } catch {
    // Corrupted registry
  }
  return null;
}

/**
 * Save the parallel registry
 * @param {string} root - Repository root
 * @param {Object} data - Registry data
 */
function saveParallelRegistry(root, data) {
  const regPath = path.join(root, PARALLEL_REGISTRY);
  fs.ensureDirSync(path.dirname(regPath));
  fs.writeFileSync(regPath, JSON.stringify(data, null, 2));
}

/**
 * Remove the parallel registry
 * @param {string} root - Repository root
 */
function removeParallelRegistry(root) {
  const regPath = path.join(root, PARALLEL_REGISTRY);
  if (fs.existsSync(regPath)) {
    fs.removeSync(regPath);
  }
}

/**
 * Load and validate a parallel plan YAML file
 * @param {string} filePath - Path to plan YAML file
 * @returns {Object} Parsed and validated plan
 */
function loadPlan(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Plan file not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  let plan;
  try {
    plan = yaml.load(content);
  } catch (err) {
    throw new Error(`Invalid YAML in plan file: ${err.message}`);
  }

  if (!plan || typeof plan !== 'object') {
    throw new Error('Plan file must contain a YAML object');
  }

  if (plan.version !== 1) {
    throw new Error(`Unsupported plan version: ${plan.version}. Expected 1.`);
  }

  if (!Array.isArray(plan.agents) || plan.agents.length === 0) {
    throw new Error('Plan must define at least one agent');
  }

  if (plan.merge_strategy && !VALID_STRATEGIES.includes(plan.merge_strategy)) {
    throw new Error(`Invalid merge_strategy: ${plan.merge_strategy}. Must be one of: ${VALID_STRATEGIES.join(', ')}`);
  }

  const names = new Set();
  for (const agent of plan.agents) {
    if (!agent.name) {
      throw new Error('Each agent must have a name');
    }
    if (!NAME_REGEX.test(agent.name)) {
      throw new Error(`Invalid agent name '${agent.name}': must contain only letters, numbers, hyphens, and underscores`);
    }
    if (names.has(agent.name)) {
      throw new Error(`Duplicate agent name: ${agent.name}`);
    }
    names.add(agent.name);
  }

  return {
    version: plan.version,
    baseBranch: plan.base_branch || null,
    mergeStrategy: plan.merge_strategy || 'merge',
    agents: plan.agents,
  };
}

/**
 * Set up parallel worktrees from a plan
 * @param {Object} plan - Validated plan from loadPlan
 * @returns {Object[]} Array of created worktree entries
 */
function setupParallel(plan) {
  const root = getRepoRoot();

  // Check for existing parallel run
  const existing = loadParallelRegistry(root);
  if (existing && existing.agents && existing.agents.length > 0) {
    throw new Error(
      'A parallel run is already active. Run `caws parallel teardown` first, or `caws parallel status` to inspect.'
    );
  }

  const baseBranch = plan.baseBranch || getCurrentBranch();
  const results = [];

  for (const agent of plan.agents) {
    const entry = createWorktree(agent.name, {
      scope: agent.scope || null,
      baseBranch,
      specId: agent.spec_id || null,
    });
    results.push({ ...entry, intent: agent.intent || null, role: agent.role || 'worker' });
  }

  // Write parallel registry
  saveParallelRegistry(root, {
    version: 1,
    createdAt: new Date().toISOString(),
    baseBranch,
    mergeStrategy: plan.mergeStrategy || 'merge',
    agents: plan.agents.map((a) => ({
      name: a.name,
      scope: a.scope || null,
      specId: a.spec_id || null,
      role: a.role || 'worker',
      intent: a.intent || null,
    })),
  });

  return results;
}

/**
 * Get status of all parallel worktrees
 * @returns {Object|null} Parallel status or null if no active run
 */
function getParallelStatus() {
  const root = getRepoRoot();
  const parallelReg = loadParallelRegistry(root);
  if (!parallelReg) return null;

  const worktrees = listWorktrees();

  const agentStatuses = parallelReg.agents.map((agent) => {
    const wt = worktrees.find((w) => w.name === agent.name);
    let commitCount = 0;
    let dirty = false;

    if (wt && wt.status === 'active') {
      try {
        const log = execFileSync(
          'git',
          ['log', '--oneline', `${parallelReg.baseBranch}..${wt.branch}`],
          { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        commitCount = log.trim().split('\n').filter(Boolean).length;
      } catch {
        // Branch may not have diverged
      }

      try {
        const status = execFileSync('git', ['status', '--porcelain'], {
          cwd: wt.path,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        dirty = status.trim().length > 0;
      } catch {
        // Worktree may be inaccessible
      }
    }

    return {
      name: agent.name,
      branch: wt ? wt.branch : BRANCH_PREFIX + agent.name,
      status: wt ? wt.status : 'missing',
      scope: agent.scope || '(all)',
      commitCount,
      dirty,
      intent: agent.intent,
    };
  });

  // Detect file-level conflicts between agents
  const conflicts = detectFileConflicts(parallelReg.baseBranch, agentStatuses);

  return {
    baseBranch: parallelReg.baseBranch,
    mergeStrategy: parallelReg.mergeStrategy,
    createdAt: parallelReg.createdAt,
    agents: agentStatuses,
    conflicts,
  };
}

/**
 * Detect file-level conflicts between agent branches
 * @param {string} baseBranch - Base branch name
 * @param {Object[]} agentStatuses - Agent status objects with branch field
 * @returns {Object[]} Conflicts: [{file, agents: [name, name]}]
 */
function detectFileConflicts(baseBranch, agentStatuses) {
  const root = getRepoRoot();
  const filesByAgent = {};

  for (const agent of agentStatuses) {
    if (agent.status !== 'active') continue;
    try {
      const diff = execFileSync(
        'git',
        ['diff', '--name-only', `${baseBranch}...${agent.branch}`],
        { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      filesByAgent[agent.name] = diff.trim().split('\n').filter(Boolean);
    } catch {
      filesByAgent[agent.name] = [];
    }
  }

  // Find overlapping files
  const conflicts = [];
  const agentNames = Object.keys(filesByAgent);
  for (let i = 0; i < agentNames.length; i++) {
    for (let j = i + 1; j < agentNames.length; j++) {
      const a = agentNames[i];
      const b = agentNames[j];
      const overlap = filesByAgent[a].filter((f) => filesByAgent[b].includes(f));
      for (const file of overlap) {
        conflicts.push({ file, agents: [a, b] });
      }
    }
  }

  return conflicts;
}

/**
 * Merge all parallel branches back to base
 * @param {Object} options - Merge options
 * @param {string} [options.strategy] - Override merge strategy
 * @param {boolean} [options.dryRun] - Preview without executing
 * @param {boolean} [options.force] - Force merge even with conflicts
 * @returns {Object} Merge results {merged, failed, conflicts}
 */
function mergeParallel(options = {}) {
  const root = getRepoRoot();
  const parallelReg = loadParallelRegistry(root);
  if (!parallelReg) {
    throw new Error('No active parallel run found. Run `caws parallel setup` first.');
  }

  const strategy = options.strategy || parallelReg.mergeStrategy || 'merge';
  const worktrees = listWorktrees();
  const activeAgents = parallelReg.agents
    .map((a) => {
      const wt = worktrees.find((w) => w.name === a.name);
      return wt ? { ...a, ...wt } : null;
    })
    .filter((a) => a && a.status === 'active');

  // Check for dirty worktrees
  for (const agent of activeAgents) {
    try {
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: agent.path,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (status.trim().length > 0) {
        throw new Error(
          `Worktree '${agent.name}' has uncommitted changes. Commit or stash before merging.`
        );
      }
    } catch (err) {
      if (err.message.includes('uncommitted changes')) throw err;
      // Worktree may be inaccessible
    }
  }

  // Build agent status for conflict detection
  const agentStatuses = activeAgents.map((a) => ({
    name: a.name,
    branch: a.branch,
    status: 'active',
  }));
  const conflicts = detectFileConflicts(parallelReg.baseBranch, agentStatuses);

  if (conflicts.length > 0 && !options.force) {
    return { merged: [], failed: [], conflicts };
  }

  if (options.dryRun) {
    return {
      merged: activeAgents.map((a) => a.name),
      failed: [],
      conflicts,
      dryRun: true,
    };
  }

  // Checkout base branch
  execFileSync('git', ['checkout', parallelReg.baseBranch], {
    cwd: root,
    stdio: 'pipe',
  });

  const merged = [];
  const failed = [];

  for (const agent of activeAgents) {
    try {
      if (strategy === 'rebase') {
        execFileSync('git', ['rebase', agent.branch], {
          cwd: root,
          stdio: 'pipe',
        });
      } else if (strategy === 'squash') {
        execFileSync('git', ['merge', '--squash', agent.branch], {
          cwd: root,
          stdio: 'pipe',
        });
        execFileSync(
          'git',
          ['commit', '-m', `feat: merge ${agent.name} (squashed)`],
          { cwd: root, stdio: 'pipe' }
        );
      } else {
        execFileSync('git', ['merge', agent.branch, '--no-edit'], {
          cwd: root,
          stdio: 'pipe',
        });
      }
      merged.push(agent.name);
    } catch (err) {
      // Abort failed merge
      try {
        execFileSync('git', ['merge', '--abort'], { cwd: root, stdio: 'pipe' });
      } catch {
        try {
          execFileSync('git', ['rebase', '--abort'], { cwd: root, stdio: 'pipe' });
        } catch {
          // Already clean
        }
      }
      failed.push({ name: agent.name, error: err.message });
    }
  }

  return { merged, failed, conflicts };
}

/**
 * Tear down all parallel worktrees
 * @param {Object} options - Teardown options
 * @param {boolean} [options.deleteBranches] - Also delete branches
 * @param {boolean} [options.force] - Force removal even if dirty
 * @returns {Object} Teardown results {destroyed, failed}
 */
function teardownParallel(options = {}) {
  const root = getRepoRoot();
  const parallelReg = loadParallelRegistry(root);
  if (!parallelReg) {
    throw new Error('No active parallel run found.');
  }

  const { deleteBranches = false, force = false } = options;
  const destroyed = [];
  const failed = [];

  for (const agent of parallelReg.agents) {
    try {
      destroyWorktree(agent.name, { deleteBranch: deleteBranches, force });
      destroyed.push(agent.name);
    } catch (err) {
      failed.push({ name: agent.name, error: err.message });
    }
  }

  // Remove parallel registry
  removeParallelRegistry(root);

  return { destroyed, failed };
}

module.exports = {
  loadPlan,
  setupParallel,
  getParallelStatus,
  mergeParallel,
  teardownParallel,
  detectFileConflicts,
  loadParallelRegistry,
  saveParallelRegistry,
  removeParallelRegistry,
  PARALLEL_REGISTRY,
};
