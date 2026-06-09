import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildStatsMessage, startAutoRefresh } from './dataFetcher';

/**
 * WebView Provider —— 管理侧边栏 HTML 内容与消息通信。
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vscode-cc-statistics.panel';
  private _view?: vscode.WebviewView;
  private _cancelRefresh?: () => void;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._getHtml();

    // 接受来自 WebView 的消息（如手动刷新）
    webviewView.onDidDispose(() => {
      // 身份校验：只有被销毁的 view 仍是当前 view 时才清理
      if (this._view === webviewView) {
        this._cancelRefresh?.();
        this._view = undefined;
      }
    });

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'refresh') {
        this._sendStats();
      } else if (msg.command === 'exec') {
        // 白名单：仅允许特定 VS Code 命令
        const ALLOWED_COMMANDS = new Set([
          'workbench.action.openSettings',
          'workbench.action.openGlobalSettings',
          'vscode.open',
        ]);
        if (ALLOWED_COMMANDS.has(msg.cmd)) {
          vscode.commands.executeCommand(msg.cmd);
        } else {
          console.warn('[vscode-cc-statistics] 阻止未授权的 exec 命令:', msg.cmd);
        }
      } else if (msg.command === 'openFile') {
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const resolved = path.resolve(wsRoot, msg.file);
        // 防路径遍历：确保解析后的路径仍在工作区内
        if (!resolved.startsWith(path.resolve(wsRoot) + path.sep) && resolved !== path.resolve(wsRoot)) {
          console.warn('[vscode-cc-statistics] 阻止越界文件访问:', msg.file);
          return;
        }
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved));
      } else if (msg.command === 'openMemory') {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        if (!home) {
          console.warn('[vscode-cc-statistics] HOME 未设置，无法打开记忆文件');
          return;
        }
        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const slug = wsRoot.replace(/[^a-zA-Z0-9]/g, '-');
        // 记忆文件只允许 .md 后缀，拒绝路径遍历
        const safeName = msg.file.replace(/\.\./g, '').replace(/[\\/]/g, '');
        const filePath = path.join(home, '.claude', 'projects', slug, 'memory', safeName + '.md');
        vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
      } else if (msg.command === 'getAuth') {
        const authPath = path.join(os.homedir(), '.claude', 'deepseek_auth.json');
        try {
          const raw = fs.readFileSync(authPath, 'utf-8');
          webviewView.webview.postMessage({ type: 'authData', data: JSON.parse(raw) });
        } catch {
          webviewView.webview.postMessage({ type: 'authData', data: {} });
        }
      } else if (msg.command === 'exportCSV') {
        vscode.commands.executeCommand('vscode-cc-statistics.exportCSV');
      } else if (msg.command === 'openUrl') {
        vscode.env.openExternal(vscode.Uri.parse(msg.url));
      } else if (msg.command === 'saveAuth') {
        const authPath = path.join(os.homedir(), '.claude', 'deepseek_auth.json');
        try {
          let auth: any = {};
          try { auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')); } catch {}
          if (msg.apiKey !== undefined) auth.apiKey = msg.apiKey;
          if (typeof msg.balanceThreshold === 'number' && msg.balanceThreshold > 0) {
            auth.balanceThreshold = msg.balanceThreshold;
          }
          fs.writeFileSync(authPath, JSON.stringify(auth, null, 2));
          webviewView.webview.postMessage({ type: 'authSaved', ok: true });
        } catch (e: any) {
          webviewView.webview.postMessage({ type: 'authSaved', ok: false, error: e.message });
        }
      }
    });

    // 启动自动刷新
    this._cancelRefresh?.();
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    this._cancelRefresh = startAutoRefresh(workspaceRoot, (stats) => {
      try { this._view?.webview.postMessage(stats); } catch {}
    });
  }

  /** 手动刷新（异步，不阻塞） */
  public async refresh(): Promise<void> {
    await this._sendStats();
  }

  /** 释放定时器 */
  public dispose(): void {
    this._cancelRefresh?.();
  }

  private _sending = false;

  private async _sendStats(): Promise<void> {
    // 防并发：上一轮未完成则跳过
    if (this._sending) return;
    this._sending = true;
    try {
      // 捕获 this._view 引用，await 后校验
      const view = this._view;
      if (!view) return;
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const msg = await buildStatsMessage(workspaceRoot);
      // 校验 view 仍为当前实例
      if (this._view !== view) return;
      view.webview.postMessage(msg);
    } catch {
      // WebView 已销毁
    } finally {
      this._sending = false;
    }
  }

  /** 返回完整的 HTML（CSS + JS 内嵌） */
  private _getHtml(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CC 面板</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background, #1a1b26);
      --bg-surface: var(--vscode-editorWidget-background, #1f2133);
      --bg-hover: var(--vscode-list-hoverBackground, #282a3a);
      --border: var(--vscode-panel-border, #2a2c3d);
      --text-primary: var(--vscode-editor-foreground, #cdd6f4);
      --text-secondary: var(--vscode-descriptionForeground, #8b91a6);
      --text-muted: color-mix(in srgb, var(--vscode-descriptionForeground, #8b91a6) 60%, transparent);
      --accent-purple: #7c3aed;
      --accent-blue: var(--vscode-focusBorder, #3b82f6);
      --accent-green: #22c55e;
      --accent-yellow: #eab308;
      --accent-orange: #f97316;
      --accent-red: #ef4444;
      --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', 'JetBrains Mono', 'Consolas', monospace);
      --font-sans: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      /* 语义化设计 token */
      --overlay-bg: rgba(0, 0, 0, 0.75);
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2);
      --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.4);
      --shadow-glow-purple: 0 0 8px rgba(124, 58, 237, 0.4);
      --shadow-glow-blue: 0 0 8px rgba(59, 130, 246, 0.4);
      --shadow-glow-green: 0 0 8px rgba(34, 197, 94, 0.4);
      --shadow-glow-orange: 0 0 8px rgba(249, 115, 22, 0.4);
      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 12px;
      --transition-fast: 0.15s ease;
      --transition-normal: 0.25s ease;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      background: var(--bg);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-size: 13px;
      padding: 0;
      user-select: none;
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    /* ====== 标签页 ====== */
    .tabs {
      display: flex;
      border-bottom: 1px solid var(--border);
      padding: 0 12px;
      background: var(--bg-surface);
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .tab {
      padding: 10px 14px;
      cursor: pointer;
      color: var(--text-secondary);
      border-bottom: 2px solid transparent;
      font-size: 12px;
      font-weight: 500;
      transition: color 0.15s, border-color 0.15s;
    }
    .tab:hover { color: var(--text-primary); transform: translateY(-1px); }
    .tab.active {
      color: var(--accent-purple);
      border-bottom-color: var(--accent-purple);
    }

    /* ====== 面板内容 ====== */
    .panel-container {
      position: relative;
      min-height: 300px;
      flex: 1;
      overflow-y: auto;
    }
    .panel {
      position: absolute;
      top: 0; left: 0; right: 0;
      opacity: 0;
      transform: translateY(8px);
      pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
      padding: 14px 12px;
    }
    .panel.active {
      position: relative;
      opacity: 1;
      transform: translateY(0);
      pointer-events: auto;
    }

    /* ====== Token 统计卡片 ====== */
    .section-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 10px;
    }

    .stat-card {
      background: var(--bg-surface);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: var(--radius-md);
      padding: 14px;
      margin-bottom: 12px;
      box-shadow: var(--shadow-sm), 0 1px 3px rgba(0, 0, 0, 0.25);
    }

    .stat-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
    }
    .stat-label {
      color: var(--text-secondary);
      font-size: 12px;
    }
    .stat-value {
      font-family: var(--font-mono);
      font-size: 13px;
      font-weight: 600;
      color: var(--text-primary);
    }

    /* 进度条 */
    .bar-wrap {
      background: var(--border);
      border-radius: var(--radius-sm);
      height: 6px;
      margin-top: 4px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: var(--radius-sm);
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .bar-purple { background: linear-gradient(90deg, #7c3aed, #a78bfa); box-shadow: var(--shadow-glow-purple); }
    .bar-blue   { background: linear-gradient(90deg, #3b82f6, #60a5fa); box-shadow: var(--shadow-glow-blue); }
    .bar-green  { background: linear-gradient(90deg, #22c55e, #4ade80); box-shadow: var(--shadow-glow-green); }
    .bar-yellow { background: linear-gradient(90deg, #eab308, #facc15); }
    .bar-orange { background: linear-gradient(90deg, #f97316, #fb923c); box-shadow: var(--shadow-glow-orange); }

    /* 进度条扫光动画 */
    @keyframes shimmer {
      0% { filter: brightness(1); }
      50% { filter: brightness(1.6); }
      100% { filter: brightness(1); }
    }
    .bar-fill.animate { animation: shimmer 1.5s ease-in-out; }

    /* 总计大数字 */
    .total-section {
      text-align: center;
      padding: 10px 0;
      border-top: 1px solid var(--border);
      margin-top: 8px;
    }
    .total-tokens {
      font-family: var(--font-mono);
      font-size: 24px;
      font-weight: 700;
      color: var(--text-primary);
      text-shadow: 0 0 20px rgba(205, 214, 244, 0.15);
    }
    .total-cost {
      font-family: var(--font-mono);
      font-size: 28px;
      font-weight: 800;
      background: linear-gradient(135deg, var(--accent-blue), var(--accent-purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-top: 2px;
    }
    .total-label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .divider {
      border-top: 1px solid var(--border);
      margin: 12px 0;
    }
    .month-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 4px;
    }
    .total-hint {
      font-size: 11px;
      color: var(--accent-yellow);
      margin-bottom: 4px;
    }
    .model-list { margin-top: 6px; }
    .model-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 2px 0;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-secondary);
    }
    .model-cost { font-weight: 600; color: var(--text-primary); }
    .total-sub {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
    }

    /* 彩色指标圆点 */
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      margin-right: 6px;
      flex-shrink: 0;
    }
    .dot-purple { background: var(--accent-purple); }
    .dot-blue   { background: var(--accent-blue); }
    .dot-green  { background: var(--accent-green); }
    .dot-yellow { background: var(--accent-yellow); }
    .dot-orange { background: var(--accent-orange); }

    /* ====== 文件列表 ====== */
    .file-list { list-style: none; }
    .file-item {
      display: flex;
      align-items: center;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 12px;
      transition: background var(--transition-fast), padding-left var(--transition-fast), color var(--transition-fast);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-item:hover { background: var(--bg-hover); color: var(--text-primary); padding-left: 12px; }
    .file-icon { margin-right: 8px; font-size: 14px; flex-shrink: 0; }
    .skill-item { display: block; white-space: normal; overflow: visible; text-overflow: clip; }
    .skill-desc {
      margin-top: 6px;
      padding: 6px 10px;
      font-size: 11px;
      color: var(--text-secondary);
      background: var(--bg-hover);
      border-radius: 4px;
      line-height: 1.4;
    }

    /* ====== MCP 状态 ====== */
    .mcp-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 10px;
      margin: 3px;
      font-size: 12px;
    }
    .mcp-badge .status-dot {
      width: 6px;
      height: 3px;
      border-radius: 50%;
      background: var(--accent-green);
    }
    .mcp-empty {
      color: var(--text-muted);
      font-size: 12px;
      font-style: italic;
    }
    .mcp-toggle {
      cursor: pointer;
      user-select: none;
    }
    .mcp-toggle:hover { color: var(--text-primary); }
    .mcp-arrow {
      font-size: 10px;
      transition: transform 0.2s;
      display: inline-block;
    }
    .mcp-arrow.open { transform: rotate(180deg); }
    .mcp-list {
      max-height: 60px;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    .mcp-list.expanded { max-height: 2000px; }

    /* ====== 刷新按钮 ====== */
    .refresh-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 0;
      margin-bottom: 10px;
    }
    .refresh-btn {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 11px;
      padding: 4px 10px;
      transition: background var(--transition-fast), color var(--transition-fast), transform var(--transition-fast);
    }
    .refresh-btn:hover { background: var(--bg-hover); color: var(--text-primary); transform: scale(1.05); }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    .refresh-icon { display: inline-block; }
    .refresh-btn.refreshing .refresh-icon { animation: spin 1s linear infinite; }
    .settings-btn {
      display: block;
      width: 100%;
      background: var(--bg-surface);
      border: none;
      border-top: 1px solid var(--border);
      border-radius: 0;
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 15px;
      padding: 10px 0;
      transition: background var(--transition-fast), color var(--transition-fast);
      line-height: 1;
      text-align: center;
      flex-shrink: 0;
    }
    .settings-btn:hover { background: var(--bg-hover); color: var(--text-primary); }

    /* ====== 设置弹窗 ====== */
    .modal-overlay {
      display: flex;
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: var(--overlay-bg);
      backdrop-filter: blur(4px);
      z-index: 1000;
      justify-content: center; align-items: center;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s ease, visibility 0.25s;
    }
    .modal-overlay.open {
      opacity: 1;
      visibility: visible;
    }
    .modal-box {
      background: var(--bg-surface);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: var(--radius-md);
      padding: 20px 24px;
      width: 90%;
      max-width: 360px;
      box-shadow: var(--shadow-md);
      position: relative;
      transform: translateY(20px) scale(0.97);
      transition: transform 0.25s ease;
    }
    .modal-overlay.open .modal-box {
      transform: translateY(0) scale(1);
    }
    .modal-close {
      position: absolute;
      top: 10px; right: 14px;
      cursor: pointer;
      color: var(--text-secondary);
      font-size: 16px;
      line-height: 1;
      transition: color var(--transition-fast);
    }
    .modal-close:hover { color: var(--text-primary); }
    .modal-box h2 {
      margin: 0 0 16px 0;
      font-size: 14px;
      color: var(--text-primary);
    }
    .modal-field { margin-bottom: 12px; }
    .modal-field label {
      display: block;
      font-size: 11px;
      color: var(--text-secondary);
      margin-bottom: 4px;
    }
    .modal-field input, .modal-field textarea {
      width: 100%;
      box-sizing: border-box;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text-primary);
      font-size: 12px;
      padding: 6px 8px;
      font-family: var(--font-mono);
    }
    .modal-field textarea { resize: vertical; min-height: 50px; }
    .modal-field input:focus, .modal-field textarea:focus {
      outline: none;
      border-color: var(--accent-blue);
      box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.25);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
    .modal-actions button {
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 12px;
      cursor: pointer;
      background: var(--bg-surface);
      color: var(--text-primary);
    }
    .modal-actions button:hover { background: var(--bg-hover); }
    .modal-actions button.primary {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
      color: #fff;
    }
    .modal-actions button.primary:hover { opacity: 0.9; }
    .modal-hint {
      font-size: 11px;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 16px;
    }
    .modal-hint a {
      color: var(--accent-blue);
      text-decoration: none;
    }
    .modal-hint a:hover { text-decoration: underline; }
    .modal-hint code {
      background: var(--bg-hover);
      padding: 1px 4px;
      border-radius: 2px;
      font-size: 10px;
    }
    .modal-toast {
      font-size: 11px;
      margin-top: 10px;
      text-align: center;
      color: var(--accent-green);
    }
    .modal-toast.error { color: #ef4444; }

    .last-updated {
      font-size: 10px;
      color: var(--text-muted);
    }

    /* ====== 会话列表 ====== */
    .day-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 12px;
      margin-bottom: 8px;
      transition: background var(--transition-fast), transform var(--transition-fast), border-color var(--transition-fast);
    }
    .day-card:hover {
      background: var(--bg-hover);
      transform: translateX(2px);
      border-color: rgba(255, 255, 255, 0.08);
    }
    .day-card .day-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .day-card .day-date {
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
    }
    .day-card .day-cost {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--accent-blue);
      font-weight: 600;
    }
    .day-card .day-detail {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 4px;
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-mono);
    }
    .day-card .day-detail .tok-label {
      color: var(--text-muted);
      margin-right: 2px;
    }

    /* ====== 月份卡片（历史面板二级折叠） ====== */
    .month-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-left: 3px solid;
      border-image: linear-gradient(180deg, var(--accent-purple), transparent) 1;
      border-radius: 0 6px 6px 0;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .month-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      cursor: pointer;
      user-select: none;
      transition: background var(--transition-fast);
    }
    .month-header:hover { background: var(--bg-hover); }
    .month-arrow {
      font-size: 12px;
      color: var(--text-secondary);
      width: 14px;
      flex-shrink: 0;
      transition: transform 0.35s ease;
    }
    .month-arrow.open { transform: rotate(90deg); }
    .month-label {
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
    }
    .month-summary {
      font-size: 12px;
      color: var(--text-primary);
      font-family: var(--font-mono);
      font-weight: 600;
      margin-left: auto;
      text-align: right;
    }
    .month-summary .month-cost {
      color: var(--accent-blue);
    }
    .month-days {
      display: block;
      max-height: 0;
      overflow: hidden;
      border-top: 1px solid var(--border);
      padding: 0 10px;
      transition: max-height 0.35s ease, padding 0.35s ease;
    }
    .month-days.open {
      max-height: 2000px;
      padding: 8px 10px;
    }
    .month-days .day-card {
      margin-bottom: 4px;
      margin-left: 12px;
      padding: 6px 8px;
      background: rgba(255,255,255,0.02);
      border-radius: 4px;
    }

    /* ====== 骨架屏 ====== */
    @keyframes skeleton-shimmer {
      0% { background-position: -200px 0; }
      100% { background-position: calc(200px + 100%) 0; }
    }
    .skeleton {
      background: linear-gradient(90deg, var(--border) 25%, rgba(255,255,255,0.04) 50%, var(--border) 75%);
      background-size: 200px 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
      border-radius: var(--radius-sm);
    }
    .skeleton-row {
      height: 14px;
      margin-bottom: 8px;
    }
    .skeleton-bar {
      height: 6px;
      margin-top: 4px;
    }
    .skeleton-card {
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      margin-bottom: 12px;
    }

    /* ====== 加载/错误状态 ====== */
    .loading {
      text-align: center;
      color: var(--text-muted);
      padding: 30px;
      font-size: 13px;
    }
    .status-banner {
      text-align: center;
      padding: 8px 12px;
      border-radius: 6px;
      margin-bottom: 10px;
      font-size: 12px;
      display: none;
    }
    .status-banner.status-loading {
      display: block;
      background: rgba(59,130,246,0.1);
      border: 1px solid rgba(59,130,246,0.3);
      color: var(--accent-blue);
    }
    .status-banner.status-error {
      display: block;
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.3);
      color: var(--accent-red);
    }
    /* 余额预警闪烁 */
    .cost-warn {
      color: var(--accent-red) !important;
      -webkit-text-fill-color: var(--accent-red) !important;
      animation: blink 1.5s ease-in-out infinite;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    .status-banner.status-empty {
      display: block;
      background: rgba(234,179,8,0.1);
      border: 1px solid rgba(234,179,8,0.3);
      color: var(--accent-yellow);
      white-space: pre-wrap;
      font-family: var(--font-mono);
      font-size: 11px;
    }

  </style>
</head>
<body>

<!-- 标签页栏 -->
<div class="tabs">
  <div class="tab active" data-tab="today">今日</div>
  <div class="tab" data-tab="history">历史</div>
  <div class="tab" data-tab="skills">技能</div>
  <div class="tab" data-tab="files">文件</div>
  <div class="tab" data-tab="memory">记忆</div>
</div>

<div class="panel-container">

<!-- ======= 今日面板 ======= -->
<div id="panel-today" class="panel active">
  <div class="refresh-bar">
    <span class="last-updated" id="last-updated">—</span>
    <button class="refresh-btn" id="refresh-btn" onclick="refresh()"><span class="refresh-icon">⟳</span> 刷新</button>
  </div>

  <div id="status-banner" class="status-banner status-loading">加载中...</div>

  <div class="section-title">上下文 · TOKENS</div>
  <div class="stat-card" id="stats-card">
    <!-- 骨架占位 -->
    <div class="skeleton skeleton-row" style="width:40%"></div>
    <div class="skeleton skeleton-row" style="width:60%;margin-top:10px"></div>
    <div class="skeleton skeleton-row" style="width:50%"></div>
    <div class="skeleton skeleton-row" style="width:45%;margin-top:10px"></div>
    <div class="skeleton skeleton-row" style="width:55%"></div>
    <div class="skeleton skeleton-row" style="width:35%;margin-top:16px"></div>
    <div class="skeleton skeleton-row" style="width:70%"></div>
    <div class="skeleton skeleton-row" style="width:25%;margin-top:12px"></div>
  </div>

  <div class="section-title mcp-toggle" onclick="toggleMcp()">🔌 MCP 服务器 <span class="mcp-arrow" id="mcp-arrow">▾</span></div>
  <div class="mcp-list" id="mcp-list"><span class="mcp-empty">检测中…</span></div>
</div>


<!-- ======= 历史面板 ======= -->
<div id="panel-history" class="panel">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
    <div class="section-title" style="margin-bottom:0">每日统计</div>
    <button class="refresh-btn" onclick="exportCSV()" title="导出 CSV">📥 导出</button>
  </div>
  <div id="history-list"><div class="loading">加载中…</div></div>
</div>

<!-- ======= 技能面板 ======= -->
<div id="panel-skills" class="panel">
  <div class="section-title">🛠️ 技能</div>
  <ul class="file-list stat-card" id="skills-list"><li class="loading">加载中…</li></ul>
</div>

<!-- ======= 文件面板 ======= -->
<div id="panel-files" class="panel">
  <div class="section-title">工作区文件</div>
  <ul class="file-list stat-card" id="file-list"><li class="loading">加载中…</li></ul>
</div>

<!-- ======= 记忆面板 ======= -->
<div id="panel-memory" class="panel">
  <div class="section-title">🧠 记忆文件</div>
  <ul class="file-list stat-card" id="memory-list"><li class="loading">加载中…</li></ul>
</div>

</div>

<button class="settings-btn" id="settings-btn" onclick="openSettings()" title="设置">⚙ 设置</button>

<!-- ======= 设置弹窗 ======= -->
<div class="modal-overlay" id="settings-modal">
  <div class="modal-box">
    <span class="modal-close" onclick="closeSettings()">✕</span>
    <h2>⚙ 设置</h2>
    <div class="modal-field">
      <label>DeepSeek API Key</label>
      <input type="password" id="auth-token" placeholder="sk-xxx...">
    </div>
    <div class="modal-hint">
      💡 在 <a href="#" onclick="openDeepSeek();return false">platform.deepseek.com</a> → API Keys 创建
    </div>
    <div class="modal-field">
      <label>⚠ 余额预警阈值（元）</label>
      <input type="number" id="auth-threshold" placeholder="10" min="1" step="0.1">
    </div>
    <div class="modal-actions">
      <button onclick="closeSettings()">取消</button>
      <button class="primary" onclick="saveSettings()">保存</button>
    </div>
    <div class="modal-toast" id="modal-toast"></div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();

  // ====== 标签页切换 ======
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.dataset.tab;
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + target).classList.add('active');
    });
  });

  // ====== 设置弹窗 ======
  function openSettings() {
    // 回显当前保存的认证信息
    vscode.postMessage({ command: 'getAuth' });
    document.getElementById('settings-modal').classList.add('open');
  }

  function closeSettings() {
    document.getElementById('settings-modal').classList.remove('open');
    document.getElementById('modal-toast').className = 'modal-toast';
    document.getElementById('modal-toast').textContent = '';
  }

  function openDeepSeek() {
    vscode.postMessage({ command: 'openUrl', url: 'https://platform.deepseek.com/api_keys' });
  }

  function saveSettings() {
    const apiKey = document.getElementById('auth-token').value.trim();
    const threshold = parseFloat(document.getElementById('auth-threshold').value) || 10;
    vscode.postMessage({ command: 'saveAuth', apiKey: apiKey, balanceThreshold: threshold });
  }

  // ====== 手动刷新 ======
  function exportCSV() {
    vscode.postMessage({ command: 'exportCSV' });
  }

  function refresh() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.add('refreshing');
    btn.disabled = true;
    vscode.postMessage({ command: 'refresh' });
  }

  function refreshDone() {
    const btn = document.getElementById('refresh-btn');
    btn.classList.remove('refreshing');
    btn.disabled = false;
  }

  function showBanner(status, text) {
    const b = document.getElementById('status-banner');
    b.className = 'status-banner status-' + status;
    b.textContent = text;
  }

  function hideBanner() {
    document.getElementById('status-banner').className = 'status-banner';
    document.getElementById('status-banner').textContent = '';
  }


  // ====== 接收消息 ======
  window.addEventListener('message', (e) => {
    const msg = e.data;

    // 统计数据更新
    if (msg.type === 'update') {
      refreshDone();

      const now = new Date();
      document.getElementById('last-updated').textContent =
        '更新于 ' + now.toLocaleTimeString('zh-CN');

      if (msg.status === 'error') {
        showBanner('error', '获取失败: ' + (msg.error || '未知错误'));
      } else if (msg.status === 'empty') {
        showBanner('empty', '暂无今日数据');
      } else if (msg.status === 'ok') {
        hideBanner();
      }

      updateTodayPanel(msg);
      updateHistoryPanel(msg);
      updateFilesPanel(msg);
      updateMemoryPanel(msg);
      updateSkillsPanel(msg);
      updateMcpPanel(msg);
      return;
    }

    // 认证数据回显
    if (msg.type === 'authData') {
      const d = msg.data || {};
      document.getElementById('auth-token').value = d.apiKey || '';
      document.getElementById('auth-threshold').value = d.balanceThreshold || 10;
      return;
    }

    // 认证保存结果
    if (msg.type === 'authSaved') {
      const toast = document.getElementById('modal-toast');
      if (msg.ok) {
        toast.className = 'modal-toast';
        toast.textContent = '已保存';
        refresh();
        setTimeout(closeSettings, 800);
      } else {
        toast.className = 'modal-toast error';
        toast.textContent = '保存失败: ' + (msg.error || '未知错误');
      }
      return;
    }
  });

  // ====== 今日面板 ======
  function updateTodayPanel(msg) {
    const card = document.getElementById('stats-card');
    // 首次收到数据时替换骨架屏
    if (card && card.querySelector('.skeleton')) {
      card.innerHTML =
        '<div class="stat-row">' +
          '<span class="stat-label"><span class="dot dot-purple"></span>输入</span>' +
          '<span class="stat-value" id="stat-input">—</span>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill bar-purple" id="bar-input" style="width:0%"></div></div>' +
        '<div class="stat-row" style="margin-top:8px">' +
          '<span class="stat-label"><span class="dot dot-orange"></span>输出</span>' +
          '<span class="stat-value" id="stat-output">—</span>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill bar-orange" id="bar-output" style="width:0%"></div></div>' +
        '<div class="stat-row" style="margin-top:8px">' +
          '<span class="stat-label"><span class="dot dot-blue"></span>缓存读取</span>' +
          '<span class="stat-value" id="stat-cache-read">—</span>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill bar-blue" id="bar-cache-read" style="width:0%"></div></div>' +
        '<div class="stat-row" style="margin-top:8px">' +
          '<span class="stat-label"><span class="dot dot-green"></span>缓存写入</span>' +
          '<span class="stat-value" id="stat-cache-create">—</span>' +
        '</div>' +
        '<div class="bar-wrap"><div class="bar-fill bar-green" id="bar-cache-create" style="width:0%"></div></div>' +
        '<div class="total-section">' +
          '<div class="total-hint" id="total-hint" style="display:none">⚠ 当前会话数据尚未计入</div>' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
            '<span class="month-label" style="margin:0">💰 充值余额</span>' +
            '<span class="total-cost" id="account-balance" style="font-size:16px">—</span>' +
          '</div>' +
          '<div class="month-label">今日消耗</div>' +
          '<div class="total-cost" id="total-cost">—</div>' +
          '<div class="total-sub" id="total-sub"></div>' +
          '<div class="model-list" id="model-list-today"></div>' +
          '<div class="divider"></div>' +
          '<div class="month-label">本月消耗</div>' +
          '<div class="total-cost" id="total-cost-all">—</div>' +
          '<div class="total-sub" id="total-sub-all"></div>' +
          '<div class="model-list" id="model-list-all"></div>' +
        '</div>';
    }

    // 进度条：用今日数据
    const today = msg.today || { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, totalTokens: 0, cost: 0 };
    const promptTotal = (today.input || 0) + (today.cacheRead || 0) + (today.cacheCreate || 0);
    const barBase = Math.max(promptTotal, today.output || 0, 1);

    setStat('input', today.input || 0, barBase);
    setStat('output', today.output || 0, barBase);
    setStat('cache-read', today.cacheRead || 0, barBase);
    setStat('cache-create', today.cacheCreate || 0, barBase);

    // 账户余额
    document.getElementById('account-balance').textContent = '¥' + (msg.balance || 0).toFixed(2);

    // 今日消耗
    const hitRate = promptTotal > 0 ? ((today.cacheRead || 0) / promptTotal * 100).toFixed(1) : '0';
    var costEl = document.getElementById('total-cost');
    costEl.textContent = '¥' + (today.cost || 0).toFixed(2);
    // 余额预警
    var balEl = document.getElementById('account-balance');
    if (msg.overThreshold) {
      balEl.classList.add('cost-warn');
      balEl.title = '⚠ 余额低于预警阈值 ¥' + (msg.balanceThreshold || 10);
    } else {
      balEl.classList.remove('cost-warn');
      balEl.title = '';
    }
    document.getElementById('total-sub').textContent = formatNum(today.totalTokens || 0) + ' tokens · 命中 ' + hitRate + '%';
    document.getElementById('model-list-today').innerHTML = renderModels(
      (msg.today && msg.today.modelBreakdown) || []
    );
    // 今日数据为零时显示提示
    document.getElementById('total-hint').style.display = (today.cost || 0) === 0 ? 'block' : 'none';

    // 本月消耗
    const mon = msg.monthlyTotals || msg.totals;
    document.getElementById('total-cost-all').textContent = '¥' + (mon.cost || 0).toFixed(2);
    document.getElementById('total-sub-all').textContent = formatNum(mon.totalTokens || 0) + ' tokens';
    document.getElementById('model-list-all').innerHTML = renderModels(msg.monthlyModelBreakdown || msg.modelBreakdown || []);

  }

  function setStat(id, val, barBase) {
    document.getElementById('stat-' + id).textContent = formatNum(val);
    const pct = barBase > 0 ? (val / barBase * 100) : 0;
    document.getElementById('bar-' + id).style.width = pct + '%';
  }

  // ====== 历史面板（二级：月份 → 每日） ======
  function updateHistoryPanel(msg) {
    const days = msg.allDays || [];
    const container = document.getElementById('history-list');
    if (days.length === 0) {
      container.innerHTML = '<div class="loading">暂无历史数据</div>';
      return;
    }

    // 按月份分组
    const months = new Map();
    days.forEach(function(d) {
      const m = d.date.slice(0, 7);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(d);
    });

    // 记住当前展开的月份
    const openMonths = new Set();
    container.querySelectorAll('.month-days.open').forEach(function(el) {
      const label = el.parentElement.querySelector('.month-label');
      if (label) openMonths.add(label.textContent);
    });

    // 月份倒序
    const sorted = Array.from(months.entries()).sort(function(a, b) { return b[0].localeCompare(a[0]); });

    container.innerHTML = sorted.map(function(entry) {
      const month = entry[0];
      const allMonthDays = entry[1];
      if (allMonthDays.length === 0) return '';

      // 汇总用全月数据（含今天），与"本月消耗"一致
      const totalCost = allMonthDays.reduce(function(s, d) { return s + (d.cost || 0); }, 0);
      const totalTokens = allMonthDays.reduce(function(s, d) { return s + (d.totalTokens || 0); }, 0);

      const dayCards = allMonthDays.slice().reverse().map(function(d) {
        const input = formatNum(d.input);
        const output = formatNum(d.output);
        const cache = formatNum(d.cacheRead);
        const cost = '¥' + (d.cost || 0).toFixed(2);
        return '<div class="day-card">' +
          '<div class="day-header">' +
            '<span class="day-date">' + escHtml(d.date) + '</span>' +
            '<span class="day-cost">' + cost + '</span>' +
          '</div>' +
          '<div class="day-detail">' +
            '<span><span class="tok-label">输入</span>' + input + '</span>' +
            '<span><span class="tok-label">输出</span>' + output + '</span>' +
            '<span><span class="tok-label">缓存</span>' + cache + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

      return '<div class="month-card">' +
        '<div class="month-header" onclick="toggleMonth(this)">' +
          '<span class="month-arrow">▸</span>' +
          '<span class="month-label">' + escHtml(month) + '</span>' +
          '<span class="month-summary">' + allMonthDays.length + '天 · <span class="month-cost">¥' + totalCost.toFixed(2) + '</span> · ' + formatNum(totalTokens) + ' tokens</span>' +
        '</div>' +
        '<div class="month-days">' + dayCards + '</div>' +
      '</div>';
    }).filter(Boolean).join('');

    // 恢复之前展开的月份
    if (openMonths.size > 0) {
      container.querySelectorAll('.month-card').forEach(function(card) {
        const label = card.querySelector('.month-label');
        if (label && openMonths.has(label.textContent)) {
          card.querySelector('.month-days').classList.add('open');
          card.querySelector('.month-arrow').textContent = '▴';
        }
      });
    }
  }

  function toggleMonth(header) {
    const card = header.parentElement;
    const days = card.querySelector('.month-days');
    const arrow = card.querySelector('.month-arrow');
    const isOpen = days.classList.toggle('open');
    arrow.classList.toggle('open', isOpen);
  }

  // ====== 文件面板 ======
  function updateFilesPanel(msg) {
    const files = msg.projectFiles || [];
    const container = document.getElementById('file-list');
    if (files.length === 0) {
      container.innerHTML = '<li class="loading">未找到文件</li>';
      return;
    }
    const icons = { '.md': '📝', '.py': '🐍', '.ts': '📘', '.json': '⚙️' };
    container.innerHTML = files.map(f => {
      const ext = '.' + f.split('.').pop();
      const icon = icons[ext] || '📄';
      return '<li class="file-item" data-file="' + escHtml(f) + '"><span class="file-icon">' + icon + '</span>' + escHtml(f) + '</li>';
    }).join('');
    // 事件委托：点击文件项打开文件
    container.onclick = function(e) {
      const item = e.target.closest('.file-item');
      if (item && item.dataset.file) {
        vscode.postMessage({ command: 'openFile', file: item.dataset.file });
      }
    };
  }

  // ====== 记忆面板 ======
  function updateMemoryPanel(msg) {
    const files = msg.memoryFiles || [];
    const container = document.getElementById('memory-list');
    if (files.length === 0) {
      container.innerHTML = '<li class="loading">暂无记忆文件</li>';
      return;
    }
    container.innerHTML = files.map(f =>
      '<li class="file-item" data-file="' + escHtml(f) + '"><span class="file-icon">🧠</span>' + escHtml(f) + '</li>'
    ).join('');
    container.onclick = function(e) {
      const item = e.target.closest('.file-item');
      if (item && item.dataset.file) {
        vscode.postMessage({ command: 'openMemory', file: item.dataset.file });
      }
    };
  }

  // ====== 技能面板 ======
  function updateSkillsPanel(msg) {
    const skills = msg.skills || [];
    const container = document.getElementById('skills-list');
    if (skills.length === 0) {
      container.innerHTML = '<li class="loading">未找到技能</li>';
      return;
    }
    // 保存展开状态
    const expanded = new Set();
    container.querySelectorAll('.skill-item').forEach(el => {
      const descEl = el.querySelector('.skill-desc');
      if (descEl && descEl.style.display !== 'none') {
        expanded.add(el.getAttribute('data-name'));
      }
    });
    container.innerHTML = skills.map((s, i) => {
      const desc = s.description ? escHtml(s.description) : '';
      const isExpanded = expanded.has(s.name);
      return '<li class="file-item skill-item" data-name="' + escHtml(s.name) + '">' +
        '<span class="file-icon">⚡</span>' + escHtml(s.name) +
        (desc ? '<div class="skill-desc"' + (isExpanded ? '' : ' style="display:none"') + '>' + desc + '</div>' : '') +
        '</li>';
    }).join('');
    container.onclick = function(e) {
      const item = e.target.closest('.skill-item');
      if (!item) return;
      const desc = item.querySelector('.skill-desc');
      if (desc) {
        desc.style.display = desc.style.display === 'none' ? 'block' : 'none';
      }
    };
  }

  // ====== MCP 折叠 ======
  function toggleMcp() {
    const list = document.getElementById('mcp-list');
    const arrow = document.getElementById('mcp-arrow');
    list.classList.toggle('expanded');
    arrow.classList.toggle('open');
  }

  // ====== MCP 面板 ======
  function updateMcpPanel(msg) {
    const servers = msg.mcpServers || [];
    const container = document.getElementById('mcp-list');
    if (servers.length === 0) {
      container.innerHTML = '<span class="mcp-empty">未配置 MCP 服务器</span>';
      return;
    }
    container.innerHTML = servers.map(s =>
      '<span class="mcp-badge"><span class="status-dot"></span>' + escHtml(s) + '</span>'
    ).join('');
  }

  // ====== 工具函数 ======
  function formatNum(n) {
    if (typeof n !== 'number' || isNaN(n) || !n || n < 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return String(Math.floor(n));
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML;
  }

  const MODEL_DOTS = {
    'deepseek-v4-pro': 'dot-purple',
    'deepseek-v4-flash': 'dot-blue',
  };
  function renderModels(models) {
    return models.map(function(m) {
      const dot = MODEL_DOTS[m.model] || 'dot-green';
      const name = (m.model || '').replace('deepseek-', '');
      return '<div class="model-row">' +
        '<span><span class="dot ' + dot + '"></span>' + escHtml(name) + '</span>' +
        '<span class="model-cost">¥' + (m.cost || 0).toFixed(2) + '</span>' +
        '</div>';
    }).join('');
  }

</script>
</body>
</html>`;
  }
}
