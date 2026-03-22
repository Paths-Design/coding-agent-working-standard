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
const WaiversManager = require('../waivers-manager');
const { commandWrapper, Output } = require('../utils/command-wrapper');

const WAIVER_DIR = '.caws/waivers';

/**
 * Valid gate identifiers recognized by the quality-gates package.
 * These must match the gate names used in processViolations() calls
 * within the check-*.mjs files.
 */
const VALID_GATES = [
  'naming',
  'code_freeze',
  'duplication',
  'duplication_gate',
  'god_objects',
  'placeholders',
  'simplification',
  'hidden-todo',
  'documentation',
  '*',
];

/**
 * Waivers command handler
 *
 * @param {string} subcommand - create, list, show, revoke
 * @param {object} options - Command options
 */
async function waiversCommand(subcommand = 'list', options = {}) {
  return commandWrapper(
    async () => {
      Output.info('Detecting CAWS setup...');
      const setup = initializeGlobalSetup();

      if (setup.hasWorkingSpec) {
        Output.success(`Detected ${setup.setupType} CAWS setup`, {
          capabilities: setup.capabilities,
        });
      }

      // Ensure waivers directory exists
      const waiversDir = path.join(process.cwd(), WAIVER_DIR);
      if (!fs.existsSync(waiversDir)) {
        fs.mkdirSync(waiversDir, { recursive: true });
      }

      switch (subcommand) {
        case 'create':
          return await createWaiver(options);
        case 'list':
          return await listWaivers(options);
        case 'show':
          return await showWaiver(options.id, options);
        case 'revoke':
          return await revokeWaiver(options.id, options);
        default:
          throw new Error(
            `Unknown waiver subcommand: ${subcommand}.\n` +
            'Available subcommands: create, list, show, revoke'
          );
      }
    },
    {
      commandName: `waivers ${subcommand}`,
      context: { subcommand, options },
    }
  );
}

/**
 * Create a new waiver
 */
async function createWaiver(options) {
  // Validate all required fields upfront (report all missing at once)
  const required = [
    { field: 'title', flag: '--title', example: '"Emergency hotfix waiver"' },
    { field: 'reason', flag: '--reason', example: 'emergency_hotfix' },
    { field: 'description', flag: '--description', example: '"Critical production bug requires immediate fix"' },
    { field: 'gates', flag: '--gates', example: `placeholders,naming  (valid: ${VALID_GATES.join(', ')})` },
    { field: 'expiresAt', flag: '--expires-at', example: '2025-12-31T23:59:59Z' },
    { field: 'approvedBy', flag: '--approved-by', example: '"@manager"' },
    { field: 'impactLevel', flag: '--impact-level', example: 'high' },
    { field: 'mitigationPlan', flag: '--mitigation-plan', example: '"Will add tests in follow-up PR within 48h"' },
  ];
  const missing = required.filter((r) => !options[r.field]);

  if (missing.length > 0) {
    console.error(chalk.red(`\nMissing ${missing.length} required option(s):\n`));
    missing.forEach((r) => {
      console.error(`  ${chalk.yellow(r.flag)}  e.g. ${r.example}`);
    });
    console.log(chalk.dim('\nFull example:'));
    console.log('   caws waivers create \\');
    required.forEach((r, i) => {
      const sep = i < required.length - 1 ? ' \\' : '';
      console.log(`     ${r.flag}=${r.example}${sep}`);
    });
    process.exit(1);
  }

  // Parse gates
  const gates =
    typeof options.gates === 'string'
      ? options.gates.split(',').map((g) => g.trim())
      : options.gates;

  // Validate gate names against known identifiers
  const invalidGates = gates.filter((g) => !VALID_GATES.includes(g));
  if (invalidGates.length > 0) {
    console.error(chalk.red(`\nUnrecognized gate name(s): ${invalidGates.join(', ')}`));
    console.log(`\nValid gate names: ${VALID_GATES.join(', ')}`);

    // Suggest close matches
    invalidGates.forEach((bad) => {
      const suggestion = VALID_GATES.find(
        (v) => v !== '*' && (v.includes(bad) || bad.includes(v))
      );
      if (suggestion) {
        console.log(chalk.yellow(`  "${bad}" -> did you mean "${suggestion}"?`));
      }
    });
    process.exit(1);
  }

  // Self-approval prevention: creator cannot be approver
  // Uses strict equality — the previous .includes() check was an asymmetric
  // substring match that produced false positives (blocking legitimate approvers
  // whose name happened to contain the session ID) while missing the reverse
  // case (approver is a prefix of the session ID).
  // When CLAUDE_SESSION_ID is unset or empty, we can't identify the creator,
  // so self-approval prevention is skipped ('' || null → null → falsy guard).
  const creatorSession = process.env.CLAUDE_SESSION_ID || null;
  if (creatorSession && options.approvedBy) {
    if (options.approvedBy === creatorSession) {
      throw new Error(
        'Waiver creator cannot be the approver.\n' +
        'A different agent or human must approve this waiver.\n' +
        `Creator session: ${creatorSession}`
      );
    }
  }

  // Generate waiver ID
  const waiverId = `WV-${Date.now().toString().slice(-4)}`;
  const timestamp = new Date().toISOString();

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
    created_by_session: creatorSession,
  };

  // Save individual waiver file
  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);
  fs.writeFileSync(waiverPath, yaml.dump(waiver, { lineWidth: -1 }));

  // Also add to active waivers file
  try {
    await addToActiveWaivers(waiver);
  } catch (error) {
    console.error(`Failed to add waiver to active waivers: ${error.message}`);
    console.error(error.stack);
  }

  console.log(chalk.green(`\nWaiver created: ${waiverId}`));
  console.log(`   Title: ${waiver.title}`);
  console.log(`   Reason: ${waiver.reason}`);
  console.log(`   Gates: ${waiver.gates.join(', ')}`);
  console.log(`   Expires: ${waiver.expires_at}`);
  console.log(`   Approved by: ${waiver.approved_by}`);
  console.log(`   Impact: ${waiver.impact_level}`);
  console.log(chalk.yellow(`\n   Note: This waiver expires on ${waiver.expires_at}`));
  console.log(chalk.yellow(`   Mitigation plan: ${waiver.mitigation_plan}\n`));
}

/**
 * List all waivers
 */
async function listWaivers(_options) {
  const waiversDir = path.join(process.cwd(), WAIVER_DIR);

  if (!fs.existsSync(waiversDir)) {
    console.log(chalk.yellow('\nNo waivers found.\n'));
    return;
  }

  const waiverFiles = fs.readdirSync(waiversDir).filter((f) => f.endsWith('.yaml'));

  if (waiverFiles.length === 0) {
    console.log(chalk.yellow('\nNo waivers found.\n'));
    return;
  }

  const waivers = waiverFiles.map((file) => {
    const content = fs.readFileSync(path.join(waiversDir, file), 'utf8');
    return yaml.load(content);
  });

  // Filter by status
  const activeWaivers = waivers.filter(
    (w) => w.status === 'active' && new Date(w.expires_at) > new Date()
  );
  const expiredWaivers = waivers.filter(
    (w) => w.status === 'active' && new Date(w.expires_at) <= new Date()
  );
  const revokedWaivers = waivers.filter((w) => w.status === 'revoked');

  console.log(chalk.blue('\nCAWS Quality Gate Waivers\n'));
  console.log('-'.repeat(60));

  if (activeWaivers.length > 0) {
    console.log(chalk.green('\nActive Waivers:\n'));
    activeWaivers.forEach((waiver) => {
      const daysLeft = Math.ceil(
        (new Date(waiver.expires_at) - new Date()) / (1000 * 60 * 60 * 24)
      );
      console.log(`  ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Reason: ${waiver.reason}`);
      console.log(`   Gates: ${waiver.gates.join(', ')}`);
      console.log(`   Expires: ${waiver.expires_at} (${daysLeft} days)`);
      console.log(`   Impact: ${waiver.impact_level}`);
      console.log();
    });
  }

  if (expiredWaivers.length > 0) {
    console.log(chalk.yellow('\nExpired Waivers:\n'));
    expiredWaivers.forEach((waiver) => {
      console.log(`  ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Expired: ${waiver.expires_at}`);
      console.log();
    });
  }

  if (revokedWaivers.length > 0) {
    console.log(chalk.red('\nRevoked Waivers:\n'));
    revokedWaivers.forEach((waiver) => {
      console.log(`  ${chalk.bold(waiver.id)}: ${waiver.title}`);
      console.log(`   Revoked: ${waiver.revoked_at}`);
      console.log();
    });
  }

  console.log(chalk.blue('Summary:\n'));
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
    console.error(chalk.red('\nWaiver ID required'));
    console.log(chalk.yellow('Usage: caws waivers show WV-1234\n'));
    process.exit(1);
  }

  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);

  if (!fs.existsSync(waiverPath)) {
    console.error(chalk.red(`\nWaiver not found: ${waiverId}\n`));
    process.exit(1);
  }

  const content = fs.readFileSync(waiverPath, 'utf8');
  const waiver = yaml.load(content);

  const isExpired = new Date(waiver.expires_at) <= new Date();
  const isActive = waiver.status === 'active' && !isExpired;
  const statusLabel = isActive ? chalk.green('Active') : isExpired ? chalk.yellow('Expired') : chalk.red(waiver.status);

  console.log(chalk.blue('\nWaiver Details\n'));
  console.log('-'.repeat(60));
  console.log(`\nStatus: ${statusLabel}`);
  console.log(`\n${chalk.bold(waiver.title)}`);
  console.log(`   ID: ${waiver.id}`);
  console.log(`   Reason: ${waiver.reason}`);
  console.log(`   Impact Level: ${waiver.impact_level}`);
  console.log(`\nDescription:`);
  console.log(`   ${waiver.description}`);
  console.log(`\nWaived Quality Gates:`);
  waiver.gates.forEach((gate) => {
    console.log(`   - ${gate}`);
  });
  console.log(`\nMitigation Plan:`);
  console.log(`   ${waiver.mitigation_plan}`);
  console.log(`\nTimeline:`);
  console.log(`   Created: ${waiver.created_at}`);
  console.log(`   Expires: ${waiver.expires_at}`);
  if (waiver.revoked_at) {
    console.log(`   Revoked: ${waiver.revoked_at}`);
  }
  console.log(`\nApproved by: ${waiver.approved_by}\n`);

  if (isExpired && waiver.status === 'active') {
    console.log(chalk.yellow('Warning: This waiver has expired. Consider revoking it.\n'));
  }
}

/**
 * Revoke a waiver
 */
async function revokeWaiver(waiverId, options) {
  if (!waiverId) {
    console.error(chalk.red('\nWaiver ID required'));
    console.log(chalk.yellow('Usage: caws waivers revoke WV-1234\n'));
    process.exit(1);
  }

  const waiverPath = path.join(process.cwd(), WAIVER_DIR, `${waiverId}.yaml`);

  if (!fs.existsSync(waiverPath)) {
    console.error(chalk.red(`\nWaiver not found: ${waiverId}\n`));
    process.exit(1);
  }

  const content = fs.readFileSync(waiverPath, 'utf8');
  const waiver = yaml.load(content);

  if (waiver.status === 'revoked') {
    console.log(chalk.yellow(`\nWaiver ${waiverId} is already revoked\n`));
    return;
  }

  // Update waiver status
  waiver.status = 'revoked';
  waiver.revoked_at = new Date().toISOString();
  waiver.revoked_by = options.revokedBy || 'system';
  waiver.revocation_reason = options.reason || 'Manual revocation';

  // Save updated waiver
  fs.writeFileSync(waiverPath, yaml.dump(waiver, { lineWidth: -1 }));

  console.log(chalk.green(`\nWaiver revoked: ${waiverId}`));
  console.log(`   Title: ${waiver.title}`);
  console.log(`   Revoked at: ${waiver.revoked_at}`);
  console.log(`   Revoked by: ${waiver.revoked_by}`);
  console.log(`   Reason: ${waiver.revocation_reason}\n`);
}

/**
 * Add waiver to active waivers file for quality gates integration
 */
async function addToActiveWaivers(waiver) {
  try {
    const waiversManager = new WaiversManager();

    // Load existing active waivers
    const activeWaivers = await waiversManager.loadActiveWaivers();

    // Check if waiver already exists
    const existingIndex = activeWaivers.findIndex((w) => w.id === waiver.id);

    // Normalize waiver format
    const normalizedWaiver = {
      id: waiver.id,
      title: waiver.title || waiver.description || waiver.id,
      reason: waiver.reason || waiver.reason_code || 'unknown',
      description: waiver.description || waiver.title || waiver.id,
      gates: Array.isArray(waiver.gates) ? waiver.gates : [waiver.gates],
      expires_at: waiver.expires_at,
      approved_by: waiver.approved_by || waiver.risk_owner || 'unknown',
      created_at: waiver.created_at || waiver.approved_at || new Date().toISOString(),
      risk_assessment: waiver.risk_assessment || {
        impact_level: waiver.impact_level || 'medium',
        mitigation_plan: waiver.mitigation || waiver.mitigation_plan || 'Unknown mitigation',
      },
      metadata: waiver.metadata || {},
    };

    if (existingIndex >= 0) {
      // Update existing waiver
      activeWaivers[existingIndex] = normalizedWaiver;
    } else {
      // Add new waiver
      activeWaivers.push(normalizedWaiver);
    }

    // Save updated active waivers
    await waiversManager.saveActiveWaivers(activeWaivers);
  } catch (error) {
    // Enhanced error logging
    console.error(`Error adding waiver to active waivers: ${error.message}`);
    console.error(error.stack);
    console.warn(`Warning: Could not add waiver to active waivers file: ${error.message}`);
    // Don't fail the waiver creation if this fails
  }
}

module.exports = { waiversCommand };
