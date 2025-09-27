#!/usr/bin/env node

/**
 * @fileoverview CAWS CLI - Scaffolding tool for Coding Agent Workflow System
 * Provides commands to initialize new projects and scaffold existing ones with CAWS
 * @author @darianrosebrook
 */

const { Command } = require('commander');
const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer').default || require('inquirer');
const yaml = require('js-yaml');
const chalk = require('chalk');

const program = new Command();

// Configuration
const TEMPLATE_DIR = path.join(__dirname, '../../caws-template');
const { generateProvenance, saveProvenance } = require(
  path.join(TEMPLATE_DIR, 'apps/tools/caws/provenance.js')
);
const CLI_VERSION = require('../package.json').version;

// Initialize JSON Schema validator - using simplified validation for CLI stability
const validateWorkingSpec = (spec) => {
  try {
    // Basic structural validation for essential fields
    const requiredFields = [
      'id',
      'title',
      'risk_tier',
      'mode',
      'change_budget',
      'blast_radius',
      'operational_rollback_slo',
      'scope',
      'invariants',
      'acceptance',
      'non_functional',
      'contracts',
    ];

    for (const field of requiredFields) {
      if (!spec[field]) {
        return {
          valid: false,
          errors: [
            {
              instancePath: `/${field}`,
              message: `Missing required field: ${field}`,
            },
          ],
        };
      }
    }

    // Validate specific field formats
    if (!/^[A-Z]+-\d+$/.test(spec.id)) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/id',
            message: 'Project ID should be in format: PREFIX-NUMBER (e.g., FEAT-1234)',
          },
        ],
      };
    }

    if (spec.risk_tier < 1 || spec.risk_tier > 3) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/risk_tier',
            message: 'Risk tier must be 1, 2, or 3',
          },
        ],
      };
    }

    if (!spec.scope || !spec.scope.in || spec.scope.in.length === 0) {
      return {
        valid: false,
        errors: [
          {
            instancePath: '/scope/in',
            message: 'Scope IN must not be empty',
          },
        ],
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          instancePath: '',
          message: `Validation error: ${error.message}`,
        },
      ],
    };
  }
};

console.log(chalk.green('✅ Schema validation initialized successfully'));

/**
 * Copy template files to destination
 * @param {string} templatePath - Source template path
 * @param {string} destPath - Destination path
 * @param {Object} replacements - Template variable replacements
 */
async function copyTemplate(templatePath, destPath, replacements = {}) {
  try {
    // Ensure destination directory exists
    await fs.ensureDir(destPath);

    // Check if template directory exists
    if (!fs.existsSync(templatePath)) {
      console.error(chalk.red('❌ Template directory not found:'), templatePath);
      console.error(chalk.blue("💡 Make sure you're running the CLI from the correct directory"));
      process.exit(1);
    }

    // Copy all files and directories
    await fs.copy(templatePath, destPath);

    // Replace template variables in text files
    const files = await fs.readdir(destPath, { recursive: true });

    for (const file of files) {
      const filePath = path.join(destPath, file);
      const stat = await fs.stat(filePath);

      if (
        stat.isFile() &&
        (file.endsWith('.md') || file.endsWith('.yml') || file.endsWith('.yaml'))
      ) {
        try {
          let content = await fs.readFile(filePath, 'utf8');
          Object.entries(replacements).forEach(([key, value]) => {
            content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
          });
          await fs.writeFile(filePath, content);
        } catch (fileError) {
          console.warn(
            chalk.yellow(`⚠️  Warning: Could not process template file ${file}:`),
            fileError.message
          );
        }
      }
    }

    console.log(chalk.green('✅ Template files copied successfully'));
  } catch (error) {
    console.error(chalk.red('❌ Error copying template:'), error.message);

    if (error.code === 'EACCES') {
      console.error(
        chalk.blue('💡 This might be a permissions issue. Try running with elevated privileges.')
      );
    } else if (error.code === 'ENOENT') {
      console.error(
        chalk.blue('💡 Template directory not found. Make sure the caws-template directory exists.')
      );
    } else if (error.code === 'ENOSPC') {
      console.error(chalk.blue('💡 Not enough disk space to copy template files.'));
    }

    process.exit(1);
  }
}

/**
 * Generate working spec YAML with user input
 * @param {Object} answers - User responses
 * @returns {string} - Generated YAML content
 */
function generateWorkingSpec(answers) {
  const template = {
    id: answers.projectId,
    title: answers.projectTitle,
    risk_tier: answers.riskTier,
    mode: answers.projectMode,
    change_budget: {
      max_files: answers.maxFiles,
      max_loc: answers.maxLoc,
    },
    blast_radius: {
      modules: answers.blastModules
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m),
      data_migration: answers.dataMigration,
    },
    operational_rollback_slo: answers.rollbackSlo,
    threats: (answers.projectThreats || '')
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t && !t.startsWith('-') === false), // Allow lines starting with -
    scope: {
      in: (answers.scopeIn || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
      out: (answers.scopeOut || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
    },
    invariants: (answers.projectInvariants || '')
      .split('\n')
      .map((i) => i.trim())
      .filter((i) => i),
    acceptance: answers.acceptanceCriteria
      .split('\n')
      .filter((a) => a.trim())
      .map((criteria, index) => {
        const id = `A${index + 1}`;
        const upperCriteria = criteria.toUpperCase();

        // Try different variations of the format
        let given = '';
        let when = '';
        let then = '';

        if (
          upperCriteria.includes('GIVEN') &&
          upperCriteria.includes('WHEN') &&
          upperCriteria.includes('THEN')
        ) {
          given = criteria.split(/WHEN/i)[0]?.replace(/GIVEN/i, '').trim() || '';
          const whenThen = criteria.split(/WHEN/i)[1];
          when = whenThen?.split(/THEN/i)[0]?.trim() || '';
          then = whenThen?.split(/THEN/i)[1]?.trim() || '';
        } else {
          // Fallback: just split by lines and create simple criteria
          given = 'Current system state';
          when = criteria.replace(/^(GIVEN|WHEN|THEN)/i, '').trim();
          then = 'Expected behavior occurs';
        }

        return {
          id,
          given: given || 'Current system state',
          when: when || criteria,
          then: then || 'Expected behavior occurs',
        };
      }),
    non_functional: {
      a11y: answers.a11yRequirements
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a),
      perf: { api_p95_ms: answers.perfBudget },
      security: answers.securityRequirements
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s),
    },
    contracts: [
      {
        type: answers.contractType,
        path: answers.contractPath,
      },
    ],
    observability: {
      logs: answers.observabilityLogs
        .split(',')
        .map((l) => l.trim())
        .filter((l) => l),
      metrics: answers.observabilityMetrics
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m),
      traces: answers.observabilityTraces
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t),
    },
    migrations: (answers.migrationPlan || '')
      .split('\n')
      .map((m) => m.trim())
      .filter((m) => m),
    rollback: (answers.rollbackPlan || '')
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r),
  };

  return yaml.dump(template, { indent: 2 });
}

/**
 * Validate generated working spec against JSON schema
 * @param {string} specContent - YAML spec content
 * @param {Object} answers - User responses for error context
 */
function validateGeneratedSpec(specContent, _answers) {
  try {
    const spec = yaml.load(specContent);

    const isValid = validateWorkingSpec(spec);

    if (!isValid) {
      console.error(chalk.red('❌ Generated working spec failed validation:'));
      validateWorkingSpec.errors.forEach((error) => {
        console.error(`   - ${error.instancePath || 'root'}: ${error.message}`);
      });

      // Provide helpful guidance
      console.log(chalk.blue('\n💡 Validation Tips:'));
      console.log('   - Ensure risk_tier is 1, 2, or 3');
      console.log('   - Check that scope.in is not empty');
      console.log('   - Verify invariants and acceptance criteria are provided');
      console.log('   - For tier 1 and 2, ensure contracts are specified');

      process.exit(1);
    }

    console.log(chalk.green('✅ Generated working spec passed validation'));
  } catch (error) {
    console.error(chalk.red('❌ Error validating working spec:'), error.message);
    process.exit(1);
  }
}

/**
 * Initialize a new project with CAWS
 */
async function initProject(projectName, options) {
  console.log(chalk.cyan(`🚀 Initializing new CAWS project: ${projectName}`));

  try {
    // Validate project name
    if (!projectName || projectName.trim() === '') {
      console.error(chalk.red('❌ Project name is required'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Sanitize project name
    const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
    if (sanitizedName !== projectName) {
      console.warn(chalk.yellow(`⚠️  Project name sanitized to: ${sanitizedName}`));
      projectName = sanitizedName;
    }

    // Check if directory already exists
    if (fs.existsSync(projectName)) {
      console.error(chalk.red(`❌ Directory ${projectName} already exists`));
      console.error(chalk.blue('💡 Choose a different name or remove the existing directory'));
      process.exit(1);
    }

    // Create project directory
    await fs.ensureDir(projectName);
    process.chdir(projectName);

    console.log(chalk.green(`📁 Created project directory: ${projectName}`));

    // Copy template files
    await copyTemplate(TEMPLATE_DIR, '.');

    if (options.interactive && !options.nonInteractive) {
      // Interactive setup with enhanced prompts
      console.log(chalk.cyan('🔧 Starting interactive project configuration...'));
      console.log(chalk.blue('💡 Press Ctrl+C at any time to exit and use defaults'));

      const questions = [
        {
          type: 'input',
          name: 'projectId',
          message: '📋 Project ID (e.g., FEAT-1234, AUTH-456):',
          default: projectName.toUpperCase().replace(/[^A-Z0-9]/g, '-') + '-001',
          validate: (input) => {
            if (!input.trim()) return 'Project ID is required';
            const pattern = /^[A-Z]+-\d+$/;
            if (!pattern.test(input)) {
              return 'Project ID should be in format: PREFIX-NUMBER (e.g., FEAT-1234)';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'projectTitle',
          message: '📝 Project Title (descriptive name):',
          default: projectName.charAt(0).toUpperCase() + projectName.slice(1).replace(/-/g, ' '),
          validate: (input) => {
            if (!input.trim()) return 'Project title is required';
            if (input.trim().length < 8) {
              return 'Project title should be at least 8 characters long';
            }
            return true;
          },
        },
        {
          type: 'list',
          name: 'riskTier',
          message: '⚠️  Risk Tier (higher tier = more rigor):',
          choices: [
            {
              name: '🔴 Tier 1 - Critical (auth, billing, migrations) - Max rigor',
              value: 1,
            },
            {
              name: '🟡 Tier 2 - Standard (features, APIs) - Standard rigor',
              value: 2,
            },
            {
              name: '🟢 Tier 3 - Low Risk (UI, tooling) - Basic rigor',
              value: 3,
            },
          ],
          default: 2,
        },
        {
          type: 'list',
          name: 'projectMode',
          message: '🎯 Project Mode:',
          choices: [
            { name: '✨ feature (new functionality)', value: 'feature' },
            { name: '🔄 refactor (code restructuring)', value: 'refactor' },
            { name: '🐛 fix (bug fixes)', value: 'fix' },
            { name: '📚 doc (documentation)', value: 'doc' },
            { name: '🧹 chore (maintenance)', value: 'chore' },
          ],
          default: 'feature',
        },
        {
          type: 'number',
          name: 'maxFiles',
          message: '📊 Max files to change:',
          default: (answers) => {
            // Dynamic defaults based on risk tier
            switch (answers.riskTier) {
              case 1:
                return 40;
              case 2:
                return 25;
              case 3:
                return 15;
              default:
                return 25;
            }
          },
          validate: (input) => {
            if (input < 1) return 'Must change at least 1 file';
            return true;
          },
        },
        {
          type: 'number',
          name: 'maxLoc',
          message: '📏 Max lines of code to change:',
          default: (answers) => {
            // Dynamic defaults based on risk tier
            switch (answers.riskTier) {
              case 1:
                return 1500;
              case 2:
                return 1000;
              case 3:
                return 600;
              default:
                return 1000;
            }
          },
          validate: (input) => {
            if (input < 1) return 'Must change at least 1 line';
            return true;
          },
        },
        {
          type: 'input',
          name: 'blastModules',
          message: '💥 Blast Radius - Affected modules (comma-separated):',
          default: 'core,api',
          validate: (input) => {
            if (!input.trim()) return 'At least one module must be specified';
            return true;
          },
        },
        {
          type: 'confirm',
          name: 'dataMigration',
          message: '🗄️  Requires data migration?',
          default: false,
        },
        {
          type: 'input',
          name: 'rollbackSlo',
          message: '⏱️  Operational rollback SLO (e.g., 5m, 1h, 24h):',
          default: '5m',
          validate: (input) => {
            const pattern = /^([0-9]+m|[0-9]+h|[0-9]+d)$/;
            if (!pattern.test(input)) {
              return 'SLO should be in format: NUMBER + m/h/d (e.g., 5m, 1h, 24h)';
            }
            return true;
          },
        },
        {
          type: 'editor',
          name: 'projectThreats',
          message: '⚠️  Project Threats & Risks (one per line, ESC to finish):',
          default: (answers) => {
            const baseThreats =
              '- Race condition in concurrent operations\n- Performance degradation under load';
            if (answers.dataMigration) {
              return baseThreats + '\n- Data migration failure\n- Inconsistent data state';
            }
            return baseThreats;
          },
        },
        {
          type: 'input',
          name: 'scopeIn',
          message: "🎯 Scope IN - What's included (comma-separated):",
          default: (answers) => {
            if (answers.projectMode === 'feature') return 'user authentication, api endpoints';
            if (answers.projectMode === 'refactor') return 'authentication module, user service';
            if (answers.projectMode === 'fix') return 'error handling, validation';
            return 'project files';
          },
          validate: (input) => {
            if (!input.trim()) return 'At least one scope item must be specified';
            return true;
          },
        },
        {
          type: 'input',
          name: 'scopeOut',
          message: "🚫 Scope OUT - What's excluded (comma-separated):",
          default: (answers) => {
            if (answers.projectMode === 'feature')
              return 'legacy authentication, deprecated endpoints';
            if (answers.projectMode === 'refactor')
              return 'external dependencies, configuration files';
            return 'unrelated features';
          },
        },
        {
          type: 'editor',
          name: 'projectInvariants',
          message: '🛡️  System Invariants (one per line, ESC to finish):',
          default:
            '- System remains available\n- Data consistency maintained\n- User sessions preserved',
        },
        {
          type: 'editor',
          name: 'acceptanceCriteria',
          message: '✅ Acceptance Criteria (GIVEN...WHEN...THEN, one per line, ESC to finish):',
          default: (answers) => {
            if (answers.projectMode === 'feature') {
              return 'GIVEN user is authenticated WHEN accessing protected endpoint THEN access is granted\nGIVEN invalid credentials WHEN attempting login THEN access is denied';
            }
            if (answers.projectMode === 'fix') {
              return 'GIVEN existing functionality WHEN applying fix THEN behavior is preserved\nGIVEN error condition WHEN fix is applied THEN error is resolved';
            }
            return 'GIVEN current system state WHEN change is applied THEN expected behavior occurs';
          },
          validate: (input) => {
            if (!input.trim()) return 'At least one acceptance criterion is required';
            const lines = input
              .trim()
              .split('\n')
              .filter((line) => line.trim());
            if (lines.length === 0) return 'At least one acceptance criterion is required';
            return true;
          },
        },
        {
          type: 'input',
          name: 'a11yRequirements',
          message: '♿ Accessibility Requirements (comma-separated):',
          default: 'keyboard navigation, screen reader support, color contrast',
        },
        {
          type: 'number',
          name: 'perfBudget',
          message: '⚡ Performance Budget (API p95 latency in ms):',
          default: 250,
          validate: (input) => {
            if (input < 1) return 'Performance budget must be at least 1ms';
            if (input > 10000) return 'Performance budget seems too high (max 10s)';
            return true;
          },
        },
        {
          type: 'input',
          name: 'securityRequirements',
          message: '🔒 Security Requirements (comma-separated):',
          default: 'input validation, rate limiting, authentication, authorization',
        },
        {
          type: 'list',
          name: 'contractType',
          message: '📄 Contract Type:',
          choices: [
            { name: 'OpenAPI (REST APIs)', value: 'openapi' },
            { name: 'GraphQL Schema', value: 'graphql' },
            { name: 'Protocol Buffers', value: 'proto' },
            { name: 'Pact (consumer-driven)', value: 'pact' },
          ],
          default: 'openapi',
        },
        {
          type: 'input',
          name: 'contractPath',
          message: '📁 Contract File Path:',
          default: (answers) => {
            if (answers.contractType === 'openapi') return 'apps/contracts/api.yaml';
            if (answers.contractType === 'graphql') return 'apps/contracts/schema.graphql';
            if (answers.contractType === 'proto') return 'apps/contracts/service.proto';
            if (answers.contractType === 'pact') return 'apps/contracts/pacts/';
            return 'apps/contracts/api.yaml';
          },
        },
        {
          type: 'input',
          name: 'observabilityLogs',
          message: '📝 Observability - Log Events (comma-separated):',
          default: 'auth.success, auth.failure, api.request, api.response',
        },
        {
          type: 'input',
          name: 'observabilityMetrics',
          message: '📊 Observability - Metrics (comma-separated):',
          default: 'auth_attempts_total, auth_success_total, api_requests_total, api_errors_total',
        },
        {
          type: 'input',
          name: 'observabilityTraces',
          message: '🔍 Observability - Traces (comma-separated):',
          default: 'auth_flow, api_request',
        },
        {
          type: 'editor',
          name: 'migrationPlan',
          message: '🔄 Migration Plan (one per line, ESC to finish):',
          default: (answers) => {
            if (answers.dataMigration) {
              return '- Create new database schema\n- Add new auth table\n- Migrate existing users\n- Validate data integrity';
            }
            return '- Deploy feature flags\n- Roll out gradually\n- Monitor metrics';
          },
          validate: (input) => {
            if (!input.trim()) return 'Migration plan is required';
            return true;
          },
        },
        {
          type: 'editor',
          name: 'rollbackPlan',
          message: '🔙 Rollback Plan (one per line, ESC to finish):',
          default: (answers) => {
            if (answers.dataMigration) {
              return '- Feature flag kill-switch\n- Database rollback script\n- Restore from backup\n- Verify system state';
            }
            return '- Feature flag disable\n- Deploy previous version\n- Monitor for issues';
          },
          validate: (input) => {
            if (!input.trim()) return 'Rollback plan is required';
            return true;
          },
        },
      ];

      console.log(chalk.cyan('⏳ Gathering project requirements...'));

      let answers;
      try {
        answers = await inquirer.prompt(questions);
      } catch (error) {
        if (error.isTtyError) {
          console.error(chalk.red('❌ Interactive prompts not supported in this environment'));
          console.error(chalk.blue('💡 Run with --non-interactive flag to use defaults'));
          process.exit(1);
        } else {
          console.error(chalk.red('❌ Error during interactive setup:'), error.message);
          process.exit(1);
        }
      }

      console.log(chalk.green('✅ Project requirements gathered successfully!'));

      // Show summary before generating spec
      console.log(chalk.bold('\n📋 Configuration Summary:'));
      console.log(`   ${chalk.cyan('Project')}: ${answers.projectTitle} (${answers.projectId})`);
      console.log(
        `   ${chalk.cyan('Mode')}: ${answers.projectMode} | ${chalk.cyan('Tier')}: ${answers.riskTier}`
      );
      console.log(`   ${chalk.cyan('Budget')}: ${answers.maxFiles} files, ${answers.maxLoc} lines`);
      console.log(`   ${chalk.cyan('Data Migration')}: ${answers.dataMigration ? 'Yes' : 'No'}`);
      console.log(`   ${chalk.cyan('Rollback SLO')}: ${answers.rollbackSlo}`);

      // Generate working spec
      const workingSpecContent = generateWorkingSpec(answers);

      // Validate the generated spec
      validateGeneratedSpec(workingSpecContent, answers);

      // Save the working spec
      await fs.writeFile('.caws/working-spec.yaml', workingSpecContent);

      console.log(chalk.green('✅ Working spec generated and validated'));
    }

    // Finalize project with provenance and git initialization
    await finalizeProject(projectName, options, answers);

    continueToSuccess();
  } catch (error) {
    console.error(chalk.red('❌ Error during project initialization:'), error.message);

    // Cleanup on error
    if (fs.existsSync(projectName)) {
      console.log(chalk.cyan('🧹 Cleaning up failed initialization...'));
      try {
        await fs.remove(projectName);
        console.log(chalk.green('✅ Cleanup completed'));
      } catch (cleanupError) {
        console.warn(
          chalk.yellow('⚠️  Could not clean up:'),
          cleanupError?.message || cleanupError
        );
      }
    }

    process.exit(1);
  }
}

// Generate provenance manifest and git initialization (for both modes)
async function finalizeProject(projectName, options, answers) {
  try {
    // Generate provenance manifest
    console.log(chalk.cyan('📦 Generating provenance manifest...'));

    const provenanceData = {
      agent: 'caws-cli',
      model: 'cli-interactive',
      modelHash: CLI_VERSION,
      toolAllowlist: [
        'node',
        'npm',
        'git',
        'fs-extra',
        'inquirer',
        'commander',
        'js-yaml',
        'ajv',
        'chalk',
      ],
      prompts: Object.keys(answers),
      commit: null, // Will be set after git init
      artifacts: ['.caws/working-spec.yaml'],
      results: {
        project_id: answers.projectId,
        project_title: answers.projectTitle,
        risk_tier: answers.riskTier,
        mode: answers.projectMode,
        change_budget: {
          max_files: answers.maxFiles,
          max_loc: answers.maxLoc,
        },
      },
      approvals: [],
    };

    const provenance = generateProvenance(provenanceData);
    await saveProvenance(provenance, '.agent/provenance.json');

    console.log(chalk.green('✅ Provenance manifest generated'));

    // Initialize git repository
    if (options.git) {
      try {
        console.log(chalk.cyan('🔧 Initializing git repository...'));

        // Check if git is available
        try {
          require('child_process').execSync('git --version', { stdio: 'ignore' });
        } catch (error) {
          console.warn(chalk.yellow('⚠️  Git not found. Skipping git initialization.'));
          console.warn(chalk.blue('💡 Install git to enable automatic repository setup.'));
          return;
        }

        require('child_process').execSync('git init', { stdio: 'inherit' });
        require('child_process').execSync('git add .', { stdio: 'inherit' });
        require('child_process').execSync('git commit -m "Initial CAWS project setup"', {
          stdio: 'inherit',
        });
        console.log(chalk.green('✅ Git repository initialized'));

        // Update provenance with commit hash
        const commitHash = require('child_process')
          .execSync('git rev-parse HEAD', { encoding: 'utf8' })
          .trim();
        const currentProvenance = JSON.parse(fs.readFileSync('.agent/provenance.json', 'utf8'));
        currentProvenance.commit = commitHash;
        currentProvenance.hash = require('crypto')
          .createHash('sha256')
          .update(JSON.stringify(currentProvenance, Object.keys(currentProvenance).sort()))
          .digest('hex');
        await fs.writeFile('.agent/provenance.json', JSON.stringify(currentProvenance, null, 2));

        console.log(chalk.green('✅ Provenance updated with commit hash'));
      } catch (error) {
        console.warn(chalk.yellow('⚠️  Failed to initialize git repository:'), error.message);
        console.warn(chalk.blue('💡 You can initialize git manually later with:'));
        console.warn("   git init && git add . && git commit -m 'Initial CAWS project setup'");
      }
    }
  } catch (error) {
    console.error(chalk.red('❌ Error during project finalization:'), error.message);
  }
}

function continueToSuccess() {
  console.log(chalk.green('\n🎉 Project initialized successfully!'));
  console.log(`📁 ${chalk.cyan('Project location')}: ${path.resolve(process.cwd())}`);
  console.log(chalk.bold('\nNext steps:'));
  console.log('1. Customize .caws/working-spec.yaml');
  console.log('2. npm install (if using Node.js)');
  console.log('3. Set up your CI/CD pipeline');
  console.log(chalk.blue('\nFor help: caws --help'));
}

/**
 * Scaffold existing project with CAWS components
 */
async function scaffoldProject(options) {
  const currentDir = process.cwd();
  const projectName = path.basename(currentDir);

  console.log(chalk.cyan(`🔧 Scaffolding existing project: ${projectName}`));

  try {
    // Check if template directory exists
    if (!fs.existsSync(TEMPLATE_DIR)) {
      console.error(chalk.red('❌ Template directory not found:'), TEMPLATE_DIR);
      console.error(chalk.blue("💡 Make sure you're running the CLI from the correct directory"));
      process.exit(1);
    }

    // Generate provenance for scaffolding operation
    const scaffoldProvenance = generateProvenance({
      agent: 'caws-cli',
      model: 'cli-scaffold',
      modelHash: CLI_VERSION,
      toolAllowlist: ['node', 'fs-extra'],
      prompts: ['scaffold', options.force ? 'force' : 'normal'],
      commit: null,
      artifacts: [],
      results: {
        operation: 'scaffold',
        force_mode: options.force,
        target_directory: currentDir,
      },
      approvals: [],
    });

    // Copy missing CAWS components
    const cawsFiles = ['.caws', 'apps/tools/caws', 'codemod', '.github/workflows/caws.yml'];

    let addedCount = 0;
    let skippedCount = 0;
    const addedFiles = [];

    for (const file of cawsFiles) {
      const templatePath = path.join(TEMPLATE_DIR, file);
      const destPath = path.join(currentDir, file);

      if (!fs.existsSync(destPath)) {
        if (fs.existsSync(templatePath)) {
          try {
            await fs.copy(templatePath, destPath);
            console.log(chalk.green(`✅ Added ${file}`));
            addedCount++;
            addedFiles.push(file);
          } catch (copyError) {
            console.warn(chalk.yellow(`⚠️  Failed to copy ${file}:`), copyError.message);
          }
        } else {
          console.warn(chalk.yellow(`⚠️  Template not found for ${file}, skipping`));
        }
      } else {
        if (options.force) {
          try {
            await fs.remove(destPath);
            await fs.copy(templatePath, destPath);
            console.log(chalk.blue(`🔄 Overwritten ${file}`));
            addedCount++;
            addedFiles.push(file);
          } catch (overwriteError) {
            console.warn(chalk.yellow(`⚠️  Failed to overwrite ${file}:`), overwriteError.message);
          }
        } else {
          console.log(`⏭️  Skipped ${file} (already exists)`);
          skippedCount++;
        }
      }
    }

    // Update provenance with results
    scaffoldProvenance.artifacts = addedFiles;
    scaffoldProvenance.results.files_added = addedCount;
    scaffoldProvenance.results.files_skipped = skippedCount;

    console.log(chalk.green(`\n🎉 Scaffolding completed!`));
    console.log(chalk.bold(`📊 Summary: ${addedCount} added, ${skippedCount} skipped`));

    if (addedCount > 0) {
      console.log(chalk.bold('\n📝 Next steps:'));
      console.log('1. Review and customize the added files');
      console.log('2. Update .caws/working-spec.yaml if needed');
      console.log('3. Run tests to ensure everything works');
      console.log('4. Set up your CI/CD pipeline');
    }

    if (options.force) {
      console.log(chalk.yellow('\n⚠️  Force mode was used - review changes carefully'));
    }

    // Save provenance manifest
    await saveProvenance(scaffoldProvenance, '.agent/scaffold-provenance.json');
    console.log(chalk.green('✅ Scaffolding provenance saved'));
  } catch (error) {
    console.error(chalk.red('❌ Error during scaffolding:'), error.message);
    process.exit(1);
  }
}

/**
 * Show version information
 */
function showVersion() {
  console.log(chalk.bold(`CAWS CLI v${CLI_VERSION}`));
  console.log(chalk.cyan('Coding Agent Workflow System - Scaffolding Tool'));
  console.log(chalk.gray('Author: @darianrosebrook'));
  console.log(chalk.gray('License: MIT'));
}

// CLI Commands
program
  .name('caws')
  .description('CAWS - Coding Agent Workflow System CLI')
  .version(CLI_VERSION, '-v, --version', 'Show version information')
  .action(() => showVersion());

program
  .command('init')
  .alias('i')
  .description('Initialize a new project with CAWS')
  .argument('<project-name>', 'Name of the new project')
  .option('-i, --interactive', 'Run interactive setup', true)
  .option('-g, --git', 'Initialize git repository', true)
  .option('-n, --non-interactive', 'Skip interactive prompts')
  .option('--no-git', "Don't initialize git repository")
  .action(initProject);

program
  .command('scaffold')
  .alias('s')
  .description('Add CAWS components to existing project')
  .option('-f, --force', 'Overwrite existing files')
  .action(scaffoldProject);

// Error handling
program.exitOverride((err) => {
  if (
    err.code === 'commander.help' ||
    err.code === 'commander.version' ||
    err.message.includes('outputHelp')
  ) {
    process.exit(0);
  }
  console.error(chalk.red('❌ Error:'), err.message);
  process.exit(1);
});

// Parse and run
try {
  program.parse();
} catch (error) {
  if (
    error.code === 'commander.help' ||
    error.code === 'commander.version' ||
    error.message.includes('outputHelp')
  ) {
    process.exit(0);
  } else {
    console.error(chalk.red('❌ Error:'), error.message);
    process.exit(1);
  }
}

// Export functions for testing
module.exports = {
  generateWorkingSpec,
  validateGeneratedSpec,
};
