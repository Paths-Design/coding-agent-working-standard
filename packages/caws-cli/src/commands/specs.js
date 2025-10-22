/**
 * @fileoverview CAWS Specs Command
 * Manage multiple spec files for better organization and discoverability
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { safeAsync, outputResult } = require('../error-handler');

// Import suggestFeatureBreakdown from spec-resolver
const { suggestFeatureBreakdown } = require('../utils/spec-resolver');

/**
 * Specs directory structure
 */
const SPECS_DIR = '.caws/specs';
const SPECS_REGISTRY = '.caws/specs/registry.json';

/**
 * Spec types and their metadata
 */
const SPEC_TYPES = {
  feature: {
    color: chalk.green,
    icon: '🚀',
    description: 'New feature development',
  },
  fix: {
    color: chalk.red,
    icon: '🔧',
    description: 'Bug fixes and patches',
  },
  refactor: {
    color: chalk.blue,
    icon: '♻️',
    description: 'Code refactoring and improvements',
  },
  chore: {
    color: chalk.gray,
    icon: '🧹',
    description: 'Maintenance and cleanup',
  },
  docs: {
    color: chalk.cyan,
    icon: '📚',
    description: 'Documentation updates',
  },
};

/**
 * Load specs registry
 * @returns {Promise<Object>} Registry data
 */
async function loadSpecsRegistry() {
  try {
    if (!(await fs.pathExists(SPECS_REGISTRY))) {
      return {
        version: '1.0.0',
        specs: {},
        lastUpdated: new Date().toISOString(),
      };
    }

    const registry = JSON.parse(await fs.readFile(SPECS_REGISTRY, 'utf8'));
    return registry;
  } catch (error) {
    return {
      version: '1.0.0',
      specs: {},
      lastUpdated: new Date().toISOString(),
    };
  }
}

/**
 * Save specs registry
 * @param {Object} registry - Registry data
 * @returns {Promise<void>}
 */
async function saveSpecsRegistry(registry) {
  await fs.ensureDir(path.dirname(SPECS_REGISTRY));
  registry.lastUpdated = new Date().toISOString();
  await fs.writeFile(SPECS_REGISTRY, JSON.stringify(registry, null, 2));
}

/**
 * List all spec files in the specs directory
 * @returns {Promise<Array>} Array of spec file info
 */
async function listSpecFiles() {
  if (!(await fs.pathExists(SPECS_DIR))) {
    return [];
  }

  const files = await fs.readdir(SPECS_DIR, { recursive: true });
  const yamlFiles = files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));

  const specs = [];
  for (const file of yamlFiles) {
    const filePath = path.join(SPECS_DIR, file);
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const spec = yaml.load(content);

      specs.push({
        id: spec.id || path.basename(file, path.extname(file)),
        path: file,
        type: spec.type || 'feature',
        title: spec.title || 'Untitled',
        status: spec.status || 'draft',
        risk_tier: spec.risk_tier || 'T3',
        mode: spec.mode || 'development',
        created_at: spec.created_at || new Date().toISOString(),
        updated_at: spec.updated_at || new Date().toISOString(),
      });
    } catch (error) {
      // Skip invalid spec files
      console.warn(`Warning: Could not parse spec file ${file}: ${error.message}`);
    }
  }

  return specs;
}

/**
 * Create a new spec file
 * @param {string} id - Spec identifier
 * @param {Object} options - Creation options
 * @returns {Promise<Object>} Created spec info
 */
async function createSpec(id, options = {}) {
  const {
    type = 'feature',
    title = `New ${type}`,
    risk_tier = 3, // Default to numeric 3 (low-risk)
    mode = 'development',
    template = null,
    force = false, // Override existing specs
    interactive = false, // Ask for confirmation on conflicts
  } = options;

  // Convert string tiers to numeric (handle both 'T3' and 3)
  let numericRiskTier = risk_tier;
  if (typeof risk_tier === 'string') {
    const tierMap = { T1: 1, T2: 2, T3: 3 };
    numericRiskTier = tierMap[risk_tier] || 3; // Default to 3 if invalid
  }

  // Check for existing spec
  const existingSpecPath = path.join(SPECS_DIR, `${id}.yaml`);
  const specExists = await fs.pathExists(existingSpecPath);

  // Handle conflict resolution
  let answer = null;

  if (specExists && !force) {
    if (interactive) {
      console.log(chalk.yellow(`⚠️  Spec '${id}' already exists.`));
      console.log(chalk.gray(`   Path: ${existingSpecPath}`));

      // Load existing spec to show details
      try {
        const existingContent = await fs.readFile(existingSpecPath, 'utf8');
        const existingSpec = yaml.load(existingContent);
        console.log(chalk.gray(`   Title: ${existingSpec.title || 'Untitled'}`));
        console.log(chalk.gray(`   Status: ${existingSpec.status || 'draft'}`));
        console.log(
          chalk.gray(
            `   Created: ${new Date(existingSpec.created_at || Date.now()).toLocaleDateString()}`
          )
        );
      } catch (error) {
        console.log(chalk.gray(`   (Could not load existing spec details)`));
      }

      // Ask for conflict resolution
      answer = await askConflictResolution();

      if (answer === 'cancel') {
        console.log(chalk.blue('ℹ️  Spec creation canceled.'));
        return null;
      } else if (answer === 'rename') {
        // Generate new name with timestamp suffix
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const newId = `${id}-${timestamp}`;
        console.log(chalk.blue(`📝 Creating spec with new name: ${newId}`));
        return await createSpec(newId, { ...options, interactive: false });
      } else if (answer === 'merge') {
        console.log(chalk.yellow('🔄 Merge functionality not yet implemented.'));
        console.log(chalk.blue('💡 For now, consider creating with a different name.'));
        return null;
      } else if (answer === 'override') {
        console.log(chalk.yellow('⚠️  Overriding existing spec...'));
      }
    } else {
      console.error(chalk.red(`❌ Spec '${id}' already exists.`));
      console.error(
        chalk.yellow('💡 Use --force to override, or --interactive for conflict resolution.')
      );
      throw new Error(`Spec '${id}' already exists. Use --force to override.`);
    }
  }

  // If we got here via override choice, proceed with creation
  if (specExists && (force || answer === 'override')) {
    console.log(chalk.yellow('⚠️  Overriding existing spec...'));
  }

  // Ensure specs directory exists
  await fs.ensureDir(SPECS_DIR);

  // Generate spec content
  const specContent = {
    id,
    type,
    title,
    status: 'draft',
    risk_tier: numericRiskTier,
    mode,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    acceptance_criteria: [],
    ...(template || {}),
  };

  // Create file path
  const fileName = `${id}.yaml`;
  const filePath = path.join(SPECS_DIR, fileName);

  // Write spec file
  await fs.writeFile(filePath, yaml.dump(specContent, { indent: 2 }));

  // Update registry
  const registry = await loadSpecsRegistry();
  registry.specs[id] = {
    path: fileName,
    type,
    status: 'draft',
    created_at: specContent.created_at,
    updated_at: specContent.updated_at,
  };
  await saveSpecsRegistry(registry);

  return {
    id,
    path: fileName,
    type,
    title,
    status: 'draft',
    risk_tier: numericRiskTier,
    mode,
    created_at: specContent.created_at,
    updated_at: specContent.updated_at,
  };
}

/**
 * Load a specific spec file
 * @param {string} id - Spec identifier
 * @returns {Promise<Object|null>} Spec data or null
 */
async function loadSpec(id) {
  const registry = await loadSpecsRegistry();

  if (!registry.specs[id]) {
    return null;
  }

  const specPath = path.join(SPECS_DIR, registry.specs[id].path);

  try {
    const content = await fs.readFile(specPath, 'utf8');
    return yaml.load(content);
  } catch (error) {
    return null;
  }
}

/**
 * Update a spec file
 * @param {string} id - Spec identifier
 * @param {Object} updates - Updates to apply
 * @returns {Promise<boolean>} Success status
 */
async function updateSpec(id, updates = {}) {
  const spec = await loadSpec(id);

  if (!spec) {
    return false;
  }

  // Apply updates
  const updatedSpec = {
    ...spec,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  // Update registry
  const registry = await loadSpecsRegistry();
  registry.specs[id].updated_at = updatedSpec.updated_at;
  if (updates.status) {
    registry.specs[id].status = updates.status;
  }
  await saveSpecsRegistry(registry);

  // Write back to file
  const specPath = path.join(SPECS_DIR, registry.specs[id].path);
  await fs.writeFile(specPath, yaml.dump(updatedSpec, { indent: 2 }));

  return true;
}

/**
 * Delete a spec file
 * @param {string} id - Spec identifier
 * @returns {Promise<boolean>} Success status
 */
async function deleteSpec(id) {
  const registry = await loadSpecsRegistry();

  if (!registry.specs[id]) {
    return false;
  }

  const specPath = path.join(SPECS_DIR, registry.specs[id].path);

  // Remove file
  await fs.remove(specPath);

  // Update registry
  delete registry.specs[id];
  await saveSpecsRegistry(registry);

  return true;
}

/**
 * Display specs in a formatted table
 * @param {Array} specs - Array of spec objects
 */
function displaySpecsTable(specs) {
  console.log(chalk.bold.cyan('\n📋 CAWS Specs'));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  if (specs.length === 0) {
    console.log(chalk.gray('   No specs found. Create one with: caws specs create <id>'));
    return;
  }

  // Header
  console.log(chalk.bold('ID'.padEnd(15) + 'Type'.padEnd(10) + 'Status'.padEnd(12) + 'Title'));
  console.log(chalk.gray('─'.repeat(80)));

  // Sort specs by type and status priority
  const statusPriority = { active: 0, draft: 1, completed: 2, archived: 3 };
  const sortedSpecs = specs.sort((a, b) => {
    const typeDiff = a.type.localeCompare(b.type);
    if (typeDiff !== 0) return typeDiff;
    return (statusPriority[a.status] || 999) - (statusPriority[b.status] || 999);
  });

  sortedSpecs.forEach((spec) => {
    const specType = SPEC_TYPES[spec.type] || SPEC_TYPES.feature;
    const typeColor = specType.color;

    const statusColor =
      spec.status === 'active'
        ? chalk.green
        : spec.status === 'draft'
          ? chalk.yellow
          : spec.status === 'completed'
            ? chalk.blue
            : chalk.gray;

    console.log(
      spec.id.padEnd(15) +
        typeColor(spec.type.padEnd(9)) +
        statusColor(spec.status.padEnd(11)) +
        chalk.white(spec.title)
    );
  });

  console.log('');
}

/**
 * Display detailed spec information
 * @param {Object} spec - Spec object
 */
function displaySpecDetails(spec) {
  const specType = SPEC_TYPES[spec.type] || SPEC_TYPES.feature;
  const typeColor = specType.color;

  console.log(chalk.bold.cyan(`\n📋 Spec Details: ${spec.id}`));
  console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

  console.log(`${specType.icon} ${typeColor(spec.type.toUpperCase())} - ${spec.title}`);
  console.log(
    chalk.gray(`   Status: ${spec.status} | Risk Tier: ${spec.risk_tier} | Mode: ${spec.mode}`)
  );
  console.log(chalk.gray(`   Created: ${new Date(spec.created_at).toLocaleDateString()}`));
  console.log(chalk.gray(`   Updated: ${new Date(spec.updated_at).toLocaleDateString()}`));

  if (spec.description) {
    console.log(chalk.gray(`\n   Description: ${spec.description}`));
  }

  if (spec.acceptance_criteria && spec.acceptance_criteria.length > 0) {
    console.log(chalk.gray(`\n   Acceptance Criteria (${spec.acceptance_criteria.length}):`));
    spec.acceptance_criteria.forEach((criterion, index) => {
      const status = criterion.completed ? chalk.green('✓') : chalk.red('○');
      console.log(
        chalk.gray(`     ${status} ${criterion.description || criterion.title || `A${index + 1}`}`)
      );
    });
  }

  if (spec.contracts && spec.contracts.length > 0) {
    console.log(chalk.gray(`\n   Contracts (${spec.contracts.length}):`));
    spec.contracts.forEach((contract) => {
      console.log(chalk.gray(`     📄 ${contract.type}: ${contract.path}`));
    });
  }

  console.log('');
}

/**
 * Migrate from legacy working-spec.yaml to feature-specific specs
 * @param {Object} options - Migration options
 * @returns {Promise<Object>} Migration result
 */
async function migrateFromLegacy(options = {}) {
  const fs = require('fs-extra');
  const path = require('path');
  const yaml = require('js-yaml');
  const chalk = require('chalk');

  const legacyPath = path.join(process.cwd(), '.caws', 'working-spec.yaml');

  if (!(await fs.pathExists(legacyPath))) {
    throw new Error('No legacy working-spec.yaml found to migrate');
  }

  console.log(chalk.blue('🔄 Migrating from legacy single-spec to multi-spec...'));

  const legacyContent = await fs.readFile(legacyPath, 'utf8');
  const legacySpec = yaml.load(legacyContent);

  // Suggest feature breakdown based on acceptance criteria
  const features = suggestFeatureBreakdown(legacySpec);

  console.log(chalk.green(`\n✅ Found ${features.length} potential features to extract:`));
  features.forEach((feature, index) => {
    console.log(chalk.yellow(`   ${index + 1}. ${feature.id} - ${feature.title}`));
    console.log(chalk.gray(`      Scope: ${feature.scope.in.join(', ')}`));
  });

  // Interactive selection or use provided feature IDs
  let selectedFeatures = features;

  if (options.interactive) {
    // For now, just use all suggested features
    // In a full implementation, this would prompt for selection
    console.log(chalk.blue('\n📋 Using all suggested features for migration'));
  }

  if (options.features && options.features.length > 0) {
    selectedFeatures = features.filter((f) => options.features.includes(f.id));
    console.log(chalk.blue(`\n📋 Migrating selected features: ${options.features.join(', ')}`));
  }

  // Create each feature spec
  const createdSpecs = [];
  for (const feature of selectedFeatures) {
    try {
      await createSpec(feature.id, {
        type: 'feature',
        title: feature.title,
        risk_tier: 'T3', // Default tier
        mode: 'development',
        template: feature,
      });

      createdSpecs.push(feature.id);
      console.log(chalk.green(`   ✅ Created spec: ${feature.id}`));
    } catch (error) {
      console.log(chalk.red(`   ❌ Failed to create spec ${feature.id}: ${error.message}`));
    }
  }

  console.log(
    chalk.green(`\n🎉 Migration completed! Created ${createdSpecs.length} feature specs.`)
  );

  if (createdSpecs.length > 0) {
    console.log(chalk.blue('\n💡 Next steps:'));
    console.log(chalk.gray('   1. Review and customize each feature spec'));
    console.log(chalk.gray('   2. Update agents to use --spec-id <feature-id>'));
    console.log(chalk.gray('   3. Consider archiving legacy working-spec.yaml when ready'));
    console.log(chalk.blue('\n   Example: caws validate --spec-id user-auth'));
  }

  return {
    migrated: createdSpecs.length,
    total: selectedFeatures.length,
    createdSpecs,
    legacySpec: legacySpec.id,
  };
}

/**
 * Ask user how to resolve spec creation conflicts
 * @returns {Promise<string>} User's choice: 'cancel', 'rename', 'merge', 'override'
 */
async function askConflictResolution() {
  return new Promise((resolve) => {
    const readline = require('readline');

    console.log(chalk.blue('\n🔄 Conflict Resolution Options:'));
    console.log(chalk.gray("   1. Cancel - Don't create the spec"));
    console.log(chalk.gray('   2. Rename - Create with auto-generated name'));
    console.log(chalk.gray('   3. Merge - Merge with existing spec (not implemented)'));
    console.log(chalk.gray('   4. Override - Replace existing spec (use --force)'));

    console.log(chalk.yellow('\nEnter your choice (1-4) or the option name:'));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('> ', (answer) => {
      rl.close();

      const trimmed = answer.trim().toLowerCase();

      // Handle numeric choices
      if (trimmed === '1' || trimmed === 'cancel') {
        resolve('cancel');
      } else if (trimmed === '2' || trimmed === 'rename') {
        resolve('rename');
      } else if (trimmed === '3' || trimmed === 'merge') {
        resolve('merge');
      } else if (trimmed === '4' || trimmed === 'override') {
        resolve('override');
      } else {
        console.log(chalk.red('❌ Invalid choice. Defaulting to cancel.'));
        resolve('cancel');
      }
    });
  });
}

/**
 * Specs command handler
 * @param {string} action - Action to perform (list, create, show, update, delete, conflicts, migrate)
 * @param {Object} options - Command options
 */
async function specsCommand(action, options = {}) {
  return safeAsync(
    async () => {
      switch (action) {
        case 'list': {
          const specs = await listSpecFiles();
          displaySpecsTable(specs);

          return outputResult({
            command: 'specs list',
            count: specs.length,
            specs: specs.map((s) => ({ id: s.id, type: s.type, status: s.status })),
          });
        }

        case 'conflicts': {
          const { checkScopeConflicts } = require('../utils/spec-resolver');
          const registry = await loadSpecsRegistry();
          const specIds = Object.keys(registry.specs ?? {});

          if (specIds.length < 2) {
            console.log(chalk.blue('ℹ️  No scope conflicts possible with fewer than 2 specs'));
            return outputResult({
              command: 'specs conflicts',
              conflictCount: 0,
              conflicts: [],
            });
          }

          console.log(chalk.blue(`🔍 Checking scope conflicts between ${specIds.length} specs...`));
          const conflicts = await checkScopeConflicts(specIds);

          if (conflicts.length === 0) {
            console.log(chalk.green('✅ No scope conflicts detected'));
          } else {
            console.log(
              chalk.yellow(
                `⚠️  Found ${conflicts.length} scope conflict${conflicts.length > 1 ? 's' : ''}:`
              )
            );
            conflicts.forEach((conflict) => {
              console.log(chalk.red(`   ${conflict.spec1} ↔ ${conflict.spec2}:`));
              conflict.conflicts.forEach((pathConflict) => {
                console.log(chalk.gray(`     ${pathConflict}`));
              });
            });
            console.log(
              chalk.blue('\n💡 Tip: Use non-overlapping scope.in paths to avoid conflicts')
            );
          }

          return outputResult({
            command: 'specs conflicts',
            conflictCount: conflicts.length,
            conflicts,
          });
        }

        case 'migrate': {
          const result = await migrateFromLegacy(options);

          return outputResult({
            command: 'specs migrate',
            ...result,
          });
        }

        case 'create': {
          if (!options.id) {
            throw new Error('Spec ID is required. Usage: caws specs create <id>');
          }

          const newSpec = await createSpec(options.id, {
            type: options.type,
            title: options.title,
            risk_tier: options.tier,
            mode: options.mode,
            force: options.force,
            interactive: options.interactive,
          });

          if (!newSpec) {
            // User canceled or creation failed
            return outputResult({
              command: 'specs create',
              canceled: true,
              message: 'Spec creation was canceled or failed',
            });
          }

          console.log(chalk.green(`✅ Created spec: ${newSpec.id}`));
          displaySpecDetails(newSpec);

          return outputResult({
            command: 'specs create',
            spec: newSpec,
          });
        }

        case 'show': {
          if (!options.id) {
            throw new Error('Spec ID is required. Usage: caws specs show <id>');
          }

          const spec = await loadSpec(options.id);
          if (!spec) {
            throw new Error(`Spec '${options.id}' not found`);
          }

          displaySpecDetails(spec);

          return outputResult({
            command: 'specs show',
            spec: { id: spec.id, type: spec.type, status: spec.status },
          });
        }

        case 'update': {
          if (!options.id) {
            throw new Error('Spec ID is required. Usage: caws specs update <id>');
          }

          const updates = {};
          if (options.status) updates.status = options.status;
          if (options.title) updates.title = options.title;
          if (options.description) updates.description = options.description;

          const updated = await updateSpec(options.id, updates);
          if (!updated) {
            throw new Error(`Spec '${options.id}' not found`);
          }

          console.log(chalk.green(`✅ Updated spec: ${options.id}`));

          return outputResult({
            command: 'specs update',
            spec: options.id,
            updates,
          });
        }

        case 'delete': {
          if (!options.id) {
            throw new Error('Spec ID is required. Usage: caws specs delete <id>');
          }

          const deleted = await deleteSpec(options.id);
          if (!deleted) {
            throw new Error(`Spec '${options.id}' not found`);
          }

          console.log(chalk.green(`✅ Deleted spec: ${options.id}`));

          return outputResult({
            command: 'specs delete',
            spec: options.id,
          });
        }

        case 'types': {
          console.log(chalk.bold.cyan('\n📋 Available Spec Types'));
          console.log(chalk.cyan('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n'));

          Object.entries(SPEC_TYPES).forEach(([type, info]) => {
            console.log(`${info.icon} ${info.color(type.padEnd(10))} - ${info.description}`);
          });

          console.log('');

          return outputResult({
            command: 'specs types',
            types: Object.keys(SPEC_TYPES),
          });
        }

        default:
          throw new Error(
            `Unknown specs action: ${action}. Use: list, create, show, update, delete, conflicts, migrate, types`
          );
      }
    },
    `specs ${action}`,
    true
  );
}

module.exports = {
  specsCommand,
  loadSpecsRegistry,
  saveSpecsRegistry,
  listSpecFiles,
  createSpec,
  loadSpec,
  updateSpec,
  deleteSpec,
  displaySpecsTable,
  displaySpecDetails,
  askConflictResolution,
  SPECS_DIR,
  SPECS_REGISTRY,
  SPEC_TYPES,
};
