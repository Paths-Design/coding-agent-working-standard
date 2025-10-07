/**
 * @fileoverview Provenance Command Handler
 * Manages CAWS provenance tracking and audit trails
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');

/**
 * Provenance command handler
 * @param {string} subcommand - The subcommand to execute
 * @param {Object} options - Command options
 */
async function provenanceCommand(subcommand, options) {
  try {
    switch (subcommand) {
      case 'update':
        return await updateProvenance(options);
      case 'show':
        return await showProvenance(options);
      case 'verify':
        return await verifyProvenance(options);
      default:
        console.error(`❌ Unknown provenance subcommand: ${subcommand}`);
        console.log('Available commands: update, show, verify');
        process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Provenance command failed: ${error.message}`);
    process.exit(1);
  }
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
  const { output = '.caws/provenance' } = options;

  const chain = await loadProvenanceChain(output);

  if (chain.length === 0) {
    console.log('ℹ️  No provenance data found');
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

    const calculatedHash = crypto
      .createHash('sha256')
      .update(hashContent)
      .digest('hex');

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
 * Attempt to detect the type of agent/system making changes
 * @returns {string} Agent type identifier
 */
function detectAgentType() {
  // Check environment variables and context clues
  if (process.env.CURSOR_AGENT === 'true') {
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
};
