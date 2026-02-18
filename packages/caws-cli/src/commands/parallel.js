/**
 * @fileoverview CAWS Parallel CLI Command
 * Orchestrates parallel multi-agent workspaces
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const path = require('path');
const {
  loadPlan,
  setupParallel,
  getParallelStatus,
  mergeParallel,
  teardownParallel,
} = require('../parallel/parallel-manager');

/**
 * Handle parallel subcommands
 * @param {string} subcommand - Subcommand name
 * @param {Object} options - Command options
 */
async function parallelCommand(subcommand, options = {}) {
  try {
    switch (subcommand) {
      case 'setup':
        return handleSetup(options);
      case 'status':
        return handleStatus();
      case 'merge':
        return handleMerge(options);
      case 'teardown':
        return handleTeardown(options);
      default:
        console.error(chalk.red(`Unknown parallel subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: setup, status, merge, teardown'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`${error.message}`));
    process.exit(1);
  }
}

function handleSetup(options) {
  const { planFile, baseBranch } = options;

  if (!planFile) {
    console.error(chalk.red('Plan file is required'));
    console.log(chalk.blue('Usage: caws parallel setup <plan-file> [--base-branch <branch>]'));
    process.exit(1);
  }

  const planPath = path.resolve(planFile);
  console.log(chalk.cyan(`Loading plan: ${planFile}`));

  const plan = loadPlan(planPath);

  // Allow CLI --base-branch to override plan file
  if (baseBranch) {
    plan.baseBranch = baseBranch;
  }

  console.log(chalk.cyan(`Setting up ${plan.agents.length} parallel worktree(s)...`));
  const results = setupParallel(plan);

  console.log(chalk.green(`\nParallel workspace created`));
  console.log(chalk.gray(`   Base branch: ${results[0] ? results[0].baseBranch : plan.baseBranch || 'main'}`));
  console.log(chalk.gray(`   Strategy:    ${plan.mergeStrategy}`));
  console.log('');

  // Print table
  console.log(
    chalk.bold(
      'Agent'.padEnd(20) +
        'Branch'.padEnd(25) +
        'Scope'
    )
  );
  console.log(chalk.gray('-'.repeat(70)));

  for (const entry of results) {
    console.log(
      entry.name.padEnd(20) +
        chalk.cyan(entry.branch.padEnd(25)) +
        chalk.gray(entry.scope || '(all)')
    );
  }

  console.log('');
  console.log(chalk.blue('Direct each agent to its worktree:'));
  for (const entry of results) {
    console.log(chalk.gray(`   ${entry.name}: cd ${entry.path}`));
  }
  console.log('');
  console.log(chalk.blue('Monitor progress: caws parallel status'));
}

function handleStatus() {
  const status = getParallelStatus();

  if (!status) {
    console.log(chalk.gray('No active parallel run.'));
    console.log(chalk.blue('Start one with: caws parallel setup <plan-file>'));
    return;
  }

  console.log(chalk.bold.cyan('CAWS Parallel Status'));
  console.log(chalk.cyan('='.repeat(70)));
  console.log(chalk.gray(`   Base branch: ${status.baseBranch}`));
  console.log(chalk.gray(`   Strategy:    ${status.mergeStrategy}`));
  console.log(chalk.gray(`   Created:     ${status.createdAt}`));
  console.log('');

  // Agent table
  console.log(
    chalk.bold(
      'Agent'.padEnd(18) +
        'Status'.padEnd(10) +
        'Branch'.padEnd(22) +
        'Commits'.padEnd(9) +
        'Dirty'.padEnd(7) +
        'Scope'
    )
  );
  console.log(chalk.gray('-'.repeat(80)));

  for (const agent of status.agents) {
    const statusColor =
      agent.status === 'active'
        ? chalk.green
        : agent.status === 'missing'
        ? chalk.red
        : chalk.yellow;

    console.log(
      agent.name.padEnd(18) +
        statusColor(agent.status.padEnd(10)) +
        agent.branch.padEnd(22) +
        String(agent.commitCount).padEnd(9) +
        (agent.dirty ? chalk.yellow('yes') : chalk.gray('no')).padEnd(7 + 10) + // +10 for chalk color codes
        chalk.gray(agent.scope || '(all)')
    );
  }

  // Show conflicts
  if (status.conflicts.length > 0) {
    console.log('');
    console.log(chalk.yellow(`WARNING: ${status.conflicts.length} file-level conflict(s) detected:`));
    for (const conflict of status.conflicts) {
      console.log(chalk.yellow(`   ${conflict.file} -- modified by: ${conflict.agents.join(', ')}`));
    }
    console.log(chalk.blue('   These files were modified by multiple agents and may cause merge conflicts.'));
  }

  console.log('');
}

function handleMerge(options) {
  const { strategy, dryRun, force } = options;

  if (dryRun) {
    console.log(chalk.cyan('Dry run: previewing merge...'));
  } else {
    console.log(chalk.cyan('Merging parallel branches back to base...'));
  }

  const result = mergeParallel({ strategy, dryRun, force });

  // Show conflicts
  if (result.conflicts.length > 0) {
    console.log(chalk.yellow(`\n${result.conflicts.length} file-level conflict(s) detected:`));
    for (const conflict of result.conflicts) {
      console.log(chalk.yellow(`   ${conflict.file} -- ${conflict.agents.join(', ')}`));
    }

    if (!force && !dryRun) {
      console.log('');
      console.log(chalk.red('Merge aborted due to conflicts.'));
      console.log(chalk.blue('   Review conflicts, then: caws parallel merge --force'));
      return;
    }
  }

  if (dryRun) {
    console.log(chalk.green(`\nWould merge ${result.merged.length} branch(es):`));
    for (const name of result.merged) {
      console.log(chalk.gray(`   - ${name}`));
    }
    return;
  }

  if (result.merged.length > 0) {
    console.log(chalk.green(`\nMerged ${result.merged.length} branch(es):`));
    for (const name of result.merged) {
      console.log(chalk.gray(`   - ${name}`));
    }
  }

  if (result.failed.length > 0) {
    console.log(chalk.red(`\nFailed to merge ${result.failed.length} branch(es):`));
    for (const fail of result.failed) {
      console.log(chalk.red(`   - ${fail.name}: ${fail.error}`));
    }
  }

  if (result.merged.length > 0 && result.failed.length === 0) {
    console.log('');
    console.log(chalk.blue('Clean up with: caws parallel teardown --delete-branches'));
  }
}

function handleTeardown(options) {
  const { deleteBranches, force } = options;

  console.log(chalk.cyan('Tearing down parallel worktrees...'));
  const result = teardownParallel({ deleteBranches, force });

  if (result.destroyed.length > 0) {
    console.log(chalk.green(`Destroyed ${result.destroyed.length} worktree(s):`));
    for (const name of result.destroyed) {
      console.log(chalk.gray(`   - ${name}`));
    }
  }

  if (result.failed.length > 0) {
    console.log(chalk.red(`Failed to destroy ${result.failed.length} worktree(s):`));
    for (const fail of result.failed) {
      console.log(chalk.red(`   - ${fail.name}: ${fail.error}`));
    }
    console.log(chalk.blue('   Use --force to override'));
  }

  if (deleteBranches) {
    console.log(chalk.gray('   Branches also deleted'));
  }
}

module.exports = { parallelCommand };
