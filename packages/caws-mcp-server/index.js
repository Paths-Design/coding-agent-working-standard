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
process.env.NO_COLOR = '1';
process.env.FORCE_COLOR = '0';
process.env.PINO_PRETTY_PRINT = 'false'; // Disable pino pretty printing
process.env.PINO_LOG_PRETTY = 'false'; // Another pino pretty print variable
process.env.PINO_COLORIZE = 'false'; // Disable pino colorization
process.env.TERM = 'dumb'; // Dumb terminal (no colors)

// Import Node.js globals that ESLint doesn't recognize
const { setTimeout: globalSetTimeout, clearTimeout: globalClearTimeout } = globalThis;

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

import { CAWS_TOOLS } from './src/tool-definitions.js';
import { installQualityGatesHandlers } from './src/handlers/quality-gates.js';
import { installSlashCommandHandlers } from './src/handlers/slash-commands.js';

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

    // Install extracted handler modules
    installQualityGatesHandlers(this, {
      stripAnsi,
      execCawsCommand,
      resolveQualityGatesModule,
      serverFilename: __filename,
    });
    installSlashCommandHandlers(this);

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

      // Determine file format by extension and parse accordingly
      const isYaml = specPath.endsWith('.yaml') || specPath.endsWith('.yml');
      let spec;

      if (isYaml) {
        const yaml = await import('js-yaml');
        spec = yaml.load(specContent);
      } else {
        spec = JSON.parse(specContent);
      }

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

      // Write back the updated spec in the same format
      if (isYaml) {
        const yaml = await import('js-yaml');
        fs.writeFileSync(specPath, yaml.dump(spec, { indent: 2 }), 'utf8');
      } else {
        fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), 'utf8');
      }

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

  // handleQualityGates, handleQualityGatesRun, handleQualityGatesStatus,
  // handleQualityExceptionsList, handleQualityExceptionsCreate, handleRefactorProgressCheck
  // are installed by installQualityGatesHandlers() in the constructor.

  // handleSlashCommands, handleSlashCommandsWithSubcommands
  // are installed by installSlashCommandHandlers() in the constructor.

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
