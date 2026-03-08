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
  mergeWorktree,
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
      case 'merge':
        return handleMerge(options);
      case 'prune':
        return handlePrune(options);
      default:
        console.error(chalk.red(`Unknown worktree subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: create, list, destroy, merge, prune'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`${error.message}`));
    process.exit(1);
  }
}

function handleCreate(options) {
  const { name, scope, baseBranch, specId } = options;

  if (!name) {
    console.error(chalk.red('Worktree name is required'));
    console.log(chalk.blue('Usage: caws worktree create <name> [--scope "src/auth/**"]'));
    process.exit(1);
  }

  console.log(chalk.cyan(`Creating worktree: ${name}`));

  const entry = createWorktree(name, { scope, baseBranch, specId });

  console.log(chalk.green(`Worktree created`));
  console.log(chalk.gray(`   Path:   ${entry.path}`));
  console.log(chalk.gray(`   Branch: ${entry.branch}`));
  if (entry.scope) console.log(chalk.gray(`   Scope:  ${entry.scope}`));
  if (entry.specId) console.log(chalk.gray(`   Spec:   ${entry.specId}`));
  console.log(chalk.blue(`\ncd ${entry.path} to start working in the isolated worktree`));
}

function handleList() {
  const entries = listWorktrees();

  if (entries.length === 0) {
    console.log(chalk.gray('No worktrees registered.'));
    console.log(chalk.blue('Create one with: caws worktree create <name>'));
    return;
  }

  console.log(chalk.bold.cyan('CAWS Worktrees'));
  console.log(chalk.cyan('='.repeat(85)));
  console.log(
    chalk.bold(
      'Name'.padEnd(18) +
        'Status'.padEnd(12) +
        'Branch'.padEnd(20) +
        'Last Commit'.padEnd(16) +
        'Owner'
    )
  );
  console.log(chalk.gray('-'.repeat(85)));

  for (const entry of entries) {
    const statusColor =
      entry.status === 'active'
        ? chalk.green
        : entry.status === 'destroyed'
          ? chalk.gray
          : chalk.yellow;

    // Format last commit age
    let commitAge = chalk.gray('-');
    if (entry.lastCommit) {
      commitAge = chalk.white(entry.lastCommit.age);
    }

    // Format owner — show truncated session ID or '-'
    let ownerStr = chalk.gray('-');
    if (entry.owner) {
      // Show last 8 chars of session ID for readability
      const short = entry.owner.length > 8 ? '...' + entry.owner.slice(-8) : entry.owner;
      ownerStr = chalk.gray(short);
    }

    // Status suffix for merged branches
    let statusStr = entry.status;
    if (entry.merged && entry.status === 'active') {
      statusStr = 'merged';
    }

    console.log(
      entry.name.padEnd(18) +
        statusColor(statusStr.padEnd(12)) +
        (entry.branch || '').padEnd(20) +
        commitAge.padEnd(16 + 10) + // +10 for chalk color codes
        ownerStr
    );
  }

  console.log('');
}

function handleDestroy(options) {
  const { name, deleteBranch, force } = options;

  if (!name) {
    console.error(chalk.red('Worktree name is required'));
    console.log(chalk.blue('Usage: caws worktree destroy <name> [--delete-branch] [--force]'));
    process.exit(1);
  }

  console.log(chalk.cyan(`Destroying worktree: ${name}`));
  destroyWorktree(name, { deleteBranch, force });
  console.log(chalk.green(`Worktree '${name}' destroyed`));
  if (deleteBranch) {
    console.log(chalk.gray('   Branch also deleted'));
  }
}

function handleMerge(options) {
  const { name, dryRun, deleteBranch = true, message } = options;

  if (!name) {
    console.error(chalk.red('Worktree name is required'));
    console.log(
      chalk.blue(
        'Usage: caws worktree merge <name> [--dry-run] [--message "..."] [--no-delete-branch]'
      )
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(chalk.cyan(`Dry-run merge preview for: ${name}`));
  } else {
    console.log(chalk.cyan(`Merging worktree: ${name}`));
  }

  const result = mergeWorktree(name, { dryRun, deleteBranch, message });

  if (dryRun) {
    if (result.conflicts.length > 0) {
      console.log(chalk.yellow(`\nConflicts detected (${result.conflicts.length}):`));
      for (const conflict of result.conflicts) {
        console.log(chalk.yellow(`   ${conflict}`));
      }
      console.log(
        chalk.blue('\nResolve conflicts in the worktree before merging, or merge manually.')
      );
    } else {
      console.log(chalk.green(`\nNo conflicts detected. Safe to merge.`));
      console.log(chalk.blue(`Run without --dry-run to merge: caws worktree merge ${name}`));
    }
    return;
  }

  if (result.merged) {
    console.log(chalk.green(`Worktree '${name}' merged to ${result.baseBranch}`));
    if (deleteBranch) {
      console.log(chalk.gray(`   Branch ${result.branch} deleted`));
    }
  } else {
    console.log(chalk.red(`Merge failed for '${name}'`));
    for (const conflict of result.conflicts) {
      console.log(chalk.yellow(`   ${conflict}`));
    }
    console.log(chalk.blue('\nThe worktree has been destroyed but the merge has conflicts.'));
    console.log(chalk.blue('Resolve conflicts and commit manually:'));
    console.log(chalk.gray(`   git merge --no-ff ${result.branch}`));
    console.log(chalk.gray(`   # resolve conflicts`));
    console.log(chalk.gray(`   git commit -m "merge(worktree): ${name}"`));
  }
}

function handlePrune(options) {
  const maxAge = options.maxAge !== undefined ? parseInt(options.maxAge, 10) : 30;

  console.log(chalk.cyan(`Pruning worktrees (max age: ${maxAge} days)`));
  const result = pruneWorktrees({ maxAgeDays: maxAge });

  // Handle both old return format (array) and new format (object with pruned/skipped)
  const pruned = Array.isArray(result) ? result : result.pruned;
  const skipped = Array.isArray(result) ? [] : result.skipped || [];

  if (pruned.length === 0 && skipped.length === 0) {
    console.log(chalk.gray('Nothing to prune.'));
  } else {
    if (pruned.length > 0) {
      console.log(chalk.green(`Pruned ${pruned.length} worktree(s):`));
      for (const entry of pruned) {
        console.log(chalk.gray(`   - ${entry.name} (created ${entry.createdAt})`));
      }
    }
    if (skipped.length > 0) {
      console.log(chalk.yellow(`\nSkipped ${skipped.length} worktree(s) with recent activity:`));
      for (const { name: skName, reason } of skipped) {
        console.log(chalk.yellow(`   - ${skName}: ${reason}`));
      }
    }
  }
}

module.exports = { worktreeCommand };
