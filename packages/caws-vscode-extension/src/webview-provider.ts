import * as vscode from 'vscode';
import { CawsMcpClient } from './mcp-client';

export class CawsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'cawsQualityDashboard';

  private _view?: vscode.WebviewView;
  private mcpClient: CawsMcpClient;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this.mcpClient = new CawsMcpClient();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'refresh':
          await this.refreshQualityData();
          break;
        case 'runEvaluation':
          vscode.commands.executeCommand('caws.evaluate');
          break;
        case 'createWaiver':
          vscode.commands.executeCommand('caws.createWaiver');
          break;
      }
    });

    // Initial data load
    this.refreshQualityData();
  }

  private async refreshQualityData(): Promise<void> {
    if (!this._view) return;

    try {
      // Get current evaluation
      const result = await this.mcpClient.callTool('caws_evaluate', {
        specFile: '.caws/working-spec.yaml',
      });

      const evaluation = JSON.parse(result.content[0].text);

      // Send data to webview
      this._view.webview.postMessage({
        type: 'updateData',
        evaluation: evaluation.success ? evaluation.evaluation : null,
        error: evaluation.success ? null : evaluation.error,
      });
    } catch (error) {
      this._view.webview.postMessage({
        type: 'updateData',
        evaluation: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CAWS Quality Dashboard</title>
        <style>
          body {
            font-family: var(--vscode-font-family);
            padding: 10px;
            margin: 0;
          }

          .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
          }

          .title {
            font-size: 1.1em;
            font-weight: bold;
          }

          .actions {
            display: flex;
            gap: 5px;
          }

          .score-display {
            text-align: center;
            margin-bottom: 15px;
            padding: 10px;
            border-radius: 6px;
          }

          .score-passed {
            background: var(--vscode-charts-green);
            color: white;
          }

          .score-failed {
            background: var(--vscode-charts-red);
            color: white;
          }

          .score-unknown {
            background: var(--vscode-notificationsInfoIcon-foreground);
            color: white;
          }

          .score-number {
            font-size: 2em;
            font-weight: bold;
            display: block;
          }

          .score-status {
            font-size: 0.9em;
            opacity: 0.9;
          }

          .criteria {
            margin-bottom: 15px;
          }

          .criterion {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            margin: 4px 0;
            border-radius: 4px;
            font-size: 0.9em;
          }

          .criterion-passed {
            background: var(--vscode-charts-green);
            opacity: 0.1;
          }

          .criterion-failed {
            background: var(--vscode-charts-red);
            opacity: 0.1;
          }

          .criterion-waived {
            background: var(--vscode-charts-yellow);
            opacity: 0.1;
          }

          .criterion-error {
            background: var(--vscode-notificationsErrorIcon-foreground);
            opacity: 0.1;
          }

          .criterion-name {
            flex: 1;
          }

          .criterion-score {
            font-weight: bold;
            margin-left: 10px;
          }

          .actions-panel {
            border-top: 1px solid var(--vscode-panel-border);
            padding-top: 10px;
          }

          .action-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 6px 12px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 0.9em;
            margin-right: 5px;
          }

          .action-button:hover {
            background: var(--vscode-button-hoverBackground);
          }

          .error {
            color: var(--vscode-notificationsErrorIcon-foreground);
            padding: 10px;
            border-radius: 4px;
            background: var(--vscode-notificationsErrorIcon-foreground);
            opacity: 0.1;
          }

          .loading {
            text-align: center;
            padding: 20px;
            color: var(--vscode-descriptionForeground);
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="title">CAWS Quality Dashboard</div>
          <div class="actions">
            <button class="action-button" onclick="refresh()">🔄</button>
          </div>
        </div>

        <div id="content">
          <div class="loading">Loading quality data...</div>
        </div>

        <div class="actions-panel">
          <button class="action-button" onclick="runEvaluation()">📊 Run Evaluation</button>
          <button class="action-button" onclick="createWaiver()">🛡️ Create Waiver</button>
        </div>

        <script nonce="${nonce}">
          const vscode = acquireVsCodeApi();
          let currentData = null;

          function refresh() {
            vscode.postMessage({ type: 'refresh' });
            document.getElementById('content').innerHTML = '<div class="loading">Refreshing...</div>';
          }

          function runEvaluation() {
            vscode.postMessage({ type: 'runEvaluation' });
          }

          function createWaiver() {
            vscode.postMessage({ type: 'createWaiver' });
          }

          window.addEventListener('message', event => {
            const message = event.data;

            if (message.type === 'updateData') {
              currentData = message;
              updateDisplay();
            }
          });

          function updateDisplay() {
            const content = document.getElementById('content');

            if (currentData.error) {
              content.innerHTML = \`<div class="error">Error: \${currentData.error}</div>\`;
              return;
            }

            if (!currentData.evaluation) {
              content.innerHTML = '<div class="loading">No evaluation data available</div>';
              return;
            }

            const evaluation = currentData.evaluation;
            const score = Math.round(evaluation.quality_score * 100);
            const status = evaluation.overall_status;

            let scoreClass = 'score-unknown';
            if (status === 'quality_passed') scoreClass = 'score-passed';
            else if (status === 'quality_failed') scoreClass = 'score-failed';

            let criteriaHtml = '';
            if (evaluation.criteria) {
              criteriaHtml = evaluation.criteria.map(criterion => {
                let criterionClass = 'criterion-unknown';
                if (criterion.status === 'passed') criterionClass = 'criterion-passed';
                else if (criterion.status === 'failed') criterionClass = 'criterion-failed';
                else if (criterion.status === 'waived') criterionClass = 'criterion-waived';
                else if (criterion.status === 'error') criterionClass = 'criterion-error';

                const scorePercent = Math.round(criterion.score * 100);
                return \`
                  <div class="criterion \${criterionClass}">
                    <span class="criterion-name">\${criterion.name}</span>
                    <span class="criterion-score">\${scorePercent}%</span>
                  </div>
                \`;
              }).join('');
            }

            content.innerHTML = \`
              <div class="score-display \${scoreClass}">
                <span class="score-number">\${score}%</span>
                <span class="score-status">\${status.replace('_', ' ').toUpperCase()}</span>
              </div>

              <div class="criteria">
                <strong>Quality Criteria:</strong>
                \${criteriaHtml}
              </div>
            \`;
          }

          // Initial load
          refresh();
        </script>
      </body>
      </html>`;
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
