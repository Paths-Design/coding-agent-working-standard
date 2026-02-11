/**
 * MCP Tool Definitions for CAWS
 *
 * Pure data: JSON Schema definitions for all 24 CAWS tools exposed via MCP.
 * Extracted from index.js to reduce god object size.
 */

export const CAWS_TOOLS = [
  {
    name: 'caws_init',
    description: 'Initialize a new project with CAWS setup',
    inputSchema: {
      type: 'object',
      properties: {
        projectName: {
          type: 'string',
          description: 'Name of the project to create (use "." for current directory)',
          default: '.',
        },
        template: {
          type: 'string',
          description: 'Project template to use (extension, library, api, cli)',
        },
        interactive: {
          type: 'boolean',
          description: 'Run interactive setup wizard (not recommended for AI agents)',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for initialization',
        },
      },
    },
  },
  {
    name: 'caws_scaffold',
    description: 'Add CAWS components to an existing project',
    inputSchema: {
      type: 'object',
      properties: {
        minimal: {
          type: 'boolean',
          description: 'Only install essential components',
          default: false,
        },
        withCodemods: {
          type: 'boolean',
          description: 'Include codemod scripts',
          default: false,
        },
        withOIDC: {
          type: 'boolean',
          description: 'Include OIDC trusted publisher setup',
          default: false,
        },
        force: {
          type: 'boolean',
          description: 'Overwrite existing files',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for scaffolding',
        },
      },
    },
  },
  {
    name: 'caws_evaluate',
    description: 'Evaluate work against CAWS quality standards',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for evaluation',
        },
      },
    },
  },
  {
    name: 'caws_iterate',
    description: 'Get iterative development guidance based on current progress',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        currentState: {
          type: 'string',
          description: 'Description of current implementation state',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for guidance',
        },
      },
    },
  },
  {
    name: 'caws_validate',
    description: 'Run CAWS validation on working specification',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for validation',
        },
      },
    },
  },
  {
    name: 'caws_waiver_create',
    description: 'Create a waiver for exceptional circumstances',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Waiver title' },
        reason: {
          type: 'string',
          enum: [
            'emergency_hotfix',
            'legacy_integration',
            'experimental_feature',
            'third_party_constraint',
            'performance_critical',
            'security_patch',
            'infrastructure_limitation',
            'other',
          ],
          description: 'Reason for waiver',
        },
        description: { type: 'string', description: 'Detailed description' },
        gates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Quality gates to waive',
        },
        expiresAt: { type: 'string', description: 'Expiration date (ISO 8601)' },
        approvedBy: { type: 'string', description: 'Approver name' },
        impactLevel: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'Risk impact level',
        },
        mitigationPlan: { type: 'string', description: 'Risk mitigation plan' },
        workingDirectory: { type: 'string', description: 'Working directory' },
      },
      required: [
        'title',
        'reason',
        'description',
        'gates',
        'expiresAt',
        'approvedBy',
        'impactLevel',
        'mitigationPlan',
      ],
    },
  },
  {
    name: 'caws_waivers_list',
    description: 'List all quality gate waivers',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['active', 'expired', 'revoked', 'all'],
          description: 'Filter waivers by status',
          default: 'active',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for waivers',
        },
      },
    },
  },
  {
    name: 'caws_workflow_guidance',
    description: 'Get workflow-specific guidance for development tasks',
    inputSchema: {
      type: 'object',
      properties: {
        workflowType: {
          type: 'string',
          enum: ['tdd', 'refactor', 'feature'],
          description: 'Type of workflow',
        },
        currentStep: {
          type: 'number',
          description: 'Current step in workflow (1-based)',
        },
        context: {
          type: 'object',
          description: 'Additional context for guidance',
        },
      },
      required: ['workflowType', 'currentStep'],
    },
  },
  {
    name: 'caws_quality_monitor',
    description: 'Monitor code quality impact in real-time',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['file_saved', 'code_edited', 'test_run'],
          description: 'Type of action performed',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files affected by action',
        },
        context: {
          type: 'object',
          description: 'Additional context about the action',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'caws_test_analysis',
    description: 'Run statistical analysis for budget prediction and test optimization',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          enum: ['assess-budget', 'analyze-patterns', 'find-similar'],
          description: 'Analysis type to perform',
        },
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for analysis',
        },
      },
      required: ['subcommand'],
    },
  },
  {
    name: 'caws_provenance',
    description: 'Manage CAWS provenance tracking and audit trails',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          enum: ['init', 'update', 'show', 'verify', 'analyze-ai'],
          description: 'Provenance command to execute',
        },
        commit: {
          type: 'string',
          description: 'Git commit hash for updates',
        },
        message: {
          type: 'string',
          description: 'Commit message',
        },
        author: {
          type: 'string',
          description: 'Author information',
        },
        quiet: {
          type: 'boolean',
          description: 'Suppress output',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for provenance operations',
        },
      },
      required: ['subcommand'],
    },
  },
  {
    name: 'caws_hooks',
    description: 'Manage CAWS git hooks for provenance tracking and quality gates',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: {
          type: 'string',
          enum: ['install', 'remove', 'status'],
          description: 'Hooks command to execute',
          default: 'status',
        },
        force: {
          type: 'boolean',
          description: 'Force overwrite existing hooks (for install)',
          default: false,
        },
        backup: {
          type: 'boolean',
          description: 'Backup existing hooks before installing',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for hooks operations',
        },
      },
      required: ['subcommand'],
    },
  },
  {
    name: 'caws_status',
    description: 'Get project health overview and status summary',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for status check',
        },
      },
    },
  },
  {
    name: 'caws_diagnose',
    description: 'Run health checks and optionally apply automatic fixes',
    inputSchema: {
      type: 'object',
      properties: {
        fix: {
          type: 'boolean',
          description: 'Automatically apply fixes for detected issues',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for diagnostics',
        },
      },
    },
  },
  {
    name: 'caws_progress_update',
    description: 'Update progress on acceptance criteria in working spec',
    inputSchema: {
      type: 'object',
      properties: {
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
          default: '.caws/working-spec.yaml',
        },
        criterionId: {
          type: 'string',
          description: 'ID of the acceptance criterion to update (e.g., "A1")',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed'],
          description: 'Current status of the criterion',
        },
        testsWritten: {
          type: 'number',
          description: 'Number of tests written for this criterion',
        },
        testsPassing: {
          type: 'number',
          description: 'Number of tests currently passing',
        },
        coverage: {
          type: 'number',
          description: 'Code coverage percentage for this criterion',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the update',
        },
      },
      required: ['criterionId'],
    },
  },
  {
    name: 'caws_help',
    description: 'Get help and documentation for CAWS MCP tools',
    inputSchema: {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'Specific tool name to get detailed help for',
        },
        category: {
          type: 'string',
          enum: [
            'project-management',
            'validation',
            'quality-gates',
            'development',
            'testing',
            'compliance',
          ],
          description: 'Category of tools to show',
        },
      },
    },
  },
  {
    name: 'caws_monitor_status',
    description: 'Get current monitoring status including budgets, progress, and alerts',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'caws_monitor_alerts',
    description: 'Get active monitoring alerts and warnings',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['info', 'warning', 'critical'],
          description: 'Filter alerts by severity level',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of alerts to return',
          default: 10,
          minimum: 1,
          maximum: 100,
        },
      },
    },
  },
  {
    name: 'caws_monitor_configure',
    description: 'Configure monitoring system settings',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'update_thresholds',
            'add_watch_path',
            'remove_watch_path',
            'set_polling_interval',
          ],
          description: 'Configuration action to perform',
        },
        budgetWarning: {
          type: 'number',
          description: 'Warning threshold for budget usage (0.0-1.0)',
          minimum: 0,
          maximum: 1,
        },
        budgetCritical: {
          type: 'number',
          description: 'Critical threshold for budget usage (0.0-1.0)',
          minimum: 0,
          maximum: 1,
        },
        path: {
          type: 'string',
          description: 'Path to add/remove from watch list',
        },
        interval: {
          type: 'number',
          description: 'Polling interval in milliseconds',
          minimum: 1000,
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'caws_archive',
    description: 'Archive completed change with lifecycle management',
    inputSchema: {
      type: 'object',
      properties: {
        changeId: {
          type: 'string',
          description: 'Change identifier to archive',
        },
        force: {
          type: 'boolean',
          description: 'Force archive even if criteria not met',
          default: false,
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview archive without performing it',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the operation',
        },
      },
      required: ['changeId'],
    },
  },
  {
    name: 'caws_quality_gates',
    description: 'Run comprehensive quality gates on staged files only',
    inputSchema: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Command line arguments to pass to quality-gates command',
          default: [],
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for quality gates execution',
        },
      },
    },
  },
  {
    name: 'caws_slash_commands',
    description: 'Execute CAWS commands using natural slash command syntax',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Slash command to execute (e.g., /caws:start, /caws:validate)',
        },
        projectName: {
          type: 'string',
          description: 'Project name (for init commands)',
        },
        template: {
          type: 'string',
          description: 'Project template (for init commands)',
        },
        interactive: {
          type: 'boolean',
          description: 'Interactive mode (for init commands)',
        },
        specFile: {
          type: 'string',
          description: 'Path to working spec file',
        },
        currentState: {
          type: 'string',
          description: 'Current implementation state (for iterate commands)',
        },
        changeId: {
          type: 'string',
          description: 'Change identifier (for archive commands)',
        },
        force: {
          type: 'boolean',
          description: 'Force operation (for archive commands)',
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview operation (for archive commands)',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory for the operation',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'caws_quality_gates_run',
    description: 'Run comprehensive quality gates to enforce code quality standards',
    inputSchema: {
      type: 'object',
      properties: {
        gates: {
          type: 'string',
          description:
            'Comma-separated list of gates to run (naming,code_freeze,duplication,god_objects,documentation). Leave empty to run all gates.',
        },
        ci: {
          type: 'boolean',
          description: 'Run in CI mode (strict enforcement, exit on violations)',
          default: false,
        },
        json: {
          type: 'boolean',
          description: 'Output machine-readable JSON instead of human-readable text',
          default: false,
        },
        fix: {
          type: 'boolean',
          description: 'Attempt automatic fixes for safe violations (experimental)',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory to run quality gates in (defaults to current directory)',
        },
      },
    },
  },
  {
    name: 'caws_quality_gates_status',
    description: 'Check the status of quality gates and recent results',
    inputSchema: {
      type: 'object',
      properties: {
        workingDirectory: {
          type: 'string',
          description: 'Working directory to check status in (defaults to current directory)',
        },
        json: {
          type: 'boolean',
          description: 'Output in JSON format',
          default: false,
        },
      },
    },
  },
  {
    name: 'caws_quality_exceptions_list',
    description: 'List all active quality gate exceptions and waivers',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Filter exceptions by specific gate (optional)',
        },
        status: {
          type: 'string',
          description: 'Filter by status: active, expired, all',
          enum: ['active', 'expired', 'all'],
          default: 'active',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory to check exceptions in (defaults to current directory)',
        },
      },
    },
  },
  {
    name: 'caws_quality_exceptions_create',
    description: 'Create a new quality gate exception/waiver',
    inputSchema: {
      type: 'object',
      properties: {
        gate: {
          type: 'string',
          description: 'Quality gate to create exception for',
          required: true,
        },
        reason: {
          type: 'string',
          description: 'Reason for the exception',
          required: true,
        },
        approvedBy: {
          type: 'string',
          description: 'Person/entity approving the exception',
          required: true,
        },
        expiresAt: {
          type: 'string',
          description: 'Expiration date in ISO format (YYYY-MM-DDTHH:mm:ssZ)',
          required: true,
        },
        filePattern: {
          type: 'string',
          description: 'File pattern to match (micromatch glob)',
        },
        violationType: {
          type: 'string',
          description: 'Type of violation to waive',
        },
        context: {
          type: 'string',
          description: 'Context where exception applies: all, commit, push, ci',
          enum: ['all', 'commit', 'push', 'ci'],
          default: 'all',
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory to create exception in (defaults to current directory)',
        },
      },
      required: ['gate', 'reason', 'approvedBy', 'expiresAt'],
    },
  },
  {
    name: 'caws_refactor_progress_check',
    description: 'Check refactoring progress against defined targets and baselines',
    inputSchema: {
      type: 'object',
      properties: {
        context: {
          type: 'string',
          description: 'Execution context: commit, push, ci',
          enum: ['commit', 'push', 'ci'],
          default: 'ci',
        },
        strict: {
          type: 'boolean',
          description: 'Fail if targets are not met (for CI)',
          default: false,
        },
        workingDirectory: {
          type: 'string',
          description: 'Working directory to check progress in (defaults to current directory)',
        },
      },
    },
  },
];
