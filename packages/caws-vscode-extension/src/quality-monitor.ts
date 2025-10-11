import * as vscode from 'vscode';
import { getLogger } from './logger';
import { CawsMcpClient } from './mcp-client';

export class CawsQualityMonitor {
  private mcpClient: CawsMcpClient;
  private lastEvaluation: any = null;
  private logger = getLogger().createChild('QualityMonitor');

  constructor(mcpClient: CawsMcpClient) {
    this.mcpClient = mcpClient;
  }

  async onFileChanged(uri: vscode.Uri): Promise<void> {
    // Only monitor certain file types
    const fileExt = uri.fsPath.split('.').pop()?.toLowerCase();
    if (!['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'go', 'rs'].includes(fileExt || '')) {
      return;
    }

    try {
      // Call quality monitoring
      const result = await this.mcpClient.callTool('caws_quality_monitor', {
        action: 'file_saved',
        files: [vscode.workspace.asRelativePath(uri)],
        context: {
          project_tier: await this.getProjectTier(),
          language: fileExt,
        },
      });

      if (!result.content || !result.content[0]) {
        this.logger.warn('Invalid quality monitoring result: missing content');
        return;
      }
      const monitoring = JSON.parse(result.content[0].text);

      // Show recommendations if quality impact is detected
      if (monitoring.recommendations && monitoring.recommendations.length > 0) {
        const showRecommendations = await vscode.window.showInformationMessage(
          `CAWS: ${monitoring.quality_impact.replace('_', ' ')} detected`,
          'Show Recommendations',
          'Ignore'
        );

        if (showRecommendations === 'Show Recommendations') {
          this.showQualityRecommendations(monitoring);
        }
      }
    } catch (error) {
      // Silently fail monitoring to avoid disrupting workflow
      this.logger.warn('CAWS quality monitoring failed', error);
    }
  }

  async onCodeEdited(
    editor: vscode.TextEditor,
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): Promise<void> {
    if (
      !editor.document.uri.fsPath.includes('src') &&
      !editor.document.uri.fsPath.includes('lib') &&
      !editor.document.uri.fsPath.includes('app')
    ) {
      return; // Only monitor source code changes
    }

    const changeSize = changes.reduce(
      (total, change) => total + (change.text.length - (change.rangeLength || 0)),
      0
    );

    // Only monitor significant changes
    if (Math.abs(changeSize) < 10) return;

    try {
      const result = await this.mcpClient.callTool('caws_quality_monitor', {
        action: 'code_edited',
        files: [vscode.workspace.asRelativePath(editor.document.uri)],
        context: {
          project_tier: await this.getProjectTier(),
          change_size: changeSize,
          language: editor.document.languageId,
        },
      });

      if (!result.content || !result.content[0]) {
        this.logger.warn('Invalid code edit monitoring result: missing content');
        return;
      }
      const monitoring = JSON.parse(result.content[0].text);

      // Provide real-time feedback
      if (monitoring.risk_level === 'high' || monitoring.risk_level === 'critical') {
        const runValidation = await vscode.window.showWarningMessage(
          'CAWS: High-risk code changes detected',
          'Run Quality Check',
          'Create Waiver',
          'Ignore'
        );

        if (runValidation === 'Run Quality Check') {
          vscode.commands.executeCommand('caws.evaluate');
        } else if (runValidation === 'Create Waiver') {
          vscode.commands.executeCommand('caws.createWaiver');
        }
      }
    } catch (error) {
      this.logger.warn('CAWS code edit monitoring failed', error);
    }
  }

  private showQualityRecommendations(monitoring: any): void {
    const panel = vscode.window.createWebviewPanel(
      'cawsQualityRecommendations',
      'CAWS Quality Recommendations',
      vscode.ViewColumn.One,
      {}
    );

    const recommendationsHtml = monitoring.recommendations
      .map((rec: string, i: number) => `<li><strong>${i + 1}.</strong> ${rec}</li>`)
      .join('');

    panel.webview.html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>CAWS Quality Recommendations</title>
        <style>
          body { font-family: var(--vscode-font-family); padding: 20px; }
          .impact { font-size: 1.1em; margin: 15px 0; padding: 10px; border-radius: 4px; }
          .high { background: var(--vscode-notificationsWarningIcon-foreground); opacity: 0.1; }
          .medium { background: var(--vscode-notificationsInfoIcon-foreground); opacity: 0.1; }
          .low { background: var(--vscode-notificationsErrorIcon-foreground); opacity: 0.1; }
          .recommendations { margin-top: 20px; }
          .recommendations ul { padding-left: 20px; }
          .recommendations li { margin: 8px 0; }
        </style>
      </head>
      <body>
        <h1>CAWS Quality Impact Analysis</h1>

        <div class="impact ${monitoring.risk_level || 'medium'}">
          <strong>Quality Impact:</strong> ${monitoring.quality_impact || 'unknown'}
          <br>
          <strong>Risk Level:</strong> ${monitoring.risk_level || 'medium'}
        </div>

        <div class="recommendations">
          <h3>Recommended Actions</h3>
          <ul>
            ${recommendationsHtml}
          </ul>
        </div>
      </body>
      </html>
    `;
  }

  private async getProjectTier(): Promise<number> {
    try {
      const specPath = '.caws/working-spec.yaml';
      const uri = vscode.workspace.workspaceFolders?.[0]?.uri;

      if (uri) {
        const specUri = vscode.Uri.joinPath(uri, specPath);
        const content = await vscode.workspace.fs.readFile(specUri);
        const yaml = require('js-yaml');
        const spec = yaml.load(content.toString());

        return spec.risk_tier || 2;
      }
    } catch (error) {
      // Default to tier 2
    }

    return 2;
  }
}
