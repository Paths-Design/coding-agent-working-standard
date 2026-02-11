import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getLogger } from './logger';

export interface McpToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class CawsMcpClient {
  private transport: any = null;
  private client: any = null;
  private logger = getLogger().createChild('McpClient');
  private initPromise: Promise<void> | null = null;
  private workspaceRoot: string | undefined;

  constructor() {
    this.workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.initPromise = this.initializeMcpClient();
  }

  private async initializeMcpClient(): Promise<void> {
    try {
      const extensionPath = vscode.extensions.getExtension(
        'paths-design.caws-vscode-extension'
      )?.extensionPath;
      let mcpServerPath: string;

      if (extensionPath) {
        const bundledPath = path.join(extensionPath, 'bundled', 'mcp-server', 'index.js');
        mcpServerPath = fs.existsSync(bundledPath) ? bundledPath : this.getFallbackMcpPath();
      } else {
        mcpServerPath = this.getFallbackMcpPath();
      }

      if (!fs.existsSync(mcpServerPath)) {
        throw new Error(
          'CAWS MCP server not found. Please ensure the extension is properly installed or install @caws/mcp-server globally.'
        );
      }

      const env = {
        ...process.env,
        VSCODE_EXTENSION_PATH: extensionPath || '',
        VSCODE_EXTENSION_DIR: extensionPath || '',
        ...(this.workspaceRoot && {
          CURSOR_WORKSPACE_ROOT: this.workspaceRoot,
          VSCODE_WORKSPACE_ROOT: this.workspaceRoot,
        }),
      };

      // Resolve MCP SDK from bundled copy if present, otherwise fall back to node_modules.
      const sdkBase =
        extensionPath &&
        (await fs.promises
          .stat(path.join(extensionPath, 'bundled', 'mcp-sdk'))
          .then(() => true)
          .catch(() => false))
          ? path.join(extensionPath, 'bundled', 'mcp-sdk')
          : null;

      const sdkStdioModule = sdkBase
        ? path.join(sdkBase, 'client', 'stdio.js')
        : '@modelcontextprotocol/sdk/client/stdio.js';
      const sdkClientModule = sdkBase
        ? path.join(sdkBase, 'client', 'index.js')
        : '@modelcontextprotocol/sdk/client/index.js';

      const { StdioClientTransport } = await import(sdkStdioModule);
      const { Client } = await import(sdkClientModule);

      this.transport = new StdioClientTransport({
        command: 'node',
        args: [mcpServerPath],
        env,
        stderr: 'inherit',
      });

      this.transport.onerror = (error: Error) => {
        this.logger.error('MCP transport error', error);
      };

      this.transport.onclose = () => {
        this.logger.warn('MCP transport closed');
        this.client = null;
        this.transport = null;
      };

      await this.transport.start();

      this.client = new Client(
        { name: 'caws-vscode-extension', version: '0.9.3' },
        {
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
            sampling: {},
            logging: {},
          },
        }
      );

      await this.client.connect(this.transport);
      this.logger.info('MCP client connected successfully');
    } catch (error) {
      this.logger.error('Failed to initialize MCP client', error);
      this.client = null;
      this.transport = null;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.initializeMcpClient();
    }
    await this.initPromise;
  }

  async callTool(toolName: string, parameters: any = {}): Promise<McpToolResult> {
    await this.ensureInitialized();

    if (this.client) {
      try {
        return await this.callMcpTool(toolName, parameters);
      } catch (error) {
        this.logger.warn('MCP tool call failed, falling back to CLI', error as Error);
      }
    }

    // Fall back to direct CLI calls
    return this.callCliTool(toolName, parameters);
  }

  private async callMcpTool(toolName: string, parameters: any): Promise<McpToolResult> {
    if (!this.client) {
      throw new Error('MCP client not available or not initialized');
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: parameters,
    });

    return {
      content: result.content ?? [],
      isError: result.isError,
    };
  }

  private async callCliTool(toolName: string, parameters: any): Promise<McpToolResult> {
    return new Promise((resolve, reject) => {
      const cawsCliPath = this.getCawsCliPath();
      const workingDir =
        parameters.workingDirectory ||
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
        process.cwd();

      let command: string;
      let args: string[] = [];

      // Handle bundled vs system CLI paths
      const isBundled = cawsCliPath.includes('bundled');
      const cliEntry = isBundled
        ? path.join(cawsCliPath, 'index.js')
        : path.join(cawsCliPath, 'dist', 'index.js');

      switch (toolName) {
        case 'caws_evaluate':
          command = cliEntry;
          args = ['agent', 'evaluate'];
          if (parameters.specFile && parameters.specFile !== '.caws/working-spec.yaml') {
            args.push(parameters.specFile);
          } else {
            args.push('--interactive-spec-selection');
          }
          break;

        case 'caws_iterate':
          command = cliEntry;
          args = [
            'iterate',
            '--current-state',
            JSON.stringify({ description: parameters.currentState }),
          ];
          if (parameters.specFile && parameters.specFile !== '.caws/working-spec.yaml') {
            args.push(parameters.specFile);
          } else {
            args.push('--interactive-spec-selection');
          }
          break;

        case 'caws_validate':
          command = cliEntry;
          args = ['validate'];
          if (parameters.specFile && parameters.specFile !== '.caws/working-spec.yaml') {
            args.push(parameters.specFile);
          } else {
            // Let CLI handle spec resolution automatically
            args.push('--interactive-spec-selection');
          }
          break;

        case 'caws_waiver_create':
          command = cliEntry;
          args = [
            'waivers',
            'create',
            `--title=${JSON.stringify(parameters.title)}`,
            `--reason=${parameters.reason}`,
            `--description=${JSON.stringify(parameters.description)}`,
            `--gates=${parameters.gates.join(',')}`,
            `--expires-at=${parameters.expiresAt}`,
            `--approved-by=${parameters.approvedBy}`,
            `--impact-level=${parameters.impactLevel}`,
            `--mitigation-plan=${JSON.stringify(parameters.mitigationPlan)}`,
          ];
          break;

        case 'caws_workflow_guidance':
          // MCP-only tool — not available via CLI fallback
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Workflow guidance not available via CLI fallback',
                }),
              },
            ],
            isError: true,
          });
          return;

        case 'caws_quality_monitor':
          // MCP-only tool — not available via CLI fallback
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'Quality monitoring not available via CLI fallback',
                }),
              },
            ],
            isError: true,
          });
          return;

        default:
          reject(new Error(`Unknown tool: ${toolName}`));
          return;
      }

      const _child = cp.execFile(command, args, { cwd: workingDir }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`CLI command failed: ${error.message}\n${stderr}`));
          return;
        }

        // Try to extract JSON from CLI output
        let resultText = stdout;

        // For agent commands, extract JSON from mixed output
        if (toolName.startsWith('caws_')) {
          const jsonMatch = stdout.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            resultText = jsonMatch[0];
          }
        }

        try {
          const result = JSON.parse(resultText);
          resolve({
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          });
        } catch (parseError) {
          // Return raw output if not JSON
          resolve({
            content: [
              {
                type: 'text',
                text: stdout,
              },
            ],
          });
        }
      });
    });
  }

  private getCawsCliPath(): string {
    // Try bundled CLI first
    const extensionPath = vscode.extensions.getExtension(
      'paths-design.caws-vscode-extension'
    )?.extensionPath;
    if (extensionPath) {
      const bundledCliPath = path.join(extensionPath, 'bundled', 'cli');
      if (fs.existsSync(path.join(bundledCliPath, 'index.js'))) {
        return bundledCliPath;
      }
    }

    // Fall back to system installation
    return this.getFallbackCliPath();
  }

  private getFallbackMcpPath(): string {
    // Try to find CAWS MCP server in system locations
    const possiblePaths = [
      // Global installation
      path.join(
        process.env.HOME || '',
        '.npm-global',
        'lib',
        'node_modules',
        '@caws',
        'mcp-server',
        'index.js'
      ),
      // Local node_modules
      path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        'node_modules',
        '@caws',
        'mcp-server',
        'index.js'
      ),
      // Monorepo packages
      path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        'packages',
        'caws-mcp-server',
        'index.js'
      ),
    ];

    for (const mcpPath of possiblePaths) {
      if (mcpPath && fs.existsSync(mcpPath)) {
        return mcpPath;
      }
    }

    // Default fallback
    return path.join(
      process.env.HOME || '',
      '.npm-global',
      'lib',
      'node_modules',
      '@caws',
      'mcp-server',
      'index.js'
    );
  }

  private getFallbackCliPath(): string {
    // Try to find CAWS CLI in various locations
    const possiblePaths = [
      // Global installation
      path.join(process.env.HOME || '', '.npm-global', 'lib', 'node_modules', '@caws', 'cli'),
      // Local node_modules
      path.join(
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
        'node_modules',
        '@caws',
        'cli'
      ),
      // Monorepo packages
      path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', 'packages', 'caws-cli'),
      // Configuration override
      vscode.workspace.getConfiguration('caws').get('cli.path') as string,
    ];

    for (const cliPath of possiblePaths) {
      if (cliPath && require('fs').existsSync(path.join(cliPath, 'dist', 'index.js'))) {
        return cliPath;
      }
    }

    // Default to assuming 'caws' is in PATH
    return 'caws';
  }

  dispose(): void {
    if (this.transport) {
      void this.transport.close().catch((error: Error) => {
        this.logger.warn('Failed to close MCP transport', error);
      });
      this.transport = null;
    }
    this.client = null;
  }
}
