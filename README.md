# Claude Code DeepSeek 用量面板

vscode-cc-deepseek-stats — Claude Code 的 DeepSeek 平台用量实时统计面板。Token 消耗、缓存命中率、费用追踪、余额预警，全在侧边栏。

## 功能

- **📊 Token 统计** — 今日输入 / 输出 / 缓存读取 / 缓存写入，带可视化进度条
- **💰 费用追踪** — 按模型分列的今日消耗和本月累计
- **💎 账户余额** — DeepSeek 平台实时余额 + 可配置阈值余额不足红色预警
- **📈 缓存命中率** — 实时显示当日缓存读取命中率百分比
- **📅 历史记录** — 按月份折叠查看每日消耗明细
- **📥 CSV 导出** — 点击按钮或执行命令一键导出消耗明细
- **🔌 MCP 服务器** — 列出当前项目配置的 MCP 服务器
- **📝 记忆文件** — 列出用户 Memory 文件，点击可在编辑器中打开
- **🛠️ 技能列表** — 列出已安装的技能，点击展开中文描述
- **🔄 自动刷新** — 每 30 秒静默更新，不再闪白
- **⚙ 一键配置** — 面板内粘贴 DeepSeek API Key，配置余额预警阈值

## 使用

1. 启动后统计面板自动在侧边栏打开
2. 点击 ⚙ 设置按钮，粘贴 DeepSeek API Key 并设置余额预警阈值
3. 点击 **技能** 标签查看所有已安装技能，点击技能名展开中文描述
4. 点击 **历史** 标签查看每日 / 每月消耗明细，顶部按钮导出 CSV
5. 点击 Memory 文件名可在编辑器中打开

> **说明：** Token 统计数据来自 Claude Code 和 DeepSeek 平台 API。费用计算和账户余额功能针对 DeepSeek 平台优化。

## 已知问题

- 首次安装或无使用记录时显示空状态
- 仅支持 DeepSeek 模型定价（v4-pro / v4-flash），其他模型显示为 unknown

## 许可

MIT

---

# Claude Code DeepSeek Stats

vscode-cc-deepseek-stats — Real-time DeepSeek usage statistics panel for Claude Code. Token tracking, cache hit rate, cost monitoring, and balance alerts in your sidebar.

## Features

- **📊 Token Stats** — Today's input / output / cache read / cache write with progress bars
- **💰 Cost Tracking** — Per-model cost breakdown for today and monthly totals
- **💎 Balance** — DeepSeek platform real-time balance + configurable low-balance alert
- **📈 Cache Hit Rate** — Real-time cache read hit rate
- **📅 History** — Monthly collapsible daily breakdown
- **📥 CSV Export** — One-click export usage data to CSV
- **🔌 MCP Servers** — Configured MCP servers list
- **📝 Memory Files** — User memory files, click to open
- **🛠️ Skills** — Installed skills with descriptions
- **🔄 Auto-Refresh** — Silent updates every 30 seconds, no flicker
- **⚙ Quick Setup** — Paste your DeepSeek API Key, set balance alert threshold

## Usage

1. The statistics panel opens automatically in the sidebar on launch
2. Click ⚙ Settings, paste your DeepSeek API Key and configure alert threshold
3. Click the **Skills** tab to browse installed skills, click to see descriptions
4. Click the **History** tab for daily / monthly breakdowns, use the export button
5. Click any memory filename to open it in the editor

> **Note:** Token statistics come from Claude Code and the DeepSeek platform API. Cost calculation and balance features are optimized for DeepSeek.

## Known Issues

- Empty state when no usage data exists
- Only DeepSeek model pricing supported (v4-pro / v4-flash)

## License

MIT
