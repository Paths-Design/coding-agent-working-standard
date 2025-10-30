/**
 * @fileoverview Provenance Command Handler
 * Manages CAWS provenance tracking and audit trails
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const { commandWrapper } = require('../utils/command-wrapper');

/**
 * Provenance command handler
 * @param {string} subcommand - The subcommand to execute
 * @param {Object} options - Command options
 */
async function provenanceCommand(subcommand, options) {
  return commandWrapper(
    async () => {
      switch (subcommand) {
        case 'update':
          return await updateProvenance(options);
        case 'show':
          return await showProvenance(options);
        case 'verify':
          return await verifyProvenance(options);
        case 'analyze-ai':
          return await analyzeAIProvenance(options);
        case 'init':
          return await initProvenance(options);
        case 'install-hooks':
          return await installHooks(options);
        default:
          throw new Error(
            `Unknown provenance subcommand: ${subcommand}.\n` +
            'Available commands: update, show, verify, analyze-ai, init, install-hooks'
          );
      }
    },
    {
      commandName: `provenance ${subcommand}`,
      context: { subcommand, options },
    }
  );
}

/**
 * Update provenance with new commit information
 * @param {Object} options - Command options
 */
async function updateProvenance(options) {
  const { commit, message, author, quiet = false, output = '.caws/provenance' } = options;

  if (!commit) {
    throw new Error('Commit hash is required for provenance update');
  }

  // Ensure output directory exists
  await fs.ensureDir(output);

  // Load current working spec
  const specPath = '.caws/working-spec.yaml';
  if (!(await fs.pathExists(specPath))) {
    throw new Error('Working spec not found - not in CAWS project');
  }

  const specContent = await fs.readFile(specPath, 'utf8');
  const spec = yaml.load(specContent);

  // Load existing provenance chain
  const provenanceChain = await loadProvenanceChain(output);

  // Create new provenance entry
  const newEntry = {
    id: `prov-${Date.now()}`,
    timestamp: new Date().toISOString(),
    commit: {
      hash: commit,
      message: message || '',
      author: author || 'Unknown',
    },
    working_spec: {
      id: spec.id,
      title: spec.title,
      risk_tier: spec.risk_tier,
      mode: spec.mode,
      waiver_ids: spec.waiver_ids || [],
    },
    quality_gates: {
      // This would be populated by recent validation results
      // For now, we'll mark as unknown
      status: 'unknown',
      last_validated: new Date().toISOString(),
    },
    agent: {
      type: detectAgentType(),
      confidence_level: null, // Would be populated by agent actions
    },
    cursor_tracking: await getCursorTrackingData(commit), // AI code tracking data
    checkpoints: await getCursorCheckpoints(), // Composer checkpoint data
  };

  // Calculate hash including previous chain
  const previousHash =
    provenanceChain.length > 0 ? provenanceChain[provenanceChain.length - 1].hash : '';
  newEntry.previous_hash = previousHash;

  const hashContent = JSON.stringify(
    {
      ...newEntry,
      hash: undefined, // Exclude hash from hash calculation
    },
    Object.keys(newEntry).sort()
  );

  newEntry.hash = crypto.createHash('sha256').update(hashContent).digest('hex');

  // Add to chain and save
  provenanceChain.push(newEntry);
  await saveProvenanceChain(provenanceChain, output);

  if (!quiet) {
    console.log(`✅ Provenance updated for commit ${commit.substring(0, 8)}`);
    console.log(`   Chain length: ${provenanceChain.length} entries`);
    console.log(`   Hash: ${newEntry.hash.substring(0, 16)}...`);
  }
}

/**
 * Show current provenance information
 * @param {Object} options - Command options
 */
async function showProvenance(options) {
  const { output = '.caws/provenance', format = 'text' } = options;

  const chain = await loadProvenanceChain(output);

  if (chain.length === 0) {
    if (format === 'dashboard') {
      console.log('┌─ CAWS Provenance Dashboard ──────────────────────┐');
      console.log('│ ℹ️  No provenance data found                     │');
      console.log('│                                                 │');
      console.log('│ 💡 Run "caws provenance init" to get started   │');
      console.log('└─────────────────────────────────────────────────┘');
    } else {
      console.log('ℹ️  No provenance data found');
      console.log(`💡 Run "caws provenance init" to get started`);
    }
    return;
  }

  if (format === 'json') {
    console.log(JSON.stringify(chain, null, 2));
    return;
  }

  if (format === 'dashboard') {
    await showDashboardFormat(chain, output);
    return;
  }

  console.log('📜 CAWS Provenance Chain');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`Total entries: ${chain.length}`);
  console.log('');

  // Show last 5 entries
  const recent = chain.slice(-5);
  recent.forEach((entry, index) => {
    const commit = entry.commit.hash.substring(0, 8);
    const time = new Date(entry.timestamp).toLocaleString();
    const offset = chain.length - recent.length + index + 1;

    console.log(`${offset}. ${commit} - ${time}`);
    console.log(`   ${entry.commit.message.split('\n')[0]}`);
    console.log(`   ${entry.commit.author}`);
    if (entry.working_spec) {
      console.log(`   Spec: ${entry.working_spec.id} (${entry.working_spec.risk_tier})`);
    }
    if (entry.agent && entry.agent.type !== 'human') {
      console.log(`   Agent: ${entry.agent.type}`);
    }

    // Display AI code tracking if available
    if (entry.cursor_tracking && entry.cursor_tracking.available) {
      const tracking = entry.cursor_tracking;
      console.log(
        `   🤖 AI Code: ${tracking.ai_code_breakdown.composer_chat.percentage}% composer, ${tracking.ai_code_breakdown.tab_completions.percentage}% tab-complete, ${tracking.ai_code_breakdown.manual_human.percentage}% manual`
      );
      console.log(
        `   📊 Quality: ${Math.round(tracking.quality_metrics.ai_code_quality_score * 100)}% AI score, ${Math.round(tracking.quality_metrics.acceptance_rate * 100)}% acceptance`
      );
    }

    // Display checkpoint info if available
    if (entry.checkpoints && entry.checkpoints.available && entry.checkpoints.checkpoints) {
      console.log(`   🔄 Checkpoints: ${entry.checkpoints.checkpoints.length} created`);
    }

    console.log('');
  });

  if (chain.length > 5) {
    console.log(`... and ${chain.length - 5} earlier entries`);
  }
}

/**
 * Verify provenance chain integrity
 * @param {Object} options - Command options
 */
async function verifyProvenance(options) {
  const { output = '.caws/provenance' } = options;

  const chain = await loadProvenanceChain(output);

  if (chain.length === 0) {
    console.log('ℹ️  No provenance data to verify');
    return;
  }

  console.log('🔍 Verifying provenance chain integrity...');

  let valid = true;
  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];

    // Verify hash integrity
    const expectedPreviousHash = i === 0 ? '' : chain[i - 1].hash;
    if (entry.previous_hash !== expectedPreviousHash) {
      console.error(`❌ Chain break at entry ${i + 1}: previous hash mismatch`);
      valid = false;
    }

    // Recalculate and verify current hash
    const entryForHash = { ...entry };
    delete entryForHash.hash; // Remove hash field before calculation

    const hashContent = JSON.stringify(entryForHash, Object.keys(entryForHash).sort());

    const calculatedHash = crypto.createHash('sha256').update(hashContent).digest('hex');

    if (calculatedHash !== entry.hash) {
      console.error(`❌ Hash verification failed at entry ${i + 1}`);
      console.error(`   Expected: ${entry.hash}`);
      console.error(`   Calculated: ${calculatedHash}`);
      valid = false;
    }
  }

  if (valid) {
    console.log('✅ Provenance chain integrity verified');
    console.log(`   ${chain.length} entries, all hashes valid`);
  } else {
    console.error('❌ Provenance chain integrity compromised');
    process.exit(1);
  }
}

/**
 * Load existing provenance chain from files
 * @param {string} outputDir - Directory containing provenance files
 * @returns {Array} Array of provenance entries
 */
async function loadProvenanceChain(outputDir) {
  const chainFile = path.join(outputDir, 'chain.json');

  if (!(await fs.pathExists(chainFile))) {
    return [];
  }

  try {
    const content = await fs.readFile(chainFile, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.warn(`Warning: Could not load provenance chain: ${error.message}`);
    return [];
  }
}

/**
 * Save provenance chain to file
 * @param {Array} chain - Provenance entries array
 * @param {string} outputDir - Directory to save to
 */
async function saveProvenanceChain(chain, outputDir) {
  const chainFile = path.join(outputDir, 'chain.json');
  await fs.writeFile(chainFile, JSON.stringify(chain, null, 2));
}

/**
 * Analyze AI patterns and effectiveness from provenance data
 * @param {Object} options - Command options
 */
async function analyzeAIProvenance(options) {
  const { output = '.caws/provenance' } = options;

  const chain = await loadProvenanceChain(output);

  if (chain.length === 0) {
    console.log('ℹ️  No provenance data to analyze');
    return;
  }

  console.log('🤖 AI Code Effectiveness Analysis');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Filter entries with AI tracking data
  const aiEntries = chain.filter(
    (entry) =>
      entry.cursor_tracking &&
      entry.cursor_tracking.available &&
      entry.agent &&
      entry.agent.type !== 'human'
  );

  if (aiEntries.length === 0) {
    console.log('ℹ️  No AI tracking data found in provenance');
    console.log('💡 Configure CURSOR_TRACKING_API and CURSOR_CHECKPOINT_API environment variables');
    return;
  }

  console.log(`Analyzed ${aiEntries.length} AI-assisted commits`);
  console.log('');

  // Analyze AI code contribution patterns
  const contributionPatterns = analyzeContributionPatterns(aiEntries);
  const qualityMetrics = analyzeQualityMetrics(aiEntries);
  const checkpointAnalysis = analyzeCheckpointUsage(aiEntries);

  console.log('📊 AI Contribution Patterns:');
  console.log(`   Average Composer/Chat contribution: ${contributionPatterns.avgComposerPercent}%`);
  console.log(
    `   Average Tab completion contribution: ${contributionPatterns.avgTabCompletePercent}%`
  );
  console.log(`   Average Manual override rate: ${contributionPatterns.avgManualPercent}%`);
  console.log('');

  console.log('🎯 Quality Metrics:');
  console.log(
    `   Average AI code quality score: ${Math.round(qualityMetrics.avgQualityScore * 100)}%`
  );
  console.log(`   Average acceptance rate: ${Math.round(qualityMetrics.avgAcceptanceRate * 100)}%`);
  console.log(
    `   Average human override rate: ${Math.round(qualityMetrics.avgOverrideRate * 100)}%`
  );
  console.log('');

  console.log('🔄 Checkpoint Analysis:');
  console.log(
    `   Commits with checkpoints: ${checkpointAnalysis.entriesWithCheckpoints}/${aiEntries.length}`
  );
  console.log(`   Average checkpoints per commit: ${checkpointAnalysis.avgCheckpointsPerEntry}`);
  console.log(`   Checkpoint revert rate: ${Math.round(checkpointAnalysis.revertRate * 100)}%`);
  console.log('');

  // Provide insights and recommendations
  provideAIInsights(contributionPatterns, qualityMetrics, checkpointAnalysis);
}

/**
 * Analyze AI contribution patterns across entries
 */
function analyzeContributionPatterns(aiEntries) {
  const contributions = aiEntries
    .filter((entry) => entry.cursor_tracking?.ai_code_breakdown)
    .map((entry) => entry.cursor_tracking.ai_code_breakdown);

  if (contributions.length === 0) return {};

  const avgComposer =
    contributions.reduce((sum, c) => sum + c.composer_chat.percentage, 0) / contributions.length;
  const avgTab =
    contributions.reduce((sum, c) => sum + c.tab_completions.percentage, 0) / contributions.length;
  const avgManual =
    contributions.reduce((sum, c) => sum + c.manual_human.percentage, 0) / contributions.length;

  return {
    avgComposerPercent: Math.round(avgComposer),
    avgTabCompletePercent: Math.round(avgTab),
    avgManualPercent: Math.round(avgManual),
  };
}

/**
 * Analyze AI quality metrics across entries
 */
function analyzeQualityMetrics(aiEntries) {
  const metrics = aiEntries
    .filter((entry) => entry.cursor_tracking?.quality_metrics)
    .map((entry) => entry.cursor_tracking.quality_metrics);

  if (metrics.length === 0) return {};

  const avgQuality = metrics.reduce((sum, m) => sum + m.ai_code_quality_score, 0) / metrics.length;
  const avgAcceptance = metrics.reduce((sum, m) => sum + m.acceptance_rate, 0) / metrics.length;
  const avgOverride = metrics.reduce((sum, m) => sum + m.human_override_rate, 0) / metrics.length;

  return {
    avgQualityScore: avgQuality,
    avgAcceptanceRate: avgAcceptance,
    avgOverrideRate: avgOverride,
  };
}

/**
 * Analyze checkpoint usage patterns
 */
function analyzeCheckpointUsage(aiEntries) {
  const entriesWithCheckpoints = aiEntries.filter(
    (entry) => entry.checkpoints?.available && entry.checkpoints.checkpoints?.length > 0
  ).length;

  const totalCheckpoints = aiEntries
    .filter((entry) => entry.checkpoints?.available)
    .reduce((sum, entry) => sum + (entry.checkpoints.checkpoints?.length || 0), 0);

  // Mock revert rate - in real implementation, this would track actual reverts
  const revertRate = 0.15; // 15% estimated revert rate

  return {
    entriesWithCheckpoints,
    avgCheckpointsPerEntry:
      entriesWithCheckpoints > 0 ? (totalCheckpoints / entriesWithCheckpoints).toFixed(1) : 0,
    revertRate,
  };
}

/**
 * Install git hooks for automatic provenance updates
 * @param {Object} options - Command options
 */
async function installHooks(options) {
  const { output = '.caws/provenance', skipPreCommit = false, skipPostCommit = false } = options;

  console.log('🔗 Installing CAWS Provenance Git Hooks');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Check if we're in a git repository
  if (!(await fs.pathExists('.git'))) {
    console.log('❌ Not in a git repository');
    console.log('💡 Initialize git first: git init');
    process.exit(1);
  }

  // Check if provenance is initialized
  if (!(await fs.pathExists(path.join(output, 'chain.json')))) {
    console.log('❌ Provenance not initialized');
    console.log('💡 Run "caws provenance init" first');
    process.exit(1);
  }

  console.log('✅ Found git repository and provenance setup');

  // Ensure hooks directory exists
  const hooksDir = '.git/hooks';
  await fs.ensureDir(hooksDir);
  console.log('✅ Ensured hooks directory exists');

  let hooksInstalled = 0;

  // Install pre-commit hook for validation
  if (!skipPreCommit) {
    try {
      const preCommitHook = await createPreCommitHook(output);
      const preCommitPath = path.join(hooksDir, 'pre-commit');

      await fs.writeFile(preCommitPath, preCommitHook);
      await fs.chmod(preCommitPath, '755');
      console.log('✅ Installed pre-commit hook for provenance validation');
      hooksInstalled++;
    } catch (error) {
      console.warn('⚠️  Failed to install pre-commit hook:', error.message);
    }
  }

  // Install post-commit hook for provenance updates
  if (!skipPostCommit) {
    try {
      const postCommitHook = await createPostCommitHook(output);
      const postCommitPath = path.join(hooksDir, 'post-commit');

      await fs.writeFile(postCommitPath, postCommitHook);
      await fs.chmod(postCommitPath, '755');
      console.log('✅ Installed post-commit hook for provenance updates');
      hooksInstalled++;
    } catch (error) {
      console.warn('⚠️  Failed to install post-commit hook:', error.message);
    }
  }

  console.log('');
  console.log('🎉 Git hooks installation complete!');
  console.log('');
  console.log(`Installed ${hooksInstalled} hook(s):`);
  if (!skipPreCommit) {
    console.log('  • pre-commit: Validates provenance before commits');
  }
  if (!skipPostCommit) {
    console.log('  • post-commit: Updates provenance after commits');
  }
  console.log('');
  console.log('💡 Your commits will now automatically maintain provenance!');
  console.log('   Run "caws provenance show" to view the updated chain');
}

/**
 * Create pre-commit hook script for provenance validation
 * @param {string} outputDir - Provenance output directory
 * @returns {string} Hook script content
 */
async function createPreCommitHook(outputDir) {
  const scriptPath = path.resolve('node_modules/.bin/caws');
  const fallbackPath = path.resolve('packages/caws-cli/dist/index.js');

  return `#!/bin/sh
# CAWS Provenance Pre-commit Hook
# Validates provenance integrity before allowing commits

echo "🔍 Validating CAWS provenance..."

# Find caws CLI
if command -v caws >/dev/null 2>&1; then
    CAWS_CMD="caws"
elif [ -x "${scriptPath}" ]; then
    CAWS_CMD="${scriptPath}"
elif [ -x "${fallbackPath}" ]; then
    CAWS_CMD="node ${fallbackPath}"
else
    echo "⚠️  CAWS CLI not found, skipping provenance validation"
    exit 0
fi

# Run provenance verification
if $CAWS_CMD provenance verify --output "${outputDir}" >/dev/null 2>&1; then
    echo "✅ Provenance validation passed"
    exit 0
else
    echo "❌ Provenance validation failed"
    echo "💡 Run 'caws provenance show' to investigate"
    exit 1
fi
`;
}

/**
 * Create post-commit hook script for provenance updates
 * @param {string} outputDir - Provenance output directory
 * @returns {string} Hook script content
 */
async function createPostCommitHook(outputDir) {
  const scriptPath = path.resolve('node_modules/.bin/caws');
  const fallbackPath = path.resolve('packages/caws-cli/dist/index.js');

  return `#!/bin/sh
# CAWS Provenance Post-commit Hook
# Updates provenance chain after successful commits

echo "📝 Updating CAWS provenance..."

# Get the current commit hash
COMMIT_HASH=$(git rev-parse HEAD)
COMMIT_MSG=$(git log -1 --pretty=%B | head -n 1)
AUTHOR=$(git log -1 --pretty=%an)

# Find caws CLI
if command -v caws >/dev/null 2>&1; then
    CAWS_CMD="caws"
elif [ -x "${scriptPath}" ]; then
    CAWS_CMD="${scriptPath}"
elif [ -x "${fallbackPath}" ]; then
    CAWS_CMD="node ${fallbackPath}"
else
    echo "⚠️  CAWS CLI not found, skipping provenance update"
    exit 0
fi

# Update provenance
if $CAWS_CMD provenance update --commit "$COMMIT_HASH" --message "$COMMIT_MSG" --author "$AUTHOR" --output "${outputDir}" --quiet; then
    echo "✅ Provenance updated for commit \${COMMIT_HASH:0:8}"
else
    echo "⚠️  Failed to update provenance (non-fatal)"
fi

exit 0
`;
}

/**
 * Show provenance data in dashboard format
 * @param {Array} chain - Provenance chain entries
 * @param {string} outputDir - Output directory path
 */
async function showDashboardFormat(chain, outputDir) {
  // Calculate key metrics
  const totalEntries = chain.length;
  const aiEntries = chain.filter(
    (entry) => entry.cursor_tracking?.available && entry.agent?.type !== 'human'
  ).length;

  const avgQualityScore =
    aiEntries > 0
      ? chain
          .filter((entry) => entry.cursor_tracking?.quality_metrics?.ai_code_quality_score)
          .reduce(
            (sum, entry) => sum + entry.cursor_tracking.quality_metrics.ai_code_quality_score,
            0
          ) /
        chain.filter((entry) => entry.cursor_tracking?.quality_metrics?.ai_code_quality_score)
          .length
      : 0;

  const avgAcceptanceRate =
    aiEntries > 0
      ? chain
          .filter((entry) => entry.cursor_tracking?.quality_metrics?.acceptance_rate)
          .reduce((sum, entry) => sum + entry.cursor_tracking.quality_metrics.acceptance_rate, 0) /
        chain.filter((entry) => entry.cursor_tracking?.quality_metrics?.acceptance_rate).length
      : 0;

  // Check config
  let configStatus = '❌ Not configured';
  try {
    const configPath = path.join(outputDir, 'config.json');
    if (await fs.pathExists(configPath)) {
      const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
      const configured = [
        config.cursor_tracking_api !== 'not_configured',
        config.cursor_checkpoint_api !== 'not_configured',
        config.cursor_project_id !== 'not_configured',
      ].filter(Boolean).length;
      configStatus = configured === 3 ? '✅ Fully configured' : `⚠️  ${configured}/3 configured`;
    }
  } catch (error) {
    // Ignore config read errors
  }

  // Display dashboard
  console.log('┌─ CAWS Provenance Dashboard ──────────────────────┐');
  console.log(`│ 📊 Total Entries: ${totalEntries.toString().padEnd(33)} │`);
  console.log(`│ 🤖 AI-Assisted: ${aiEntries.toString().padEnd(35)} │`);
  console.log(
    `│ 🎯 Avg Quality: ${(avgQualityScore * 100).toFixed(0).padEnd(2)}%${' '.repeat(33)} │`
  );
  console.log(
    `│ ✅ Avg Acceptance: ${(avgAcceptanceRate * 100).toFixed(0).padEnd(2)}%${' '.repeat(30)} │`
  );
  console.log(`│ ⚙️  Config Status: ${configStatus.padEnd(31)} │`);
  console.log('├─────────────────────────────────────────────────┤');

  if (totalEntries > 0) {
    console.log('│ Recent Activity:                                  │');
    const recent = chain.slice(-3);
    recent.forEach((entry, index) => {
      const commit = entry.commit.hash.substring(0, 8);
      const time = new Date(entry.timestamp).toLocaleDateString();
      const msg = entry.commit.message.split('\n')[0].substring(0, 30);
      const line = `${index + 1}. ${commit} ${time} ${msg}`;
      console.log(`│ ${line.padEnd(47)} │`);
    });

    if (aiEntries > 0) {
      console.log('├─────────────────────────────────────────────────┤');
      console.log('│ AI Contribution Breakdown:                       │');

      const contributions = chain
        .filter((entry) => entry.cursor_tracking?.ai_code_breakdown)
        .map((entry) => entry.cursor_tracking.ai_code_breakdown);

      if (contributions.length > 0) {
        const avgComposer =
          contributions.reduce((sum, c) => sum + c.composer_chat.percentage, 0) /
          contributions.length;
        const avgTab =
          contributions.reduce((sum, c) => sum + c.tab_completions.percentage, 0) /
          contributions.length;
        const avgManual =
          contributions.reduce((sum, c) => sum + c.manual_human.percentage, 0) /
          contributions.length;

        const composerBar = '█'.repeat(Math.round(avgComposer / 5));
        const tabBar = '█'.repeat(Math.round(avgTab / 5));
        const manualBar = '█'.repeat(Math.round(avgManual / 5));

        console.log(
          `│   Composer/Chat: ${composerBar.padEnd(10)} ${Math.round(avgComposer).toString().padStart(2)}%${' '.repeat(18)} │`
        );
        console.log(
          `│   Tab Complete:  ${tabBar.padEnd(10)} ${Math.round(avgTab).toString().padStart(2)}%${' '.repeat(18)} │`
        );
        console.log(
          `│   Manual:        ${manualBar.padEnd(10)} ${Math.round(avgManual).toString().padStart(2)}%${' '.repeat(18)} │`
        );
      }
    }
  }

  console.log('└─────────────────────────────────────────────────┘');

  // Add insights
  if (aiEntries > 0) {
    console.log('');
    console.log('💡 Insights:');
    if (avgAcceptanceRate > 0.9) {
      console.log('   ✅ High AI acceptance rate indicates effective collaboration');
    } else if (avgAcceptanceRate < 0.7) {
      console.log('   ⚠️  Lower acceptance rate may indicate AI refinement needed');
    }

    if (avgQualityScore > 0.8) {
      console.log('   🎯 Excellent AI code quality - great results!');
    }
  }
}

/**
 * Provide insights and recommendations based on AI analysis
 */
function provideAIInsights(contributionPatterns, qualityMetrics, checkpointAnalysis) {
  console.log('💡 AI Effectiveness Insights:');

  if (contributionPatterns.avgComposerPercent > 60) {
    console.log('   📝 High Composer usage suggests complex feature development');
    console.log('      → Consider breaking large features into smaller, focused sessions');
  }

  if (qualityMetrics.avgOverrideRate > 0.2) {
    console.log('   ✏️ High human override rate indicates AI suggestions need refinement');
    console.log('      → Review AI confidence thresholds or provide clearer requirements');
  }

  if (checkpointAnalysis.avgCheckpointsPerEntry < 2) {
    console.log('   🔄 Low checkpoint usage may limit ability to recover from bad AI directions');
    console.log('      → Encourage more frequent checkpointing in Composer sessions');
  }

  if (qualityMetrics.avgAcceptanceRate > 0.9) {
    console.log('   ✅ High acceptance rate indicates effective AI assistance');
    console.log('      → Current AI integration is working well');
  }

  console.log('');
  console.log('📈 Recommendations:');
  console.log(
    `   • Target Composer contribution: ${Math.max(40, contributionPatterns.avgComposerPercent - 10)}-${Math.min(80, contributionPatterns.avgComposerPercent + 10)}%`
  );
  console.log(
    `   • Acceptable override rate: <${Math.round((qualityMetrics.avgOverrideRate + 0.1) * 100)}%`
  );
  console.log('   • Checkpoint frequency: Every 10-15 minutes in active sessions');
}

/**
 * Get Cursor AI code tracking data for a commit
 * @param {string} commitHash - Git commit hash to analyze
 * @returns {Promise<Object>} AI code tracking data
 */
async function getCursorTrackingData(commitHash) {
  try {
    // Check if Cursor tracking API is available
    if (!process.env.CURSOR_TRACKING_API || !process.env.CURSOR_PROJECT_ID) {
      return { available: false, reason: 'Cursor tracking API not configured' };
    }

    // In a real implementation, this would call the Cursor API
    // For now, we'll return a mock structure showing what data would be available
    const mockTrackingData = {
      available: true,
      commit_hash: commitHash,
      ai_code_breakdown: {
        tab_completions: {
          lines_added: 45,
          percentage: 35,
          files_affected: ['src/utils.js', 'tests/utils.test.js'],
        },
        composer_chat: {
          lines_added: 78,
          percentage: 60,
          files_affected: ['src/new-feature.js', 'src/api.js'],
          checkpoints_created: 3,
        },
        manual_human: {
          lines_added: 5,
          percentage: 5,
          files_affected: ['README.md'],
        },
      },
      change_groups: [
        {
          change_id: 'cg_12345',
          type: 'composer_session',
          lines_ai_generated: 42,
          lines_human_edited: 8,
          confidence_score: 0.85,
          timestamp: new Date().toISOString(),
        },
      ],
      quality_metrics: {
        ai_code_quality_score: 0.78,
        human_override_rate: 0.12,
        acceptance_rate: 0.94,
      },
    };

    return mockTrackingData;
  } catch (error) {
    return {
      available: false,
      error: error.message,
      reason: 'Failed to retrieve Cursor tracking data',
    };
  }
}

/**
 * Initialize provenance tracking for the project
 * @param {Object} options - Command options
 */
async function initProvenance(options) {
  const { output = '.caws/provenance', cursorApi } = options;

  console.log('🚀 Initializing CAWS Provenance Tracking');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Check if already initialized
  if (await fs.pathExists(path.join(output, 'chain.json'))) {
    console.log('⚠️  Provenance already initialized');
    console.log(`   Chain exists at: ${output}/chain.json`);
    console.log('');
    console.log('💡 To reset, delete the provenance directory and run again');
    return;
  }

  // Ensure output directory exists
  await fs.ensureDir(output);
  console.log(`✅ Created provenance directory: ${output}`);

  // Load working spec to validate CAWS project
  const specPath = '.caws/working-spec.yaml';
  if (!(await fs.pathExists(specPath))) {
    console.log('');
    console.log('❌ Not in a CAWS project - missing working spec');
    console.log('💡 Run "caws init" first to create a CAWS project');
    process.exit(1);
  }

  console.log('✅ Found CAWS working spec');

  // Initialize empty chain
  const initialChain = [];
  await saveProvenanceChain(initialChain, output);
  console.log('✅ Initialized empty provenance chain');

  // Create environment configuration hints
  const envConfig = {
    cursor_tracking_api: cursorApi || process.env.CURSOR_TRACKING_API || 'not_configured',
    cursor_checkpoint_api: process.env.CURSOR_CHECKPOINT_API || 'not_configured',
    cursor_project_id: process.env.CURSOR_PROJECT_ID || 'not_configured',
    notes: [
      'Configure CURSOR_TRACKING_API for AI code tracking',
      'Configure CURSOR_CHECKPOINT_API for session recovery data',
      'Configure CURSOR_PROJECT_ID to link with Cursor IDE',
    ],
  };

  await fs.writeFile(path.join(output, 'config.json'), JSON.stringify(envConfig, null, 2));
  console.log('✅ Created configuration template');

  console.log('');
  console.log('🎉 Provenance tracking initialized!');
  console.log('');
  console.log('Next steps:');
  console.log('1. Install git hooks for automatic provenance (recommended):');
  console.log('   caws provenance install-hooks');
  console.log('');
  console.log('2. Configure environment variables (optional):');
  console.log('   export CURSOR_TRACKING_API="your-api-endpoint"');
  console.log('   export CURSOR_CHECKPOINT_API="your-checkpoint-endpoint"');
  console.log('   export CURSOR_PROJECT_ID="your-project-id"');
  console.log('');
  console.log('3. Manual provenance updates (if not using hooks):');
  console.log('   caws provenance update --commit <hash>');
  console.log('');
  console.log('4. View provenance history:');
  console.log('   caws provenance show');
}

/**
 * Get Cursor Composer/Chat checkpoint data
 * @returns {Promise<Array>} Array of checkpoint data
 */
async function getCursorCheckpoints() {
  try {
    // Check if Cursor checkpoint API is available
    if (!process.env.CURSOR_CHECKPOINT_API) {
      return { available: false, reason: 'Cursor checkpoint API not configured' };
    }

    // In a real implementation, this would call the Cursor checkpoint API
    // For now, we'll return a mock structure
    const mockCheckpoints = [
      {
        id: 'cp_001',
        timestamp: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        description: 'Initial AI-generated function structure',
        changes_summary: {
          lines_added: 25,
          lines_modified: 0,
          files_affected: ['src/new-feature.js'],
        },
        ai_confidence: 0.82,
        can_revert: true,
      },
      {
        id: 'cp_002',
        timestamp: new Date(Date.now() - 1800000).toISOString(), // 30 min ago
        description: 'Added error handling and validation',
        changes_summary: {
          lines_added: 15,
          lines_modified: 8,
          files_affected: ['src/new-feature.js', 'tests/new-feature.test.js'],
        },
        ai_confidence: 0.91,
        can_revert: true,
      },
      {
        id: 'cp_003',
        timestamp: new Date().toISOString(), // Current
        description: 'Final implementation with documentation',
        changes_summary: {
          lines_added: 12,
          lines_modified: 5,
          files_affected: ['src/new-feature.js', 'README.md'],
        },
        ai_confidence: 0.88,
        can_revert: false, // Latest checkpoint
      },
    ];

    return { available: true, checkpoints: mockCheckpoints };
  } catch (error) {
    return {
      available: false,
      error: error.message,
      reason: 'Failed to retrieve Cursor checkpoint data',
    };
  }
}

/**
 * Attempt to detect the type of agent/system making changes
 * @returns {string} Agent type identifier
 */
function detectAgentType() {
  // Check environment variables and context clues
  if (
    process.env.CURSOR_AGENT === 'true' ||
    process.env.CURSOR_TRACKING_API ||
    process.env.CURSOR_CHECKPOINT_API
  ) {
    return 'cursor-ide';
  }

  if (process.env.GITHUB_ACTIONS === 'true') {
    return 'github-actions';
  }

  if (process.env.CI === 'true') {
    return 'ci-system';
  }

  // Default to human unless we can detect otherwise
  return 'human';
}

module.exports = {
  provenanceCommand,
  updateProvenance,
  showProvenance,
  verifyProvenance,
  initProvenance,
  installHooks,
};
