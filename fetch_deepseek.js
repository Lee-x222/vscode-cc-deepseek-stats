/**
 * DeepSeek 平台 API 数据拉取脚本
 * 从 platform.deepseek.com 抓取当月用量 + 费用，输出到 stdout
 * 同时写入 ~/.claude/deepseek_usage.json 缓存
 *
 * 认证方式：优先使用 API Key（sk-xxx），兼容旧浏览器 token+cookie
 * 余额来源：优先 api.deepseek.com/user/balance 公共接口
 *
 * 用法: node fetch_deepseek.js
 * 返回: JSON 到 stdout { ok: true, data: {...} } 或 { ok: false, error: "..." }
 */
"use strict";

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const AUTH_PATH = path.join(HOME, '.claude', 'deepseek_auth.json');
const CACHE_PATH = path.join(HOME, '.claude', 'deepseek_usage.json');

function readAuth() {
  try {
    const raw = fs.readFileSync(AUTH_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 获取 API Key（用于公共 API） */
function getApiKey(auth) {
  if (!auth) return '';
  return auth.apiKey || '';
}

/** 获取 session token（用于平台内部 API） */
function getSessionToken(auth) {
  if (!auth) return '';
  return auth.token || '';
}

/** 公共 API：查询账户余额（用 API Key） */
function fetchBalance() {
  return new Promise((resolve) => {
    const auth = readAuth();
    const apiKey = getApiKey(auth);
    if (!apiKey) { resolve(null); return; }
    https.get({
      hostname: 'api.deepseek.com',
      path: '/user/balance',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // 尝试多种可能的余额字段
          const bal = json.balance ?? json.data?.balance ?? json.total_balance;
          if (typeof bal === 'number') resolve(bal);
          else resolve(null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function fetchAPI(urlPath) {
  return new Promise((resolve, reject) => {
    const auth = readAuth();
    const token = getSessionToken(auth);
    if (!token) {
      reject(new Error('没有 DeepSeek 认证信息，请先登录平台'));
      return;
    }
    https.get({
      hostname: 'platform.deepseek.com',
      path: urlPath,
      headers: {
        'Authorization': 'Bearer ' + token,
        'User-Agent': (auth && auth.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cookie': (auth && auth.cookie) || '',
        'Referer': 'https://platform.deepseek.com/usage',
        'Origin': 'https://platform.deepseek.com',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 0) resolve(json.data);
          else reject(new Error('API 返回错误: ' + (json.msg || json.code)));
        } catch(e) {
          reject(new Error('解析失败: ' + e.message));
        }
      });
    }).on('error', reject);
  });
}

function fetchUserSummary() {
  return new Promise((resolve) => {
    const auth = readAuth();
    const token = getSessionToken(auth);
    if (!token) { resolve(null); return; }
    https.get({
      hostname: 'platform.deepseek.com',
      path: '/api/v0/users/get_user_summary',
      headers: {
        'Authorization': 'Bearer ' + token,
        'User-Agent': (auth && auth.userAgent) || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Cookie': (auth && auth.cookie) || '',
        'Referer': 'https://platform.deepseek.com/usage',
        'Origin': 'https://platform.deepseek.com',
        'Cache-Control': 'no-cache'
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // 响应格式: { code:0, data: { biz_code:0, biz_data: {...} } }
          if (json.code === 0 && json.data?.biz_code === 0 && json.data?.biz_data) {
            resolve(json.data.biz_data);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function parseUsage(usageArr, isCost) {
  const m = {};
  usageArr.forEach(u => {
    const v = isCost ? parseFloat(u.amount) : parseInt(u.amount);
    switch (u.type) {
      case 'PROMPT_TOKEN': m.prompt = v || 0; break;
      case 'PROMPT_CACHE_HIT_TOKEN': m.cacheHit = v || 0; break;
      case 'PROMPT_CACHE_MISS_TOKEN': m.cacheMiss = v || 0; break;
      case 'RESPONSE_TOKEN': m.response = v || 0; break;
      case 'REQUEST': m.requests = v || 0; break;
    }
  });
  if (isCost) m.total = (m.prompt || 0) + (m.cacheHit || 0) + (m.cacheMiss || 0) + (m.response || 0) + (m.requests || 0);
  return m;
}

(async () => {
  try {
    const now = new Date();
    const month = now.getUTCMonth() + 1;
    const year = now.getUTCFullYear();
    const monthStr = year + '-' + String(month).padStart(2, '0');
    const todayUTC = now.toISOString().slice(0, 10);

    const [costData, amtData, balanceFromApi, userSummary] = await Promise.all([
      fetchAPI('/api/v0/usage/cost?month=' + month + '&year=' + year),
      fetchAPI('/api/v0/usage/amount?month=' + month + '&year=' + year),
      fetchBalance(),
      fetchUserSummary(),
    ]);

    const models = {};
    let totalCost = 0;

    // 解析 cost 总额
    const costArr = Array.isArray(costData.biz_data) ? costData.biz_data : [costData.biz_data];
    if (costArr.length > 0 && costArr[0].total) {
      costArr[0].total.forEach(entry => {
        const name = entry.model;
        if (!models[name]) models[name] = { cost: {}, tokens: {} };
        models[name].cost = parseUsage(entry.usage, true);
        totalCost += models[name].cost.total;
      });
    }

    // 解析 amount 总额
    if (amtData.biz_data && amtData.biz_data.total) {
      amtData.biz_data.total.forEach(entry => {
        const name = entry.model;
        if (!models[name]) models[name] = { cost: {}, tokens: {} };
        models[name].tokens = parseUsage(entry.usage, false);
      });
    }

    // 解析天数数据
    const days = {};

    if (costArr.length > 0 && Array.isArray(costArr[0].days)) {
      costArr[0].days.forEach(d => {
        if (!days[d.date]) days[d.date] = {};
        d.data.forEach(entry => {
          days[d.date][entry.model] = { tokens: {}, cost: 0 };
          entry.usage.forEach(u => {
            const v = parseFloat(u.amount) || 0;
            switch (u.type) {
              case 'PROMPT_TOKEN': case 'PROMPT_CACHE_HIT_TOKEN':
              case 'PROMPT_CACHE_MISS_TOKEN': case 'RESPONSE_TOKEN':
              case 'REQUEST':
                days[d.date][entry.model].cost += v;
                break;
            }
          });
        });
      });
    }

    if (amtData.biz_data && Array.isArray(amtData.biz_data.days)) {
      amtData.biz_data.days.forEach(d => {
        if (!days[d.date]) days[d.date] = {};
        d.data.forEach(entry => {
          if (!days[d.date][entry.model]) days[d.date][entry.model] = { tokens: {}, cost: 0 };
          entry.usage.forEach(u => {
            const v = parseInt(u.amount) || 0;
            switch (u.type) {
              case 'PROMPT_TOKEN': days[d.date][entry.model].tokens.prompt = v; break;
              case 'PROMPT_CACHE_HIT_TOKEN': days[d.date][entry.model].tokens.cacheHit = v; break;
              case 'PROMPT_CACHE_MISS_TOKEN': days[d.date][entry.model].tokens.cacheMiss = v; break;
              case 'RESPONSE_TOKEN': days[d.date][entry.model].tokens.response = v; break;
              case 'REQUEST': days[d.date][entry.model].tokens.requests = v; break;
            }
          });
        });
      });
    }

    // 过滤零值和未来日期
    const cleanedDays = {};
    Object.entries(days).forEach(([date, dayModels]) => {
      if (date > todayUTC) return;
      let dayCost = 0;
      Object.values(dayModels).forEach(m => dayCost += m.cost || 0);
      if (dayCost > 0) cleanedDays[date] = dayModels;
    });

    totalCost = 0;
    Object.values(models).forEach(m => { totalCost += m.cost.total || 0; });

    // 余额：优先公共 API，降级到 user_summary
    let balance = 0;
    if (balanceFromApi !== null) {
      balance = balanceFromApi;
    } else if (userSummary) {
      const normalBalance = (userSummary.normal_wallets || [])
        .reduce((s, w) => s + (parseFloat(w.balance) || 0), 0);
      const bonusBalance = (userSummary.bonus_wallets || [])
        .reduce((s, w) => s + (parseFloat(w.balance) || 0), 0);
      balance = normalBalance + bonusBalance;
    }

    const result = {
      month: monthStr,
      updatedAt: new Date().toISOString(),
      models,
      totalCost: Math.round(totalCost * 100) / 100,
      days: cleanedDays,
      balance: Math.round(balance * 100) / 100
    };

    // 写缓存
    fs.writeFileSync(CACHE_PATH, JSON.stringify(result, null, 2));

    // 输出到 stdout
    console.log(JSON.stringify({ ok: true, data: result }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message }));
  }
})();
