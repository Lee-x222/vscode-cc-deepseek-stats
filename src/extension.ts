import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';

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
    vscode.commands.registerCommand('vscode-cc-statistics.refresh', () => {
      provider.refresh();
    })
  );

  // 打开面板命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-statistics.openPanel', () => {
      vscode.commands.executeCommand(
        'workbench.view.extension.vscode-cc-statistics-container'
      );
    })
  );

  // 启动时自动打开面板
  vscode.commands.executeCommand('workbench.view.extension.vscode-cc-statistics-container');
}

export function deactivate() {
  _provider?.dispose();
  _provider = undefined;
}
