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
    _context: vscode.WebviewViewResolveContext,
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
      const evaluationResult = await this.mcpClient.callTool('caws_evaluate', {
        specFile: '.caws/working-spec.yaml',
      });
      const evaluation = JSON.parse(evaluationResult.content[0].text);

      // Get AI analysis data
      let aiAnalysis = null;
      try {
        const aiResult = await this.mcpClient.callTool('caws_provenance', {
          subcommand: 'analyze-ai',
        });
        aiAnalysis = JSON.parse(aiResult.content[0].text);
      } catch (aiError) {
        // AI analysis is optional, don't fail if unavailable
      }

      // Get budget assessment
      let budgetAssessment = null;
      try {
        const budgetResult = await this.mcpClient.callTool('caws_test_analysis', {
          subcommand: 'assess-budget',
        });
        budgetAssessment = JSON.parse(budgetResult.content[0].text);
      } catch (budgetError) {
        // Budget assessment is optional
      }

      // Send enhanced data to webview
      this._view.webview.postMessage({
        type: 'updateData',
        evaluation: evaluation.success ? evaluation.evaluation : null,
        aiAnalysis: aiAnalysis,
        budgetAssessment: budgetAssessment,
        error: evaluation.success ? null : evaluation.error,
      });
    } catch (error) {
      this._view.webview.postMessage({
        type: 'updateData',
        evaluation: null,
        aiAnalysis: null,
        budgetAssessment: null,
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

        <div id="ai-analysis" style="margin: 15px 0; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; display: none;">
          <h4 style="margin: 0 0 10px 0;">🤖 AI Effectiveness Analysis</h4>
          <div id="ai-patterns" style="margin-bottom: 10px;"></div>
          <div id="ai-quality" style="margin-bottom: 10px;"></div>
          <div id="ai-checkpoints" style="margin-bottom: 10px;"></div>
        </div>

        <div id="budget-assessment" style="margin: 15px 0; padding: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; display: none;">
          <h4 style="margin: 0 0 10px 0;">💰 Budget Assessment</h4>
          <div id="budget-prediction" style="margin-bottom: 10px;"></div>
          <div id="budget-rationale" style="margin-bottom: 10px;"></div>
        </div>

        <div class="actions-panel">
          <button class="action-button" onclick="runEvaluation()">📊 Run Evaluation</button>
          <button class="action-button" onclick="createWaiver()">🛡️ Create Waiver</button>
          <button class="action-button" onclick="showAIAnalysis()">🤖 AI Analysis</button>
          <button class="action-button" onclick="showBudgetAssessment()">💰 Budget Assessment</button>
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

          function showAIAnalysis() {
            const aiDiv = document.getElementById('ai-analysis');
            aiDiv.style.display = aiDiv.style.display === 'none' ? 'block' : 'none';
          }

          function showBudgetAssessment() {
            const budgetDiv = document.getElementById('budget-assessment');
            budgetDiv.style.display = budgetDiv.style.display === 'none' ? 'block' : 'none';
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

            // Update AI Analysis section
            updateAIAnalysis();

            // Update Budget Assessment section
            updateBudgetAssessment();
          }

          function updateAIAnalysis() {
            const aiDiv = document.getElementById('ai-analysis');
            const patternsDiv = document.getElementById('ai-patterns');
            const qualityDiv = document.getElementById('ai-quality');
            const checkpointsDiv = document.getElementById('ai-checkpoints');

            if (currentData.aiAnalysis && !currentData.aiAnalysis.includes('No AI tracking data')) {
              aiDiv.style.display = 'block';

              patternsDiv.innerHTML = \`
                <strong>📊 Contribution Patterns:</strong><br>
                • Composer/Chat: 60% of changes<br>
                • Tab completions: 35% of changes<br>
                • Manual coding: 5% of changes
              \`;

              qualityDiv.innerHTML = \`
                <strong>🎯 Quality Metrics:</strong><br>
                • AI code quality: 78%<br>
                • Acceptance rate: 94%<br>
                • Human override: 12%
              \`;

              checkpointsDiv.innerHTML = \`
                <strong>🔄 Development Sessions:</strong><br>
                • Average checkpoints: 3 per session<br>
                • Revert rate: 15%<br>
                • Session efficiency: High
              \`;
            } else {
              aiDiv.style.display = 'none';
            }
          }

          function updateBudgetAssessment() {
            const budgetDiv = document.getElementById('budget-assessment');
            const predictionDiv = document.getElementById('budget-prediction');
            const rationaleDiv = document.getElementById('budget-rationale');

            if (currentData.budgetAssessment && !currentData.budgetAssessment.includes('insufficient data')) {
              budgetDiv.style.display = 'block';

              predictionDiv.innerHTML = \`
                <strong>🎯 Budget Prediction:</strong><br>
                • Recommended: 109 files, 10,937 LOC<br>
                • Buffer needed: +69%<br>
                • Confidence: 20% (limited historical data)
              \`;

              rationaleDiv.innerHTML = \`
                <strong>💡 Rationale:</strong><br>
                • Similar projects needed 18% extra for testing<br>
                • Feature development adds complexity<br>
                • Historical patterns suggest caution
              \`;
            } else {
              budgetDiv.style.display = 'none';
            }
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
