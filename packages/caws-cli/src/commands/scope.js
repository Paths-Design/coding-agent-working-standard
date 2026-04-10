/**
 * @fileoverview CAWS Scope CLI Command
 * Inspects and displays effective scope boundaries for the current context
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const path = require('path');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const {
  getRepoRoot,
  loadRegistry,
  findFeatureSpecPath,
  WORKTREES_DIR,
} = require('../worktree/worktree-manager');

/**
 * Handle scope subcommands
 * @param {string} subcommand - Subcommand name
 * @param {Object} options - Command options
 */
async function scopeCommand(subcommand, options = {}) {
  try {
    switch (subcommand) {
      case 'show':
        return handleShow(options);
      default:
        console.error(chalk.red(`Unknown scope subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: show'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`${error.message}`));
    process.exit(1);
  }
}

/**
 * Detect if current working directory is inside a worktree
 * @param {string} root - Repository root
 * @returns {{ inWorktree: boolean, worktreeName: string|null }}
 */
function detectWorktreeContext(root) {
  const cwd = process.cwd();
  const worktreesBase = path.join(root, WORKTREES_DIR);

  if (!cwd.startsWith(worktreesBase + path.sep) && cwd !== worktreesBase) {
    return { inWorktree: false, worktreeName: null };
  }

  // Extract worktree name: first path segment after the worktrees dir
  const relative = path.relative(worktreesBase, cwd);
  const worktreeName = relative.split(path.sep)[0];

  if (!worktreeName) {
    return { inWorktree: false, worktreeName: null };
  }

  return { inWorktree: true, worktreeName };
}

/**
 * Load a spec file and return its parsed contents
 * @param {string} specPath - Absolute path to spec YAML
 * @returns {Object|null}
 */
function loadSpec(specPath) {
  try {
    if (!fs.existsSync(specPath)) return null;
    const content = fs.readFileSync(specPath, 'utf8');
    return yaml.load(content);
  } catch {
    return null;
  }
}

/**
 * Find all active spec files in .caws/specs/
 * @param {string} root - Repository root
 * @returns {Array<{ id: string, path: string, data: Object }>}
 */
function findAllActiveSpecs(root) {
  const specsDir = path.join(root, '.caws', 'specs');
  if (!fs.existsSync(specsDir)) return [];

  const files = fs.readdirSync(specsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
  const specs = [];

  for (const file of files) {
    const specPath = path.join(specsDir, file);
    const data = loadSpec(specPath);
    if (!data) continue;

    // Skip closed/archived specs
    const status = (data.status || '').toLowerCase();
    if (status === 'closed' || status === 'archived') continue;

    const id = path.basename(file, path.extname(file));
    specs.push({ id, path: specPath, data });
  }

  return specs;
}

/**
 * Print scope patterns for a spec
 * @param {Object} data - Parsed spec YAML
 * @param {string} indent - Indentation prefix
 */
function printScopePatterns(data, indent = '   ') {
  const scope = data.scope || {};
  const scopeIn = scope.in || scope.include || [];
  const scopeOut = scope.out || scope.exclude || [];

  if (scopeIn.length > 0) {
    console.log(chalk.green(`${indent}scope.in:`));
    for (const pattern of scopeIn) {
      console.log(chalk.gray(`${indent}  - ${pattern}`));
    }
  } else {
    console.log(chalk.yellow(`${indent}scope.in: (none defined)`));
  }

  if (scopeOut.length > 0) {
    console.log(chalk.red(`${indent}scope.out:`));
    for (const pattern of scopeOut) {
      console.log(chalk.gray(`${indent}  - ${pattern}`));
    }
  } else {
    console.log(chalk.gray(`${indent}scope.out: (none)`));
  }
}

/**
 * Handle the 'show' subcommand
 * @param {Object} options - Command options
 */
function handleShow(options) {
  const root = getRepoRoot();
  const { inWorktree, worktreeName } = detectWorktreeContext(root);

  console.log(chalk.bold.cyan('CAWS Scope Inspector'));
  console.log(chalk.cyan('='.repeat(50)));
  console.log('');

  if (inWorktree) {
    return handleAuthoritativeMode(root, worktreeName);
  } else {
    return handleUnionMode(root);
  }
}

/**
 * Handle authoritative mode: agent is inside a worktree with a bound spec
 * @param {string} root - Repository root
 * @param {string} worktreeName - Name of the worktree
 */
function handleAuthoritativeMode(root, worktreeName) {
  console.log(chalk.white(`Worktree: ${chalk.bold(worktreeName)}`));

  const registry = loadRegistry(root);
  const entry = registry.worktrees ? registry.worktrees[worktreeName] : null;

  if (!entry) {
    console.log(chalk.red(`Worktree '${worktreeName}' not found in registry.`));
    console.log(chalk.yellow('The scope guard is operating in union mode (all active specs).'));
    return handleUnionMode(root);
  }

  const specId = entry.specId;

  if (!specId) {
    console.log(chalk.yellow('Mode: union (no spec bound to this worktree)'));
    console.log('');
    console.log(chalk.yellow('This worktree has no spec binding. The scope guard checks'));
    console.log(chalk.yellow('against the union of all active specs.'));
    console.log('');
    console.log(chalk.blue('To bind a spec: caws worktree bind <spec-id>'));
    console.log('');
    return handleUnionMode(root);
  }

  // Load the spec
  const specPath = findFeatureSpecPath(root, specId);
  if (!specPath) {
    console.log(chalk.red(`Bound spec '${specId}' not found on disk.`));
    console.log(chalk.yellow('Fix: recreate the spec or rebind with a valid spec ID.'));
    console.log(chalk.blue(`  caws worktree bind <valid-spec-id>`));
    return;
  }

  const specData = loadSpec(specPath);
  if (!specData) {
    console.log(chalk.red(`Failed to parse spec file: ${specPath}`));
    return;
  }

  console.log(chalk.green(`Mode: authoritative (single bound spec)`));
  console.log(chalk.white(`Spec: ${chalk.bold(specId)}`));
  if (specData.title) {
    console.log(chalk.gray(`Title: ${specData.title}`));
  }
  console.log('');

  // Print scope patterns
  printScopePatterns(specData);
  console.log('');

  // Check binding health: mutual reference
  const specWorktreeRef = specData.worktree || null;
  const registrySpecRef = specId;

  let bindingHealthy = true;

  if (specWorktreeRef !== worktreeName) {
    bindingHealthy = false;
    console.log(chalk.yellow('Binding health: BROKEN'));
    console.log(chalk.yellow(`  Registry points to spec '${registrySpecRef}'`));
    console.log(chalk.yellow(`  Spec 'worktree' field: ${specWorktreeRef || '(missing)'} (expected: ${worktreeName})`));
    console.log('');
    console.log(chalk.blue(`Fix: caws worktree bind ${specId}`));
  } else {
    console.log(chalk.green('Binding health: OK'));
    console.log(chalk.gray(`  Registry -> spec: ${registrySpecRef}`));
    console.log(chalk.gray(`  Spec -> worktree: ${specWorktreeRef}`));
  }
}

/**
 * Handle union mode: no worktree or no spec binding
 * @param {string} root - Repository root
 */
function handleUnionMode(root) {
  const specs = findAllActiveSpecs(root);

  if (specs.length === 0) {
    console.log(chalk.gray('Mode: union (no active specs found)'));
    console.log('');
    console.log(chalk.gray('No active feature specs in .caws/specs/.'));
    console.log(chalk.gray('The scope guard has no patterns to enforce.'));
    console.log('');
    console.log(chalk.blue('Create a spec: caws specs create <id> --title "description"'));
    return;
  }

  console.log(chalk.white('Mode: union (checking all active specs)'));
  console.log(chalk.gray(`Active specs: ${specs.length}`));
  console.log('');

  for (const spec of specs) {
    const statusLabel = spec.data.status || 'draft';
    console.log(chalk.white(`  ${chalk.bold(spec.id)} [${statusLabel}]`));
    if (spec.data.title) {
      console.log(chalk.gray(`  Title: ${spec.data.title}`));
    }
    printScopePatterns(spec.data, '    ');

    // Check if this spec has a worktree binding
    if (spec.data.worktree) {
      console.log(chalk.gray(`    worktree: ${spec.data.worktree}`));
    }
    console.log('');
  }
}

module.exports = { scopeCommand };
