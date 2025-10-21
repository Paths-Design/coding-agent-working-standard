import * as vscode from 'vscode';
import { disposeLogger, getLogger, initializeLogger } from './logger';
import { CawsMcpClient } from './mcp-client';
import { CawsProvenancePanel } from './provenance-panel';
import { CawsQualityMonitor } from './quality-monitor';
import { CawsStatusBar } from './status-bar';
import { CawsWebviewProvider } from './webview-provider';

let mcpClient: CawsMcpClient;
let qualityMonitor: CawsQualityMonitor;
let statusBar: CawsStatusBar;
let webviewProvider: CawsWebviewProvider;

export function activate(context: vscode.ExtensionContext) {
  // Initialize structured logging
  const logger = initializeLogger('CAWS Extension');
  logger.info('CAWS VS Code extension activated');

  // Initialize MCP server first - it will auto-start
  mcpClient = new CawsMcpClient();

  // Register MCP server with Cursor if in Cursor environment
  registerMcpServerWithCursor(context);

  // Initialize other components
  qualityMonitor = new CawsQualityMonitor(mcpClient);
  statusBar = new CawsStatusBar();
  webviewProvider = new CawsWebviewProvider(context.extensionUri);

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cawsQualityDashboard', webviewProvider)
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('caws.init', async () => {
      await runCawsInit();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.scaffold', async () => {
      await runCawsScaffold();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.evaluate', async () => {
      await runCawsEvaluation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.iterate', async () => {
      await runCawsIteration();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.validate', async () => {
      await runCawsValidation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.createWaiver', async () => {
      await createWaiver();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.showDashboard', async () => {
      await showQualityDashboard();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.hooksInstall', async () => {
      await installHooks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.hooksStatus', async () => {
      await checkHooksStatus();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.showProvenance', async () => {
      CawsProvenancePanel.createOrShow(context.extensionUri, mcpClient);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.specsList', async () => {
      await runCawsSpecsList();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.specsCreate', async () => {
      await runCawsSpecsCreate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('caws.specsShow', async () => {
      await runCawsSpecsShow();
    })
  );

  // Register code action provider
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new CawsCodeActionProvider())
  );

  // Set up file watchers for real-time validation
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');
  watcher.onDidChange(async (uri) => {
    if (getConfiguration('autoValidate')) {
      await qualityMonitor.onFileChanged(uri);
    }
  });

  context.subscriptions.push(watcher);

  // Initialize status bar
  statusBar.initialize(context);
  updateQualityStatus();

  // Set up periodic quality updates
  const qualityUpdateInterval = setInterval(updateQualityStatus, 30000); // Every 30 seconds
  context.subscriptions.push({ dispose: () => clearInterval(qualityUpdateInterval) });

  // Register completion provider for CAWS commands
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider('*', {
      provideCompletionItems(document, position) {
        const line = document.lineAt(position.line).text.substring(0, position.character);

        if (line.endsWith('caws ')) {
          return [
            new vscode.CompletionItem('evaluate', vscode.CompletionItemKind.Function),
            new vscode.CompletionItem('iterate', vscode.CompletionItemKind.Function),
            new vscode.CompletionItem('validate', vscode.CompletionItemKind.Function),
            new vscode.CompletionItem('waivers', vscode.CompletionItemKind.Module),
            new vscode.CompletionItem('cicd', vscode.CompletionItemKind.Module),
            new vscode.CompletionItem('experimental', vscode.CompletionItemKind.Module),
          ];
        }

        return [];
      },
    })
  );
}

export function deactivate() {
  const logger = getLogger();
  logger.info('CAWS VS Code extension deactivated');

  // Clean up MCP client
  if (mcpClient) {
    mcpClient.dispose();
  }

  // Dispose logger
  disposeLogger();
}

/**
 * Register CAWS MCP server with Cursor IDE
 * This makes CAWS tools available to Cursor's AI features automatically
 */
async function registerMcpServerWithCursor(context: vscode.ExtensionContext): Promise<void> {
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');

    // Get bundled MCP server path
    const mcpServerPath = path.join(context.extensionPath, 'bundled', 'mcp-server', 'index.js');

    if (!fs.existsSync(mcpServerPath)) {
      getLogger().warn('CAWS MCP server not found in bundle, skipping auto-registration');
      return;
    }

    // Cursor MCP configuration path (similar to VS Code settings)
    const cursorConfigDir = path.join(os.homedir(), '.cursor');
    const mcpConfigPath = path.join(cursorConfigDir, 'mcp.json');

    // Create config directory if it doesn't exist
    if (!fs.existsSync(cursorConfigDir)) {
      fs.mkdirSync(cursorConfigDir, { recursive: true });
    }

    // Read existing MCP config or create new one
    let mcpConfig: any = { mcpServers: {} };
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const configContent = fs.readFileSync(mcpConfigPath, 'utf8');
        mcpConfig = JSON.parse(configContent);
      } catch (error) {
        getLogger().warn('Failed to parse existing MCP config, will create new one', error);
      }
    }

    // Ensure mcpServers object exists
    if (!mcpConfig.mcpServers) {
      mcpConfig.mcpServers = {};
    }

    // Register CAWS MCP server
    mcpConfig.mcpServers.caws = {
      command: 'node',
      args: [mcpServerPath],
      env: {},
      disabled: false,
      alwaysAllow: [],
    };

    // Write updated config
    fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    getLogger().info('CAWS MCP server registered with Cursor', { configPath: mcpConfigPath });

    // Show notification to user
    vscode.window
      .showInformationMessage(
        'CAWS MCP server is now available to Cursor AI! Restart Cursor to activate all 13 CAWS tools.',
        'Open MCP Config'
      )
      .then((selection) => {
        if (selection === 'Open MCP Config') {
          vscode.workspace.openTextDocument(mcpConfigPath).then((doc) => {
            vscode.window.showTextDocument(doc);
          });
        }
      });
  } catch (error) {
    getLogger().error('Failed to register CAWS MCP server with Cursor', error);
    // Don't show error to user - this is a nice-to-have feature
  }
}

async function runCawsInit(): Promise<void> {
  try {
    const projectName = await vscode.window.showInputBox({
      prompt: 'Enter project name (use "." for current directory)',
      placeHolder: '.',
      value: '.',
    });

    if (!projectName) return;

    const templates = ['extension', 'library', 'api', 'cli', 'none'];
    const template = await vscode.window.showQuickPick(templates, {
      placeHolder: 'Select project template (or none for manual setup)',
    });

    if (!template) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CAWS Initialization',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Initializing CAWS project...' });

        const result = await mcpClient.callTool('caws_init', {
          projectName,
          template: template === 'none' ? undefined : template,
          interactive: false,
        });

        if (!result.content || !result.content[0]) {
          throw new Error('Invalid init result: missing content');
        }
        const initResult = JSON.parse(result.content[0].text);

        if (initResult.success) {
          vscode.window.showInformationMessage(
            `CAWS initialized successfully: ${initResult.projectName}`
          );

          // Refresh workspace
          const workspaceFolders = vscode.workspace.workspaceFolders;
          if (workspaceFolders?.[0]) {
            const specUri = vscode.Uri.joinPath(
              workspaceFolders[0].uri,
              '.caws',
              'working-spec.yaml'
            );
            await vscode.window.showTextDocument(specUri);
          }
        } else {
          vscode.window.showErrorMessage(`CAWS init failed: ${initResult.error}`);
        }
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`CAWS init failed: ${error}`);
  }
}

async function runCawsScaffold(): Promise<void> {
  try {
    const options = await vscode.window.showQuickPick(
      [
        { label: 'Full Setup', value: 'full' },
        { label: 'Minimal Setup', value: 'minimal' },
        { label: 'With Codemods', value: 'codemods' },
        { label: 'With OIDC', value: 'oidc' },
      ],
      {
        placeHolder: 'Select scaffolding options',
        canPickMany: false,
      }
    );

    if (!options) return;

    const force = await vscode.window.showQuickPick(['No', 'Yes'], {
      placeHolder: 'Overwrite existing files?',
    });

    if (!force) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CAWS Scaffold',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Scaffolding CAWS components...' });

        const result = await mcpClient.callTool('caws_scaffold', {
          minimal: options.value === 'minimal',
          withCodemods: options.value === 'codemods',
          withOIDC: options.value === 'oidc',
          force: force === 'Yes',
        });

        if (!result.content || !result.content[0]) {
          throw new Error('Invalid scaffold result: missing content');
        }
        const scaffoldResult = JSON.parse(result.content[0].text);

        if (scaffoldResult.success) {
          vscode.window.showInformationMessage('CAWS components scaffolded successfully');
        } else {
          vscode.window.showErrorMessage(`CAWS scaffold failed: ${scaffoldResult.error}`);
        }
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`CAWS scaffold failed: ${error}`);
  }
}

async function installHooks(): Promise<void> {
  try {
    const backup = await vscode.window.showQuickPick(['Yes', 'No'], {
      placeHolder: 'Backup existing hooks before installing?',
    });

    if (!backup) return;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CAWS Hooks',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Installing git hooks...' });

        const result = await mcpClient.callTool('caws_hooks', {
          subcommand: 'install',
          backup: backup === 'Yes',
          force: false,
        });

        if (!result.content || !result.content[0]) {
          throw new Error('Invalid hooks result: missing content');
        }
        const hooksResult = JSON.parse(result.content[0].text);

        if (hooksResult.success) {
          vscode.window.showInformationMessage('CAWS git hooks installed successfully');
        } else {
          vscode.window.showErrorMessage(`Hooks installation failed: ${hooksResult.error}`);
        }
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Hooks installation failed: ${error}`);
  }
}

async function checkHooksStatus(): Promise<void> {
  try {
    const result = await mcpClient.callTool('caws_hooks', {
      subcommand: 'status',
    });

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid hooks status result: missing content');
    }
    const statusResult = JSON.parse(result.content[0].text);

    const outputChannel = vscode.window.createOutputChannel('CAWS Hooks Status');
    outputChannel.clear();
    outputChannel.append(statusResult.output);
    outputChannel.show();
  } catch (error) {
    vscode.window.showErrorMessage(`Hooks status check failed: ${error}`);
  }
}

async function runCawsEvaluation(): Promise<void> {
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'CAWS Evaluation',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: 'Running quality evaluation...' });

        const result = await mcpClient.callTool('caws_evaluate', {
          specFile: '.caws/working-spec.yaml',
        });

        if (!result.content || !result.content[0]) {
          throw new Error('Invalid evaluation result: missing content');
        }
        const evaluation = JSON.parse(result.content[0].text);

        if (evaluation.success) {
          const status = evaluation.evaluation.overall_status;
          const score = evaluation.evaluation.quality_score;

          const message = `CAWS Evaluation: ${status.replace('_', ' ').toUpperCase()} (${(score * 100).toFixed(1)}%)`;

          if (status === 'quality_passed') {
            vscode.window.showInformationMessage(message);
          } else {
            vscode.window.showWarningMessage(message, 'View Details').then((selection) => {
              if (selection === 'View Details') {
                showEvaluationDetails(evaluation);
              }
            });
          }
        } else {
          vscode.window.showErrorMessage(
            `CAWS Evaluation Failed: ${evaluation.error || 'Unknown error'}`
          );
        }

        updateQualityStatus();
      }
    );
  } catch (error) {
    vscode.window.showErrorMessage(`CAWS evaluation failed: ${error}`);
  }
}

async function runCawsIteration(): Promise<void> {
  try {
    const currentState = await vscode.window.showInputBox({
      prompt: 'Describe your current implementation state',
      placeHolder: 'e.g., "Started core implementation" or "Added basic error handling"',
    });

    if (!currentState) return;

    const result = await mcpClient.callTool('caws_iterate', {
      specFile: '.caws/working-spec.yaml',
      currentState,
    });

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid iteration result: missing content');
    }
    const guidance = JSON.parse(result.content[0].text);

    if (guidance.success) {
      showIterativeGuidance(guidance.iteration);
    } else {
      vscode.window.showErrorMessage(`CAWS guidance failed: ${guidance.error || 'Unknown error'}`);
    }
  } catch (error) {
    vscode.window.showErrorMessage(`CAWS iteration guidance failed: ${error}`);
  }
}

/**
 * Get available CAWS specs
 */
async function getAvailableSpecs(): Promise<
  Array<{ id: string; path: string; type: string; title: string }>
> {
  try {
    const result = await mcpClient.callTool('caws_specs_list', {});
    if (result.content && result.content[0]) {
      return JSON.parse(result.content[0].text);
    }
  } catch (error) {
    // Fallback to legacy spec if available
  }
  return [];
}

/**
 * Select a spec for command execution
 */
async function selectSpecForCommand(
  specs: Array<{ id: string; path: string; type: string; title: string }>
): Promise<{ id: string; path: string; type: string; title: string } | null> {
  if (specs.length === 0) {
    return null;
  }

  if (specs.length === 1) {
    return specs[0];
  }

  // Multiple specs - show quick pick
  const items = specs.map((spec) => ({
    label: `${spec.id} (${spec.type})`,
    description: spec.title,
    detail: spec.path,
    spec: spec,
  }));

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a CAWS spec to validate',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return selected ? selected.spec : null;
}

/**
 * List all available CAWS specs
 */
async function runCawsSpecsList(): Promise<void> {
  try {
    const result = await mcpClient.callTool('caws_specs_list', {});

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid specs list result: missing content');
    }

    const specs = JSON.parse(result.content[0].text);

    if (specs.length === 0) {
      vscode.window.showInformationMessage(
        'No CAWS specs found. Create one with "CAWS: Create Spec"'
      );
      return;
    }

    const outputChannel = vscode.window.createOutputChannel('CAWS Specs');
    outputChannel.clear();
    outputChannel.append('📋 Available CAWS Specs\n');
    outputChannel.append(
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
    );

    specs.forEach((spec: any, index: number) => {
      outputChannel.append(`${index + 1}. ${spec.id} (${spec.type})\n`);
      outputChannel.append(`   Title: ${spec.title}\n`);
      outputChannel.append(`   Path: ${spec.path}\n`);
      outputChannel.append('\n');
    });

    outputChannel.show();
    vscode.window.showInformationMessage(`Found ${specs.length} CAWS specs - check output channel`);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to list specs: ${error}`);
  }
}

/**
 * Create a new CAWS spec
 */
async function runCawsSpecsCreate(): Promise<void> {
  try {
    const specId = await vscode.window.showInputBox({
      prompt: 'Enter spec ID (e.g., user-auth, payment-system)',
      placeHolder: 'my-feature',
      validateInput: (value) => {
        if (!value) return 'Spec ID is required';
        if (!/^[a-z0-9-]+$/.test(value))
          return 'Spec ID must contain only lowercase letters, numbers, and hyphens';
        return null;
      },
    });

    if (!specId) return;

    const title = await vscode.window.showInputBox({
      prompt: 'Enter spec title',
      placeHolder: 'My Feature Description',
      validateInput: (value) => {
        if (!value || value.length < 10) return 'Title must be at least 10 characters';
        return null;
      },
    });

    if (!title) return;

    const result = await mcpClient.callTool('caws_specs_create', {
      id: specId,
      title: title,
      type: 'feature',
    });

    if (result.content && result.content[0]) {
      vscode.window.showInformationMessage(`Created spec: ${specId}`);
      runCawsSpecsList(); // Refresh the list
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create spec: ${error}`);
  }
}

/**
 * Show details of a specific spec
 */
async function runCawsSpecsShow(): Promise<void> {
  try {
    const specs = await getAvailableSpecs();

    if (specs.length === 0) {
      vscode.window.showInformationMessage('No specs available');
      return;
    }

    const selectedSpec = await selectSpecForCommand(specs);
    if (!selectedSpec) return;

    // For now, just show the spec path - in a full implementation,
    // we'd read and display the full spec content
    vscode.window.showInformationMessage(
      `Spec: ${selectedSpec.id}\nPath: ${selectedSpec.path}\nTitle: ${selectedSpec.title}`
    );

    // TODO: Read and display full spec content in a webview or output channel
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to show spec: ${error}`);
  }
}

async function runCawsValidation(): Promise<void> {
  try {
    // Check if multiple specs exist and prompt for selection if needed
    const specs = await getAvailableSpecs();
    let specFile = '.caws/working-spec.yaml';

    if (specs.length > 1) {
      // Multiple specs exist - use spec resolution logic
      const selectedSpec = await selectSpecForCommand(specs);
      if (selectedSpec) {
        specFile = selectedSpec.path;
      }
    }

    const result = await mcpClient.callTool('caws_validate', {
      specFile: specFile,
    });

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid validation result: missing content');
    }
    const output = result.content[0].text;

    // Show validation results in output channel
    const outputChannel = vscode.window.createOutputChannel('CAWS Validation');
    outputChannel.clear();
    outputChannel.append(output);
    outputChannel.show();

    vscode.window.showInformationMessage('CAWS validation completed - check output channel');
  } catch (error) {
    vscode.window.showErrorMessage(`CAWS validation failed: ${error}`);
  }
}

async function createWaiver(): Promise<void> {
  const waiverData = await collectWaiverData();
  if (!waiverData) return;

  try {
    const result = await mcpClient.callTool('caws_waiver_create', waiverData);

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid waiver creation result: missing content');
    }
    const output = result.content[0].text;
    vscode.window.showInformationMessage('CAWS waiver created successfully');

    // Show waiver details in output channel
    const outputChannel = vscode.window.createOutputChannel('CAWS Waiver');
    outputChannel.clear();
    outputChannel.append(output);
    outputChannel.show();
  } catch (error) {
    vscode.window.showErrorMessage(`Waiver creation failed: ${error}`);
  }
}

async function showQualityDashboard(): Promise<void> {
  // Focus on the CAWS dashboard webview
  await vscode.commands.executeCommand('workbench.view.extension.caws-quality-dashboard');
}

async function collectWaiverData(): Promise<any | null> {
  const title = await vscode.window.showInputBox({
    prompt: 'Waiver title',
    placeHolder: 'e.g., Emergency security fix deployment',
  });
  if (!title) return null;

  const reason = await vscode.window.showQuickPick(
    [
      'emergency_hotfix',
      'legacy_integration',
      'experimental_feature',
      'third_party_constraint',
      'performance_critical',
      'security_patch',
      'infrastructure_limitation',
      'other',
    ],
    { placeHolder: 'Select waiver reason' }
  );
  if (!reason) return null;

  const description = await vscode.window.showInputBox({
    prompt: 'Detailed description',
    placeHolder: 'Explain why this waiver is needed...',
  });
  if (!description) return null;

  const gatesInput = await vscode.window.showInputBox({
    prompt: 'Quality gates to waive (comma-separated)',
    placeHolder: 'e.g., coverage_threshold,contract_compliance',
  });
  if (!gatesInput) return null;

  const expiresAt = await vscode.window.showInputBox({
    prompt: 'Expiration date (ISO 8601)',
    placeHolder: 'e.g., 2025-11-01T00:00:00Z',
  });
  if (!expiresAt) return null;

  const approvedBy = await vscode.window.showInputBox({
    prompt: 'Approved by',
    placeHolder: 'Your name or team name',
  });
  if (!approvedBy) return null;

  const impactLevel = await vscode.window.showQuickPick(['low', 'medium', 'high', 'critical'], {
    placeHolder: 'Select risk impact level',
  });
  if (!impactLevel) return null;

  const mitigationPlan = await vscode.window.showInputBox({
    prompt: 'Risk mitigation plan',
    placeHolder: 'How will you address the waived quality concerns?',
  });
  if (!mitigationPlan) return null;

  return {
    title,
    reason,
    description,
    gates: gatesInput.split(',').map((g: string) => g.trim()),
    expiresAt,
    approvedBy,
    impactLevel,
    mitigationPlan,
  };
}

function showEvaluationDetails(evaluation: any): void {
  const panel = vscode.window.createWebviewPanel(
    'cawsEvaluation',
    'CAWS Evaluation Results',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = generateEvaluationHtml(evaluation);
}

function showIterativeGuidance(guidance: any): void {
  const panel = vscode.window.createWebviewPanel(
    'cawsGuidance',
    'CAWS Iterative Guidance',
    vscode.ViewColumn.One,
    {}
  );

  panel.webview.html = generateGuidanceHtml(guidance);
}

function generateEvaluationHtml(evaluation: any): string {
  const criteriaHtml = evaluation.evaluation.criteria
    .map(
      (c: any) =>
        `<div class="criterion ${c.status}">
      <strong>${c.name}</strong>: ${c.feedback}
      <span class="score">${(c.score * 100).toFixed(1)}%</span>
    </div>`
    )
    .join('');

  const nextActionsHtml =
    evaluation.evaluation.next_actions?.map((action: string) => `<li>${action}</li>`).join('') ||
    '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CAWS Evaluation Results</title>
      <style>
        body { font-family: var(--vscode-font-family); padding: 20px; }
        .status { font-size: 1.2em; font-weight: bold; margin-bottom: 20px; }
        .status.quality_passed { color: var(--vscode-charts-green); }
        .status.quality_failed { color: var(--vscode-charts-red); }
        .score { font-size: 1.5em; margin: 10px 0; }
        .criteria { margin: 20px 0; }
        .criterion { margin: 10px 0; padding: 10px; border-radius: 4px; }
        .criterion.passed { background: var(--vscode-charts-green); opacity: 0.1; }
        .criterion.failed { background: var(--vscode-charts-red); opacity: 0.1; }
        .criterion.waived { background: var(--vscode-charts-yellow); opacity: 0.1; }
        .actions { margin-top: 20px; }
        .actions ul { padding-left: 20px; }
      </style>
    </head>
    <body>
      <h1>CAWS Quality Evaluation</h1>
      <div class="status ${evaluation.evaluation.overall_status}">
        ${evaluation.evaluation.overall_status.replace('_', ' ').toUpperCase()}
      </div>
      <div class="score">
        Quality Score: ${(evaluation.evaluation.quality_score * 100).toFixed(1)}%
      </div>

      <div class="criteria">
        <h3>Quality Criteria</h3>
        ${criteriaHtml}
      </div>

      <div class="actions">
        <h3>Next Actions</h3>
        <ul>${nextActionsHtml}</ul>
      </div>
    </body>
    </html>
  `;
}

function generateGuidanceHtml(guidance: any): string {
  const stepsHtml =
    guidance.next_steps
      ?.map((step: string, i: number) => `<li><strong>${i + 1}.</strong> ${step}</li>`)
      .join('') || '';

  const focusAreasHtml =
    guidance.focus_areas
      ?.map((area: string) => `<span class="focus-area">${area}</span>`)
      .join('') || '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>CAWS Iterative Guidance</title>
      <style>
        body { font-family: var(--vscode-font-family); padding: 20px; }
        .guidance { font-size: 1.1em; margin: 20px 0; padding: 15px; background: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textLink-foreground); }
        .confidence { margin: 15px 0; font-weight: bold; }
        .confidence.high { color: var(--vscode-charts-green); }
        .confidence.medium { color: var(--vscode-charts-yellow); }
        .confidence.low { color: var(--vscode-charts-red); }
        .steps { margin: 20px 0; }
        .steps ul { padding-left: 20px; }
        .focus-areas { margin: 20px 0; }
        .focus-area { display: inline-block; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); padding: 4px 8px; margin: 2px; border-radius: 12px; font-size: 0.9em; }
      </style>
    </head>
    <body>
      <h1>CAWS Iterative Guidance</h1>

      <div class="guidance">
        ${guidance.guidance}
      </div>

      <div class="confidence ${guidance.confidence > 0.7 ? 'high' : guidance.confidence > 0.4 ? 'medium' : 'low'}">
        Confidence: ${(guidance.confidence * 100).toFixed(0)}%
      </div>

      <div class="steps">
        <h3>Recommended Next Steps</h3>
        <ul>${stepsHtml}</ul>
      </div>

      <div class="focus-areas">
        <h3>Focus Areas</h3>
        ${focusAreasHtml}
      </div>
    </body>
    </html>
  `;
}

async function updateQualityStatus(): Promise<void> {
  try {
    const result = await mcpClient.callTool('caws_evaluate', {
      specFile: '.caws/working-spec.yaml',
    });

    if (!result.content || !result.content[0]) {
      throw new Error('Invalid quality evaluation result: missing content');
    }
    const evaluation = JSON.parse(result.content[0].text);

    if (evaluation.success) {
      const score = evaluation.evaluation.quality_score;
      const status = evaluation.evaluation.overall_status;

      statusBar.updateStatus(score, status);
    }
  } catch (error) {
    // Silently fail status updates
  }
}

function getConfiguration(key: string): any {
  return vscode.workspace.getConfiguration('caws').get(key);
}

class CawsCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(_document: vscode.TextDocument, _range: vscode.Range): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // Suggest CAWS validation after code changes
    const validateAction = new vscode.CodeAction(
      'Validate with CAWS',
      vscode.CodeActionKind.QuickFix
    );
    validateAction.command = {
      command: 'caws.evaluate',
      title: 'Run CAWS validation',
      arguments: [],
    };
    actions.push(validateAction);

    // Suggest waiver creation for complex changes
    const waiverAction = new vscode.CodeAction(
      'Create CAWS Waiver',
      vscode.CodeActionKind.QuickFix
    );
    waiverAction.command = {
      command: 'caws.createWaiver',
      title: 'Create waiver for quality concerns',
    };
    actions.push(waiverAction);

    return actions;
  }
}
