/**
 * @fileoverview CAWS Init Command Handler
 * Handles project initialization with CAWS setup
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const inquirer = require('inquirer');
const chalk = require('chalk');

// Import shared utilities
const { detectCAWSSetup } = require('../utils/detection');
const { detectProjectType } = require('../utils/project-analysis');
const { shouldInitInCurrentDirectory } = require('../utils/project-analysis');
const { generateWorkingSpec } = require('../generators/working-spec');
const { finalizeProject } = require('../utils/finalization');
const { scaffoldCursorHooks } = require('../scaffold/cursor-hooks');
const { scaffoldIDEIntegrations } = require('../scaffold/index');

/**
 * Initialize a new project with CAWS
 */
async function initProject(projectName, options) {
  const currentDir = process.cwd();
  const isCurrentDirInit = shouldInitInCurrentDirectory(projectName, currentDir);

  if (!isCurrentDirInit && projectName !== '.') {
    console.log(chalk.cyan(`🚀 Initializing new CAWS project: ${projectName}`));
    console.log(chalk.gray(`   (Creating subdirectory: ${projectName}/)`));
  } else {
    console.log(
      chalk.cyan(`🚀 Initializing CAWS in current project: ${path.basename(currentDir)}`)
    );
    console.log(chalk.gray(`   (Adding CAWS files to existing project)`));
  }

  let answers; // Will be set either interactively or with defaults

  try {
    // Validate project name
    if (!projectName || projectName.trim() === '') {
      console.error(chalk.red('❌ Project name is required'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Special case: '.' means current directory, don't sanitize
    if (projectName !== '.') {
      // Sanitize project name
      const sanitizedName = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase();
      if (sanitizedName !== projectName) {
        console.warn(chalk.yellow(`⚠️  Project name sanitized to: ${sanitizedName}`));
        projectName = sanitizedName;
      }
    }

    // Validate project name length
    if (projectName.length > 50) {
      console.error(chalk.red('❌ Project name is too long (max 50 characters)'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Validate project name format
    if (projectName.length === 0) {
      console.error(chalk.red('❌ Project name cannot be empty'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      process.exit(1);
    }

    // Check for invalid characters that should cause immediate failure
    if (projectName.includes('/') || projectName.includes('\\') || projectName.includes('..')) {
      console.error(chalk.red('❌ Project name contains invalid characters'));
      console.error(chalk.blue('💡 Usage: caws init <project-name>'));
      console.error(chalk.blue('💡 Project name should not contain: / \\ ..'));
      process.exit(1);
    }

    // Determine if initializing in current directory
    const initInCurrentDir = projectName === '.';
    const targetDir = initInCurrentDir ? process.cwd() : path.resolve(process.cwd(), projectName);

    // Check if target directory already exists and has content (skip check for current directory)
    if (!initInCurrentDir && fs.existsSync(projectName)) {
      const existingFiles = fs.readdirSync(projectName);
      if (existingFiles.length > 0) {
        console.error(chalk.red(`❌ Directory '${projectName}' already exists and contains files`));
        console.error(chalk.blue('💡 To initialize CAWS in current directory instead:'));
        console.error(`   ${chalk.cyan('caws init .')}`);
        console.error(chalk.blue('💡 Or choose a different name/remove existing directory'));
        process.exit(1);
      }
    }

    // Check if current directory has project files when trying to init in subdirectory
    if (!initInCurrentDir) {
      const currentDirFiles = fs.readdirSync(process.cwd());
      const hasProjectFiles = currentDirFiles.some(
        (file) => !file.startsWith('.') && file !== 'node_modules' && file !== '.git'
      );

      if (hasProjectFiles) {
        console.warn(chalk.yellow('⚠️  Current directory contains project files'));
        console.warn(
          chalk.blue('💡 You might want to initialize CAWS in current directory instead:')
        );
        console.warn(`   ${chalk.cyan('caws init .')}`);
        console.warn(chalk.blue('   Or continue to create subdirectory (Ctrl+C to cancel)'));
      }
    }

    // Save the original template directory before changing directories
    const cawsSetup = detectCAWSSetup(targetDir);
    const originalTemplateDir = cawsSetup?.hasTemplateDir ? cawsSetup.templateDir : null;

    // Check for existing agents.md/caws.md in target directory
    const existingAgentsMd = fs.existsSync(path.join(targetDir, 'agents.md'));
    const existingCawsMd = fs.existsSync(path.join(targetDir, 'caws.md'));

    // Create project directory and change to it (unless already in current directory)
    if (!initInCurrentDir) {
      await fs.ensureDir(projectName);
      process.chdir(projectName);
      console.log(chalk.green(`📁 Created project directory: ${projectName}`));
    } else {
      console.log(chalk.green(`📁 Initializing in current directory`));
    }

    // Detect and adapt to existing setup
    const currentSetup = detectCAWSSetup(process.cwd());

    if (currentSetup.type === 'new') {
      // Create minimal CAWS structure
      await fs.ensureDir('.caws');
      await fs.ensureDir('.agent');
      console.log(chalk.blue('ℹ️  Created basic CAWS structure'));

      // Copy agents.md guide if templates are available
      if (originalTemplateDir) {
        try {
          const agentsMdSource = path.join(originalTemplateDir, 'agents.md');
          let targetFile = 'agents.md';

          if (fs.existsSync(agentsMdSource)) {
            // Use the pre-checked values for conflicts
            if (existingAgentsMd) {
              // Conflict: user already has agents.md
              if (options.interactive && !options.nonInteractive) {
                // Interactive mode: ask user
                const overwriteAnswer = await inquirer.prompt([
                  {
                    type: 'confirm',
                    name: 'overwrite',
                    message: '⚠️  agents.md already exists. Overwrite with CAWS guide?',
                    default: false,
                  },
                ]);

                if (overwriteAnswer.overwrite) {
                  targetFile = 'agents.md';
                } else {
                  targetFile = 'caws.md';
                }
              } else {
                // Non-interactive mode: use caws.md instead
                targetFile = 'caws.md';
                console.log(chalk.blue('ℹ️  agents.md exists, using caws.md for CAWS guide'));
              }
            }

            // If caws.md also exists and that's our target, skip
            if (targetFile === 'caws.md' && existingCawsMd) {
              console.log(
                chalk.yellow('⚠️  Both agents.md and caws.md exist, skipping guide copy')
              );
            } else {
              const agentsMdDest = path.join(process.cwd(), targetFile);
              await fs.copyFile(agentsMdSource, agentsMdDest);
              console.log(chalk.green(`✅ Added ${targetFile} guide`));
            }
          }
        } catch (templateError) {
          console.warn(chalk.yellow('⚠️  Could not copy agents guide:'), templateError.message);
          console.warn(
            chalk.blue('💡 You can manually copy the guide from the caws-template package')
          );
        }
      }
    } else {
      // Already has CAWS setup
      console.log(chalk.green('✅ CAWS project detected - skipping template copy'));
    }

    // Handle interactive wizard or template-based setup
    if (options.interactive && !options.nonInteractive) {
      console.log(chalk.cyan('🎯 CAWS Interactive Setup Wizard'));
      console.log(chalk.blue('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'));
      console.log(chalk.gray('This wizard will guide you through creating a CAWS working spec\n'));

      // Detect project type
      const detectedType = detectProjectType(process.cwd());
      console.log(chalk.blue(`📦 Detected project type: ${chalk.cyan(detectedType)}`));

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
          message: '❓ What type of project is this?',
          choices: [
            {
              name: '🔌 VS Code Extension (webview, commands, integrations)',
              value: 'extension',
              short: 'VS Code Extension',
            },
            {
              name: '📚 Library/Package (reusable components, utilities)',
              value: 'library',
              short: 'Library',
            },
            {
              name: '🌐 Web Application (frontend/backend, full-stack)',
              value: 'application',
              short: 'Web Application',
            },
            {
              name: '🖥️  CLI Tool (command-line interface, scripts)',
              value: 'cli',
              short: 'CLI Tool',
            },
            {
              name: '📱 Mobile App (iOS/Android, React Native, etc.)',
              value: 'mobile',
              short: 'Mobile App',
            },
            {
              name: '🛠️  Infrastructure (DevOps, deployment, cloud)',
              value: 'infrastructure',
              short: 'Infrastructure',
            },
            {
              name: '📊 Data/Analytics (ETL, ML, dashboards)',
              value: 'data',
              short: 'Data/Analytics',
            },
            {
              name: '🎮 Game Development (Unity, Godot, custom engine)',
              value: 'game',
              short: 'Game',
            },
            {
              name: '🔧 Other/Custom (please specify)',
              value: 'other',
              short: 'Other',
            },
          ],
          default: detectedType,
        },
        {
          type: 'input',
          name: 'projectTitle',
          message: '📝 What is the project title?',
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
          message: '📖 Provide a brief project description (1-2 sentences):',
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
          message: '⚠️  What risk tier does this project fall into?',
          choices: [
            {
              name: '🔴 Tier 1 - High Risk (auth, billing, migrations, critical infrastructure)',
              value: 1,
              short: 'High Risk (T1)',
            },
            {
              name: '🟡 Tier 2 - Medium Risk (features, APIs, data writes)',
              value: 2,
              short: 'Medium Risk (T2)',
            },
            {
              name: '🟢 Tier 3 - Low Risk (UI, internal tools, docs)',
              value: 3,
              short: 'Low Risk (T3)',
            },
          ],
          default: 2,
        },
        {
          type: 'input',
          name: 'projectId',
          message: '🆔 Project ID (e.g., PROJ-001, FEAT-123):',
          default: () => {
            const randomNum = Math.floor(Math.random() * 1000) + 1;
            return `PROJ-${randomNum.toString().padStart(3, '0')}`;
          },
          validate: (input) => {
            if (!input.match(/^[A-Z]+-\d+$/)) {
              return 'Project ID must be in format PREFIX-NUMBER (e.g., PROJ-001)';
            }
            if (input.length > 20) {
              return 'Project ID must be less than 20 characters';
            }
            return true;
          },
        },
        {
          type: 'confirm',
          name: 'useCursorHooks',
          message: '🎯 Enable Cursor IDE hooks for real-time quality gates?',
          default: true,
        },
        {
          type: 'confirm',
          name: 'generateExamples',
          message: '📋 Generate example code and documentation?',
          default: true,
        },
      ];

      // Ask questions and get answers
      answers = await inquirer.prompt(wizardQuestions);

      // Generate working spec
      console.log(chalk.blue('\n📄 Generating CAWS working spec...'));
      const specContent = generateWorkingSpec(answers);

      // Write working spec
      await fs.ensureDir('.caws');
      await fs.writeFile(path.join('.caws', 'working-spec.yaml'), specContent);
      console.log(chalk.green('✅ Created .caws/working-spec.yaml'));

      // Generate additional files if requested
      if (answers.generateExamples) {
        console.log(chalk.blue('📝 Generating example files...'));

        // Generate .caws/getting-started.md
        const gettingStartedGuide = `# ${answers.projectTitle} - Getting Started

## Project Overview
${answers.projectDescription}

## Risk Tier: ${answers.riskTier === 1 ? 'High (T1)' : answers.riskTier === 2 ? 'Medium (T2)' : 'Low (T3)'}

## Next Steps
1. Review and customize \`.caws/working-spec.yaml\`
2. Set up your development environment
3. Implement features according to the spec
4. Run \`caws validate\` to check your progress

## Quality Gates
- **Coverage**: ${answers.riskTier === 1 ? '90%+' : answers.riskTier === 2 ? '80%+' : '70%+'}
- **Mutation Score**: ${answers.riskTier === 1 ? '70%+' : answers.riskTier === 2 ? '50%+' : '30%+'}
- **Review**: ${answers.riskTier === 1 ? 'Manual' : 'Optional'}

Happy coding! 🎯
`;

        await fs.writeFile(path.join('.caws', 'getting-started.md'), gettingStartedGuide);
        console.log(chalk.green('✅ Created .caws/getting-started.md'));

        // Generate basic directory structure
        await fs.ensureDir('tests');
        await fs.ensureDir('tests/unit');
        await fs.ensureDir('tests/integration');
        await fs.ensureDir('tests/e2e');
        await fs.ensureDir('docs');
        console.log(chalk.green('✅ Created test and docs directories'));
      }

      // Setup Cursor hooks if requested
      if (answers.useCursorHooks) {
        console.log(chalk.blue('🎯 Setting up Cursor hooks...'));
        await scaffoldCursorHooks(process.cwd());
      }

      // Setup IDE integrations for comprehensive development experience
      console.log(chalk.blue('🎨 Setting up IDE integrations...'));
      await scaffoldIDEIntegrations(process.cwd(), { force: false });

      // Finalize project
      await finalizeProject(projectName, options, answers);
    } else {
      // Non-interactive mode - generate basic spec with defaults
      console.log(chalk.blue('📄 Generating basic CAWS working spec...'));

      const detectedType = detectProjectType(process.cwd());
      const defaultAnswers = {
        projectType: detectedType,
        projectTitle: path.basename(process.cwd()),
        projectDescription: `A ${detectedType} project managed with CAWS`,
        riskTier: 2,
        projectId: `PROJ-${Math.floor(Math.random() * 1000) + 1}`,
        useCursorHooks: true,
        generateExamples: false,
      };

      const specContent = generateWorkingSpec(defaultAnswers);
      await fs.ensureDir('.caws');
      await fs.writeFile(path.join('.caws', 'working-spec.yaml'), specContent);
      console.log(chalk.green('✅ Created .caws/working-spec.yaml'));

      // Setup Cursor hooks by default in non-interactive mode
      console.log(chalk.blue('🎯 Setting up Cursor hooks...'));
      await scaffoldCursorHooks(process.cwd());

      // Setup IDE integrations by default in non-interactive mode
      console.log(chalk.blue('🎨 Setting up IDE integrations...'));
      await scaffoldIDEIntegrations(process.cwd(), { force: false });

      // Finalize project
      await finalizeProject(projectName, options, defaultAnswers);
    }

    // Success message
    console.log(chalk.green('\n🎉 CAWS project initialized successfully!'));
    console.log(chalk.blue('\nNext steps:'));
    console.log('1. Review .caws/working-spec.yaml');
    console.log('2. Customize the specification for your needs');
    console.log('3. Run "caws validate" to check your setup');
    if (answers?.useCursorHooks || options.interactive === false) {
      console.log('4. Restart Cursor IDE to activate quality gates');
    }
    console.log('5. Start implementing your features!');
  } catch (error) {
    // Cleanup on error (only for new directory creation)
    if (projectName && projectName !== '.' && fs.existsSync(projectName)) {
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

module.exports = {
  initProject,
};
