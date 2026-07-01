import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { buildStatsMessage, fetchDeepSeekMonth } from './dataFetcher';

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

  // 图表报告导出命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-deepseek-stats.exportChart', async () => {
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
      const msg = await buildStatsMessage(wsRoot);
      const entries = msg.allDays || [];
      if (entries.length === 0) {
        vscode.window.showWarningMessage('暂无数据可导出');
        return;
      }
      const html = buildChartReport(entries);
      const defaultName = `cc-chart-${new Date().toISOString().slice(0, 10)}.html`;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(defaultName),
        filters: { 'HTML 文件': ['html'] },
      });
      if (!uri) return;
      try {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(html, 'utf-8'));
      } catch {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(html));
      }
      vscode.window.showInformationMessage(`已导出图表报告到 ${uri.fsPath}`, '打开报告').then(choice => {
        if (choice === '打开报告') { vscode.env.openExternal(uri); }
      });
    })
  );

  // 拉取指定月份 DeepSeek 平台数据命令
  context.subscriptions.push(
    vscode.commands.registerCommand('vscode-cc-deepseek-stats.fetchMonth', async () => {
      const input = await vscode.window.showInputBox({
        prompt: '输入要拉取的月份 (YYYY-MM)',
        placeHolder: '2026-05',
        validateInput: (v) => /^\d{4}-\d{2}$/.test(v) ? undefined : '格式: YYYY-MM',
      });
      if (!input) return;
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const result = await fetchDeepSeekMonth(home, input);
      if (result) {
        vscode.window.showInformationMessage(`已拉取 ${input} 平台数据: ¥${result.totalCost.toFixed(2)} (${Object.keys(result.models||{}).join(', ')})`);
        _provider?.refresh();
      } else {
        vscode.window.showWarningMessage(`无法获取 ${input} 的平台数据，请检查认证信息和网络连接`);
      }
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
      const header = '日期,费用(¥),命中率%,输入Tokens,输出Tokens,缓存读取Tokens,总Tokens,模型\n';
      const rows = entries.map(e => {
        const denom = (e.cacheRead || 0) + (e.input || 0);
        const hitRate = denom > 0 ? ((e.cacheRead || 0) / denom * 100).toFixed(1) : '0';
        return `${e.date},${e.cost.toFixed(4)},${hitRate}%,${e.input},${e.output},${e.cacheRead},${e.totalTokens},${e.models.join('|')}`;
      }).join('\n');
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

// 数字格式化（TS 侧用，不依赖浏览器 JS）
function fmtTok(n: number): string {
  if (!n || n < 0) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.floor(n));
}

// ====== 自包含 HTML 图表报告生成 ======
function buildChartReport(entries: Array<{
  date: string; cost: number; input: number; output: number;
  cacheRead: number; totalTokens: number; models: string[];
  modelBreakdown: Array<{ model: string; cost: number }>;
}>): string {
  const now = new Date();
  const pd = (n: number) => String(n).padStart(2, '0');
  const localTs = `${now.getFullYear()}-${pd(now.getMonth() + 1)}-${pd(now.getDate())} ${pd(now.getHours())}:${pd(now.getMinutes())}:${pd(now.getSeconds())}`;
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  // 提取所有月份
  const months = [...new Set(sorted.map(e => e.date.slice(0, 7)))].sort();
  const defaultMonth = months.length > 0 ? months[months.length - 1] : '';

  // 初始 KPI（默认最新月）
  const calcKpi = (data: typeof sorted) => {
    const cost = data.reduce((s, e) => s + e.cost, 0);
    const tok = data.reduce((s, e) => s + e.totalTokens, 0);
    let hs = 0, hc = 0;
    for (const e of data) {
      const d = (e.cacheRead || 0) + (e.input || 0);
      if (d > 0) { hs += (e.cacheRead || 0) / d * 100; hc++; }
    }
    return { cost: cost.toFixed(2), tok: fmtTok(tok), hit: hc > 0 ? (hs / hc).toFixed(1) : '0', days: data.length };
  };
  const kpi = calcKpi(sorted.filter(e => e.date.startsWith(defaultMonth)));

  const dataJSON = JSON.stringify(sorted);
  const monthsJSON = JSON.stringify(months);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DeepSeek 用量报告 · ${defaultMonth}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"SF Pro Text","PingFang SC",sans-serif;background:#f5f5f5;color:#333;padding:32px 24px;max-width:960px;margin:0 auto}
h1{font-size:22px;font-weight:700;margin-bottom:12px}
.month-select{padding:6px 12px;border-radius:6px;border:1px solid #ddd;background:#fff;font-size:13px;color:#333;cursor:pointer;margin-bottom:16px;outline:none}
.month-select:focus{border-color:#3b82f6}
.sub{color:#888;font-size:13px;margin-bottom:20px}
.kpi-row{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.kpi-card{flex:1;min-width:140px;background:#fff;border-radius:10px;padding:16px 18px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.kpi-label{font-size:12px;color:#888;margin-bottom:4px}
.kpi-value{font-size:24px;font-weight:700;color:#222}
.kpi-unit{font-size:13px;font-weight:400;color:#999}
.chart-section{background:#fff;border-radius:10px;padding:20px;margin-bottom:16px;box-shadow:0 1px 4px rgba(0,0,0,0.06)}
.chart-title{font-size:15px;font-weight:600;margin-bottom:12px;color:#333}
.chart-section canvas{width:100%;height:auto;display:block}
.legend{display:flex;gap:16px;margin-top:8px;font-size:12px;color:#888}
.legend-dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:4px;vertical-align:middle}
.footer{text-align:center;color:#bbb;font-size:11px;margin-top:24px}
</style>
</head>
<body>
<h1> DeepSeek 用量报告</h1>

<select class="month-select" id="month-select" onchange="switchMonth(this.value)">${months.map(m => `<option value="${m}"${m === defaultMonth ? ' selected' : ''}>${m}</option>`).join('')}</select>
<div class="sub">生成于 ${localTs}</div>

<div class="kpi-row">
  <div class="kpi-card"><div class="kpi-label">累计费用</div><div class="kpi-value" id="kpi-cost">¥${kpi.cost}</div></div>
  <div class="kpi-card"><div class="kpi-label">累计 Tokens</div><div class="kpi-value" id="kpi-tokens">${kpi.tok}</div></div>
  <div class="kpi-card"><div class="kpi-label">平均命中率</div><div class="kpi-value" id="kpi-hit">${kpi.hit}<span class="kpi-unit">%</span></div></div>
  <div class="kpi-card"><div class="kpi-label">总天数</div><div class="kpi-value" id="kpi-days">${kpi.days}</div></div>
</div>

<div class="chart-section">
  <div class="chart-title"> 本月费用趋势 (¥)</div>
  <canvas id="c1" width="900" height="300"></canvas>
  <div class="legend">
    <span><span class="legend-dot" style="background:#ea580c"></span>v4-pro</span>
    <span><span class="legend-dot" style="background:#fbbf24"></span>v4-flash</span>
  </div>
</div>

<div class="chart-section">
  <div class="chart-title" id="c2-title"> 每日 Token 分布</div>
  <canvas id="c2" width="900" height="300"></canvas>
  <div class="legend">
    <span><span class="legend-dot" style="background:#3b82f6"></span>命中缓存</span>
    <span><span class="legend-dot" style="background:#a78bfa"></span>未命中</span>
    <span><span class="legend-dot" style="background:#f97316"></span>输出</span>
  </div>
</div>

<div class="footer">DeepSeek Stats · v1.1.8</div>

<script>
var ALL_DATA = ${dataJSON};
var MONTHS = ${monthsJSON};
var CUR = '${defaultMonth}';

function fmtTok(n) {
  if (!n || n < 0) return '0';
  if (n >= 1e6) return (n/1e6).toFixed(2)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(Math.floor(n));
}

function daysInMonth(prefix) {
  var parts = prefix.split('-');
  return new Date(parseInt(parts[0]), parseInt(parts[1]), 0).getDate();
}

function setupCanvas(canvas, w, h) {
  var dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w+'px';
  canvas.style.height = h+'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return ctx;
}

// ====== 浮窗 ======
var _tip = null;
function showTip(evt, lines) {
  if (!_tip) {
    _tip = document.createElement('div');
    _tip.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:rgba(30,30,30,0.94);color:#fff;font-size:11px;font-family:sans-serif;padding:6px 10px;border-radius:6px;line-height:1.5;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,0.4);';
    document.body.appendChild(_tip);
  }
  _tip.innerHTML = lines.join('<br>');
  var left = evt.clientX + 12, top = evt.clientY - 30;
  var tw = _tip.offsetWidth || 150;
  if (left + tw > window.innerWidth - 8) left = evt.clientX - tw - 12;
  var th = _tip.offsetHeight || 60;
  if (top + th > window.innerHeight - 8) top = evt.clientY - th - 10;
  if (left < 4) left = 4;
  if (top < 4) top = 4;
  _tip.style.left = left + 'px';
  _tip.style.top = top + 'px';
  _tip.style.display = 'block';
}
function hideTip() { if (_tip) _tip.style.display = 'none'; }

// 月份切换 — 构建完整月份天数数组，无数据天填0，铺满X轴
function switchMonth(prefix) {
  CUR = prefix;
  var totalDays = daysInMonth(prefix);

  // 映射已有数据
  var existingMap = {};
  ALL_DATA.forEach(function(d) {
    if (d.date.indexOf(prefix) === 0) existingMap[d.date] = d;
  });

  // 构建完整月份数组（1..totalDays）
  var fullMonthData = [];
  for (var d = 1; d <= totalDays; d++) {
    var dateStr = prefix + '-' + (d < 10 ? '0' + d : '' + d);
    var entry = existingMap[dateStr];
    if (entry) {
      fullMonthData.push(entry);
    } else {
      fullMonthData.push({ date: dateStr, cost: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, models: [], modelBreakdown: [] });
    }
  }

  // KPI 统计 — 仅用真实数据
  var realData = fullMonthData.filter(function(d) { return d.totalTokens > 0; });
  var tc = realData.reduce(function(s,d){return s+d.cost;}, 0);
  var tt = realData.reduce(function(s,d){return s+d.totalTokens;}, 0);
  var hs = 0, hc = 0;
  realData.forEach(function(d) {
    var denom = (d.cacheRead||0)+(d.input||0);
    if (denom > 0) { hs += (d.cacheRead||0)/denom*100; hc++; }
  });
  document.getElementById('kpi-cost').textContent = '¥' + tc.toFixed(2);
  document.getElementById('kpi-tokens').textContent = fmtTok(tt);
  document.getElementById('kpi-hit').innerHTML = (hc>0?(hs/hc).toFixed(1):'0') + '<span class="kpi-unit">%</span>';
  document.getElementById('kpi-days').textContent = realData.length;
  // 重绘 — 用完整月份数组铺满X轴
  drawBars(document.getElementById('c1'), fullMonthData);
  drawStacked(document.getElementById('c2'), fullMonthData);
}

// 费用堆叠柱状图 — pro(底#ea580c) + flash(顶#fbbf24), 渐变色 + 最高值 + 浮窗
function drawBars(canvas, entries) {
  var ctx = setupCanvas(canvas, 900, 300);
  var W = 900, H = 300, pad = {top:20,right:20,bottom:36,left:60};
  var pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  ctx.clearRect(0, 0, W, H);

  var maxTotal = 0, daily = [];
  for (var i = 0; i < entries.length; i++) {
    var bd = entries[i].modelBreakdown || [];
    var pro = 0, flash = 0;
    for (var j = 0; j < bd.length; j++) {
      if (bd[j].model.indexOf('flash') >= 0) flash += bd[j].cost;
      else pro += bd[j].cost;
    }
    var tot = pro + flash;
    if (tot > maxTotal) maxTotal = tot;
    daily.push({ pro: pro, flash: flash, total: tot, date: entries[i].date });
  }
  maxTotal = Math.max(0.01, maxTotal);
  var nm = Math.ceil(maxTotal * 1.15);
  var MAX_BW = 50;
  var bw = Math.min(MAX_BW, Math.max(5, pw / entries.length * 0.7)), gap = pw / entries.length;

  // Y 轴
  ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#999'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (var i = 0; i <= 5; i++) {
    var y = pad.top + ph / 5 * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillText('¥' + (nm - nm / 5 * i).toFixed(0), pad.left - 8, y + 4);
  }
  ctx.textAlign = 'center';

  var proColor = '#ea580c', flashColor = '#fbbf24';
  var step = Math.max(1, Math.floor(entries.length / 15));
  canvas._bars = [];
  var maxIdx = -1, maxVal = 0;

  for (var i = 0; i < daily.length; i++) {
    var x = pad.left + gap * i + (gap - bw) / 2, yb = pad.top + ph;

    // pro 底
    if (daily[i].pro > 0) {
      var ph2 = daily[i].pro / nm * ph, py = yb - ph2;
      var g = ctx.createLinearGradient(x, py, x, yb);
      g.addColorStop(0, '#f97316'); g.addColorStop(1, proColor);
      ctx.fillStyle = g; ctx.fillRect(x, py, bw, ph2);
      yb -= ph2;
    }
    // flash 顶
    if (daily[i].flash > 0) {
      var fh = daily[i].flash / nm * ph, fy = yb - fh;
      var fg = ctx.createLinearGradient(x, fy, x, yb);
      fg.addColorStop(0, '#fcd34d'); fg.addColorStop(1, flashColor);
      ctx.fillStyle = fg; ctx.fillRect(x, fy, bw, fh);
    }

    if (daily[i].total >= maxVal) { maxVal = daily[i].total; maxIdx = i; }

    if (i % step === 0 || i === entries.length - 1) {
      ctx.fillStyle = '#999';
      ctx.fillText(entries[i].date.slice(8), x + bw / 2, H - pad.bottom + 14);
    }

    canvas._bars.push({ x: x, w: bw, total: daily[i].total, date: daily[i].date, pro: daily[i].pro, flash: daily[i].flash });
  }

  // 最高费用标注
  if (maxIdx >= 0 && daily[maxIdx].total > 0) {
    var mb = canvas._bars[maxIdx];
    ctx.fillStyle = '#f97316'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('¥' + mb.total.toFixed(2), mb.x + mb.w / 2, pad.top + ph - (mb.total / nm) * ph - 6);
  }

  // 图例由 HTML 提供（与 Token 图一致）

  // 浮窗
  canvas.onmousemove = function(evt) {
    var mx = evt.offsetX, my = evt.offsetY;
    for (var i = 0; i < canvas._bars.length; i++) {
      var b = canvas._bars[i];
      if (mx >= b.x && mx <= b.x + b.w && my >= pad.top && my <= pad.top + ph) {
        showTip(evt, [b.date, '总费用: ¥' + b.total.toFixed(4), 'v4-pro: ¥' + b.pro.toFixed(4), 'v4-flash: ¥' + b.flash.toFixed(4)]);
        return;
      }
    }
    hideTip();
  };
  canvas.onmouseleave = hideTip;
}

// Token 堆叠柱状图 — 底=命中(蓝#3b82f6) → 中=未命中(紫#a78bfa) → 顶=输出(橙#f97316), 渐变+浮窗
function drawStacked(canvas, entries) {
  var ctx = setupCanvas(canvas, 900, 300);
  var W = 900, H = 300, pad = {top:20,right:20,bottom:36,left:60};
  var pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;
  ctx.clearRect(0, 0, W, H);

  var mt = 0;
  for (var i = 0; i < entries.length; i++) {
    var t = (entries[i].input || 0) + (entries[i].cacheRead || 0) + (entries[i].output || 0);
    if (t > mt) mt = t;
  }
  mt = Math.max(1, mt); var nm = Math.ceil(mt * 1.15);
  var yUnit = '', yDiv = 1;
  if (nm >= 1e6) { yUnit = 'M'; yDiv = 1e6; }
  else if (nm >= 1e3) { yUnit = 'K'; yDiv = 1e3; }

  ctx.strokeStyle = '#eee'; ctx.lineWidth = 0.5;
  ctx.fillStyle = '#999'; ctx.font = '11px sans-serif'; ctx.textAlign = 'right';
  for (var i = 0; i <= 5; i++) {
    var y = pad.top + ph / 5 * i;
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    var yv = nm - nm / 5 * i;
    ctx.fillText(yDiv > 1 ? (yv / yDiv).toFixed(1) : fmtTok(yv), pad.left - 8, y + 4);
  }

  // 更新标题
  var ct = document.getElementById('c2-title');
  if (ct) ct.textContent = ' 每日 Token 分布' + (yUnit ? ' (' + yUnit + ')' : '');
  ctx.textAlign = 'center';

  var colors = ['#3b82f6', '#a78bfa', '#f97316'], lightColors = ['#60a5fa', '#c4b5fd', '#fb923c'], keys = ['cacheRead', 'input', 'output'];
  var MAX_BW = 50;
  var bw = Math.min(MAX_BW, Math.max(3, pw / entries.length * 0.7)), gap = pw / entries.length;
  var step = Math.max(1, Math.floor(entries.length / 15));
  canvas._bars = [];

  for (var i = 0; i < entries.length; i++) {
    var x = pad.left + gap * i + (gap - bw) / 2, yb = pad.top + ph;
    for (var s = 0; s < keys.length; s++) {
      var v = entries[i][keys[s]] || 0;
      if (!v) continue;
      var sh = v / nm * ph, segTop = yb - sh;
      var grad = ctx.createLinearGradient(x, segTop, x, yb);
      grad.addColorStop(0, lightColors[s]); grad.addColorStop(1, colors[s]);
      ctx.fillStyle = grad;
      ctx.fillRect(x, segTop, bw, sh);
      yb -= sh;
    }

    if (i % step === 0 || i === entries.length - 1) {
      ctx.fillStyle = '#999';
      ctx.fillText(entries[i].date.slice(8), x + bw / 2, H - pad.bottom + 14);
    }

    canvas._bars.push({
      x: x, w: bw, date: entries[i].date,
      input: entries[i].input || 0, cacheRead: entries[i].cacheRead || 0, output: entries[i].output || 0
    });
  }

  // 图例由 HTML 提供，Canvas 内不重复绘制

  // 浮窗
  canvas.onmousemove = function(evt) {
    var mx = evt.offsetX, my = evt.offsetY;
    for (var i = 0; i < canvas._bars.length; i++) {
      var b = canvas._bars[i];
      if (mx >= b.x && mx <= b.x + b.w && my >= pad.top && my <= pad.top + ph) {
        var total = (b.input || 0) + (b.cacheRead || 0) + (b.output || 0);
        var denom = (b.input || 0) + (b.cacheRead || 0);
        var hr = denom > 0 ? ((b.cacheRead || 0) / denom * 100).toFixed(1) : '0';
        showTip(evt, [
          b.date,
          '总Token: ' + fmtTok(total),
          '<span style="color:#3b82f6">●</span> 命中缓存: ' + fmtTok(b.cacheRead || 0),
          '<span style="color:#a78bfa">●</span> 未命中: ' + fmtTok(b.input || 0),
          '<span style="color:#f97316">●</span> 输出: ' + fmtTok(b.output || 0),
          '命中率: ' + hr + '%'
        ]);
        return;
      }
    }
    hideTip();
  };
  canvas.onmouseleave = hideTip;
}

// 初始渲染 — 构建完整月份天数数组
(function() {
  var totalDays = daysInMonth(CUR);
  var existingMap = {};
  ALL_DATA.forEach(function(d) { if (d.date.indexOf(CUR) === 0) existingMap[d.date] = d; });
  var fullMonthData = [];
  for (var d = 1; d <= totalDays; d++) {
    var dateStr = CUR + '-' + (d < 10 ? '0' + d : '' + d);
    var entry = existingMap[dateStr];
    if (entry) {
      fullMonthData.push(entry);
    } else {
      fullMonthData.push({ date: dateStr, cost: 0, input: 0, output: 0, cacheRead: 0, totalTokens: 0, models: [], modelBreakdown: [] });
    }
  }
  if (!fullMonthData.length) return;
  drawBars(document.getElementById('c1'), fullMonthData);
  drawStacked(document.getElementById('c2'), fullMonthData);
})();
</script>
</body></html>`;
}

export function deactivate() {
  _provider?.dispose();
  _provider = undefined;
}
