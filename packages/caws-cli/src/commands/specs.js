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
const { question, closeReadline } = require('../utils/promise-utils');
const { SPEC_TYPES } = require('../constants/spec-types');

// Import suggestFeatureBreakdown from spec-resolver
const { suggestFeatureBreakdown } = require('../utils/spec-resolver');
const { findProjectRoot } = require('../utils/detection');
const { loadRegistry: loadWorktreeRegistry, getRepoRoot } = require('../worktree/worktree-manager');

/**
 * Check if a spec is referenced by any active worktree.
 * Returns the list of worktree names that reference it, or empty array.
 * @param {string} specId - Spec identifier to check
 * @returns {string[]} Names of worktrees referencing this spec
 */
function getWorktreesReferencingSpec(specId) {
  try {
    const root = getRepoRoot();
    const registry = loadWorktreeRegistry(root);
    const matches = [];
    for (const [name, entry] of Object.entries(registry.worktrees || {})) {
      if (
        entry.specId === specId &&
        entry.status !== 'destroyed' &&
        entry.status !== 'merged'
      ) {
        matches.push(name);
      }
    }
    return matches;
  } catch {
    // If worktree registry can't be loaded (e.g., no .caws dir), no conflict
    return [];
  }
}

/**
 * Specs directory structure — anchored to the CAWS project root,
 * not process.cwd(), so the CLI works from subdirectories and monorepos.
 */
function getSpecsDir() {
  return path.join(findProjectRoot(), '.caws', 'specs');
}
function getSpecsRegistry() {
  return path.join(findProjectRoot(), '.caws', 'specs', 'registry.json');
}
// Legacy constants kept for backward compatibility in tests
const SPECS_DIR = '.caws/specs';
const SPECS_REGISTRY = '.caws/specs/registry.json';

/**
 * Load specs registry
 * @returns {Promise<Object>} Registry data
 */
async function loadSpecsRegistry() {
  try {
    const registryPath = getSpecsRegistry();
    if (!(await fs.pathExists(registryPath))) {
      return {
        version: '1.0.0',
        specs: {},
        lastUpdated: new Date().toISOString(),
      };
    }

    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
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
  const registryPath = getSpecsRegistry();
  await fs.ensureDir(path.dirname(registryPath));
  registry.lastUpdated = new Date().toISOString();
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
}

/**
 * Read and validate a spec YAML file that was just written.
 * This catches malformed YAML and duplicate keys before registry sync.
 * @param {string} filePath - Absolute path to the spec file
 * @returns {Promise<Object>} Parsed spec object
 */
async function validateAndReadSpecFile(filePath) {
  const writtenContent = await fs.readFile(filePath, 'utf8');
  const parsed = yaml.load(writtenContent);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Failed to parse written spec file - invalid YAML structure');
  }

  const { validateWorkingSpec } = require('../validation/spec-validation');
  const validation = validateWorkingSpec(parsed);

  if (!validation.valid) {
    const errorMessages = validation.errors
      .map((e) => `${e.instancePath}: ${e.message}`)
      .join('; ');
    throw new Error(`Spec validation failed: ${errorMessages}`);
  }

  return parsed;
}

/**
 * Build the registry entry from the parsed spec content instead of caller assumptions.
 * @param {Object} spec - Parsed spec object
 * @param {string} fileName - Registry path for the spec
 * @param {string|null} owner - Session owner for the registry entry
 * @returns {Object} Registry entry
 */
function buildRegistryEntryFromSpec(spec, fileName, owner = null) {
  return {
    path: fileName,
    type: spec.type || 'feature',
    status: spec.status || 'draft',
    created_at: spec.created_at || new Date().toISOString(),
    updated_at: spec.updated_at || new Date().toISOString(),
    owner,
  };
}

/**
 * Backfill legacy sparse specs so write-time validation can succeed when
 * update/merge flows touch older files created before the stricter schema.
 * @param {Object} spec - Spec content to normalize
 * @returns {Object} Normalized spec content
 */
function normalizeSpecForValidation(spec = {}) {
  const normalizedRiskTier =
    typeof spec.risk_tier === 'string'
      ? parseInt(spec.risk_tier.replace(/^T/i, ''), 10) || 3
      : spec.risk_tier || 3;

  return {
    type: 'feature',
    status: 'draft',
    risk_tier: normalizedRiskTier,
    mode: 'standard',
    blast_radius: {
      modules: [],
      data_migration: false,
    },
    operational_rollback_slo: '5m',
    scope: {
      in: ['src/', 'tests/'],
      out: ['node_modules/', 'dist/', 'build/'],
    },
    invariants: ['System maintains data consistency'],
    acceptance: [],
    acceptance_criteria: [],
    non_functional: {
      a11y: [],
      perf: {},
      security: [],
    },
    contracts: [],
    ...spec,
    blast_radius: {
      modules: [],
      data_migration: false,
      ...(spec.blast_radius || {}),
    },
    scope: {
      in: ['src/', 'tests/'],
      out: ['node_modules/', 'dist/', 'build/'],
      ...(spec.scope || {}),
    },
    non_functional: {
      a11y: [],
      perf: {},
      security: [],
      ...(spec.non_functional || {}),
    },
    acceptance: Array.isArray(spec.acceptance)
      ? spec.acceptance
      : Array.isArray(spec.acceptance_criteria)
        ? spec.acceptance_criteria
        : [],
    acceptance_criteria: Array.isArray(spec.acceptance_criteria)
      ? spec.acceptance_criteria
      : Array.isArray(spec.acceptance)
        ? spec.acceptance
        : [],
  };
}

/**
 * List all spec files in the specs directory
 * @returns {Promise<Array>} Array of spec file info
 */
async function listSpecFiles() {
  const specsDir = getSpecsDir();
  if (!(await fs.pathExists(specsDir))) {
    return [];
  }

  const files = await fs.readdir(specsDir, { recursive: true });
  const yamlFiles = files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));

  const specs = [];
  for (const file of yamlFiles) {
    const filePath = path.join(specsDir, file);
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
  const specsDir = getSpecsDir();
  const existingSpecPath = path.join(specsDir, `${id}.yaml`);
  const specExists = await fs.pathExists(existingSpecPath);

  // Handle conflict resolution
  let answer = null;

  if (specExists && !force) {
    if (interactive) {
      console.log(chalk.yellow(`Spec '${id}' already exists.`));
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
        console.log(chalk.blue('Spec creation canceled.'));
        return null;
      } else if (answer === 'rename') {
        // Generate new name with valid PREFIX-NUMBER format
        // Extract prefix from existing ID or use default
        const prefixMatch = id.match(/^([A-Z]+)-\d+$/);
        const prefix = prefixMatch ? prefixMatch[1] : 'FEAT';
        // Generate sequential number based on timestamp
        const number = Date.now().toString().slice(-6); // Last 6 digits of timestamp
        const newId = `${prefix}-${number}`;
        console.log(chalk.blue(`Creating spec with new name: ${newId}`));
        return await createSpec(newId, { ...options, interactive: false });
      } else if (answer === 'merge') {
        // Merge new spec data with existing spec
        console.log(chalk.blue('Merging with existing spec...'));
        return await mergeSpec(id, options);
      } else if (answer === 'override') {
        console.log(chalk.yellow('Overriding existing spec...'));
      }
    } else {
      console.error(chalk.red(`Spec '${id}' already exists.`));
      console.error(
        chalk.yellow('Use --force to override, or --interactive for conflict resolution.')
      );
      throw new Error(`Spec '${id}' already exists. Use --force to override.`);
    }
  }

  // If we got here via override choice, check ownership and worktree associations
  if (specExists && (force || answer === 'override')) {
    // Check session ownership — only the creator session can override
    const registry = await loadSpecsRegistry();
    const existingEntry = registry.specs[id];
    const currentSession = process.env.CLAUDE_SESSION_ID || null;
    if (existingEntry?.owner && currentSession && existingEntry.owner !== currentSession) {
      throw new Error(
        `Cannot override spec '${id}': owned by another session (${existingEntry.owner}). ` +
          `Only the creator session can override a spec. Create a new spec with a different ID instead.`
      );
    }

    // Check for active worktree associations
    const referencingWorktrees = getWorktreesReferencingSpec(id);
    if (referencingWorktrees.length > 0) {
      const names = referencingWorktrees.join(', ');
      throw new Error(
        `Cannot override spec '${id}': active worktree(s) [${names}] reference it. ` +
          `Destroy the worktree(s) first with 'caws worktree destroy <name>', or create a new spec with a different ID.`
      );
    }
    console.log(chalk.yellow('Overriding existing spec...'));
  }

  // Ensure specs directory exists
  await fs.ensureDir(specsDir);

  // Generate spec content with all required fields
  // Merge template carefully to preserve required fields and structure
  const defaultSpec = {
    id, // Always use the provided id parameter
    type,
    title,
    status: 'draft',
    risk_tier: numericRiskTier,
    mode,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Required fields for validation
    blast_radius: {
      modules: [],
      data_migration: false,
    },
    operational_rollback_slo: '5m',
    scope: {
      in: ['src/', 'tests/'],
      out: ['node_modules/', 'dist/', 'build/'],
    },
    invariants: ['System maintains data consistency'],
    acceptance: [], // Note: validation expects 'acceptance', not 'acceptance_criteria'
    acceptance_criteria: [], // Keep for backward compatibility
    non_functional: {
      a11y: [],
      perf: {},
      security: [],
    },
    contracts: [],
  };

  // Merge template, but preserve required structure
  // Map template.criteria to acceptance if present
  const templateAcceptance = template?.criteria || template?.acceptance;

  const specContent = {
    ...defaultSpec,
    ...(template || {}),
    // Always preserve these critical fields
    id, // Never allow template to override id
    // Map criteria to acceptance if template uses criteria
    acceptance: templateAcceptance || defaultSpec.acceptance,
    acceptance_criteria: templateAcceptance || defaultSpec.acceptance_criteria,
    // Deep merge scope if template provides it
    scope: template?.scope
      ? {
          in: template.scope.in || defaultSpec.scope.in,
          out: template.scope.out || defaultSpec.scope.out,
        }
      : defaultSpec.scope,
    // Deep merge blast_radius if template provides it
    blast_radius: template?.blast_radius
      ? {
          modules: template.blast_radius.modules || defaultSpec.blast_radius.modules,
          data_migration:
            template.blast_radius.data_migration !== undefined
              ? template.blast_radius.data_migration
              : defaultSpec.blast_radius.data_migration,
        }
      : defaultSpec.blast_radius,
    // Deep merge non_functional if template provides it
    non_functional: template?.non_functional
      ? {
          a11y: template.non_functional.a11y || defaultSpec.non_functional.a11y,
          perf: template.non_functional.perf || defaultSpec.non_functional.perf,
          security: template.non_functional.security || defaultSpec.non_functional.security,
        }
      : defaultSpec.non_functional,
  };

  // Create file path
  const fileName = `${id}.yaml`;
  const filePath = path.join(specsDir, fileName);

  // Write spec file
  const yamlContent = yaml.dump(specContent, { indent: 2 });
  await fs.writeFile(filePath, yamlContent);

  // Validate written file (YAML syntax and structure)
  let parsedSpec;
  try {
    parsedSpec = await validateAndReadSpecFile(filePath);
  } catch (error) {
    // Clean up invalid file if it exists
    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
    }

    // Re-throw with helpful message
    if (error.message.includes('YAMLException') || error.message.includes('yaml')) {
      throw new Error(
        `Failed to create valid spec: YAML syntax error. ${error.message}\n` +
          'Consider using the interactive mode: caws specs create <id> --interactive'
      );
    }
    throw error;
  }

  // Update registry
  const registry = await loadSpecsRegistry();
  registry.specs[id] = buildRegistryEntryFromSpec(
    parsedSpec,
    fileName,
    process.env.CLAUDE_SESSION_ID || null
  );
  await saveSpecsRegistry(registry);

  return {
    id,
    path: fileName,
    type: parsedSpec.type || type,
    title: parsedSpec.title || title,
    status: parsedSpec.status || 'draft',
    risk_tier: parsedSpec.risk_tier || numericRiskTier,
    mode: parsedSpec.mode || mode,
    created_at: parsedSpec.created_at || specContent.created_at,
    updated_at: parsedSpec.updated_at || specContent.updated_at,
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

  const specPath = path.join(getSpecsDir(), registry.specs[id].path);

  try {
    const content = await fs.readFile(specPath, 'utf8');
    return yaml.load(content);
  } catch (error) {
    throw new Error(`Failed to load spec '${id}' from ${specPath}: ${error.message}`);
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

  // Validate status if being updated
  if (updates.status) {
    const { SPEC_STATUSES } = require('../constants/spec-types');
    if (!SPEC_STATUSES[updates.status]) {
      throw new Error(
        `Invalid status '${updates.status}'. Valid values: ${Object.keys(SPEC_STATUSES).join(', ')}`
      );
    }
  }

  // Apply updates
  const updatedSpec = {
    ...spec,
    ...updates,
    updated_at: new Date().toISOString(),
  };
  const normalizedSpec = normalizeSpecForValidation(updatedSpec);

  // Write back to file
  const registry = await loadSpecsRegistry();
  const specPath = path.join(getSpecsDir(), registry.specs[id].path);
  const previousContent = await fs.readFile(specPath, 'utf8');
  await fs.writeFile(specPath, yaml.dump(normalizedSpec, { indent: 2 }));

  let parsedSpec;
  try {
    parsedSpec = await validateAndReadSpecFile(specPath);
  } catch (error) {
    await fs.writeFile(specPath, previousContent);
    throw new Error(`Failed to update spec '${id}': ${error.message}`);
  }

  registry.specs[id] = buildRegistryEntryFromSpec(
    parsedSpec,
    registry.specs[id].path,
    registry.specs[id].owner || null
  );
  await saveSpecsRegistry(registry);

  return true;
}

/**
 * Merge new spec data with an existing spec
 * Combines acceptance criteria, updates metadata, preserves history
 * @param {string} id - Spec identifier
 * @param {Object} options - Options including new spec data to merge
 * @returns {Promise<Object>} Merged spec
 */
async function mergeSpec(id, options = {}) {
  const existingSpec = await loadSpec(id);
  if (!existingSpec) {
    throw new Error(`Spec '${id}' not found`);
  }

  console.log(chalk.blue(`\nMerging into existing spec: ${id}`));
  console.log(chalk.gray('==============================================\n'));

  // Show existing spec summary
  console.log(chalk.gray(`Existing spec:`));
  console.log(chalk.gray(`   Title: ${existingSpec.title}`));
  console.log(chalk.gray(`   Status: ${existingSpec.status}`));
  console.log(
    chalk.gray(`   Acceptance Criteria: ${existingSpec.acceptance_criteria?.length || 0}`)
  );
  console.log('');

  // Prepare merge data from options
  const {
    title: newTitle,
    description: newDescription,
    acceptance_criteria: newCriteria,
    mode: newMode,
    risk_tier: newRiskTier,
  } = options;

  const mergedSpec = { ...existingSpec };

  // Track what was merged
  const mergeLog = [];

  // Merge title (prefer new if provided)
  if (newTitle && newTitle !== existingSpec.title) {
    mergedSpec.title = newTitle;
    mergeLog.push(`Title updated: "${existingSpec.title}" → "${newTitle}"`);
  }

  // Merge description
  if (newDescription) {
    if (existingSpec.description) {
      mergedSpec.description = `${existingSpec.description}\n\n---\n\n${newDescription}`;
      mergeLog.push('Description appended');
    } else {
      mergedSpec.description = newDescription;
      mergeLog.push('Description added');
    }
  }

  // Merge acceptance criteria (append new ones, avoid duplicates)
  if (newCriteria && Array.isArray(newCriteria) && newCriteria.length > 0) {
    const existingCriteria = existingSpec.acceptance_criteria || [];
    const existingIds = new Set(existingCriteria.map((c) => c.id));

    const criteriaToAdd = newCriteria.filter((c) => !existingIds.has(c.id));
    if (criteriaToAdd.length > 0) {
      mergedSpec.acceptance_criteria = [...existingCriteria, ...criteriaToAdd];
      mergeLog.push(`Added ${criteriaToAdd.length} new acceptance criteria`);
    }

    // Also update the 'acceptance' array if it exists
    if (existingSpec.acceptance) {
      const existingAcceptIds = new Set(existingSpec.acceptance.map((a) => a.id));
      const acceptToAdd = newCriteria.filter((c) => !existingAcceptIds.has(c.id));
      if (acceptToAdd.length > 0) {
        mergedSpec.acceptance = [...existingSpec.acceptance, ...acceptToAdd];
      }
    }
  }

  // Merge mode (prefer higher tier if both provided)
  if (newMode && newMode !== existingSpec.mode) {
    // Mode priority: crisis > standard > minimal
    const modePriority = { minimal: 1, standard: 2, crisis: 3 };
    if ((modePriority[newMode] || 0) > (modePriority[existingSpec.mode] || 0)) {
      mergedSpec.mode = newMode;
      mergeLog.push(`Mode upgraded: ${existingSpec.mode} → ${newMode}`);
    }
  }

  // Merge risk tier (prefer higher risk if both provided)
  if (newRiskTier && newRiskTier !== existingSpec.risk_tier) {
    // Risk priority: T1 > T2 > T3
    const riskPriority = { T3: 1, T2: 2, T1: 3, 3: 1, 2: 2, 1: 3 };
    if ((riskPriority[newRiskTier] || 0) > (riskPriority[existingSpec.risk_tier] || 0)) {
      mergedSpec.risk_tier = newRiskTier;
      mergeLog.push(`Risk tier updated: ${existingSpec.risk_tier} → ${newRiskTier}`);
    }
  }

  // Update metadata
  mergedSpec.updated_at = new Date().toISOString();

  // Add merge history entry
  if (!mergedSpec.history) {
    mergedSpec.history = [];
  }
  mergedSpec.history.push({
    action: 'merge',
    timestamp: new Date().toISOString(),
    changes: mergeLog,
  });

  // Save merged spec
  await updateSpec(id, mergedSpec);

  // Display merge results
  console.log(chalk.green('Merge completed:'));
  if (mergeLog.length > 0) {
    mergeLog.forEach((change) => {
      console.log(chalk.gray(`   - ${change}`));
    });
  } else {
    console.log(chalk.gray('   - No changes needed (specs were identical)'));
  }
  console.log('');

  return mergedSpec;
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

  // Block deletion if owned by another session
  const currentSession = process.env.CLAUDE_SESSION_ID || null;
  const existingEntry = registry.specs[id];
  if (existingEntry?.owner && currentSession && existingEntry.owner !== currentSession) {
    throw new Error(
      `Cannot delete spec '${id}': owned by another session (${existingEntry.owner}). ` +
        `Only the creator session can delete a spec.`
    );
  }

  // Block deletion if active worktrees reference this spec
  const referencingWorktrees = getWorktreesReferencingSpec(id);
  if (referencingWorktrees.length > 0) {
    const names = referencingWorktrees.join(', ');
    throw new Error(
      `Cannot delete spec '${id}': active worktree(s) [${names}] reference it. ` +
        `Destroy the worktree(s) first with 'caws worktree destroy <name>'.`
    );
  }

  const specPath = path.join(getSpecsDir(), registry.specs[id].path);

  // Remove file
  await fs.remove(specPath);

  // Update registry
  delete registry.specs[id];
  await saveSpecsRegistry(registry);

  return true;
}

/**
 * Close a spec (sets status to 'closed', removing scope enforcement).
 * @param {string} id - Spec identifier
 * @returns {Promise<boolean>} Success status
 */
async function closeSpec(id) {
  const spec = await loadSpec(id);
  if (!spec) {
    return false;
  }

  const currentStatus = spec.status || 'draft';
  if (currentStatus === 'closed') {
    console.log(chalk.yellow(`Spec '${id}' is already closed.`));
    return true;
  }
  if (currentStatus === 'archived') {
    console.log(chalk.yellow(`Spec '${id}' is archived and cannot be closed.`));
    return false;
  }

  // Block closure if owned by another session
  const registry = await loadSpecsRegistry();
  const existingEntry = registry.specs[id];
  const currentSession = process.env.CLAUDE_SESSION_ID || null;
  if (existingEntry?.owner && currentSession && existingEntry.owner !== currentSession) {
    console.error(
      chalk.red(
        `Cannot close spec '${id}': owned by another session (${existingEntry.owner}). ` +
          `Only the creator session can close a spec.`
      )
    );
    return false;
  }

  // Block closure if active worktrees reference this spec (closing removes scope enforcement)
  const referencingWorktrees = getWorktreesReferencingSpec(id);
  if (referencingWorktrees.length > 0) {
    const names = referencingWorktrees.join(', ');
    console.error(
      chalk.red(
        `Cannot close spec '${id}': active worktree(s) [${names}] reference it. ` +
          `Closing would remove scope enforcement while work is in progress. ` +
          `Destroy the worktree(s) first with 'caws worktree destroy <name>'.`
      )
    );
    return false;
  }

  return await updateSpec(id, { status: 'closed' });
}

/**
 * Display specs in a formatted table
 * @param {Array} specs - Array of spec objects
 */
function displaySpecsTable(specs) {
  console.log(chalk.bold.cyan('\nCAWS Specs'));
  console.log(chalk.cyan('==============================================\n'));

  if (specs.length === 0) {
    console.log(chalk.gray('   No specs found. Create one with: caws specs create <id>'));
    return;
  }

  // Header
  console.log(chalk.bold('ID'.padEnd(15) + 'Type'.padEnd(10) + 'Status'.padEnd(12) + 'Title'));
  console.log(chalk.gray('-'.repeat(80)));

  // Sort specs by type and status priority
  const statusPriority = { active: 0, draft: 1, completed: 2, closed: 3, archived: 4 };
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

  console.log(chalk.bold.cyan(`\nSpec Details: ${spec.id}`));
  console.log(chalk.cyan('==============================================\n'));

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
      const status = criterion.completed ? chalk.green('[done]') : chalk.red('[ ]');
      console.log(
        chalk.gray(`     ${status} ${criterion.description || criterion.title || `A${index + 1}`}`)
      );
    });
  }

  if (spec.contracts && spec.contracts.length > 0) {
    console.log(chalk.gray(`\n   Contracts (${spec.contracts.length}):`));
    spec.contracts.forEach((contract) => {
      console.log(chalk.gray(`     ${contract.type}: ${contract.path}`));
    });
  }

  console.log('');
}

/**
 * Migrate from legacy working-spec.yaml to feature-specific specs
 * @param {Object} options - Migration options
 * @param {Function} [createSpecFn] - Function to create specs (for testing)
 * @returns {Promise<Object>} Migration result
 */
async function migrateFromLegacy(options = {}, createSpecFn = createSpec) {
  const fs = require('fs-extra');
  const path = require('path');
  const yaml = require('js-yaml');
  const chalk = require('chalk');

  const legacyPath = path.join(findProjectRoot(), '.caws', 'working-spec.yaml');

  if (!(await fs.pathExists(legacyPath))) {
    throw new Error('No legacy working-spec.yaml found to migrate');
  }

  console.log(chalk.blue('Migrating from legacy single-spec to multi-spec...'));

  const legacyContent = await fs.readFile(legacyPath, 'utf8');
  const legacySpec = yaml.load(legacyContent);

  if (!legacySpec) {
    throw new Error('Legacy working-spec.yaml is empty or invalid');
  }

  if (!legacySpec.acceptance || !Array.isArray(legacySpec.acceptance)) {
    throw new Error('Legacy working-spec.yaml must have an acceptance array');
  }

  // Suggest feature breakdown based on acceptance criteria
  const features = suggestFeatureBreakdown(legacySpec);

  console.log(chalk.green(`\nFound ${features.length} potential features to extract:`));
  features.forEach((feature, index) => {
    console.log(chalk.yellow(`   ${index + 1}. ${feature.id} - ${feature.title}`));
    console.log(chalk.gray(`      Scope: ${feature.scope.in.join(', ')}`));
  });

  // Interactive selection or use provided feature IDs
  let selectedFeatures = features;

  if (options.interactive) {
    selectedFeatures = await selectFeaturesInteractively(features);
    if (selectedFeatures.length === 0) {
      console.log(chalk.yellow('No features selected. Migration cancelled.'));
      return { migrated: 0, total: features.length, createdSpecs: [], legacySpec: legacySpec.id };
    }
    console.log(chalk.blue(`\nMigrating ${selectedFeatures.length} selected features`));
  }

  if (options.features && options.features.length > 0) {
    // Filter by original feature IDs (before transformation)
    selectedFeatures = features.filter((f) => options.features.includes(f.id));
    if (selectedFeatures.length === 0) {
      const errorMsg = `No features found matching: ${options.features.join(', ')}. Available features: ${features.map((f) => f.id).join(', ')}`;
      console.log(chalk.yellow(`${errorMsg}`));
      throw new Error(errorMsg);
    } else {
      console.log(chalk.blue(`\nMigrating selected features: ${options.features.join(', ')}`));
    }
  }

  // Create each feature spec
  const createdSpecs = [];
  let featureCounter = 1;
  for (const feature of selectedFeatures) {
    try {
      // Transform feature ID to proper format (PREFIX-NUMBER) if needed
      let specId = feature.id;
      if (!/^[A-Z]+-\d+$/.test(specId)) {
        // Convert 'auth' -> 'FEAT-001', 'payment' -> 'FEAT-002', etc.
        const prefix = specId.toUpperCase().replace(/[^A-Z0-9]/g, '');
        specId = `${prefix || 'FEAT'}-${String(featureCounter).padStart(3, '0')}`;
        featureCounter++;
      }

      await createSpecFn(specId, {
        type: 'feature',
        title: feature.title,
        risk_tier: 'T3', // Default tier
        mode: 'development',
        template: feature,
      });

      createdSpecs.push(specId);
      console.log(chalk.green(`   Created spec: ${specId}`));
    } catch (error) {
      // Log full error details for debugging
      console.log(chalk.red(`   Failed to create spec ${feature.id}: ${error.message}`));
      if (process.env.DEBUG_MIGRATION) {
        console.log(chalk.gray(`   Error details: ${error.stack}`));
      }
    }
  }

  console.log(
    chalk.green(`\nMigration completed! Created ${createdSpecs.length} feature specs.`)
  );

  if (createdSpecs.length > 0) {
    console.log(chalk.blue('\nNext steps:'));
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
 * Interactive feature selection for migration
 * @param {Array} features - Array of suggested features
 * @returns {Promise<Array>} Selected features
 */
async function selectFeaturesInteractively(features) {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(chalk.cyan('\nSelect features to migrate:\n'));
  features.forEach((f, i) => {
    const scope = f.scope?.in?.join(', ') || 'N/A';
    console.log(`  ${chalk.yellow(i + 1)}. ${chalk.bold(f.id || f.name)} - ${f.title || f.description}`);
    console.log(chalk.gray(`     Scope: ${scope}`));
  });
  console.log(chalk.cyan(`\nEnter numbers separated by commas, or 'all' for all features:`));
  console.log(chalk.gray(`Example: 1,3,5 or all`));

  try {
    const answer = await question(rl, '> ');
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === 'all' || trimmed === '*') {
      return features;
    }

    if (trimmed === '' || trimmed === 'none' || trimmed === 'q' || trimmed === 'quit') {
      return [];
    }

    // Parse comma-separated numbers
    const indices = trimmed
      .split(',')
      .map(n => parseInt(n.trim(), 10) - 1)
      .filter(i => !isNaN(i) && i >= 0 && i < features.length);

    // Remove duplicates and sort
    const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);

    return features.filter((_, i) => uniqueIndices.includes(i));
  } finally {
    await closeReadline(rl);
  }
}

/**
 * Ask user how to resolve spec creation conflicts
 * @returns {Promise<string>} User's choice: 'cancel', 'rename', 'merge', 'override'
 */
async function askConflictResolution() {
  const readline = require('readline');

  console.log(chalk.blue('\nConflict Resolution Options:'));
  console.log(chalk.gray("   1. Cancel - Don't create the spec"));
  console.log(chalk.gray('   2. Rename - Create with auto-generated name'));
  console.log(chalk.gray('   3. Merge - Merge with existing spec (not implemented)'));
  console.log(chalk.gray('   4. Override - Replace existing spec (use --force)'));
  console.log(chalk.yellow('\nEnter your choice (1-4) or the option name:'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await question(rl, '> ');
    const trimmed = answer.trim().toLowerCase();

    // Handle numeric choices
    if (trimmed === '1' || trimmed === 'cancel') {
      return 'cancel';
    } else if (trimmed === '2' || trimmed === 'rename') {
      return 'rename';
    } else if (trimmed === '3' || trimmed === 'merge') {
      return 'merge';
    } else if (trimmed === '4' || trimmed === 'override') {
      return 'override';
    } else {
      console.log(chalk.red('Invalid choice. Defaulting to cancel.'));
      return 'cancel';
    }
  } finally {
    await closeReadline(rl);
  }
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
            console.log(chalk.blue('No scope conflicts possible with fewer than 2 specs'));
            return outputResult({
              command: 'specs conflicts',
              conflictCount: 0,
              conflicts: [],
            });
          }

          console.log(chalk.blue(`Checking scope conflicts between ${specIds.length} specs...`));
          const conflicts = await checkScopeConflicts(specIds);

          if (conflicts.length === 0) {
            console.log(chalk.green('No scope conflicts detected'));
          } else {
            console.log(
              chalk.yellow(
                `Found ${conflicts.length} scope conflict${conflicts.length > 1 ? 's' : ''}:`
              )
            );
            conflicts.forEach((conflict) => {
              console.log(chalk.red(`   ${conflict.spec1} ↔ ${conflict.spec2}:`));
              conflict.conflicts.forEach((pathConflict) => {
                console.log(chalk.gray(`     ${pathConflict}`));
              });
            });
            console.log(
              chalk.blue('\nTip: Use non-overlapping scope.in paths to avoid conflicts')
            );
          }

          return outputResult({
            command: 'specs conflicts',
            conflictCount: conflicts.length,
            conflicts,
          });
        }

        case 'migrate': {
          // Allow tests to inject createSpec function
          const createSpecFn = options._createSpecFn || createSpec;
          const migrationOptions = { ...options };
          delete migrationOptions._createSpecFn; // Remove test-only option
          const result = await migrateFromLegacy(migrationOptions, createSpecFn);

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

          console.log(chalk.green(`Created spec: ${newSpec.id}`));
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

          console.log(chalk.green(`Updated spec: ${options.id}`));

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

          console.log(chalk.green(`Deleted spec: ${options.id}`));

          return outputResult({
            command: 'specs delete',
            spec: options.id,
          });
        }

        case 'close': {
          if (!options.id) {
            throw new Error('Spec ID is required. Usage: caws specs close <id>');
          }

          const closed = await closeSpec(options.id);
          if (!closed) {
            throw new Error(`Could not close spec '${options.id}'`);
          }

          console.log(chalk.green(`Closed spec: ${options.id} -- scope restrictions removed`));

          return outputResult({
            command: 'specs close',
            spec: options.id,
          });
        }

        case 'types': {
          console.log(chalk.bold.cyan('\nAvailable Spec Types'));
          console.log(chalk.cyan('==============================================\n'));

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
            `Unknown specs action: ${action}. Use: list, create, show, update, delete, close, conflicts, migrate, types`
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
  closeSpec,
  displaySpecsTable,
  displaySpecDetails,
  askConflictResolution,
  SPECS_DIR,
  SPECS_REGISTRY,
  SPEC_TYPES,
};
