# Tutorial: Bundling and Loading MCP Server in VSCode Extension

This tutorial demonstrates how to bundle a Model Context Protocol (MCP) server and integrate it into a VSCode extension, based on the CAWS implementation.

## Overview

The process involves:

1. **Bundling**: Using esbuild to create a single-file bundle of the MCP server with all dependencies
2. **Integration**: Loading the bundled server as a child process in the VSCode extension
3. **Communication**: Implementing JSON-RPC protocol for tool calls

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    VSCode Extension                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │         Extension Activation (extension.ts)          │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │                                       │
│  ┌──────────────────▼───────────────────────────────────┐  │
│  │         MCP Client (mcp-client.ts)                    │  │
│  │  - Spawns bundled MCP server process                 │  │
│  │  - Handles JSON-RPC protocol                          │  │
│  │  - Manages request/response lifecycle                │  │
│  └──────────────────┬───────────────────────────────────┘  │
│                     │ stdio (stdin/stdout)                 │
└─────────────────────┼───────────────────────────────────────┘
                      │
                      ▼
        ┌─────────────────────────────┐
        │  Bundled MCP Server         │
        │  (bundled/mcp-server/       │
        │   index.js)                 │
        │  - Single file bundle       │
        │  - All dependencies included │
        │  - No node_modules needed   │
        └─────────────────────────────┘
```

## Step 1: Create Bundling Script

Create a script to bundle the MCP server using esbuild:

```javascript
// scripts/bundle-deps.js
#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_ROOT = path.resolve(__dirname, '..');
const MONOREPO_ROOT = path.resolve(EXTENSION_ROOT, '../..');
const BUNDLED_DIR = path.join(EXTENSION_ROOT, 'bundled');

async function bundleMcpServer() {
  console.log('Bundling MCP server with esbuild...');

  const mcpServerSource = path.join(MONOREPO_ROOT, 'packages/caws-mcp-server');
  const mcpServerDest = path.join(BUNDLED_DIR, 'mcp-server');

  await fs.ensureDir(mcpServerDest);

  // Check if esbuild is available
  try {
    execSync('npx esbuild --version', { stdio: 'pipe' });
  } catch (error) {
    console.log('  Installing esbuild...');
    execSync('npm install --save-dev esbuild', {
      cwd: EXTENSION_ROOT,
      stdio: 'inherit'
    });
  }

  // Bundle MCP server entry point with all dependencies
  const mcpServerEntry = path.join(mcpServerSource, 'index.js');
  const mcpServerBundle = path.join(mcpServerDest, 'index.js');

  console.log('  Bundling MCP server dependencies...');
  try {
    // Bundle as ES module for Node.js
    execSync(
      `npx esbuild "${mcpServerEntry}" --bundle --platform=node --target=node18 --format=esm --outfile="${mcpServerBundle}" --external:@paths.design/caws-cli --external:@paths.design/quality-gates`,
      { stdio: 'inherit', cwd: EXTENSION_ROOT }
    );

    // Remove shebang if present (causes syntax errors in ES modules)
    let bundledContent = await fs.readFile(mcpServerBundle, 'utf8');
    if (bundledContent.startsWith('#!/usr/bin/env node')) {
      bundledContent = bundledContent.replace(/^#!\/usr\/bin\/env node\n?/, '');
    }
    await fs.writeFile(mcpServerBundle, bundledContent);

    console.log('  ✅ Bundled MCP server (single file)');
  } catch (error) {
    console.error('  ❌ Failed to bundle MCP server:', error.message);
    throw error;
  }

  // Copy minimal package.json (just for version info)
  const mcpServerPackageJson = require(path.join(mcpServerSource, 'package.json'));
  const minimalMcpPackageJson = {
    name: mcpServerPackageJson.name,
    version: mcpServerPackageJson.version,
    description: mcpServerPackageJson.description,
    type: 'module',
  };
  await fs.writeJSON(path.join(mcpServerDest, 'package.json'), minimalMcpPackageJson, {
    spaces: 2,
  });

  console.log('✅ Bundled MCP server\n');
}

async function main() {
  console.log('Starting dependency bundling...\n');

  try {
    // Clean bundled directory
    await fs.remove(BUNDLED_DIR);
    await fs.ensureDir(BUNDLED_DIR);

    // Bundle MCP server
    await bundleMcpServer();

    // Create bundle info file
    const bundledInfo = {
      bundledAt: new Date().toISOString(),
      mcpServer: {
        version: require(path.join(MONOREPO_ROOT, 'packages/caws-mcp-server/package.json')).version,
        path: 'bundled/mcp-server',
      },
    };

    await fs.writeJSON(path.join(BUNDLED_DIR, 'bundle-info.json'), bundledInfo, { spaces: 2 });
    console.log('✅ Bundling complete!');
  } catch (error) {
    console.error('❌ Bundling failed:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
```

## Step 2: Update package.json Scripts

Add bundling to your extension's build process:

```json
{
  "scripts": {
    "build": "npm run bundle-deps && npm run compile",
    "vscode:prepublish": "npm run bundle-deps && npm run compile",
    "bundle-deps": "node scripts/bundle-deps.js",
    "compile": "tsc -p ./"
  }
}
```

## Step 3: Create MCP Client

Implement an MCP client that spawns and communicates with the bundled server:

```typescript
// src/mcp-client.ts
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

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
  private pendingRequests = new Map<
    number,
    { resolve: Function; reject: Function; timeout: NodeJS.Timeout }
  >();
  private initialized = false;

  constructor() {
    this.initializeMcpServer().catch((error) => {
      console.error('Failed to initialize MCP server', error);
    });
  }

  private async initializeMcpServer(): Promise<void> {
    try {
      // Get extension path
      const extensionPath = vscode.extensions.getExtension(
        'paths-design.caws-vscode-extension'
      )?.extensionPath;

      if (!extensionPath) {
        throw new Error('Extension path not found');
      }

      // Use bundled MCP server
      const bundledPath = path.join(extensionPath, 'bundled', 'mcp-server', 'index.js');

      if (!fs.existsSync(bundledPath)) {
        throw new Error('CAWS MCP server not found. Please rebuild the extension.');
      }

      // Start MCP server process
      this.mcpProcess = cp.spawn('node', [bundledPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(),
        env: {
          ...process.env,
          VSCODE_EXTENSION_PATH: extensionPath,
          VSCODE_EXTENSION_DIR: extensionPath,
        },
      });

      // Set up MCP protocol handlers
      this.setupMcpProtocol();

      // Initialize MCP handshake
      await this.initializeMcpProtocol();
      this.initialized = true;

      console.log('MCP server initialized successfully');
    } catch (error) {
      console.error('Failed to initialize MCP server', error);
      this.mcpProcess = null;
    }
  }

  private setupMcpProtocol(): void {
    if (!this.mcpProcess) return;

    // Handle stdout (MCP responses)
    if (this.mcpProcess.stdout) {
      this.mcpProcess.stdout.on('data', (data) => {
        this.handleMcpResponse(data);
      });
    }

    // Handle stderr (debug logs)
    if (this.mcpProcess.stderr) {
      this.mcpProcess.stderr.on('data', (data) => {
        console.debug('MCP Server stderr', data.toString());
      });
    }

    // Handle process exit
    this.mcpProcess.on('exit', (code) => {
      console.log('MCP Server exited', { exitCode: code });
      this.mcpProcess = null;
      this.initialized = false;
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
            version: '1.0.0',
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
      console.debug('Received non-JSON data from MCP server', data.toString());
    }
  }

  async callTool(toolName: string, parameters: any = {}): Promise<McpToolResult> {
    // Wait for MCP initialization
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
      return this.callMcpTool(toolName, parameters);
    } else {
      throw new Error('MCP server not available or not initialized');
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

  dispose(): void {
    if (this.mcpProcess) {
      this.mcpProcess.kill();
      this.mcpProcess = null;
    }
  }
}
```

## Step 4: Integrate in Extension

Use the MCP client in your extension activation:

```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { CawsMcpClient } from './mcp-client';

let mcpClient: CawsMcpClient;

export function activate(context: vscode.ExtensionContext) {
  // Initialize MCP client
  mcpClient = new CawsMcpClient();

  // Register commands that use MCP tools
  context.subscriptions.push(
    vscode.commands.registerCommand('caws.validate', async () => {
      try {
        const result = await mcpClient.callTool('caws_validate', {
          specFile: '.caws/working-spec.yaml',
        });

        if (result.content && result.content[0]) {
          const output = result.content[0].text;
          const outputChannel = vscode.window.createOutputChannel('CAWS Validation');
          outputChannel.clear();
          outputChannel.append(output);
          outputChannel.show();
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`CAWS validation failed: ${error.message}`);
      }
    })
  );

  // Clean up on deactivation
  context.subscriptions.push({
    dispose: () => {
      if (mcpClient) {
        mcpClient.dispose();
      }
    },
  });
}

export function deactivate() {
  if (mcpClient) {
    mcpClient.dispose();
  }
}
```

## Step 5: Key Considerations

### External Dependencies

When bundling, mark peer dependencies as external to avoid bundling them:

```javascript
--external:@paths.design/caws-cli --external:@paths.design/quality-gates
```

These will be resolved at runtime from the extension's bundled dependencies or system installation.

### Shebang Removal

MCP servers often have shebangs (`#!/usr/bin/env node`), which cause syntax errors when loaded as ES modules. Remove them after bundling:

```javascript
let bundledContent = await fs.readFile(mcpServerBundle, 'utf8');
if (bundledContent.startsWith('#!/usr/bin/env node')) {
  bundledContent = bundledContent.replace(/^#!\/usr\/bin\/env node\n?/, '');
}
await fs.writeFile(mcpServerBundle, bundledContent);
```

### Environment Variables

Pass extension context to the MCP server via environment variables:

```typescript
this.mcpProcess = cp.spawn('node', [bundledPath], {
  env: {
    ...process.env,
    VSCODE_EXTENSION_PATH: extensionPath,
    VSCODE_EXTENSION_DIR: extensionPath,
    CURSOR_WORKSPACE_ROOT: workspaceRoot,
    VSCODE_WORKSPACE_ROOT: workspaceRoot,
  },
});
```

### Error Handling

Implement robust error handling for:

- MCP server startup failures
- Communication timeouts
- Process crashes
- Invalid responses

### Path Resolution

The bundled MCP server needs to resolve paths relative to the extension bundle:

```javascript
// In MCP server code
const extensionPath = process.env.VSCODE_EXTENSION_PATH || process.env.VSCODE_EXTENSION_DIR;
const bundledPath = path.join(extensionPath, 'bundled', 'quality-gates', 'run-quality-gates.mjs');
```

## Step 6: Testing

Test the bundled MCP server:

1. **Build the extension**:

   ```bash
   npm run build
   ```

2. **Verify bundle exists**:

   ```bash
   ls -la bundled/mcp-server/index.js
   ```

3. **Test in development**:
   - Press F5 in VSCode to launch extension development host
   - Execute a command that uses the MCP client
   - Check output channel for errors

4. **Package and test**:
   ```bash
   npm run package
   vsce install caws-vscode-extension-*.vsix
   ```

## Troubleshooting

### MCP Server Not Found

**Problem**: `CAWS MCP server not found`

**Solution**:

- Run `npm run bundle-deps` to create the bundle
- Verify `bundled/mcp-server/index.js` exists
- Check extension path is correct

### Initialization Timeout

**Problem**: `MCP initialization timeout`

**Solution**:

- Check MCP server starts correctly (no syntax errors)
- Verify stdio communication is working
- Increase timeout if server takes longer to start

### JSON-RPC Errors

**Problem**: Invalid JSON responses

**Solution**:

- Ensure MCP server strips ANSI codes from output
- Verify JSON responses are properly formatted
- Check for stdout pollution (console.logs, etc.)

### Process Crashes

**Problem**: MCP server process exits unexpectedly

**Solution**:

- Check stderr for error messages
- Verify all dependencies are bundled correctly
- Test MCP server standalone first

## Best Practices

1. **Bundle Size**: Keep bundle size reasonable by externalizing large dependencies
2. **Error Recovery**: Implement automatic restart for crashed MCP servers
3. **Logging**: Use structured logging for debugging
4. **Versioning**: Track bundled versions in `bundle-info.json`
5. **Testing**: Test bundled server in isolation before integration

## Summary

Bundling an MCP server for VSCode extension involves:

1. Creating a bundling script using esbuild
2. Bundling MCP server as a single ES module file
3. Removing shebangs and cleaning up output
4. Implementing MCP client with JSON-RPC protocol
5. Spawning bundled server as child process
6. Handling initialization and communication
7. Proper error handling and cleanup

This approach provides a self-contained extension that doesn't require external MCP server installation, making distribution and usage simpler for end users.
