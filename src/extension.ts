import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { buildStatsMessage } from './dataFetcher';

let _provider: SidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext) {
  // 注册侧边栏 WebView Provider
  const provider = new SidebarProvider(context.extensionUri);
  _provider = provider;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, provider)
  );

  // 刷新命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-deepseek-stats.refresh', () => {
      provider.refresh();
    })
  );

  // 打开面板命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-deepseek-stats.openPanel', () => {
      vscode.commands.executeCommand(
        'workbench.view.extension.vscode-cc-deepseek-stats-container'
      );
    })
  );

  // CSV 导出命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-deepseek-stats.exportCSV', async () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const msg = await buildStatsMessage(wsRoot);
      const entries = msg.allDays || [];
      if (entries.length === 0) {
        vscode.window.showWarningMessage('暂无数据可导出');
        return;
      }
      const header = 'date,cost,inputTokens,outputTokens,cacheReadTokens,cacheCreateTokens,totalTokens,models\n';
      const rows = entries.map(e =>
        `${e.date},${e.cost.toFixed(4)},${e.input},${e.output},${e.cacheRead},${e.cacheCreate},${e.totalTokens},${e.models.join('|')}`
      ).join('\n');
      const csv = header + rows + '\n';
      const defaultName = `cc-usage-${new Date().toISOString().slice(0, 10)}.csv`;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: { 'CSV 文件': ['csv'] },
      });
      if (!uri) return;
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(csv, 'utf-8'));
      } catch {
        const enc = new TextEncoder();
        await vscode.workspace.fs.writeFile(uri, enc.encode(csv));
      }
      vscode.window.showInformationMessage(`已导出 ${entries.length} 天数据到 ${uri.fsPath}`);
    })
  );

  // 启动时自动打开面板
  vscode.commands.executeCommand('workbench.view.extension.vscode-cc-deepseek-stats-container');
}

export function deactivate() {
  _provider?.dispose();
  _provider = undefined;
}
