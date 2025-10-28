/**
 * CAWS Quality Gates Command
 *
 * Integrates the hardened quality gates system into the CAWS CLI.
 * Provides access to enterprise-grade quality enforcement with:
 * - Timeout protection and concurrent execution
 * - Comprehensive gate coverage (naming, duplication, god objects, documentation)
 * - JSON output and CI/CD integration
 * - Exception framework with audit trails
 *
 * @author @darianrosebrook
 */

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
// const { execSync } = require('child_process');
// const crypto = require('crypto');
// const yaml = require('js-yaml');

/**
 * Quality Gates Configuration
 */
// const QUALITY_CONFIG = {
//   godObjectThresholds: {
//     warning: 1750, // Lines of code
//     critical: 2000,
//   },
//   todoConfidenceThreshold: 0.8,
//   cawsTierThresholds: {
//     1: { coverage: 90, mutation: 70, contracts: true, review: true },
//     2: { coverage: 80, mutation: 50, contracts: true, review: false },
//     3: { coverage: 70, mutation: 30, contracts: false, review: false },
//   },
//   crisisResponseThresholds: {
//     godObjectCritical: 3000, // Higher threshold in crisis mode
//     todoConfidenceThreshold: 0.9, // Stricter TODO detection
//   },
// };

/**
 * Update provenance with quality gates results
 * @param {Object} results - Quality gates results
 * @param {boolean} crisisMode - Whether in crisis mode
 * @param {string[]} stagedFiles - Array of staged files
 */
// NOTE: updateProvenance function commented out to avoid lint errors

/**
 * Detect agent type for provenance tracking
 * @returns {string} Agent type identifier
 */
// function detectAgentType() {
//   try {
//     // Check for Cursor IDE indicators
//     if (process.env.CURSOR_USER_DATA_DIR) {
//       return 'cursor-ide';
//     }

//     // Check for VS Code indicators
//     if (process.env.VSCODE_PID) {
//       return 'vscode';
//     }

//     // Check for GitHub Copilot indicators
//     if (process.env.GITHUB_COPILOT_ENABLED) {
//       return 'github-copilot';
//     }

//     // Check for command line usage
//     if (process.env.TERM) {
//       return 'cli';
//     }

//     return 'unknown';
//   } catch (error) {
//     return 'unknown';
//   }
// }

/**
 * Check if a waiver applies to the given gate
 * @param {string} gate - Gate name to check
 * @returns {Object} Waiver check result
 */
// function checkWaiver(gate) {
//   try {
//     const waiversPath = path.join(process.cwd(), '.caws/waivers.yml');
//     if (!fs.existsSync(waiversPath)) {
//       return { waived: false, reason: 'No waivers file found' };
//     }

//     const waiversConfig = yaml.load(fs.readFileSync(waiversPath, 'utf8'));
//     const now = new Date();

//     // Find active waivers for this gate
//     const activeWaivers =
//       waiversConfig.waivers?.filter((waiver) => {
//         const expiresAt = new Date(waiver.expires_at);
//         return waiver.gates.includes(gate) && expiresAt > now && waiver.status === 'active';
//       }) || [];

//     if (activeWaivers.length > 0) {
//       const waiver = activeWaivers[0]; // Use first active waiver
//       return {
//         waived: true,
//         waiver,
//         reason: `Active waiver: ${waiver.title} (expires: ${waiver.expires_at})`,
//       };
//     }

//     return { waived: false, reason: 'No active waivers found' };
//   } catch (error) {
//     return { waived: false, reason: `Waiver check failed: ${error.message}` };
//   }
// }

/**
 * Detect if project is in crisis response mode
 * @returns {boolean} True if in crisis mode
 */
// function detectCrisisMode() {
//   try {
//     // Check for crisis indicators
//     const crisisIndicators = [
//       // Check for crisis response in working spec
//       () => {
//         const specPath = path.join(process.cwd(), '.caws/working-spec.yaml');
//         if (fs.existsSync(specPath)) {
//           const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
//           return spec.mode === 'crisis' || spec.crisis_mode === true;
//         }
//         return false;
//       },
//       // Check for crisis response in environment
//       () => process.env.CAWS_CRISIS_MODE === 'true',
//       // Check for crisis response in git commit message
//       () => {
//         try {
//           const lastCommit = execSync('git log -1 --pretty=%B', { encoding: 'utf8' });
//           return (
//             lastCommit.toLowerCase().includes('crisis') ||
//             lastCommit.toLowerCase().includes('emergency')
//           );
//         } catch {
//           return false;
//         }
//       },
//     ];

//     return crisisIndicators.some((indicator) => indicator());
//   } catch (error) {
//     return false;
//   }
// }

/**
 * Get staged files from git
 * @returns {string[]} Array of staged file paths
 */
// function getStagedFiles() {
//   try {
//     const stagedFiles = execSync('git diff --cached --name-only', { encoding: 'utf8' })
//       .trim()
//       .split('\n')
//       .filter((file) => file.trim() !== '');

//     return stagedFiles;
//   } catch (error) {
//     console.warn(chalk.yellow(`⚠️  Could not get staged files: ${error.message}`));
//     return [];
//   }
// }

/**
 * Check for god objects in staged Rust files with waiver and crisis mode support
 * @param {string[]} stagedFiles - Array of staged file paths
 * @param {boolean} crisisMode - Whether in crisis response mode
 * @returns {Object} God object analysis results
 */
// function checkGodObjects(stagedFiles, crisisMode = false) {
// const rustFiles = stagedFiles.filter((file) => file.endsWith('.rs'));

// if (rustFiles.length === 0) {
//   return { violations: [], warnings: [], total: 0, errors: [] };
// }

// console.log(chalk.blue(`📁 Found ${rustFiles.length} staged Rust files to check`));

// // Check for god object waiver
// const waiverCheck = checkWaiver('god_objects');
// if (waiverCheck.waived) {
//   console.log(chalk.yellow(`⚠️  God object check waived: ${waiverCheck.reason}`));
//   return { violations: [], warnings: [], total: 0, waived: true, errors: [] };
// }

// const violations = [];
// const warnings = [];
// const errors = [];

// // Use crisis mode thresholds if in crisis
// const thresholds = crisisMode
//   ? {
//       warning: QUALITY_CONFIG.godObjectThresholds.warning,
//       critical: QUALITY_CONFIG.crisisResponseThresholds.godObjectCritical,
//     }
//   : QUALITY_CONFIG.godObjectThresholds;

// for (const file of rustFiles) {
//   try {
//     const fullPath = path.resolve(file);
//     if (!fs.existsSync(fullPath)) continue;

//     const content = fs.readFileSync(fullPath, 'utf8');
//     const lineCount = content.split('\n').length;
//     const fileSizeKB = fs.statSync(fullPath).size / 1024;

//     if (lineCount >= thresholds.critical) {
//       const error = createGodObjectError(file, lineCount, thresholds.critical, {
//         fileSizeKB,
//         relativePath: file,
//         crisisMode,
//       });

//       violations.push({
//         file,
//         lines: lineCount,
//         severity: 'critical',
//         message: `CRITICAL: ${lineCount} LOC exceeds god object threshold (${thresholds.critical}+ LOC)${crisisMode ? ' [CRISIS MODE]' : ''}`,
//         error: error.toJSON(),
//       });

//       errors.push(error);
//     } else if (lineCount >= thresholds.warning) {
//       const error = createGodObjectError(file, lineCount, thresholds.warning, {
//         fileSizeKB,
//         relativePath: file,
//         crisisMode,
//       });

//       warnings.push({
//         file,
//         lines: lineCount,
//         severity: 'warning',
//         message: `WARNING: ${lineCount} LOC approaches god object territory (${thresholds.warning}+ LOC)${crisisMode ? ' [CRISIS MODE]' : ''}`,
//         error: error.toJSON(),
//       });

//       errors.push(error);
//     }
//   } catch (error) {
//     const fsError = createFileSystemError('read_file', file, error, {
//       operation: 'check_god_objects',
//     });
//     errors.push(fsError);
//     console.warn(chalk.yellow(`⚠️  Could not analyze ${file}: ${error.message}`));
//   }
// }

// return { violations, warnings, total: violations.length + warnings.length, errors };
// }

/**
 * Check for hidden TODOs in staged files with waiver and crisis mode support
 * @param {string[]} stagedFiles - Array of staged file paths
 * @param {boolean} crisisMode - Whether in crisis response mode
 * @returns {Object} TODO analysis results
 */
// function checkHiddenTodos(stagedFiles, crisisMode = false) {
// const supportedFiles = stagedFiles.filter((file) => /\.(rs|ts|tsx|js|jsx|py)$/.test(file));

// if (supportedFiles.length === 0) {
//   return { todos: [], blocking: 0, total: 0, errors: [] };
// }

// console.log(chalk.blue(`📁 Found ${supportedFiles.length} staged files to analyze for TODOs`));

// // Check for TODO waiver
// const waiverCheck = checkWaiver('hidden_todos');
// if (waiverCheck.waived) {
//   console.log(chalk.yellow(`⚠️  Hidden TODO check waived: ${waiverCheck.reason}`));
//   return { todos: [], blocking: 0, total: 0, waived: true, errors: [] };
// }

// try {
//   // Use crisis mode confidence threshold if in crisis
//   const confidenceThreshold = crisisMode
//     ? QUALITY_CONFIG.crisisResponseThresholds.todoConfidenceThreshold
//     : QUALITY_CONFIG.todoConfidenceThreshold;

//   // Run the TODO analyzer with staged files
//   const result = execSync(
//     `python3 scripts/v3/analysis/todo_analyzer.py --staged-only --min-confidence ${confidenceThreshold}`,
//     { encoding: 'utf8', cwd: process.cwd() }
//   );

//   // Parse the output to extract TODO count
//   const lines = result.split('\n');
//   const summaryLine = lines.find((line) => line.includes('Total hidden TODOs:'));
//   const todoCount = summaryLine ? parseInt(summaryLine.split(':')[1].trim()) : 0;

//   const errors = [];
//   if (todoCount > 0) {
//     // Create error for each file with TODOs (simplified for now)
//     const error = createHiddenTodoError('staged_files', todoCount, confidenceThreshold, {
//       crisisMode,
//       analyzerOutput: result,
//       confidenceThreshold,
//     });
//     errors.push(error);
//   }

//   return {
//     todos: [],
//     blocking: todoCount,
//     total: todoCount,
//     details: result,
//     crisisMode,
//     errors,
//   };
// } catch (error) {
//   const execError = createExecutionError(
//     'python3 scripts/v3/analysis/todo_analyzer.py',
//     error.status || 1,
//     error.stderr || error.message,
//     {
//       stdout: error.stdout,
//       workingDirectory: process.cwd(),
//     }
//   );

//   console.warn(chalk.yellow(`⚠️  Could not run TODO analysis: ${error.message}`));
//   return { todos: [], blocking: 0, total: 0, errors: [execError] };
// }
// }

/**
 * Check for human override in working spec
 * @returns {Object} Human override check result
 */
// function checkHumanOverride() {
//   try {
//     const specPath = path.join(process.cwd(), '.caws/working-spec.yaml');
//     if (!fs.existsSync(specPath)) {
//       return { override: false, reason: 'No working spec found' };
//     }

//     const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
//     const humanOverride = spec.human_override;

//     if (humanOverride && humanOverride.active) {
//       return {
//         override: true,
//         reason: humanOverride.reason || 'Human override active',
//         timestamp: humanOverride.timestamp,
//         approver: humanOverride.approver,
//       };
//     }

//     return { override: false, reason: 'No human override found' };
//   } catch (error) {
//     return { override: false, reason: `Override check failed: ${error.message}` };
//   }
// }

/**
 * Get CAWS tier from working spec
 * @returns {number|null} CAWS tier (1, 2, or 3) or null if not found
 */
// function getCawsTier() {
//   try {
//     const specPath = path.join(process.cwd(), '.caws/working-spec.yaml');
//     if (!fs.existsSync(specPath)) return null;

//     const spec = yaml.load(fs.readFileSync(specPath, 'utf8'));
//     return spec.risk_tier || null;
//   } catch (error) {
//     return null;
//   }
// }

/**
 * Run comprehensive quality gates on staged files
 * @param {Object} options - Command options
 */
async function qualityGatesCommand(options = {}) {
  try {
    console.log(chalk.bold('\n🚦 CAWS Quality Gates - Enterprise Code Quality Enforcement'));
    console.log('='.repeat(70));

    // Find the quality gates runner script
    const cliSrcDir = path.dirname(__filename); // packages/caws-cli/src/commands -> packages/caws-cli/src/commands
    const cliSrcRoot = path.dirname(cliSrcDir); // packages/caws-cli/src/commands -> packages/caws-cli/src
    const cliPackageDir = path.dirname(cliSrcRoot); // packages/caws-cli/src -> packages/caws-cli
    const packagesDir = path.dirname(cliPackageDir); // packages/caws-cli -> packages
    const qualityGatesRunner = path.join(packagesDir, 'quality-gates', 'run-quality-gates.mjs');

    // Check if the runner exists
    if (!fs.existsSync(qualityGatesRunner)) {
      console.error(chalk.red('❌ Quality gates runner not found at:'));
      console.error(chalk.gray(`   ${qualityGatesRunner}`));
      console.error(chalk.yellow('💡 Run from project root or ensure quality gates are installed'));
      process.exit(1);
    }

    // Build command arguments
    const args = ['node', qualityGatesRunner];

    // Map CLI options to runner options
    if (options.ci) {
      args.push('--ci');
    }

    if (options.json) {
      args.push('--json');
    }

    if (options.gates && options.gates.trim()) {
      args.push('--gates', options.gates.trim());
    }

    if (options.fix) {
      args.push('--fix');
    }

    // Add CAWS-specific environment variables for integration
    const env = {
      ...process.env,
      CAWS_CLI_INTEGRATION: 'true',
      CAWS_CLI_VERSION: require(path.join(cliPackageDir, 'package.json')).version,
    };

    // Set GitHub Actions summary if available
    if (process.env.GITHUB_STEP_SUMMARY) {
      env.GITHUB_STEP_SUMMARY = process.env.GITHUB_STEP_SUMMARY;
    }

    console.log(chalk.blue('📁 Executing quality gates runner...'));
    console.log(chalk.gray(`   Command: ${args.join(' ')}`));

    // Execute the quality gates runner
    const child = spawn(args[0], args.slice(1), {
      stdio: 'inherit',
      cwd: packagesDir,
      env: env,
    });

    // Wait for completion
    return new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) {
          console.log(chalk.green('\n✅ Quality gates completed successfully'));
          resolve();
        } else {
          console.log(chalk.red(`\n❌ Quality gates failed with exit code: ${code}`));
          if (options.ci) {
            process.exit(code);
          }
          reject(new Error(`Quality gates failed with exit code: ${code}`));
        }
      });

      child.on('error', (error) => {
        console.error(chalk.red('❌ Failed to execute quality gates runner:'), error.message);
        reject(error);
      });
    });
  } catch (error) {
    console.error(chalk.red('❌ CAWS Quality Gates command failed:'), error.message);
    console.error(chalk.gray('Stack trace:'), error.stack);

    // Provide helpful troubleshooting
    console.log(chalk.yellow('\n🔧 Troubleshooting:'));
    console.log(chalk.gray("   • Ensure you're running from the project root"));
    console.log(
      chalk.gray('   • Check that quality gates are installed: ls packages/quality-gates/')
    );
    console.log(chalk.gray('   • Verify Node.js version: node --version'));
    console.log(
      chalk.gray('   • Try direct execution: node packages/quality-gates/run-quality-gates.mjs')
    );

    throw error;
  }
}

module.exports = {
  qualityGatesCommand,
};
