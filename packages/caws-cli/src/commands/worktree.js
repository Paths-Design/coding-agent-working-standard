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
  repairWorktrees,
  loadRegistry,
  saveRegistry,
  getRepoRoot,
  findFeatureSpecPath,
  autoActivateBoundSpec,
} = require('../worktree/worktree-manager');
const { getAgentSessionId } = require('../utils/agent-session');

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
      case 'repair':
        return handleRepair(options);
      case 'bind':
        return handleBind(options);
      default:
        console.error(chalk.red(`Unknown worktree subcommand: ${subcommand}`));
        console.log(chalk.blue('Available: create, list, destroy, merge, prune, repair, bind'));
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

  const maxNameLen = Math.max(18, ...entries.map((e) => e.name.length + 2));
  const maxBranchLen = Math.max(20, ...entries.map((e) => (e.branch || '').length + 2));
  const totalWidth = maxNameLen + 14 + maxBranchLen + 16 + 16;
  console.log(chalk.bold.cyan('CAWS Worktrees'));
  console.log(chalk.cyan('='.repeat(totalWidth)));
  console.log(
    chalk.bold(
      'Name'.padEnd(maxNameLen) +
        'Status'.padEnd(14) +
        'Branch'.padEnd(maxBranchLen) +
        'Last Commit'.padEnd(16) +
        'Session'
    )
  );
  console.log(chalk.gray('-'.repeat(totalWidth)));

  // Show current session for comparison
  const currentSession = getAgentSessionId(process.cwd());
  if (currentSession) {
    const shortCurrent = currentSession.length > 8 ? '...' + currentSession.slice(-8) : currentSession;
    console.log(chalk.gray(`You: ${shortCurrent}`));
    console.log(chalk.gray('-'.repeat(totalWidth)));
  }

  for (const entry of entries) {
    const statusColors = {
      active: chalk.green,
      fresh: chalk.cyan,
      merged: chalk.blue,
      destroyed: chalk.gray,
      missing: chalk.red,
      'stale-merged': chalk.yellow,
      orphaned: chalk.yellow,
      unregistered: chalk.yellow,
    };
    const statusColor = statusColors[entry.status] || chalk.white;

    // Build status string with dirty indicator
    let statusStr = entry.status;
    if (entry.dirty && (entry.status === 'active' || entry.status === 'fresh')) {
      statusStr += '*';
    }

    // Format last commit age
    let commitAge = chalk.gray('-');
    if (entry.lastCommit) {
      commitAge = chalk.white(entry.lastCommit.age);
    }

    // Format owner — show truncated session ID, highlight if it's the current session
    let ownerStr = chalk.gray('-');
    if (entry.owner) {
      const short = entry.owner.length > 8 ? '...' + entry.owner.slice(-8) : entry.owner;
      if (currentSession && entry.owner === currentSession) {
        ownerStr = chalk.green(short + ' (you)');
      } else {
        ownerStr = chalk.yellow(short);
      }
    }

    console.log(
      entry.name.padEnd(maxNameLen) +
        statusColor(statusStr.padEnd(14)) +
        (entry.branch || '').padEnd(maxBranchLen) +
        commitAge.padEnd(16 + 10) + // +10 for chalk color codes
        ownerStr
    );
  }

  // Legend
  console.log('');
  console.log(chalk.gray('Status: fresh = no commits yet, active = has commits/changes, active* = dirty files'));
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
  const force = options.force || false;

  console.log(chalk.cyan(`Pruning worktrees (max age: ${maxAge} days)`));
  const result = pruneWorktrees({ maxAgeDays: maxAge, force });

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


function handleRepair(options) {
  const dryRun = options.dryRun || false;
  const shouldPrune = options.prune || false;
  const force = options.force || false;

  if (dryRun) {
    console.log(chalk.cyan('Repair dry-run (no changes will be persisted)'));
  } else {
    console.log(chalk.cyan('Repairing worktree registry'));
  }

  const result = repairWorktrees({ prune: shouldPrune, dryRun, force });

  if (result.repaired.length === 0 && result.pruned.length === 0 && result.skipped.length === 0) {
    console.log(chalk.green('Registry is consistent. Nothing to repair.'));
    return;
  }

  if (result.repaired.length > 0) {
    console.log(chalk.green('\nRepaired ' + result.repaired.length + ' entry/entries:'));
    for (const r of result.repaired) {
      const ownerTag = r.owner ? chalk.yellow(` [owner: ${r.owner}]`) : '';
      if (r.action === 'registered') {
        console.log(chalk.gray('   + ' + r.name + ' (auto-registered from git)'));
      } else {
        console.log(chalk.gray('   ~ ' + r.name + ' (' + r.from + ' -> ' + r.to + ')') + ownerTag);
      }
    }
  }

  if (result.pruned.length > 0) {
    console.log(chalk.green('\nPruned ' + result.pruned.length + ' stale entry/entries:'));
    for (const p of result.pruned) {
      const ownerTag = p.owner ? chalk.yellow(` [owner: ${p.owner}]`) : '';
      console.log(chalk.gray('   - ' + p.name + ' (' + p.status + ')') + ownerTag);
    }
  }

  if (result.skipped.length > 0) {
    console.log(chalk.yellow('\nSkipped ' + result.skipped.length + ' entry/entries:'));
    for (const s of result.skipped) {
      console.log(chalk.yellow('   ? ' + s.name + ': ' + s.reason));
    }
  }

  if (dryRun) {
    console.log(chalk.blue('\nDry-run complete. Run without --dry-run to persist changes.'));
  }
}

function handleBind(options) {
  const path = require('path');
  const fs = require('fs-extra');
  const yaml = require('js-yaml');
  const { specId, name } = options;

  if (!specId) {
    console.error(chalk.red('Spec ID is required'));
    console.log(chalk.blue('Usage: caws worktree bind <spec-id> [--name <worktree-name>]'));
    process.exit(1);
  }

  // Determine worktree name: from option, or detect from cwd
  let worktreeName = name;
  if (!worktreeName) {
    const root = getRepoRoot();
    const cwd = process.cwd();
    const worktreesBase = path.join(root, '.caws', 'worktrees');

    if (cwd.startsWith(worktreesBase + path.sep)) {
      const relative = path.relative(worktreesBase, cwd);
      worktreeName = relative.split(path.sep)[0];
    }
  }

  if (!worktreeName) {
    console.error(chalk.red('Could not determine worktree name.'));
    console.log(chalk.blue('Either run this from inside a worktree, or pass --name <worktree-name>'));
    process.exit(1);
  }

  const root = getRepoRoot();
  const registry = loadRegistry(root);

  // Find the worktree entry in the registry
  if (!registry.worktrees || !registry.worktrees[worktreeName]) {
    console.error(chalk.red(`Worktree '${worktreeName}' not found in registry.`));
    console.log(chalk.blue('Run: caws worktree list  to see available worktrees'));
    process.exit(1);
  }

  // Load the spec file
  const specPath = findFeatureSpecPath(root, specId);
  if (!specPath) {
    console.error(chalk.red(`Spec '${specId}' not found in .caws/specs/`));
    console.log(chalk.blue('Run: caws specs list  to see available specs'));
    process.exit(1);
  }

  const specContent = fs.readFileSync(specPath, 'utf8');
  const specData = yaml.load(specContent);

  // Warn if spec already bound to a different worktree
  if (specData.worktree && specData.worktree !== worktreeName) {
    console.log(chalk.yellow(`Warning: Spec '${specId}' is currently bound to worktree '${specData.worktree}'.`));
    console.log(chalk.yellow(`Rebinding to '${worktreeName}'.`));
  }

  // Update registry side: set specId on the worktree entry
  registry.worktrees[worktreeName].specId = specId;
  saveRegistry(root, registry);

  // Update spec side: set worktree field
  specData.worktree = worktreeName;
  const updatedYaml = yaml.dump(specData, { lineWidth: 120, noRefs: true });
  fs.writeFileSync(specPath, updatedYaml, 'utf8');

  // CAWSFIX-23: activate the spec if it's still at draft — bind is the
  // lifecycle signal that work is starting.
  const activated = autoActivateBoundSpec(root, specId);

  console.log(chalk.green(`Binding established`));
  console.log(chalk.gray(`   Worktree: ${worktreeName} -> spec: ${specId}`));
  console.log(chalk.gray(`   Spec: ${specId} -> worktree: ${worktreeName}`));
  if (activated) {
    console.log(chalk.gray(`   Status: draft -> active`));
  }
  console.log(chalk.gray(`   Registry: ${path.join(root, '.caws', 'worktrees.json')}`));
  console.log(chalk.gray(`   Spec file: ${specPath}`));
}

module.exports = { worktreeCommand };
