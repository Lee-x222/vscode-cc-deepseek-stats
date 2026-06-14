import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { CcUsageResult, DailyEntry, ModelCost, McpServerInfo, McpServerStatus, StatsMessage } from './types';

const REFRESH_INTERVAL = 30_000;

// ====== 缓存层 ======
const _fullCache = new Map<string, { data: StatsMessage; ts: number }>();
const FULL_CACHE_TTL = 120_000;

let _skillsCache: { skills: { name: string; description: string }[]; ts: number } | null = null;
const SKILLS_CACHE_TTL = 600_000;  // 技能列表 10 分钟内不变

const _mcpCache = new Map<string, { data: McpServerInfo[]; ts: number }>();
const MCP_CACHE_TTL = 300_000;

const _mcpHealthCache = new Map<string, { data: McpServerStatus; ts: number }>();
const MCP_HEALTH_CACHE_TTL = 60_000;  // 健康检查结果 60 秒有效

const _memCache = new Map<string, { data: string[]; ts: number }>();
const MEM_CACHE_TTL = 300_000;

const _filesCache = new Map<string, { data: string[]; ts: number }>();
const FILES_CACHE_TTL = 60_000;

/** 通用缓存读取：命中且未过期返回 data，否则 null */
function cacheGet<T>(cache: Map<string, { data: T; ts: number }>, key: string, ttl: number): T | null {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttl) return entry.data;
  return null;
}

/** 通用缓存写入 */
function cacheSet<T>(cache: Map<string, { data: T; ts: number }>, key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}

// ====== JSONL 文件级解析缓存 ======
// JSONL 文件是追加写入的，旧内容永不改变 → 按 (路径 + mtime) 缓存解析结果
interface CachedLine {
  ts: string;       // timestamp
  date: string;     // YYYY-MM-DD
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  model: string;
  msgId: string;
}
const _parseFileCache = new Map<string, { mtime: number; lines: CachedLine[] }>();
const MAX_PARSE_CACHE_SIZE = 1000;

/** Map 超过上限时清掉最旧的一半条目，防止长期运行内存泄漏 */
function trimCache<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return;
  const toDelete = Math.floor(cache.size / 2);
  let i = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    if (++i >= toDelete) break;
  }
}

/** 从单个 JSONL 文件中提取 CachedLine[]，优先走缓存 */
function parseOneFile(file: string): CachedLine[] {
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return []; }

  const cached = _parseFileCache.get(file);
  if (cached && cached.mtime === mtime) {
    return cached.lines;
  }

  const lines: CachedLine[] = [];
  try {
    for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
      try {
        const e = JSON.parse(line);
        const msg = e.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        const ts = e.timestamp;
        if (!ts) continue;
        lines.push({
          ts,
          date: ts.slice(0, 10),
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          model: msg.model || 'unknown',
          msgId: msg.id || '',
        });
      } catch { /* 单行 JSON 解析失败，跳过 */ }
    }
  } catch (e) {
    console.error('[vscode-cc-deepseek-stats] parseOneFile 读取失败:', file, e);
  }

  _parseFileCache.set(file, { mtime, lines });
  trimCache(_parseFileCache, MAX_PARSE_CACHE_SIZE);
  return lines;
}

/** 收集目录下最近 N 天修改的 session 子目录中的 JSONL，recentDays=0 表示全量 */
function collectRecentJsonlFiles(dir: string, recentDays: number): string[] {
  const results: string[] = [];
  const cutoff = recentDays > 0 ? Date.now() - recentDays * 24 * 60 * 60 * 1000 : 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 如果是最外层 session 目录，做 mtime 过滤
        if (recentDays > 0) {
          try {
            if (fs.statSync(full).mtimeMs < cutoff) continue;
          } catch { continue; }
        }
        results.push(...collectRecentJsonlFiles(full, 0)); // 子目录不再过滤
      } else if (entry.name.endsWith('.jsonl')) {
        results.push(full);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[vscode-cc-deepseek-stats] collectRecentJsonlFiles 错误:', e);
    }
  }
  return results;
}

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

/** 将单条使用记录聚合到 dayMap / modelMap / dayModelMap（parseAll & parseHermes 共用） */
function addUsageToMaps(
  date: string, input: number, output: number, cacheCreate: number, cacheRead: number,
  model: string, agent: string,
  dayMap: Map<string, DailyEntry>,
  modelMap: Map<string, ModelCost>,
  dayModelMap: Map<string, Map<string, ModelCost>>,
): void {
  const p = PRICING[model] || PRICING['deepseek-v4-pro'];
  const cost = (input + cacheCreate) / 1e6 * p.in + output / 1e6 * p.out + cacheRead / 1e6 * p.cache;

  // 按日期聚合
  const day = dayMap.get(date);
  if (day) {
    day.input += input; day.output += output;
    day.cacheCreate += cacheCreate; day.cacheRead += cacheRead;
    day.totalTokens += input + output + cacheCreate + cacheRead;
    day.cost += cost;
    if (model && !day.models.includes(model)) day.models.push(model);
  } else {
    dayMap.set(date, {
      date, agent, models: model ? [model] : [],
      input, output, cacheCreate, cacheRead,
      totalTokens: input + output + cacheCreate + cacheRead, cost,
      modelBreakdown: [],
    });
  }

  // 按日期+模型
  let dm = dayModelMap.get(date);
  if (!dm) { dm = new Map(); dayModelMap.set(date, dm); }
  const dmb = dm.get(model);
  if (dmb) {
    dmb.input += input; dmb.output += output;
    dmb.cacheCreate += cacheCreate; dmb.cacheRead += cacheRead;
    dmb.cost += cost;
  } else {
    dm.set(model, { model, input, output, cacheRead, cacheCreate, cost });
  }

  // 全量模型
  const mb = modelMap.get(model);
  if (mb) {
    mb.input += input; mb.output += output;
    mb.cacheCreate += cacheCreate; mb.cacheRead += cacheRead;
    mb.cost += cost;
  } else {
    modelMap.set(model, { model, input, output, cacheRead, cacheCreate, cost });
  }
}

/** 把 dayModelMap 中的分模型数据挂到 dayMap 的每个 entry 上 */
function attachModelBreakdowns(
  dayMap: Map<string, DailyEntry>,
  dayModelMap: Map<string, Map<string, ModelCost>>,
): void {
  for (const [date, dm] of dayModelMap) {
    const entry = dayMap.get(date);
    if (entry) {
      entry.modelBreakdown = Array.from(dm.values())
        .filter(m => m.input > 0 || m.output > 0)
        .sort((a, b) => b.cost - a.cost);
    }
  }
}

function parseAll(dir: string, recentDays = 0): {
  dayMap: Map<string, DailyEntry>;
  modelMap: Map<string, ModelCost>;
} {
  const dayMap = new Map<string, DailyEntry>();
  const modelMap = new Map<string, ModelCost>();
  const dayModelMap = new Map<string, Map<string, ModelCost>>();
  const seenIds = new Set<string>();

  const files = recentDays > 0
    ? collectRecentJsonlFiles(dir, recentDays)
    : collectRecentJsonlFiles(dir, 0);

  for (const file of files) {
    for (const cl of parseOneFile(file)) {
      if (cl.msgId && seenIds.has(cl.msgId)) continue;
      if (cl.msgId) seenIds.add(cl.msgId);
      addUsageToMaps(cl.date, cl.input, cl.output, cl.cacheCreate, cl.cacheRead, cl.model, 'claude', dayMap, modelMap, dayModelMap);
    }
  }

  attachModelBreakdowns(dayMap, dayModelMap);
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
      addUsageToMaps(date, input, output, cacheWrite, cacheRead, model, 'hermes', dayMap, modelMap, dayModelMap);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[vscode-cc-deepseek-stats] parseHermes 错误:', e);
    }
  }

  attachModelBreakdowns(dayMap, dayModelMap);
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
  const scriptPath = path.resolve(__dirname, '..', 'fetch_deepseek.js');
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

export function fetchCcUsage(workspaceRoot: string, recentDays = 0): CcUsageResult | null {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const projectDir = path.join(home, '.claude', 'projects',
    workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'));
  const { dayMap, modelMap } = parseAll(projectDir, recentDays);
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

export function getMcpServers(workspaceRoot: string): McpServerInfo[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const serverMap = new Map<string, McpServerInfo>();

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

      // 完整 server config（mcp.json / .mcp.json）
      if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
        for (const [name, serverCfg] of Object.entries(cfg.mcpServers)) {
          if (serverCfg && typeof serverCfg === 'object') {
            const sc = serverCfg as any;
            // 推断 type：无 type 字段时按 url/command 自动判断
            const inferredType = sc.type || (sc.url ? 'sse' : sc.command ? 'stdio' : undefined);
            // 尝试读取缓存的健康状态
            const healthKey = `${workspaceRoot}::${name}`;
            const cachedHealth = cacheGet(_mcpHealthCache, healthKey, MCP_HEALTH_CACHE_TTL);
            serverMap.set(name, {
              name,
              type: inferredType,
              url: sc.url || undefined,
              command: sc.command || undefined,
              args: Array.isArray(sc.args) ? sc.args as string[] : undefined,
              status: cachedHealth || 'unknown',
            });
          }
        }
      }

      // 旧版 mcp 字段（部分 settings 文件）
      if (cfg.mcp && typeof cfg.mcp === 'object') {
        for (const name of Object.keys(cfg.mcp)) {
          if (!serverMap.has(name)) {
            serverMap.set(name, { name, status: 'unknown' });
          }
        }
      }

      // settings.local.json 用 enabledMcpjsonServers 数组
      if (cfg.enabledMcpjsonServers) {
        for (const s of (cfg.enabledMcpjsonServers as string[])) {
          if (!serverMap.has(s)) {
            serverMap.set(s, { name: s, status: 'unknown' });
          }
        }
      }
    } catch { /* 配置文件不存在或格式错误 */ }
  }

  // 检测项目级 codegraph（.codegraph/ 目录存在即认为已注册）
  try {
    if (fs.statSync(path.join(workspaceRoot, '.codegraph')).isDirectory()) {
      if (!serverMap.has('codegraph')) {
        serverMap.set('codegraph', { name: 'codegraph', type: 'stdio', status: 'unknown' });
      }
    }
  } catch { /* .codegraph 目录不存在 */ }

  return Array.from(serverMap.values());
}

// ====== 带缓存的辅助读取函数（避免每次刷新都读文件） ======

function getSkillsCached(workspaceRoot: string): { name: string; description: string }[] {
  const key = workspaceRoot;
  if (_skillsCache && Date.now() - _skillsCache.ts < SKILLS_CACHE_TTL) {
    return _skillsCache.skills;
  }
  const skills = getSkills(workspaceRoot);
  _skillsCache = { skills, ts: Date.now() };
  return skills;
}

function getMcpServersCached(workspaceRoot: string): McpServerInfo[] {
  const key = workspaceRoot;
  const hit = cacheGet(_mcpCache, key, MCP_CACHE_TTL);
  if (hit) return hit;
  const servers = getMcpServers(workspaceRoot);
  cacheSet(_mcpCache, key, servers);
  return servers;
}

// ====== MCP 健康检查 ======

/** TCP connect 检测 SSE 服务器连通性，超时 timeoutMs ms */
async function checkSseHealth(url: string, timeoutMs = 3000): Promise<McpServerStatus> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'offline';  // URL 格式错误
  }
  const host = parsed.hostname;
  const port = parseInt(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (status: McpServerStatus) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(status);
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done('online'));
    sock.on('timeout', () => done('offline'));
    sock.on('error', () => done('offline'));

    sock.connect(port, host);
  });
}

/** 从 stdio server config 提取进程检测用特征串 */
function getSearchPattern(srv: McpServerInfo): string | null {
  const args = srv.args;
  if (args && args.length > 0) {
    for (const arg of args) {
      if (arg.startsWith('-') || arg.startsWith('--')) continue;
      const parts = arg.replace(/\\/g, '/').split('/');
      const last = parts[parts.length - 1];
      const withoutExt = last.replace(/\.(js|py|mjs|cjs|ts)$/i, '');
      if (withoutExt.length >= 4) return withoutExt;
    }
    const first = args.find(a => !a.startsWith('-') && !a.startsWith('--'));
    if (first) {
      const parts = first.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1].replace(/\.(js|py|mjs|cjs|ts)$/i, '');
    }
  }
  if (srv.command) {
    return path.basename(srv.command).replace(/\.exe$/i, '');
  }
  return null;
}

/** 用 PowerShell 批量检测 stdio 进程是否在运行（一次查询所有 server） */
async function checkStdioProcesses(servers: McpServerInfo[]): Promise<Map<string, boolean>> {
  const result = new Map<string, boolean>();
  const stdioServers = servers.filter(s =>
    (s.type === 'stdio' || (!s.type && s.command && !s.url)) && s.command
  );

  if (stdioServers.length === 0) return result;

  const patterns: { name: string; exe: string; pattern: string }[] = [];
  for (const srv of stdioServers) {
    const pattern = getSearchPattern(srv);
    if (!pattern) continue;
    const cmdBase = path.basename(srv.command || '').toLowerCase();
    const exe = (cmdBase === 'npx' || cmdBase === 'npm' || cmdBase === 'npx.cmd' || cmdBase === 'npm.cmd')
      ? 'node.exe' : cmdBase.includes('.') ? cmdBase : `${cmdBase}.exe`;
    patterns.push({ name: srv.name, exe, pattern });
  }

  if (patterns.length === 0) return result;

  for (const p of patterns) result.set(p.name, false);

  try {
    const uniqueExes = [...new Set(patterns.map(p => p.exe))];
    const filter = uniqueExes.map(e => `Name='${e}'`).join(' or ');
    const clauses = patterns.map(p => `\$_.CommandLine -like '*${p.pattern}*'`).join(' -or ');

    const psScript = `Get-CimInstance Win32_Process -Filter "${filter}" | Where-Object { ${clauses} } | ForEach-Object { \$_.CommandLine }`;

    const { stdout } = await promisify(execFile)(
      'powershell.exe', ['-NoProfile', '-Command', psScript],
      { timeout: 8000, maxBuffer: 512 * 1024 }
    );

    const output = stdout || '';
    for (const p of patterns) {
      if (output.includes(p.pattern)) {
        result.set(p.name, true);
      }
    }
  } catch {
    for (const srv of stdioServers) {
      const cmd = srv.command!;
      if (path.isAbsolute(cmd)) {
        try {
          await fs.promises.access(cmd, fs.constants.X_OK);
          result.set(srv.name, true);
        } catch {
          result.set(srv.name, false);
        }
      } else {
        result.set(srv.name, true);
      }
    }
  }

  return result;
}

/** 并行健康检查所有 MCP 服务器（SSE: TCP connect, stdio: PowerShell 进程检测） */
async function enrichMcpHealth(workspaceRoot: string, servers: McpServerInfo[]): Promise<McpServerInfo[]> {
  // 只信任已确认的 'online' 缓存；'offline'/'unknown' 每次重新验证（进程可能刚起来）
  const uncached: McpServerInfo[] = [];
  for (const srv of servers) {
    const healthKey = `${workspaceRoot}::${srv.name}`;
    const cached = cacheGet(_mcpHealthCache, healthKey, MCP_HEALTH_CACHE_TTL);
    if (cached === 'online') {
      srv.status = 'online';  // 已确认在线，信任缓存
    } else {
      uncached.push(srv);     // 离线/未知/过期 → 重新检测
    }
  }

  if (uncached.length === 0) return servers;

  const processResults = await checkStdioProcesses(uncached);

  const sseChecks = uncached
    .filter(s => (s.type === 'sse' || (!s.type && s.url)) && s.url)
    .map(async (srv) => {
      const status = await checkSseHealth(srv.url!);
      srv.status = status;
      cacheSet(_mcpHealthCache, `${workspaceRoot}::${srv.name}`, status);
      return srv;
    });

  // 如果所有 stdio 都离线 → 大概率是 CC 刚重启进程还没起来，标灰避免误导
  const stdioResults = Array.from(processResults.values());
  const allStdioOffline = stdioResults.length > 0 && stdioResults.every(v => !v);

  for (const srv of uncached) {
    if (srv.type === 'sse' || (!srv.type && srv.url)) continue;
    const healthKey = `${workspaceRoot}::${srv.name}`;
    if (processResults.has(srv.name)) {
      const online = processResults.get(srv.name);
      srv.status = online ? 'online' : (allStdioOffline ? 'unknown' : 'offline');
    } else {
      srv.status = 'unknown';
    }
    cacheSet(_mcpHealthCache, healthKey, srv.status);
  }

  await Promise.allSettled(sseChecks);
  return servers;
}

function getMemoryFilesCached(workspaceRoot: string): string[] {
  const key = workspaceRoot;
  const hit = cacheGet(_memCache, key, MEM_CACHE_TTL);
  if (hit) return hit;
  const files = getMemoryFiles(workspaceRoot);
  cacheSet(_memCache, key, files);
  return files;
}

function getProjectFilesCached(workspaceRoot: string): string[] {
  const key = workspaceRoot;
  const hit = cacheGet(_filesCache, key, FILES_CACHE_TTL);
  if (hit) return hit;
  const files = getProjectFiles(workspaceRoot);
  cacheSet(_filesCache, key, files);
  return files;
}

// ====== 快速首屏消息（同步，仅当前项目） ======

/** 构建轻量级 StatsMessage — 只解析当前项目 JSONL + 缓存读其他数据，<200ms */
export function buildQuickMessage(workspaceRoot: string, recentDays = 7): StatsMessage {
  let result = fetchCcUsage(workspaceRoot, recentDays); // 默认只扫最近 7 天的 session
  // 月初边界兜底：recentDays 过滤后无数据时退到全量扫描
  if (recentDays > 0 && (!result || result.entries.length === 0)) {
    result = fetchCcUsage(workspaceRoot, 0);
  }
  const entries = result?.entries || [];
  let today: DailyEntry | null = entries[entries.length - 1] || null;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (today && today.date !== todayStr) today = null;

  // 本月汇总（当前项目）
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

  // 本月模型拆分
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

  const totals = result?.totals || { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, totalTokens: 0, cost: 0 };
  const modelBreakdown = result?.modelBreakdown || [];
  const hasData = entries.length > 0 && entries.some(e => e.totalTokens > 0);

  // 余额阈值 + API Key 检测（用于首次使用引导）
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let balanceThreshold = 10;
  let authConfigured = false;
  try {
    const authRaw = fs.readFileSync(path.join(home, '.claude', 'deepseek_auth.json'), 'utf-8');
    const auth = JSON.parse(authRaw);
    if (typeof auth.balanceThreshold === 'number' && auth.balanceThreshold > 0) {
      balanceThreshold = auth.balanceThreshold;
    }
    if (typeof auth.apiKey === 'string' && auth.apiKey.length > 0) {
      authConfigured = true;
    }
  } catch { /* 用默认值 */ }

  // 尝试读缓存 DS 数据获取余额（不从平台实时拉）
  let balance = 0;
  try {
    const dsRaw = fs.readFileSync(path.join(home, '.claude', 'deepseek_usage.json'), 'utf-8');
    const dsData = JSON.parse(dsRaw);
    if (dsData.balance) balance = dsData.balance;
  } catch { /* 无缓存 */ }

  const overThreshold = (balance > 0 && balance < balanceThreshold);

  return {
    type: 'update',
    status: hasData ? 'ok' : 'loading',
    today,
    allDays: entries,
    totals,
    mcpServers: getMcpServersCached(workspaceRoot),
    memoryFiles: getMemoryFilesCached(workspaceRoot),
    projectFiles: getProjectFilesCached(workspaceRoot),
    skills: getSkillsCached(workspaceRoot),
    modelBreakdown,
    globalCost: totals.cost,
    otherCost: 0,
    monthlyTotals,
    monthlyModelBreakdown: Array.from(monthModelMap.values())
      .filter(m => m.input > 0 || m.output > 0)
      .sort((a, b) => b.cost - a.cost),
    monthlyOtherCost: 0,
    monthlyGlobalCost: monthlyTotals.cost,
    workspaceRoot,
    home,
    projectSlug: workspaceRoot.replace(/[^a-zA-Z0-9]/g, '-'),
    balance,
    overThreshold,
    authConfigured,
    balanceThreshold,
  };
}

// ====== 异步丰富消息（其他项目 + Hermes + DeepSeek 平台） ======

/** 在快速消息基础上补充慢数据 — 其他项目扫描、Hermes DB、DeepSeek 平台实时用量 */
async function enrichMessage(workspaceRoot: string, base: StatsMessage): Promise<StatsMessage> {
  const home = base.home;
  const currentSlug = base.projectSlug;

  const now = new Date();
  const monthPrefix = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  // 累积器 —— 从 base 数据初始化
  let globalCost = base.globalCost;
  let otherCost = 0;
  let monthlyOtherCost = 0;
  const globalModelMap = new Map<string, ModelCost>();
  const monthModelMap = new Map<string, ModelCost>();
  for (const m of base.modelBreakdown) globalModelMap.set(m.model, { ...m });
  for (const m of base.monthlyModelBreakdown) monthModelMap.set(m.model, { ...m });

  // 先启动异步操作（外部进程 — 它们会并行运行）
  const hermesPromise = parseHermes(home);
  const dsPromise = fetchDeepSeekPlatformUsage(home);

  // 同步：扫描其他项目（利用异步进程启动后的等待时间）
  const projectsDir = path.join(home, '.claude', 'projects');
  try {
    for (const dir of fs.readdirSync(projectsDir)) {
      if (dir === currentSlug) continue;
      const full = path.join(projectsDir, dir);
      try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
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

  // 等待异步结果
  const [hermes, ds] = await Promise.all([hermesPromise, dsPromise]);

  // 合并 Hermes
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

  // 构建中间结果
  let monthlyGlobalCost = base.monthlyTotals.cost + monthlyOtherCost;
  const globalModelBreakdown = Array.from(globalModelMap.values())
    .filter(m => m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost);
  let monthlyModelBreakdown = Array.from(monthModelMap.values())
    .filter(m => m.input > 0 || m.output > 0)
    .sort((a, b) => b.cost - a.cost);

  // DeepSeek 平台数据覆盖
  let today = base.today;
  let monthlyTotals = { ...base.monthlyTotals };
  let allDays = [...base.allDays];
  let balance = base.balance;

  const dsBreakdown = dsToModelBreakdown(ds);
  if (ds && ds.totalCost > 0) {
    let dsInput = 0, dsOutput = 0, dsCacheRead = 0, dsCacheCreate = 0;
    for (const m of dsBreakdown) {
      dsInput += m.input;
      dsOutput += m.output;
      dsCacheRead += m.cacheRead;
      dsCacheCreate += m.cacheCreate;
    }
    monthlyTotals = {
      input: dsInput,
      output: dsOutput,
      cacheRead: dsCacheRead,
      cacheCreate: dsCacheCreate,
      totalTokens: dsInput + dsOutput + dsCacheRead + dsCacheCreate,
      cost: ds.totalCost,
    };
    monthlyModelBreakdown = dsBreakdown;
    monthlyOtherCost = 0;
    monthlyGlobalCost = ds.totalCost;
    balance = ds.balance || 0;

    if (ds.days) {
      const dsDates = Object.keys(ds.days).sort();
      const latestDate = dsDates[dsDates.length - 1];
      if (latestDate) {
        today = dsDayToEntry(latestDate, ds.days[latestDate]);
        const todayStr = new Date().toISOString().slice(0, 10);
        if (today && today.date !== todayStr) today = null;
      }
    }
  }

  // 合并 DS 历史月份每日数据
  const dsHistoryDays = loadDSHistoryDays(home);
  const dsDateSet = new Set(Object.keys(dsHistoryDays));
  allDays = allDays.filter(e => !dsDateSet.has(e.date));
  for (const [date, dm] of Object.entries(dsHistoryDays)) {
    allDays.push(dsDayToEntry(date, dm));
  }
  allDays.sort((a, b) => a.date.localeCompare(b.date));

  const hasData = allDays.length > 0 && allDays.some(e => e.totalTokens > 0);

  // 余额阈值 + API Key 检测（重新读，可能已变更）
  let balanceThreshold = base.balanceThreshold;
  let authConfigured = base.authConfigured;
  try {
    const authRaw = fs.readFileSync(path.join(home, '.claude', 'deepseek_auth.json'), 'utf-8');
    const auth = JSON.parse(authRaw);
    if (typeof auth.balanceThreshold === 'number' && auth.balanceThreshold > 0) {
      balanceThreshold = auth.balanceThreshold;
    }
    if (typeof auth.apiKey === 'string' && auth.apiKey.length > 0) {
      authConfigured = true;
    }
  } catch { /* 保持旧值 */ }

  const overThreshold = (balance > 0 && balance < balanceThreshold);

  // MCP 健康检查（异步，不阻塞首屏 — 首屏已通过 buildQuickMessage 显示灰色圆点）
  let enrichedMcpServers = base.mcpServers;
  if (enrichedMcpServers && enrichedMcpServers.length > 0) {
    enrichedMcpServers = await enrichMcpHealth(workspaceRoot, enrichedMcpServers);
  }

  return {
    ...base,
    status: hasData ? 'ok' : (base.status === 'ok' ? 'ok' : 'empty'),
    today,
    allDays,
    modelBreakdown: globalModelBreakdown,
    globalCost,
    otherCost,
    monthlyTotals,
    monthlyModelBreakdown,
    monthlyOtherCost,
    monthlyGlobalCost,
    mcpServers: enrichedMcpServers,
    balance,
    overThreshold,
    authConfigured,
    balanceThreshold,
  };
}

export async function buildStatsMessage(workspaceRoot: string): Promise<StatsMessage> {
  // recentDays=0 → 全量扫描（用于导出 CSV / 手动刷新）
  const quick = buildQuickMessage(workspaceRoot, 0);
  const full = await enrichMessage(workspaceRoot, quick);
  cacheSet(_fullCache, workspaceRoot, full); // 更新缓存，防止自动刷新吐出旧数据
  return full;
}

export function startAutoRefresh(
  workspaceRoot: string,
  callback: (msg: StatsMessage) => void,
  interval = REFRESH_INTERVAL
): () => void {
  let cancelled = false;
  let timer: NodeJS.Timeout | null = null;
  let isFirstTick = true;

  const tick = async () => {
    if (cancelled) return;
    try {
      if (isFirstTick) {
        // 首屏快速消息（同步，<200ms）
        const quickMsg = buildQuickMessage(workspaceRoot);
        if (!cancelled) {
          callback(quickMsg);
        }
        // 异步丰富（其他项目 + Hermes + DS 平台）
        const fullMsg = await enrichMessage(workspaceRoot, quickMsg);
        if (!cancelled) {
          cacheSet(_fullCache, workspaceRoot, fullMsg);
          callback(fullMsg);
        }
        isFirstTick = false;
      } else {
        // 后续 tick：优先走缓存，缓存未命中做无感刷新（只发一次消息）
        const fullCached = cacheGet(_fullCache, workspaceRoot, FULL_CACHE_TTL);
        if (fullCached) {
          if (!cancelled) callback(fullCached);
        } else {
          const fullMsg = await buildStatsMessage(workspaceRoot);
          if (!cancelled) {
            cacheSet(_fullCache, workspaceRoot, fullMsg);
            callback(fullMsg);
          }
        }
      }
    } catch (e) {
      console.error('[vscode-cc-deepseek-stats] 自动刷新失败:', e);
    }
    if (!cancelled) {
      timer = setTimeout(tick, interval);
    }
  };
  tick();
  return () => { cancelled = true; if (timer) clearTimeout(timer); };
}
