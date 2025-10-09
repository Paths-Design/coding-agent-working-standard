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

/**
 * Load working specification
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
  // In full implementation, this would run actual gate checks
  return {
    checked: false,
    message: 'Run: node apps/tools/caws/gates.js for full gate status',
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
 * Generate actionable suggestions based on status
 * @param {Object} data - Status data
 * @returns {string[]} Array of suggestions
 */
function generateSuggestions(data) {
  const suggestions = [];

  if (!data.spec) {
    suggestions.push('Initialize CAWS: caws init .');
  }

  if (!data.hooks.installed) {
    suggestions.push('Install Git hooks: caws hooks install');
  }

  if (!data.provenance.exists) {
    suggestions.push('Initialize provenance tracking: caws provenance init');
  }

  if (data.spec && !data.hooks.installed && !data.provenance.exists) {
    suggestions.push('Complete setup: caws scaffold');
  }

  return suggestions;
}

/**
 * Status command handler
 * @param {Object} options - Command options
 */
async function statusCommand(options = {}) {
  return safeAsync(async () => {
    // Load all status data
    const spec = await loadWorkingSpec(options.spec || '.caws/working-spec.yaml');
    const hooks = await checkGitHooks();
    const provenance = await loadProvenanceChain();
    const waivers = await loadWaiverStatus();
    const gates = await checkQualityGates();

    // Display status
    displayStatus({
      spec,
      hooks,
      provenance,
      waivers,
      gates,
    });

    const result = outputResult({
      command: 'status',
      spec: spec ? 'loaded' : 'not found',
      hooks: hooks.installed,
      provenance: provenance.entries?.length || 0,
      waivers: waivers.active?.length || 0,
      gates: gates.passed ? 'passed' : 'failed',
    });

    return result;
  }, 'status check', true);
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
