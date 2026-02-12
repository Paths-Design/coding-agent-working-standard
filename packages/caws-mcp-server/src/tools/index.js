/**
 * CAWS MCP Tool Registration
 *
 * Registers all CAWS tools on the McpServer using Zod schemas.
 * Consolidates 24 original tools down to 16.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import {
  execCaws,
  spawnScript,
  findQualityGatesRunner,
  findExceptionFramework,
  findRefactorProgressChecker,
} from '../exec.js';
import { ok, jsonOk, err } from '../utils.js';

/** Common optional working directory param */
const wdSchema = { workingDirectory: z.string().optional().describe('Working directory for the operation') };

export function registerTools(server) {
  // ─── Project Setup ─────────────────────────────────────────────

  server.tool(
    'caws_init',
    'Initialize a new project with CAWS setup',
    {
      projectName: z.string().default('.').describe('Project name ("." for current directory)'),
      template: z.string().optional().describe('Template: extension, library, api, cli'),
      interactive: z.boolean().default(false).describe('Run interactive wizard (not recommended for AI)'),
      ...wdSchema,
    },
    async ({ projectName, template, interactive, workingDirectory }) => {
      try {
        const args = ['init', projectName];
        if (template) args.push(`--template=${template}`);
        args.push(interactive ? '--interactive' : '--non-interactive');
        const output = await execCaws(args, { cwd: workingDirectory });
        return jsonOk({ success: true, message: 'Project initialized', output, projectName });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_scaffold',
    'Add CAWS components to an existing project',
    {
      minimal: z.boolean().default(false).describe('Only install essential components'),
      withCodemods: z.boolean().default(false).describe('Include codemod scripts'),
      withOIDC: z.boolean().default(false).describe('Include OIDC trusted publisher setup'),
      force: z.boolean().default(false).describe('Overwrite existing files'),
      ...wdSchema,
    },
    async ({ minimal, withCodemods, withOIDC, force, workingDirectory }) => {
      try {
        const args = ['scaffold'];
        if (minimal) args.push('--minimal');
        if (withCodemods) args.push('--with-codemods');
        if (withOIDC) args.push('--with-oidc');
        if (force) args.push('--force');
        const output = await execCaws(args, { cwd: workingDirectory });
        return jsonOk({ success: true, message: 'CAWS components scaffolded', output });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Validation & Status ───────────────────────────────────────

  server.tool(
    'caws_validate',
    'Validate a CAWS working spec against the schema',
    {
      specFile: z.string().default('.caws/working-spec.yaml').describe('Path to working spec'),
      ...wdSchema,
    },
    async ({ specFile, workingDirectory }) => {
      try {
        const output = await execCaws(['validate', specFile, '--format', 'json'], { cwd: workingDirectory });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_evaluate',
    'Evaluate work against CAWS quality standards',
    {
      specFile: z.string().default('.caws/working-spec.yaml').describe('Path to working spec'),
      ...wdSchema,
    },
    async ({ specFile, workingDirectory }) => {
      try {
        const output = await execCaws(['evaluate', specFile], { cwd: workingDirectory });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_iterate',
    'Get iterative development guidance based on current progress',
    {
      specFile: z.string().default('.caws/working-spec.yaml').describe('Path to working spec'),
      currentState: z.string().optional().describe('Description of current implementation state'),
      ...wdSchema,
    },
    async ({ specFile, currentState, workingDirectory }) => {
      try {
        const args = ['iterate'];
        if (currentState) {
          args.push('--current-state', JSON.stringify({ description: currentState }));
        }
        args.push(specFile);
        const output = await execCaws(args, { cwd: workingDirectory });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_status',
    'Get project health overview and status summary',
    {
      specFile: z.string().default('.caws/working-spec.yaml').describe('Path to working spec'),
      ...wdSchema,
    },
    async ({ specFile, workingDirectory }) => {
      try {
        const output = await execCaws(['status', '--spec', specFile, '--json'], { cwd: workingDirectory });
        return jsonOk({ success: true, output });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_diagnose',
    'Run health checks and optionally apply automatic fixes',
    {
      fix: z.boolean().default(false).describe('Automatically apply fixes'),
      ...wdSchema,
    },
    async ({ fix, workingDirectory }) => {
      try {
        const args = ['diagnose'];
        if (fix) args.push('--fix');
        const output = await execCaws(args, { cwd: workingDirectory, timeout: 60000 });
        return jsonOk({ success: true, output, fixesApplied: fix });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Workflow & Development ────────────────────────────────────

  server.tool(
    'caws_workflow_guidance',
    'Get workflow-specific guidance for development tasks',
    {
      workflowType: z.enum(['tdd', 'refactor', 'feature']).describe('Type of workflow'),
      currentStep: z.number().describe('Current step in workflow (1-based)'),
      context: z.record(z.unknown()).optional().describe('Additional context'),
      ...wdSchema,
    },
    async ({ workflowType, currentStep, context, workingDirectory }) => {
      try {
        const args = ['workflow', workflowType, '--step', String(currentStep)];
        if (context) args.push('--current-state', JSON.stringify(context));
        const output = await execCaws(args, { cwd: workingDirectory });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_test_analysis',
    'Run statistical analysis for budget prediction and test optimization',
    {
      subcommand: z.enum(['assess-budget', 'analyze-patterns', 'find-similar']).describe('Analysis type'),
      ...wdSchema,
    },
    async ({ subcommand, workingDirectory }) => {
      try {
        const output = await execCaws(['test-analysis', subcommand], { cwd: workingDirectory, timeout: 30000 });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_provenance',
    'Manage CAWS provenance tracking and audit trails',
    {
      subcommand: z.enum(['init', 'update', 'show', 'verify', 'analyze-ai']).describe('Provenance command'),
      commit: z.string().optional().describe('Git commit hash'),
      message: z.string().optional().describe('Commit message'),
      author: z.string().optional().describe('Author information'),
      quiet: z.boolean().default(false).describe('Suppress output'),
      ...wdSchema,
    },
    async ({ subcommand, commit, message, author, quiet, workingDirectory }) => {
      try {
        const args = ['provenance', subcommand];
        if (commit) args.push('--commit', commit);
        if (message) args.push('--message', message);
        if (author) args.push('--author', author);
        if (quiet) args.push('--quiet');
        const output = await execCaws(args, { cwd: workingDirectory, timeout: 30000 });
        return jsonOk({ success: true, subcommand, output });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_hooks',
    'Manage CAWS git hooks for provenance tracking and quality gates',
    {
      subcommand: z.enum(['install', 'remove', 'status']).default('status').describe('Hooks command'),
      force: z.boolean().default(false).describe('Force overwrite existing hooks'),
      backup: z.boolean().default(false).describe('Backup existing hooks before installing'),
      ...wdSchema,
    },
    async ({ subcommand, force, backup, workingDirectory }) => {
      try {
        const args = ['hooks', subcommand];
        if (subcommand === 'install') {
          if (force) args.push('--force');
          if (backup) args.push('--backup');
        }
        const output = await execCaws(args, { cwd: workingDirectory, timeout: 30000 });
        return jsonOk({ success: true, subcommand, output });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_progress_update',
    'Update progress on acceptance criteria in working spec',
    {
      specFile: z.string().default('.caws/working-spec.yaml').describe('Path to working spec'),
      criterionId: z.string().describe('Acceptance criterion ID (e.g., "A1")'),
      status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('Current status'),
      testsWritten: z.number().optional().describe('Number of tests written'),
      testsPassing: z.number().optional().describe('Number of tests passing'),
      coverage: z.number().optional().describe('Code coverage percentage'),
      ...wdSchema,
    },
    async ({ specFile, criterionId, status, testsWritten, testsPassing, coverage, workingDirectory }) => {
      try {
        const cwd = workingDirectory || process.cwd();
        const specPath = path.isAbsolute(specFile) ? specFile : path.join(cwd, specFile);

        if (!fs.existsSync(specPath)) {
          return err(`Working spec not found: ${specPath}`);
        }

        const specContent = fs.readFileSync(specPath, 'utf8');
        const isYaml = specPath.endsWith('.yaml') || specPath.endsWith('.yml');
        const spec = isYaml ? yaml.load(specContent) : JSON.parse(specContent);

        const criterion = spec.acceptance?.find((a) => a.id === criterionId);
        if (!criterion) {
          return err(`Acceptance criterion not found: ${criterionId}`);
        }

        if (status) criterion.status = status;
        if (testsWritten !== undefined || testsPassing !== undefined) {
          criterion.tests = criterion.tests || {};
          if (testsWritten !== undefined) criterion.tests.written = testsWritten;
          if (testsPassing !== undefined) criterion.tests.passing = testsPassing;
        }
        if (coverage !== undefined) criterion.coverage = coverage;
        criterion.last_updated = new Date().toISOString();

        const output = isYaml ? yaml.dump(spec, { indent: 2 }) : JSON.stringify(spec, null, 2);
        fs.writeFileSync(specPath, output, 'utf8');

        return jsonOk({
          success: true,
          message: `Updated progress for ${criterionId}`,
          updatedFields: { status, testsWritten, testsPassing, coverage, lastUpdated: criterion.last_updated },
        });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_archive',
    'Archive completed change with lifecycle management',
    {
      changeId: z.string().describe('Change identifier to archive'),
      force: z.boolean().default(false).describe('Force archive even if criteria not met'),
      dryRun: z.boolean().default(false).describe('Preview archive without performing it'),
      ...wdSchema,
    },
    async ({ changeId, force, dryRun, workingDirectory }) => {
      try {
        const args = ['archive', changeId];
        if (force) args.push('--force');
        if (dryRun) args.push('--dry-run');
        const output = await execCaws(args, { cwd: workingDirectory, timeout: 30000 });
        return jsonOk({ success: true, changeId, archived: !dryRun, output, dryRun });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Waivers (merged create + list) ────────────────────────────

  server.tool(
    'caws_waivers',
    'Create or list quality gate waivers',
    {
      action: z.enum(['list', 'create']).default('list').describe('Action to perform'),
      // List params
      status: z.enum(['active', 'expired', 'revoked', 'all']).default('active').optional().describe('Filter by status (for list)'),
      // Create params
      title: z.string().optional().describe('Waiver title (for create)'),
      reason: z.enum([
        'emergency_hotfix', 'legacy_integration', 'experimental_feature',
        'third_party_constraint', 'performance_critical', 'security_patch',
        'infrastructure_limitation', 'other',
      ]).optional().describe('Reason for waiver (for create)'),
      description: z.string().optional().describe('Detailed description (for create)'),
      gates: z.array(z.string()).optional().describe('Quality gates to waive (for create)'),
      expiresAt: z.string().optional().describe('Expiration date ISO 8601 (for create)'),
      approvedBy: z.string().optional().describe('Approver name (for create)'),
      impactLevel: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Risk level (for create)'),
      mitigationPlan: z.string().optional().describe('Risk mitigation plan (for create)'),
      ...wdSchema,
    },
    async (args) => {
      try {
        if (args.action === 'create') {
          const cliArgs = [
            'waivers', 'create',
            `--title=${args.title}`,
            `--reason=${args.reason}`,
            `--description=${args.description}`,
            `--gates=${args.gates.join(',')}`,
            `--expires-at=${args.expiresAt}`,
            `--approved-by=${args.approvedBy}`,
            `--impact-level=${args.impactLevel}`,
            `--mitigation-plan=${args.mitigationPlan}`,
          ];
          const output = await execCaws(cliArgs, { cwd: args.workingDirectory });
          return ok(`Waiver created:\n${output}`);
        }

        // List
        const output = await execCaws(['waivers', 'list'], { cwd: args.workingDirectory });
        return jsonOk({ success: true, waivers: output, filter: args.status });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Quality Gates (merged gates + run) ────────────────────────

  server.tool(
    'caws_quality_gates',
    'Run quality gates to enforce code quality standards',
    {
      gates: z.string().optional().describe('Comma-separated gates to run (empty = all)'),
      ci: z.boolean().default(false).describe('CI mode (strict enforcement)'),
      json: z.boolean().default(false).describe('Output JSON'),
      fix: z.boolean().default(false).describe('Attempt auto-fixes (experimental)'),
      ...wdSchema,
    },
    async ({ gates, ci, json, fix, workingDirectory }) => {
      try {
        const runnerPath = findQualityGatesRunner();
        if (!runnerPath) {
          // Fall back to CLI
          const args = ['quality-gates'];
          if (gates) args.push('--gates', gates);
          if (ci) args.push('--ci');
          if (json) args.push('--json');
          if (fix) args.push('--fix');
          const output = await execCaws(args, { cwd: workingDirectory });
          return ok(output);
        }

        const scriptArgs = [];
        if (gates && gates.trim()) scriptArgs.push('--gates', gates.trim());
        if (ci) scriptArgs.push('--ci');
        if (json) scriptArgs.push('--json');
        if (fix) scriptArgs.push('--fix');

        const output = await spawnScript(runnerPath, scriptArgs, {
          cwd: workingDirectory,
          timeout: 30000,
        });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );

  server.tool(
    'caws_quality_gates_status',
    'Check quality gates status and recent results',
    {
      json: z.boolean().default(false).describe('Output in JSON format'),
      ...wdSchema,
    },
    async ({ json, workingDirectory }) => {
      try {
        const cwd = workingDirectory || process.cwd();
        const reportPath = path.join(cwd, 'docs-status', 'quality-gates-report.json');

        if (!fs.existsSync(reportPath)) {
          return ok('No quality gates report found. Run quality gates first.');
        }

        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
        if (json) return jsonOk(report);

        const status = report.violations.length === 0 ? 'PASSED' : 'FAILED';
        return ok(
          `Quality Gates Status: ${status}\n` +
          `Last run: ${new Date(report.timestamp).toLocaleString()}\n` +
          `Context: ${report.context}\n` +
          `Files checked: ${report.files_scoped}\n` +
          `Violations: ${report.violations.length}\n` +
          `Warnings: ${report.warnings.length}`
        );
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Quality Exceptions (merged list + create) ─────────────────

  server.tool(
    'caws_quality_exceptions',
    'List or create quality gate exceptions',
    {
      action: z.enum(['list', 'create']).default('list').describe('Action to perform'),
      // List params
      gate: z.string().optional().describe('Filter by gate'),
      status: z.enum(['active', 'expired', 'all']).default('active').optional().describe('Filter by status'),
      // Create params
      reason: z.string().optional().describe('Reason for exception (for create)'),
      approvedBy: z.string().optional().describe('Approver (for create)'),
      expiresAt: z.string().optional().describe('Expiration date ISO format (for create)'),
      filePattern: z.string().optional().describe('File pattern to match (for create)'),
      violationType: z.string().optional().describe('Violation type to waive (for create)'),
      context: z.enum(['all', 'commit', 'push', 'ci']).default('all').optional().describe('Context (for create)'),
      ...wdSchema,
    },
    async (args) => {
      try {
        const frameworkPath = findExceptionFramework();
        if (!frameworkPath) {
          return err('Exception framework not found. Ensure quality-gates package is available.');
        }

        const { pathToFileURL } = await import('url');
        const module = await import(pathToFileURL(frameworkPath).href);

        const cwd = args.workingDirectory || process.cwd();
        module.setProjectRoot(cwd);

        if (args.action === 'create') {
          let expiresInDays = 180;
          if (args.expiresAt) {
            const diffMs = new Date(args.expiresAt).getTime() - Date.now();
            expiresInDays = Math.max(1, Math.ceil(diffMs / (24 * 60 * 60 * 1000)));
          }
          const result = module.addException(args.gate, {
            reason: args.reason,
            approvedBy: args.approvedBy,
            expiresInDays,
            ...(args.filePattern && { filePattern: args.filePattern }),
            ...(args.violationType && { violationType: args.violationType }),
            context: args.context || 'all',
          });
          return jsonOk({ success: true, message: 'Exception created', exception: result });
        }

        // List
        const config = module.loadExceptionConfig();
        let exceptions = config.exceptions || [];
        const now = new Date();

        exceptions = exceptions.filter((exc) => {
          const isExpired = new Date(exc.expires_at) < now;
          if (args.status === 'active') return !isExpired;
          if (args.status === 'expired') return isExpired;
          return true;
        });

        if (args.gate) exceptions = exceptions.filter((exc) => exc.gate === args.gate);

        return jsonOk({
          success: true,
          exceptions: exceptions.map((exc) => ({
            id: exc.id,
            gate: exc.gate,
            reason: exc.reason,
            approved_by: exc.approved_by,
            expires_at: exc.expires_at,
            status: new Date(exc.expires_at) > now ? 'active' : 'expired',
          })),
          count: exceptions.length,
        });
      } catch (error) {
        return err(error.message);
      }
    }
  );

  // ─── Refactoring Progress ──────────────────────────────────────

  server.tool(
    'caws_refactor_progress_check',
    'Check refactoring progress against defined targets',
    {
      context: z.enum(['commit', 'push', 'ci']).default('ci').describe('Execution context'),
      strict: z.boolean().default(false).describe('Fail if targets not met'),
      ...wdSchema,
    },
    async ({ context, strict, workingDirectory }) => {
      try {
        const checkerPath = findRefactorProgressChecker();
        if (!checkerPath) {
          return err('Refactoring progress checker not found.');
        }
        const args = ['--context', context];
        if (strict) args.push('--strict');
        const output = await spawnScript(checkerPath, args, { cwd: workingDirectory });
        return ok(output);
      } catch (error) {
        return err(error.message);
      }
    }
  );
}
