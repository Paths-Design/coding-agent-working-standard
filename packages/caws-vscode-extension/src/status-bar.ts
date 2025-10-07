import * as vscode from 'vscode';

export class CawsStatusBar {
  private statusBarItem: vscode.StatusBarItem;
  private qualityScore: number = 0;
  private status: string = 'unknown';

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBarItem.command = 'caws.evaluate';
  }

  initialize(context: vscode.ExtensionContext): void {
    if (vscode.workspace.getConfiguration('caws').get('showQualityStatus')) {
      this.statusBarItem.show();
      context.subscriptions.push(this.statusBarItem);
    }

    // Update on configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('caws.showQualityStatus')) {
        const showStatus = vscode.workspace.getConfiguration('caws').get('showQualityStatus');
        if (showStatus) {
          this.statusBarItem.show();
        } else {
          this.statusBarItem.hide();
        }
      }
    });
  }

  updateStatus(qualityScore: number, status: string): void {
    this.qualityScore = qualityScore;
    this.status = status;

    const percentage = Math.round(qualityScore * 100);

    // Set color and icon based on status
    let icon = '$(check)';
    let color = undefined;

    switch (status) {
      case 'quality_passed':
        icon = '$(check)';
        color = new vscode.ThemeColor('charts.green');
        break;
      case 'quality_failed':
        icon = '$(error)';
        color = new vscode.ThemeColor('charts.red');
        break;
      case 'spec_invalid':
        icon = '$(warning)';
        color = new vscode.ThemeColor('charts.yellow');
        break;
      default:
        icon = '$(question)';
        color = new vscode.ThemeColor('charts.blue');
    }

    this.statusBarItem.text = `${icon} CAWS: ${percentage}%`;
    this.statusBarItem.tooltip = `CAWS Quality Score: ${percentage}%\nStatus: ${status.replace('_', ' ')}\nClick to run evaluation`;
    this.statusBarItem.color = color;
  }

  setLoading(): void {
    this.statusBarItem.text = '$(sync~spin) CAWS: Evaluating...';
    this.statusBarItem.tooltip = 'Running CAWS quality evaluation...';
  }

  setError(error: string): void {
    this.statusBarItem.text = '$(error) CAWS: Error';
    this.statusBarItem.tooltip = `CAWS Error: ${error}`;
    this.statusBarItem.color = new vscode.ThemeColor('charts.red');
  }

  hide(): void {
    this.statusBarItem.hide();
  }

  show(): void {
    if (vscode.workspace.getConfiguration('caws').get('showQualityStatus')) {
      this.statusBarItem.show();
    }
  }
}
