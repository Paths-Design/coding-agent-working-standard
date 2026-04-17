/**
 * @fileoverview CAWS Git Worktree Manager
 * Provides CRUD operations for git worktrees with scope isolation
 * @author @darianrosebrook
 */

const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');
const { createValidator, getSchemaPath } = require('../utils/schema-validator');
const { getAgentSessionId } = require('../utils/agent-session');
const { lifecycle, EVENTS } = require('../utils/lifecycle-events');

const WORKTREES_DIR = '.caws/worktrees';
const REGISTRY_FILE = '.caws/worktrees.json';
const BRANCH_PREFIX = 'caws/';

function findFeatureSpecPath(root, specId) {
  if (!specId) return null;

  const candidates = [
    path.join(root, '.caws', 'specs', `${specId}.yaml`),
    path.join(root, '.caws', 'specs', `${specId}.yml`),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function writeSpecWithWorktree(filePath, worktreeName) {
  const yaml = require('js-yaml');
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== 'object') {
    return content;
  }

  parsed.worktree = worktreeName;
  return yaml.dump(parsed, { lineWidth: 120, noRefs: true });
}

function hasPathChanges(root, relativePath) {
  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', '--', relativePath],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function ensureCanonicalSpecCommitted(root, specPath, specId, worktreeName) {
  const relativeSpecPath = path.relative(root, specPath);
  const nextContent = writeSpecWithWorktree(specPath, worktreeName);
  const currentContent = fs.readFileSync(specPath, 'utf8');

  if (currentContent !== nextContent) {
    fs.writeFileSync(specPath, nextContent);
  }

  if (!hasPathChanges(root, relativeSpecPath)) {
    return false;
  }

  execFileSync('git', ['add', '--', relativeSpecPath], {
    cwd: root,
    stdio: 'pipe',
  });
  execFileSync(
    'git',
    ['commit', '-m', `chore(caws): bind spec ${specId} to worktree ${worktreeName}`, '--', relativeSpecPath],
    {
      cwd: root,
      stdio: 'pipe',
    }
  );
  return true;
}

function materializeWorktreeSpec(root, cawsDest, specId, worktreeName, scope) {
  if (!specId) return;

  const canonicalSpecPath = findFeatureSpecPath(root, specId);
  const workingSpecPath = path.join(cawsDest, 'working-spec.yaml');

  if (!canonicalSpecPath) {
    console.warn(
      chalk.yellow(`Warning: spec '${specId}' not found in .caws/specs/ — generating default working spec for worktree`)
    );
  }

  if (canonicalSpecPath) {
    const destSpecsDir = path.join(cawsDest, 'specs');
    const destSpecPath = path.join(destSpecsDir, path.basename(canonicalSpecPath));
    fs.ensureDirSync(destSpecsDir);

    // Keep a canonical feature-spec copy inside the worktree and align
    // working-spec.yaml to that exact content for legacy-compatible commands.
    const specContent = writeSpecWithWorktree(canonicalSpecPath, worktreeName);
    fs.writeFileSync(destSpecPath, specContent);
    fs.writeFileSync(workingSpecPath, specContent);
    return;
  }

  const { generateWorkingSpec } = require('../generators/working-spec');
  let specContent = generateWorkingSpec({
    projectId: specId,
    projectTitle: `Worktree: ${worktreeName}`,
    projectDescription: `Isolated worktree for ${worktreeName}`,
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

  try {
    const yaml = require('js-yaml');
    const parsed = yaml.load(specContent);
    if (parsed && typeof parsed === 'object') {
      parsed.worktree = worktreeName;
      specContent = yaml.dump(parsed, { lineWidth: 120, noRefs: true });
    }
  } catch {
    // Keep generated spec content if augmentation fails.
  }

  fs.ensureDirSync(path.dirname(workingSpecPath));
  fs.writeFileSync(workingSpecPath, specContent);
}

function parseSpecIdFromYamlFile(filePath) {
  try {
    const yaml = require('js-yaml');
    const doc = yaml.load(fs.readFileSync(filePath, 'utf8'));
    if (doc && typeof doc.id === 'string' && doc.id.trim()) {
      return doc.id.trim();
    }
  } catch {
    // Ignore malformed YAML during inference
  }
  return null;
}

/**
 * Scan .caws/specs/ for a spec that declares `worktree: <name>`.
 * Returns the spec's id if found, null otherwise.
 * This enables auto-binding: when a spec already names the worktree
 * it expects, the registry entry gets the specId automatically.
 * @param {string} root - Repository root
 * @param {string} worktreeName - Worktree name to match
 * @returns {string|null} Spec ID or null
 */
function findSpecByWorktreeName(root, worktreeName) {
  const yaml = require('js-yaml');
  const specsDir = path.join(root, '.caws', 'specs');
  if (!fs.existsSync(specsDir)) return null;

  const specFiles = fs.readdirSync(specsDir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));

  for (const specFile of specFiles) {
    try {
      const doc = yaml.load(fs.readFileSync(path.join(specsDir, specFile), 'utf8'));
      if (doc && doc.worktree === worktreeName && typeof doc.id === 'string') {
        return doc.id.trim();
      }
    } catch {
      // Skip malformed spec files
    }
  }
  return null;
}

function inferSpecIdForWorktree(worktreePath) {
  if (!worktreePath) return null;

  const specsDir = path.join(worktreePath, '.caws', 'specs');
  if (fs.existsSync(specsDir)) {
    const specFiles = fs.readdirSync(specsDir)
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
      .sort();

    for (const specFile of specFiles) {
      const inferred = parseSpecIdFromYamlFile(path.join(specsDir, specFile));
      if (inferred) {
        return inferred;
      }
    }
  }

  return parseSpecIdFromYamlFile(path.join(worktreePath, '.caws', 'working-spec.yaml'));
}

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
 * Check if a branch has divergent commits from target (commits on branch not on target).
 * @param {string} branch - Branch to check
 * @param {string} target - Target branch (e.g., "main")
 * @param {string} root - Repository root
 * @returns {boolean}
 */
function hasDivergentCommits(branch, target, root) {
  try {
    const count = execFileSync(
      'git',
      ['rev-list', '--count', `${target}..${branch}`],
      { cwd: root, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    return parseInt(count, 10) > 0;
  } catch {
    return false;
  }
}

/**
 * Check if a worktree directory has dirty (uncommitted) files.
 * @param {string} worktreePath - Path to the worktree
 * @returns {boolean}
 */
function hasDirtyFiles(worktreePath) {
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain'],
      { cwd: worktreePath, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    return status.length > 0;
  } catch {
    return false;
  }
}

/**
 * Get the canonical git repository root (main worktree, not a linked worktree).
 *
 * `git rev-parse --show-toplevel` returns the root of whichever worktree
 * the CWD is inside. In a linked worktree that is NOT the main repo root,
 * so CAWS would read the wrong (or missing) .caws/worktrees.json.
 *
 * `--git-common-dir` always resolves to the main repo's .git directory,
 * even from inside a linked worktree. Its parent is the canonical repo root.
 *
 * @returns {string} Absolute path to the main repo root
 */
function getRepoRoot() {
  const gitCommonDir = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { encoding: 'utf8' }
  ).trim();
  // gitCommonDir is /path/to/main-repo/.git — parent is the repo root
  return path.dirname(gitCommonDir);
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

// Track whether we've already warned about schema violations this process.
// loadRegistry() is called multiple times per command; warning every time
// floods stderr and contributes to Claude Code context-window exhaustion.
let _schemaWarned = false;

/**
 * Load the worktree registry
 * @param {string} root - Repository root
 * @returns {Object} Registry object
 */
function loadRegistry(root) {
  const registryPath = path.join(root, REGISTRY_FILE);
  try {
    if (fs.existsSync(registryPath)) {
      const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      try {
        const validate = createValidator(getSchemaPath('worktrees.schema.json', root));
        const result = validate(data);
        if (!result.valid && !_schemaWarned) {
          _schemaWarned = true;
          console.warn('Worktree registry has schema violations:', result.errors);
        }
      } catch (schemaErr) {
        if (!_schemaWarned) {
          _schemaWarned = true;
          console.warn('Could not validate worktree registry schema:', schemaErr.message);
        }
      }
      return data;
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
  // Auto-prune destroyed entries whose branch and directory are both gone.
  // This prevents the registry from accumulating ghost entries over time.
  for (const [name, entry] of Object.entries(registry.worktrees || {})) {
    if (entry.status !== 'destroyed') continue;
    const dirGone = !fs.existsSync(entry.path);
    let branchGone = true;
    if (entry.branch) {
      try {
        execFileSync('git', ['rev-parse', '--verify', entry.branch], {
          cwd: root, stdio: 'pipe',
        });
        branchGone = false;
      } catch {
        branchGone = true;
      }
    }
    if (dirGone && branchGone) {
      delete registry.worktrees[name];
    }
  }

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
    specId: inferSpecIdForWorktree(discovered.path),
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

  // Check for duplicate in registry
  if (registry.worktrees[name]) {
    const existing = registry.worktrees[name];
    if (existing.status !== 'destroyed') {
      const ownerInfo = existing.owner ? ` (owned by session ${existing.owner})` : '';
      throw new Error(
        `Worktree '${name}' already exists with status '${existing.status}'${ownerInfo}.\n` +
        `Use 'caws worktree destroy ${name}' first, or choose a different name.`
      );
    }
    // Destroyed entries: check if another session owns the branch
    if (existing.owner && existing.owner !== getAgentSessionId(root)) {
      // Branch may still be in use by the owning session for merge
      try {
        const branchExists = execFileSync('git', ['rev-parse', '--verify', BRANCH_PREFIX + name], {
          cwd: root, stdio: 'pipe',
        }).toString().trim();
        if (branchExists) {
          throw new Error(
            `Worktree '${name}' was destroyed but branch '${BRANCH_PREFIX}${name}' still exists ` +
            `(owned by session ${existing.owner}).\n` +
            `The owning session may still need this branch for merging.\n` +
            `Choose a different name, or delete the branch first: git branch -d ${BRANCH_PREFIX}${name}`
          );
        }
      } catch (e) {
        if (e.message.includes('owned by session')) throw e;
        // Branch doesn't exist — safe to reuse the name
      }
    }
  }

  const worktreePath = path.join(root, WORKTREES_DIR, name);
  const branchName = BRANCH_PREFIX + name;
  const base = baseBranch || getCurrentBranch();
  const canonicalSpecPath = findFeatureSpecPath(root, specId);

  // Check if the branch already exists in git (even if not in registry)
  // This catches cases where another agent created the branch outside CAWS
  try {
    execFileSync('git', ['rev-parse', '--verify', branchName], {
      cwd: root, stdio: 'pipe',
    });
    // Branch exists — refuse unless it's fully merged into base
    const currentSession = getAgentSessionId(root);
    const registryOwner = registry.worktrees[name]?.owner;
    if (registryOwner && registryOwner !== currentSession) {
      throw new Error(
        `Branch '${branchName}' already exists and is owned by another session (${registryOwner}).\n` +
        `Another agent may be using this branch. Choose a different worktree name.`
      );
    }
    // Branch exists but no owner conflict — warn and reuse
    console.warn(`Warning: Branch '${branchName}' already exists, reusing it.`);
  } catch (e) {
    if (e.message.includes('already exists and is owned')) throw e;
    // Branch doesn't exist — this is the normal path
  }

  // Create the worktree directory
  fs.ensureDirSync(path.dirname(worktreePath));

  if (canonicalSpecPath) {
    ensureCanonicalSpecCommitted(root, canonicalSpecPath, specId, name);
  }

  // Create git worktree with new branch
  try {
    execFileSync('git', ['worktree', 'add', '-b', branchName, worktreePath, base], {
      cwd: root,
      stdio: 'pipe',
    });
  } catch (error) {
    // Branch already exists (caught above and allowed) — attach to it
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

  // Auto-bind specId: if no explicit --spec-id was passed, scan .caws/specs/
  // for a spec that declares `worktree: <name>`. This establishes the mutual
  // reference that the scope guard uses to treat one spec as authoritative.
  let resolvedSpecId = specId || null;
  if (!resolvedSpecId) {
    resolvedSpecId = findSpecByWorktreeName(root, name);
    if (resolvedSpecId) {
      console.log(chalk.gray(`   Auto-bound spec: ${resolvedSpecId}`));
    }
  }

  // Materialize a worktree-local working spec. Prefer the canonical feature
  // spec when it exists so isolated worktrees stay aligned with the main
  // registry/resolver model.
  if (resolvedSpecId) {
    try {
      materializeWorktreeSpec(root, cawsDest, resolvedSpecId, name, scope);
    } catch (error) {
      console.warn(
        chalk.yellow(`Could not materialize spec '${resolvedSpecId}' for worktree '${name}': ${error.message}`)
      );
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
    specId: resolvedSpecId,
    owner: options.owner || getAgentSessionId(root) || null,
    createdAt: new Date().toISOString(),
    status: 'fresh',
  };

  registry.worktrees[name] = entry;
  saveRegistry(root, registry);

  return entry;
}

/**
 * Reconcile registry state against git worktree list and filesystem.
 *
 * Non-destructive read that classifies every known worktree entry
 * (from registry + git discovery) into one of:
 *   active       — directory exists AND in git worktree list
 *   orphaned     — directory exists but NOT in git worktree list
 *   missing      — directory gone, branch may or may not exist
 *   destroyed    — explicitly destroyed via CAWS
 *   unregistered — in git worktree list but not in registry
 *   stale-merged — missing + branch already merged to base
 *
 * Does NOT mutate the registry. Callers decide what to persist.
 *
 * @param {string} root - Repository root
 * @returns {{ entries: Array, gitWorktrees: string[] }}
 */
function reconcileRegistry(root) {
  const registry = loadRegistry(root);

  let gitWorktrees = [];
  try {
    const output = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
      encoding: 'utf8',
      stdio: 'pipe',
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

    const merged = entry.branch && entry.baseBranch
      ? isBranchMerged(entry.branch, entry.baseBranch, root)
      : false;
    const divergent = entry.branch && entry.baseBranch
      ? hasDivergentCommits(entry.branch, entry.baseBranch, root)
      : false;
    const dirty = exists ? hasDirtyFiles(entry.path) : false;

    let status;
    if (entry.status === 'destroyed') {
      status = 'destroyed';
    } else if (exists && inGit) {
      // Worktree directory exists and is tracked by git
      if (divergent || dirty) {
        // Has commits beyond base or uncommitted work → active
        status = 'active';
      } else if (merged) {
        // No divergent commits, branch aligned with base.
        // Use stored status as history to distinguish fresh vs merged:
        //   - stored 'fresh' → never had divergent commits → still fresh
        //   - stored 'active' → had work that's now merged → merged
        if (entry.status === 'active') {
          status = 'merged';
        } else {
          status = 'fresh';
        }
      } else {
        status = 'fresh';
      }
    } else if (exists) {
      status = 'orphaned';
    } else {
      status = merged ? 'stale-merged' : 'missing';
    }

    const lastCommit = entry.branch ? getLastCommitInfo(entry.branch, root) : null;

    return { ...entry, status, lastCommit, merged, divergent, dirty };
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

  return { entries, gitWorktrees };
}

/**
 * Repair registry drift caused by manual git operations outside CAWS.
 *
 * Scans registry vs git vs filesystem, classifies each entry, and optionally
 * prunes stale entries. Reports the delta before persisting.
 *
 * @param {Object} options
 * @param {boolean} [options.prune=false] - Remove destroyed, stale-merged, and missing entries
 * @param {boolean} [options.dryRun=false] - Report only, do not persist
 * @param {boolean} [options.force=false] - Allow pruning entries owned by other sessions
 * @returns {{ repaired: Array, pruned: Array, skipped: Array }}
 */
function repairWorktrees(options = {}) {
  const { prune: shouldPrune = false, dryRun = false, force = false } = options;
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { entries } = reconcileRegistry(root);
  const currentSession = getAgentSessionId(root);

  const repaired = [];
  const pruned = [];
  const skipped = [];

  for (const entry of entries) {
    const regEntry = registry.worktrees[entry.name];

    if (entry.status === 'unregistered') {
      if (!dryRun) {
        autoRegisterWorktree(root, registry, entry);
      }
      repaired.push({ name: entry.name, action: 'registered', status: entry.status });
      continue;
    }

    if (!regEntry) continue;

    // Update registry status to match filesystem reality
    const wasAlive = regEntry.status === 'active' || regEntry.status === 'fresh';
    const nowDead = entry.status === 'missing' || entry.status === 'stale-merged';
    if (wasAlive && nowDead) {
      repaired.push({
        name: entry.name,
        action: 'status-updated',
        from: regEntry.status,
        to: entry.status,
        owner: entry.owner || null,
      });
    }

    // Determine if entry is prunable (destroyed, stale-merged, or missing)
    const isPrunable = entry.status === 'destroyed' ||
      entry.status === 'stale-merged' ||
      entry.status === 'missing';

    if (!isPrunable) continue;

    // Ownership check: refuse to prune another session's entries without --force
    const isOwnedByOther = entry.owner && currentSession && entry.owner !== currentSession;

    if (shouldPrune && isPrunable) {
      if (isOwnedByOther && !force) {
        skipped.push({
          name: entry.name,
          reason: `owned by another session (${entry.owner}). Use --force to override`,
          owner: entry.owner,
        });
      } else {
        if (!dryRun) {
          delete registry.worktrees[entry.name];
        }
        pruned.push({ name: entry.name, status: entry.status, owner: entry.owner || null });
      }
    } else if (!shouldPrune && isPrunable) {
      skipped.push({
        name: entry.name,
        reason: entry.status + ' (use --prune to remove)',
        owner: entry.owner || null,
      });
    }
  }

  if (!dryRun) {
    saveRegistry(root, registry);
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
    } catch {
      // Non-fatal
    }
  }

  return { repaired, pruned, skipped };
}

/**
 * List all registered worktrees with filesystem validation.
 * Delegates to reconcileRegistry() for state classification.
 * Persists status transitions (fresh → active, active → merged) so
 * future calls can distinguish "never had work" from "work was merged back".
 * @returns {Array} Worktree entries with status
 */
function listWorktrees() {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { entries } = reconcileRegistry(root);

  // Persist status transitions so future reconcile can use stored status as history
  let dirty = false;
  for (const entry of entries) {
    const regEntry = registry.worktrees[entry.name];
    if (regEntry && regEntry.status !== entry.status &&
        entry.status !== 'unregistered') {
      regEntry.status = entry.status;
      dirty = true;
    }
  }
  if (dirty) {
    saveRegistry(root, registry);
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
  // Ensure CWD is not inside the worktree we're about to destroy.
  // If CWD is the worktree directory, removing it crashes subsequent commands.
  try { process.chdir(root); } catch { /* non-fatal */ }
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

  // Ownership check: refuse to destroy another agent's worktree without --force
  const currentSession = getAgentSessionId(root);
  const isLiveStatus = entry.status === 'active' || entry.status === 'fresh' || entry.status === 'merged';
  if (
    !force &&
    isLiveStatus &&
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
    isLiveStatus &&
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
  const wasAlreadyDestroyed = registry.worktrees[name].status === 'destroyed';
  registry.worktrees[name].status = 'destroyed';
  registry.worktrees[name].destroyedAt = new Date().toISOString();
  saveRegistry(root, registry);

  // CAWSFIX-18: auto-commit the registry so the working tree stays clean
  if (!wasAlreadyDestroyed) {
    try {
      const status = execFileSync('git', ['status', '--porcelain', '.caws/worktrees.json'], {
        cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      }).toString().trim();
      if (status) {
        const otherActive = Object.values(registry.worktrees || {}).some(
          (e) => e.status === 'active' || e.status === 'fresh'
        );
        const prefix = otherActive ? 'wip(checkpoint)' : 'chore(worktree)';
        execFileSync('git', ['add', '.caws/worktrees.json'], { cwd: root, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', `${prefix}: record destroyed ${name}`], {
          cwd: root, stdio: 'pipe',
        });
      }
    } catch (err) {
      console.warn(chalk.yellow(`   Warning: could not auto-commit .caws/worktrees.json: ${err.message}`));
    }
  }
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

  // Check for uncommitted work in the worktree.
  // Ignore .caws/ changes (provenance chain, registry) — these are
  // infrastructure artifacts written by git hooks, not user work.
  // The post-commit hook appends to .caws/provenance/chain.json after
  // every commit, which immediately dirties the tree and blocks merges.
  if (fs.existsSync(entry.path)) {
    try {
      const rawStatus = execFileSync(
        'git',
        ['status', '--porcelain'],
        { cwd: entry.path, encoding: 'utf8', stdio: 'pipe' }
      );
      // Filter out .caws/ infrastructure changes (provenance, registry).
      // Git porcelain format: "XY PATH" — 2 status chars, space, path.
      // IMPORTANT: do NOT .trim() the raw output — it strips the leading
      // space from " M file" (unstaged), corrupting the XY prefix and
      // breaking substring(3) path extraction.
      const statusLines = rawStatus.split('\n').filter(l => l.length > 0);
      const userChanges = statusLines
        .filter(line => {
          const filePath = line.substring(3);
          return !filePath.startsWith('.caws/');
        }).join('\n');
      if (userChanges) {
        throw new Error(
          `Worktree '${name}' has uncommitted changes:\n${userChanges}\n` +
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

  // Emit merge:pre event
  try {
    lifecycle.emit(EVENTS.MERGE_PRE, {
      worktreeName: name, branch: entry.branch, baseBranch, conflicts,
      timestamp: new Date().toISOString(),
    });
  } catch { /* non-fatal */ }

  // Ensure CWD is the repo root BEFORE destroying the worktree.
  // If the caller's CWD is inside the worktree directory, destroying it
  // removes the CWD out from under the process, causing all subsequent
  // git commands to fail with "Unable to read current working directory".
  try { process.chdir(root); } catch { /* non-fatal */ }

  // Destroy the worktree (auto-forces since we're about to merge)
  destroyWorktree(name, { deleteBranch: false, force: true });

  // Switch to base branch (use cwd: root since getCurrentBranch has no cwd param)
  const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  }).trim();
  if (currentBranch !== baseBranch) {
    execFileSync('git', ['checkout', baseBranch], { cwd: root, stdio: 'pipe' });
  }

  // Merge
  // Use --no-verify to skip pre-commit/commit-msg hooks during merge.
  // The worktree commits were already validated by those hooks when originally
  // committed. Re-running them here adds seconds of blocking time (especially
  // in projects with heavy hooks like quality gates, YAML validation, etc.)
  // and can trigger OAuth token expiry races in long-running sessions.
  const mergeMessage = message || `merge(worktree): ${name}`;
  try {
    execFileSync(
      'git',
      ['merge', '--no-ff', '--no-verify', entry.branch, '-m', mergeMessage],
      { cwd: root, stdio: 'pipe' }
    );
  } catch (error) {
    const failResult = {
      name, branch: entry.branch, baseBranch, merged: false,
      conflicts: [`Merge failed: ${error.message}`],
      message: 'Merge conflicts detected. Resolve with git and commit.',
    };
    try {
      lifecycle.emit(EVENTS.MERGE_POST, { ...failResult, timestamp: new Date().toISOString() });
    } catch { /* non-fatal */ }
    return failResult;
  }

  // Delete branch after successful merge
  if (deleteBranch) {
    try {
      execFileSync('git', ['branch', '-d', entry.branch], { cwd: root, stdio: 'pipe' });
    } catch {
      // Non-fatal
    }
  }

  // Auto-close the bound spec if one exists. A worktree merge is the
  // lifecycle signal that the spec's work is done; leaving the spec
  // `active` after merge accumulates stale-active entries (D6). Direct
  // YAML status flip bypasses the ownership + worktree-reference checks
  // in `closeSpec` — the caller has already proven authority by merging.
  let autoClosedSpecId = null;
  if (entry.specId) {
    autoClosedSpecId = autoCloseBoundSpec(root, entry.specId);
  }

  const mergeResult = {
    name, branch: entry.branch, baseBranch, merged: true, conflicts: [],
    specId: entry.specId || null, autoClosedSpecId,
  };
  try {
    lifecycle.emit(EVENTS.MERGE_POST, { ...mergeResult, timestamp: new Date().toISOString() });
  } catch { /* non-fatal */ }
  return mergeResult;
}

/**
 * Flip a spec's status to `closed` by rewriting just the `status:` line.
 * Idempotent: no-op when the spec is already closed or the file is missing.
 * Returns the spec ID on success, null if skipped or failed.
 * @param {string} root - Repo root
 * @param {string} specId - Spec identifier (e.g. CAWSFIX-14)
 * @returns {string|null}
 */
function autoCloseBoundSpec(root, specId) {
  try {
    const specPath = findFeatureSpecPath(root, specId);
    if (!specPath || !fs.existsSync(specPath)) return null;
    const original = fs.readFileSync(specPath, 'utf8');
    // Idempotent: already closed → no-op, no write, no diff.
    if (/^status:\s*closed\s*$/m.test(original)) return specId;
    const patched = original.replace(/^status:\s*active\s*$/m, 'status: closed');
    if (patched === original) return null; // status was e.g. draft/archived
    fs.writeFileSync(specPath, patched, 'utf8');
    return specId;
  } catch {
    return null;
  }
}

/**
 * Prune stale worktree entries
 * @param {Object} options - Prune options
 * @param {number} [options.maxAgeDays] - Remove entries older than this many days
 * @param {number} [options.recentCommitMinutes] - Protect branches with commits newer than this (default: 60)
 * @param {boolean} [options.force] - Allow pruning entries owned by other sessions
 * @returns {{ pruned: Array, skipped: Array }} Pruned and skipped entries
 */
function pruneWorktrees(options = {}) {
  const root = getRepoRoot();
  const registry = loadRegistry(root);
  const { maxAgeDays = 30, recentCommitMinutes = 60, force = false } = options;
  const currentSession = getAgentSessionId(root);

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
      // Prune active/fresh entries whose directory is gone (filesystem-registry desync)
      ((entry.status === 'active' || entry.status === 'fresh') && !dirExists) ||
      // Prune old missing entries
      (!dirExists && ageDays > maxAgeDays);

    if (shouldPrune) {
      // Ownership check: skip entries owned by other sessions unless --force
      const isOwnedByOther = entry.owner && currentSession && entry.owner !== currentSession;
      if (isOwnedByOther && entry.status !== 'destroyed' && !force) {
        skipped.push({
          name,
          reason: `owned by another session (${entry.owner})`,
          entry,
        });
        continue;
      }

      // Before pruning a non-destroyed entry, check for recent commits (skip if --force)
      if (!force && entry.status !== 'destroyed' && entry.branch) {
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
  autoCloseBoundSpec,
  pruneWorktrees,
  repairWorktrees,
  reconcileRegistry,
  loadRegistry,
  saveRegistry,
  getRepoRoot,
  getLastCommitInfo,
  isBranchMerged,
  hasDivergentCommits,
  hasDirtyFiles,
  discoverUnregisteredWorktrees,
  autoRegisterWorktree,
  WORKTREES_DIR,
  REGISTRY_FILE,
  BRANCH_PREFIX,
  findFeatureSpecPath,
  materializeWorktreeSpec,
  inferSpecIdForWorktree,
  findSpecByWorktreeName,
};
