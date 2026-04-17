/**
 * @fileoverview CAWS Init Command Handler
 * Handles project initialization with CAWS setup
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');
const yaml = require('js-yaml');

// Import shared utilities
const { detectCAWSSetup } = require('../utils/detection');
const { detectProjectType } = require('../utils/project-analysis');
const { shouldInitInCurrentDirectory } = require('../utils/project-analysis');
const { generateWorkingSpec } = require('../generators/working-spec');
const { finalizeProject } = require('../utils/finalization');
const { scaffoldCursorHooks } = require('../scaffold/cursor-hooks');
const { scaffoldIDEIntegrations } = require('../scaffold/index');
const { updateGitignore } = require('../utils/gitignore-updater');
const { getLiteScopeDefaults } = require('../config/lite-scope');
const { scaffoldClaudeHooks } = require('../scaffold/claude-hooks');
const { setCurrentMode } = require('../config/modes');
const {
  IDE_REGISTRY,
  detectActiveIDEs,
  getRecommendedIDEs,
  parseIDESelection,
} = require('../utils/ide-detection');
// CAWSFIX-10: share the canonical spec-ID regex with the validator
const { SPEC_ID_PATTERN } = require('../validation/spec-validation');

function buildInitialFeatureSpec(specContent, fallbackId) {
  const parsed = yaml.load(specContent);
  const riskTier =
    typeof parsed.risk_tier === 'string'
      ? parseInt(parsed.risk_tier.replace(/^T/i, ''), 10) || 3
      : parsed.risk_tier || 3;
  const aiConfidenceRaw = parsed.ai_assessment?.confidence_level;
  const aiConfidence =
    typeof aiConfidenceRaw === 'number' && aiConfidenceRaw <= 1
      ? Math.max(1, Math.min(10, Math.round(aiConfidenceRaw * 10)))
      : typeof aiConfidenceRaw === 'number'
        ? Math.max(1, Math.min(10, Math.round(aiConfidenceRaw)))
        : 8;
  const normalizedContracts =
    Array.isArray(parsed.contracts) && parsed.contracts.length > 0
      ? parsed.contracts.map((contract, index) => ({
          type: ['openapi', 'graphql', 'proto', 'pact'].includes(contract?.type)
            ? contract.type
            : 'openapi',
          path:
            contract?.path ||
            (index === 0 ? 'docs/api/initial-feature.yaml' : `docs/api/contract-${index + 1}.yaml`),
        }))
      : riskTier <= 2
        ? [{ type: 'openapi', path: 'docs/api/initial-feature.yaml' }]
        : [];

  return {
    id: parsed.id || fallbackId,
    title: parsed.title || 'New CAWS Project',
    risk_tier: riskTier,
    mode: parsed.mode || 'feature',
    blast_radius: parsed.blast_radius || { modules: ['src', 'tests'], data_migration: false },
    operational_rollback_slo: parsed.operational_rollback_slo || '5m',
    scope: parsed.scope || {
      in: ['src/', 'tests/'],
      out: ['node_modules/', 'dist/', 'build/'],
    },
    invariants: Array.isArray(parsed.invariants) && parsed.invariants.length > 0
      ? parsed.invariants
      : ['System maintains data consistency'],
    acceptance: Array.isArray(parsed.acceptance) && parsed.acceptance.length > 0
      ? parsed.acceptance
      : [
          {
            id: 'A1',
            given: 'Current system state',
            when: 'the initial project is bootstrapped',
            then: 'the CAWS project should validate successfully',
          },
        ],
    non_functional: parsed.non_functional || {
      a11y: ['keyboard'],
      perf: { api_p95_ms: 250 },
      security: [],
    },
    contracts: normalizedContracts,
    observability: parsed.observability || { logs: [], metrics: [], traces: [] },
    migrations: Array.isArray(parsed.migrations) ? parsed.migrations : [],
    rollback: Array.isArray(parsed.rollback) ? parsed.rollback : [],
    ai_assessment: {
      confidence_level: aiConfidence,
      uncertainty_areas: Array.isArray(parsed.ai_assessment?.uncertainty_areas)
        ? parsed.ai_assessment.uncertainty_areas
        : [],
      recommended_pairing:
        parsed.ai_assessment?.recommended_pairing !== undefined
          ? Boolean(parsed.ai_assessment.recommended_pairing)
          : aiConfidence <= 6,
    },
  };
}

async function writeInitialSpecArtifacts(specContent, fallbackId) {
  const canonicalSpec = buildInitialFeatureSpec(specContent, fallbackId);
  const now = new Date().toISOString();
  const canonicalContent = yaml.dump(canonicalSpec, { indent: 2 });
  const specsDir = path.join('.caws', 'specs');
  const featureSpecPath = path.join(specsDir, `${canonicalSpec.id}.yaml`);
  const workingSpecPath = path.join('.caws', 'working-spec.yaml');
  const registryPath = path.join(specsDir, 'registry.json');

  await fs.ensureDir(specsDir);
  await fs.writeFile(featureSpecPath, canonicalContent);
  await fs.writeFile(workingSpecPath, canonicalContent);
  await fs.writeJson(
    registryPath,
    {
      version: '1.0.0',
      specs: {
        [canonicalSpec.id]: {
          path: `${canonicalSpec.id}.yaml`,
          type: 'feature',
          status: 'active',
          created_at: now,
          updated_at: now,
          owner: null,
        },
      },
      lastUpdated: now,
    },
    { spaces: 2 }
  );

  return {
    canonicalSpec,
    featureSpecPath,
    workingSpecPath,
  };
}

/**
 * Initialize a new project with CAWS
 */
async function initProject(projectName, options) {
  const currentDir = process.cwd();
  const isCurrentDirInit = shouldInitInCurrentDirectory(projectName, currentDir);

  if (!isCurrentDirInit && projectName !== '.') {
    console.log(chalk.cyan(`Initializing new CAWS project: ${projectName}`));
    console.log(chalk.gray(`   (Creating subdirectory: ${projectName}/)`));
  } else {
    console.log(
      chalk.cyan(`Initializing CAWS in current project: ${path.basename(currentDir)}`)
    );
    console.log(chalk.gray(`   (Adding CAWS files to existing project)`));
  }

  let answers; // Will be set either interactively or with defaults

  try {
    // Validate project name
    if (!projectName || projectName.trim() === '') {
      console.error(chalk.red('Project name is required'));
      console.error(chalk.blue('Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Special case: '.' means current directory, don't sanitize
    if (projectName !== '.') {
      // Sanitize project name
      const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      if (sanitizedName !== projectName) {
        console.warn(chalk.yellow(`Project name sanitized to: ${sanitizedName}`));
        projectName = sanitizedName;
      }
    }

    // Validate project name length
    if (projectName.length > 50) {
      console.error(chalk.red('Project name is too long (max 50 characters)'));
      console.error(chalk.blue('Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Validate project name format
    if (projectName.length === 0) {
      console.error(chalk.red('Project name cannot be empty'));
      console.error(chalk.blue('Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Check for invalid characters that should cause immediate failure
    if (projectName.includes('/') || projectName.includes('\\') || projectName.includes('..')) {
      console.error(chalk.red('Project name contains invalid characters'));
      console.error(chalk.blue('Usage: caws init <project-name>'));
      console.error(chalk.blue('Project name should not contain: / \\ ..'));
      process.exit(1);
    }

    // Determine if initializing in current directory
    const initInCurrentDir = projectName === '.';
    const targetDir = initInCurrentDir ? process.cwd() : path.resolve(process.cwd(), projectName);

    // Check if target directory already exists and has content (skip check for current directory)
    if (!initInCurrentDir && fs.existsSync(projectName)) {
      const existingFiles = fs.readdirSync(projectName);
      if (existingFiles.length > 0) {
        console.error(chalk.red(`Directory '${projectName}' already exists and contains files`));
        console.error(chalk.blue('To initialize CAWS in current directory instead:'));
        console.error(`   ${chalk.cyan('caws init .')}`);
        console.error(chalk.blue('Or choose a different name/remove existing directory'));
        process.exit(1);
      }
    }

    // Check if current directory has project files when trying to init in subdirectory
    if (!initInCurrentDir) {
      const currentDirFiles = fs.readdirSync(process.cwd());
      const hasProjectFiles = currentDirFiles.some(
        (file) => !file.startsWith('.') && file !== 'node_modules' && file !== '.git'
      );

      if (hasProjectFiles && !options.nonInteractive) {
        console.warn(chalk.yellow('Current directory contains project files'));
        console.warn(
          chalk.blue('You might want to initialize CAWS in current directory instead:')
        );
        console.warn(`   ${chalk.cyan('caws init .')}`);
        console.warn(chalk.blue('   Or continue to create subdirectory (Ctrl+C to cancel)'));
      }
    }

    // Save the original template directory before changing directories
    const cawsSetup = detectCAWSSetup(targetDir);
    const originalTemplateDir = cawsSetup?.hasTemplateDir ? cawsSetup.templateDir : null;

    // Check for existing AGENTS.md/agents.md/caws.md in target directory
    const existingAgentsMd = fs.existsSync(path.join(targetDir, 'AGENTS.md')) ||
      fs.existsSync(path.join(targetDir, 'agents.md'));
    const existingCawsMd = fs.existsSync(path.join(targetDir, 'caws.md'));

    // Create project directory and change to it (unless already in current directory)
    if (!initInCurrentDir) {
      await fs.ensureDir(projectName);
      process.chdir(projectName);
      console.log(chalk.green(`Created project directory: ${projectName}`));
    } else {
      console.log(chalk.green(`Initializing in current directory`));
    }

    // Detect and adapt to existing setup
    const currentSetup = detectCAWSSetup(process.cwd());

    if (currentSetup.type === 'new') {
      // Create minimal CAWS structure
      await fs.ensureDir('.caws');
      await fs.ensureDir('.agent');
      console.log(chalk.blue('Created basic CAWS structure'));

      // Copy AGENTS.md guide if templates are available
      if (originalTemplateDir) {
        try {
          const agentsMdSource = path.join(originalTemplateDir, 'AGENTS.md');
          let targetFile = 'AGENTS.md';

          if (fs.existsSync(agentsMdSource)) {
            if (existingAgentsMd) {
              if (options.interactive && !options.nonInteractive) {
                const overwriteAnswer = await inquirer.prompt([
                  {
                    type: 'confirm',
                    name: 'overwrite',
                    message: 'AGENTS.md already exists. Overwrite with CAWS guide?',
                    default: false,
                  },
                ]);

                if (!overwriteAnswer.overwrite) {
                  targetFile = 'caws.md';
                }
              } else {
                targetFile = 'caws.md';
                console.log(chalk.blue('AGENTS.md exists, using caws.md for CAWS guide'));
              }
            }

            if (targetFile === 'caws.md' && existingCawsMd) {
              console.log(
                chalk.yellow('Both AGENTS.md and caws.md exist, skipping guide copy')
              );
            } else {
              const agentsMdDest = path.join(process.cwd(), targetFile);
              await fs.copyFile(agentsMdSource, agentsMdDest);
              console.log(chalk.green(`Added ${targetFile} guide`));
            }
          }
        } catch (templateError) {
          console.warn(chalk.yellow('Could not copy agents guide:'), templateError.message);
        }
      }
    } else {
      // Already has CAWS setup
      console.log(chalk.green('CAWS project detected - skipping template copy'));
    }

    // Handle lite mode init path
    if (options.mode === 'lite') {
      console.log(chalk.magenta('CAWS Lite Mode — guardrails without YAML specs'));

      // Detect allowed directories
      const detectedDirs = [];
      const commonDirs = ['src/', 'lib/', 'app/', 'tests/', 'test/', 'docs/'];
      for (const dir of commonDirs) {
        if (fs.existsSync(path.join(process.cwd(), dir.replace(/\/$/, '')))) {
          detectedDirs.push(dir);
        }
      }

      let allowedDirs = detectedDirs.length > 0 ? detectedDirs : ['src/', 'tests/', 'docs/'];

      if (options.interactive && !options.nonInteractive) {
        const liteAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'projectName',
            message: 'Project name:',
            default: path.basename(process.cwd()),
          },
          {
            type: 'input',
            name: 'allowedDirs',
            message: 'Allowed directories (comma-separated):',
            default: allowedDirs.join(', '),
          },
        ]);
        allowedDirs = liteAnswers.allowedDirs.split(',').map((d) => d.trim()).filter(Boolean);
      }

      // Generate .caws/scope.json
      await fs.ensureDir('.caws');
      const scopeConfig = getLiteScopeDefaults();
      scopeConfig.allowedDirectories = allowedDirs;
      await fs.writeFile(
        path.join('.caws', 'scope.json'),
        JSON.stringify(scopeConfig, null, 2)
      );
      console.log(chalk.green('Created .caws/scope.json'));

      // Set mode to lite
      await setCurrentMode('lite');
      console.log(chalk.green('Set mode to lite in .caws/mode.json'));

      // Scaffold hooks: block-dangerous + scope-guard + lite-sprawl-check + simplification-guard
      const liteIDEs = options.ide ? parseIDESelection(options.ide) : ['claude'];
      if (liteIDEs.includes('claude')) {
        console.log(chalk.blue('Setting up lite-mode hooks...'));
        await scaffoldClaudeHooks(process.cwd(), ['safety', 'scope', 'lite']);
      }

      // Update .gitignore
      console.log(chalk.blue('Updating .gitignore...'));
      await updateGitignore(process.cwd());

      // Success
      console.log(chalk.green('\nCAWS Lite mode initialized!'));
      console.log(chalk.blue('\nGuardrails active:'));
      console.log('  - Destructive command blocking (git push --force, rm -rf, etc.)');
      console.log('  - Scope fencing (edits outside allowed directories require confirmation)');
      console.log('  - File sprawl detection (banned patterns like *-enhanced.*, *-final.*)');
      console.log('  - Simplification guard (prevents stubbing out implementations)');
      console.log(chalk.blue('\nNext steps:'));
      console.log('  1. Review .caws/scope.json and customize for your project');
      console.log('  2. Start coding — hooks will protect against common AI mistakes');
      console.log('  3. Use `caws worktree create <name>` for isolated agent workspaces');
      return;
    }

    // Handle interactive wizard or template-based setup
    if (options.interactive && !options.nonInteractive) {
      console.log(chalk.cyan('CAWS Interactive Setup Wizard'));
      console.log(chalk.blue('========================================'));
      console.log(chalk.gray('This wizard will guide you through creating a CAWS working spec\n'));

      // Detect active IDEs for pre-selecting the IDE prompt
      const detectedIDEs = detectActiveIDEs();
      const recommendedIDEs = getRecommendedIDEs();
      if (detectedIDEs.length > 0) {
        console.log(chalk.blue(`Detected IDE: ${detectedIDEs.map((id) => IDE_REGISTRY[id].name).join(', ')}`));
        console.log(chalk.gray('   (Pre-selected based on your environment)\n'));
      }

      // Detect project type
      const detectedType = detectProjectType(process.cwd());
      console.log(chalk.blue(`Detected project type: ${chalk.cyan(detectedType)}`));

      // Get package.json info if available
      let packageJson = {};
      try {
        packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
      } catch (e) {
        // No package.json, that's fine
      }

      const wizardQuestions = [
        {
          type: 'list',
          name: 'projectType',
          message: 'What type of project is this?',
          choices: [
            {
              name: 'VS Code Extension (webview, commands, integrations)',
              value: 'extension',
              short: 'VS Code Extension',
            },
            {
              name: 'Library/Package (reusable components, utilities)',
              value: 'library',
              short: 'Library',
            },
            {
              name: 'Web Application (frontend/backend, full-stack)',
              value: 'application',
              short: 'Web Application',
            },
            {
              name: 'CLI Tool (command-line interface, scripts)',
              value: 'cli',
              short: 'CLI Tool',
            },
            {
              name: 'Mobile App (iOS/Android, React Native, etc.)',
              value: 'mobile',
              short: 'Mobile App',
            },
            {
              name: 'Infrastructure (DevOps, deployment, cloud)',
              value: 'infrastructure',
              short: 'Infrastructure',
            },
            {
              name: 'Data/Analytics (ETL, ML, dashboards)',
              value: 'data',
              short: 'Data/Analytics',
            },
            {
              name: 'Game Development (Unity, Godot, custom engine)',
              value: 'game',
              short: 'Game',
            },
            {
              name: 'Other/Custom (please specify)',
              value: 'other',
              short: 'Other',
            },
          ],
          default: detectedType,
        },
        {
          type: 'input',
          name: 'projectTitle',
          message: 'What is the project title?',
          default: packageJson.name || path.basename(process.cwd()),
          validate: (input) => {
            if (input.trim().length < 3) {
              return 'Project title must be at least 3 characters';
            }
            if (input.length > 100) {
              return 'Project title must be less than 100 characters';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'projectDescription',
          message: 'Provide a brief project description (1-2 sentences):',
          default: packageJson.description || '',
          validate: (input) => {
            if (input.trim().length < 10) {
              return 'Description must be at least 10 characters';
            }
            if (input.length > 500) {
              return 'Description must be less than 500 characters';
            }
            return true;
          },
        },
        {
          type: 'list',
          name: 'riskTier',
          message: 'What risk tier does this project fall into?',
          choices: [
            {
              name: 'Tier 1 - High Risk (auth, billing, migrations, critical infrastructure)',
              value: 1,
              short: 'High Risk (T1)',
            },
            {
              name: 'Tier 2 - Medium Risk (features, APIs, data writes)',
              value: 2,
              short: 'Medium Risk (T2)',
            },
            {
              name: 'Tier 3 - Low Risk (UI, internal tools, docs)',
              value: 3,
              short: 'Low Risk (T3)',
            },
          ],
          default: 2,
        },
        {
          type: 'input',
          name: 'projectId',
          message: 'Project ID (e.g., PROJ-001, FEAT-123):',
          default: () => {
            const randomNum = Math.floor(Math.random() * 1000) + 1;
            return `PROJ-${randomNum.toString().padStart(3, '0')}`;
          },
          validate: (input) => {
            // CAWSFIX-10: accept multi-segment IDs like P03-IMPL-01
            if (!SPEC_ID_PATTERN.test(input)) {
              return 'Project ID must be in format PREFIX-NUMBER or PREFIX-SEGMENT-NUMBER (e.g., PROJ-001, P03-IMPL-01)';
            }
            if (input.length > 40) {
              return 'Project ID must be less than 40 characters';
            }
            return true;
          },
        },
        {
          type: 'checkbox',
          name: 'selectedIDEs',
          message: 'Which IDE integrations do you want to install?',
          choices: [
            {
              name: `Cursor (hooks, rules, audit) - AI-first IDE`,
              value: 'cursor',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('cursor')
                : recommendedIDEs.includes('cursor'),
            },
            {
              name: `Claude Code (safety hooks, settings)`,
              value: 'claude',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('claude')
                : recommendedIDEs.includes('claude'),
            },
            {
              name: `VS Code (settings, debug configs)`,
              value: 'vscode',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('vscode')
                : recommendedIDEs.includes('vscode'),
            },
            {
              name: `IntelliJ IDEA (run configurations)`,
              value: 'intellij',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('intellij')
                : recommendedIDEs.includes('intellij'),
            },
            {
              name: `Windsurf (CAWS workflow)`,
              value: 'windsurf',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('windsurf')
                : recommendedIDEs.includes('windsurf'),
            },
            {
              name: `GitHub Copilot (instructions)`,
              value: 'copilot',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('copilot')
                : recommendedIDEs.includes('copilot'),
            },
            {
              name: `JetBrains Junie (AI agent guidelines)`,
              value: 'junie',
              checked: options.ide
                ? parseIDESelection(options.ide).includes('junie')
                : recommendedIDEs.includes('junie'),
            },
            new inquirer.Separator(),
            {
              name: 'All IDEs (install everything)',
              value: 'all',
            },
          ],
        },
        {
          type: 'confirm',
          name: 'generateExamples',
          message: 'Generate example code and documentation?',
          default: true,
        },
      ];

      // Ask questions and get answers
      answers = await inquirer.prompt(wizardQuestions);

      // Generate working spec
      console.log(chalk.blue('\nGenerating CAWS working spec...'));
      const specContent = generateWorkingSpec(answers);

      // Write canonical feature spec plus legacy compatibility mirror
      await fs.ensureDir('.caws');
      const initialSpec = await writeInitialSpecArtifacts(specContent, answers.projectId);
      console.log(chalk.green(`Created ${initialSpec.featureSpecPath}`));
      console.log(chalk.green('Created .caws/working-spec.yaml'));
      console.log(chalk.green('Created .caws/specs/registry.json'));

      // Optionally create policy.yaml (optional - defaults work fine)
      const policyPath = path.join('.caws', 'policy.yaml');
      if (!fs.existsSync(policyPath)) {
        const { PolicyManager } = require('../policy/PolicyManager');
        const policyManager = new PolicyManager();
        const defaultPolicy = policyManager.getDefaultPolicy();
        const policyContent = yaml.dump(defaultPolicy, { indent: 2 });
        await fs.writeFile(policyPath, policyContent);
        console.log(chalk.green('Created .caws/policy.yaml (optional - defaults work fine)'));
      }

      // Generate additional files if requested
      if (answers.generateExamples) {
        console.log(chalk.blue('Generating example files...'));

        // Generate .caws/getting-started.md
        const gettingStartedGuide = `# ${answers.projectTitle} - Getting Started

## Project Overview
${answers.projectDescription}

## Risk Tier: ${answers.riskTier === 1 ? 'High (T1)' : answers.riskTier === 2 ? 'Medium (T2)' : 'Low (T3)'}

## Next Steps
1. Review and customize \`.caws/specs/${answers.projectId}.yaml\`
2. Set up your development environment
3. Implement features according to the spec
4. Run \`caws validate --spec-id ${answers.projectId}\` to check your progress

## Multi-Agent Recommendation
The initial project spec is also available in \`.caws/specs/${answers.projectId}.yaml\`.
For multi-agent work, treat feature specs in \`.caws/specs/\` as canonical and use
\`.caws/working-spec.yaml\` only as a compatibility mirror:

\`\`\`bash
caws specs create my-feature --type feature --title "My Feature"
caws validate --spec-id my-feature
\`\`\`

## Quality Gates
- **Coverage**: ${answers.riskTier === 1 ? '90%+' : answers.riskTier === 2 ? '80%+' : '70%+'}
- **Mutation Score**: ${answers.riskTier === 1 ? '70%+' : answers.riskTier === 2 ? '50%+' : '30%+'}
- **Review**: ${answers.riskTier === 1 ? 'Manual' : 'Optional'}

Happy coding! `;

        await fs.writeFile(path.join('.caws', 'getting-started.md'), gettingStartedGuide);
        console.log(chalk.green('Created .caws/getting-started.md'));

        // Generate basic directory structure
        await fs.ensureDir('tests');
        await fs.ensureDir('tests/unit');
        await fs.ensureDir('tests/integration');
        await fs.ensureDir('tests/e2e');
        await fs.ensureDir('docs');
        console.log(chalk.green('Created test and docs directories'));
      }

      // Setup selected IDE integrations
      const selectedIDEs = parseIDESelection(answers.selectedIDEs || []);

      if (selectedIDEs.includes('cursor')) {
        console.log(chalk.blue('Setting up Cursor hooks...'));
        await scaffoldCursorHooks(process.cwd());
      }

      if (selectedIDEs.length > 0) {
        console.log(chalk.blue('Setting up IDE integrations...'));
        await scaffoldIDEIntegrations(process.cwd(), { force: false, ides: selectedIDEs });
      } else {
        console.log(chalk.gray('Skipping IDE setup (none selected, run `caws scaffold --ide <ides>` later)'));
      }

      // Update .gitignore to exclude CAWS local runtime files
      console.log(chalk.blue('Updating .gitignore...'));
      const gitignoreUpdated = await updateGitignore(process.cwd());
      if (gitignoreUpdated) {
        console.log(chalk.green('Updated .gitignore to exclude CAWS local runtime files'));
        console.log(
          chalk.gray('   Tracked: Specs, policy, waivers, provenance, plans (shared with team)')
        );
        console.log(chalk.gray('   Ignored: Agent runtime, temp files, logs (local-only)'));
      }

      // Finalize project
      await finalizeProject(projectName, options, answers);
    } else {
      // Non-interactive mode - generate basic spec with defaults
      console.log(chalk.blue('Generating basic CAWS working spec...'));

      const detectedType = detectProjectType(process.cwd());
      const defaultAnswers = {
        projectType: detectedType,
        projectTitle: path.basename(process.cwd()),
        projectDescription: `A ${detectedType} project managed with CAWS`,
        riskTier: 2,
        projectId: `PROJ-${String(Math.floor(Math.random() * 1000) + 1).padStart(3, '0')}`,
        useCursorHooks: true,
        generateExamples: false,
        projectMode: 'feature',
        maxFiles: 25,
        maxLoc: 1000,
        blastModules: 'src, tests',
        dataMigration: false,
        rollbackSlo: '5m',
        projectThreats: '',
        scopeIn: 'src/, tests/',
        scopeOut: 'node_modules/, dist/, build/',
        projectInvariants: 'System maintains data consistency',
        acceptanceCriteria: 'Given current state, when action occurs, then expected result',
        a11yRequirements: 'keyboard',
        perfBudget: 250,
        securityRequirements: 'validation',
        contractType: '',
        contractPath: '',
        observabilityLogs: '',
        observabilityMetrics: '',
        observabilityTraces: '',
        migrationPlan: '',
        rollbackPlan: '',
        needsOverride: false,
        overrideApprover: '',
        overrideRationale: '',
        waivedGates: [],
        overrideExpiresDays: 7,
        isExperimental: false,
        experimentalRationale: '',
        experimentalExpiresDays: 30,
        experimentalSandbox: '',
        aiConfidence: 0.8,
        uncertaintyAreas: '',
        complexityFactors: '',
      };

      const specContent = generateWorkingSpec(defaultAnswers);
      await fs.ensureDir('.caws');
      const initialSpec = await writeInitialSpecArtifacts(specContent, defaultAnswers.projectId);
      console.log(chalk.green(`Created ${initialSpec.featureSpecPath}`));
      console.log(chalk.green('Created .caws/working-spec.yaml'));
      console.log(chalk.green('Created .caws/specs/registry.json'));

      // Optionally create policy.yaml (optional - defaults work fine)
      const policyPath = path.join('.caws', 'policy.yaml');
      if (!fs.existsSync(policyPath)) {
        const { PolicyManager } = require('../policy/PolicyManager');
        const policyManager = new PolicyManager();
        const defaultPolicy = policyManager.getDefaultPolicy();
        const policyContent = yaml.dump(defaultPolicy, { indent: 2 });
        await fs.writeFile(policyPath, policyContent);
        console.log(chalk.green('Created .caws/policy.yaml (optional - defaults work fine)'));
      }

      // Setup IDE integrations based on --ide flag or auto-detection
      const selectedIDEs = options.ide ? parseIDESelection(options.ide) : getRecommendedIDEs();

      if (selectedIDEs.includes('cursor')) {
        console.log(chalk.blue('Setting up Cursor hooks...'));
        await scaffoldCursorHooks(process.cwd());
      }

      if (selectedIDEs.length > 0) {
        console.log(chalk.blue(`Setting up IDE integrations: ${selectedIDEs.map((id) => IDE_REGISTRY[id].name).join(', ')}...`));
        await scaffoldIDEIntegrations(process.cwd(), { force: false, ides: selectedIDEs });
      }

      // Update .gitignore to exclude CAWS local runtime files
      console.log(chalk.blue('Updating .gitignore...'));
      const gitignoreUpdated = await updateGitignore(process.cwd());
      if (gitignoreUpdated) {
        console.log(chalk.green('Updated .gitignore to exclude CAWS local runtime files'));
        console.log(
          chalk.gray('   Tracked: Specs, policy, waivers, provenance, plans (shared with team)')
        );
        console.log(chalk.gray('   Ignored: Agent runtime, temp files, logs (local-only)'));
      }

      // Finalize project
      await finalizeProject(projectName, options, defaultAnswers);
    }

    // Success message
    console.log(chalk.green('\nCAWS project initialized successfully!'));
    console.log(chalk.blue('\nNext steps:'));
    console.log('1. Review .caws/specs/<spec-id>.yaml');
    console.log('2. Treat .caws/working-spec.yaml as the compatibility mirror, not the long-term source of truth');
    console.log('3. If multiple agents will collaborate, create more feature specs with `caws specs create <id>`');
    console.log('4. Use `--spec-id` on validation/status/diagnose commands for feature work');

    // Show contract requirements if Tier 1 or 2
    // Use answers if available (interactive mode), otherwise default to 2
    const riskTier = answers?.riskTier || 2;
    if (riskTier === 1 || riskTier === 2) {
      console.log(chalk.yellow('\nImportant: Contract Requirements'));
      console.log(`   Tier ${riskTier} changes require at least one contract.`);
      console.log('   For infrastructure/setup work, add a minimal contract:');
      console.log(chalk.gray('   contracts:'));
      console.log(chalk.gray('     - type: "project_setup"'));
      console.log(chalk.gray('       path: ".caws/working-spec.yaml"'));
      console.log(chalk.gray('       description: "Project-level CAWS configuration"'));
      console.log('   Or use "chore" mode for maintenance work (mode: chore)');
    }

    console.log('\nRecommended Setup Workflow:');
    console.log('   1. Review .caws/specs/<spec-id>.yaml');
    console.log('   2. Run: caws scaffold (adds tools and templates)');
    console.log('   3. For multi-agent work, run: caws specs create <feature-id>');
    console.log('   4. Run: caws validate --spec-id <spec-id> (verify setup)');
    console.log('   5. Run: caws diagnose --spec-id <spec-id> (check health)');
    console.log('   6. Optional: Create .caws/policy.yaml for custom budgets');
    const finalIDEs = answers?.selectedIDEs || [];
    if (finalIDEs.includes('cursor') || finalIDEs.includes('claude') || options.interactive === false) {
      console.log('   7. Restart your IDE to activate quality gates');
    }
    console.log('\nQuick start: caws scaffold && caws validate && caws diagnose');
    console.log('Multi-agent quick start: caws specs create my-feature && caws validate --spec-id my-feature');
  } catch (error) {
    console.error(chalk.red('Error during initialization:'), error.message);
    if (error.stack) {
      console.error(chalk.gray(error.stack));
    }

    // Cleanup on error (only for new directory creation)
    if (projectName && projectName !== '.' && fs.existsSync(projectName)) {
      try {
        await fs.remove(projectName);
        console.log(chalk.green('Cleanup completed'));
      } catch (cleanupError) {
        console.warn(
          chalk.yellow('Could not clean up:'),
          cleanupError?.message || cleanupError
        );
      }
    }

    process.exit(1);
  }
}

module.exports = {
  initProject,
};
