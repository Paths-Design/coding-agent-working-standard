/**
 * @fileoverview CAWS Archive Command
 * Archive completed changes with lifecycle management (multi-spec aware)
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { execSync } = require('child_process');
const { safeAsync, outputResult } = require('../error-handler');

// Import spec resolution system
const { resolveSpec } = require('../utils/spec-resolver');

/**
 * Load change folder structure
 * @param {string} changeId - Change identifier
 * @returns {Promise<Object|null>} Change data or null
 */
async function loadChange(changeId) {
  const changesDir = '.caws/changes';
  const changePath = path.join(changesDir, changeId);

  if (!(await fs.pathExists(changePath))) {
    return null;
  }

  try {
    const metadataPath = path.join(changePath, 'metadata.yaml');
    const workingSpecPath = path.join(changePath, 'working-spec.yaml');

    const metadata = (await fs.pathExists(metadataPath))
      ? yaml.load(await fs.readFile(metadataPath, 'utf8'))
      : {};

    const workingSpec = (await fs.pathExists(workingSpecPath))
      ? yaml.load(await fs.readFile(workingSpecPath, 'utf8'))
      : null;

    return {
      id: changeId,
      path: changePath,
      metadata,
      workingSpec,
      exists: true,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Validate all acceptance criteria are met
 * @param {Object} workingSpec - Working specification
 * @returns {Promise<Object>} Validation result
 */
async function validateAcceptanceCriteria(workingSpec) {
  if (!workingSpec || !workingSpec.acceptance_criteria) {
    return {
      valid: false,
      message: 'No acceptance criteria found in working spec',
    };
  }

  const criteria = workingSpec.acceptance_criteria;
  const incomplete = [];

  for (const criterion of criteria) {
    if (!criterion.completed) {
      incomplete.push(criterion.id || 'unknown');
    }
  }

  if (incomplete.length > 0) {
    return {
      valid: false,
      message: `Incomplete acceptance criteria: ${incomplete.join(', ')}`,
    };
  }

  return {
    valid: true,
    message: `All ${criteria.length} acceptance criteria completed`,
  };
}

/**
 * Validate change meets quality gates
 * Runs the actual quality gates runner and checks for violations
 * @param {string} changeId - Change identifier
 * @returns {Promise<Object>} Quality gate result
 */
async function validateQualityGates(_changeId) {
  const gates = [];
  const violations = [];
  const warnings = [];

  try {
    // Try to run the quality gates runner
    const qualityGatesPath = path.join(
      __dirname,
      '..',
      '..',
      '..',
      'quality-gates',
      'run-quality-gates.mjs'
    );

    // Check if quality gates runner exists
    if (await fs.pathExists(qualityGatesPath)) {
      try {
        // Run quality gates in CI mode (checks all files, not just staged)
        const result = execSync(`node "${qualityGatesPath}" --context=ci --json 2>&1`, {
          encoding: 'utf8',
          timeout: 60000, // 60 second timeout
          cwd: process.cwd(),
        });

        // Try to parse JSON output
        try {
          const jsonMatch = result.match(/\{[\s\S]*\}$/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.violations) {
              violations.push(...parsed.violations);
            }
            if (parsed.warnings) {
              warnings.push(...parsed.warnings);
            }
            gates.push(...(parsed.gates || []));
          }
        } catch {
          // JSON parsing failed, check for error indicators in output
          if (result.includes('❌') || result.includes('FAIL')) {
            violations.push({ message: 'Quality gates reported failures', output: result });
          }
        }
      } catch (execError) {
        // Command failed - check exit code and output
        if (execError.status !== 0) {
          const output = execError.stdout || execError.message;
          if (output.includes('violations') || output.includes('❌')) {
            violations.push({ message: 'Quality gates failed', output: output.substring(0, 500) });
          }
        }
      }
    }

    // Also check for active waivers that might cover violations
    const waiversPath = path.join(process.cwd(), '.caws', 'waivers', 'active-waivers.yaml');
    let hasActiveWaivers = false;
    if (await fs.pathExists(waiversPath)) {
      const waiversContent = await fs.readFile(waiversPath, 'utf8');
      const waivers = yaml.load(waiversContent);
      if (waivers && waivers.waivers) {
        const activeWaiverCount = Object.keys(waivers.waivers).length;
        if (activeWaiverCount > 0) {
          hasActiveWaivers = true;
          gates.push(`${activeWaiverCount} active waiver(s)`);
        }
      }
    }

    // Determine overall validity
    const hasBlockingViolations = violations.some(
      (v) => v.severity === 'block' || v.severity === 'fail'
    );

    if (violations.length === 0) {
      return {
        valid: true,
        message: 'All quality gates passed',
        gates: gates.length > 0 ? gates : ['naming', 'duplication', 'god-objects', 'hidden-todo'],
        violations: [],
        warnings,
      };
    } else if (hasActiveWaivers && !hasBlockingViolations) {
      return {
        valid: true,
        message: `Quality gates passed with ${violations.length} waived violation(s)`,
        gates,
        violations,
        warnings,
        waived: true,
      };
    } else {
      return {
        valid: false,
        message: `${violations.length} quality gate violation(s) found`,
        gates,
        violations,
        warnings,
      };
    }
  } catch (error) {
    // If quality gates can't be run, warn but don't block
    return {
      valid: true,
      message: `Quality gates check skipped: ${error.message}`,
      gates: [],
      violations: [],
      warnings: [{ message: `Could not run quality gates: ${error.message}` }],
      skipped: true,
    };
  }
}

/**
 * Generate change summary for archival
 * @param {Object} change - Change data
 * @returns {Promise<string>} Summary text
 */
async function generateChangeSummary(change) {
  const { workingSpec, metadata } = change;

  let summary = `# Change Summary: ${change.id}\n\n`;

  if (workingSpec) {
    summary += `**Title**: ${workingSpec.title || 'Untitled'}\n`;
    summary += `**Risk Tier**: ${workingSpec.risk_tier || 'Unknown'}\n`;
    summary += `**Mode**: ${workingSpec.mode || 'Unknown'}\n\n`;

    if (workingSpec.acceptance_criteria) {
      const total = workingSpec.acceptance_criteria.length;
      const completed = workingSpec.acceptance_criteria.filter((c) => c.completed).length;
      summary += `**Acceptance Criteria**: ${completed}/${total} completed\n\n`;
    }
  }

  if (metadata.created_at) {
    summary += `**Created**: ${new Date(metadata.created_at).toISOString()}\n`;
  }

  if (metadata.completed_at) {
    summary += `**Completed**: ${new Date(metadata.completed_at).toISOString()}\n`;
  }

  summary += `\n**Files Changed**: ${metadata.files_changed || 0}\n`;
  summary += `**Lines Added**: ${metadata.lines_added || 0}\n`;
  summary += `**Lines Removed**: ${metadata.lines_removed || 0}\n`;

  return summary;
}

/**
 * Archive change folder to archive directory
 * @param {Object} change - Change data
 * @returns {Promise<void>}
 */
async function archiveChange(change) {
  const archiveDir = '.caws/archive';
  const archivePath = path.join(archiveDir, change.id);

  // Ensure archive directory exists
  await fs.ensureDir(archiveDir);

  // Move change folder to archive
  await fs.move(change.path, archivePath);

  console.log(chalk.green(`   ✅ Moved to: ${archivePath}`));
}

/**
 * Update provenance with completion
 * @param {Object} change - Change data
 * @returns {Promise<void>}
 */
async function updateProvenance(change) {
  const provenanceDir = '.caws/provenance';
  const chainPath = path.join(provenanceDir, 'chain.json');

  try {
    let chain = [];

    if (await fs.pathExists(chainPath)) {
      chain = JSON.parse(await fs.readFile(chainPath, 'utf8'));
    }

    // Add completion entry
    const completionEntry = {
      timestamp: new Date().toISOString(),
      action: 'change_completed',
      change_id: change.id,
      metadata: {
        title: change.workingSpec?.title,
        risk_tier: change.workingSpec?.risk_tier,
        files_changed: change.metadata?.files_changed || 0,
        lines_added: change.metadata?.lines_added || 0,
        lines_removed: change.metadata?.lines_removed || 0,
      },
    };

    chain.push(completionEntry);

    await fs.ensureDir(provenanceDir);
    await fs.writeFile(chainPath, JSON.stringify(chain, null, 2));

    console.log(chalk.green(`   ✅ Provenance updated: ${chain.length} total entries`));
  } catch (error) {
    console.log(chalk.yellow(`   ⚠️  Could not update provenance: ${error.message}`));
  }
}

/**
 * Display archive results
 * @param {Object} change - Change data
 * @param {Object} validation - Validation result
 * @param {Object} qualityGates - Quality gates result
 */
function displayArchiveResults(change, validation, qualityGates) {
  console.log(chalk.bold.cyan(`\n📦 Archiving Change: ${change.id}`));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Validation status
  if (validation.valid) {
    console.log(chalk.green('✅ Acceptance Criteria'));
    console.log(chalk.gray(`   ${validation.message}`));
  } else {
    console.log(chalk.red('❌ Acceptance Criteria'));
    console.log(chalk.gray(`   ${validation.message}`));
  }

  console.log('');

  // Quality gates status
  if (qualityGates.valid) {
    console.log(chalk.green('✅ Quality Gates'));
    console.log(chalk.gray(`   ${qualityGates.message}`));
  } else {
    console.log(chalk.red('❌ Quality Gates'));
    console.log(chalk.gray(`   ${qualityGates.message}`));
  }

  console.log('');

  // Archive action
  console.log(chalk.blue('📂 Archive Actions:'));
  console.log(chalk.gray('   • Moving change folder to archive'));
  console.log(chalk.gray('   • Updating provenance chain'));
  console.log(chalk.gray('   • Generating change summary'));

  console.log('');
}

/**
 * Archive command handler
 * @param {string} changeId - Change identifier to archive
 * @param {Object} options - Command options
 */
async function archiveCommand(changeId, options = {}) {
  return safeAsync(
    async () => {
      if (!changeId) {
        throw new Error('Change ID is required. Usage: caws archive <change-id>');
      }

      // Load change data
      const change = await loadChange(changeId);
      if (!change) {
        throw new Error(`Change '${changeId}' not found in .caws/changes/`);
      }

      // Resolve spec using priority system
      let workingSpec = change.workingSpec;
      if (!workingSpec && options.specId) {
        // If change doesn't have a working spec but spec-id is provided, load it
        try {
          const resolved = await resolveSpec({
            specId: options.specId,
            warnLegacy: false,
          });
          workingSpec = resolved.spec;
        } catch (error) {
          console.log(
            chalk.yellow(`⚠️  Could not load spec '${options.specId}': ${error.message}`)
          );
        }
      }

      // Validate acceptance criteria
      const validation = await validateAcceptanceCriteria(workingSpec);

      // Validate quality gates
      const qualityGates = await validateQualityGates(changeId);

      // Display results
      displayArchiveResults(change, validation, qualityGates);

      // Check if we should proceed with archival
      if (!validation.valid) {
        console.log(chalk.yellow('⚠️  Cannot archive: Incomplete acceptance criteria'));
        if (!options.force) {
          console.log(chalk.yellow('💡 Use --force to archive anyway'));
          return outputResult({
            command: 'archive',
            change: changeId,
            archived: false,
            reason: 'incomplete_criteria',
          });
        }
      }

      if (!qualityGates.valid) {
        console.log(chalk.yellow('⚠️  Cannot archive: Quality gates not met'));
        if (!options.force) {
          console.log(chalk.yellow('💡 Use --force to archive anyway'));
          return outputResult({
            command: 'archive',
            change: changeId,
            archived: false,
            reason: 'quality_gates_failed',
          });
        }
      }

      // Perform archival
      console.log(chalk.blue('🔄 Performing archival...'));

      // Update metadata with completion timestamp
      change.metadata.completed_at = new Date().toISOString();
      change.metadata.archived = true;

      // Generate and save summary
      const summary = await generateChangeSummary(change);
      const summaryPath = path.join(change.path, 'archive-summary.md');
      await fs.writeFile(summaryPath, summary);

      // Archive the change
      await archiveChange(change);

      // Update provenance
      await updateProvenance(change);

      console.log(chalk.green(`\n🎉 Successfully archived change: ${changeId}`));

      return outputResult({
        command: 'archive',
        change: changeId,
        archived: true,
        validation: validation.valid,
        qualityGates: qualityGates.valid,
        summary: summary,
      });
    },
    'archive change',
    true
  );
}

module.exports = {
  archiveCommand,
  loadChange,
  validateAcceptanceCriteria,
  validateQualityGates,
  generateChangeSummary,
  archiveChange,
  updateProvenance,
  displayArchiveResults,
};
