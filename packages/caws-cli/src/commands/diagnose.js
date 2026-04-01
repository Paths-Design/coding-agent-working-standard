/**
 * @fileoverview CAWS Diagnose Command
 * Run health checks and suggest fixes
 * @author @darianrosebrook
 */

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const chalk = require('chalk');
const { resolveSpec } = require('../utils/spec-resolver');

// Import utilities
const { checkTypeScriptTestConfig } = require('../utils/typescript-detector');
const { configureJestForTypeScript } = require('../generators/jest-config-generator');

/**
 * Health check: Working spec validity
 * @returns {Promise<Object>} Check result
 */
async function checkWorkingSpec(options = {}) {
  try {
    const resolved = await resolveSpec({
      specId: options.specId,
      specFile: options.spec,
      warnLegacy: false,
      interactive: false,
    });
    const spec = resolved.spec;
    const specPath = path.relative(process.cwd(), resolved.path);

    // Basic validation
    if (!spec.id || !spec.title || !spec.risk_tier) {
      return {
        passed: false,
        severity: 'high',
        message: `Spec missing required fields (${specPath})`,
        fix: 'Run: caws validate for details',
        autoFixable: false,
      };
    }

    return {
      passed: true,
      message: `Spec is valid (${specPath})`,
    };
  } catch (error) {
    if (error.message === 'Spec ID required when multiple specs exist' && !options.specId) {
      return {
        passed: false,
        severity: 'high',
        message: 'Multiple specs detected, but no --spec-id was provided',
        fix: 'Run: caws diagnose --spec-id <id>',
        autoFixable: false,
      };
    }
    if (error.message.includes('No CAWS spec found')) {
      return {
        passed: false,
        severity: 'high',
        message: 'No CAWS spec found',
        fix: 'Initialize CAWS: caws init . or create a feature spec with caws specs create <id>',
        autoFixable: false,
      };
    }
    return {
      passed: false,
      severity: 'high',
      message: `Spec has errors: ${error.message}`,
      fix: 'Run: caws validate for details',
      autoFixable: false,
    };
  }
}

/**
 * Health check: Git repository
 * @returns {Promise<Object>} Check result
 */
async function checkGitSetup() {
  if (!(await fs.pathExists('.git'))) {
    return {
      passed: false,
      severity: 'medium',
      message: 'Not a git repository',
      fix: 'Initialize git: git init',
      autoFixable: false,
    };
  }

  return {
    passed: true,
    message: 'Git repository initialized',
  };
}

/**
 * Health check: Git hooks
 * @returns {Promise<Object>} Check result
 */
async function checkGitHooks() {
  const hooksDir = '.git/hooks';

  if (!(await fs.pathExists(hooksDir))) {
    return {
      passed: false,
      severity: 'medium',
      message: 'Git hooks directory not found',
      fix: 'Ensure .git directory exists',
      autoFixable: false,
    };
  }

  const cawsHooks = ['pre-commit', 'post-commit', 'pre-push'];
  let installedCount = 0;

  for (const hook of cawsHooks) {
    const hookPath = path.join(hooksDir, hook);
    if (await fs.pathExists(hookPath)) {
      const content = await fs.readFile(hookPath, 'utf8');
      if (content.includes('CAWS')) {
        installedCount++;
      }
    }
  }

  if (installedCount === 0) {
    return {
      passed: false,
      severity: 'low',
      message: 'No CAWS git hooks installed',
      fix: 'Install hooks: caws hooks install',
      autoFixable: false,
    };
  }

  return {
    passed: true,
    message: `${installedCount}/${cawsHooks.length} CAWS hooks installed`,
  };
}

/**
 * Health check: TypeScript configuration
 * @returns {Promise<Object>} Check result
 */
async function checkTypeScriptConfig() {
  const tsConfig = checkTypeScriptTestConfig('.');

  if (!tsConfig.isTypeScript) {
    return {
      passed: true,
      message: 'Not a TypeScript project (check skipped)',
      skipped: true,
    };
  }

  // If we have workspaces, provide context about where the TypeScript setup was found
  let messageSuffix = '';
  if (tsConfig.workspaceInfo.hasWorkspaces && tsConfig.workspaceInfo.primaryWorkspace) {
    messageSuffix = ` (detected in workspace: ${tsConfig.workspaceInfo.primaryWorkspace})`;
  }

  if (tsConfig.needsJestConfig) {
    return {
      passed: false,
      severity: 'medium',
      message: `TypeScript project missing Jest configuration${messageSuffix}`,
      fix: 'Auto-configure Jest for TypeScript',
      autoFixable: true,
      autoFix: async () => {
        const result = await configureJestForTypeScript('.', { quiet: false });
        return {
          success: result.configured,
          message: 'Jest configuration created',
          nextSteps: result.nextSteps,
        };
      },
    };
  }

  if (tsConfig.needsTsJest) {
    const workspaceContext = tsConfig.workspaceInfo.primaryWorkspace
      ? ` (in workspace: ${tsConfig.workspaceInfo.primaryWorkspace})`
      : '';

    return {
      passed: false,
      severity: 'high',
      message: `TypeScript + Jest detected but missing ts-jest${workspaceContext}`,
      fix: `Install ts-jest in ${tsConfig.workspaceInfo.primaryWorkspace || 'root'}: npm install --save-dev ts-jest`,
      autoFixable: false,
      details: {
        searchedLocations: tsConfig.workspaceInfo.primaryWorkspace
          ? [`${tsConfig.workspaceInfo.primaryWorkspace}/package.json`]
          : ['package.json'],
        frameworkDetected: tsConfig.testFramework.framework,
        hasJest: tsConfig.testFramework.hasJest,
        hasTsJest: tsConfig.testFramework.hasTsJest,
        workspacesChecked: tsConfig.workspaceInfo.allWorkspaces,
      },
    };
  }

  return {
    passed: true,
    message: `TypeScript configuration is correct${messageSuffix}`,
  };
}

/**
 * Health check: Test files exist
 * @returns {Promise<Object>} Check result
 */
async function checkTestFiles() {
  const testsDirs = ['tests', 'test', '__tests__', 'spec'];
  let testsDir = null;

  for (const dir of testsDirs) {
    if (await fs.pathExists(dir)) {
      testsDir = dir;
      break;
    }
  }

  if (!testsDir) {
    return {
      passed: false,
      severity: 'medium',
      message: 'No tests directory found',
      fix: 'Create tests directory: mkdir tests',
      autoFixable: true,
      autoFix: async () => {
        await fs.ensureDir('tests');
        await fs.ensureDir('tests/unit');
        await fs.ensureDir('tests/integration');
        return {
          success: true,
          message: 'Created tests/ directory structure',
        };
      },
    };
  }

  return {
    passed: true,
    message: `Tests directory exists: ${testsDir}/`,
  };
}

/**
 * Health check: CAWS tools directory
 * @returns {Promise<Object>} Check result
 */
async function checkCAWSTools() {
  // Check new location first, then legacy location for backward compatibility
  const toolsPath = '.caws/tools';
  const legacyToolsPath = 'apps/tools/caws';

  if (!(await fs.pathExists(toolsPath)) && !(await fs.pathExists(legacyToolsPath))) {
    return {
      passed: true,
      severity: 'info',
      message: 'CAWS tools directory not found (optional - use CLI commands instead)',
      fix: 'Core functionality available via: caws validate, caws quality-gates, caws provenance',
      autoFixable: false,
    };
  }

  // Tools directory exists - check for specialized tools (not core CLI duplicates)
  const specializedTools = ['flake-detector.ts', 'spec-test-mapper.ts', 'perf-budgets.ts'];
  const foundTools = [];

  for (const tool of specializedTools) {
    if (await fs.pathExists(path.join(toolsPath, tool))) {
      foundTools.push(tool);
    }
  }

  if (foundTools.length === 0) {
    return {
      passed: true,
      severity: 'info',
      message: 'No specialized tools found (optional - use CLI commands for core functionality)',
      fix: 'Core functionality available via: caws validate, caws quality-gates, caws provenance',
      autoFixable: false,
    };
  }

  return {
    passed: true,
    message: `Found ${foundTools.length} specialized tool(s): ${foundTools.join(', ')}`,
    note: 'Core functionality (validate, quality-gates, provenance) available via CLI commands',
  };
}

/**
 * Run all health checks
 * @returns {Promise<Object>} Diagnosis results
 */
async function runDiagnosis(options = {}) {
  const checks = [
    { name: 'Working spec validity', fn: () => checkWorkingSpec(options) },
    { name: 'Git repository', fn: checkGitSetup },
    { name: 'Git hooks', fn: checkGitHooks },
    { name: 'TypeScript configuration', fn: checkTypeScriptConfig },
    { name: 'Test files', fn: checkTestFiles },
    { name: 'CAWS tools', fn: checkCAWSTools },
  ];

  console.log(chalk.cyan('\nDiagnosing CAWS Project...\n'));
  console.log(chalk.gray('Running checks:'));

  const results = [];

  for (const check of checks) {
    process.stdout.write(chalk.gray(`   ${check.name}... `));

    try {
      const result = await check.fn();

      if (result.skipped) {
        console.log(chalk.gray('skipped'));
      } else if (result.passed) {
        console.log(chalk.green(''));
      } else {
        const icon = result.severity === 'high' ? chalk.red('') : chalk.yellow('');
        console.log(icon);
      }

      results.push({
        name: check.name,
        ...result,
      });
    } catch (error) {
      console.log(chalk.red(''));
      results.push({
        name: check.name,
        passed: false,
        severity: 'high',
        message: `Check failed: ${error.message}`,
        fix: 'Review error and try again',
        autoFixable: false,
      });
    }
  }

  return results;
}

/**
 * Display diagnosis results
 * @param {Object[]} results - Diagnosis results
 */
function displayResults(results) {
  const issues = results.filter((r) => !r.passed && !r.skipped);

  if (issues.length === 0) {
    console.log(chalk.green('\nNo issues found! Your CAWS project is healthy.\n'));
    return;
  }

  console.log(
    chalk.bold.yellow(`\nFound ${issues.length} issue${issues.length > 1 ? 's' : ''}:\n`)
  );

  issues.forEach((issue, index) => {
    const icon = issue.severity === 'high' ? chalk.red('') : chalk.yellow('');
    const severity = chalk.gray(`[${issue.severity.toUpperCase()}]`);

    console.log(`${index + 1}. ${icon} ${issue.name} ${severity}`);
    console.log(chalk.white(`   Issue: ${issue.message}`));
    console.log(chalk.cyan(`   Fix: ${issue.fix}`));

    if (issue.autoFixable) {
      console.log(chalk.green('   Auto-fix available'));
    }

    // Show additional details if available
    if (issue.details) {
      console.log(chalk.gray('   Details:'));
      if (issue.details.searchedLocations) {
        console.log(chalk.gray(`      Searched: ${issue.details.searchedLocations.join(', ')}`));
      }
      if (issue.details.frameworkDetected) {
        console.log(chalk.gray(`      Framework: ${issue.details.frameworkDetected}`));
      }
      if (issue.details.workspacesChecked && issue.details.workspacesChecked.length > 0) {
        console.log(
          chalk.gray(`      Workspaces checked: ${issue.details.workspacesChecked.join(', ')}`)
        );
      }
    }

    console.log('');
  });
}

/**
 * Apply automatic fixes
 * @param {Object[]} results - Diagnosis results
 * @returns {Promise<Object>} Fix results
 */
async function applyAutoFixes(results) {
  const fixableIssues = results.filter((r) => !r.passed && r.autoFixable && r.autoFix);

  if (fixableIssues.length === 0) {
    console.log(chalk.yellow('\nNo auto-fixable issues found\n'));
    return {
      applied: 0,
      skipped: 0,
      failed: 0,
    };
  }

  console.log(chalk.cyan(`\nApplying ${fixableIssues.length} automatic fixes...\n`));

  let applied = 0;
  let failed = 0;

  for (const issue of fixableIssues) {
    process.stdout.write(chalk.gray(`   Fixing: ${issue.name}... `));

    try {
      const result = await issue.autoFix();

      if (result.success) {
        console.log(chalk.green(''));
        applied++;

        if (result.nextSteps && result.nextSteps.length > 0) {
          console.log(chalk.blue('   Next steps:'));
          result.nextSteps.forEach((step) => {
            console.log(chalk.blue(`      ${step}`));
          });
        }
      } else {
        console.log(chalk.red(''));
        failed++;
      }
    } catch (error) {
      console.log(chalk.red(`${error.message}`));
      failed++;
    }
  }

  console.log(chalk.bold.green(`\nResults: ${applied} fixed, ${failed} failed\n`));

  return {
    applied,
    skipped: results.filter((r) => !r.passed && !r.autoFixable).length,
    failed,
  };
}

/**
 * Diagnose command handler
 * @param {Object} options - Command options
 */
async function diagnoseCommand(options = {}) {
  try {
    // Run all health checks
    const results = await runDiagnosis(options);

    // Display results
    displayResults(results);

    // Check if there are auto-fixable issues
    const fixableCount = results.filter((r) => !r.passed && r.autoFixable).length;

    if (fixableCount > 0 && !options.fix) {
      console.log(
        chalk.yellow(
          `${fixableCount} issue${fixableCount > 1 ? 's' : ''} can be fixed automatically`
        )
      );
      console.log(chalk.yellow('   Run: caws diagnose --fix to apply fixes\n'));
    } else if (options.fix) {
      const fixResults = await applyAutoFixes(results);

      if (fixResults.applied > 0) {
        console.log(chalk.green('Auto-fixes applied successfully'));
        console.log(chalk.blue('Run: caws validate to verify fixes\n'));
      }

      if (fixResults.skipped > 0) {
        console.log(
          chalk.yellow(
            `${fixResults.skipped} issue${fixResults.skipped > 1 ? 's' : ''} require manual intervention\n`
          )
        );
      }
    }

    // Provide next steps
    const issueCount = results.filter((r) => !r.passed && !r.skipped).length;

    if (issueCount === 0) {
      console.log(chalk.blue('Next steps:'));
      console.log(chalk.blue('   - Run: caws status --visual to view project health'));
      console.log(chalk.blue('   - Run: caws validate to check working spec'));
      console.log(chalk.blue('   - Optional: Create .caws/policy.yaml for custom budgets'));
      console.log(
        chalk.blue('   - Start implementing: caws iterate --current-state "Ready to begin"')
      );
    }
  } catch (error) {
    console.error(chalk.red('\nError running diagnosis:'), error.message);
    console.error(chalk.yellow('\nTry: caws status for basic health check'));
    process.exit(1);
  }
}

module.exports = {
  diagnoseCommand,
  runDiagnosis,
  displayResults,
  applyAutoFixes,
  // Export individual checks for testing
  checkWorkingSpec,
  checkGitSetup,
  checkGitHooks,
  checkTypeScriptConfig,
  checkTestFiles,
  checkCAWSTools,
};
