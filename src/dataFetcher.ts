import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CcUsageResult, DailyEntry, ModelCost, StatsMessage } from './types';

const REFRESH_INTERVAL = 30_000;

// 公共定价表（单位：元/百万token）
const PRICING: Record<string, { in: number; out: number; cache: number }> = {
  'deepseek-v4-pro':   { in: 3,    out: 6,    cache: 0.025 },
  'deepseek-v4-flash': { in: 1,    out: 2,    cache: 0.02 },
};

const execFileAsync = promisify(execFile);

/** 解析单行 CSV，处理引号包裹的字段 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function collectJsonlFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectJsonlFiles(full));
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[vscode-cc-statistics] collectJsonlFiles 错误:', e);
    }
  }
  return results;
}

function parseAll(dir: string): {
  dayMap: Map<string, DailyEntry>;
  modelMap: Map<string, ModelCost>;
} {
  const dayMap = new Map<string, DailyEntry>();
  const modelMap = new Map<string, ModelCost>();
  const dayModelMap = new Map<string, Map<string, ModelCost>>();

  const seenIds = new Set<string>();

  for (const file of collectJsonlFiles(dir)) {
    try {
      for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
        try {
          const e = JSON.parse(line);
          const msg = e.message;
          if (!msg?.usage) continue;
          const msgId = msg.id;
          if (msgId && seenIds.has(msgId)) continue;
          if (msgId) seenIds.add(msgId);
          const u = msg.usage;
          const ts = e.timestamp;
          if (!ts) continue;

          const date = ts.slice(0, 10);
          const input = u.input_tokens || 0;
          const output = u.output_tokens || 0;
          const cc = u.cache_creation_input_tokens || 0;
          const cr = u.cache_read_input_tokens || 0;
          const model = msg.model || 'unknown';
          const p = PRICING[model] || PRICING['deepseek-v4-pro'];
          const cost = (input + cc) / 1e6 * p.in + output / 1e6 * p.out + cr / 1e6 * p.cache;

          // 按日期聚合
          const day = dayMap.get(date);
          if (day) {
            day.input += input; day.output += output;
            day.cacheCreate += cc; day.cacheRead += cr;
            day.totalTokens += input + output + cc + cr;
            day.cost += cost;
            if (model && !day.models.includes(model)) day.models.push(model);
          } else {
            dayMap.set(date, {
              date, agent: 'claude', models: model ? [model] : [],
              input, output, cacheCreate: cc, cacheRead: cr,
              totalTokens: input + output + cc + cr, cost,
              modelBreakdown: [],
            });
          }

          // 按日期+模型聚合
          let dm = dayModelMap.get(date);
          if (!dm) { dm = new Map(); dayModelMap.set(date, dm); }
          const dmb = dm.get(model);
          if (dmb) {
            dmb.input += input; dmb.output += output;
            dmb.cacheCreate += cc; dmb.cacheRead += cr;
            dmb.cost += cost;
          } else {
            dm.set(model, { model, input, output, cacheRead: cr, cacheCreate: cc, cost });
          }

          // 全部模型聚合
          const mb = modelMap.get(model);
          if (mb) {
            mb.input += input; mb.output += output;
            mb.cacheCreate += cc; mb.cacheRead += cr;
            mb.cost += cost;
          } else {
            modelMap.set(model, { model, input, output, cacheRead: cr, cacheCreate: cc, cost });
          }
        } catch { /* 单行 JSON 解析失败，跳过 */ }
      }
    } catch (e) {
      console.error('[vscode-cc-statistics] parseAll 读取文件失败:', file, e);
    }
  }

  // 把每天的分模型数据挂到对应 entry 上
  for (const [date, dm] of dayModelMap) {
    const entry = dayMap.get(date);
    if (entry) {
      entry.modelBreakdown = Array.from(dm.values())
        .filter(m => m.input > 0 || m.output > 0)
        .sort((a, b) => b.cost - a.cost);
    }
  }

  return { dayMap, modelMap };
}

async function parseHermes(home: string): Promise<{
  dayMap: Map<string, DailyEntry>;
  modelMap: Map<string, ModelCost>;
}> {
  const dayMap = new Map<string, DailyEntry>();
  const modelMap = new Map<string, ModelCost>();
  const dayModelMap = new Map<string, Map<string, ModelCost>>();

  try {
    const dbPath = path.join(home, '.hermes', 'state.db');
    const { stdout: output } = await execFileAsync('sqlite3', [
      dbPath, '-readonly', '-csv', '-noheader',
      "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at FROM sessions WHERE billing_provider = 'deepseek' AND (input_tokens > 0 OR output_tokens > 0)",
    ], { encoding: 'utf-8', timeout: 5000, windowsHide: true });

    for (const line of output.trim().split('\n')) {
      if (!line) continue;
      // CSV 解析：处理带引号的字段
      const parts = parseCSVLine(line);
      if (parts.length < 6) continue;
      const model = parts[0] || 'unknown';
      const input = Number(parts[1]) || 0;
      const output = Number(parts[2]) || 0;
      const cacheRead = Number(parts[3]) || 0;
      const cacheWrite = Number(parts[4]) || 0;
      const startedAt = Number(parts[5]) || 0;
      if (startedAt === 0) continue;

      const date = new Date(startedAt * 1000).toISOString().slice(0, 10);
      const p = PRICING[model] || PRICING['deepseek-v4-pro'];
      const cost = (input + cacheWrite) / 1e6 * p.in + output / 1e6 * p.out + cacheRead / 1e6 * p.cache;

      // 按日期聚合
      const day = dayMap.get(date);
      if (day) {
        day.input += input; day.output += output;
        day.cacheCreate += cacheWrite; day.cacheRead += cacheRead;
        day.totalTokens += input + output + cacheWrite + cacheRead;
        day.cost += cost;
        if (model && !day.models.includes(model)) day.models.push(model);
      } else {
        dayMap.set(date, {
          date, agent: 'hermes', models: model ? [model] : [],
          input, output, cacheCreate: cacheWrite, cacheRead,
          totalTokens: input + output + cacheWrite + cacheRead, cost,
          modelBreakdown: [],
        });
      }

      // 按日期+模型聚合
      let dm = dayModelMap.get(date);
      if (!dm) { dm = new Map(); dayModelMap.set(date, dm); }
      const dmb = dm.get(model);
      if (dmb) {
        dmb.input += input; dmb.output += output;
        dmb.cacheCreate += cacheWrite; dmb.cacheRead += cacheRead;
        dmb.cost += cost;
      } else {
        dm.set(model, { model, input, output, cacheRead, cacheCreate: cacheWrite, cost });
      }

      // 全部模型聚合
      const mb = modelMap.get(model);
      if (mb) {
        mb.input += input; mb.output += output;
        mb.cacheCreate += cacheWrite; mb.cacheRead += cacheRead;
        mb.cost += cost;
      } else {
        modelMap.set(model, { model, input, output, cacheRead, cacheCreate: cacheWrite, cost });
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[vscode-cc-statistics] parseHermes 错误:', e);
    }
  }

  // 把每天的分模型数据挂到对应 entry 上
  for (const [date, dm] of dayModelMap) {
    const entry = dayMap.get(date);
    if (entry) {
      entry.modelBreakdown = Array.from(dm.values())
        .filter(m => m.input > 0 || m.output > 0)
        .sort((a, b) => b.cost - a.cost);
    }
  }

  return { dayMap, modelMap };
}

/** DeepSeek 平台 API 缓存的完整格式 */
type DsDayModel = { tokens: Record<string, number>; cost: number };
type DsDayMap = Record<string, DsDayModel>;
interface DsUsageCache {
  month: string;
  updatedAt: string;
  models: Record<string, {
    cost: { prompt: number; cacheHit: number; cacheMiss: number; response: number; total: number };
    tokens?: { prompt: number; cacheHit: number; cacheMiss: number; response: number; requests: number };
  }>;
  totalCost: number;
  days?: Record<string, DsDayMap>;
  balance?: number;
}

let _lastLiveFetch = 0;
let _fetching = false;
const LIVE_FETCH_INTERVAL = 2 * 60 * 1000;

/** DeepSeek 平台数据：优先调 fetch_deepseek.js 实时拉（限频+互斥锁），失败降级读缓存 */
async function fetchDeepSeekPlatformUsage(home: string): Promise<DsUsageCache | null> {
  const scriptPath = path.join(home, '.claude', 'fetch_deepseek.js');
  if (Date.now() - _lastLiveFetch > LIVE_FETCH_INTERVAL && !_fetching) {
    _fetching = true;
    try {
      _lastLiveFetch = Date.now();
      const { stdout } = await execFileAsync('node', [scriptPath], {
        encoding: 'utf-8', timeout: 15_000, windowsHide: true,
      });
      const parsed = JSON.parse(stdout.trim());
      if (parsed.ok && parsed.data) return parsed.data as DsUsageCache;
    } catch {
      // 实时拉取失败，降级读缓存
    } finally {
      _fetching = false;
    }
  }
  // 读缓存
  try {
    const raw = fs.readFileSync(path.join(home, '.claude', 'deepseek_usage.json'), 'utf-8');
    const data = JSON.parse(raw);
    const updatedTs = new Date(data.updatedAt).getTime();
    // 修复：无效日期视为缓存过期
    if (isNaN(updatedTs) || Date.now() - updatedTs > 2 * 60 * 60 * 1000) return null;
    return data;
  } catch { return null; }
}

/** 将 DeepSeek 平台数据转为 ModelCost[]（月度模型费用拆分） */
function dsToModelBreakdown(ds: DsUsageCache | null): ModelCost[] {
  if (!ds) return [];
  return Object.entries(ds.models)
    .filter(([name]) => name !== 'deepseek-chat & deepseek-reasoner')
    .map(([model, m]) => ({
      model,
      input: (m.tokens?.cacheMiss || 0) + (m.tokens?.prompt || 0),
      output: m.tokens?.response || 0,
      cacheRead: m.tokens?.cacheHit || 0,
      cacheCreate: 0,
      cost: m.cost.total,
    }))
    .sort((a, b) => b.cost - a.cost);
}

/** 加载所有 DeepSeek 历史月份缓存文件的每日数据 */
function loadDSHistoryDays(home: string): Record<string, DsDayMap> {
  const allDays: Record<string, DsDayMap> = {};
  const claudeDir = path.join(home, '.claude');
  try {
    for (const f of fs.readdirSync(claudeDir)) {
      if (!f.startsWith('deepseek_usage') || !f.endsWith('.json')) continue;
      try {
        const raw = fs.readFileSync(path.join(claudeDir, f), 'utf-8');
        const data = JSON.parse(raw);
        if (data.days) {
          for (const [date, dm] of Object.entries(data.days) as [string, DsDayMap][]) {
            let dayCost = 0;
            for (const m of Object.values(dm)) dayCost += (m as DsDayModel).cost || 0;
            if (dayCost > 0) allDays[date] = dm;
          }
        }
      } catch { /* 个别历史文件解析失败，跳过 */ }
    }
  } catch {
    // .claude 目录不存在
  }
  return allDays;
}

/** 将 DS 某天的数据转为 DailyEntry */
function dsDayToEntry(date: string, dm: DsDayMap): DailyEntry {
  let totalTokens = 0, totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCost = 0;
  const ml: string[] = [];
  const breakdown: ModelCost[] = [];
  for (const [model, m] of Object.entries(dm) as [string, DsDayModel][]) {
    if (model === 'deepseek-chat & deepseek-reasoner') continue;
    const t = m.tokens || {};
    const input = (t.cacheMiss || 0) + (t.prompt || 0);
    const output = t.response || 0;
    const cacheRead = t.cacheHit || 0;
    const tokens = input + output + cacheRead;
    totalTokens += tokens;
    totalInput += input;
    totalOutput += output;
    totalCacheRead += cacheRead;
    totalCost += m.cost;
    ml.push(model);
    breakdown.push({
      model,
      input,
      output,
      cacheRead,
      cacheCreate: 0,
      cost: m.cost,
    });
  }
  return {
    date, agent: 'deepseek',
    models: ml,
    input: totalInput, output: totalOutput, cacheCreate: 0, cacheRead: totalCacheRead,
    totalTokens,
    cost: totalCost,
    modelBreakdown: breakdown.sort((a, b) => b.cost - a.cost),
  };
}

export function fetchCcUsage(workspaceRoot: string): CcUsageResult | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectDir = path.join(home, '.claude', 'projects',
    workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'));
  const { dayMap, modelMap } = parseAll(projectDir);
  const entries = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  const totals = {
    input: entries.reduce((s, e) => s + e.input, 0),
    output: entries.reduce((s, e) => s + e.output, 0),
    cacheCreate: entries.reduce((s, e) => s + e.cacheCreate, 0),
    cacheRead: entries.reduce((s, e) => s + e.cacheRead, 0),
    totalTokens: entries.reduce((s, e) => s + e.totalTokens, 0),
    cost: entries.reduce((s, e) => s + e.cost, 0),
  };
  const modelBreakdown = Array.from(modelMap.values())
    .filter(m => m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost);
  return { entries, totals, modelBreakdown };
}

export function getMemoryFiles(workspaceRoot: string): string[] {
  const d = path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'projects',
    workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  try {
    return fs.readdirSync(d).filter(f => f.endsWith('.md') && f !== 'MEMORY.md').map(f => f.replace('.md', ''));
  } catch { /* 目录不存在 */ return []; }
}

/** 技能中文描述（代码内置默认值，可被 ~/.claude/skill-desc.json 覆盖） */
const SKILL_CN: Record<string, string> = {
  'brainstorming': '通过自然对话将想法转化为完整设计方案',
  'claude-vision-skill': '提供识图能力，将剪贴板图片发送给视觉模型分析',
  'deep-research': '多源深度研究，自动搜索、验证并生成带引用的报告',
  'dispatching-parallel-agents': '将任务分派给多个专用子代理并行执行，互不干扰',
  'doc-coauthoring': '引导用户通过三阶段协作完成文档创作：收集上下文→精炼结构→读者测试',
  'docx': 'Word 文档创建、编辑和分析',
  'executing-plans': '加载实现计划，逐一执行所有任务并报告完成状态',
  'find-skills': '帮助用户发现和安装可用的技能',
  'finishing-a-development-branch': '引导完成开发分支的收尾工作，给出清晰的选项',
  'frontend-design': '创建独特的生产级前端界面，注重美学细节和创意，避免通用 AI 风格',
  'karpathy-guidelines': 'Karpathy 编码准则：编码前先思考、最简代码解决问题、精准修改不碰无关代码',
  'pdf': 'PDF 文件处理：读取、合并、拆分、旋转、加水印、OCR 识别',
  'pptx': 'PowerPoint 演示文稿创建',
  'receiving-code-review': '接收代码审查反馈，进行技术评估而非情绪反应',
  'requesting-code-review': '派发代码审查子代理，提前发现 bug 和简化机会',
  'skill-creator': '创建新技能并迭代改进',
  'subagent-driven-development': '每个任务派发独立子代理执行，完成后进行两阶段审查（规范+质量）',
  'systematic-debugging': '系统化调试方法论，避免随机修补造成新 bug',
  'test-driven-development': '测试驱动开发：先写测试→看它失败→写最小代码通过→重构',
  'using-git-worktrees': '在隔离的 Git 工作树中工作，保护主分支不受影响',
  'using-superpowers': '子代理执行说明，包含使用工作流和子代理的指引',
  'verification-before-completion': '未经验证就声称完成是不诚实的——完成前必须验证',
  'webapp-testing': '通过 Playwright 在浏览器中测试 Web 应用',
  'writing-plans': '编写零上下文也能执行的详细实现计划，包含文件路径、测试和验证方法',
  'writing-skills': '用 TDD 方法编写和迭代技能文档',
  'xlsx': 'Excel 电子表格创建和处理',
};

/** 加载技能中文描述：自定义 JSON > 代码内置默认 */
function loadSkillDesc(): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const merged = { ...SKILL_CN };
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'skill-desc.json'), 'utf-8'));
    Object.assign(merged, custom); // 用户自定义覆盖默认
  } catch { /* 文件不存在或格式错误 */ }
  return merged;
}

/** 从技能文件中读取描述（跳过 YAML 前置元数据） */
function readSkillDesc(skillDir: string): string {
  for (const f of ['CLAUDE.md', 'SKILL.md']) {
    try {
      const content = fs.readFileSync(path.join(skillDir, f), 'utf-8');
      const lines = content.split('\n');
      let inFrontmatter = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '---') {
          if (inFrontmatter) { inFrontmatter = false; continue; }
          inFrontmatter = true; continue;
        }
        if (inFrontmatter) continue;
        const text = trimmed.replace(/^#+\s*/, '').trim();
        if (text) return text;
      }
    } catch { /* 文件不存在 */ }
  }
  return '';
}

export function getSkills(workspaceRoot: string): { name: string; description: string }[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  // name → fullPath（用于回退读文件）
  const descMap = loadSkillDesc();
  const skillPaths = new Map<string, string>();
  const dirs = [
    path.join(home, '.claude', 'skills'),
    path.join(workspaceRoot, '.claude', 'skills'),
  ];
  for (const d of dirs) {
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const fullPath = path.join(d, entry.name);
        let isDir = entry.isDirectory();
        if (!isDir) {
          try { isDir = fs.statSync(fullPath).isDirectory(); } catch {}
        }
        if (isDir && !skillPaths.has(entry.name)) {
          skillPaths.set(entry.name, fullPath);
        }
      }
    } catch { /* 目录不存在 */ }
  }
  return Array.from(skillPaths.entries())
    .map(([name, p]) => ({
      name,
      description: descMap[name] || readSkillDesc(p),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getProjectFiles(workspaceRoot: string): string[] {
  try {
    return fs.readdirSync(workspaceRoot)
      .filter(f => /\.(md|py|ts|json)$/.test(f))
      .slice(0, 20);
  } catch { /* 目录不存在 */ return []; }
}

export function getMcpServers(workspaceRoot: string): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const servers = new Set<string>();

  // 检查多个配置来源
  const sources = [
    path.join(home, '.claude', 'mcp.json'),
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(workspaceRoot, '.mcp.json'),
  ];

  for (const p of sources) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (cfg.mcpServers) {
        Object.keys(cfg.mcpServers).forEach(s => servers.add(s));
      }
      if (cfg.mcp) {
        Object.keys(cfg.mcp).forEach(s => servers.add(s));
      }
      // settings.local.json 用 enabledMcpjsonServers 数组
      if (cfg.enabledMcpjsonServers) {
        cfg.enabledMcpjsonServers.forEach((s: string) => servers.add(s));
      }
    } catch { /* 配置文件不存在或格式错误 */ }
  }

  // 检测项目级 codegraph（.codegraph/ 目录存在即认为已注册）
  try {
    if (fs.statSync(path.join(workspaceRoot, '.codegraph')).isDirectory()) {
      servers.add('codegraph');
    }
  } catch { /* .codegraph 目录不存在 */ }

  return Array.from(servers);
}

export async function buildStatsMessage(workspaceRoot: string): Promise<StatsMessage> {
  const result = fetchCcUsage(workspaceRoot);
  let entries: DailyEntry[] = result?.entries || [];
  let today = entries[entries.length - 1] || null;

  // 本月汇总：用 UTC 月份，与 DeepSeek 官网一致
  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthEntries = entries.filter(e => e.date.startsWith(monthPrefix));
  const monthlyTotals = {
    input: monthEntries.reduce((s, e) => s + e.input, 0),
    output: monthEntries.reduce((s, e) => s + e.output, 0),
    cacheCreate: monthEntries.reduce((s, e) => s + e.cacheCreate, 0),
    cacheRead: monthEntries.reduce((s, e) => s + e.cacheRead, 0),
    totalTokens: monthEntries.reduce((s, e) => s + e.totalTokens, 0),
    cost: monthEntries.reduce((s, e) => s + e.cost, 0),
  };
  // 当前项目本月模型拆分
  const monthModelMap = new Map<string, ModelCost>();
  for (const e of monthEntries) {
    for (const m of e.modelBreakdown || []) {
      const existing = monthModelMap.get(m.model);
      if (existing) {
        existing.input += m.input; existing.output += m.output;
        existing.cacheCreate += m.cacheCreate; existing.cacheRead += m.cacheRead;
        existing.cost += m.cost;
      } else {
        monthModelMap.set(m.model, { ...m });
      }
    }
  }

  // 扫描所有项目计算全局总费用 & 月度其他费用
  let globalCost = result?.totals.cost || 0;
  let otherCost = 0;
  let monthlyOtherCost = 0;
  const globalModelMap = new Map<string, ModelCost>();
  // 先合并当前项目的模型数据
  for (const m of result?.modelBreakdown || []) {
    globalModelMap.set(m.model, { ...m });
  }
  // 扫描其他项目
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectsDir = path.join(home, '.claude', 'projects');
  const currentSlug = workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      if (dir === currentSlug) continue;
      const full = path.join(projectsDir, dir);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch { /* stat 失败，跳过 */ continue; }
      const other = parseAll(full);
      let otherSum = 0;
      for (const [model, mc] of other.modelMap) {
        otherSum += mc.cost;
        const existing = globalModelMap.get(model);
        if (existing) {
          existing.input += mc.input; existing.output += mc.output;
          existing.cacheCreate += mc.cacheCreate; existing.cacheRead += mc.cacheRead;
          existing.cost += mc.cost;
        } else {
          globalModelMap.set(model, { ...mc });
        }
      }
      otherCost += otherSum;
      globalCost += otherSum;
      // 月度：按日期过滤其他项目
      for (const [date, entry] of other.dayMap) {
        if (date.startsWith(monthPrefix)) {
          monthlyOtherCost += entry.cost;
          for (const m of entry.modelBreakdown || []) {
            const existing = monthModelMap.get(m.model);
            if (existing) {
              existing.input += m.input; existing.output += m.output;
              existing.cacheCreate += m.cacheCreate; existing.cacheRead += m.cacheRead;
              existing.cost += m.cost;
            } else {
              monthModelMap.set(m.model, { ...m });
            }
          }
        }
      }
    }
  } catch { /* projects 目录不存在 */ }

  // 合并 Hermes（DeepSeek API）消耗
  const hermes = await parseHermes(home);
  let hermesSum = 0;
  for (const [model, mc] of hermes.modelMap) {
    hermesSum += mc.cost;
    const existing = globalModelMap.get(model);
    if (existing) {
      existing.input += mc.input; existing.output += mc.output;
      existing.cacheCreate += mc.cacheCreate; existing.cacheRead += mc.cacheRead;
      existing.cost += mc.cost;
    } else {
      globalModelMap.set(model, { ...mc });
    }
  }
  otherCost += hermesSum;
  globalCost += hermesSum;
  for (const [date, entry] of hermes.dayMap) {
    if (date.startsWith(monthPrefix)) {
      monthlyOtherCost += entry.cost;
      for (const m of entry.modelBreakdown || []) {
        const existing = monthModelMap.get(m.model);
        if (existing) {
          existing.input += m.input; existing.output += m.output;
          existing.cacheCreate += m.cacheCreate; existing.cacheRead += m.cacheRead;
          existing.cost += m.cost;
        } else {
          monthModelMap.set(m.model, { ...m });
        }
      }
    }
  }

  let monthlyGlobalCost = monthlyTotals.cost + monthlyOtherCost;
  const globalModelBreakdown = Array.from(globalModelMap.values())
    .filter(m => m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost);
  let monthlyModelBreakdown = Array.from(monthModelMap.values())
    .filter(m => m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost);

  // DeepSeek 平台实时数据，覆盖本月汇总 + 今日
  // DS 数据已包含所有项目 + Hermes，所以覆盖后 other/global 也以它为准
  const ds = await fetchDeepSeekPlatformUsage(home);
  const dsBreakdown = dsToModelBreakdown(ds);
  if (ds && ds.totalCost > 0) {
    // 汇总 DS 所有模型的 token 数，覆盖 monthlyTotals
    let dsInput = 0, dsOutput = 0, dsCacheRead = 0, dsCacheCreate = 0;
    for (const m of dsBreakdown) {
      dsInput += m.input;
      dsOutput += m.output;
      dsCacheRead += m.cacheRead;
      dsCacheCreate += m.cacheCreate;
    }
    monthlyTotals.input = dsInput;
    monthlyTotals.output = dsOutput;
    monthlyTotals.cacheRead = dsCacheRead;
    monthlyTotals.cacheCreate = dsCacheCreate;
    monthlyTotals.totalTokens = dsInput + dsOutput + dsCacheRead + dsCacheCreate;
    monthlyTotals.cost = ds.totalCost;
    monthlyModelBreakdown = dsBreakdown;
    monthlyOtherCost = 0;
    monthlyGlobalCost = ds.totalCost;
    // 用 DS 每日数据覆盖"今日消耗"（取最新有数据的日期）
    if (ds.days) {
      const dsDates = Object.keys(ds.days).sort();
      const latestDate = dsDates[dsDates.length - 1];
      if (latestDate) {
        today = dsDayToEntry(latestDate, ds.days[latestDate]);
      }
    }
  }

  // 合并 DS 历史月份每日数据到 allDays（DS 平台真实账单优先，本地 JSONL 补充）
  const dsHistoryDays = loadDSHistoryDays(home);
  const dsDateSet = new Set(Object.keys(dsHistoryDays));
  // 移除本地数据中 DS 已覆盖的日期，用 DS 数据替换
  entries = entries.filter(e => !dsDateSet.has(e.date));
  for (const [date, dm] of Object.entries(dsHistoryDays)) {
    entries.push(dsDayToEntry(date, dm));
  }
  entries.sort((a, b) => a.date.localeCompare(b.date));

  const hasData = entries.length > 0 && entries.some(e => e.totalTokens > 0);

  // 余额预警：从配置文件读取，未设置默认 10 元
  let balanceThreshold = 10;
  try {
    const authRaw = fs.readFileSync(path.join(home, '.claude', 'deepseek_auth.json'), 'utf-8');
    const auth = JSON.parse(authRaw);
    if (typeof auth.balanceThreshold === 'number' && auth.balanceThreshold > 0) {
      balanceThreshold = auth.balanceThreshold;
    }
  } catch { /* 配置文件不存在或格式错误，用默认值 */ }
  const balance = ds?.balance || 0;
  const overThreshold = (balance > 0 && balance < balanceThreshold);

  return {
    type: 'update',
    status: hasData ? 'ok' : 'empty',
    today,
    allDays: entries,
    totals: result?.totals || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, totalTokens: 0, cost: 0 },
    mcpServers: getMcpServers(workspaceRoot),
    memoryFiles: getMemoryFiles(workspaceRoot),
    projectFiles: getProjectFiles(workspaceRoot),
    skills: getSkills(workspaceRoot),
    modelBreakdown: globalModelBreakdown,
    globalCost,
    otherCost,
    monthlyTotals,
    monthlyModelBreakdown,
    monthlyOtherCost,
    monthlyGlobalCost,
    workspaceRoot,
    home,
    projectSlug: workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'),
    balance,
    overThreshold,
    balanceThreshold,
  };
}

export function startAutoRefresh(
  workspaceRoot: string,
  callback: (msg: StatsMessage) => void,
  interval = REFRESH_INTERVAL
): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = async () => {
    if (cancelled) return;
    try {
      const msg = await buildStatsMessage(workspaceRoot);
      if (!cancelled) callback(msg);
    } catch (e) {
      console.error('[vscode-cc-statistics] 自动刷新失败:', e);
    }
    if (!cancelled) {
      timer = setTimeout(tick, interval);
    }
  };
  tick();
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}
