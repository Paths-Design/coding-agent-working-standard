/**
 * @fileoverview Unified quality gates CLI command
 * Delegates to the v2 gate pipeline (src/gates/pipeline.js) for evaluation
 * and formatting (src/gates/format.js) for output.
 * @author @darianrosebrook
 */

const { evaluateGates } = require('../gates/pipeline');
const { formatText, formatJson, formatEnrichedText } = require('../gates/format');
const { enrichGateResults } = require('../gates/feedback');
const { resolveSpec } = require('../utils/spec-resolver');
const { commandWrapper } = require('../utils/command-wrapper');
const { recordGates, loadState } = require('../utils/working-state');
const { appendEvent } = require('../utils/event-log');

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

      // Record to working state (Phase 1 dual-write: state layer + event log)
      if (spec && spec.id) {
        try { recordGates(spec.id, report, context, projectRoot); } catch { /* non-fatal */ }

        // EVLOG-001: emit gates_evaluated event alongside state write.
        // Payload shape mirrors the `gates` field produced by recordGates.
        await appendEvent(
          {
            actor: 'cli',
            event: 'gates_evaluated',
            spec_id: spec.id,
            data: {
              context,
              passed: report.passed,
              summary: report.summary || {},
              gates: (report.gates || []).map((g) => ({
                name: g.name,
                status: g.status,
                mode: g.mode,
              })),
            },
          },
          { projectRoot }
        );
      }

      if (options.json || options.format === 'json') {
        console.log(formatJson(report));
      } else if (!options.quiet) {
        // Enrich feedback on failure or --verbose
        if (!report.passed || options.verbose) {
          try {
            const state = spec?.id ? loadState(spec.id, projectRoot) : null;
            const enrichments = enrichGateResults(report, { spec, state, projectRoot });
            if (enrichments.size > 0) {
              console.log(formatEnrichedText(report, enrichments));
            } else {
              console.log(formatText(report));
            }
          } catch {
            console.log(formatText(report));
          }
        } else {
          console.log(formatText(report));
        }
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
