/**
 * 评分模块 - 唯一的评分逻辑来源
 *
 * 这个模块取代了原来三处重复的评分代码:
 *   - analyze.js  analyzeStock()
 *   - server.js   analyzeStock() + backtestScore()
 *   - backtest.js quickScore()
 *
 * 所有调用方都通过 computeScore() 拿到同一份评分结果,
 * 这样回测验证的就是用户实际使用的策略。
 *
 * 这个模块是纯函数,无 IO。大盘环境由调用方注入。
 */

const indicators = require('./indicators');
const {
  SMA, EMA, MACD, RSI, KDJ, BOLL, ATR, ADX,
  detectDivergence,
  detectPatterns,
  detectMomentumExhaustion,
  calcFibonacci,
  detectGaps,
} = indicators;

/**
 * 计算单只股票的综合评分
 *
 * @param {Array} klines  K 线数组(至少 60 天)
 * @param {Object} options
 *   - marketEnv: { trend: 'bull'|'bear'|'neutral', score: number, signals: string[] }
 *   - realtime:  实时行情对象(可选,用于报告输出)
 * @returns 完整分析对象
 */
function computeScore(klines, options = {}) {
  const marketEnv = options.marketEnv || { trend: 'neutral', score: 0, signals: ['未提供大盘环境'] };
  const realtime = options.realtime || null;

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const volumes = klines.map(k => k.volume);
  const n = closes.length;
  const last = n - 1;

  // ===== 指标计算 =====
  const ma5 = SMA(closes, 5);
  const ma10 = SMA(closes, 10);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);
  const macd = MACD(closes);
  const rsi = RSI(closes, 14);
  const kdj = KDJ(highs, lows, closes);
  const boll = BOLL(closes);
  const atrArr = ATR(highs, lows, closes);
  const adxData = ADX(highs, lows, closes);

  // ===== 量能预计算 =====
  const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volRatio = +(vol5 / vol20).toFixed(2);
  const todayVolExpand = volumes[last] > vol20 * 1.2;
  const vol5Expand = vol5 > vol20 * 1.2;
  const vol5Shrink = vol5 < vol20 * 0.7;

  // ===== 趋势方向预判 =====
  const recent20 = closes.slice(-20);
  const trend20 = (recent20[recent20.length - 1] - recent20[0]) / recent20[0] * 100;
  const recent5 = closes.slice(-5);
  const trend5 = (recent5[recent5.length - 1] - recent5[0]) / recent5[0] * 100;
  const isBullTrend = trend20 > 3;
  const isBearTrend = trend20 < -3;

  // ===== 连续性辅助 =====
  function countConsecutiveDays(condFn, maxLookback = 10) {
    let count = 0;
    for (let i = last; i >= Math.max(0, last - maxLookback); i--) {
      if (condFn(i)) count++; else break;
    }
    return count;
  }
  function freshnessMultiplier(days) {
    if (days <= 1) return 1.0;
    if (days <= 3) return 0.7;
    if (days <= 5) return 0.4;
    return 0.2;
  }

  // --- 均线 + 信号确认 + 连续性 ---
  const maSignals = [];
  let maScore = 0;
  const bullAlign = ma5[last] > ma10[last] && ma10[last] > ma20[last];
  const bearAlign = ma5[last] < ma10[last] && ma10[last] < ma20[last];
  if (bullAlign) {
    const days = countConsecutiveDays(i => ma5[i] > ma10[i] && ma10[i] > ma20[i]);
    const mult = freshnessMultiplier(days);
    maSignals.push(`短期均线多头排列 (MA5>MA10>MA20, 已持续${days}天)`);
    maScore += +(2 * mult).toFixed(1);
    if (days > 5) maSignals.push('  注意: 多头排列已久,短期回调风险增大');
  } else if (bearAlign) {
    const days = countConsecutiveDays(i => ma5[i] < ma10[i] && ma10[i] < ma20[i]);
    const mult = freshnessMultiplier(days);
    maSignals.push(`短期均线空头排列 (MA5<MA10<MA20, 已持续${days}天)`);
    maScore -= +(2 * mult).toFixed(1);
    if (days > 5) maSignals.push('  注意: 空头排列已久,可能接近超卖');
  }

  if (closes[last] > ma20[last]) {
    maSignals.push(`收盘价在20日均线上方 (${closes[last]} > MA20=${ma20[last]})`);
    maScore += 1;
  } else {
    maSignals.push(`收盘价在20日均线下方 (${closes[last]} < MA20=${ma20[last]})`);
    maScore -= 1;
  }

  if (ma5[last] > ma10[last] && ma5[last - 1] <= ma10[last - 1]) {
    let cc = 0, details = [];
    if (todayVolExpand) { cc++; details.push('量能配合'); }
    if (isBullTrend) { cc++; details.push('趋势向上'); }
    if (closes[last] > ma20[last]) { cc++; details.push('站上MA20'); }
    if (cc >= 2) { maSignals.push(`MA5上穿MA10 (金叉) 确认: ${details.join('+')}`); maScore += 3; }
    else if (cc === 1) { maSignals.push(`MA5上穿MA10 (金叉) 部分确认: ${details.join('+')}`); maScore += 1.5; }
    else { maSignals.push('MA5上穿MA10 (金叉) 无确认,可靠性低'); maScore += 0.5; }
  } else if (ma5[last] < ma10[last] && ma5[last - 1] >= ma10[last - 1]) {
    let cc = 0, details = [];
    if (todayVolExpand) { cc++; details.push('放量下跌'); }
    if (isBearTrend) { cc++; details.push('趋势向下'); }
    if (closes[last] < ma20[last]) { cc++; details.push('跌破MA20'); }
    if (cc >= 2) { maSignals.push(`MA5下穿MA10 (死叉) 确认: ${details.join('+')}`); maScore -= 3; }
    else if (cc === 1) { maSignals.push(`MA5下穿MA10 (死叉) 部分确认: ${details.join('+')}`); maScore -= 1.5; }
    else { maSignals.push('MA5下穿MA10 (死叉) 无确认,可能是假信号'); maScore -= 0.5; }
  }

  // --- MACD + 多重确认 ---
  const macdSignals = [];
  let macdScore = 0;
  const macdGoldenCross = macd.dif[last] > macd.dea[last] && macd.dif[last - 1] <= macd.dea[last - 1];
  const macdDeathCross = macd.dif[last] < macd.dea[last] && macd.dif[last - 1] >= macd.dea[last - 1];

  if (macdGoldenCross) {
    let cc = 0, details = [];
    if (todayVolExpand || vol5Expand) { cc++; details.push('量能放大'); }
    if (isBullTrend) { cc++; details.push('趋势配合'); }
    if (macd.dif[last] > -0.5) { cc++; details.push('接近零轴'); }
    if (cc >= 2) { macdSignals.push(`MACD金叉 确认: ${details.join('+')}`); macdScore += 4; }
    else if (cc === 1) { macdSignals.push(`MACD金叉 部分确认: ${details.join('+')}`); macdScore += 2; }
    else { macdSignals.push('MACD金叉 缺乏确认,信号偏弱'); macdScore += 1; }
  } else if (macdDeathCross) {
    let cc = 0, details = [];
    if (todayVolExpand || vol5Expand) { cc++; details.push('放量下跌'); }
    if (isBearTrend) { cc++; details.push('趋势配合'); }
    if (macd.dif[last] < 0.5) { cc++; details.push('零轴下方'); }
    if (cc >= 2) { macdSignals.push(`MACD死叉 确认: ${details.join('+')}`); macdScore -= 4; }
    else if (cc === 1) { macdSignals.push(`MACD死叉 部分确认: ${details.join('+')}`); macdScore -= 2; }
    else { macdSignals.push('MACD死叉 缺乏确认,可能是假信号'); macdScore -= 1; }
  }
  if (macd.dif[last] > 0 && macd.dea[last] > 0) { macdSignals.push('MACD在零轴上方 (多头市场)'); macdScore += 1; }
  else if (macd.dif[last] < 0 && macd.dea[last] < 0) { macdSignals.push('MACD在零轴下方 (空头市场)'); macdScore -= 1; }
  if (macd.histogram[last] > macd.histogram[last - 1]) { macdSignals.push('MACD柱状线放大 (动能增强)'); macdScore += 1; }
  else { macdSignals.push('MACD柱状线缩小 (动能减弱)'); macdScore -= 1; }

  // --- RSI + 连续性 ---
  const rsiSignals = [];
  let rsiScore = 0;
  const rsiVal = rsi[last];
  if (rsiVal !== null) {
    if (rsiVal < 30) {
      const days = countConsecutiveDays(i => rsi[i] !== null && rsi[i] < 30);
      rsiSignals.push(`RSI=${rsiVal} 超卖区域 (已${days}天)`);
      rsiScore += days <= 2 ? 2 : 3;
    } else if (rsiVal > 70) {
      const days = countConsecutiveDays(i => rsi[i] !== null && rsi[i] > 70);
      rsiSignals.push(`RSI=${rsiVal} 超买区域 (已${days}天)`);
      rsiScore -= days <= 2 ? 1 : 2;
      if (days >= 3 && vol5Shrink) { rsiSignals.push('  超买+缩量,见顶概率增大'); rsiScore -= 1; }
    } else if (rsiVal >= 50) { rsiSignals.push(`RSI=${rsiVal} 偏强区域`); rsiScore += 1; }
    else { rsiSignals.push(`RSI=${rsiVal} 偏弱区域`); rsiScore -= 1; }
  }

  // --- KDJ + 多重确认 ---
  const kdjSignals = [];
  let kdjScore = 0;
  if (kdj.K[last] !== null) {
    const kdjGolden = kdj.K[last] > kdj.D[last] && kdj.K[last - 1] <= kdj.D[last - 1];
    const kdjDeath = kdj.K[last] < kdj.D[last] && kdj.K[last - 1] >= kdj.D[last - 1];
    if (kdjGolden) {
      const inOversold = kdj.J[last] < 30 || kdj.K[last] < 30;
      if (inOversold && todayVolExpand) { kdjSignals.push('KDJ金叉 超卖区+放量确认,信号强'); kdjScore += 3; }
      else if (inOversold || todayVolExpand) { kdjSignals.push('KDJ金叉 部分确认'); kdjScore += 2; }
      else { kdjSignals.push('KDJ金叉 (中位区,信号一般)'); kdjScore += 1; }
    } else if (kdjDeath) {
      const inOverbought = kdj.J[last] > 70 || kdj.K[last] > 70;
      if (inOverbought && todayVolExpand) { kdjSignals.push('KDJ死叉 超买区+放量确认,信号强'); kdjScore -= 3; }
      else if (inOverbought || todayVolExpand) { kdjSignals.push('KDJ死叉 部分确认'); kdjScore -= 2; }
      else { kdjSignals.push('KDJ死叉 (中位区,信号一般)'); kdjScore -= 1; }
    }
    if (kdj.J[last] < 20) {
      const days = countConsecutiveDays(i => kdj.J[i] !== null && kdj.J[i] < 20);
      kdjSignals.push(`J值=${kdj.J[last]} 超卖 (${days}天)`); kdjScore += days >= 3 ? 2 : 1;
    } else if (kdj.J[last] > 80) {
      const days = countConsecutiveDays(i => kdj.J[i] !== null && kdj.J[i] > 80);
      kdjSignals.push(`J值=${kdj.J[last]} 超买 (${days}天)`); kdjScore -= days >= 3 ? 2 : 1;
    }
    kdjSignals.push(`K=${kdj.K[last]} D=${kdj.D[last]} J=${kdj.J[last]}`);
  }

  // --- 布林带 + 连续性 ---
  const bollSignals = [];
  let bollScore = 0;
  if (boll.mid[last] !== null) {
    const price = closes[last];
    const bandwidth = ((boll.upper[last] - boll.lower[last]) / boll.mid[last] * 100).toFixed(2);
    if (price >= boll.upper[last]) {
      const days = countConsecutiveDays(i => boll.upper[i] !== null && closes[i] >= boll.upper[i]);
      bollSignals.push(`触及布林带上轨 (${boll.upper[last]}),已${days}天`);
      bollScore -= days >= 3 ? 2 : 1;
    } else if (price <= boll.lower[last]) {
      const days = countConsecutiveDays(i => boll.lower[i] !== null && closes[i] <= boll.lower[i]);
      bollSignals.push(`触及布林带下轨 (${boll.lower[last]}),已${days}天`);
      bollScore += days >= 2 ? 2 : 1;
      if (vol5Shrink) { bollSignals.push('  缩量触下轨,反弹概率较大'); bollScore += 1; }
    } else if (price > boll.mid[last]) { bollSignals.push('在布林带中轨上方运行'); bollScore += 1; }
    else { bollSignals.push('在布林带中轨下方运行'); bollScore -= 1; }
    bollSignals.push(`带宽=${bandwidth}%${bandwidth < 10 ? ' (收窄,可能变盘)' : ''}`);
  }

  // --- 量价 + 连续性 ---
  const volSignals = [];
  let volScore = 0;
  if (vol5 > vol20 * 1.5) {
    volSignals.push(`近5日量能显著放大 (量比=${volRatio})`);
    if (closes[last] > closes[last - 5]) {
      const days = countConsecutiveDays(i => volumes[i] > vol20 * 1.2 && i > 0 && closes[i] > closes[i - 1]);
      volSignals.push(`放量上涨 (连续${days}天),多头强势`);
      volScore += days >= 3 ? 3 : 2;
    } else { volSignals.push('放量下跌,注意风险'); volScore -= 2; }
  } else if (vol5 < vol20 * 0.7) {
    volSignals.push(`近5日量能萎缩 (量比=${volRatio})`);
    if (closes[last] > closes[last - 5]) { volSignals.push('缩量上涨,持续性存疑'); }
    else { volSignals.push('缩量回调,抛压减轻'); volScore += 1; }
  } else { volSignals.push(`量能平稳 (量比=${volRatio})`); }

  // --- 趋势 + 连续性 ---
  const trendSignals = [];
  let trendScore = 0;
  if (trend20 > 5) { trendSignals.push(`20日趋势:上涨 (+${trend20.toFixed(2)}%)`); trendScore += 2; }
  else if (trend20 < -5) { trendSignals.push(`20日趋势:下跌 (${trend20.toFixed(2)}%)`); trendScore -= 2; }
  else { trendSignals.push(`20日趋势:震荡 (${trend20.toFixed(2)}%)`); }

  const upDays = countConsecutiveDays(i => i > 0 && closes[i] > closes[i - 1]);
  const downDays = countConsecutiveDays(i => i > 0 && closes[i] < closes[i - 1]);
  if (trend5 > 3) {
    trendSignals.push(`5日短期趋势:强势上涨 (+${trend5.toFixed(2)}%, 连涨${upDays}天)`);
    trendScore += upDays <= 3 ? 1 : 0;
    if (upDays >= 5) { trendSignals.push('  连涨过久,短期回调概率增大'); trendScore -= 1; }
  } else if (trend5 < -3) {
    trendSignals.push(`5日短期趋势:快速下跌 (${trend5.toFixed(2)}%, 连跌${downDays}天)`);
    trendScore -= downDays <= 3 ? 1 : 0;
    if (downDays >= 5) { trendSignals.push('  连跌过久,超跌反弹概率增大'); trendScore += 1; }
  }

  // --- ADX 趋势强度 ---
  const adxSignals = [];
  let adxScore = 0;
  const adxVal = +adxData.adx[last].toFixed(2);
  const plusDI = adxData.plusDI[last];
  const minusDI = adxData.minusDI[last];
  let marketState = 'oscillating';
  if (adxVal >= 25) {
    marketState = 'trending';
    if (plusDI > minusDI) {
      adxSignals.push(`ADX=${adxVal} 强趋势上涨 (+DI=${plusDI.toFixed(1)} > -DI=${minusDI.toFixed(1)})`);
      adxScore += 2;
    } else {
      adxSignals.push(`ADX=${adxVal} 强趋势下跌 (-DI=${minusDI.toFixed(1)} > +DI=${plusDI.toFixed(1)})`);
      adxScore -= 2;
    }
    if (adxVal >= 40) adxSignals.push('趋势极强,顺势操作');
  } else if (adxVal >= 20) {
    adxSignals.push(`ADX=${adxVal} 弱趋势,方向不明确`);
  } else {
    adxSignals.push(`ADX=${adxVal} 震荡市,适合高抛低吸`);
  }

  // --- ATR 波动率 + 仓位建议 ---
  const atrVal = +atrArr[last].toFixed(3);
  const atrPct = +(atrVal / closes[last] * 100).toFixed(2);
  const atrSignals = [];
  let positionAdvice = '', suggestedStopLoss = 0;
  if (atrPct > 5) { positionAdvice = '波动极大,建议仓位<=20%'; suggestedStopLoss = +(closes[last] - atrVal * 2).toFixed(2); }
  else if (atrPct > 3) { positionAdvice = '波动较大,建议仓位30-50%'; suggestedStopLoss = +(closes[last] - atrVal * 1.5).toFixed(2); }
  else if (atrPct > 1.5) { positionAdvice = '波动适中,建议仓位50-70%'; suggestedStopLoss = +(closes[last] - atrVal * 1.5).toFixed(2); }
  else { positionAdvice = '波动较小,可加大仓位至80%'; suggestedStopLoss = +(closes[last] - atrVal * 2).toFixed(2); }
  atrSignals.push(`ATR=${atrVal} (${atrPct}%)`);
  atrSignals.push(positionAdvice);

  // --- 背离 ---
  const macdDivergence = detectDivergence(closes, macd.dif, 20);
  const rsiDivergence = detectDivergence(closes, rsi, 20);
  const divergenceSignals = [];
  let divergenceScore = 0;
  if (macdDivergence.bearish) { divergenceSignals.push('MACD ' + macdDivergence.description); divergenceScore -= 3; }
  if (macdDivergence.bullish) { divergenceSignals.push('MACD ' + macdDivergence.description); divergenceScore += 3; }
  if (rsiDivergence.bearish) { divergenceSignals.push('RSI ' + rsiDivergence.description); divergenceScore -= 2; }
  if (rsiDivergence.bullish) { divergenceSignals.push('RSI ' + rsiDivergence.description); divergenceScore += 2; }
  if (divergenceSignals.length === 0) divergenceSignals.push('未检测到明显背离');

  // --- 量价背离 ---
  const volDivSignals = [];
  let volDivScore = 0;
  if (closes[last] > closes[last - 5] && vol5 < vol20 * 0.7) { volDivSignals.push('量价背离:价涨量缩,动力不足'); volDivScore -= 2; }
  if (closes[last] < closes[last - 5] && vol5 < vol20 * 0.6) { volDivSignals.push('缩量下跌:抛压衰竭'); volDivScore += 1; }
  if (Math.abs(trend5) < 2 && vol5 > vol20 * 1.3) { volDivSignals.push('横盘放量:关注方向选择'); }

  // --- 形态 ---
  const patterns = detectPatterns(klines, ma20, boll);
  let patternScore = 0;
  const patternSignals = [];
  for (const p of patterns) { patternSignals.push(`[${p.type === 'bullish' ? '看多' : '看空'}] ${p.name}: ${p.description}`); patternScore += p.weight; }
  if (patternSignals.length === 0) patternSignals.push('未识别到明显形态');

  // --- 动量衰竭 ---
  const momentum = detectMomentumExhaustion(klines);

  // --- 斐波那契 ---
  const fib = calcFibonacci(klines, 60);
  const fibSignals = [];
  fibSignals.push(`趋势: ${fib.trend} (高${fib.highPrice} 低${fib.lowPrice})`);
  fibSignals.push(`最近位: ${fib.nearest.name}=${fib.nearest.price}`);

  // --- 缺口 ---
  const gapAnalysis = detectGaps(klines, 20);

  // --- 支撑/压力 ---
  const supportResistance = [];
  const high20 = Math.max(...highs.slice(-20));
  const low20 = Math.min(...lows.slice(-20));
  supportResistance.push(`近20日压力位: ${high20}`);
  supportResistance.push(`近20日支撑位: ${low20}`);
  if (ma20[last]) supportResistance.push(`MA20动态支撑/压力: ${ma20[last]}`);
  if (boll.upper[last]) {
    supportResistance.push(`布林上轨压力: ${boll.upper[last]}`);
    supportResistance.push(`布林下轨支撑: ${boll.lower[last]}`);
  }

  // ==================== 动态加权评分 ====================
  let weightedScore = 0;
  if (marketState === 'trending') {
    weightedScore = maScore * 1.5 + macdScore * 1.3 + adxScore * 1.5
      + rsiScore * 0.7 + kdjScore * 0.7 + bollScore * 0.8
      + volScore + trendScore * 1.3 + divergenceScore * 1.2 + volDivScore + patternScore
      + momentum.score * 1.2 + gapAnalysis.score * 0.8;
  } else {
    weightedScore = maScore * 0.8 + macdScore * 0.8 + adxScore * 0.8
      + rsiScore * 1.5 + kdjScore * 1.5 + bollScore * 1.5
      + volScore + trendScore * 0.8 + divergenceScore * 1.3 + volDivScore + patternScore * 1.2
      + momentum.score * 1.0 + gapAnalysis.score * 1.0;
  }

  // 趋势一致性
  const trend60 = ma60[last] !== null ? (closes[last] - closes[Math.max(0, last - 60)]) / closes[Math.max(0, last - 60)] * 100 : 0;
  const shortBull = trend5 > 1, midBull = trend20 > 2, longBull = trend60 > 5;
  const shortBear = trend5 < -1, midBear = trend20 < -2, longBear = trend60 < -5;
  if (shortBull && midBull && longBull) weightedScore += 3;
  else if (shortBear && midBear && longBear) weightedScore -= 3;
  else if ((shortBull && midBear) || (shortBear && midBull)) {
    if (weightedScore !== 0) weightedScore *= 0.8;
  }

  // ADX 震荡市惩罚
  if (adxVal < 15) weightedScore *= 0.4;
  else if (adxVal < 20 && Math.abs(weightedScore) > 0) weightedScore *= 0.6;

  // 低波动股降权
  if (atrPct < 1.5 && Math.abs(weightedScore) > 3) weightedScore *= 0.7;

  // 量能确认加成
  if (weightedScore > 5 && vol5Expand) weightedScore *= 1.15;
  else if (weightedScore < -5 && vol5Expand) weightedScore *= 1.15;
  else if (weightedScore > 5 && vol5Shrink) weightedScore *= 0.8;

  // 大盘环境修正
  if (marketEnv.trend === 'bull') { weightedScore += 1.5; }
  else if (marketEnv.trend === 'bear') { weightedScore -= 1.5; if (weightedScore > 0) weightedScore *= 0.7; }

  const totalScore = +weightedScore.toFixed(1);

  // 风险收益比
  const currentPrice = closes[last];
  const supportLevels = [suggestedStopLoss];
  if (ma20[last] && ma20[last] < currentPrice) supportLevels.push(ma20[last]);
  if (boll.lower[last] && boll.lower[last] < currentPrice) supportLevels.push(boll.lower[last]);
  supportLevels.push(low20);
  const validSupports = supportLevels.filter(s => s < currentPrice).sort((a, b) => b - a);
  const smartStopLoss = validSupports.length > 0 ? +validSupports[0].toFixed(2) : suggestedStopLoss;

  const resistanceLevels = [];
  if (high20 > currentPrice * 1.02) resistanceLevels.push(high20);
  if (boll.upper[last] && boll.upper[last] > currentPrice * 1.02) resistanceLevels.push(boll.upper[last]);
  const fibLevels = Object.values(fib.levels).filter(v => v > currentPrice * 1.03);
  if (fibLevels.length > 0) resistanceLevels.push(Math.min(...fibLevels));
  resistanceLevels.push(+(currentPrice + atrVal * 2).toFixed(2));
  resistanceLevels.push(+(currentPrice + atrVal * 3).toFixed(2));
  const validResistance = [...new Set(resistanceLevels.filter(r => r > currentPrice))].sort((a, b) => a - b);
  const smartTP1 = validResistance.length > 0 ? +validResistance[0].toFixed(2) : +(currentPrice + atrVal * 2).toFixed(2);
  const smartTP2 = validResistance.length > 1 ? +validResistance[1].toFixed(2) : +(currentPrice + atrVal * 3).toFixed(2);

  const riskAmt = currentPrice - smartStopLoss;
  const rewardAmt = smartTP1 - currentPrice;
  const riskRewardRatio = riskAmt > 0 ? +(rewardAmt / riskAmt).toFixed(2) : 99;

  let signal, advice;
  if (totalScore >= 10) { signal = '强烈买入'; advice = '多项指标共振看多,可考虑积极建仓'; }
  else if (totalScore >= 5) { signal = '建议买入'; advice = '技术面偏多,可适量买入或加仓'; }
  else if (totalScore >= 1) { signal = '谨慎买入'; advice = '信号偏多但不强烈,可小仓位试探'; }
  else if (totalScore >= -4) { signal = '观望'; advice = '多空信号交织,建议等待更明确的方向'; }
  else if (totalScore >= -9) { signal = '建议卖出'; advice = '技术面偏空,建议减仓或观望'; }
  else { signal = '强烈卖出'; advice = '多项指标看空,建议清仓回避'; }
  if (riskRewardRatio < 1.0 && totalScore > 0) { advice += ';风险收益比不佳(<1:1),建议等回调再入场'; }
  else if (riskRewardRatio >= 2.0 && totalScore > 0) { advice += ';风险收益比优秀(1:' + riskRewardRatio + '),入场性价比高'; }

  // === 买入/卖出条件 ===
  const buyConditions = [];
  const sellConditions = [];
  const distToMA20 = ma20[last] ? +((currentPrice - ma20[last]) / currentPrice * 100).toFixed(1) : 0;
  const distToHigh20 = +((high20 - currentPrice) / currentPrice * 100).toFixed(1);

  if (totalScore >= 5) {
    if (distToMA20 < 3) {
      buyConditions.push(`[立即] 当前价附近(${(currentPrice*0.99).toFixed(2)}~${currentPrice.toFixed(2)})直接买入,MA20(${ma20[last]})支撑`);
    } else {
      const intraSupport = +(currentPrice - atrVal * 0.5).toFixed(2);
      const ma5Val = ma5[last] ? +ma5[last].toFixed(2) : intraSupport;
      buyConditions.push(`[首选] 日内回调至${Math.max(intraSupport, ma5Val)}附近轻仓试探`);
    }
    buyConditions.push(`[稳健] 分批: ${currentPrice.toFixed(2)}(1/3), 回调${(currentPrice*0.98).toFixed(2)}加仓(1/3), ${(currentPrice*0.95).toFixed(2)}补仓(1/3)`);
  } else if (totalScore >= 1) {
    buyConditions.push(`[首选] 回调2-3%至${(currentPrice*0.97).toFixed(2)}附近,出现止跌信号后买入`);
    if (macd.dif[last] < macd.dea[last]) buyConditions.push('[等信号] MACD金叉确认后次日买入');
  } else {
    if (boll.lower[last]) buyConditions.push(`[激进] 跌至布林下轨${boll.lower[last].toFixed(2)}+RSI<30+缩量,轻仓抄底`);
    if (ma20[last] && currentPrice < ma20[last]) buyConditions.push(`[等信号] 放量站回MA20(${ma20[last].toFixed(2)})上方后买入`);
  }
  if (distToHigh20 > 0 && distToHigh20 < 5) {
    buyConditions.push(`[突破] 放量突破${high20.toFixed(2)}时跟进,不追超${(high20*1.03).toFixed(2)}`);
  }

  sellConditions.push(`[止损] ${smartStopLoss} (亏${(riskAmt/currentPrice*100).toFixed(1)}%),跌破即走`);
  if (rsiVal > 75) sellConditions.push(`[止盈] RSI=${rsiVal}超买,冲高回落减半仓`);
  if (ma5[last] && currentPrice > ma5[last]) sellConditions.push(`[减仓] 跌破MA5(${ma5[last].toFixed(2)})且次日不收回`);
  if (ma20[last] && currentPrice > ma20[last]) sellConditions.push(`[清仓] 跌破MA20(${ma20[last].toFixed(2)})且3日不收回`);
  if (smartTP1 > currentPrice) sellConditions.push(`[目标] 到达${smartTP1}附近分批止盈`);

  return {
    realtime,
    marketState: marketState === 'trending' ? '趋势市' : '震荡市',
    marketEnv,
    buyConditions,
    sellConditions,
    indicators: {
      ma: { score: maScore, signals: maSignals },
      macd: { score: macdScore, signals: macdSignals, values: { dif: macd.dif[last], dea: macd.dea[last], histogram: macd.histogram[last] } },
      rsi: { score: rsiScore, signals: rsiSignals, value: rsiVal },
      kdj: { score: kdjScore, signals: kdjSignals },
      boll: { score: bollScore, signals: bollSignals },
      volume: { score: volScore, signals: volSignals },
      trend: { score: trendScore, signals: trendSignals },
      adx: { score: adxScore, signals: adxSignals },
      atr: { signals: atrSignals },
      divergence: { score: divergenceScore, signals: divergenceSignals },
      volumeDivergence: { score: volDivScore, signals: volDivSignals },
      patterns: { score: patternScore, signals: patternSignals },
      momentum: { score: momentum.score, signals: momentum.signals },
      gaps: { score: gapAnalysis.score, signals: gapAnalysis.signals },
      fibonacci: { signals: fibSignals },
    },
    supportResistance,
    riskReward: {
      stopLoss: smartStopLoss,
      takeProfit1: smartTP1,
      takeProfit2: smartTP2,
      riskRewardRatio,
      positionAdvice,
    },
    summary: {
      totalScore,
      normalizedScore: Math.max(0, Math.min(100, +((totalScore + 20) / 40 * 100).toFixed(0))),
      signal,
      advice,
      marketState: marketState === 'trending' ? '趋势市' : '震荡市',
      marketEnv: marketEnv.trend === 'bull' ? '大盘偏强' : marketEnv.trend === 'bear' ? '大盘偏弱' : '大盘震荡',
      breakdown: `均线(${maScore}) MACD(${macdScore}) RSI(${rsiScore}) KDJ(${kdjScore}) 布林(${bollScore}) 量价(${volScore}) 趋势(${trendScore}) ADX(${adxScore}) 背离(${divergenceScore}) 形态(${patternScore}) 动量(${momentum.score}) 缺口(${gapAnalysis.score}) = ${totalScore}(加权)`,
    },
  };
}

/**
 * 给回测用的"截至第 idx 天"评分
 * 用 klines.slice(0, idx+1) 作为可见数据,模拟当天分析
 *
 * @param {Array} klines  完整 K 线
 * @param {number} idx    "今天"的索引
 * @param {Object} options.marketEnv  可选大盘环境
 * @returns {number} 综合评分(单值)
 */
function computeQuickScore(klines, idx, options = {}) {
  if (idx < 60) return 0;
  const visible = klines.slice(0, idx + 1);
  const result = computeScore(visible, { marketEnv: options.marketEnv });
  return result.summary.totalScore;
}

/**
 * 给回测用的完整评分(返回信号类型 + 关键中间值)
 * 比 computeQuickScore 多返回 stopLoss / takeProfit 等,P1 阶段用于止损止盈退出
 */
function computeBacktestSnapshot(klines, idx, options = {}) {
  if (idx < 60) return null;
  const visible = klines.slice(0, idx + 1);
  const result = computeScore(visible, { marketEnv: options.marketEnv });
  const highs = visible.map(k => k.high);
  const lows = visible.map(k => k.low);
  const closes = visible.map(k => k.close);
  const atrArr = ATR(highs, lows, closes);
  const atrVal = +(atrArr[atrArr.length - 1] || 0).toFixed(3);
  return {
    score: result.summary.totalScore,
    signal: result.summary.signal,
    stopLoss: result.riskReward.stopLoss,
    takeProfit1: result.riskReward.takeProfit1,
    takeProfit2: result.riskReward.takeProfit2,
    rsi: result.indicators.rsi.value,
    atr: atrVal,
    closePrice: closes[closes.length - 1],
  };
}

module.exports = {
  computeScore,
  computeQuickScore,
  computeBacktestSnapshot,
};
