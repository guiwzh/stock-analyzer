/**
 * 回测引擎 — P1 事件驱动版
 *
 * 关键变化(相比 P0):
 *   1. 信号去重:已持仓时同向信号不重复入场
 *   2. 止损止盈退出:用 scoring.js 提供的 stopLoss / takeProfit1,而不是固定持有 N 天
 *   3. 反向信号退出:多头持仓时出现 score<=-5,立即平仓
 *   4. 大盘环境过滤:每日重新计算上证趋势,与实盘一致
 *   5. 完整交易记录:返回每笔"入场→退出"的完整流水
 *
 * 用法: node backtest.js [sz002049|sh601138|2330|all]
 */

const { fetchHistory, fetchTWHistory } = require('./analyze');
const { computeBacktestSnapshot } = require('./scoring');
const { SMA } = require('./indicators');

// ==================== 大盘环境(任意历史时点) ====================

/**
 * 给定上证指数 K 线和某个日期,返回那天的大盘环境
 * 用于回测时让每一天都看到"当时"的大盘状态,与实盘 getMarketEnvironment 一致
 */
function getMarketEnvAtDate(indexKlines, date) {
  // 找 date 当天或最近的前一交易日
  let idx = -1;
  for (let i = indexKlines.length - 1; i >= 0; i--) {
    if (indexKlines[i].date <= date) { idx = i; break; }
  }
  if (idx < 20) return { trend: 'neutral', score: 0, signals: ['大盘数据不足'] };
  const slice = indexKlines.slice(0, idx + 1);
  const closes = slice.map(k => k.close);
  const n = closes.length;
  const ma5 = SMA(closes, 5);
  const ma20 = SMA(closes, 20);
  const trend20 = (closes[n - 1] - closes[n - 20]) / closes[n - 20] * 100;
  let trend = 'neutral', score = 0;
  const signals = [];
  if (ma5[n - 1] > ma20[n - 1] && trend20 > 2) { trend = 'bull'; score = 1; signals.push(`上证偏强: 20日涨${trend20.toFixed(1)}%`); }
  else if (ma5[n - 1] < ma20[n - 1] && trend20 < -2) { trend = 'bear'; score = -1; signals.push(`上证偏弱: 20日跌${trend20.toFixed(1)}%`); }
  else { signals.push(`上证震荡: 20日${trend20.toFixed(1)}%`); }
  return { trend, score, signals };
}

// ==================== 事件驱动回测引擎 ====================

/**
 * @param {Array} klines       标的 K 线
 * @param {Object} options
 *   - startIdx        从第几天开始(默认 60,保证指标有足够数据)
 *   - maxHoldDays     单笔最大持仓天数(默认 30)
 *   - indexKlines     上证指数 K 线(可选,用于大盘环境过滤)
 *   - scoreBuy        买入阈值(默认 5)
 *   - scoreSell       卖出阈值(默认 -5)
 *   - enableShort     是否回测做空(默认 false,只做多)
 *   - trailing        是否启用跟踪止损(默认 true)
 *                     Chandelier Exit:stopLoss = max(原止损, 持仓最高价 - 2.5×ATR)
 *   - trailingATR     跟踪止损的 ATR 倍数(默认 2.5)
 *   - useTP1          是否在 TP1 止盈(默认 false,跟踪止损接管止盈)
 *                     关闭后,只靠跟踪止损 + 反向信号 + 超时退出 — 经典趋势跟随风格
 */
function backtest(klines, options = {}) {
  const {
    startIdx = 60,
    maxHoldDays = 30,
    indexKlines = null,
    scoreBuy = 5,
    scoreSell = -5,
    enableShort = false,
    trailing = false,     // 默认关闭(高波动股开了反而拖累累计收益)
    trailingATR = 2.5,
    useTP1 = true,
  } = options;
  const n = klines.length;
  const trades = [];
  let position = null;

  for (let i = startIdx; i < n; i++) {
    const today = klines[i];
    const mEnv = indexKlines ? getMarketEnvAtDate(indexKlines, today.date) : null;

    if (position === null) {
      // ===== 空仓:扫描入场信号 =====
      const snap = computeBacktestSnapshot(klines, i, { marketEnv: mEnv });
      if (!snap) continue;

      if (snap.score >= scoreBuy) {
        position = {
          type: 'long',
          entryIdx: i, entryDate: today.date, entryPrice: today.close,
          entryScore: snap.score,
          entryATR: snap.atr || 0,
          peakPrice: today.close,         // 持仓期间最高价(跟踪止损用)
          troughPrice: today.close,        // 持仓期间最低价(做空跟踪用)
          stopLoss: snap.stopLoss,
          initialStopLoss: snap.stopLoss,  // 记录初始止损,便于报告
          takeProfit1: snap.takeProfit1,
          takeProfit2: snap.takeProfit2,
        };
      } else if (enableShort && snap.score <= scoreSell) {
        position = {
          type: 'short',
          entryIdx: i, entryDate: today.date, entryPrice: today.close,
          entryScore: snap.score,
          entryATR: snap.atr || 0,
          peakPrice: today.close,
          troughPrice: today.close,
          stopLoss: snap.takeProfit1,
          initialStopLoss: snap.takeProfit1,
          takeProfit1: snap.stopLoss,
          takeProfit2: null,
        };
      }
      continue;
    }

    // ===== 持仓中:检查退出条件 =====
    let exitReason = null, exitPrice = null;

    // 更新持仓期间的高低水位
    if (today.high > position.peakPrice) position.peakPrice = today.high;
    if (today.low < position.troughPrice) position.troughPrice = today.low;

    // 跟踪止损:Chandelier Exit
    // 做多:trailStop = peak - N×ATR,只上调不下调
    // 做空:trailStop = trough + N×ATR,只下调不上调
    if (trailing && position.entryATR > 0) {
      if (position.type === 'long') {
        const trail = position.peakPrice - trailingATR * position.entryATR;
        if (trail > position.stopLoss) position.stopLoss = +trail.toFixed(2);
      } else {
        const trail = position.troughPrice + trailingATR * position.entryATR;
        if (trail < position.stopLoss) position.stopLoss = +trail.toFixed(2);
      }
    }

    if (position.type === 'long') {
      if (today.low <= position.stopLoss) {
        exitReason = position.stopLoss > position.initialStopLoss ? 'trailingStop' : 'stopLoss';
        exitPrice = today.open <= position.stopLoss ? today.open : position.stopLoss;
      }
      else if (useTP1 && today.high >= position.takeProfit1) {
        exitReason = 'takeProfit';
        exitPrice = today.open >= position.takeProfit1 ? today.open : position.takeProfit1;
      }
      else {
        const snap = computeBacktestSnapshot(klines, i, { marketEnv: mEnv });
        if (snap && snap.score <= scoreSell) { exitReason = 'reverseSignal'; exitPrice = today.close; }
        else if (i - position.entryIdx >= maxHoldDays) { exitReason = 'timeout'; exitPrice = today.close; }
      }
    } else {
      if (today.high >= position.stopLoss) {
        exitReason = position.stopLoss < position.initialStopLoss ? 'trailingStop' : 'stopLoss';
        exitPrice = today.open >= position.stopLoss ? today.open : position.stopLoss;
      } else if (useTP1 && today.low <= position.takeProfit1) {
        exitReason = 'takeProfit';
        exitPrice = today.open <= position.takeProfit1 ? today.open : position.takeProfit1;
      } else {
        const snap = computeBacktestSnapshot(klines, i, { marketEnv: mEnv });
        if (snap && snap.score >= scoreBuy) { exitReason = 'reverseSignal'; exitPrice = today.close; }
        else if (i - position.entryIdx >= maxHoldDays) { exitReason = 'timeout'; exitPrice = today.close; }
      }
    }

    if (exitReason) {
      const returnPct = position.type === 'long'
        ? (exitPrice - position.entryPrice) / position.entryPrice * 100
        : (position.entryPrice - exitPrice) / position.entryPrice * 100;
      trades.push({
        type: position.type,
        entryIdx: position.entryIdx, entryDate: position.entryDate, entryPrice: position.entryPrice,
        entryScore: position.entryScore,
        exitIdx: i, exitDate: today.date, exitPrice: +exitPrice.toFixed(2),
        exitReason,
        returnPct: +returnPct.toFixed(2),
        holdDays: i - position.entryIdx,
        stopLoss: position.stopLoss, takeProfit1: position.takeProfit1,
      });
      position = null;
    }
  }

  // 数据末尾还有持仓:按最后收盘强制平仓
  if (position) {
    const last = n - 1;
    const exitPrice = klines[last].close;
    const returnPct = position.type === 'long'
      ? (exitPrice - position.entryPrice) / position.entryPrice * 100
      : (position.entryPrice - exitPrice) / position.entryPrice * 100;
    trades.push({
      type: position.type,
      entryIdx: position.entryIdx, entryDate: position.entryDate, entryPrice: position.entryPrice,
      entryScore: position.entryScore,
      exitIdx: last, exitDate: klines[last].date, exitPrice: +exitPrice.toFixed(2),
      exitReason: 'endOfData',
      returnPct: +returnPct.toFixed(2),
      holdDays: last - position.entryIdx,
      stopLoss: position.stopLoss, takeProfit1: position.takeProfit1,
    });
  }

  return summarize(trades, klines);
}

// ==================== 汇总统计 ====================

function summarize(trades, klines) {
  const longs = trades.filter(t => t.type === 'long');
  const shorts = trades.filter(t => t.type === 'short');

  function stats(group) {
    if (group.length === 0) return null;
    const wins = group.filter(t => t.returnPct > 0);
    const losses = group.filter(t => t.returnPct <= 0);
    const returns = group.map(t => t.returnPct);
    const holdDaysArr = group.map(t => t.holdDays);
    const sum = returns.reduce((a, b) => a + b, 0);
    const reasonCount = {};
    for (const t of group) reasonCount[t.exitReason] = (reasonCount[t.exitReason] || 0) + 1;
    return {
      total: group.length,
      wins: wins.length,
      losses: losses.length,
      winRate: +(wins.length / group.length * 100).toFixed(1),
      avgReturn: +(sum / group.length).toFixed(2),
      totalReturn: +sum.toFixed(2),
      maxWin: +Math.max(...returns).toFixed(2),
      maxLoss: +Math.min(...returns).toFixed(2),
      avgHoldDays: +(holdDaysArr.reduce((a, b) => a + b, 0) / group.length).toFixed(1),
      exitReasons: reasonCount,
      // 期望值 / 凯利公式所需的盈亏比
      avgWin: wins.length > 0 ? +(wins.reduce((a, t) => a + t.returnPct, 0) / wins.length).toFixed(2) : 0,
      avgLoss: losses.length > 0 ? +(losses.reduce((a, t) => a + t.returnPct, 0) / losses.length).toFixed(2) : 0,
    };
  }

  return {
    trades,
    long: stats(longs),
    short: stats(shorts),
    dataRange: klines.length > 0 ? `${klines[0].date} ~ ${klines[klines.length - 1].date}` : '',
    totalDays: klines.length,
  };
}

// ==================== 报告输出 ====================

function formatBacktestReport(code, klines, btResult) {
  const lines = [];
  const { long, short, trades, dataRange } = btResult;

  lines.push('═'.repeat(64));
  lines.push(`  回测报告: ${code}    [事件驱动 / 真实策略 / 大盘过滤]`);
  lines.push(`  数据范围: ${dataRange} (${klines.length}个交易日)`);
  lines.push('═'.repeat(64));

  if (!long && !short) {
    lines.push('');
    lines.push('  整个回测周期内没有触发任何入场信号(score 始终在 [-5, 5] 区间)');
    lines.push('═'.repeat(64));
    return lines.join('\n');
  }

  function block(title, s) {
    if (!s) return;
    lines.push('');
    lines.push('─'.repeat(64));
    lines.push(`【${title}】`);
    lines.push(`  交易笔数: ${s.total}   胜: ${s.wins}   负: ${s.losses}   胜率: ${s.winRate}%`);
    lines.push(`  平均收益: ${s.avgReturn}%   累计收益: ${s.totalReturn}%`);
    lines.push(`  平均盈利: ${s.avgWin}%   平均亏损: ${s.avgLoss}%   盈亏比: ${s.avgLoss < 0 ? Math.abs(s.avgWin / s.avgLoss).toFixed(2) : '∞'}`);
    lines.push(`  最大盈利: ${s.maxWin}%   最大亏损: ${s.maxLoss}%   平均持有: ${s.avgHoldDays} 天`);
    const reasonLabel = { stopLoss: '止损', trailingStop: '跟踪止损', takeProfit: '止盈', reverseSignal: '反向信号', timeout: '超时', endOfData: '数据末尾' };
    const reasonStr = Object.entries(s.exitReasons)
      .map(([k, v]) => `${reasonLabel[k] || k}:${v}`).join('  ');
    lines.push(`  退出方式: ${reasonStr}`);
  }

  block('做多统计', long);
  block('做空统计', short);

  // 最近的交易
  lines.push('');
  lines.push('─'.repeat(64));
  lines.push('【最近 10 笔交易】');
  const reasonLabel = { stopLoss: '止损', trailingStop: '跟踪止损', takeProfit: '止盈', reverseSignal: '反向', timeout: '超时', endOfData: '末尾' };
  for (const t of trades.slice(-10)) {
    const sign = t.type === 'long' ? '▲多' : '▼空';
    const r = t.returnPct >= 0 ? `+${t.returnPct}%` : `${t.returnPct}%`;
    lines.push(`  ${t.entryDate} ${sign} @${t.entryPrice} → ${t.exitDate} @${t.exitPrice} | ${r} | ${t.holdDays}天 | ${reasonLabel[t.exitReason] || t.exitReason}`);
  }

  // 综合评级
  lines.push('');
  lines.push('═'.repeat(64));
  if (long) {
    let grade = '较差';
    if (long.winRate >= 60 && long.avgReturn > 3) grade = '优秀 - 信号可靠';
    else if (long.winRate >= 55 && long.avgReturn > 1.5) grade = '良好 - 有参考价值';
    else if (long.winRate >= 50 || long.avgReturn > 0) grade = '一般 - 需结合其他因素';
    else grade = '较差 - 信号不可靠';
    lines.push(`  做多评级: 胜率 ${long.winRate}% / 均收益 ${long.avgReturn}% / ${long.total}笔 → ${grade}`);
  }
  lines.push(`  注: 用与实盘 analyze 一致的评分(scoring.js),并按 stopLoss/takeProfit 退出`);
  lines.push(`  局限: 未计手续费和滑点(按用户要求)`);
  lines.push('═'.repeat(64));
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

const WATCH_LIST = ['sz002049', 'sh603893', 'sz300750', 'sh601138', 'sh600011', 'tw2330'];

async function fetchAny(code, days) {
  return code.startsWith('tw') ? fetchTWHistory(code, days) : fetchHistory(code, days);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const result = { code: 'all', trailing: false, trailingATR: 2.5, useTP1: true };
  for (const a of args) {
    if (a === '--trailing') result.trailing = true;
    else if (a.startsWith('--trailing-atr=')) result.trailingATR = parseFloat(a.split('=')[1]);
    else if (a === '--no-tp1') result.useTP1 = false;
    else if (!a.startsWith('--')) result.code = a;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv);
  const codes = args.code === 'all' ? WATCH_LIST : [resolveCode(args.code)];

  const modeDesc = [];
  if (args.trailing) modeDesc.push(`跟踪止损=${args.trailingATR}×ATR`);
  if (!args.useTP1) modeDesc.push('无TP1');
  if (modeDesc.length === 0) modeDesc.push('默认: TP1止盈,无跟踪');
  console.log(`\n正在拉取数据并回测... [${modeDesc.join(', ')}]\n`);

  let indexKlines = null;
  try {
    indexKlines = await fetchHistory('sh000001', 500);
    if (indexKlines.length < 30) indexKlines = null;
  } catch (e) {
    console.log('大盘指数拉取失败,跳过大盘环境过滤');
  }

  for (const code of codes) {
    try {
      const klines = await fetchAny(code, 500);
      if (klines.length < 80) {
        console.log(`${code} 数据不足(${klines.length}天),跳过\n`);
        continue;
      }
      const btResult = backtest(klines, {
        startIdx: 60, maxHoldDays: 30, indexKlines,
        trailing: args.trailing, trailingATR: args.trailingATR, useTP1: args.useTP1,
      });
      console.log(formatBacktestReport(code, klines, btResult));
      console.log('');
    } catch (e) {
      console.log(`${code} 回测出错: ${e.message}\n`);
    }
  }
}

if (require.main === module) {
  main().catch(e => console.error('回测出错:', e.message));
}

module.exports = { backtest, formatBacktestReport, resolveCode, getMarketEnvAtDate, main };
