import * as vscode from 'vscode';
import { CawsMcpClient } from './mcp-client';
import { CawsQualityMonitor } from './quality-monitor';
import { CawsStatusBar } from './status-bar';
import { CawsWebviewProvider } from './webview-provider';

let mcpClient: CawsMcpClient;
let qualityMonitor: CawsQualityMonitor;
let statusBar: CawsStatusBar;
let webviewProvider: CawsWebviewProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('CAWS VS Code extension activated');

  // Initialize components
  mcpClient = new CawsMcpClient();
  qualityMonitor = new CawsQualityMonitor(mcpClient);
  statusBar = new CawsStatusBar();
  webviewProvider = new CawsWebviewProvider(context.extensionUri);

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('cawsQualityDashboard', webviewProvider)
  );

  // Register commands
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
  console.log('CAWS VS Code extension deactivated');
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

async function runCawsValidation(): Promise<void> {
  try {
    const result = await mcpClient.callTool('caws_validate', {
      specFile: '.caws/working-spec.yaml',
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
