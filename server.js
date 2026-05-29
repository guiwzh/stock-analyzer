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

const PORT = 3000;

// ==================== 股票搜索(中文/拼音) ====================

function searchStock(keyword) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(keyword);
    const url = `https://smartbox.gtimg.cn/s3/?q=${encoded}&t=all`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const client = res.headers.location.startsWith('https') ? https : http;
        client.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          collectSearch(res2, resolve, reject);
        }).on('error', reject);
        return;
      }
      collectSearch(res, resolve, reject);
    }).on('error', reject);
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
        trades: btResult.trades.slice(-20), // 最近20笔
        grade,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: `回测出错: ${e.message}` }));
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
      if (klines.length < 30) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `${code} 历史数据不足,无法进行有效分析` }));
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
  server.listen(port, () => {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`  A股/台股综合分析工具`);
    console.log(`  打开浏览器访问: http://127.0.0.1:${port}`);
    console.log(`${'='.repeat(50)}\n`);
    openBrowser(`http://127.0.0.1:${port}`);
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

module.exports = { server, startServer, searchStock, resolveStockCode, main };
