/**
 * CAWS Waivers Command
 * 
 * Manage quality gate waivers for exceptional circumstances.
 * Waivers allow temporary exceptions to quality requirements
 * with proper documentation and approval.
 * 
 * @author @darianrosebrook
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { initializeGlobalSetup } = require('../config');

const WAIVER_DIR = '.caws/waivers';

/**
 * Waivers command handler
 * 
 * @param {string} subcommand - create, list, show, revoke
 * @param {object} options - Command options
 */
async function waiversCommand(subcommand = 'list', options = {}) {
  try {
    console.log('🔍 Detecting CAWS setup...');
    const setup = initializeGlobalSetup();
    
    if (setup.hasWorkingSpec) {
      console.log(`✅ Detected ${setup.setupType} CAWS setup`);
      console.log(`   Capabilities: ${setup.capabilities.join(', ')}`);
    }

    // Ensure waivers directory exists
    const waiversDir = path.join(process.cwd(), WAIVER_DIR);
    if (!fs.existsSync(waiversDir)) {
      fs.mkdirSync(waiversDir, { recursive: true });
    }

    switch (subcommand) {
      case 'create':
        await createWaiver(options);
        break;
      case 'list':
        await listWaivers(options);
        break;
      case 'show':
        await showWaiver(options.id, options);
        break;
      case 'revoke':
        await revokeWaiver(options.id, options);
        break;
      default:
        console.error(chalk.red(`\n❌ Unknown waiver subcommand: ${subcommand}`));
        console.log(chalk.yellow('\n💡 Available subcommands: create, list, show, revoke'));
        process.exit(1);
    }
  } catch (error) {
    console.error(chalk.red(`\n❌ Waiver command failed: ${error.message}`));
    if (options.verbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }
}

/**
 * Create a new waiver
 */
async function createWaiver(options) {
  // Validate required fields
  const required = ['title', 'reason', 'description', 'gates', 'expiresAt', 'approvedBy', 'impactLevel', 'mitigationPlan'];
  const missing = required.filter(field => !options[field]);
  
  if (missing.length > 0) {
    console.error(chalk.red(`\n❌ Missing required fields: ${missing.join(', ')}`));
    console.log(chalk.yellow('\n💡 Example:'));
    console.log('   caws waivers create \\');
    console.log('     --title="Emergency hotfix waiver" \\');
    console.log('     --reason=emergency_hotfix \\');
    console.log('     --description="Critical production bug requires immediate fix" \\');
    console.log('     --gates=coverage,mutation \\');
    console.log('     --expires-at=2025-12-31T23:59:59Z \\');
    console.log('     --approved-by="@manager" \\');
    console.log('     --impact-level=high \\');
    console.log('     --mitigation-plan="Will add tests in follow-up PR within 48h"');
    process.exit(1);
  }

  // Generate waiver ID
  const waiverId = `WV-${Date.now().toString().slice(-4)}`;
  const timestamp = new Date().toISOString();

  // Parse gates
  const gates = typeof options.gates === 'string' 
    ? options.gates.split(',').map(g => g.trim())
    : options.gates;

  // Create waiver object
  const waiver = {
    id: waiverId,
    title: options.title,
    reason: options.reason,
    description: options.description,
    gates: gates,
    created_at: timestamp,
    expires_at: options.expiresAt,
    approved_by: options.approvedBy,
    impact_level: options.impactLevel,
    mitigation_plan: options.mitigationPlan,
    status: 'active',
  };

  // Save waiver
  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);
  fs.writeFileSync(waiverPath, yaml.dump(waiver, { lineWidth: -1 }));

  console.log(chalk.green(`\n✅ Waiver created: ${waiverId}`));
  console.log(`   Title: ${waiver.title}`);
  console.log(`   Reason: ${waiver.reason}`);
  console.log(`   Gates: ${waiver.gates.join(', ')}`);
  console.log(`   Expires: ${waiver.expires_at}`);
  console.log(`   Approved by: ${waiver.approved_by}`);
  console.log(`   Impact: ${waiver.impact_level}`);
  console.log(chalk.yellow(`\n⚠️  Remember: This waiver expires on ${waiver.expires_at}`));
  console.log(chalk.yellow(`⚠️  Mitigation plan: ${waiver.mitigation_plan}\n`));
}

/**
 * List all waivers
 */
async function listWaivers(_options) {
  const waiversDir = path.join(process.cwd(), WAIVER_DIR);
  
  if (!fs.existsSync(waiversDir)) {
    console.log(chalk.yellow('\nℹ️  No waivers found\n'));
    return;
  }

  const waiverFiles = fs.readdirSync(waiversDir).filter(f => f.endsWith('.yaml'));

  if (waiverFiles.length === 0) {
    console.log(chalk.yellow('\nℹ️  No waivers found\n'));
    return;
  }

  const waivers = waiverFiles.map(file => {
    const content = fs.readFileSync(path.join(waiversDir, file), 'utf8');
    return yaml.load(content);
  });

  // Filter by status
  const activeWaivers = waivers.filter(w => w.status === 'active' && new Date(w.expires_at) > new Date());
  const expiredWaivers = waivers.filter(w => w.status === 'active' && new Date(w.expires_at) <= new Date());
  const revokedWaivers = waivers.filter(w => w.status === 'revoked');

  console.log(chalk.blue('\n🔖 CAWS Quality Gate Waivers\n'));
  console.log('─'.repeat(60));

  if (activeWaivers.length > 0) {
    console.log(chalk.green('\n✅ Active Waivers:\n'));
    activeWaivers.forEach(waiver => {
      const daysLeft = Math.ceil((new Date(waiver.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
      console.log(`🔖 ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Reason: ${waiver.reason}`);
      console.log(`   Gates: ${waiver.gates.join(', ')}`);
      console.log(`   Expires: ${waiver.expires_at} (${daysLeft} days)`);
      console.log(`   Impact: ${waiver.impact_level}`);
      console.log();
    });
  }

  if (expiredWaivers.length > 0) {
    console.log(chalk.yellow('\n⚠️  Expired Waivers:\n'));
    expiredWaivers.forEach(waiver => {
      console.log(`🔖 ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Expired: ${waiver.expires_at}`);
      console.log();
    });
  }

  if (revokedWaivers.length > 0) {
    console.log(chalk.red('\n❌ Revoked Waivers:\n'));
    revokedWaivers.forEach(waiver => {
      console.log(`🔖 ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Revoked: ${waiver.revoked_at}`);
      console.log();
    });
  }

  console.log(chalk.blue('📊 Summary:\n'));
  console.log(`   Active: ${activeWaivers.length}`);
  console.log(`   Expired: ${expiredWaivers.length}`);
  console.log(`   Revoked: ${revokedWaivers.length}`);
  console.log(`   Total: ${waivers.length}\n`);
}

/**
 * Show waiver details
 */
async function showWaiver(waiverId, _options) {
  if (!waiverId) {
    console.error(chalk.red('\n❌ Waiver ID required'));
    console.log(chalk.yellow('💡 Usage: caws waivers show WV-1234\n'));
    process.exit(1);
  }

  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);
  
  if (!fs.existsSync(waiverPath)) {
    console.error(chalk.red(`\n❌ Waiver not found: ${waiverId}\n`));
    process.exit(1);
  }

  const content = fs.readFileSync(waiverPath, 'utf8');
  const waiver = yaml.load(content);

  const isExpired = new Date(waiver.expires_at) <= new Date();
  const isActive = waiver.status === 'active' && !isExpired;
  const statusIcon = isActive ? '✅' : isExpired ? '⚠️' : '❌';

  console.log(chalk.blue('\n🔖 Waiver Details\n'));
  console.log('─'.repeat(60));
  console.log(`\n${statusIcon} Status: ${chalk.bold(isActive ? 'Active' : isExpired ? 'Expired' : waiver.status)}`);
  console.log(`\n📋 ${chalk.bold(waiver.title)}`);
  console.log(`   ID: ${waiver.id}`);
  console.log(`   Reason: ${waiver.reason}`);
  console.log(`   Impact Level: ${waiver.impact_level}`);
  console.log(`\n📝 Description:`);
  console.log(`   ${waiver.description}`);
  console.log(`\n🔒 Waived Quality Gates:`);
  waiver.gates.forEach(gate => {
    console.log(`   • ${gate}`);
  });
  console.log(`\n🛡️ Mitigation Plan:`);
  console.log(`   ${waiver.mitigation_plan}`);
  console.log(`\n📅 Timeline:`);
  console.log(`   Created: ${waiver.created_at}`);
  console.log(`   Expires: ${waiver.expires_at}`);
  if (waiver.revoked_at) {
    console.log(`   Revoked: ${waiver.revoked_at}`);
  }
  console.log(`\n✍️  Approved by: ${waiver.approved_by}\n`);

  if (isExpired && waiver.status === 'active') {
    console.log(chalk.yellow('⚠️  This waiver has expired. Consider revoking it.\n'));
  }
}

/**
 * Revoke a waiver
 */
async function revokeWaiver(waiverId, options) {
  if (!waiverId) {
    console.error(chalk.red('\n❌ Waiver ID required'));
    console.log(chalk.yellow('💡 Usage: caws waivers revoke WV-1234\n'));
    process.exit(1);
  }

  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);
  
  if (!fs.existsSync(waiverPath)) {
    console.error(chalk.red(`\n❌ Waiver not found: ${waiverId}\n`));
    process.exit(1);
  }

  const content = fs.readFileSync(waiverPath, 'utf8');
  const waiver = yaml.load(content);

  if (waiver.status === 'revoked') {
    console.log(chalk.yellow(`\nℹ️  Waiver ${waiverId} is already revoked\n`));
    return;
  }

  // Update waiver status
  waiver.status = 'revoked';
  waiver.revoked_at = new Date().toISOString();
  waiver.revoked_by = options.revokedBy || 'system';
  waiver.revocation_reason = options.reason || 'Manual revocation';

  // Save updated waiver
  fs.writeFileSync(waiverPath, yaml.dump(waiver, { lineWidth: -1 }));

  console.log(chalk.green(`\n✅ Waiver revoked: ${waiverId}`));
  console.log(`   Title: ${waiver.title}`);
  console.log(`   Revoked at: ${waiver.revoked_at}`);
  console.log(`   Revoked by: ${waiver.revoked_by}`);
  console.log(`   Reason: ${waiver.revocation_reason}\n`);
}

module.exports = { waiversCommand };

