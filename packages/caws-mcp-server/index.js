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

    this.setupToolHandlers();
    this.setupResourceHandlers();
  }

  setupToolHandlers() {
    // Handle MCP initialization
    this.setRequestHandler(InitializeRequestSchema, async (request) => {
      const { protocolVersion, capabilities, clientInfo } = request.params;

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
      console.error('MCP: Listing tools');
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
        case 'caws_waiver_create':
          return await this.handleWaiverCreate(args);
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
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  setupResourceHandlers() {
    // List available resources
    this.setRequestHandler(ListResourcesRequestSchema, () => {
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
        // Ignore errors in resource listing
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

      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} ${cliArgs.join(' ')}`;
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

      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} ${cliArgs.join(' ')}`;
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
      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} agent evaluate ${specFile}`;
      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      // Extract JSON from mixed output
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      const evaluation = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { success: false, error: 'No JSON found in output' };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(evaluation, null, 2),
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
      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} agent iterate --current-state ${JSON.stringify(stateArg)} ${specFile}`;

      const result = execSync(command, {
        encoding: 'utf8',
        cwd: workingDirectory,
        maxBuffer: 1024 * 1024,
      });

      // Extract JSON from mixed output
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      const guidance = jsonMatch
        ? JSON.parse(jsonMatch[0])
        : { success: false, error: 'No JSON found in output' };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(guidance, null, 2),
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
      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} validate ${specFile}`;
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

      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} ${waiverArgs.join(' ')}`;
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

    // Generate workflow-specific guidance
    const guidance = this.generateWorkflowGuidance(workflowType, currentStep, context);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(guidance, null, 2),
        },
      ],
    };
  }

  async handleQualityMonitor(args) {
    const { action, files, context } = args;

    // Analyze the action and provide quality monitoring feedback
    const feedback = await this.analyzeQualityImpact(action, files, context);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(feedback, null, 2),
        },
      ],
    };
  }

  async handleTestAnalysis(args) {
    const {
      subcommand,
      // specFile: _specFile = '.caws/working-spec.yaml',
      workingDirectory = process.cwd(),
    } = args;

    try {
      // Execute test analysis command and return results
      const result = await execCommand(
        `node packages/caws-cli/dist/index.js test-analysis ${subcommand}`,
        {
          cwd: workingDirectory,
          timeout: 30000,
        }
      );

      return {
        content: [{ type: 'text', text: result.stdout || result.stderr || 'Analysis completed' }],
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
      let command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} provenance ${subcommand}`;

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

  generateWorkflowGuidance(workflowType, currentStep, _context) {
    const workflowTemplates = {
      tdd: {
        steps: [
          'Define requirements and acceptance criteria',
          'Write failing test',
          'Implement minimal code to pass test',
          'Run CAWS validation',
          'Refactor while maintaining tests',
          'Repeat for next requirement',
        ],
        guidance: {
          1: 'Start by clearly defining what the code should do. Use CAWS working spec to document requirements.',
          2: 'Write a test that captures the desired behavior but will initially fail.',
          3: 'Implement only the minimal code needed to make the test pass.',
          4: 'Run CAWS evaluation to ensure quality standards are maintained.',
          5: 'Improve code structure while keeping all tests passing.',
          6: 'Move to the next requirement and repeat the cycle.',
        },
      },
      refactor: {
        steps: [
          'Establish baseline quality metrics',
          'Apply refactoring changes',
          'Run comprehensive validation',
          'Address any quality gate failures',
          'Document changes and rationale',
        ],
        guidance: {
          1: 'Run CAWS evaluation to establish current quality baseline.',
          2: 'Make your refactoring changes incrementally.',
          3: 'Run full CAWS validation to ensure no quality degradation.',
          4: 'Address any failing quality gates with waivers if necessary.',
          5: 'Update documentation and provenance records.',
        },
      },
      feature: {
        steps: [
          'Create working specification',
          'Design and plan implementation',
          'Implement core functionality',
          'Add comprehensive testing',
          'Run full quality validation',
          'Prepare for integration',
        ],
        guidance: {
          1: 'Define clear requirements, acceptance criteria, and risk assessment.',
          2: 'Break down the feature into manageable tasks.',
          3: 'Implement core functionality with error handling.',
          4: 'Add unit, integration, and contract tests.',
          5: 'Run complete CAWS validation and address issues.',
          6: 'Ensure documentation and provenance are complete.',
        },
      },
    };

    const template = workflowTemplates[workflowType];
    if (!template) {
      return {
        error: `Unknown workflow type: ${workflowType}`,
        available_types: Object.keys(workflowTemplates),
      };
    }

    const currentGuidance =
      template.guidance[currentStep] || 'Continue with the next logical step.';
    const nextStep = currentStep < template.steps.length ? currentStep + 1 : null;

    return {
      workflow_type: workflowType,
      current_step: currentStep,
      total_steps: template.steps.length,
      step_description: template.steps[currentStep - 1] || 'Unknown step',
      guidance: currentGuidance,
      next_step: nextStep,
      next_step_description: nextStep ? template.steps[nextStep - 1] : null,
      all_steps: template.steps,
      caws_recommendations: this.getWorkflowCawsRecommendations(workflowType, currentStep),
    };
  }

  getWorkflowCawsRecommendations(workflowType, currentStep) {
    const recommendations = {
      tdd: {
        1: ['caws agent evaluate --feedback-only', 'Ensure spec completeness'],
        2: ['Write failing test first', 'caws validate for basic checks'],
        3: ['Implement minimal solution', 'Run tests to verify'],
        4: ['caws agent evaluate', 'Address any quality issues'],
        5: ['Refactor safely', 'Re-run CAWS validation'],
        6: ['caws agent iterate for next steps', 'Continue TDD cycle'],
      },
      refactor: {
        1: ['caws agent evaluate', 'Establish quality baseline'],
        2: ['Apply changes incrementally', 'caws validate frequently'],
        3: ['caws agent evaluate', 'Full quality assessment'],
        4: ['Create waivers if needed', 'Document rationale'],
        5: ['Update provenance', 'caws provenance update'],
      },
      feature: {
        1: ['caws init --interactive', 'Create comprehensive spec'],
        2: ['caws agent iterate', 'Get implementation guidance'],
        3: ['caws agent evaluate', 'Validate progress'],
        4: ['Add comprehensive tests', 'caws cicd analyze'],
        5: ['caws validate', 'Final quality gates'],
        6: ['caws provenance generate', 'Prepare for integration'],
      },
    };

    return recommendations[workflowType]?.[currentStep] || ['caws agent evaluate'];
  }

  async analyzeQualityImpact(action, files, context) {
    const analysis = {
      action,
      files_affected: files?.length || 0,
      quality_impact: 'unknown',
      recommendations: [],
      risk_level: 'low',
    };

    // Analyze based on action type
    switch (action) {
      case 'file_saved':
        analysis.quality_impact = 'code_change';
        analysis.recommendations = [
          'Run CAWS validation: caws agent evaluate',
          'Check for linting issues',
          'Verify test coverage if applicable',
        ];
        break;

      case 'code_edited':
        analysis.quality_impact = 'implementation_change';
        analysis.recommendations = [
          'Run unit tests for affected files',
          'Check CAWS quality gates',
          'Update documentation if public APIs changed',
        ];
        analysis.risk_level = files?.length > 5 ? 'medium' : 'low';
        break;

      case 'test_run':
        analysis.quality_impact = 'validation_complete';
        analysis.recommendations = [
          'Review test results',
          'Address any failing tests',
          'Update CAWS working spec if needed',
        ];
        break;

      default:
        analysis.quality_impact = 'unknown_action';
        analysis.recommendations = ['Run CAWS evaluation to assess impact'];
    }

    // Add context-specific recommendations
    if (context?.project_tier <= 2) {
      analysis.recommendations.unshift('High-quality project: Run comprehensive validation');
      analysis.risk_level = 'high';
    }

    return analysis;
  }

  findWorkingSpecs() {
    // Find all .caws/working-spec.yaml files in current directory and subdirectories
    const specs = [];

    function findSpecs(dir) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const fullPath = path.join(dir, file);
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
            findSpecs(fullPath);
          } else if (file === 'working-spec.yaml' && dir.includes('.caws')) {
            specs.push(path.relative(process.cwd(), fullPath));
          }
        }
      } catch (error) {
        // Ignore directories we can't read
      }
    }

    findSpecs(process.cwd());
    return specs;
  }

  async getActiveWaivers() {
    try {
      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} waivers list`;
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
      let command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} hooks ${subcommand}`;

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
      const command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} status --spec ${specFile}`;
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
      let command = `node ${path.join(__dirname, '../caws-cli/dist/index.js')} diagnose`;
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
      // eslint-disable-next-line no-console
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

  // eslint-disable-next-line no-console
  console.error('CAWS MCP Server started');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('CAWS MCP Server error:', error);
    process.exit(1);
  });
}

export default CawsMcpServer;
