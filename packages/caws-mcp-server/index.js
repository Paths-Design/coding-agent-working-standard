#!/usr/bin/env node

/**
 * CAWS MCP Server
 *
 * Model Context Protocol server that exposes CAWS tools to AI agents.
 * Enables real-time quality validation, iterative guidance, and workflow management.
 *
 * @author @darianrosebrook
 */

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
import { fileURLToPath } from 'url';
import { CawsMonitor } from './src/monitoring/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

    // Initialize monitoring system
    this.monitor = new CawsMonitor({
      watchPaths: ['.caws', 'src', 'tests', 'docs', 'packages'],
      pollingInterval: 30000, // 30 seconds
    });

    this.setupToolHandlers();
    this.setupResourceHandlers();
  }

  setupToolHandlers() {
    // Handle MCP initialization
    this.setRequestHandler(InitializeRequestSchema, async (request) => {
      const { protocolVersion, clientInfo } = request.params;

      console.error(`MCP Initialize: protocol=${protocolVersion}, client=${clientInfo?.name}`);

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
      console.error('MCP Client initialized - ready for requests');
    });

    // List available tools
    this.setRequestHandler(ListToolsRequestSchema, () => {
      try {
        console.error('MCP: Listing tools - returning', CAWS_TOOLS.length, 'tools');
        const result = { tools: CAWS_TOOLS };
        console.error('MCP: Tools result prepared');
        return result;
      } catch (error) {
        console.error('MCP: Error listing tools:', error.message);
        throw error;
      }
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
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  setupResourceHandlers() {
    // List available resources
    this.setRequestHandler(ListResourcesRequestSchema, () => {
      try {
        console.error('MCP: Listing resources');
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
          console.error('MCP: Error finding working specs:', error.message);
          // Ignore errors in resource listing
        }

        console.error('MCP: Returning', resources.length, 'resources');
        return { resources };
      } catch (error) {
        console.error('MCP: Error listing resources:', error.message);
        throw error;
      }
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
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'Project initialized successfully',
                output: result,
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
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                message: 'CAWS components scaffolded successfully',
                output: result,
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
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      return {
        content: [
          {
            type: 'text',
            text: result,
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

      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [
          {
            type: 'text',
            text: result,
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
      const command = `npx @paths.design/caws-cli validate ${specFile}`;
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [
          {
            type: 'text',
            text: `Validation completed:\n${result}`,
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
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: args.workingDirectory || process.cwd(),
      });

      return {
        content: [
          {
            type: 'text',
            text: `Waiver created successfully:\n${result}`,
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

      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [{ type: 'text', text: result }],
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

      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      return {
        content: [{ type: 'text', text: result }],
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
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
        timeout: 30000,
      });

      return {
        content: [{ type: 'text', text: result }],
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
                output: result.stdout || 'Provenance operation completed',
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
    const specs = [];
    const cawsDir = path.join(process.cwd(), '.caws');
    const specPath = path.join(cawsDir, 'working-spec.yaml');

    try {
      if (fs.existsSync(specPath)) {
        specs.push('.caws/working-spec.yaml');
      }
    } catch (error) {
      // Ignore if we can't read the spec
    }

    return specs;
  }

  async getActiveWaivers() {
    try {
      const command = `npx @paths.design/caws-cli waivers list`;
      const result = execSync(command, { encoding: 'utf8' });

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
                output: result.stdout || result.stderr || 'Hooks operation completed',
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
      const command = `npx @paths.design/caws-cli status --spec ${specFile}`;
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
                output: result.stdout || 'Status check completed',
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
                output: result.stdout || 'Diagnostics completed',
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

  async handleWaiversList(args) {
    const { status = 'active', workingDirectory = process.cwd() } = args;

    try {
      const command = `npx @paths.design/caws-cli waivers list`;
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

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
];

// Handler implementations for new tools are defined as class methods above
// Helper function to execute shell commands
function execCommand(command, options = {}) {
  return new Promise((_resolve, _reject) => {
    try {
      const child = execSync(command, { ...options, encoding: 'utf8' });
      _resolve({ stdout: child, stderr: '' });
    } catch (error) {
      // Log command execution errors for debugging
      console.error(`Command execution failed: ${command}`, error.message);
      throw error;
    }
  });
}

// Main execution
async function main() {
  const server = new CawsMcpServer();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Start monitoring system (unless disabled for testing)
  if (process.env.CAWS_DISABLE_MONITORING !== 'true') {
    try {
      await server.monitor.start();
      console.error('CAWS MCP Server started with monitoring');
    } catch (error) {
      console.error('Failed to start monitoring:', error.message);
      console.error('CAWS MCP Server started without monitoring');
    }
  } else {
    console.error('CAWS MCP Server started (monitoring disabled)');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('CAWS MCP Server error:', error);
    process.exit(1);
  });
}

export default CawsMcpServer;
