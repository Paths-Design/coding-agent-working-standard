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

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { commandWrapper, Output } = require('../utils/command-wrapper');
const { withTimeout } = require('../utils/async-utils');

// Quality gates runner implementation - delegates to external package

/**
 * Run comprehensive quality gates on staged files
 * @param {Object} options - Command options
 */
async function qualityGatesCommand(options = {}) {
  return commandWrapper(
    async () => {
      Output.section('CAWS Quality Gates - Enterprise Code Quality Enforcement');

      const projectRoot = process.cwd();
      let qualityGatesRunner = null;

      // Fallback chain for finding quality gates runner:
      // 1. Check monorepo structure (current behavior)
      // 2. Check node_modules for @paths.design/quality-gates package
      // 3. Check project-local scripts
      // 4. Provide helpful error with alternatives

      // Option 1: Check monorepo structure
      const cliSrcDir = path.dirname(__filename);
      const cliSrcRoot = path.dirname(cliSrcDir);
      const cliPackageDir = path.dirname(cliSrcRoot);
      const packagesDir = path.dirname(cliPackageDir);
      const monorepoRunner = path.join(packagesDir, 'quality-gates', 'run-quality-gates.mjs');

      if (fs.existsSync(monorepoRunner)) {
        qualityGatesRunner = monorepoRunner;
      } else {
        // Option 2: Check node_modules for quality-gates package
        const nodeModulesPaths = [
          path.join(projectRoot, 'node_modules', '@paths.design', 'quality-gates', 'run-quality-gates.mjs'),
          path.join(projectRoot, 'node_modules', 'quality-gates', 'run-quality-gates.mjs'),
        ];

        for (const nmPath of nodeModulesPaths) {
          if (fs.existsSync(nmPath)) {
            qualityGatesRunner = nmPath;
            break;
          }
        }

        // Option 3: Check for project-local Python scripts
        if (!qualityGatesRunner) {
          const pythonScript = path.join(projectRoot, 'scripts', 'simple_gates.py');
          const makefile = path.join(projectRoot, 'Makefile');

          if (fs.existsSync(pythonScript)) {
            Output.warning('Node.js quality gates runner not found', 'Found Python script - falling back to Python implementation');
            Output.info(`Running: python3 ${pythonScript}`);
            Output.info('Tip: Install quality gates package for better integration: npm install -g @paths.design/quality-gates');

            // Execute Python script instead
            const { execSync } = require('child_process');
            const pythonArgs = ['all', '--tier', '2', '--profile', 'backend-api'];
            if (options.ci) {
              pythonArgs.push('--ci');
            }
            if (options.json) {
              pythonArgs.push('--json');
            }

            execSync(`python3 ${pythonScript} ${pythonArgs.join(' ')}`, {
              stdio: 'inherit',
              cwd: projectRoot,
            });
            Output.success('Quality gates completed successfully');
            return;
          } else if (fs.existsSync(makefile)) {
            Output.warning('Node.js quality gates runner not found', 'Found Makefile - falling back to Makefile target');
            Output.info('Running: make caws-gates');
            Output.info('Tip: Install quality gates package for better integration: npm install -g @paths.design/quality-gates');

            // Execute Makefile target
            const { execSync } = require('child_process');
            execSync('make caws-gates', {
              stdio: 'inherit',
              cwd: projectRoot,
            });
            Output.success('Quality gates completed successfully');
            return;
          }
        }
      }

      // If still no runner found, provide helpful error
      if (!qualityGatesRunner) {
        const suggestions = [
          'Install quality gates package: npm install -g @paths.design/quality-gates',
          'Use Python script (if available): python3 scripts/simple_gates.py all --tier 2 --profile backend-api',
          'Use Makefile target (if available): make caws-gates',
          'Run from CAWS monorepo root',
        ];

        throw new Error(
          'Quality gates runner not found.\n\n' +
          'Expected locations:\n' +
          `  • Monorepo: ${monorepoRunner}\n` +
          `  • npm package: ${path.join(projectRoot, 'node_modules', '@paths.design', 'quality-gates', 'run-quality-gates.mjs')}\n` +
          `  • Python script: ${path.join(projectRoot, 'scripts', 'simple_gates.py')}\n\n` +
          'Available options:\n' +
          suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
        );
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

      Output.progress('Executing quality gates runner...');
      Output.info(`Command: ${args.join(' ')}`);

      // Execute the quality gates runner with timeout
      const child = spawn(args[0], args.slice(1), {
        stdio: 'inherit',
        cwd: packagesDir,
        env: env,
      });

      // Wait for completion with timeout (30 minutes default for CI)
      const timeoutMs = options.timeout || (options.ci ? 30 * 60 * 1000 : 10 * 60 * 1000);
      
      const completionPromise = new Promise((resolve, reject) => {
        child.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`Quality gates failed with exit code: ${code}`));
          }
        });

        child.on('error', (error) => {
          reject(new Error(`Failed to execute quality gates runner: ${error.message}`));
        });
      });

      await withTimeout(completionPromise, timeoutMs, 'Quality gates execution timed out');
      Output.success('Quality gates completed successfully');
    },
    {
      commandName: 'quality-gates',
      context: { options },
      exitOnError: !options.ci, // Don't exit in CI mode if we want to handle errors
    }
  );
}

module.exports = {
  qualityGatesCommand,
};
