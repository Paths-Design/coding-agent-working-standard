#!/usr/bin/env node

/**
 * CAWS MCP Server
 *
 * Model Context Protocol server that exposes CAWS tools to AI agents.
 * Enables real-time quality validation, iterative guidance, and workflow management.
 *
 * @author @darianrosebrook
 */

// Force JSON-only logging for MCP server (no colors or pretty printing)
// This must be set before any imports that might initialize the logger
process.env.CAWS_MCP_SERVER = 'true';
process.env.NO_COLOR = '1'; // Disable ANSI colors globally
process.env.FORCE_COLOR = '0'; // Explicitly disable colors
process.env.PINO_PRETTY_PRINT = 'false'; // Disable pino pretty printing
process.env.PINO_LOG_PRETTY = 'false'; // Another pino pretty print variable
process.env.PINO_COLORIZE = 'false'; // Disable pino colorization
process.env.TERM = 'dumb'; // Dumb terminal (no colors)

/**
 * Strip ANSI escape codes from text output
 * This prevents color codes from corrupting JSON responses
 * Handles all ANSI escape sequences: CSI codes, OSC codes, etc.
 * IMPORTANT: Preserves newlines and other essential control characters for JSON-RPC
 */
function stripAnsi(text) {
  if (!text || typeof text !== 'string') return text;
  // Remove all ANSI escape sequences:
  // - CSI (Control Sequence Introducer): ESC[ ... [m] (most common)
  // - OSC (Operating System Command): ESC] ... BEL or ESC\
  // - Other escape sequences: ESC followed by various characters
  // DO NOT remove newlines (\n = 0x0A) or carriage returns (\r = 0x0D) - they're essential for JSON-RPC
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, '') // CSI codes (colors, styles)
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\]8;[^;]*;[^\u0007]*\u0007/g, '') // OSC hyperlinks
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][0-9]+;[^\u0007]*\u0007/g, '') // Other OSC codes
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u0007]*\u0007/g, '') // OSC codes ending with BEL
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\][^\u001b\\]*\\/g, '') // OSC codes ending with ESC\
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b[[\]()#;?]?[0-9;:]*[A-Za-z]/g, '') // Other escape sequences
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b./g, '') // Any remaining escape sequences
      // Only remove problematic control characters, NOT newlines or carriage returns
      // Keep: \n (0x0A), \r (0x0D), \t (0x09)
      // Remove: other control chars that might corrupt JSON
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
  );
}

// Ensure stdout is completely clean for MCP protocol
// Only strip ANSI codes - DO NOT interfere with valid JSON-RPC messages
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = function (chunk, encoding, fd) {
  const str = chunk.toString();

  // Check if this looks like a JSON-RPC message (starts with { or [)
  const isJsonRpc = /^[\s]*[{[]/.test(str);

  if (isJsonRpc) {
    // This is likely a JSON-RPC message from MCP SDK - only strip ANSI codes, preserve everything else
    // Don't use trim() - JSON-RPC messages end with newlines which are essential
    const cleaned = stripAnsi(str);
    return originalStdoutWrite(cleaned, encoding, fd);
  } else {
    // Not JSON-RPC - might be accidental output (like logger), strip ANSI and write
    const cleaned = stripAnsi(str);
    if (cleaned.trim().length > 0) {
      return originalStdoutWrite(cleaned, encoding, fd);
    }
    return true;
  }
};

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  InitializedNotificationSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// ES module equivalent of __filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Detect project root directory (git root or provided directory)
 * This ensures CAWS operations are scoped to the correct project
 */
function getProjectRoot(workingDirectory = process.cwd()) {
  // Try environment variables first (set by VS Code/Cursor)
  if (process.env.CURSOR_WORKSPACE_ROOT) {
    return process.env.CURSOR_WORKSPACE_ROOT;
  }
  if (process.env.VSCODE_WORKSPACE_ROOT) {
    return process.env.VSCODE_WORKSPACE_ROOT;
  }

  // Try to find git root from working directory
  try {
    const gitRoot = execSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      cwd: workingDirectory,
      stdio: 'pipe',
    }).trim();
    return gitRoot;
  } catch {
    // Not a git repo or git not available, use provided directory
    return workingDirectory;
  }
}

/**
 * Resolve path to quality gates module with fallback support
 * Works in both development (monorepo) and bundled (VS Code extension) contexts
 */
function resolveQualityGatesModule(moduleName) {
  const possiblePaths = [
    // Bundled (VS Code extension) - check this FIRST for bundled contexts
    // From bundled/mcp-server to bundled/quality-gates
    path.join(__dirname, '..', 'quality-gates', moduleName),
    // Bundled alternative - if quality-gates is in same directory
    path.join(__dirname, 'quality-gates', moduleName),
    // Published npm package (priority for external projects)
    path.join(process.cwd(), 'node_modules', '@paths.design', 'quality-gates', moduleName),
    // Development (monorepo) - from MCP server to quality-gates
    path.join(__dirname, '..', '..', 'packages', 'quality-gates', moduleName),
    // Legacy monorepo local copy (fallback)
    path.join(process.cwd(), 'node_modules', '@caws', 'quality-gates', moduleName),
  ];

  const attemptedPaths = [];
  for (const modulePath of possiblePaths) {
    attemptedPaths.push(modulePath);
    try {
      if (fs.existsSync(modulePath)) {
        return pathToFileURL(modulePath).href;
      }
    } catch {
      // Continue to next path
      continue;
    }
  }

  // If no path found, try the original monorepo path as fallback
  const fallbackPath = path.join(
    path.dirname(path.dirname(__filename)),
    '..',
    '..',
    'packages',
    'quality-gates',
    moduleName
  );
  attemptedPaths.push(fallbackPath);

  // Provide helpful error message with attempted paths
  const errorMessage =
    `Quality gates module "${moduleName}" not found. Attempted paths:\n` +
    attemptedPaths.map((p) => `  - ${p}`).join('\n') +
    `\n\nCurrent directory: ${__dirname}\n` +
    `Working directory: ${process.cwd()}\n` +
    `\nTroubleshooting:\n` +
    `  1. Ensure quality-gates package is bundled with extension\n` +
    `  2. Check that bundled/quality-gates directory exists\n` +
    `  3. Verify module name is correct: ${moduleName}`;

  throw new Error(errorMessage);
}

/**
 * Execute CLI command with color suppression and ANSI stripping
 */
function execCawsCommand(command, options = {}) {
  try {
    const result = execSync(command, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CAWS_OUTPUT_FORMAT: 'json', // Force JSON output format
        TERM: 'dumb', // Dumb terminal (no colors)
        // Ensure no TTY detection
        CI: 'true', // Many tools check CI env var to disable colors
      },
      stdio: ['pipe', 'pipe', 'pipe'], // Explicitly separate stdout/stderr
      ...options,
    });
    // Strip any remaining ANSI codes as a safety measure
    // Do multiple passes to catch any edge cases
    let cleaned = stripAnsi(result);
    cleaned = stripAnsi(cleaned); // Second pass for nested codes
    return cleaned;
  } catch (error) {
    // If command fails, strip ANSI from error message too
    if (error.stdout) {
      error.stdout = stripAnsi(error.stdout.toString());
      error.stdout = stripAnsi(error.stdout); // Second pass
    }
    if (error.stderr) {
      error.stderr = stripAnsi(error.stderr.toString());
      error.stderr = stripAnsi(error.stderr); // Second pass
    }
    // Also clean the error message itself
    if (error.message) {
      error.message = stripAnsi(error.message);
    }
    throw error;
  }
}

class CawsMcpServer extends Server {
  constructor() {
    super(
      {
        name: 'caws-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          logging: {},
        },
      }
    );

    // Disable monitoring in MCP mode to prevent stdout pollution
    // Monitoring uses file watchers and yaml parsing which can emit ANSI codes
    this.monitor = {
      start: async () => {},
      stop: async () => {},
      getStatus: () => ({ running: false, alerts: [] }),
    };

    this.setupToolHandlers();
    this.setupResourceHandlers();
  }

  setupToolHandlers() {
    // Handle MCP initialization
    this.setRequestHandler(InitializeRequestSchema, async (request) => {
      const { protocolVersion } = request.params;

      // Don't log in MCP mode - logs can leak ANSI codes to stdout

      return {
        protocolVersion,
        capabilities: {
          tools: {
            listChanged: false,
          },
          resources: {
            listChanged: false,
          },
          logging: {},
        },
        serverInfo: {
          name: 'caws-mcp-server',
          version: '1.0.0',
        },
      };
    });

    // Handle client initialized notification
    this.setNotificationHandler(InitializedNotificationSchema, () => {
      // Don't log in MCP mode - logs can leak ANSI codes to stdout
    });

    // List available tools
    this.setRequestHandler(ListToolsRequestSchema, () => {
      // Don't log debug messages in MCP mode - they might leak to stdout
      return { tools: CAWS_TOOLS };
    });

    // Handle tool calls
    this.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'caws_init':
          return await this.handleCawsInit(args);
        case 'caws_scaffold':
          return await this.handleCawsScaffold(args);
        case 'caws_evaluate':
          return await this.handleCawsEvaluate(args);
        case 'caws_iterate':
          return await this.handleCawsIterate(args);
        case 'caws_validate':
          return await this.handleCawsValidate(args);
        case 'caws_workflow_guidance':
          return await this.handleWorkflowGuidance(args);
        case 'caws_quality_monitor':
          return await this.handleQualityMonitor(args);
        case 'caws_test_analysis':
          return await this.handleTestAnalysis(args);
        case 'caws_provenance':
          return await this.handleProvenance(args);
        case 'caws_hooks':
          return await this.handleHooks(args);
        case 'caws_status':
          return await this.handleStatus(args);
        case 'caws_diagnose':
          return await this.handleDiagnose(args);
        case 'caws_progress_update':
          return await this.handleProgressUpdate(args);
        case 'caws_waiver_create':
          return await this.handleWaiverCreate(args);
        case 'caws_waivers_list':
          return await this.handleWaiversList(args);
        case 'caws_help':
          return await this.handleHelp(args);
        case 'caws_monitor_status':
          return await this.handleMonitorStatus(args);
        case 'caws_monitor_alerts':
          return await this.handleMonitorAlerts(args);
        case 'caws_monitor_configure':
          return await this.handleMonitorConfigure(args);
        case 'caws_archive':
          return await this.handleCawsArchive(args);
        case 'caws_slash_commands':
          return await this.handleSlashCommands(args);
        case 'caws_quality_gates':
          return await this.handleQualityGates(args);
        case 'caws_quality_gates_run':
          return await this.handleQualityGatesRun(args);
        case 'caws_quality_gates_status':
          return await this.handleQualityGatesStatus(args);
        case 'caws_quality_exceptions_list':
          return await this.handleQualityExceptionsList(args);
        case 'caws_quality_exceptions_create':
          return await this.handleQualityExceptionsCreate(args);
        case 'caws_refactor_progress_check':
          return await this.handleRefactorProgressCheck(args);
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  setupResourceHandlers() {
    // List available resources
    this.setRequestHandler(ListResourcesRequestSchema, () => {
      const resources = [];

      // Working specs
      try {
        const specFiles = this.findWorkingSpecs();
        specFiles.forEach((specPath) => {
          resources.push({
            uri: `caws://working-spec/${specPath}`,
            name: `Working Spec: ${path.basename(specPath, '.yaml')}`,
            description: 'CAWS working specification',
            mimeType: 'application/yaml',
          });
        });
      } catch (error) {
        // Ignore errors in resource listing - don't log to avoid stdout pollution
      }

      return { resources };
    });

    // Read resource content
    this.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;

      if (uri.startsWith('caws://working-spec/')) {
        const specPath = uri.replace('caws://working-spec/', '');
        return await this.readWorkingSpec(specPath);
      }

      if (uri.startsWith('caws://waivers/')) {
        const waiverId = uri.replace('caws://waivers/', '');
        return await this.readWaiver(waiverId);
      }

      throw new Error(`Unknown resource: ${uri}`);
    });
  }

  async handleCawsInit(args) {
    const {
      projectName = '.',
      template,
      interactive = false,
      workingDirectory = process.cwd(),
    } = args;

    try {
      const cliArgs = ['init', projectName];

      if (template) {
        cliArgs.push(`--template=${template}`);
      }

      if (interactive) {
        cliArgs.push('--interactive');
      } else {
        cliArgs.push('--non-interactive');
      }

      const command = `npx @paths.design/caws-cli ${cliArgs.join(' ')}`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Project initialized successfully',
                output: stripAnsi(result),
                projectName: projectName === '.' ? path.basename(workingDirectory) : projectName,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws init',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleCawsScaffold(args) {
    const {
      minimal = false,
      withCodemods = false,
      withOIDC = false,
      force = false,
      workingDirectory = process.cwd(),
    } = args;

    try {
      const cliArgs = ['scaffold'];

      if (minimal) cliArgs.push('--minimal');
      if (withCodemods) cliArgs.push('--with-codemods');
      if (withOIDC) cliArgs.push('--with-oidc');
      if (force) cliArgs.push('--force');

      const command = `npx @paths.design/caws-cli ${cliArgs.join(' ')}`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'CAWS components scaffolded successfully',
                output: stripAnsi(result),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws scaffold',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleCawsEvaluate(args) {
    const specFile = args.specFile || '.caws/working-spec.yaml';
    const workingDirectory = args.workingDirectory || process.cwd();

    try {
      const command = `npx @paths.design/caws-cli evaluate ${specFile}`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: stripAnsi(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws agent evaluate',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleCawsIterate(args) {
    const specFile = args.specFile || '.caws/working-spec.yaml';
    const currentState = args.currentState || 'Implementation in progress';
    const workingDirectory = args.workingDirectory || process.cwd();

    try {
      const stateArg = JSON.stringify({ description: currentState });
      const command = `npx @paths.design/caws-cli iterate --current-state ${JSON.stringify(stateArg)} ${specFile}`;

      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: stripAnsi(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws agent iterate',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleCawsValidate(args) {
    const specFile = args.specFile || '.caws/working-spec.yaml';
    const workingDirectory = args.workingDirectory || process.cwd();

    try {
      // Detect existing CLI installation first
      let cawsCommand;
      try {
        execSync('caws --version', { stdio: 'ignore', cwd: workingDirectory });
        cawsCommand = 'caws';
      } catch {
        // CLI not found, use npx fallback
        cawsCommand = 'npx @paths.design/caws-cli';
      }

      const command = `${cawsCommand} validate ${specFile} --format json`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: `Validation completed:\n${stripAnsi(result)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Validation failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleWaiverCreate(args) {
    try {
      const waiverArgs = [
        'waivers',
        'create',
        `--title=${JSON.stringify(args.title)}`,
        `--reason=${args.reason}`,
        `--description=${JSON.stringify(args.description)}`,
        `--gates=${args.gates.join(',')}`,
        `--expires-at=${args.expiresAt}`,
        `--approved-by=${args.approvedBy}`,
        `--impact-level=${args.impactLevel}`,
        `--mitigation-plan=${JSON.stringify(args.mitigationPlan)}`,
      ];

      const command = `npx @paths.design/caws-cli ${waiverArgs.join(' ')}`;
      const result = execCawsCommand(command, { cwd: args.workingDirectory || process.cwd() });

      return {
        content: [
          {
            type: 'text',
            text: `Waiver created successfully:\n${stripAnsi(result)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Waiver creation failed: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  async handleWorkflowGuidance(args) {
    const { workflowType, currentStep, context } = args;
    const workingDirectory = args.workingDirectory || process.cwd();

    try {
      const contextArg = context
        ? `--current-state ${JSON.stringify(JSON.stringify(context))}`
        : '';
      const command = `npx @paths.design/caws-cli workflow ${workflowType} --step ${currentStep} ${contextArg}`;

      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [{ type: 'text', text: stripAnsi(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Workflow guidance failed: ${error.message}` }],
        isError: true,
      };
    }
  }

  async handleQualityMonitor(args) {
    const { action, files, context } = args;
    const workingDirectory = args.workingDirectory || process.cwd();

    try {
      const filesArg = files?.length ? `--files ${files.join(',')}` : '';
      const contextArg = context ? `--context ${JSON.stringify(JSON.stringify(context))}` : '';
      const command = `npx @paths.design/caws-cli quality-monitor ${action} ${filesArg} ${contextArg}`;

      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [{ type: 'text', text: stripAnsi(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Quality monitoring failed: ${error.message}` }],
        isError: true,
      };
    }
  }

  async handleTestAnalysis(args) {
    const {
      subcommand,
      // specFile: _specFile = '.caws/working-spec.yaml',
      workingDirectory = process.cwd(),
    } = args;

    try {
      // Execute test analysis command and return results
      const command = `npx @paths.design/caws-cli test-analysis ${subcommand}`;
      const result = execCawsCommand(command, { cwd: workingDirectory, timeout: 30000 });

      return {
        content: [{ type: 'text', text: stripAnsi(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Test analysis failed: ${error.message}` }],
        isError: true,
      };
    }
  }

  async handleProvenance(args) {
    const {
      subcommand,
      commit,
      message,
      author,
      quiet = false,
      workingDirectory = process.cwd(),
    } = args;

    try {
      let command = `npx @paths.design/caws-cli provenance ${subcommand}`;

      if (commit) command += ` --commit "${commit}"`;
      if (message) command += ` --message "${message}"`;
      if (author) command += ` --author "${author}"`;
      if (quiet) command += ' --quiet';

      const result = await execCommand(command, {
        cwd: workingDirectory,
        timeout: 30000,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                subcommand,
                output: stripAnsi(result.stdout || 'Provenance operation completed'),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: `caws provenance ${subcommand}`,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  findWorkingSpecs() {
    // Only check the current project's .caws directory (fast, no recursion)
    // Use project root detection to ensure we're looking in the right place
    const specs = [];
    const projectRoot = getProjectRoot();
    const cawsDir = path.join(projectRoot, '.caws');
    const specPath = path.join(cawsDir, 'working-spec.yaml');

    try {
      if (fs.existsSync(specPath)) {
        // Return relative path from project root
        const relativePath = path.relative(projectRoot, specPath);
        specs.push(relativePath);
      }
    } catch (error) {
      // Ignore if we can't read the spec
    }

    return specs;
  }

  async getActiveWaivers() {
    try {
      const command = `npx @paths.design/caws-cli waivers list`;
      const result = execCawsCommand(command);

      // Parse the output to extract waiver information
      // This is a simplified parsing - in production, use structured output
      const waivers = [];
      const lines = result.split('\n');

      for (const line of lines) {
        if (line.startsWith('🔖 ')) {
          const match = line.match(/🔖 (WV-\d{4}): (.+)/);
          if (match) {
            waivers.push({
              id: match[1],
              title: match[2],
            });
          }
        }
      }

      return waivers;
    } catch (error) {
      return [];
    }
  }

  async readWorkingSpec(specPath) {
    try {
      const fullPath = path.isAbsolute(specPath) ? specPath : path.join(process.cwd(), specPath);
      const content = fs.readFileSync(fullPath, 'utf8');

      return {
        contents: [
          {
            uri: `caws://working-spec/${specPath}`,
            mimeType: 'application/yaml',
            text: content,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read working spec: ${error.message}`);
    }
  }

  async readWaiver(waiverId) {
    try {
      // This is a simplified implementation - in production, parse waiver files
      const waivers = await this.getActiveWaivers();
      const waiver = waivers.find((w) => w.id === waiverId);

      if (!waiver) {
        throw new Error(`Waiver not found: ${waiverId}`);
      }

      return {
        contents: [
          {
            uri: `caws://waivers/${waiverId}`,
            mimeType: 'application/json',
            text: JSON.stringify(waiver, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read waiver: ${error.message}`);
    }
  }

  async handleHooks(args) {
    const {
      subcommand = 'status',
      force = false,
      backup = false,
      workingDirectory = process.cwd(),
    } = args;

    try {
      let command = `npx @paths.design/caws-cli hooks ${subcommand}`;

      if (subcommand === 'install') {
        if (force) command += ' --force';
        if (backup) command += ' --backup';
      }

      const result = await execCommand(command, {
        cwd: workingDirectory,
        timeout: 30000,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                subcommand,
                output: stripAnsi(result.stdout || result.stderr || 'Hooks operation completed'),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: `caws hooks ${subcommand}`,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleStatus(args) {
    const { specFile = '.caws/working-spec.yaml', workingDirectory = process.cwd() } = args;

    try {
      const command = `npx @paths.design/caws-cli status --spec ${specFile} --json`;
      const result = await execCommand(command, {
        cwd: workingDirectory,
        timeout: 30000,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                output: stripAnsi(result.stdout || 'Status check completed'),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws status',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleDiagnose(args) {
    const { fix = false, workingDirectory = process.cwd() } = args;

    try {
      let command = `npx @paths.design/caws-cli diagnose`;
      if (fix) command += ' --fix';

      const result = await execCommand(command, {
        cwd: workingDirectory,
        timeout: 60000, // Longer timeout for diagnose with fixes
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                output: stripAnsi(result.stdout || 'Diagnostics completed'),
                fixesApplied: fix,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws diagnose',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleProgressUpdate(args) {
    const {
      specFile = '.caws/working-spec.yaml',
      criterionId,
      status,
      testsWritten,
      testsPassing,
      coverage,
      workingDirectory = process.cwd(),
    } = args;

    try {
      // Read the current working spec
      const specPath = path.isAbsolute(specFile) ? specFile : path.join(workingDirectory, specFile);

      if (!fs.existsSync(specPath)) {
        throw new Error(`Working spec not found: ${specPath}`);
      }

      const specContent = fs.readFileSync(specPath, 'utf8');
      const spec = JSON.parse(specContent); // Assume JSON for now, can extend to YAML

      // Find and update the acceptance criterion
      const criterion = spec.acceptance?.find((a) => a.id === criterionId);
      if (!criterion) {
        throw new Error(`Acceptance criterion not found: ${criterionId}`);
      }

      // Update the criterion with new progress data
      if (status) criterion.status = status;
      if (testsWritten !== undefined || testsPassing !== undefined) {
        criterion.tests = criterion.tests || {};
        if (testsWritten !== undefined) criterion.tests.written = testsWritten;
        if (testsPassing !== undefined) criterion.tests.passing = testsPassing;
      }
      if (coverage !== undefined) criterion.coverage = coverage;
      criterion.last_updated = new Date().toISOString();

      // Write back the updated spec
      fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: `Updated progress for acceptance criterion ${criterionId}`,
                updatedFields: {
                  status,
                  testsWritten,
                  testsPassing,
                  coverage,
                  lastUpdated: criterion.last_updated,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws progress update',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleCawsArchive(args) {
    const { changeId, force = false, dryRun = false, workingDirectory = process.cwd() } = args;

    try {
      let command = `npx @paths.design/caws-cli archive "${changeId}"`;

      if (force) command += ' --force';
      if (dryRun) command += ' --dry-run';

      const result = await execCommand(command, {
        cwd: workingDirectory,
        timeout: 30000,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                changeId,
                archived: !dryRun,
                output: stripAnsi(result.stdout || 'Archive operation completed'),
                dryRun,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: `caws archive ${changeId}`,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleQualityGates(args) {
    const { args: cliArgs = [], workingDirectory = process.cwd() } = args;

    try {
      const command = `npx @paths.design/caws-cli quality-gates ${cliArgs.join(' ')}`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: stripAnsi(result),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws quality-gates',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleQualityGatesRun(args) {
    const {
      gates = '',
      ci = false,
      json = false,
      fix = false,
      workingDirectory = process.cwd(),
    } = args;

    try {
      // Build command arguments
      const cliArgs = [];
      if (gates && gates.trim()) {
        cliArgs.push('--gates', gates.trim());
      }
      if (ci) {
        cliArgs.push('--ci');
      }
      if (json) {
        cliArgs.push('--json');
      }
      if (fix) {
        cliArgs.push('--fix');
      }

      // Execute the quality gates runner directly
      const { spawn } = await import('child_process');

      // Try multiple locations for quality gates runner:
      // 1. Bundled in VS Code extension (when MCP server runs from extension)
      // 2. Monorepo structure (development)
      // 3. npm package installation
      const extensionPath = process.env.VSCODE_EXTENSION_PATH || process.env.VSCODE_EXTENSION_DIR;
      const possiblePaths = [
        // Bundled in extension (relative to MCP server when bundled)
        extensionPath
          ? path.join(extensionPath, 'bundled', 'quality-gates', 'run-quality-gates.mjs')
          : null,
        // Bundled relative to MCP server (if running from bundled location)
        path.join(path.dirname(__filename), '..', 'quality-gates', 'run-quality-gates.mjs'),
        // Monorepo structure (development)
        path.join(
          path.dirname(path.dirname(__filename)),
          '..',
          '..',
          'packages',
          'quality-gates',
          'run-quality-gates.mjs'
        ),
        // Published npm package (priority)
        path.join(
          process.cwd(),
          'node_modules',
          '@paths.design',
          'quality-gates',
          'run-quality-gates.mjs'
        ),
        // Legacy monorepo local copy (fallback)
        path.join(process.cwd(), 'node_modules', '@caws', 'quality-gates', 'run-quality-gates.mjs'),
        path.join(process.cwd(), 'node_modules', 'quality-gates', 'run-quality-gates.mjs'),
      ].filter(Boolean);

      let qualityGatesPath = null;
      for (const possiblePath of possiblePaths) {
        if (fs.existsSync(possiblePath)) {
          qualityGatesPath = possiblePath;
          break;
        }
      }

      if (!qualityGatesPath) {
        throw new Error(
          `Quality gates runner not found. Searched:\n${possiblePaths.map((p) => `  - ${p}`).join('\n')}`
        );
      }

      return new Promise((resolve, reject) => {
        const child = spawn('node', [qualityGatesPath, ...cliArgs], {
          cwd: workingDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CAWS_MCP_INTEGRATION: 'true',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', (_code) => {
          const output = stripAnsi(stdout || stderr);
          resolve({
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          });
        });

        child.on('error', (error) => {
          reject({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: error.message,
                    command: 'caws_quality_gates_run',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws_quality_gates_run',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleQualityGatesStatus(args) {
    const { workingDirectory: _workingDirectory = process.cwd(), json = false } = args;

    try {
      // Check for quality gates report file
      const reportPath = path.join(_workingDirectory, 'docs-status', 'quality-gates-report.json');

      if (fs.existsSync(reportPath)) {
        const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

        if (json) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(report, null, 2),
              },
            ],
          };
        }

        // Human-readable format
        const status = report.violations.length === 0 ? '✅ PASSED' : '❌ FAILED';
        const summary =
          `Quality Gates Status: ${status}\n` +
          `Last run: ${new Date(report.timestamp).toLocaleString()}\n` +
          `Context: ${report.context}\n` +
          `Files checked: ${report.files_scoped}\n` +
          `Violations: ${report.violations.length}\n` +
          `Warnings: ${report.warnings.length}`;

        return {
          content: [
            {
              type: 'text',
              text: summary,
            },
          ],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: 'No quality gates report found. Run quality gates first.',
            },
          ],
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws_quality_gates_status',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleQualityExceptionsList(args) {
    const { gate, status = 'active', workingDirectory = process.cwd() } = args;

    try {
      // Import the exception framework using path resolver
      const exceptionFrameworkPath = resolveQualityGatesModule('shared-exception-framework.mjs');

      // Set NODE_PATH to include quality-gates node_modules for ES module resolution
      const qualityGatesDir = path.dirname(fileURLToPath(exceptionFrameworkPath));
      const originalNodePath = process.env.NODE_PATH || '';
      const qualityGatesNodeModules = path.join(qualityGatesDir, 'node_modules');
      process.env.NODE_PATH =
        qualityGatesNodeModules + (originalNodePath ? path.delimiter + originalNodePath : '');

      let loadExceptionConfig, setProjectRoot;
      try {
        const module = await import(exceptionFrameworkPath);
        loadExceptionConfig = module.loadExceptionConfig;
        setProjectRoot = module.setProjectRoot;
      } finally {
        // Restore original NODE_PATH
        process.env.NODE_PATH = originalNodePath;
      }

      // Set project root to working directory (ensures project-specific exceptions)
      setProjectRoot(workingDirectory);

      const config = loadExceptionConfig();
      let exceptions = config.exceptions || [];

      // Filter by status
      const now = new Date();
      exceptions = exceptions.filter((exc) => {
        const expiresAt = new Date(exc.expires_at);
        const isExpired = expiresAt < now;

        switch (status) {
          case 'active':
            return !isExpired;
          case 'expired':
            return isExpired;
          case 'all':
            return true;
          default:
            return !isExpired;
        }
      });

      // Filter by gate if specified
      if (gate) {
        exceptions = exceptions.filter((exc) => exc.gate === gate);
      }

      // Format for display
      const formatted = exceptions.map((exc) => ({
        id: exc.id,
        gate: exc.gate,
        reason: exc.reason,
        approved_by: exc.approved_by,
        expires_at: exc.expires_at,
        status: new Date(exc.expires_at) > now ? 'active' : 'expired',
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                exceptions: formatted,
                count: formatted.length,
                filter: { gate, status },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      // Provide helpful error message with troubleshooting guidance
      const errorMessage = error.message || 'Unknown error';
      const isPathError =
        errorMessage.includes('not found') || errorMessage.includes('Cannot find module');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
                command: 'caws_quality_exceptions_list',
                suggestion: isPathError
                  ? 'Exception framework not available. Ensure quality-gates package is bundled with extension or available in monorepo.'
                  : 'Check error message for details and verify exception framework is properly configured.',
                exceptions: [], // Return empty list on error for graceful degradation
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleQualityExceptionsCreate(args) {
    const {
      gate,
      reason,
      approvedBy,
      expiresAt,
      filePattern,
      violationType,
      context = 'all',
      workingDirectory = process.cwd(),
    } = args;

    try {
      // Import the exception framework using path resolver
      const exceptionFrameworkPath = resolveQualityGatesModule('shared-exception-framework.mjs');

      // Set NODE_PATH to include quality-gates node_modules for ES module resolution
      const qualityGatesDir = path.dirname(fileURLToPath(exceptionFrameworkPath));
      const originalNodePath = process.env.NODE_PATH || '';
      const qualityGatesNodeModules = path.join(qualityGatesDir, 'node_modules');
      process.env.NODE_PATH =
        qualityGatesNodeModules + (originalNodePath ? path.delimiter + originalNodePath : '');

      let addException, setProjectRoot;
      try {
        const module = await import(exceptionFrameworkPath);
        addException = module.addException;
        setProjectRoot = module.setProjectRoot;
      } finally {
        // Restore original NODE_PATH
        process.env.NODE_PATH = originalNodePath;
      }

      // Set project root to working directory (ensures project-specific exceptions)
      setProjectRoot(workingDirectory);

      // Calculate expiresInDays from expiresAt if provided, otherwise use default
      let expiresInDays = 180; // Default 180 days
      if (expiresAt) {
        const expiresDate = new Date(expiresAt);
        const now = new Date();
        const diffMs = expiresDate.getTime() - now.getTime();
        expiresInDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
        if (expiresInDays < 1) expiresInDays = 1; // Minimum 1 day
      }

      const exceptionData = {
        reason,
        approvedBy,
        expiresInDays,
        ...(filePattern && { filePattern }),
        ...(violationType && { violationType }),
        context,
      };

      // Fix: addException expects (gateName, exceptionData) signature
      const result = addException(gate, exceptionData);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Exception created successfully',
                exception: result,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      // Provide helpful error message with troubleshooting guidance
      const errorMessage = error.message || 'Unknown error';
      const isPathError =
        errorMessage.includes('not found') || errorMessage.includes('Cannot find module');

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: errorMessage,
                command: 'caws_quality_exceptions_create',
                suggestion: isPathError
                  ? 'Exception framework not available. Ensure quality-gates package is bundled with extension or available in monorepo.'
                  : 'Check error message for details. Verify all required parameters are provided and exception framework is properly configured.',
                exception: null, // Return null on error for graceful degradation
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleRefactorProgressCheck(args) {
    const {
      context = 'ci',
      strict = false,
      workingDirectory: _workingDirectory = process.cwd(),
    } = args;

    try {
      // Execute the refactor progress checker
      const { spawn } = await import('child_process');
      const progressCheckerPath = path.join(
        path.dirname(path.dirname(__filename)),
        '..',
        '..',
        'packages',
        'quality-gates',
        'monitor-refactoring-progress.mjs'
      );

      const cliArgs = ['--context', context];
      if (strict) {
        cliArgs.push('--strict');
      }

      return new Promise((resolve, reject) => {
        const child = spawn('node', [progressCheckerPath, ...cliArgs], {
          cwd: _workingDirectory,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            ...process.env,
            CAWS_MCP_INTEGRATION: 'true',
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        child.on('close', (_code) => {
          const output = stripAnsi(stdout || stderr);

          resolve({
            content: [
              {
                type: 'text',
                text: output,
              },
            ],
          });
        });

        child.on('error', (error) => {
          reject({
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: false,
                    error: error.message,
                    command: 'caws_refactor_progress_check',
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          });
        });
      });
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws_refactor_progress_check',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleSlashCommands(args) {
    const { command, ...params } = args;

    // Map slash commands to MCP tool names
    const slashCommandMap = {
      '/caws:start': 'caws_init',
      '/caws:init': 'caws_init',
      '/caws:validate': 'caws_validate',
      '/caws:archive': 'caws_archive',
      '/caws:status': 'caws_status',
      '/caws:specs': 'caws_slash_commands', // Route to slash command handler
      '/caws:evaluate': 'caws_evaluate',
      '/caws:iterate': 'caws_iterate',
      '/caws:diagnose': 'caws_diagnose',
      '/caws:scaffold': 'caws_scaffold',
      '/caws:help': 'caws_help',
      '/caws:waivers': 'caws_waivers_list',
      '/caws:workflow': 'caws_workflow_guidance',
      '/caws:monitor': 'caws_monitor_status',
      '/caws:provenance': 'caws_provenance',
      '/caws:hooks': 'caws_hooks',
      '/caws:quality-gates': 'caws_quality_gates',
      '/caws:quality-gates-run': 'caws_quality_gates_run',
      '/caws:quality-gates-status': 'caws_quality_gates_status',
      '/caws:quality-exceptions-list': 'caws_quality_exceptions_list',
      '/caws:quality-exceptions-create': 'caws_quality_exceptions_create',
      '/caws:refactor-progress': 'caws_refactor_progress_check',
    };

    const mappedTool = slashCommandMap[command];

    if (!mappedTool) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: `Unknown slash command: ${command}`,
                availableCommands: Object.keys(slashCommandMap),
                suggestion: 'Use /caws:help for available commands',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // For specs commands, route to subcommand handler
    if (mappedTool === 'caws_slash_commands') {
      return await this.handleSlashCommandsWithSubcommands(args);
    }

    // Call the mapped tool with the provided parameters
    try {
      const toolArgs = { ...params, workingDirectory: params.workingDirectory || process.cwd() };

      switch (mappedTool) {
        case 'caws_init':
          return await this.handleCawsInit(toolArgs);
        case 'caws_scaffold':
          return await this.handleCawsScaffold(toolArgs);
        case 'caws_evaluate':
          return await this.handleCawsEvaluate(toolArgs);
        case 'caws_iterate':
          return await this.handleCawsIterate(toolArgs);
        case 'caws_validate':
          return await this.handleCawsValidate(toolArgs);
        case 'caws_archive':
          return await this.handleCawsArchive(toolArgs);
        case 'caws_workflow_guidance':
          return await this.handleWorkflowGuidance(toolArgs);
        case 'caws_quality_monitor':
          return await this.handleQualityMonitor(toolArgs);
        case 'caws_test_analysis':
          return await this.handleTestAnalysis(toolArgs);
        case 'caws_provenance':
          return await this.handleProvenance(toolArgs);
        case 'caws_hooks':
          return await this.handleHooks(toolArgs);
        case 'caws_status':
          return await this.handleStatus(toolArgs);
        case 'caws_diagnose':
          return await this.handleDiagnose(toolArgs);
        case 'caws_help':
          return await this.handleHelp(toolArgs);
        default:
          throw new Error(`Tool handler not implemented: ${mappedTool}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                slashCommand: command,
                mappedTool,
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  async handleSlashCommandsWithSubcommands(args) {
    const { command, ...params } = args;

    // Handle specs subcommands
    if (command.startsWith('/caws:specs ')) {
      const subcommand = command.replace('/caws:specs ', '');

      // Import specs functionality
      const fs = await import('fs-extra');
      const path = await import('path');
      const yaml = await import('js-yaml');

      const SPECS_DIR = '.caws/specs';
      const SPECS_REGISTRY = '.caws/specs/registry.json';

      try {
        // Load specs registry
        let registry = { specs: {} };
        if (fs.existsSync(SPECS_REGISTRY)) {
          registry = JSON.parse(fs.readFileSync(SPECS_REGISTRY, 'utf8'));
        }

        // List specs
        if (subcommand === 'list' || subcommand === '') {
          if (!fs.existsSync(SPECS_DIR)) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ specs: [], count: 0 }, null, 2) }],
            };
          }

          const files = fs.readdirSync(SPECS_DIR, { recursive: true });
          const yamlFiles = files.filter((file) => file.endsWith('.yaml') || file.endsWith('.yml'));

          const specs = [];
          for (const file of yamlFiles) {
            const filePath = path.join(SPECS_DIR, file);
            try {
              const content = fs.readFileSync(filePath, 'utf8');
              const spec = yaml.load(content);
              specs.push({
                id: spec.id || path.basename(file, path.extname(file)),
                type: spec.type || 'feature',
                status: spec.status || 'draft',
                title: spec.title || 'Untitled',
              });
            } catch (error) {
              // Skip invalid files
            }
          }

          return {
            content: [
              { type: 'text', text: JSON.stringify({ specs, count: specs.length }, null, 2) },
            ],
          };
        }

        // Create spec
        if (subcommand.startsWith('create ')) {
          const specId = subcommand.replace('create ', '');
          const { type = 'feature', title, tier = 'T3', mode = 'development' } = params;

          // Create spec file
          const specContent = {
            id: specId,
            type,
            title: title || `New ${type}`,
            status: 'draft',
            risk_tier: tier,
            mode,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            acceptance_criteria: [],
          };

          fs.ensureDirSync(SPECS_DIR);
          const filePath = path.join(SPECS_DIR, `${specId}.yaml`);
          fs.writeFileSync(filePath, yaml.dump(specContent, { indent: 2 }));

          // Update registry
          registry.specs[specId] = {
            path: `${specId}.yaml`,
            type,
            status: 'draft',
            created_at: specContent.created_at,
            updated_at: specContent.updated_at,
          };
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    spec: { id: specId, type, title: specContent.title, status: 'draft' },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Show spec
        if (subcommand.startsWith('show ')) {
          const specId = subcommand.replace('show ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          const content = fs.readFileSync(specPath, 'utf8');
          const spec = yaml.load(content);

          return {
            content: [{ type: 'text', text: JSON.stringify(spec, null, 2) }],
          };
        }

        // Update spec
        if (subcommand.startsWith('update ')) {
          const specId = subcommand.replace('update ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          const content = fs.readFileSync(specPath, 'utf8');
          const spec = yaml.load(content);

          // Apply updates
          const updates = {};
          if (params.status) updates.status = params.status;
          if (params.title) updates.title = params.title;
          if (params.description) updates.description = params.description;

          const updatedSpec = { ...spec, ...updates, updated_at: new Date().toISOString() };
          fs.writeFileSync(specPath, yaml.dump(updatedSpec, { indent: 2 }));

          // Update registry
          registry.specs[specId].updated_at = updatedSpec.updated_at;
          if (params.status) registry.specs[specId].status = params.status;
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    spec: { id: specId, updates },
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }

        // Delete spec
        if (subcommand.startsWith('delete ')) {
          const specId = subcommand.replace('delete ', '');

          if (!registry.specs[specId]) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ error: `Spec '${specId}' not found` }, null, 2),
                },
              ],
              isError: true,
            };
          }

          const specPath = path.join(SPECS_DIR, registry.specs[specId].path);
          fs.removeSync(specPath);
          delete registry.specs[specId];
          fs.writeFileSync(SPECS_REGISTRY, JSON.stringify(registry, null, 2));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    spec: specId,
                    message: 'Spec deleted successfully',
                  },
                  null,
                  2
                ),
              },
            ],
          };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: error.message }, null, 2) }],
          isError: true,
        };
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: `Unsupported slash command: ${command}`,
              supported: [
                '/caws:specs list',
                '/caws:specs create',
                '/caws:specs show',
                '/caws:specs update',
                '/caws:specs delete',
              ],
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  async handleWaiversList(args) {
    const { status = 'active', workingDirectory = process.cwd() } = args;

    try {
      const command = `npx @paths.design/caws-cli waivers list`;
      const result = execCawsCommand(command, { cwd: workingDirectory });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                waivers: this.parseWaiversOutput(result),
                filter: status,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: false,
                error: error.message,
                command: 'caws waivers list',
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  parseWaiversOutput(output) {
    // Parse the text output from waivers list command
    const waivers = [];
    const lines = output.split('\n');

    let currentWaiver = null;
    for (const line of lines) {
      if (line.includes('🔖 ') && line.includes(':')) {
        if (currentWaiver) {
          waivers.push(currentWaiver);
        }
        const match = line.match(/🔖 ([^:]+): (.+)/);
        if (match) {
          currentWaiver = {
            id: match[1],
            title: match[2],
            status: line.includes('✅') ? 'active' : line.includes('⚠️') ? 'expired' : 'revoked',
          };
        }
      } else if (currentWaiver && line.includes('Reason:')) {
        currentWaiver.reason = line.split('Reason:')[1].trim();
      } else if (currentWaiver && line.includes('Gates:')) {
        currentWaiver.gates = line.split('Gates:')[1].trim().split(', ');
      } else if (currentWaiver && line.includes('Expires:')) {
        currentWaiver.expires = line.split('Expires:')[1].trim().split(' ')[0];
      }
    }

    if (currentWaiver) {
      waivers.push(currentWaiver);
    }

    return waivers;
  }

  async handleHelp(args) {
    const { tool, category } = args;

    if (tool) {
      // Show help for specific tool
      const toolDef = CAWS_TOOLS.find((t) => t.name === tool);
      if (!toolDef) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: `Tool not found: ${tool}`,
                  available_tools: CAWS_TOOLS.map((t) => t.name),
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                tool: toolDef.name,
                description: toolDef.description,
                parameters: toolDef.inputSchema.properties,
                required: toolDef.inputSchema.required || [],
                examples: this.getToolExamples(toolDef.name),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (category) {
      // Show tools by category
      const categories = {
        'project-management': ['caws_init', 'caws_scaffold', 'caws_status'],
        validation: ['caws_validate', 'caws_evaluate', 'caws_iterate'],
        'quality-gates': ['caws_diagnose', 'caws_hooks', 'caws_provenance'],
        development: ['caws_workflow_guidance', 'caws_quality_monitor', 'caws_progress_update'],
        testing: ['caws_test_analysis'],
        compliance: ['caws_waiver_create', 'caws_waivers_list'],
      };

      const tools = categories[category] || [];
      const toolDetails = CAWS_TOOLS.filter((t) => tools.includes(t.name));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                category,
                tools: toolDetails.map((t) => ({
                  name: t.name,
                  description: t.description,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Show all tools overview
    const categories = {
      '🚀 Project Setup': ['caws_init', 'caws_scaffold'],
      '🔍 Validation & Status': ['caws_validate', 'caws_evaluate', 'caws_iterate', 'caws_status'],
      '🩺 Health & Diagnostics': ['caws_diagnose', 'caws_hooks', 'caws_provenance'],
      '⚙️ Development Workflow': [
        'caws_workflow_guidance',
        'caws_quality_monitor',
        'caws_progress_update',
      ],
      '🧪 Testing & Analysis': ['caws_test_analysis'],
      '📋 Compliance & Waivers': ['caws_waiver_create', 'caws_waivers_list'],
    };

    const help = {
      overview: 'CAWS MCP Server provides comprehensive development workflow management tools',
      categories: Object.entries(categories).map(([categoryName, toolNames]) => ({
        category: categoryName,
        tools: toolNames.map((name) => {
          const tool = CAWS_TOOLS.find((t) => t.name === name);
          return {
            name,
            description: tool?.description || 'Unknown tool',
          };
        }),
      })),
      usage: {
        get_all_tools: 'Call without parameters to see this overview',
        get_tool_help: 'Use tool parameter to get detailed help for a specific tool',
        get_category_help: 'Use category parameter to see tools by category',
        available_categories: [
          'project-management',
          'validation',
          'quality-gates',
          'development',
          'testing',
          'compliance',
        ],
      },
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(help, null, 2),
        },
      ],
    };
  }

  /**
   * Handle monitoring status requests
   */
  async handleMonitorStatus(_args) {
    try {
      const status = this.monitor.getStatus();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                monitoring_active: status.isRunning,
                budgets: status.budgets,
                progress: status.progress,
                overall_progress: status.overallProgress,
                active_alerts: status.alerts.length,
                working_spec: status.workingSpec,
                timestamp: new Date().toISOString(),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Failed to get monitoring status',
                details: error.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * Handle monitoring alerts requests
   */
  async handleMonitorAlerts(args) {
    try {
      const { severity, limit = 10 } = args;
      let alerts = this.monitor.alerts;

      if (severity) {
        alerts = alerts.filter((alert) => alert.severity === severity);
      }

      alerts = alerts.slice(-limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                alerts_count: alerts.length,
                alerts: alerts.map((alert) => ({
                  id: alert.id,
                  type: alert.type,
                  severity: alert.severity,
                  message: alert.message,
                  timestamp: alert.timestamp,
                  budget_type: alert.budgetType,
                  current: alert.current,
                  limit: alert.limit,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Failed to get monitoring alerts',
                details: error.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  /**
   * Handle monitoring configuration requests
   */
  async handleMonitorConfigure(args) {
    try {
      const { action, ...config } = args;

      switch (action) {
        case 'update_thresholds':
          if (config.budgetWarning !== undefined) {
            this.monitor.options.alertThresholds.budgetWarning = config.budgetWarning;
          }
          if (config.budgetCritical !== undefined) {
            this.monitor.options.alertThresholds.budgetCritical = config.budgetCritical;
          }
          break;

        case 'add_watch_path':
          if (config.path && !this.monitor.options.watchPaths.includes(config.path)) {
            this.monitor.options.watchPaths.push(config.path);
            // Restart monitoring with new paths
            await this.monitor.stop();
            await this.monitor.start();
          }
          break;

        case 'remove_watch_path':
          if (config.path) {
            this.monitor.options.watchPaths = this.monitor.options.watchPaths.filter(
              (p) => p !== config.path
            );
            // Restart monitoring with updated paths
            await this.monitor.stop();
            await this.monitor.start();
          }
          break;

        case 'set_polling_interval':
          if (config.interval && config.interval > 0) {
            this.monitor.options.pollingInterval = config.interval;
            // Restart periodic checks with new interval
            if (this.monitor.checkInterval) {
              clearInterval(this.monitor.checkInterval);
            }
            this.monitor.startPeriodicChecks();
          }
          break;

        default:
          throw new Error(`Unknown configuration action: ${action}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                action,
                new_config: {
                  watchPaths: this.monitor.options.watchPaths,
                  pollingInterval: this.monitor.options.pollingInterval,
                  alertThresholds: this.monitor.options.alertThresholds,
                },
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'Failed to configure monitoring',
                details: error.message,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  }

  getToolExamples(toolName) {
    const examples = {
      caws_validate: [
        'caws_validate({ specFile: ".caws/working-spec.yaml" })',
        'caws_validate({ workingDirectory: "/path/to/project" })',
      ],
      caws_iterate: [
        'caws_iterate({ currentState: "Starting implementation" })',
        'caws_iterate({ specFile: "custom-spec.yaml", currentState: "Tests written" })',
      ],
      caws_progress_update: [
        'caws_progress_update({ criterionId: "A1", status: "in_progress" })',
        'caws_progress_update({ criterionId: "A1", testsWritten: 5, testsPassing: 3, coverage: 75.5 })',
      ],
      caws_diagnose: [
        'caws_diagnose({})',
        'caws_diagnose({ fix: true, workingDirectory: "/path/to/project" })',
      ],
    };

    return examples[toolName] || ['No examples available'];
  }
}

// Tool definitions for MCP
const CAWS_TOOLS = [
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

// Handler implementations for new tools are defined as class methods above
// Helper function to execute shell commands
function execCommand(command, options = {}) {
  return new Promise((_resolve, _reject) => {
    const result = execSync(command, {
      ...options,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], // Explicitly separate stdout/stderr
      env: {
        ...process.env,
        ...options.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        CAWS_OUTPUT_FORMAT: 'json', // Force JSON output format
        TERM: 'dumb', // Dumb terminal (no colors)
        CI: 'true', // Many tools check CI env var to disable colors
      },
    });
    // Strip ANSI codes from output to prevent JSON corruption
    // Do multiple passes to catch any edge cases
    let cleanedOutput = stripAnsi(result.toString());
    cleanedOutput = stripAnsi(cleanedOutput); // Second pass
    _resolve({ stdout: cleanedOutput, stderr: '' });
  }).catch((error) => {
    // Don't log in MCP mode - suppress all output to prevent ANSI leaks
    throw error;
  });
}

// Main execution
async function main() {
  const server = new CawsMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Disable monitoring in MCP mode - it can cause stdout pollution
  // Monitoring uses file watchers and yaml parsing which may emit logs
  process.env.CAWS_DISABLE_MONITORING = 'true';

  // Don't log in MCP mode - logs can leak ANSI codes to stdout
  // MCP server is now running silently
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('CAWS MCP Server error:', error.message);
    process.exit(1);
  });
}

export default CawsMcpServer;
