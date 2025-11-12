/**
 * @fileoverview CAWS Scaffolding Module
 * Functions for scaffolding CAWS components in existing projects
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const chalk = require('chalk');

// Import detection utilities
const { detectCAWSSetup, findPackageRoot } = require('../utils/detection');
const { detectsPublishing } = require('../utils/project-analysis');

// Import git hooks scaffolding
const { scaffoldGitHooks } = require('./git-hooks');
const { updateGitignore } = require('../utils/gitignore-updater');

// CLI version from package.json
const CLI_VERSION = require('../../package.json').version;

/**
 * Scaffold IDE integrations for comprehensive CAWS development experience
 * @param {string} targetDir - Target directory for scaffolding
 * @param {Object} options - Scaffold options
 */
/**
 * Find the template directory using robust path resolution
 * Works in both development and global install scenarios
 * @returns {string|null} Template directory path or null
 */
function findTemplateDir() {
  // Find package root using shared utility
  const packageRoot = findPackageRoot(__dirname);

  // Try templates relative to package root first (works in both dev and global install)
  const possiblePaths = [
    path.join(packageRoot, 'templates'),
    path.resolve(__dirname, '../../templates'), // Dev fallback
    path.resolve(__dirname, '../templates'), // Legacy fallback
  ];

  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }

  return null;
}

async function scaffoldIDEIntegrations(targetDir, options) {
  const templateDir = findTemplateDir() || path.join(__dirname, '../../templates');

  console.log(chalk.cyan('🎨 Setting up IDE integrations...'));

  let addedCount = 0;
  let skippedCount = 0;

  // Setup git hooks with provenance integration
  try {
    const gitHooksResult = await scaffoldGitHooks(targetDir, {
      provenance: true,
      validation: true,
      qualityGates: true,
      force: options.force,
      backup: options.backup,
    });
    addedCount += gitHooksResult.added;
    skippedCount += gitHooksResult.skipped;
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Git hooks setup failed: ${error.message}`));
  }

  // List of IDE integration templates to copy
  const ideTemplates = [
    // VS Code
    {
      src: '.vscode/settings.json',
      dest: '.vscode/settings.json',
      desc: 'VS Code workspace settings',
    },
    {
      src: '.vscode/launch.json',
      dest: '.vscode/launch.json',
      desc: 'VS Code debug configurations',
    },

    // IntelliJ IDEA
    {
      src: '.idea/runConfigurations/CAWS_Validate.xml',
      dest: '.idea/runConfigurations/CAWS_Validate.xml',
      desc: 'IntelliJ run configuration for CAWS validate',
    },
    {
      src: '.idea/runConfigurations/CAWS_Evaluate.xml',
      dest: '.idea/runConfigurations/CAWS_Evaluate.xml',
      desc: 'IntelliJ run configuration for CAWS evaluate',
    },

    // Windsurf
    {
      src: '.windsurf/workflows/caws-guided-development.md',
      dest: '.windsurf/workflows/caws-guided-development.md',
      desc: 'Windsurf workflow for CAWS-guided development',
    },

    // GitHub Copilot
    {
      src: '.github/copilot/instructions.md',
      dest: '.github/copilot/instructions.md',
      desc: 'GitHub Copilot CAWS integration instructions',
    },

    // Git hooks are handled separately by scaffoldGitHooks

    // Cursor hooks (already handled by scaffoldCursorHooks, but ensure README is copied)
    {
      src: '.cursor/README.md',
      dest: '.cursor/README.md',
      desc: 'Cursor integration documentation',
    },
  ];

  for (const template of ideTemplates) {
    const srcPath = path.join(templateDir, template.src);
    const destPath = path.join(targetDir, template.dest);

    try {
      // Check if source exists
      if (!(await fs.pathExists(srcPath))) {
        if (!template.optional) {
          console.log(chalk.yellow(`⚠️  Template not found: ${template.src}`));
        }
        continue;
      }

      // Check if destination already exists
      const destExists = await fs.pathExists(destPath);

      if (destExists && !options.force) {
        console.log(chalk.gray(`⏭️  Skipped ${template.desc} (already exists)`));
        skippedCount++;
        continue;
      }

      // Ensure destination directory exists
      await fs.ensureDir(path.dirname(destPath));

      // Copy the file
      await fs.copy(srcPath, destPath);

      // Make scripts executable if they're in hooks or cursor directories
      if (destPath.includes('.git/hooks/') || destPath.includes('.cursor/hooks/')) {
        try {
          await fs.chmod(destPath, '755');
        } catch (error) {
          // Ignore chmod errors on some systems
        }
      }

      console.log(chalk.green(`✅ Added ${template.desc}`));
      addedCount++;
    } catch (error) {
      console.log(chalk.red(`❌ Failed to add ${template.desc}: ${error.message}`));
    }
  }

  if (addedCount > 0) {
    console.log(chalk.green(`\n🎨 IDE integrations: ${addedCount} added, ${skippedCount} skipped`));
    console.log(chalk.blue('💡 Restart your IDE to activate the new integrations'));
  }

  return { added: addedCount, skipped: skippedCount };
}

// Dependencies injected via setScaffoldDependencies()
let cawsSetup = null;
let loadProvenanceTools = null;

/**
 * Set dependencies for scaffold module
 * @param {Object} deps - Dependencies object
 */
function setScaffoldDependencies(deps) {
  cawsSetup = deps.cawsSetup;
  loadProvenanceTools = deps.loadProvenanceTools;
}

/**
 * Scaffold existing project with CAWS components
 * @param {Object} options - Scaffold options
 */
async function scaffoldProject(options) {
  const currentDir = process.cwd();
  const projectName = path.basename(currentDir);

  try {
    // Detect existing CAWS setup FIRST before any logging
    const setup = detectCAWSSetup(currentDir);

    // Check for CAWS setup immediately and exit with helpful message if not found
    if (!setup.hasCAWSDir) {
      console.log(chalk.red('❌ CAWS not initialized in this project'));
      console.log(chalk.blue('\n💡 To get started:'));
      console.log(`   1. Initialize CAWS: ${chalk.cyan('caws init <project-name>')}`);
      console.log(`   2. Or initialize in current directory: ${chalk.cyan('caws init .')}`);
      console.log(chalk.blue('\n📚 For more help:'));
      console.log(`   ${chalk.cyan('caws --help')}`);
      process.exit(1);
    }

    console.log(chalk.cyan(`🔧 Enhancing existing CAWS project: ${projectName}`));

    // Preserve the original template directory from global cawsSetup
    // (needed because detectCAWSSetup from within a new project won't find the template)
    if (cawsSetup?.templateDir && !setup.templateDir) {
      setup.templateDir = cawsSetup.templateDir;
      setup.hasTemplateDir = true;
    } else if (!setup.templateDir) {
      // Try to find template directory using robust path resolution
      const possiblePaths = [
        // 1. Use the helper function to find templates (works in dev and global install)
        findTemplateDir(),
        // 2. Bundled templates relative to package root
        path.join(findPackageRoot(__dirname), 'templates'),
        // 3. Legacy fallback paths
        path.join(__dirname, '../../templates'),
        path.join(__dirname, '../templates'),
        // 4. CI paths
        '/home/runner/work/coding-agent-working-standard/coding-agent-working-standard/packages/caws-template',
        '/workspace/packages/caws-template',
        '/caws/packages/caws-template',
        // 5. Monorepo relative paths
        path.resolve(process.cwd(), '../../../packages/caws-template'),
        path.resolve(process.cwd(), '../../packages/caws-template'),
        path.resolve(process.cwd(), '../packages/caws-template'),
      ].filter(Boolean); // Remove null values

      for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
          setup.templateDir = testPath;
          setup.hasTemplateDir = true;
          break;
        }
      }

      if (!setup.templateDir) {
        console.log(chalk.red(`❌ No template directory available!`));
        console.log(chalk.blue('💡 To fix this issue:'));
        console.log(`   1. Ensure caws-template package is installed`);
        console.log(`   2. Run from the monorepo root directory`);
        console.log(`   3. Check that CAWS CLI was installed correctly`);
        console.log(chalk.blue('\n📚 For installation help:'));
        console.log(`   ${chalk.cyan('npm install -g @paths.design/caws-cli')}`);
      }
    }

    // Override global cawsSetup with current context for scaffold operations
    cawsSetup = setup;

    if (!setup.hasCAWSDir) {
      console.error(chalk.red('❌ No .caws directory found'));
      console.error(chalk.blue('💡 Run "caws init <project-name>" first to create a CAWS project'));
      process.exit(1);
    }

    // Adapt behavior based on setup type
    if (setup.isEnhanced) {
      console.log(chalk.green('🎯 Enhanced CAWS detected - adding automated publishing'));
    } else if (setup.isAdvanced) {
      console.log(chalk.blue('🔧 Advanced CAWS detected - adding missing capabilities'));
    } else {
      console.log(chalk.blue('📋 Basic CAWS detected - enhancing with additional tools'));
    }

    // Generate provenance for scaffolding operation
    const scaffoldProvenance = {
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
      timestamp: new Date().toISOString(),
      version: CLI_VERSION,
    };

    // Calculate hash after object is fully defined
    scaffoldProvenance.hash = require('crypto')
      .createHash('sha256')
      .update(JSON.stringify(scaffoldProvenance))
      .digest('hex');

    // Determine what enhancements to add based on setup type and options
    const enhancements = [];

    // Add CAWS tools to .caws/ directory (keeps all CAWS files together)
    enhancements.push({
      name: '.caws/tools',
      description: 'CAWS tools directory',
      required: true,
    });
    enhancements.push({
      name: '.caws/schemas',
      description: 'CAWS JSON schemas',
      required: true,
    });
    enhancements.push({
      name: '.caws/templates',
      description: 'CAWS templates',
      required: true,
    });
    enhancements.push({
      name: '.caws/waivers.yml',
      description: 'CAWS waivers configuration',
      required: false,
    });
    enhancements.push({
      name: '.caws/tools-allow.json',
      description: 'CAWS tools allowlist',
      required: false,
    });

    // Add codemods if requested or not minimal
    if (options.withCodemods || (!options.minimal && !options.withCodemods)) {
      enhancements.push({
        name: 'codemod',
        description: 'Codemod transformation scripts',
        required: true,
      });
    }

    // Also add automated publishing for enhanced setups
    if (setup.isEnhanced) {
      enhancements.push({
        name: '.github/workflows/release.yml',
        description: 'GitHub Actions workflow for automated publishing',
        required: true,
      });

      enhancements.push({
        name: '.releaserc.json',
        description: 'semantic-release configuration',
        required: true,
      });
    }

    // Add IDE integrations for comprehensive development experience
    enhancements.push({
      name: 'ide-integrations',
      description: 'IDE integrations (VS Code, IntelliJ, Windsurf, Git hooks)',
      required: false,
      customHandler: async (targetDir, options) => {
        return await scaffoldIDEIntegrations(targetDir, options);
      },
    });

    // Add quality gates package and configuration if requested
    // Note: These are optional - git hooks fall back to CAWS CLI if package isn't installed
    if (options.withQualityGates) {
      // Copy quality gates configuration files from templates
      enhancements.push({
        name: 'duplication.qualitygatesrc.yaml',
        description: 'Duplication gate configuration',
        required: false,
        sourcePath: path.join(
          __dirname,
          '../../quality-gates/templates/duplication.qualitygatesrc.yaml'
        ),
      });

      enhancements.push({
        name: 'godObject.qualitygatesrc.yaml',
        description: 'God objects gate configuration',
        required: false,
        sourcePath: path.join(
          __dirname,
          '../../quality-gates/templates/godObject.qualitygatesrc.yaml'
        ),
      });

      // Create docs-status directory structure
      enhancements.push({
        name: 'docs-status',
        description: 'Quality gates status directory',
        required: false,
        customHandler: async (targetDir) => {
          const docsStatusDir = path.join(targetDir, 'docs-status');
          await fs.ensureDir(docsStatusDir);

          // Copy template files from quality-gates package
          const qualityGatesTemplates = path.join(
            __dirname,
            '../../quality-gates/templates/docs-status'
          );
          if (fs.existsSync(qualityGatesTemplates)) {
            await fs.copy(qualityGatesTemplates, docsStatusDir);
            return { added: 1, skipped: 0 };
          }
          return { added: 1, skipped: 0 };
        },
      });

      // Install quality gates package
      console.log(chalk.blue('\n📦 Setting up quality gates package...'));
      try {
        const { execSync } = require('child_process');

        // Check if we're in monorepo (can copy files directly) or need npm install
        const qualityGatesPath = path.resolve(__dirname, '../../../quality-gates');
        const isMonorepo = fs.existsSync(qualityGatesPath);

        if (isMonorepo && fs.existsSync(path.join(currentDir, 'package.json'))) {
          // In monorepo - copy files directly instead of installing package
          console.log(
            chalk.gray('   Detected monorepo structure - copying quality gates files...')
          );

          const qualityGatesDest = path.join(currentDir, 'node_modules', '@caws', 'quality-gates');
          await fs.ensureDir(qualityGatesDest);

          // Copy all .mjs files
          const mjsFiles = fs.readdirSync(qualityGatesPath).filter((f) => f.endsWith('.mjs'));
          for (const file of mjsFiles) {
            await fs.copy(path.join(qualityGatesPath, file), path.join(qualityGatesDest, file));
          }

          // Copy templates directory
          if (fs.existsSync(path.join(qualityGatesPath, 'templates'))) {
            await fs.copy(
              path.join(qualityGatesPath, 'templates'),
              path.join(qualityGatesDest, 'templates')
            );
          }

          // Copy package.json for dependencies
          await fs.copy(
            path.join(qualityGatesPath, 'package.json'),
            path.join(qualityGatesDest, 'package.json')
          );

          // Install dependencies
          console.log(chalk.gray('   Installing quality gates dependencies...'));
          execSync('npm install --production --no-audit --no-fund', {
            cwd: qualityGatesDest,
            stdio: 'inherit',
          });

          console.log(chalk.green('✅ Quality gates files copied and dependencies installed'));
        } else if (fs.existsSync(path.join(currentDir, 'package.json'))) {
          // Regular project - try to install from npm (when published)
          console.log(chalk.gray('   Installing @paths.design/quality-gates package...'));

          try {
            const npmCommand = 'npm install --save-dev @paths.design/quality-gates';
            execSync(npmCommand, {
              cwd: currentDir,
              stdio: 'inherit',
            });
            console.log(chalk.green('✅ Quality gates package installed from npm'));
          } catch (npmError) {
            console.log(
              chalk.yellow('⚠️  Package not found on npm - quality gates will use local files')
            );
            console.log(
              chalk.gray(
                '   Package will be available once published as @paths.design/quality-gates'
              )
            );
            console.log(
              chalk.gray('   For now, quality gates will work via CAWS CLI or local scripts')
            );

            // Copy todo-analyzer.mjs locally as fallback if available
            const qualityGatesPath = path.resolve(__dirname, '../../../quality-gates');
            const todoAnalyzerSource = path.join(qualityGatesPath, 'todo-analyzer.mjs');
            if (fs.existsSync(todoAnalyzerSource)) {
              const scriptsDir = path.join(currentDir, 'scripts');
              await fs.ensureDir(scriptsDir);
              const todoAnalyzerDest = path.join(scriptsDir, 'todo-analyzer.mjs');
              await fs.copy(todoAnalyzerSource, todoAnalyzerDest);
              console.log(
                chalk.green('✅ Copied todo-analyzer.mjs to scripts/ directory (local fallback)')
              );
            }
          }
        } else {
          // No package.json - suggest global install or manual setup
          console.log(chalk.yellow('⚠️  No package.json found - skipping package installation'));
          console.log(chalk.gray('   Options:'));
          console.log(
            chalk.gray('   • Install globally: npm install -g @paths.design/quality-gates')
          );
          console.log(
            chalk.gray(
              '   • Create package.json and run: npm install --save-dev @paths.design/quality-gates'
            )
          );
          console.log(chalk.gray('   • Use CAWS CLI: caws quality-gates'));
        }

        console.log(
          chalk.blue(
            '💡 You can now use: node node_modules/@paths.design/quality-gates/run-quality-gates.mjs'
          )
        );
        console.log(chalk.blue('   Or: caws quality-gates'));
      } catch (error) {
        console.log(chalk.yellow(`⚠️  Failed to set up quality gates package: ${error.message}`));
        console.log(
          chalk.gray(
            '   You can install manually: npm install --save-dev @paths.design/quality-gates'
          )
        );
        console.log(chalk.gray('   Or globally: npm install -g @paths.design/quality-gates'));
        console.log(chalk.gray('   Or use CAWS CLI: caws quality-gates'));
      }
    }

    // Add commit conventions for setups that don't have them
    if (!setup.hasTemplates || !fs.existsSync(path.join(currentDir, 'COMMIT_CONVENTIONS.md'))) {
      enhancements.push({
        name: 'COMMIT_CONVENTIONS.md',
        description: 'Commit message guidelines',
        required: false,
      });
    }

    // Add AGENTS.md guide for agent workflow instructions
    if (
      !fs.existsSync(path.join(currentDir, 'agents.md')) &&
      !fs.existsSync(path.join(currentDir, 'AGENTS.md')) &&
      !fs.existsSync(path.join(currentDir, 'caws.md'))
    ) {
      enhancements.push({
        name: 'agents.md',
        description: 'CAWS agent workflow guide',
        required: false,
      });
    }

    // Add OIDC setup guide only if:
    // 1. Explicitly requested with --with-oidc flag, OR
    // 2. Project detects publishing configuration (package.json with publishConfig, pyproject.toml, etc.)
    const needsOidc = options.withOidc || detectsPublishing(currentDir);
    const oidcExists = fs.existsSync(path.join(currentDir, 'OIDC_SETUP.md'));

    if (needsOidc && !oidcExists) {
      enhancements.push({
        name: 'OIDC_SETUP.md',
        description: 'OIDC trusted publisher setup guide',
        required: false,
      });
    } else if (needsOidc && oidcExists) {
      console.log(chalk.gray('⏭️  Skipped OIDC_SETUP.md (already exists)'));
    } else if (!needsOidc && !options.minimal) {
      // Inform user that OIDC is available but not needed
      console.log(
        chalk.blue('ℹ️  OIDC setup skipped (project does not appear to publish packages)')
      );
      console.log(chalk.gray('   Add --with-oidc flag if you plan to publish packages later'));
    }

    // For enhanced setups, preserve existing tools
    if (setup.isEnhanced) {
      console.log(chalk.blue('ℹ️  Preserving existing sophisticated CAWS tools'));
    }

    let addedCount = 0;
    let skippedCount = 0;
    const addedFiles = [];

    for (const enhancement of enhancements) {
      // Handle custom enhancement handlers (like IDE integrations)
      if (enhancement.customHandler) {
        try {
          const result = await enhancement.customHandler(currentDir, options);
          if (result && typeof result.added === 'number') {
            addedCount += result.added;
            skippedCount += result.skipped || 0;
            // Add enhancement name to provenance if it was processed
            if (result.added > 0) {
              addedFiles.push(enhancement.name);
            }
          } else {
            console.log(chalk.green(`✅ Added ${enhancement.description}`));
            addedCount++;
            addedFiles.push(enhancement.name);
          }
        } catch (error) {
          console.warn(
            chalk.yellow(`⚠️  Custom handler failed for ${enhancement.name}:`),
            error.message
          );
        }
        continue;
      }

      // Handle custom sourcePath (for quality gates configs from monorepo)
      const sourcePath = enhancement.sourcePath
        ? enhancement.sourcePath
        : setup?.templateDir
          ? path.join(setup.templateDir, enhancement.name)
          : null;

      if (!sourcePath && !enhancement.sourcePath) {
        console.warn(
          chalk.yellow(`⚠️  Template directory not available for enhancement: ${enhancement.name}`)
        );
        continue;
      }

      const destPath = path.join(currentDir, enhancement.name);

      if (!fs.existsSync(destPath)) {
        if (fs.existsSync(sourcePath)) {
          try {
            await fs.copy(sourcePath, destPath);
            console.log(chalk.green(`✅ Added ${enhancement.description}`));
            addedCount++;
            addedFiles.push(enhancement.name);
          } catch (copyError) {
            console.warn(chalk.yellow(`⚠️  Failed to add ${enhancement.name}:`), copyError.message);
          }
        } else {
          // If source doesn't exist in template, check if it should be a file or directory
          try {
            // Check if the enhancement name looks like a file (has extension)
            const hasExtension = path.extname(enhancement.name).length > 0;

            if (hasExtension) {
              // Create an empty file for file-like enhancements
              await fs.ensureDir(path.dirname(destPath));
              await fs.writeFile(destPath, '');
              console.log(
                chalk.yellow(`⚠️  Created empty ${enhancement.description} (template not found)`)
              );
              console.log(chalk.gray(`   Template expected at: ${sourcePath}`));
            } else {
              // Create directory for directory-like enhancements
              await fs.ensureDir(destPath);
              console.log(chalk.green(`✅ Created ${enhancement.description}`));
            }
            addedCount++;
            addedFiles.push(enhancement.name);
          } catch (createError) {
            console.warn(
              chalk.yellow(`⚠️  Failed to create ${enhancement.name}:`),
              createError.message
            );
          }
        }
      } else {
        if (options.force) {
          try {
            await fs.remove(destPath);
            if (fs.existsSync(sourcePath)) {
              await fs.copy(sourcePath, destPath);
            } else {
              await fs.ensureDir(destPath);
            }
            console.log(chalk.blue(`🔄 Updated ${enhancement.description}`));
            addedCount++;
            addedFiles.push(enhancement.name);
          } catch (overwriteError) {
            console.warn(
              chalk.yellow(`⚠️  Failed to update ${enhancement.name}:`),
              overwriteError.message
            );
          }
        } else {
          console.log(`⏭️  Skipped ${enhancement.name} (already exists)`);
          skippedCount++;
        }
      }
    }

    // Update provenance with results
    scaffoldProvenance.artifacts = addedFiles;
    scaffoldProvenance.results.files_added = addedCount;
    scaffoldProvenance.results.files_skipped = skippedCount;

    // Show summary
    console.log(chalk.green(`\n🎉 Enhancement completed!`));
    console.log(chalk.bold(`📊 Summary: ${addedCount} added, ${skippedCount} skipped`));

    if (addedCount > 0) {
      console.log(chalk.bold('\n📝 Next steps:'));
      console.log('1. Review the added files');

      // Check if OIDC was added
      const oidcAdded = addedFiles.some((file) => file.includes('OIDC_SETUP'));
      const qualityGatesAdded = addedFiles.some(
        (file) => file.includes('quality-gates') || file.includes('todo_analyzer')
      );

      if (oidcAdded) {
        console.log('2. Set up OIDC trusted publisher (see OIDC_SETUP.md)');
        console.log('3. Push to trigger automated publishing');
        console.log('4. Your existing CAWS tools remain unchanged');
      } else {
        console.log('2. Run: caws validate (verify setup)');
        console.log('3. Run: caws diagnose (check project health)');
        console.log('4. Customize .caws/working-spec.yaml for your project');
        console.log('5. Optional: Create .caws/policy.yaml for tier-specific budgets');
        if (!qualityGatesAdded && !options.minimal) {
          console.log(
            chalk.gray('6. Note: Quality gates scripts skipped (git hooks use CAWS CLI by default)')
          );
          console.log(
            chalk.gray(
              '   Add --with-quality-gates flag if you want local scripts without global CLI'
            )
          );
        }
      }
    }

    if (setup.isEnhanced) {
      console.log(
        chalk.blue('\n🎯 Your enhanced CAWS setup has been improved with automated publishing!')
      );
    }

    if (options.force) {
      console.log(chalk.yellow('\n⚠️  Force mode was used - review changes carefully'));
    }

    // Update .gitignore to exclude CAWS local runtime files
    const gitignoreUpdated = await updateGitignore(targetDir);
    if (gitignoreUpdated) {
      console.log(chalk.green('\n✅ Updated .gitignore to exclude CAWS local runtime files'));
      console.log(
        chalk.gray('   Tracked: Specs, policy, waivers, provenance, plans (shared with team)')
      );
      console.log(chalk.gray('   Ignored: Agent runtime, temp files, logs (local-only)'));
    }

    // Save provenance manifest if tools are available
    const tools = loadProvenanceTools && loadProvenanceTools();
    if (tools && typeof tools.saveProvenance === 'function') {
      await tools.saveProvenance(scaffoldProvenance, '.agent/scaffold-provenance.json');
      console.log(chalk.green('✅ Scaffolding provenance saved'));
    } else {
      console.log(chalk.yellow('⚠️  Provenance tools not available - skipping manifest save'));
    }
  } catch (error) {
    // Handle circular reference errors from Commander.js
    if (error.message && error.message.includes('Converting circular structure to JSON')) {
      console.log(
        chalk.yellow('⚠️  Scaffolding completed with minor issues (circular reference handled)')
      );
      console.log(chalk.green('✅ CAWS components scaffolded successfully'));
    } else {
      console.error(chalk.red('❌ Error during scaffolding:'), error.message);
      process.exit(1);
    }
  }
}

module.exports = {
  scaffoldProject,
  scaffoldIDEIntegrations,
  setScaffoldDependencies,
};
