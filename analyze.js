/**
 * A股/台股综合分析工具(CLI)
 *
 * 评分逻辑统一在 scoring.js,指标统一在 indicators.js
 * 此文件只负责:数据获取 + 大盘环境 + 报告输出
 *
 * 用法:node analyze.js [sz002049|sh603893|tw2330|2330|all]
 */

const http = require('http');
const https = require('https');
const { SMA } = require('./indicators');
const { computeScore } = require('./scoring');

const WATCH_LIST = {
  'sz002049': '紫光国微',
  'sh603893': '瑞芯微',
  'sz300750': '宁德时代',
  'sz300274': '阳光电源',
  'sh603698': '航天工程',
  'sh601138': '工业富联',
  'sh600011': '华能国际',
  'sh601600': '中国铝业',
  'sz002138': '顺络电子',
  'sh603986': '兆易创新',
  'sz002716': '湖南白银',
  'sh603256': '宏和科技',
  'sz001309': '德明利',
  'sh601899': '紫金矿业',
  'sz000426': '兴业银锡',
  'sz002428': '云南锗业',
  'sh600259': '中稀有色',
  'sh600362': '江西铜业',
  'sh600206': '有研新材',
  'sh600111': '北方稀土',
  'sh601318': '中国平安',
  'sh601066': '中信建投',
};

// ==================== 数据获取 ====================

function fetchRealtime(codes) {
  return new Promise((resolve, reject) => {
    const codesStr = codes.join(',');
    const options = {
      hostname: 'hq.sinajs.cn',
      path: `/list=${codesStr}`,
      headers: {
        'Referer': 'http://finance.sina.com.cn',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };
    http.get(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = new TextDecoder('gbk').decode(buf);
        const results = [];
        for (const line of text.trim().split('\n')) {
          const match = line.match(/var hq_str_(\w+)="(.*)";?/);
          if (!match || !match[2]) continue;
          const fields = match[2].split(',');
          if (fields.length < 32) continue;
          const yesterdayClose = parseFloat(fields[2]);
          const price = parseFloat(fields[3]);
          results.push({
            code: match[1],
            name: fields[0],
            price,
            open: parseFloat(fields[1]),
            high: parseFloat(fields[4]),
            low: parseFloat(fields[5]),
            yesterdayClose,
            change: +(price - yesterdayClose).toFixed(2),
            changePct: yesterdayClose > 0 ? +(((price - yesterdayClose) / yesterdayClose) * 100).toFixed(2) : 0,
            volume: Math.round(parseFloat(fields[8]) / 100),
            amount: +(parseFloat(fields[9]) / 10000).toFixed(2),
            time: `${fields[30]} ${fields[31]}`,
          });
        }
        resolve(results);
      });
    }).on('error', reject);
  });
}

function fetchHistory(code, days = 120) {
  return new Promise((resolve, reject) => {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${days},qfq`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const client = res.headers.location.startsWith('https') ? https : http;
        client.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          collect(res2, code, resolve, reject);
        }).on('error', reject);
        return;
      }
      collect(res, code, resolve, reject);
    }).on('error', reject);
  });
}

function collect(res, code, resolve, reject) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    try {
      const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      if (!json.data || !json.data[code]) { resolve([]); return; }
      const klines = json.data[code].qfqday || json.data[code].day || [];
      resolve(klines.map(item => ({
        date: item[0],
        open: parseFloat(item[1]),
        close: parseFloat(item[2]),
        high: parseFloat(item[3]),
        low: parseFloat(item[4]),
        volume: parseInt(item[5]) || 0,
      })));
    } catch (e) { reject(e); }
  });
}

// ==================== 台股数据 ====================

function fetchTWRealtime(code) {
  return new Promise((resolve, reject) => {
    const num = code.replace(/^tw/i, '');
    const exCh = `tse_${num}.tw|otc_${num}.tw`;
    const url = `/stock/api/getStockInfo.jsp?ex_ch=${exCh}&_=${Date.now()}`;
    https.get({ hostname: 'mis.twse.com.tw', path: url, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (!json.msgArray || json.msgArray.length === 0) { resolve([]); return; }
          const results = [];
          for (const item of json.msgArray) {
            if (!item.z || item.z === '-') continue;
            const price = parseFloat(item.z);
            const yesterdayClose = parseFloat(item.y);
            results.push({
              code: `tw${item.c}`, name: item.n, price,
              open: parseFloat(item.o) || price, high: parseFloat(item.h) || price,
              low: parseFloat(item.l) || price, yesterdayClose,
              change: +(price - yesterdayClose).toFixed(2),
              changePct: yesterdayClose > 0 ? +(((price - yesterdayClose) / yesterdayClose) * 100).toFixed(2) : 0,
              volume: Math.round(parseInt(item.v) || 0), amount: 0,
              time: `${item.d} ${item.t || ''}`,
            });
          }
          resolve(results);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function fetchTWHistory(code, days = 120) {
  return new Promise((resolve, reject) => {
    const num = code.replace(/^tw/i, '');
    const symbol = `${num}.TW`;
    const period2 = Math.floor(Date.now() / 1000);
    const period1 = period2 - Math.floor(days * 24 * 60 * 60 * 1.5);
    const url = `/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;
    https.get({ hostname: 'query1.finance.yahoo.com', path: url, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res2) => {
          collectTWHist(res2, resolve, reject);
        }).on('error', reject);
        return;
      }
      collectTWHist(res, resolve, reject);
    }).on('error', reject);
  });
}

function collectTWHist(res, resolve, reject) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    try {
      const json = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp) { resolve([]); return; }
      const ts = result.timestamp, q = result.indicators.quote[0];
      const klines = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.close[i] === null) continue;
        const d = new Date(ts[i] * 1000);
        klines.push({
          date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
          open: +(q.open[i]||0).toFixed(2), close: +(q.close[i]||0).toFixed(2),
          high: +(q.high[i]||0).toFixed(2), low: +(q.low[i]||0).toFixed(2),
          volume: Math.round((q.volume[i]||0)/1000),
        });
      }
      resolve(klines);
    } catch (e) { reject(e); }
  });
}

// ==================== 大盘环境 ====================

async function getMarketEnvironment() {
  try {
    const klines = await fetchHistory('sh000001', 30);
    if (klines.length < 20) return { trend: 'neutral', score: 0, signals: ['大盘数据不足'] };
    const closes = klines.map(k => k.close);
    const n = closes.length;
    const ma5 = SMA(closes, 5);
    const ma20 = SMA(closes, 20);
    const trend20 = (closes[n - 1] - closes[Math.max(0, n - 20)]) / closes[Math.max(0, n - 20)] * 100;
    let trend = 'neutral', score = 0;
    const signals = [];
    if (ma5[n - 1] > ma20[n - 1] && trend20 > 2) { trend = 'bull'; score = 1; signals.push(`上证偏强: 20日涨${trend20.toFixed(1)}%`); }
    else if (ma5[n - 1] < ma20[n - 1] && trend20 < -2) { trend = 'bear'; score = -1; signals.push(`上证偏弱: 20日跌${trend20.toFixed(1)}%`); }
    else { signals.push(`上证震荡: 20日${trend20.toFixed(1)}%`); }
    return { trend, score, signals };
  } catch (e) { return { trend: 'neutral', score: 0, signals: ['获取大盘数据失败'] }; }
}

// ==================== 报告输出 ====================

function formatReport(analysis) {
  const { realtime: rt, indicators: ind, supportResistance: sr, summary, riskReward: rr, marketState, marketEnv, buyConditions, sellConditions } = analysis;
  const lines = [];

  lines.push('═'.repeat(60));
  lines.push(`  ${rt.name} (${rt.code})  综合分析报告`);
  lines.push(`  当前价: ${rt.price}  涨跌: ${rt.change > 0 ? '+' : ''}${rt.change} (${rt.changePct > 0 ? '+' : ''}${rt.changePct}%)`);
  lines.push(`  时间: ${rt.time}  市场状态: ${marketState}  ${summary.marketEnv}`);
  lines.push('═'.repeat(60));

  lines.push('');
  lines.push(`【综合信号】 >>> ${summary.signal} <<<`);
  lines.push(`  综合评分: ${summary.totalScore} 分 (标准化: ${summary.normalizedScore}/100)`);
  lines.push(`  评分构成: ${summary.breakdown}`);
  lines.push(`  建议: ${summary.advice}`);

  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('【大盘环境】');
  marketEnv.signals.forEach(s => lines.push('  · ' + s));

  const sections = [
    ['均线系统', ind.ma],
    ['MACD', ind.macd],
    ['RSI', ind.rsi],
    ['KDJ', ind.kdj],
    ['布林带', ind.boll],
    ['量价关系', ind.volume],
    ['趋势分析', ind.trend],
    ['ADX趋势强度', ind.adx],
    ['背离检测', ind.divergence],
    ['形态识别', ind.patterns],
    ['动量分析', ind.momentum],
    ['缺口分析', ind.gaps],
  ];
  for (const [name, sec] of sections) {
    lines.push('');
    lines.push(`【${name}】 得分: ${sec.score !== undefined ? sec.score : ''}`);
    if (name === 'MACD' && sec.values) lines.push(`  DIF=${sec.values.dif} DEA=${sec.values.dea} 柱=${sec.values.histogram}`);
    sec.signals.forEach(s => lines.push('  · ' + s));
  }

  lines.push('');
  lines.push('【ATR波动率】');
  ind.atr.signals.forEach(s => lines.push('  · ' + s));

  if (ind.volumeDivergence.signals.length > 0) {
    ind.volumeDivergence.signals.forEach(s => lines.push('  · ' + s));
  }

  lines.push('');
  lines.push('【斐波那契】');
  ind.fibonacci.signals.forEach(s => lines.push('  · ' + s));

  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('【买入条件】');
  if (buyConditions && buyConditions.length > 0) buyConditions.forEach(s => lines.push('  · ' + s));
  else lines.push('  · 暂无明确买入信号');

  lines.push('');
  lines.push('【卖出/止损条件】');
  if (sellConditions && sellConditions.length > 0) sellConditions.forEach(s => lines.push('  · ' + s));
  else lines.push('  · 暂无');

  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('【支撑/压力位】');
  sr.forEach(s => lines.push('  · ' + s));

  lines.push('');
  lines.push('【风险收益比】');
  lines.push(`  · 止损位: ${rr.stopLoss} | 止盈1: ${rr.takeProfit1} | 止盈2: ${rr.takeProfit2}`);
  lines.push(`  · 风险收益比: 1:${rr.riskRewardRatio}`);
  lines.push(`  · ${rr.positionAdvice}`);

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push('  免责声明: 以上分析仅基于技术面,不构成投资建议。');
  lines.push('  投资有风险,入市需谨慎。');
  lines.push('═'.repeat(60));

  return lines.join('\n');
}

// ==================== 主程序 ====================

function resolveCode(input) {
  input = input.trim();
  if (/^tw\d{4,6}$/i.test(input)) return input.toLowerCase();
  if (/^\d{4}$/.test(input)) return 'tw' + input;
  if (/^(sh|sz)\d{6}$/i.test(input)) return input.toLowerCase();
  if (/^\d{6}$/.test(input)) return (input.startsWith('6') ? 'sh' : 'sz') + input;
  return input;
}

async function main() {
  const arg = process.argv[2] || 'all';
  const codes = arg === 'all' ? Object.keys(WATCH_LIST) : [resolveCode(arg)];

  console.log(`\n正在获取数据并分析...\n`);

  // 拿一次大盘环境就够了(同一批分析共享)
  const marketEnv = await getMarketEnvironment();

  for (const code of codes) {
    try {
      const isTW = code.startsWith('tw');
      const [realtimeArr, klines] = isTW
        ? await Promise.all([fetchTWRealtime(code), fetchTWHistory(code, 120)])
        : await Promise.all([fetchRealtime([code]), fetchHistory(code, 120)]);

      const rt = realtimeArr.find(r => r.code === code) || realtimeArr[0];
      if (!rt) { console.log(`未找到 ${code} 的实时数据,跳过`); continue; }
      if (klines.length < 60) { console.log(`${code} 历史数据不足60天 (仅${klines.length}天),跳过`); continue; }

      const analysis = computeScore(klines, { marketEnv, realtime: rt });
      console.log(formatReport(analysis));
      console.log('');
    } catch (e) {
      console.log(`${code} 分析出错: ${e.message}`);
    }
  }
}

if (require.main === module) {
  main().catch(e => console.error('分析出错:', e.message));
}

module.exports = {
  fetchRealtime, fetchHistory, fetchTWRealtime, fetchTWHistory,
  getMarketEnvironment, resolveCode, formatReport, WATCH_LIST,
};
