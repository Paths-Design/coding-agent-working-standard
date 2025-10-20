/**
 * @fileoverview Spec Resolution System
 * Resolves spec files with priority: feature-specific > working-spec.yaml
 * Enables multi-agent workflows where each agent works on their own spec
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

/**
 * Spec resolution priority:
 * 1. .caws/specs/<spec-id>.yaml (feature-specific, multi-agent safe)
 * 2. .caws/working-spec.yaml (legacy, single-agent only)
 */
const SPECS_DIR = '.caws/specs';
const LEGACY_SPEC = '.caws/working-spec.yaml';
const SPECS_REGISTRY = '.caws/specs/registry.json';

/**
 * Resolve spec file path based on priority
 * @param {Object} options - Resolution options
 * @param {string} [options.specId] - Feature-specific spec ID (e.g., 'user-auth', 'FEAT-001')
 * @param {string} [options.specFile] - Explicit file path override
 * @param {boolean} [options.warnLegacy=true] - Warn when falling back to legacy spec
 * @param {boolean} [options.interactive=false] - Use interactive spec selection for multiple specs
 * @returns {Promise<{path: string, type: 'feature' | 'legacy', spec: Object}>}
 */
async function resolveSpec(options = {}) {
  const { specId, specFile, warnLegacy = true, interactive = false } = options;

  // 1. Explicit file path takes highest priority
  if (specFile) {
    const explicitPath = path.isAbsolute(specFile) ? specFile : path.join(process.cwd(), specFile);

    if (await fs.pathExists(explicitPath)) {
      const yaml = require('js-yaml');
      const content = await fs.readFile(explicitPath, 'utf8');
      const spec = yaml.load(content);

      return {
        path: explicitPath,
        type: explicitPath.includes('/specs/') ? 'feature' : 'legacy',
        spec,
      };
    }

    throw new Error(`Spec file not found: ${explicitPath}`);
  }

  // 2. Feature-specific spec (preferred for multi-agent)
  if (specId) {
    const featurePath = path.join(process.cwd(), SPECS_DIR, `${specId}.yaml`);

    if (await fs.pathExists(featurePath)) {
      const yaml = require('js-yaml');
      const content = await fs.readFile(featurePath, 'utf8');
      const spec = yaml.load(content);

      console.log(chalk.green(`✅ Using feature-specific spec: ${specId}`));

      return {
        path: featurePath,
        type: 'feature',
        spec,
      };
    }

    throw new Error(
      `Feature spec '${specId}' not found. Create it with: caws specs create ${specId}`
    );
  }

  // 3. Auto-detect from registry or list specs
  const registry = await loadSpecsRegistry();
  const specIds = Object.keys(registry.specs ?? {});

  if (specIds.length === 1) {
    // Single spec - use it automatically
    const singleSpecId = specIds[0];
    const singleSpecPath = path.join(process.cwd(), SPECS_DIR, registry.specs[singleSpecId].path);

    if (await fs.pathExists(singleSpecPath)) {
      const yaml = require('js-yaml');
      const content = await fs.readFile(singleSpecPath, 'utf8');
      const spec = yaml.load(content);

      console.log(chalk.blue(`📋 Auto-detected single spec: ${singleSpecId}`));

      return {
        path: singleSpecPath,
        type: 'feature',
        spec,
      };
    }
  } else if (specIds.length > 1) {
    // Multiple specs - require explicit selection with enhanced guidance
    console.error(chalk.red('❌ Multiple specs detected. Please specify which one:'));

    // Show specs with details
    const specsInfo = [];
    for (const id of specIds) {
      const specPath = path.join(SPECS_DIR, registry.specs[id].path);
      try {
        const content = await fs.readFile(specPath, 'utf8');
        const spec = yaml.load(content);
        const status = spec.status || 'draft';
        const type = spec.type || 'feature';
        const statusColor =
          status === 'active' ? chalk.green : status === 'completed' ? chalk.blue : chalk.yellow;
        const typeColor = SPEC_TYPES[type] ? SPEC_TYPES[type].color : chalk.white;

        console.log(
          chalk.yellow(
            `   - ${id} ${typeColor(`(${type})`)} ${statusColor(`[${status}]`)} - ${spec.title || 'Untitled'}`
          )
        );
        specsInfo.push({ id, type, status, title: spec.title || 'Untitled' });
      } catch (error) {
        console.log(chalk.yellow(`   - ${id} (error loading details)`));
        specsInfo.push({ id, type: 'unknown', status: 'unknown', title: 'Error loading' });
      }
    }

    // Interactive mode
    if (interactive) {
      try {
        const selectedSpecId = await interactiveSpecSelection(specIds);

        // Recursively resolve with the selected spec ID
        return await resolveSpec({
          specId: selectedSpecId,
          warnLegacy,
          interactive: false, // Prevent infinite recursion
        });
      } catch (error) {
        throw new Error(`Interactive selection failed: ${error.message}`);
      }
    }

    console.log(chalk.blue('\n   Usage: caws <command> --spec-id <spec-id>'));
    console.log(chalk.gray(`   Example: caws validate --spec-id ${specIds[0]}`));

    // Suggest most likely spec (active first, then by type priority)
    const priorityOrder = { active: 0, draft: 1, completed: 2 };
    const sortedSpecs = specIds.sort((a, b) => {
      const aSpec = specsInfo.find((s) => s.id === a);
      const bSpec = specsInfo.find((s) => s.id === b);
      const aPriority = priorityOrder[aSpec?.status] || 999;
      const bPriority = priorityOrder[bSpec?.status] || 999;
      if (aPriority !== bPriority) return aPriority - bPriority;

      // Then by type (feature > fix > refactor > etc.)
      const typePriority = { feature: 0, fix: 1, refactor: 2, chore: 3, docs: 4 };
      const aTypePriority = typePriority[aSpec?.type] || 999;
      const bTypePriority = typePriority[bSpec?.type] || 999;
      return aTypePriority - bTypePriority;
    });

    console.log(chalk.green('\n💡 Quick suggestion:'));
    console.log(chalk.gray(`   Try: caws <command> --spec-id ${sortedSpecs[0]}`));

    // Interactive mode suggestion
    console.log(chalk.blue('\n   Interactive mode: caws <command> --interactive-spec-selection'));

    throw new Error('Spec ID required when multiple specs exist');
  }

  // 4. Fall back to legacy working-spec.yaml (with warning)
  const legacyPath = path.join(process.cwd(), LEGACY_SPEC);

  if (await fs.pathExists(legacyPath)) {
    const yaml = require('js-yaml');
    const content = await fs.readFile(legacyPath, 'utf8');
    const spec = yaml.load(content);

    if (warnLegacy) {
      console.log(chalk.yellow('⚠️  Using legacy working-spec.yaml'));
      console.log(chalk.gray('   For multi-agent workflows, use feature-specific specs:'));
      console.log(chalk.blue('   caws specs create <feature-id>'));
      console.log('');
    }

    return {
      path: legacyPath,
      type: 'legacy',
      spec,
    };
  }

  // 5. No specs found
  throw new Error(
    'No CAWS spec found. Initialize with: caws init or create a feature spec: caws specs create <id>'
  );
}

/**
 * Load specs registry
 * @returns {Promise<Object>} Registry data
 */
async function loadSpecsRegistry() {
  const registryPath = path.join(process.cwd(), SPECS_REGISTRY);

  if (!(await fs.pathExists(registryPath))) {
    return {
      version: '1.0.0',
      specs: {},
      lastUpdated: new Date().toISOString(),
    };
  }

  try {
    const registry = await fs.readJson(registryPath);
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
 * List all available specs
 * @returns {Promise<Array<{id: string, path: string, type: string}>>}
 */
async function listAvailableSpecs() {
  const specs = [];

  // Check feature-specific specs
  const specsDir = path.join(process.cwd(), SPECS_DIR);
  if (await fs.pathExists(specsDir)) {
    const files = await fs.readdir(specsDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

    for (const file of yamlFiles) {
      if (file === 'registry.json') continue;

      const specPath = path.join(specsDir, file);
      try {
        const yaml = require('js-yaml');
        const content = await fs.readFile(specPath, 'utf8');
        const spec = yaml.load(content);

        specs.push({
          id: spec.id || path.basename(file, path.extname(file)),
          path: path.relative(process.cwd(), specPath),
          type: 'feature',
          title: spec.title || 'Untitled',
        });
      } catch (error) {
        // Skip invalid specs
      }
    }
  }

  // Check legacy working-spec.yaml
  const legacyPath = path.join(process.cwd(), LEGACY_SPEC);
  if (await fs.pathExists(legacyPath)) {
    try {
      const yaml = require('js-yaml');
      const content = await fs.readFile(legacyPath, 'utf8');
      const spec = yaml.load(content);

      specs.push({
        id: spec.id || 'working-spec',
        path: LEGACY_SPEC,
        type: 'legacy',
        title: spec.title || 'Legacy Working Spec',
      });
    } catch (error) {
      // Skip invalid spec
    }
  }

  return specs;
}

/**
 * Interactive spec selection using readline
 * @param {string[]} specIds - Available spec IDs
 * @returns {Promise<string>} Selected spec ID
 */
async function interactiveSpecSelection(specIds) {
  return new Promise((resolve, reject) => {
    const readline = require('readline');

    console.log(chalk.blue('\n📋 Interactive Spec Selection'));
    console.log(chalk.gray('Select which spec to use:\n'));

    specIds.forEach((id, index) => {
      console.log(chalk.yellow(`${index + 1}. ${id}`));
    });

    console.log(chalk.gray('\nEnter number (1-' + specIds.length + ') or spec ID directly: '));

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question('> ', (answer) => {
      rl.close();

      const trimmed = answer.trim();

      // Check if it's a number
      const num = parseInt(trimmed);
      if (num >= 1 && num <= specIds.length) {
        resolve(specIds[num - 1]);
        return;
      }

      // Check if it's a direct spec ID
      if (specIds.includes(trimmed)) {
        resolve(trimmed);
        return;
      }

      reject(new Error(`Invalid selection: ${trimmed}. Please choose a valid spec ID.`));
    });
  });
}

/**
 * Check if project is using multi-spec architecture
 * @returns {Promise<{isMultiSpec: boolean, specCount: number, needsMigration: boolean}>}
 */
async function checkMultiSpecStatus() {
  const registry = await loadSpecsRegistry();
  const hasFeatureSpecs = Object.keys(registry.specs ?? {}).length > 0;
  const legacyPath = path.join(process.cwd(), LEGACY_SPEC);
  const hasLegacySpec = await fs.pathExists(legacyPath);

  return {
    isMultiSpec: hasFeatureSpecs,
    specCount: Object.keys(registry.specs ?? {}).length,
    needsMigration: hasLegacySpec && !hasFeatureSpecs,
  };
}

/**
 * Check for scope conflicts between specs
 * @param {string[]} specIds - Array of spec IDs to check
 * @returns {Promise<Array<{spec1: string, spec2: string, conflicts: string[]}>>} Array of conflicts
 */
async function checkScopeConflicts(specIds) {
  const conflicts = [];
  const specScopes = [];

  // Load all specs and their scopes
  for (const id of specIds) {
    const registry = await loadSpecsRegistry();
    const specPath = path.join(SPECS_DIR, registry.specs[id].path);

    try {
      const content = await fs.readFile(specPath, 'utf8');
      const spec = yaml.load(content);

      specScopes.push({
        id,
        scope: spec.scope || { in: [], out: [] },
        title: spec.title || id,
      });
    } catch (error) {
      // Skip specs that can't be loaded
      continue;
    }
  }

  // Check for conflicts between each pair of specs
  for (let i = 0; i < specScopes.length; i++) {
    for (let j = i + 1; j < specScopes.length; j++) {
      const spec1 = specScopes[i];
      const spec2 = specScopes[j];

      const spec1Paths = new Set(spec1.scope.in || []);
      const spec2Paths = new Set(spec2.scope.in || []);

      // Find overlapping paths
      const overlappingPaths = [];
      for (const path1 of spec1Paths) {
        for (const path2 of spec2Paths) {
          if (pathsOverlap(path1, path2)) {
            overlappingPaths.push(`${path1} ↔ ${path2}`);
          }
        }
      }

      if (overlappingPaths.length > 0) {
        conflicts.push({
          spec1: spec1.id,
          spec2: spec2.id,
          conflicts: overlappingPaths,
          severity: 'warning', // Could be 'error' for stricter enforcement
        });
      }
    }
  }

  return conflicts;
}

/**
 * Check if two paths overlap (simplified implementation)
 * @param {string} path1 - First path
 * @param {string} path2 - Second path
 * @returns {boolean} True if paths overlap
 */
function pathsOverlap(path1, path2) {
  // Normalize paths (remove leading/trailing slashes, handle wildcards)
  const normalizePath = (p) => p.replace(/^\/+|\/+$/g, '').replace(/\*/g, '.*');

  // Simple check: if one path is a substring of another or vice versa
  const normalized1 = normalizePath(path1);
  const normalized2 = normalizePath(path2);

  // Check for exact match or substring relationships
  return (
    normalized1 === normalized2 ||
    normalized1.includes(normalized2) ||
    normalized2.includes(normalized1)
  );
}

/**
 * Suggest migration from legacy to multi-spec
 * @returns {Promise<void>}
 */
async function suggestMigration() {
  const status = await checkMultiSpecStatus();

  if (status.needsMigration) {
    console.log(chalk.yellow('\n⚠️  Migration Recommended: Single-Spec → Multi-Spec'));
    console.log(chalk.gray('   Your project uses the legacy working-spec.yaml'));
    console.log(chalk.gray('   For multi-agent workflows, migrate to feature-specific specs:\n'));
    console.log(chalk.blue('   1. caws specs create <feature-id>'));
    console.log(chalk.blue('   2. Copy relevant content from working-spec.yaml'));
    console.log(chalk.blue('   3. Update agents to use --spec-id <feature-id>'));
    console.log(chalk.gray('\n   See: docs/guides/multi-agent-migration.md\n'));
  }
}

// Feature breakdown logic (moved from specs.js to avoid circular dependency)
function suggestFeatureBreakdown(legacySpec) {
  const features = [];

  if (legacySpec.acceptance && legacySpec.acceptance.length > 0) {
    // Group acceptance criteria by logical features
    const criteriaByFeature = {};

    legacySpec.acceptance.forEach((criterion, index) => {
      // Simple heuristic: extract feature from criterion description (check all fields)
      const fullDescription = [
        criterion.given || '',
        criterion.when || '',
        criterion.then || '',
        criterion.description || '',
        criterion.title || `A${index + 1}`,
      ].join(' ');
      const words = fullDescription.toLowerCase().split(' ');

      // Look for common feature keywords
      const featureKeywords = {
        auth: 'Authentication',
        login: 'Authentication',
        payment: 'Payment System',
        billing: 'Billing',
        dashboard: 'Dashboard',
        admin: 'Admin Panel',
        api: 'API',
        database: 'Data Layer',
        ui: 'User Interface',
        email: 'Email System',
        notification: 'Notifications',
        report: 'Reporting',
        search: 'Search',
        filter: 'Filtering',
        user: 'User Management',
      };

      let featureKey = 'general';
      let featureTitle = 'General Features';

      for (const [keyword, title] of Object.entries(featureKeywords)) {
        if (words.some((word) => word.includes(keyword))) {
          featureKey = keyword;
          featureTitle = title;
          break;
        }
      }

      if (!criteriaByFeature[featureKey]) {
        criteriaByFeature[featureKey] = {
          id: featureKey,
          title: featureTitle,
          criteria: [],
          scope: { in: [], out: [] },
        };
      }

      criteriaByFeature[featureKey].criteria.push(criterion);
    });

    // Convert to feature objects
    Object.values(criteriaByFeature).forEach((feature) => {
      // Suggest scope based on feature type
      const scopeSuggestions = {
        user: { in: ['src/users/', 'tests/users/'], out: ['src/payments/', 'src/admin/'] },
        auth: { in: ['src/auth/', 'tests/auth/'], out: ['src/payments/', 'src/admin/'] },
        payment: { in: ['src/payments/', 'tests/payments/'], out: ['src/users/', 'src/admin/'] },
        dashboard: {
          in: ['src/dashboard/', 'tests/dashboard/'],
          out: ['src/payments/', 'src/users/'],
        },
        admin: { in: ['src/admin/', 'tests/admin/'], out: ['src/payments/', 'src/users/'] },
        api: { in: ['src/api/', 'tests/api/'], out: ['src/dashboard/', 'src/admin/'] },
        general: { in: ['src/', 'tests/'], out: [] },
      };

      const suggestion = scopeSuggestions[feature.id] || scopeSuggestions.general;
      feature.scope = suggestion;

      features.push(feature);
    });
  } else {
    // Fallback: create a single feature
    features.push({
      id: 'main-feature',
      title: legacySpec.title || 'Main Feature',
      criteria: legacySpec.acceptance || [],
      scope: {
        in: ['src/', 'tests/'],
        out: [],
      },
    });
  }

  return features;
}

module.exports = {
  resolveSpec,
  listAvailableSpecs,
  checkMultiSpecStatus,
  checkScopeConflicts,
  suggestMigration,
  interactiveSpecSelection,
  loadSpecsRegistry,
  suggestFeatureBreakdown,
  SPECS_DIR,
  LEGACY_SPEC,
  SPECS_REGISTRY,
};
