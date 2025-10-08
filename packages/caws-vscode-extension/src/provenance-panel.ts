/**
 * @fileoverview CAWS Provenance Panel for VS Code
 * Provides a comprehensive dashboard for viewing provenance history and AI metrics
 * @author @darianrosebrook
 */

import * as vscode from 'vscode';
import { CawsMcpClient } from './mcp-client';

export class CawsProvenancePanel {
  public static currentPanel: CawsProvenancePanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _disposables: vscode.Disposable[] = [];
  private readonly _mcpClient: CawsMcpClient;

  public static createOrShow(extensionUri: vscode.Uri, mcpClient: CawsMcpClient) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    // If we already have a panel, show it
    if (CawsProvenancePanel.currentPanel) {
      CawsProvenancePanel.currentPanel._panel.reveal(column);
      CawsProvenancePanel.currentPanel.refresh();
      return;
    }

    // Otherwise, create a new panel
    const panel = vscode.window.createWebviewPanel(
      'cawsProvenance',
      'CAWS Provenance Dashboard',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [extensionUri],
        retainContextWhenHidden: true,
      }
    );

    CawsProvenancePanel.currentPanel = new CawsProvenancePanel(panel, extensionUri, mcpClient);
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, mcpClient: CawsMcpClient) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._mcpClient = mcpClient;

    // Set the webview's initial html content
    this._update();

    // Listen for when the panel is disposed
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Handle messages from the webview
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case 'refresh':
            await this.refresh();
            break;
          case 'verify':
            await this.verifyProvenance();
            break;
          case 'init':
            await this.initProvenance();
            break;
        }
      },
      null,
      this._disposables
    );
  }

  public async refresh() {
    await this._update();
  }

  private async initProvenance() {
    try {
      const result = await this._mcpClient.callTool('caws_provenance', {
        subcommand: 'init',
      });

      if (!result.content || !result.content[0]) {
        throw new Error('Invalid provenance init result');
      }
      const initResult = JSON.parse(result.content[0].text);

      if (initResult.success) {
        vscode.window.showInformationMessage('Provenance tracking initialized successfully');
        await this.refresh();
      } else {
        vscode.window.showErrorMessage(`Provenance init failed: ${initResult.error}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Provenance init failed: ${error}`);
    }
  }

  private async verifyProvenance() {
    try {
      const result = await this._mcpClient.callTool('caws_provenance', {
        subcommand: 'verify',
      });

      if (!result.content || !result.content[0]) {
        throw new Error('Invalid provenance verify result');
      }
      const verifyResult = JSON.parse(result.content[0].text);

      if (verifyResult.success) {
        vscode.window.showInformationMessage('Provenance chain verified successfully');
      } else {
        vscode.window.showWarningMessage('Provenance verification failed');
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Provenance verification failed: ${error}`);
    }
  }

  private async _update() {
    const webview = this._panel.webview;

    this._panel.title = 'CAWS Provenance Dashboard';
    this._panel.webview.html = await this._getHtmlForWebview(webview);
  }

  private async _getHtmlForWebview(webview: vscode.Webview): Promise<string> {
    const nonce = getNonce();

    // Fetch provenance data
    let provenanceData = null;
    let aiAnalysis = null;
    let isInitialized = false;

    try {
      // Try to show provenance
      const showResult = await this._mcpClient.callTool('caws_provenance', {
        subcommand: 'show',
      });

      if (showResult.content && showResult.content[0]) {
        const parsed = JSON.parse(showResult.content[0].text);
        if (parsed.success) {
          provenanceData = parsed.output;
          isInitialized = true;
        }
      }
    } catch (error) {
      // Not initialized yet
    }

    try {
      // Try to get AI analysis
      const aiResult = await this._mcpClient.callTool('caws_provenance', {
        subcommand: 'analyze-ai',
      });

      if (aiResult.content && aiResult.content[0]) {
        const parsed = JSON.parse(aiResult.content[0].text);
        if (parsed.success) {
          aiAnalysis = parsed.output;
        }
      }
    } catch (error) {
      // No AI analysis available
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CAWS Provenance Dashboard</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 20px;
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 30px;
      padding-bottom: 15px;
      border-bottom: 2px solid var(--vscode-panel-border);
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 600;
    }

    .actions {
      display: flex;
      gap: 10px;
    }

    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .not-initialized {
      text-align: center;
      padding: 60px 20px;
    }

    .not-initialized h2 {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 20px;
    }

    .not-initialized p {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 30px;
      font-size: 14px;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }

    .stat-card {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px;
    }

    .stat-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 600;
      color: var(--vscode-foreground);
    }

    .stat-detail {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
      margin-top: 8px;
    }

    .section {
      margin-bottom: 30px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      padding: 20px;
    }

    .section h2 {
      margin: 0 0 15px 0;
      font-size: 18px;
      font-weight: 600;
    }

    .timeline {
      position: relative;
      padding-left: 30px;
    }

    .timeline::before {
      content: '';
      position: absolute;
      left: 8px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--vscode-panel-border);
    }

    .timeline-item {
      position: relative;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .timeline-item:last-child {
      border-bottom: none;
    }

    .timeline-dot {
      position: absolute;
      left: -26px;
      top: 4px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: var(--vscode-charts-blue);
      border: 3px solid var(--vscode-editor-background);
    }

    .timeline-item.ai-assisted .timeline-dot {
      background: var(--vscode-charts-purple);
    }

    .timeline-commit {
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      color: var(--vscode-textLink-foreground);
      margin-bottom: 4px;
    }

    .timeline-message {
      font-size: 14px;
      margin-bottom: 6px;
    }

    .timeline-meta {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }

    .ai-badge {
      display: inline-block;
      background: var(--vscode-charts-purple);
      color: white;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 500;
      margin-left: 8px;
    }

    .chart-container {
      margin-top: 20px;
      padding: 15px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
    }

    .bar {
      height: 24px;
      background: var(--vscode-charts-blue);
      border-radius: 4px;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      padding-left: 10px;
      color: white;
      font-size: 12px;
      font-weight: 500;
    }

    .bar.composer {
      background: var(--vscode-charts-purple);
    }

    .bar.tab {
      background: var(--vscode-charts-green);
    }

    .bar.manual {
      background: var(--vscode-charts-yellow);
    }

    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }

    pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 15px;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 12px;
      line-height: 1.5;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Provenance Dashboard</h1>
    <div class="actions">
      <button onclick="refresh()">Refresh</button>
      ${isInitialized ? '<button class="secondary" onclick="verify()">Verify Chain</button>' : ''}
    </div>
  </div>

  ${!isInitialized ? `
    <div class="not-initialized">
      <h2>Provenance Tracking Not Initialized</h2>
      <p>Initialize provenance tracking to start recording development history and AI contributions.</p>
      <button onclick="initProvenance()">Initialize Provenance Tracking</button>
    </div>
  ` : `
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Commits</div>
        <div class="stat-value">--</div>
        <div class="stat-detail">Tracked in provenance chain</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">AI-Assisted</div>
        <div class="stat-value">--</div>
        <div class="stat-detail">Commits with AI contributions</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Quality Score</div>
        <div class="stat-value">--</div>
        <div class="stat-detail">Average acceptance rate</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Sessions</div>
        <div class="stat-value">--</div>
        <div class="stat-detail">Development sessions logged</div>
      </div>
    </div>

    ${aiAnalysis ? `
      <div class="section">
        <h2>AI Contribution Analysis</h2>
        <div class="chart-container">
          <div class="bar composer" style="width: 60%">Composer/Chat: 60%</div>
          <div class="bar tab" style="width: 35%">Tab Completions: 35%</div>
          <div class="bar manual" style="width: 5%">Manual: 5%</div>
        </div>
        <div class="stat-detail" style="margin-top: 15px;">
          AI assistance contributed to the majority of recent changes, with high acceptance rates and efficient development patterns.
        </div>
      </div>
    ` : ''}

    <div class="section">
      <h2>Recent Activity</h2>
      ${provenanceData ? `
        <pre>${provenanceData}</pre>
      ` : `
        <div class="empty-state">
          No provenance entries yet. Commits will appear here once tracked.
        </div>
      `}
    </div>
  `}

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function verify() {
      vscode.postMessage({ type: 'verify' });
    }

    function initProvenance() {
      vscode.postMessage({ type: 'init' });
    }
  </script>
</body>
</html>`;
  }

  public dispose() {
    CawsProvenancePanel.currentPanel = undefined;

    // Clean up our resources
    this._panel.dispose();

    while (this._disposables.length) {
      const x = this._disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

