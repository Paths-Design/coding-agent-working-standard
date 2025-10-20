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
  private mcpProcess: cp.ChildProcess | null = null;
  private requestId = 0;
  private logger = getLogger().createChild('McpClient');
  private pendingRequests = new Map<
    number,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  >();
  private initialized = false;

  constructor() {
    // Initialize MCP server asynchronously
    this.initializeMcpServer().catch((error) => {
      this.logger.error('Failed to initialize MCP server in constructor', error);
    });
  }

  private async initializeMcpServer(): Promise<void> {
    try {
      // Use bundled MCP server from extension
      const extensionPath = vscode.extensions.getExtension(
        'caws.caws-vscode-extension'
      )?.extensionPath;
      let mcpServerPath: string;

      if (extensionPath) {
        // Try bundled version first
        const bundledPath = path.join(extensionPath, 'bundled', 'mcp-server', 'index.js');
        if (fs.existsSync(bundledPath)) {
          mcpServerPath = bundledPath;
        } else {
          // Fall back to system installation
          mcpServerPath = this.getFallbackMcpPath();
        }
      } else {
        // No extension path, use fallback
        mcpServerPath = this.getFallbackMcpPath();
      }

      if (!fs.existsSync(mcpServerPath)) {
        throw new Error(
          'CAWS MCP server not found. Please ensure the extension is properly installed or install @caws/mcp-server globally.'
        );
      }

      // Start MCP server process
      this.mcpProcess = cp.spawn('node', [mcpServerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
      });

      // Set up MCP protocol handlers
      this.setupMcpProtocol();

      // Initialize MCP handshake
      await this.initializeMcpProtocol();
      this.initialized = true;

      this.logger.info('MCP server initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize MCP server', error);
      // Fall back to direct CLI calls
      this.mcpProcess = null;
    }
  }

  private setupMcpProtocol(): void {
    if (!this.mcpProcess) return;

    if (this.mcpProcess.stdout) {
      this.mcpProcess.stdout.on('data', (data) => {
        this.handleMcpResponse(data);
      });
    }

    if (this.mcpProcess.stderr) {
      this.mcpProcess.stderr.on('data', (data) => {
        this.logger.debug('MCP Server stderr', { data: data.toString() });
      });
    }

    this.mcpProcess.on('exit', (code) => {
      this.logger.info('MCP Server exited', { exitCode: code });
      this.mcpProcess = null;
    });
  }

  private async initializeMcpProtocol(): Promise<void> {
    return new Promise((resolve, reject) => {
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'caws-vscode-extension',
            version: '0.9.3',
          },
        },
      };

      const initHandler = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === 1) {
            if (this.mcpProcess?.stdout) {
              this.mcpProcess.stdout.removeListener('data', initHandler);
            }

            if (response.error) {
              reject(new Error(`MCP initialization failed: ${response.error.message}`));
            } else {
              // Send initialized notification
              const initializedNotification = {
                jsonrpc: '2.0',
                method: 'notifications/initialized',
              };
              this.mcpProcess?.stdin?.write(JSON.stringify(initializedNotification) + '\n');
              resolve();
            }
          }
        } catch (error) {
          // Continue listening for valid response
        }
      };

      if (this.mcpProcess?.stdout) {
        this.mcpProcess.stdout.on('data', initHandler);
      }

      // Send initialization request
      this.mcpProcess?.stdin?.write(JSON.stringify(initRequest) + '\n');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.mcpProcess?.stdout) {
          this.mcpProcess.stdout.removeListener('data', initHandler);
        }
        reject(new Error('MCP initialization timeout'));
      }, 10000);
    });
  }

  private handleMcpResponse(data: Buffer): void {
    try {
      const response = JSON.parse(data.toString());
      // Handle pending requests
      const pendingRequest = this.pendingRequests.get(response.id);
      if (pendingRequest) {
        this.pendingRequests.delete(response.id);
        clearTimeout(pendingRequest.timeout);

        if (response.error) {
          pendingRequest.reject(new Error(response.error.message));
        } else {
          pendingRequest.resolve(response.result);
        }
      }
    } catch (error) {
      this.logger.debug('Received non-JSON data from MCP server', { data: data.toString() });
    }
  }

  async callTool(toolName: string, parameters: any = {}): Promise<McpToolResult> {
    // Wait for MCP initialization (with timeout)
    if (!this.initialized) {
      await new Promise((resolve) => {
        const checkInit = () => {
          if (this.initialized || !this.mcpProcess) {
            resolve(void 0);
          } else {
            setTimeout(checkInit, 100);
          }
        };
        setTimeout(() => resolve(void 0), 5000); // 5 second timeout
        checkInit();
      });
    }

    if (this.mcpProcess && this.mcpProcess.stdin && this.initialized) {
      // Use MCP protocol
      return this.callMcpTool(toolName, parameters);
    } else {
      // Fall back to direct CLI calls
      return this.callCliTool(toolName, parameters);
    }
  }

  private async callMcpTool(toolName: string, parameters: any): Promise<McpToolResult> {
    return new Promise((resolve, reject) => {
      if (!this.mcpProcess || !this.mcpProcess.stdin || !this.initialized) {
        reject(new Error('MCP server not available or not initialized'));
        return;
      }

      const requestId = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: parameters,
        },
      };

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error('MCP request timeout'));
      }, 30000);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });

      // Send request
      this.mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    });
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
          args = ['agent', 'evaluate', parameters.specFile || '.caws/working-spec.yaml'];
          break;

        case 'caws_iterate':
          command = cliEntry;
          args = [
            'agent',
            'iterate',
            '--current-state',
            JSON.stringify({ description: parameters.currentState }),
            parameters.specFile || '.caws/working-spec.yaml',
          ];
          break;

        case 'caws_validate':
          command = cliEntry;
          args = ['validate', parameters.specFile || '.caws/working-spec.yaml'];
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
          // This would be implemented in the MCP server
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
          // This would be implemented in the MCP server
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
      'caws.caws-vscode-extension'
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
    if (this.mcpProcess) {
      this.mcpProcess.kill();
      this.mcpProcess = null;
    }
  }
}
