/**
 * @fileoverview Project Finalization Utilities
 * Functions for finalizing CAWS project setup
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

// CLI version from package.json
const CLI_VERSION = require('../../package.json').version;

// Import scaffold utilities
const { scaffoldCursorHooks } = require('../scaffold/cursor-hooks');

// Dependencies injected via setFinalizationDependencies()
let languageSupport = null;
let loadProvenanceTools = null;

/**
 * Set dependencies for finalization utilities
 * @param {Object} deps - Dependencies object
 */
function setFinalizationDependencies(deps) {
  languageSupport = deps.languageSupport;
  loadProvenanceTools = deps.loadProvenanceTools;
}

/**
 * Generate provenance manifest and git initialization (for both modes)
 * @param {string} projectName - Project name
 * @param {Object} options - Command options
 * @param {Object} answers - User answers
 */
async function finalizeProject(projectName, options, answers) {
  try {
    // Detect and configure language support
    if (languageSupport) {
      console.log(chalk.cyan('🔍 Detecting project language...'));
      const detectedLanguage = languageSupport.detectProjectLanguage();

      if (detectedLanguage !== 'unknown') {
        console.log(chalk.green(`✅ Detected language: ${detectedLanguage}`));

        // Generate language-specific configuration
        try {
          const langConfig = languageSupport.generateLanguageConfig(
            detectedLanguage,
            '.caws/language-config.json'
          );

          console.log(chalk.green('✅ Generated language-specific configuration'));
          console.log(`   Language: ${langConfig.name}`);
          console.log(`   Tier: ${langConfig.tier}`);
          console.log(
            `   Thresholds: Branch ≥${langConfig.thresholds.min_branch * 100}%, Mutation ≥${langConfig.thresholds.min_mutation * 100}%`
          );
        } catch (langError) {
          console.warn(chalk.yellow('⚠️  Could not generate language config:'), langError.message);
        }
      } else {
        console.log(
          chalk.blue('ℹ️  Could not detect project language - using default configuration')
        );
      }
    }

    // Setup Cursor hooks if enabled
    if (answers && answers.enableCursorHooks) {
      console.log(chalk.cyan('📌 Setting up Cursor hooks...'));
      await scaffoldCursorHooks(
        process.cwd(),
        answers.cursorHookLevels || ['safety', 'quality', 'scope', 'audit']
      );
    }

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

    // Generate provenance if tools are available
    const tools = loadProvenanceTools && loadProvenanceTools();
    if (
      tools &&
      typeof tools.generateProvenance === 'function' &&
      typeof tools.saveProvenance === 'function'
    ) {
      const provenance = tools.generateProvenance(provenanceData);
      await tools.saveProvenance(provenance, '.agent/provenance.json');
      console.log(chalk.green('✅ Provenance manifest generated'));
    } else {
      console.log(
        chalk.yellow('⚠️  Provenance tools not available - skipping manifest generation')
      );
    }

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

        // Configure git author information
        const gitConfig = answers.git_config || {};
        const authorName = process.env.GIT_AUTHOR_NAME || gitConfig.author_name;
        const authorEmail = process.env.GIT_AUTHOR_EMAIL || gitConfig.author_email;

        if (authorName && authorEmail) {
          require('child_process').execSync(`git config user.name "${authorName}"`, {
            stdio: 'inherit',
          });
          require('child_process').execSync(`git config user.email "${authorEmail}"`, {
            stdio: 'inherit',
          });
          console.log(chalk.green(`✅ Git configured: ${authorName} <${authorEmail}>`));
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
        console.warn(
          chalk.yellow('⚠️  Failed to initialize git repository:'),
          error?.message || String(error)
        );
        console.warn(chalk.blue('💡 You can initialize git manually later with:'));
        console.warn("   git init && git add . && git commit -m 'Initial CAWS project setup'");
      }
    }
  } catch (error) {
    console.error(
      chalk.red('❌ Error during project finalization:'),
      error?.message || String(error)
    );
  }
}

/**
 * Display success message after project initialization
 */
function continueToSuccess() {
  const isCurrentDir =
    process.cwd() ===
    path.resolve(process.argv[3] === '.' ? process.cwd() : process.argv[3] || 'caws-project');

  console.log(chalk.green('\n🎉 CAWS project initialized successfully!'));

  if (isCurrentDir) {
    console.log(
      `📁 ${chalk.cyan('Initialized in current directory')}: ${path.resolve(process.cwd())}`
    );
    console.log(chalk.gray('   (CAWS files added to your existing project)'));
  } else {
    console.log(`📁 ${chalk.cyan('Project location')}: ${path.resolve(process.cwd())}`);
    console.log(chalk.gray('   (New subdirectory created with CAWS structure)'));
  }

  console.log(chalk.bold('\nNext steps:'));
  console.log('1. Customize .caws/working-spec.yaml');
  console.log('2. Review added CAWS tools and documentation');
  if (!isCurrentDir) {
    console.log('3. Move CAWS files to your main project if needed');
  }
  console.log('4. npm install (if using Node.js)');
  console.log('5. Set up your CI/CD pipeline');
  console.log(chalk.blue('\nFor help: caws --help'));
}

module.exports = {
  finalizeProject,
  continueToSuccess,
  setFinalizationDependencies,
};
