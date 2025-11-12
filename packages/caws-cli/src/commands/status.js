/**
 * @fileoverview CAWS Status Command
 * Display project health overview
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { safeAsync, outputResult } = require('../error-handler');
const { parallel } = require('../utils/async-utils');

/**
 * Load working specification (legacy single file approach)
 * @param {string} specPath - Path to working spec
 * @returns {Promise<Object|null>} Parsed spec or null
 */
async function loadWorkingSpec(specPath = '.caws/working-spec.yaml') {
  try {
    if (!(await fs.pathExists(specPath))) {
      return null;
    }

    const content = await fs.readFile(specPath, 'utf8');
    return yaml.load(content);
  } catch (error) {
    return null;
  }
}

/**
 * Load specs from the new multi-spec system
 * @returns {Promise<Array>} Array of spec objects
 */
async function loadSpecsFromMultiSpec() {
  const { listSpecFiles } = require('./specs');

  try {
    return await listSpecFiles();
  } catch (error) {
    return [];
  }
}

/**
 * Check Git hooks status
 * @returns {Promise<Object>} Hooks status
 */
async function checkGitHooks() {
  const hooksDir = '.git/hooks';

  if (!(await fs.pathExists(hooksDir))) {
    return {
      installed: false,
      count: 0,
      active: [],
    };
  }

  const cawsHooks = ['pre-commit', 'post-commit', 'pre-push', 'commit-msg'];
  const activeHooks = [];

  for (const hook of cawsHooks) {
    const hookPath = path.join(hooksDir, hook);
    if (await fs.pathExists(hookPath)) {
      const content = await fs.readFile(hookPath, 'utf8');
      if (content.includes('CAWS')) {
        activeHooks.push(hook);
      }
    }
  }

  return {
    installed: activeHooks.length > 0,
    count: activeHooks.length,
    active: activeHooks,
    total: cawsHooks.length,
  };
}

/**
 * Load provenance chain
 * @returns {Promise<Object>} Provenance status
 */
async function loadProvenanceChain() {
  const chainPath = '.caws/provenance/chain.json';

  if (!(await fs.pathExists(chainPath))) {
    return {
      exists: false,
      count: 0,
      lastUpdate: null,
    };
  }

  try {
    const chain = JSON.parse(await fs.readFile(chainPath, 'utf8'));
    const lastEntry = chain.length > 0 ? chain[chain.length - 1] : null;

    return {
      exists: true,
      count: chain.length,
      lastUpdate: lastEntry?.timestamp || null,
      lastCommit: lastEntry?.commit?.hash || null,
    };
  } catch (error) {
    return {
      exists: true,
      count: 0,
      lastUpdate: null,
      error: error.message,
    };
  }
}

/**
 * Load waiver status
 * @returns {Promise<Object>} Waiver status
 */
async function loadWaiverStatus() {
  const waiversDir = '.caws/waivers';

  if (!(await fs.pathExists(waiversDir))) {
    return {
      exists: false,
      active: 0,
      expired: 0,
      revoked: 0,
      total: 0,
    };
  }

  try {
    const waiverFiles = await fs.readdir(waiversDir);
    const yamlFiles = waiverFiles.filter((f) => f.endsWith('.yaml'));

    let active = 0;
    let expired = 0;
    let revoked = 0;

    for (const file of yamlFiles) {
      const waiverPath = path.join(waiversDir, file);
      const content = await fs.readFile(waiverPath, 'utf8');
      const waiver = yaml.load(content);

      if (waiver.status === 'revoked') {
        revoked++;
      } else if (waiver.status === 'active') {
        const now = new Date();
        const expiresAt = new Date(waiver.expires_at);
        if (now > expiresAt) {
          expired++;
        } else {
          active++;
        }
      }
    }

    return {
      exists: true,
      active,
      expired,
      revoked,
      total: active + expired + revoked,
    };
  } catch (error) {
    return {
      exists: false,
      active: 0,
      expired: 0,
      revoked: 0,
      total: 0,
      error: error.message,
    };
  }
}

/**
 * Check quality gates status (simplified)
 * @returns {Promise<Object>} Quality gates status
 */
async function checkQualityGates() {
  // For now, return a placeholder
  // Quality gates are available via CLI or MCP
  return {
    checked: false,
    message: 'Run: caws quality-gates or use MCP tool caws_quality_gates_run for full gate status',
  };
}

/**
 * Get time since last update
 * @param {string} timestamp - ISO timestamp
 * @returns {string} Human-readable time
 */
function getTimeSince(timestamp) {
  if (!timestamp) return 'never';

  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;

  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

/**
 * Display project status
 * @param {Object} data - Status data
 */
function displayStatus(data) {
  const { spec, hooks, provenance, waivers, gates } = data;

  console.log(chalk.bold.cyan('\n📊 CAWS Project Status'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  // Working Spec Status
  if (spec) {
    console.log(chalk.green('✅ Working Spec'));
    console.log(chalk.gray(`   ID: ${spec.id} | Tier: ${spec.risk_tier} | Mode: ${spec.mode}`));
    console.log(chalk.gray(`   Title: ${spec.title}`));
  } else {
    console.log(chalk.red('❌ Working Spec'));
    console.log(chalk.gray('   No working spec found'));
    console.log(chalk.yellow('   💡 Run: caws init . to create one'));
  }

  console.log('');

  // Git Hooks Status
  if (hooks.installed) {
    console.log(chalk.green(`✅ Git Hooks`));
    console.log(chalk.gray(`   ${hooks.count}/${hooks.total} active: ${hooks.active.join(', ')}`));
  } else {
    console.log(chalk.yellow('⚠️  Git Hooks'));
    console.log(chalk.gray('   No CAWS git hooks installed'));
    console.log(chalk.yellow('   💡 Run: caws hooks install'));
  }

  console.log('');

  // Provenance Status
  if (provenance.exists) {
    console.log(chalk.green('✅ Provenance'));
    console.log(chalk.gray(`   Chain: ${provenance.count} entries`));
    if (provenance.lastUpdate) {
      console.log(chalk.gray(`   Last update: ${getTimeSince(provenance.lastUpdate)}`));
    }
  } else {
    console.log(chalk.yellow('⚠️  Provenance'));
    console.log(chalk.gray('   Provenance tracking not initialized'));
    console.log(chalk.yellow('   💡 Run: caws provenance init'));
  }

  console.log('');

  // Waivers Status
  if (waivers.exists && waivers.total > 0) {
    console.log(chalk.green('✅ Quality Gate Waivers'));
    console.log(
      chalk.gray(
        `   ${waivers.active} active, ${waivers.expired} expired, ${waivers.revoked} revoked`
      )
    );
    console.log(chalk.gray(`   Total: ${waivers.total} waiver${waivers.total > 1 ? 's' : ''}`));
  } else if (waivers.exists) {
    console.log(chalk.blue('ℹ️  Quality Gate Waivers'));
    console.log(chalk.gray('   No waivers configured'));
  } else {
    console.log(chalk.yellow('⚠️  Quality Gate Waivers'));
    console.log(chalk.gray('   Waiver system not initialized'));
    console.log(chalk.yellow('   💡 Run: caws waivers create (when needed)'));
  }

  console.log('');

  // Quality Gates Status
  console.log(chalk.blue('ℹ️  Quality Gates'));
  console.log(chalk.gray(`   ${gates.message}`));

  // Suggestions
  const suggestions = generateSuggestions(data);
  if (suggestions.length > 0) {
    console.log(chalk.bold.yellow('\n💡 Suggestions:'));
    suggestions.forEach((suggestion) => {
      console.log(chalk.yellow(`   ${suggestion}`));
    });
  }

  // Quick Links
  console.log(chalk.bold.blue('\n📚 Quick Links:'));
  if (spec) {
    console.log(chalk.blue('   View spec: .caws/working-spec.yaml'));
  }
  if (hooks.installed) {
    console.log(chalk.blue('   View hooks: .git/hooks/'));
  }
  if (provenance.exists) {
    console.log(chalk.blue('   View provenance: caws provenance show --format=dashboard'));
  }
  if (waivers.exists && waivers.total > 0) {
    console.log(chalk.blue('   View waivers: caws waivers list'));
  }
  console.log(chalk.blue('   Full documentation: docs/agents/full-guide.md'));

  console.log('');
}

/**
 * Generate actionable suggestions based on status and mode
 * @param {Object} data - Status data
 * @param {string} currentMode - Current CAWS mode
 * @returns {string[]} Array of suggestions
 */
function generateSuggestions(data, currentMode) {
  const { spec, specs, hooks, provenance, waivers } = data;
  const modes = require('../config/modes');
  const suggestions = [];

  // Basic setup suggestions
  if (!spec && (!specs || specs.length === 0)) {
    suggestions.push('Create a spec: caws specs create <id>');
  }

  // Mode-specific suggestions
  if (modes.isFeatureEnabled('gitHooks', currentMode) && !hooks.installed) {
    suggestions.push('Install Git hooks: caws hooks install');
  }

  if (modes.isFeatureEnabled('provenance', currentMode) && !provenance.exists) {
    suggestions.push('Initialize provenance tracking: caws provenance init');
  }

  if (modes.isFeatureEnabled('waivers', currentMode) && !waivers.exists) {
    suggestions.push('Initialize waiver system: caws waivers create (when needed)');
  }

  // Quality gate suggestions
  if (modes.isFeatureEnabled('qualityGates', currentMode)) {
    if (spec || (specs && specs.length > 0)) {
      suggestions.push('Run quality gates: caws diagnose');
    }
  }

  // Mode switching suggestion
  suggestions.push('Switch modes: caws mode set --interactive');

  return suggestions;
}

/**
 * Create progress bar string
 * @param {number} current - Current value
 * @param {number} total - Total value
 * @param {number} width - Bar width
 * @returns {string} Progress bar string
 */
function createProgressBar(current, total, width = 20) {
  if (total === 0) return '░'.repeat(width);

  const percentage = Math.min(current / total, 1);
  const filled = Math.round(percentage * width);
  const empty = width - filled;

  return '▓'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Get color for progress percentage
 * @param {number} percentage - Progress percentage
 * @returns {string} Chalk color function
 */
function getProgressColor(percentage) {
  if (percentage >= 80) return chalk.green;
  if (percentage >= 50) return chalk.yellow;
  return chalk.red;
}

/**
 * Display enhanced visual status
 * @param {Object} data - Status data
 * @param {string} currentMode - Current CAWS mode
 */
function displayVisualStatus(data, currentMode) {
  const { spec, specs, hooks, provenance, waivers, gates } = data;
  const modes = require('../config/modes');
  const tierConfig = modes.getTier(currentMode);

  console.log(
    chalk.bold.cyan(
      `\n📊 CAWS Project Status (${tierConfig.icon} ${tierConfig.color(currentMode)})`
    )
  );
  console.log(
    chalk.cyan(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'
    )
  );

  // Multi-spec system status
  if (specs && specs.length > 0) {
    console.log(chalk.green(`✅ Specs System (${specs.length} specs)`));

    // Show active specs first
    const activeSpecs = specs.filter((s) => s.status === 'active');
    const draftSpecs = specs.filter((s) => s.status === 'draft');
    const completedSpecs = specs.filter((s) => s.status === 'completed');

    if (activeSpecs.length > 0) {
      console.log(
        chalk.gray(`   Active: ${activeSpecs.map((s) => `${s.id}(${s.type})`).join(', ')}`)
      );
    }
    if (draftSpecs.length > 0) {
      console.log(
        chalk.gray(`   Draft: ${draftSpecs.length} spec${draftSpecs.length > 1 ? 's' : ''}`)
      );
      // Show details for draft specs if not too many
      if (draftSpecs.length <= 3) {
        draftSpecs.forEach((s) => {
          console.log(chalk.gray(`     • ${s.id}: ${s.title}`));
        });
      }
    }
    if (completedSpecs.length > 0) {
      console.log(
        chalk.gray(
          `   Completed: ${completedSpecs.length} spec${completedSpecs.length > 1 ? 's' : ''}`
        )
      );
      // Show details for completed specs if not too many
      if (completedSpecs.length <= 3) {
        completedSpecs.forEach((s) => {
          console.log(chalk.gray(`     • ${s.id}: ${s.title}`));
        });
      }
    }

    // Overall specs progress
    const totalSpecs = specs.length;
    const completedSpecsCount = specs.filter((s) => s.status === 'completed').length;
    const activeSpecsCount = specs.filter((s) => s.status === 'active').length;
    const progressPercentage =
      totalSpecs > 0 ? Math.round((completedSpecsCount / totalSpecs) * 100) : 0;
    const progressBar = createProgressBar(completedSpecsCount, totalSpecs);
    const color = getProgressColor(progressPercentage);

    console.log(
      chalk.gray(
        `   Overall Progress: ${color(`${progressPercentage}%`)} ${progressBar} ${completedSpecsCount}/${totalSpecs} completed`
      )
    );

    if (activeSpecsCount > 0) {
      console.log(chalk.gray(`   Active Features: ${activeSpecsCount} in progress`));
    }

    // Show risk tier breakdown
    const riskBreakdown = {};
    specs.forEach((s) => {
      const tier = s.risk_tier || 'T3';
      riskBreakdown[tier] = (riskBreakdown[tier] || 0) + 1;
    });

    if (Object.keys(riskBreakdown).length > 1) {
      const tierDisplay = Object.entries(riskBreakdown)
        .map(([tier, count]) => `${tier}:${count}`)
        .join(', ');
      console.log(chalk.gray(`   Risk Distribution: ${tierDisplay}`));
    }
  } else if (spec) {
    // Legacy single spec system
    console.log(chalk.green('✅ Working Spec'));
    console.log(chalk.gray(`   ID: ${spec.id} | Tier: ${spec.risk_tier} | Mode: ${spec.mode}`));
    console.log(chalk.gray(`   Title: ${spec.title}`));

    // Acceptance Criteria Progress
    if (spec.acceptance_criteria && spec.acceptance_criteria.length > 0) {
      const total = spec.acceptance_criteria.length;
      const completed = spec.acceptance_criteria.filter((c) => c.completed).length;
      const percentage = Math.round((completed / total) * 100);

      const color = getProgressColor(percentage);
      const bar = createProgressBar(completed, total);

      console.log(
        chalk.gray(
          `   Acceptance Criteria: ${color(`${percentage}%`)} ${bar} ${completed}/${total}`
        )
      );
    }

    // Test Coverage (placeholder for now)
    console.log(
      chalk.gray(
        `   Test Coverage: ${chalk.blue('Calculating...')} ${createProgressBar(0, 100)} 0%`
      )
    );

    // Risk Tier Indicator
    const riskColor =
      spec.risk_tier === 'T1' ? chalk.red : spec.risk_tier === 'T2' ? chalk.yellow : chalk.green;
    console.log(
      chalk.gray(
        `   Risk Tier: ${riskColor(spec.risk_tier)} (Quality Gates: ${riskColor('Active')})`
      )
    );
  } else {
    console.log(chalk.red('❌ No Specs Found'));
    console.log(chalk.gray('   No working spec or specs directory found'));
    console.log(chalk.yellow('   💡 Run: caws specs create <id> to create specs'));
    console.log(chalk.yellow('   💡 Or run: caws init . for legacy single spec'));
  }

  console.log('');

  // Git Hooks Status (only show in modes that support it)
  if (modes.isFeatureEnabled('gitHooks', currentMode)) {
    if (hooks.installed) {
      const hookBar = createProgressBar(hooks.count, hooks.total);
      console.log(chalk.green(`✅ Git Hooks`));
      console.log(
        chalk.gray(`   ${hookBar} ${hooks.count}/${hooks.total} active: ${hooks.active.join(', ')}`)
      );
    } else {
      console.log(chalk.yellow('⚠️  Git Hooks'));
      console.log(chalk.gray('   No CAWS git hooks installed'));
      console.log(chalk.yellow('   💡 Run: caws hooks install'));
    }
  }

  console.log('');

  // Provenance Status (only show in modes that support it)
  if (modes.isFeatureEnabled('provenance', currentMode)) {
    if (provenance.exists) {
      const provenanceBar = createProgressBar(provenance.count, Math.max(provenance.count, 10));
      console.log(chalk.green('✅ Provenance'));
      console.log(chalk.gray(`   ${provenanceBar} ${provenance.count} entries`));
      if (provenance.lastUpdate) {
        console.log(chalk.gray(`   Last update: ${getTimeSince(provenance.lastUpdate)}`));
      }
    } else {
      console.log(chalk.yellow('⚠️  Provenance'));
      console.log(chalk.gray('   Provenance tracking not initialized'));
      console.log(chalk.yellow('   💡 Run: caws provenance init'));
    }
  }

  console.log('');

  // Waivers Status (only show in modes that support it)
  if (modes.isFeatureEnabled('waivers', currentMode)) {
    if (waivers.exists && waivers.total > 0) {
      const waiverBar = createProgressBar(waivers.active, waivers.total);
      console.log(chalk.green('✅ Quality Gate Waivers'));
      console.log(
        chalk.gray(
          `   ${waiverBar} ${waivers.active} active, ${waivers.expired} expired, ${waivers.revoked} revoked`
        )
      );
      console.log(chalk.gray(`   Total: ${waivers.total} waiver${waivers.total > 1 ? 's' : ''}`));
    } else if (waivers.exists) {
      console.log(chalk.blue('ℹ️  Quality Gate Waivers'));
      console.log(chalk.gray('   No waivers configured'));
    } else {
      console.log(chalk.yellow('⚠️  Quality Gate Waivers'));
      console.log(chalk.gray('   Waiver system not initialized'));
      console.log(chalk.yellow('   💡 Run: caws waivers create (when needed)'));
    }
  }

  console.log('');

  // Quality Gates Status (only show in modes that support it)
  if (modes.isFeatureEnabled('qualityGates', currentMode)) {
    console.log(chalk.blue('🛡️  Quality Gates'));
    if (gates.checked) {
      if (gates.passed) {
        console.log(chalk.green(`   ${createProgressBar(1, 1)} All gates passed`));
        gates.results?.forEach((gate) => {
          const gateStatus = gate.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
          console.log(chalk.gray(`     ${gateStatus} ${gate.name}: ${gate.message || 'OK'}`));
        });
      } else {
        console.log(
          chalk.red(
            `   ${createProgressBar(0, gates.results?.length || 1)} ${gates.failed || 0} gates failed`
          )
        );
        gates.results?.forEach((gate) => {
          const gateStatus = gate.status === 'passed' ? chalk.green('✓') : chalk.red('✗');
          console.log(chalk.gray(`     ${gateStatus} ${gate.name}: ${gate.message || 'Failed'}`));
        });
      }
    } else {
      console.log(chalk.gray(`   ${gates.message}`));
    }
  }

  // Progress Summary
  const overallProgress = calculateOverallProgress(data);
  const progressColor = getProgressColor(overallProgress);
  const progressBar = createProgressBar(overallProgress, 100);

  console.log('');
  console.log(chalk.bold.blue('📈 Overall Progress'));
  console.log(chalk.gray(`   ${progressBar} ${progressColor(`${overallProgress}%`)} complete`));

  // Suggestions (mode-aware)
  const suggestions = generateSuggestions(data, currentMode);
  if (suggestions.length > 0) {
    console.log(chalk.bold.yellow('\n💡 Next Steps:'));
    suggestions.forEach((suggestion, index) => {
      console.log(chalk.yellow(`   ${index + 1}. ${suggestion}`));
    });
  }

  // Quick Links (mode-aware)
  console.log(chalk.bold.blue('\n📚 Quick Actions:'));
  if (spec || (specs && specs.length > 0)) {
    if (modes.isFeatureEnabled('validate', currentMode)) {
      console.log(chalk.blue('   View specs: caws specs list'));
    }
    if (modes.isFeatureEnabled('validate', currentMode)) {
      console.log(chalk.blue('   Validate: caws validate'));
    }
  }

  if (modes.isFeatureEnabled('gitHooks', currentMode) && hooks.installed) {
    console.log(chalk.blue('   View hooks: caws hooks status'));
  }

  if (modes.isFeatureEnabled('provenance', currentMode) && provenance.exists) {
    console.log(chalk.blue('   View provenance: caws provenance show'));
  }

  if (modes.isFeatureEnabled('waivers', currentMode) && waivers.exists && waivers.total > 0) {
    console.log(chalk.blue('   View waivers: caws waivers list'));
  }

  console.log(chalk.blue('   Get help: caws help'));
  console.log(chalk.blue('   Switch mode: caws mode set --interactive'));

  console.log('');
}

/**
 * Calculate overall project progress (mode-aware)
 * @param {Object} data - Status data
 * @returns {number} Overall progress percentage
 */
function calculateOverallProgress(data) {
  const { spec, specs, hooks, provenance, waivers, currentMode } = data;
  const modes = require('../config/modes');

  let score = 0;

  // Multi-spec system
  if (specs && specs.length > 0) {
    // Specs system (40%)
    const completedSpecs = specs.filter((s) => s.status === 'completed').length;
    if (specs.length > 0) {
      const percentage = (completedSpecs / specs.length) * 40;
      score += percentage;
    }

    // Git hooks (20%) - only if enabled in mode
    if (modes.isFeatureEnabled('gitHooks', currentMode)) {
      if (hooks.installed) score += 20;
    }

    // Provenance (20%) - only if enabled in mode
    if (modes.isFeatureEnabled('provenance', currentMode)) {
      if (provenance.exists) score += 20;
    }

    // Waivers (15%) - only if enabled in mode
    if (modes.isFeatureEnabled('waivers', currentMode)) {
      if (waivers.exists) score += 15;
    }

    // Quality gates (5%) - only if enabled in mode
    if (modes.isFeatureEnabled('qualityGates', currentMode)) {
      if (specs.length > 0) score += 5;
    }
  } else if (spec) {
    // Legacy single spec system (30%)
    if (spec) score += 30;

    // Acceptance criteria progress (25%)
    if (spec && spec.acceptance_criteria && spec.acceptance_criteria.length > 0) {
      const completed = spec.acceptance_criteria.filter((c) => c.completed).length;
      const percentage = (completed / spec.acceptance_criteria.length) * 25;
      score += percentage;
    }

    // Git hooks (15%) - only if enabled in mode
    if (modes.isFeatureEnabled('gitHooks', currentMode)) {
      if (hooks.installed) score += 15;
    }

    // Provenance (15%) - only if enabled in mode
    if (modes.isFeatureEnabled('provenance', currentMode)) {
      if (provenance.exists) score += 15;
    }

    // Waivers (10%) - only if enabled in mode
    if (modes.isFeatureEnabled('waivers', currentMode)) {
      if (waivers.exists) score += 10;
    }

    // Quality gates (5%) - only if enabled in mode
    if (modes.isFeatureEnabled('qualityGates', currentMode)) {
      if (spec) score += 5;
    }
  } else {
    // No specs system - check basic setup (mode-aware)

    // Git hooks (30%) - only if enabled in mode
    if (modes.isFeatureEnabled('gitHooks', currentMode)) {
      if (hooks.installed) score += 30;
    }

    // Provenance (30%) - only if enabled in mode
    if (modes.isFeatureEnabled('provenance', currentMode)) {
      if (provenance.exists) score += 30;
    }

    // Waivers (20%) - only if enabled in mode
    if (modes.isFeatureEnabled('waivers', currentMode)) {
      if (waivers.exists) score += 20;
    }

    // Quality gates (20%) - only if enabled in mode
    if (modes.isFeatureEnabled('qualityGates', currentMode)) {
      if (hooks.installed || provenance.exists) score += 20;
    }
  }

  return Math.min(Math.round(score), 100);
}

/**
 * Status command handler
 * @param {Object} options - Command options
 */
async function statusCommand(options = {}) {
  return safeAsync(
    async () => {
      // Check current mode and adjust behavior accordingly
      const modes = require('../config/modes');
      const currentMode = await modes.getCurrentMode();

      // Load all status data in parallel for better performance
      const [spec, specs, hooks, provenance, waivers, gates] = await parallel([
        () => loadWorkingSpec(options.spec || '.caws/working-spec.yaml'),
        () => loadSpecsFromMultiSpec(),
        () => checkGitHooks(),
        () => loadProvenanceChain(),
        () => loadWaiverStatus(),
        () => checkQualityGates(),
      ]);

      // Display status (visual mode if requested)
      if (options.visual || options.json) {
        if (options.json) {
          // JSON output for automation
          const result = {
            command: 'status',
            timestamp: new Date().toISOString(),
            system: specs.length > 0 ? 'multi-spec' : 'single-spec',
            specs:
              specs.length > 0
                ? {
                    count: specs.length,
                    active: specs.filter((s) => s.status === 'active').length,
                    draft: specs.filter((s) => s.status === 'draft').length,
                    completed: specs.filter((s) => s.status === 'completed').length,
                    list: specs.map((s) => ({
                      id: s.id,
                      type: s.type,
                      status: s.status,
                      title: s.title,
                    })),
                  }
                : null,
            legacySpec: spec
              ? {
                  id: spec.id,
                  title: spec.title,
                  riskTier: spec.risk_tier,
                  mode: spec.mode,
                  acceptanceCriteria: spec.acceptance_criteria?.length || 0,
                  completedCriteria:
                    spec.acceptance_criteria?.filter((c) => c.completed).length || 0,
                }
              : null,
            hooks: {
              installed: hooks.installed,
              count: hooks.count,
              total: hooks.total,
              active: hooks.active,
            },
            provenance: {
              exists: provenance.exists,
              count: provenance.count,
              lastUpdate: provenance.lastUpdate,
            },
            waivers: {
              exists: waivers.exists,
              active: waivers.active,
              expired: waivers.expired,
              revoked: waivers.revoked,
              total: waivers.total,
            },
            qualityGates: {
              checked: gates.checked,
              passed: gates.passed,
              message: gates.message,
            },
            overallProgress: calculateOverallProgress({
              spec,
              specs,
              hooks,
              provenance,
              waivers,
              gates,
            }),
          };

          console.log(JSON.stringify(result, null, 2));
        } else {
          // Visual output
          displayVisualStatus(
            {
              spec,
              specs,
              hooks,
              provenance,
              waivers,
              gates,
            },
            currentMode
          );
        }
      } else {
        // Original text-based output
        displayStatus({
          spec,
          hooks,
          provenance,
          waivers,
          gates,
        });
      }

      const result = outputResult({
        command: 'status',
        mode: options.visual ? 'visual' : options.json ? 'json' : 'text',
        system: specs.length > 0 ? 'multi-spec' : 'single-spec',
        currentMode: currentMode,
        specs: specs.length,
        legacySpec: spec ? 'loaded' : 'not found',
        hooks: modes.isFeatureEnabled('gitHooks', currentMode) ? hooks.installed : null,
        provenance: modes.isFeatureEnabled('provenance', currentMode)
          ? provenance.count || 0
          : null,
        waivers: modes.isFeatureEnabled('waivers', currentMode) ? waivers.active || 0 : null,
        gates: modes.isFeatureEnabled('qualityGates', currentMode)
          ? gates.passed
            ? 'passed'
            : 'failed'
          : null,
        overallProgress: calculateOverallProgress({
          spec,
          specs,
          hooks,
          provenance,
          waivers,
          gates,
          currentMode,
        }),
      });

      return result;
    },
    'status check',
    true
  );
}

module.exports = {
  statusCommand,
  loadWorkingSpec,
  checkGitHooks,
  loadProvenanceChain,
  loadWaiverStatus,
  checkQualityGates,
  displayStatus,
  generateSuggestions,
};
