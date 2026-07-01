#!/usr/bin/env node
// diagnose_usage.js - 诊断本地JSONL费用 vs DeepSeek平台费用
// Usage: node tools/diagnose_usage.js [--month 2026-06]

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const MONTH = process.argv.includes('--month')
  ? process.argv[process.argv.indexOf('--month') + 1]
  : '2026-06';

// 定价表 (与 dataFetcher.ts 保持一致)
const PRICING = {
  'deepseek-v4-pro':   { in: 3,    out: 6,    cache: 0.025 },
  'deepseek-v4-flash': { in: 1,    out: 2,    cache: 0.02 },
};

function calcCost(model, input, output, cacheCreate, cacheRead) {
  const p = PRICING[model] || PRICING['deepseek-v4-pro'];
  return (input + cacheCreate) / 1e6 * p.in + output / 1e6 * p.out + cacheRead / 1e6 * p.cache;
}

// ===== 1. 解析 JSONL 文件 =====
function parseJsonlFile(filePath) {
  const lines = [];
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return lines; }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        const msg = e.message;
        if (!msg?.usage) continue;
        const u = msg.usage;
        const ts = e.timestamp;
        if (!ts) continue;
        lines.push({
          date: ts.slice(0, 10),
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          model: msg.model || 'unknown',
        });
      } catch {}
    }
  } catch {}
  return lines;
}

function scanProject(projectDir) {
  const results = { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, files: 0, requests: 0, byModel: {} };
  if (!fs.existsSync(projectDir)) return results;

  function walk(dir) {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); }
        else if (entry.name.endsWith('.jsonl')) {
          results.files++;
          for (const r of parseJsonlFile(full)) {
            if (!r.date.startsWith(MONTH)) continue;
            results.requests++;
            results.input += r.input;
            results.output += r.output;
            results.cacheCreate += r.cacheCreate;
            results.cacheRead += r.cacheRead;
            const cost = calcCost(r.model, r.input, r.output, r.cacheCreate, r.cacheRead);
            results.cost += cost;
            // 按模型
            if (!results.byModel[r.model]) results.byModel[r.model] = { cost: 0, input: 0, output: 0, cacheRead: 0, requests: 0 };
            results.byModel[r.model].cost += cost;
            results.byModel[r.model].input += r.input;
            results.byModel[r.model].output += r.output;
            results.byModel[r.model].cacheRead += r.cacheRead;
            results.byModel[r.model].requests++;
          }
        }
      }
    } catch {}
  }
  walk(projectDir);
  return results;
}

// ===== 2. 查询 Hermes SQLite =====
function scanHermes() {
  const result = { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0, byModel: {} };
  const dbPath = path.join(HOME, '.hermes', 'state.db');
  if (!fs.existsSync(dbPath)) { result.error = 'state.db not found'; return result; }

  try {
    const stdout = execFileSync('sqlite3', [
      dbPath, '-readonly', '-csv', '-noheader',
      "SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at FROM sessions WHERE billing_provider = 'deepseek' AND (input_tokens > 0 OR output_tokens > 0)"
    ], { encoding: 'utf-8', timeout: 5000 });

    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      // CSV 解析 (支持引号)
      const parts = [];
      let cur = '', inQ = false;
      for (const ch of line) {
        if (ch === '"') { inQ = !inQ; continue; }
        if (ch === ',' && !inQ) { parts.push(cur); cur = ''; continue; }
        cur += ch;
      }
      parts.push(cur);

      const model = parts[0] || 'unknown';
      const input = parseInt(parts[1]) || 0;
      const output = parseInt(parts[2]) || 0;
      const cacheRead = parseInt(parts[3]) || 0;
      const cacheCreate = parseInt(parts[4]) || 0;
      const startedAt = parts[5] || '';

      const date = startedAt.slice(0, 10);
      if (!date.startsWith(MONTH)) continue;

      result.requests++;
      result.input += input;
      result.output += output;
      result.cacheCreate += cacheCreate;
      result.cacheRead += cacheRead;
      const cost = calcCost(model, input, output, cacheCreate, cacheRead);
      result.cost += cost;

      if (!result.byModel[model]) result.byModel[model] = { cost: 0, input: 0, output: 0, cacheRead: 0, requests: 0 };
      result.byModel[model].cost += cost;
      result.byModel[model].input += input;
      result.byModel[model].output += output;
      result.byModel[model].cacheRead += cacheRead;
      result.byModel[model].requests++;
    }
  } catch (e) { result.error = e.message; }
  return result;
}

// ===== 3. 读取 DeepSeek 平台缓存 =====
function scanDSCache() {
  const results = [];
  const cacheDir = path.join(HOME, '.claude');
  try {
    for (const f of fs.readdirSync(cacheDir)) {
      if (!f.startsWith('deepseek_usage') || !f.endsWith('.json')) continue;
      const filePath = path.join(cacheDir, f);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        results.push({ file: f, month: data.month, totalCost: data.totalCost, models: data.models });
      } catch {}
    }
  } catch {}
  return results;
}

// ===== 主流程 =====
console.log('='.repeat(60));
console.log(`  费用诊断报告 — ${MONTH}`);
console.log('='.repeat(60));

// 扫描所有项目
const projectsDir = path.join(HOME, '.claude', 'projects');
const projects = {};
let totalLocal = { cost: 0, input: 0, output: 0, cacheCreate: 0, cacheRead: 0, requests: 0 };

if (fs.existsSync(projectsDir)) {
  for (const dir of fs.readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const result = scanProject(path.join(projectsDir, dir.name));
    projects[dir.name] = result;
    totalLocal.cost += result.cost;
    totalLocal.input += result.input;
    totalLocal.output += result.output;
    totalLocal.cacheCreate += result.cacheCreate;
    totalLocal.cacheRead += result.cacheRead;
    totalLocal.requests += result.requests;
  }
}

// Hermes
const hermes = scanHermes();
totalLocal.cost += hermes.cost;
totalLocal.input += hermes.input;
totalLocal.output += hermes.output;
totalLocal.cacheCreate += hermes.cacheCreate;
totalLocal.cacheRead += hermes.cacheRead;
totalLocal.requests += hermes.requests;

// DS 缓存
const dsCaches = scanDSCache();

// ===== 输出 =====
console.log('\n📂 各项目费用明细:');
console.log('-'.repeat(50));
for (const [name, r] of Object.entries(projects).sort((a,b) => b[1].cost - a[1].cost)) {
  const flag = name === 'e--claude-code' ? ' ★当前' : '';
  console.log(`  ${name}${flag}`);
  console.log(`    费用: ¥${r.cost.toFixed(2)} | 请求: ${r.requests} | 文件: ${r.files}`);
  console.log(`    Tokens → 输入: ${(r.input/1e6).toFixed(2)}M | 输出: ${(r.output/1e6).toFixed(2)}M | 缓存读: ${(r.cacheRead/1e6).toFixed(2)}M | 缓存写: ${(r.cacheCreate/1e6).toFixed(2)}M`);
  for (const [model, m] of Object.entries(r.byModel).sort((a,b) => b[1].cost - a[1].cost)) {
    console.log(`    └─ ${model}: ¥${m.cost.toFixed(2)} (${m.requests}次)`);
  }
}

console.log(`\n🤖 Hermes: ¥${hermes.cost.toFixed(2)} | 请求: ${hermes.requests}`);
if (hermes.error) console.log(`   ⚠️ 错误: ${hermes.error}`);
for (const [model, m] of Object.entries(hermes.byModel).sort((a,b) => b[1].cost - a[1].cost)) {
  console.log(`  └─ ${model}: ¥${m.cost.toFixed(2)} (${m.requests}次)`);
}

console.log(`\n📊 DS平台缓存:`);
if (dsCaches.length === 0) console.log('  ⚠️ 无缓存文件');
for (const c of dsCaches) {
  console.log(`  ${c.file}: 月份=${c.month} 总费用=¥${c.totalCost}`);
  if (c.models) {
    for (const [model, m] of Object.entries(c.models)) {
      if (m.cost?.total > 0) console.log(`    └─ ${model}: ¥${m.cost.total.toFixed(2)}`);
    }
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`📊 汇总对比 (${MONTH}):`);
console.log(`  本地全部来源合计: ¥${totalLocal.cost.toFixed(2)}`);
console.log(`  本地总Tokens: 入${(totalLocal.input/1e6).toFixed(2)}M 出${(totalLocal.output/1e6).toFixed(2)}M 缓存读${(totalLocal.cacheRead/1e6).toFixed(2)}M`);
console.log(`  总请求数: ${totalLocal.requests}`);

// 检查是否有当前月份的DS缓存
const monthCache = dsCaches.find(c => c.month === MONTH);
if (monthCache) {
  console.log(`  DS平台费用: ¥${monthCache.totalCost}`);
  const diff = monthCache.totalCost - totalLocal.cost;
  console.log(`  差额: ¥${diff.toFixed(2)} (${diff > 0 ? '平台多' : '本地多'})`);
} else {
  console.log(`  ⚠️ ${MONTH} 的DS平台缓存已被覆盖，无法直接对比`);
  console.log(`  💡 建议: 给 fetch_deepseek.js 加月份轮转功能`);
}
console.log('='.repeat(60));
