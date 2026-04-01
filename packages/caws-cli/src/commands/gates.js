/**
 * @fileoverview Unified quality gates CLI command
 * Delegates to the v2 gate pipeline (src/gates/pipeline.js) for evaluation
 * and formatting (src/gates/format.js) for output.
 * @author @darianrosebrook
 */

const { evaluateGates } = require('../gates/pipeline');
const { formatText, formatJson } = require('../gates/format');
const { resolveSpec } = require('../utils/spec-resolver');
const { commandWrapper } = require('../utils/command-wrapper');
const { recordGates } = require('../utils/working-state');

/**
 * Run quality gates via the v2 pipeline
 * @param {Object} options - Command options
 * @param {string} [options.context] - Execution context (cli, commit, edit)
 * @param {string} [options.specId] - Target spec ID
 * @param {string} [options.specFile] - Explicit spec file path
 * @param {string} [options.file] - Single file to check (for edit context)
 * @param {boolean} [options.json] - Output as JSON
 * @param {string} [options.format] - Output format (text, json)
 * @param {boolean} [options.quiet] - Minimal output
 */
async function gatesCommand(options = {}) {
  return commandWrapper(
    async () => {
      const projectRoot = process.cwd();
      const context = options.context || 'cli';

      // Resolve spec (working-spec or feature spec)
      let spec = null;
      try {
        const resolved = await resolveSpec({
          specId: options.specId,
          specFile: options.specFile,
          warnLegacy: false,
          interactive: false,
        });
        spec = resolved.spec;
      } catch {
        // No spec available — gates that need it will handle gracefully
      }

      // Get file list based on context
      let stagedFiles = [];
      const { execSync } = require('child_process');
      if (context === 'commit') {
        try {
          stagedFiles = execSync('git diff --cached --name-only', {
            cwd: projectRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          })
            .trim()
            .split('\n')
            .filter(Boolean);
        } catch {
          /* no staged files */
        }
      } else if (options.file) {
        stagedFiles = [options.file];
      } else if (context === 'cli') {
        // For CLI context, use all tracked files so gates can provide meaningful analysis
        try {
          stagedFiles = execSync('git ls-files', {
            cwd: projectRoot,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
            .trim()
            .split('\n')
            .filter(Boolean);
        } catch {
          /* not a git repo or git unavailable */
        }
      }

      const report = await evaluateGates({ projectRoot, stagedFiles, spec, context });

      // Record to working state
      if (spec && spec.id) {
        try { recordGates(spec.id, report, context, projectRoot); } catch { /* non-fatal */ }
      }

      if (options.json || options.format === 'json') {
        console.log(formatJson(report));
      } else if (!options.quiet) {
        console.log(formatText(report));
      }

      // Exit with appropriate code
      if (!report.passed) {
        process.exit(1);
      }
    },
    {
      commandName: 'gates',
      context: { options },
      exitOnError: true,
    }
  );
}

module.exports = { gatesCommand };
