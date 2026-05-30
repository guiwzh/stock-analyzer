/**
 * A股/台股综合分析 Web 服务
 *
 * 启动: node server.js
 * 访问: http://127.0.0.1:3000
 *
 * P0 改造:评分逻辑统一使用 scoring.js,与 CLI(analyze.js / backtest.js)完全一致
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const {
  fetchRealtime, fetchHistory, fetchTWRealtime, fetchTWHistory,
  getMarketEnvironment,
} = require('./analyze');
const { computeScore } = require('./scoring');
const { backtest: runBacktest } = require('./backtest');
const { fetchValuation, scoreValuation } = require('./valuation');
const { fetchFundamentals, scoreFundamentals } = require('./fundamentals');

const PORT = 3000;
const HOST = '127.0.0.1';

// 搜索接口的单次请求超时(毫秒),避免上游卡住时请求永久挂起
const REQUEST_TIMEOUT = 8000;

function withTimeout(req, reject) {
  req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('请求超时')));
  req.on('error', reject);
  return req;
}

// ==================== 股票搜索(中文/拼音) ====================

function searchStock(keyword) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(keyword);
    const url = `https://smartbox.gtimg.cn/s3/?q=${encoded}&t=all`;
    withTimeout(https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const client = res.headers.location.startsWith('https') ? https : http;
        withTimeout(client.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          collectSearch(res2, resolve, reject);
        }), reject);
        return;
      }
      collectSearch(res, resolve, reject);
    }), reject);
  });
}

function collectSearch(res, resolve, reject) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    try {
      const text = Buffer.concat(chunks).toString('utf-8');
      const match = text.match(/v_hint="(.*)"/);
      if (!match || !match[1]) { resolve([]); return; }
      const items = match[1].split('^').filter(Boolean);
      const results = [];
      for (const item of items) {
        const parts = item.split('~');
        if (parts.length < 5) continue;
        const market = parts[0];
        const num = parts[1];
        const name = parts[2];
        const type = parts[4];
        if (type === 'GP-A') results.push({ code: `${market}${num}`, name, type });
      }
      resolve(results);
    } catch (e) { reject(e); }
  });
}

async function resolveStockCode(input) {
  input = input.trim();
  if (/^tw\d{4,6}$/i.test(input)) return input.toLowerCase();
  if (/^\d{4}$/.test(input)) return 'tw' + input;
  if (/^(sh|sz)\d{6}$/i.test(input)) return input.toLowerCase();
  if (/^\d{6}$/.test(input)) return (input.startsWith('6') ? 'sh' : 'sz') + input;
  const results = await searchStock(input);
  return results.length > 0 ? results[0].code : null;
}

// ==================== 批量评分排名 ====================

/**
 * 对一组股票跑同一套 computeScore,按综合评分排序。
 * - 大盘环境只取一次,所有股票共享(与 CLI analyze.js 一致)
 * - A 股实时行情用新浪批量接口一次拿全(支持多代码)
 * - 历史 K 线分批并发拉取,控制并发避免被上游限流
 * 返回结果只含评分摘要,不含完整指标明细。
 */
async function rankStocks(inputs) {
  const resolved = await Promise.all(inputs.map(i => resolveStockCode(i).catch(() => null)));
  // 去重 + 去空
  const codes = [...new Set(resolved.filter(Boolean))];

  const marketEnv = await getMarketEnvironment();

  // 大盘指数 K 线只拉一次,供所有标的的回测做大盘环境过滤(与实盘一致)
  let indexKlines = null;
  try {
    indexKlines = await fetchHistory('sh000001', 500);
    if (indexKlines.length < 30) indexKlines = null;
  } catch (e) { /* 降级:无大盘过滤 */ }

  // A 股实时行情批量拿(一个请求多代码)
  const aShares = codes.filter(c => !c.startsWith('tw'));
  const rtMap = {};
  if (aShares.length) {
    try {
      const arr = await fetchRealtime(aShares);
      for (const r of arr) rtMap[r.code] = r;
    } catch (e) { /* 批量实时失败时,各股单独降级处理 */ }
  }

  async function analyzeOne(code) {
    try {
      const isTW = code.startsWith('tw');
      let rt, klines;
      // 拉 500 天:评分只看近端窗口,回测需要长历史,一次拉够两用
      if (isTW) {
        const [rtArr, kl] = await Promise.all([fetchTWRealtime(code), fetchTWHistory(code, 500)]);
        rt = rtArr[0]; klines = kl;
      } else {
        rt = rtMap[code];
        klines = await fetchHistory(code, 500);
        if (!rt) { const a = await fetchRealtime([code]); rt = a[0]; }
      }
      if (!rt) return { code, name: code, error: '无实时数据' };
      if (!klines || klines.length < 60) return { code, name: rt.name || code, error: `数据不足(${klines ? klines.length : 0}天)` };
      const a = computeScore(klines, { marketEnv, realtime: rt });

      // 估值 + 基本面(并行;失败不影响其余维度,降级为 null)
      const [val, fund] = await Promise.all([
        fetchValuation(code).then(scoreValuation).catch(() => ({ score: null, signals: ['估值接口失败'] })),
        fetchFundamentals(code).then(scoreFundamentals).catch(() => ({ score: null, signals: ['财务接口失败'] })),
      ]);

      // 回测(数据足够时):用与单股一致的默认参数,拿净收益指标
      let bt = null;
      if (klines.length >= 80) {
        const r = runBacktest(klines, { startIdx: 60, maxHoldDays: 30, indexKlines, trailing: false, useTP1: true });
        if (r.long) {
          bt = {
            trades: r.long.total,
            winRate: r.long.winRate,
            compoundReturn: r.long.compoundReturn,
            maxDrawdown: r.long.maxDrawdown,
            profitFactor: r.long.profitFactor,
          };
        }
      }

      // ===== 三维综合分(均衡型:技术/估值/基本面 等权,缺失维度按现有维度平均) =====
      const techDim = a.summary.normalizedScore; // 0~100
      const dims = { technical: techDim, valuation: val.score, fundamental: fund.score };
      const present = [techDim, val.score, fund.score].filter(s => s != null);
      const composite = present.length ? Math.round(present.reduce((x, y) => x + y, 0) / present.length) : techDim;

      return {
        code, name: rt.name || code,
        price: rt.price, changePct: rt.changePct,
        totalScore: a.summary.totalScore,
        normalizedScore: techDim,
        signal: a.summary.signal,
        marketState: a.marketState,
        riskRewardRatio: a.riskReward.riskRewardRatio,
        positionAdvice: a.riskReward.positionAdvice,
        backtest: bt,
        composite,
        dims,
        valuation: { score: val.score, label: val.label || null, peTTM: val.peTTM != null ? +val.peTTM.toFixed(1) : null, pePercentile: val.pePercentile, board: val.board || null, signals: val.signals },
        fundamental: { score: fund.score, label: fund.label || null, roe: fund.roe, revenueYoY: fund.revenueYoY, profitYoY: fund.profitYoY, reportDate: fund.reportDate, signals: fund.signals },
      };
    } catch (e) {
      return { code, name: code, error: e.message };
    }
  }

  // 限并发(每批 5 只)
  const CONCURRENCY = 5;
  const results = [];
  for (let i = 0; i < codes.length; i += CONCURRENCY) {
    const batch = codes.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(batch.map(analyzeOne)));
  }

  // 排序:可分析的按三维综合分降序,出错/数据不足的排末尾
  results.sort((x, y) => {
    if (x.error && y.error) return 0;
    if (x.error) return 1;
    if (y.error) return -1;
    return y.composite - x.composite;
  });

  return { marketEnv, count: results.length, results };
}

// ==================== HTTP 服务 ====================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // API: 搜索股票
  if (url.pathname === '/api/search') {
    const keyword = url.searchParams.get('q');
    if (!keyword) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请提供搜索关键词' }));
      return;
    }
    try {
      const results = await searchStock(keyword);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ results }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // API: 回测 — 使用与实盘一致的评分(scoring.computeQuickScore)
  if (url.pathname === '/api/backtest') {
    const input = url.searchParams.get('code');
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请提供股票代码' }));
      return;
    }
    try {
      const code = await resolveStockCode(input);
      if (!code) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `未找到"${input}"对应的股票` }));
        return;
      }
      const isTW = code.startsWith('tw');
      const klines = isTW ? await fetchTWHistory(code, 500) : await fetchHistory(code, 500);
      if (klines.length < 80) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${code} 历史数据不足,无法回测` }));
        return;
      }

      // 拉一次上证指数用于大盘环境过滤
      let indexKlines = null;
      try {
        indexKlines = await fetchHistory('sh000001', 500);
        if (indexKlines.length < 30) indexKlines = null;
      } catch (e) { /* 忽略,降级为无大盘过滤 */ }

      const trailing = url.searchParams.get('trailing') === '1';
      const trailingATR = parseFloat(url.searchParams.get('trailing_atr')) || 2.5;
      const useTP1 = url.searchParams.get('no_tp1') !== '1';
      const btResult = runBacktest(klines, {
        startIdx: 60, maxHoldDays: 30, indexKlines,
        trailing, trailingATR, useTP1,
      });

      let name = code;
      if (!isTW) {
        const rtArr = await fetchRealtime([code]);
        if (rtArr.length > 0) name = rtArr[0].name;
      } else {
        const rtArr = await fetchTWRealtime(code);
        if (rtArr.length > 0) name = rtArr[0].name;
      }

      // 评级
      let grade = '较差';
      if (btResult.long) {
        const { winRate, avgReturn } = btResult.long;
        if (winRate >= 60 && avgReturn > 3) grade = '优秀';
        else if (winRate >= 55 && avgReturn > 1.5) grade = '良好';
        else if (winRate >= 50 || avgReturn > 0) grade = '一般';
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        code, name,
        engine: 'event-driven-v1',
        dataRange: btResult.dataRange,
        long: btResult.long,
        short: btResult.short,
        costs: btResult.costs,
        trades: btResult.trades.slice(-20), // 最近20笔
        grade,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `回测出错: ${e.message}` }));
    }
    return;
  }

  // API: 批量评分排名 — 对一组股票跑同一套 computeScore,按综合评分从高到低排序
  // 注意:这是工具的技术面评分排名,不是投资建议
  if (url.pathname === '/api/rank') {
    const raw = url.searchParams.get('codes');
    if (!raw) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请提供股票代码列表(codes=逗号分隔)' }));
      return;
    }
    try {
      const inputs = raw.split(',').map(s => s.trim()).filter(Boolean);
      const out = await rankStocks(inputs);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `排名出错: ${e.message}` }));
    }
    return;
  }

  // API: 分析股票
  if (url.pathname === '/api/analyze') {
    const input = url.searchParams.get('code');
    if (!input) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: '请提供股票代码或名称' }));
      return;
    }
    try {
      const code = await resolveStockCode(input);
      if (!code) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `未找到"${input}"对应的股票,请检查输入(A股6位/台股4位)` }));
        return;
      }
      const isTW = code.startsWith('tw');
      const [realtimeArr, klines] = isTW
        ? await Promise.all([fetchTWRealtime(code), fetchTWHistory(code, 120)])
        : await Promise.all([fetchRealtime([code]), fetchHistory(code, 120)]);

      if (!realtimeArr.length) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `未找到股票 ${code} 的实时数据` }));
        return;
      }
      if (klines.length < 60) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${code} 历史数据不足60天(仅${klines.length}天),无法进行有效分析` }));
        return;
      }

      const marketEnv = await getMarketEnvironment();
      const analysis = computeScore(klines, { marketEnv, realtime: realtimeArr[0] });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(analysis));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `分析出错: ${e.message}` }));
    }
    return;
  }

  // 前端页面
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const htmlPath = path.join(__dirname, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

function openBrowser(url) {
  const { exec } = require('child_process');
  const platform = process.platform;
  if (platform === 'win32') exec(`start ${url}`);
  else if (platform === 'darwin') exec(`open ${url}`);
  else exec(`xdg-open ${url}`);
}

function startServer(port) {
  server.listen(port, HOST, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  A股/台股综合分析工具`);
    console.log(`  打开浏览器访问: http://${HOST}:${port}`);
    console.log(`${'='.repeat(50)}\n`);
    openBrowser(`http://${HOST}:${port}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`端口 ${port} 被占用,尝试 ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error('服务启动失败:', err.message);
    }
  });
}

function main() {
  startServer(PORT);
}

if (require.main === module) {
  main();
}

module.exports = { server, startServer, searchStock, resolveStockCode, rankStocks, main };
