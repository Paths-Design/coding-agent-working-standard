/**
 * @fileoverview CAWS Worktree CLI Command
 * Manages git worktrees for agent scope isolation
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const {
  createWorktree,
  listWorktrees,
  destroyWorktree,
  pruneWorktrees,
} = require('../worktree/worktree-manager');

/**
 * Handle worktree subcommands
 * @param {string} subcommand - Subcommand name
 * @param {Object} options - Command options
 */
async function worktreeCommand(subcommand, options = {}) {
  try {
    switch (subcommand) {
      case 'create':
        return handleCreate(options);
      case 'list':
        return handleList();
      case 'destroy':
        return handleDestroy(options);
      case 'prune':
        return handlePrune(options);
      default:
        console.error(chalk.red(`Unknown worktree subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: create, list, destroy, prune'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`❌ ${error.message}`));
    process.exit(1);
  }
}

function handleCreate(options) {
  const { name, scope, baseBranch, specId } = options;

  if (!name) {
    console.error(chalk.red('❌ Worktree name is required'));
    console.log(chalk.blue('Usage: caws worktree create <name> [--scope "src/auth/**"]'));
    process.exit(1);
  }

  console.log(chalk.cyan(`🌿 Creating worktree: ${name}`));

  const entry = createWorktree(name, { scope, baseBranch, specId });

  console.log(chalk.green(`✅ Worktree created`));
  console.log(chalk.gray(`   Path:   ${entry.path}`));
  console.log(chalk.gray(`   Branch: ${entry.branch}`));
  if (entry.scope) console.log(chalk.gray(`   Scope:  ${entry.scope}`));
  if (entry.specId) console.log(chalk.gray(`   Spec:   ${entry.specId}`));
  console.log(chalk.blue(`\n💡 cd ${entry.path} to start working in the isolated worktree`));
}

function handleList() {
  const entries = listWorktrees();

  if (entries.length === 0) {
    console.log(chalk.gray('No worktrees registered.'));
    console.log(chalk.blue('Create one with: caws worktree create <name>'));
    return;
  }

  console.log(chalk.bold.cyan('🌿 CAWS Worktrees'));
  console.log(chalk.cyan('━'.repeat(70)));
  console.log(
    chalk.bold(
      'Name'.padEnd(20) +
        'Status'.padEnd(12) +
        'Branch'.padEnd(20) +
        'Scope'
    )
  );
  console.log(chalk.gray('─'.repeat(70)));

  for (const entry of entries) {
    const statusColor =
      entry.status === 'active'
        ? chalk.green
        : entry.status === 'destroyed'
        ? chalk.gray
        : chalk.yellow;

    console.log(
      entry.name.padEnd(20) +
        statusColor(entry.status.padEnd(12)) +
        (entry.branch || '').padEnd(20) +
        (entry.scope || '-')
    );
  }

  console.log('');
}

function handleDestroy(options) {
  const { name, deleteBranch, force } = options;

  if (!name) {
    console.error(chalk.red('❌ Worktree name is required'));
    console.log(chalk.blue('Usage: caws worktree destroy <name> [--delete-branch] [--force]'));
    process.exit(1);
  }

  console.log(chalk.cyan(`🗑️  Destroying worktree: ${name}`));
  destroyWorktree(name, { deleteBranch, force });
  console.log(chalk.green(`✅ Worktree '${name}' destroyed`));
  if (deleteBranch) {
    console.log(chalk.gray('   Branch also deleted'));
  }
}

function handlePrune(options) {
  const maxAge = options.maxAge !== undefined ? parseInt(options.maxAge, 10) : 30;

  console.log(chalk.cyan(`🧹 Pruning worktrees (max age: ${maxAge} days)`));
  const pruned = pruneWorktrees({ maxAgeDays: maxAge });

  if (pruned.length === 0) {
    console.log(chalk.gray('Nothing to prune.'));
  } else {
    console.log(chalk.green(`✅ Pruned ${pruned.length} worktree(s):`));
    for (const entry of pruned) {
      console.log(chalk.gray(`   - ${entry.name} (created ${entry.createdAt})`));
    }
  }
}

module.exports = { worktreeCommand };
