/**
 * 技术指标共享模块
 *
 * 注意:
 *   - EMA 使用前 period 日 SMA 作为种子(标准做法,前期值更准确)
 *   - RSI 使用 Wilder 平滑(与同花顺/通达信/TradingView 一致)
 *   - ADX 使用 Wilder smoothing(标准 Welles Wilder 算法)
 */

// ==================== 基础工具 ====================

function round(v, n = 3) {
  if (v === null || v === undefined || Number.isNaN(v)) return null;
  return +v.toFixed(n);
}

/** 简单移动平均 */
function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    result.push(round(sum / period));
  }
  return result;
}

/**
 * 指数移动平均
 * 前 period-1 个值返回 null;第 period 个值用 SMA 作种子;之后用 EMA 递推
 */
function EMA(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += data[i];
  seed = seed / period;
  result[period - 1] = round(seed);
  for (let i = period; i < data.length; i++) {
    result[i] = round(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

/**
 * Wilder 平滑(用于 RSI / ADX)
 * 第一个值是前 period 日的简单平均,之后:val[i] = (val[i-1] * (period-1) + data[i]) / period
 */
function wilderSmooth(data, period) {
  const result = new Array(data.length).fill(null);
  if (data.length < period) return result;
  let seed = 0;
  for (let i = 0; i < period; i++) seed += data[i];
  result[period - 1] = seed / period;
  for (let i = period; i < data.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + data[i]) / period;
  }
  return result;
}

// ==================== MACD ====================

/** MACD(12, 26, 9) — 由于早期 EMA 为 null,前 25 项 dif 也为 null */
function MACD(closes) {
  const ema12 = EMA(closes, 12);
  const ema26 = EMA(closes, 26);
  const dif = ema12.map((v, i) => (v === null || ema26[i] === null) ? null : round(v - ema26[i]));
  // 对 dif 做 EMA9 时需要跳过 null 起点
  const dea = emaWithSkip(dif, 9);
  const histogram = dif.map((v, i) => (v === null || dea[i] === null) ? null : round((v - dea[i]) * 2));
  return { dif, dea, histogram };
}

/** EMA 计算时跳过开头的 null(用于 MACD 的 DEA 计算) */
function emaWithSkip(data, period) {
  const result = new Array(data.length).fill(null);
  // 找到第一个非 null 索引
  let start = 0;
  while (start < data.length && data[start] === null) start++;
  if (data.length - start < period) return result;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = start; i < start + period; i++) seed += data[i];
  seed = seed / period;
  const seedIdx = start + period - 1;
  result[seedIdx] = round(seed);
  for (let i = seedIdx + 1; i < data.length; i++) {
    result[i] = round(data[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

// ==================== RSI(Wilder) ====================

function RSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;

  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  // gains/losses 长度 = closes.length - 1, gains[i] 对应 closes[i+1]

  // 第一个 RSI 出现在 closes 索引 period 处:用 gains[0..period-1] 的简单平均
  let avgGain = 0, avgLoss = 0;
  for (let i = 0; i < period; i++) { avgGain += gains[i]; avgLoss += losses[i]; }
  avgGain /= period; avgLoss /= period;
  let rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
  result[period] = avgLoss === 0 ? 100 : round(100 - 100 / (1 + rs), 2);

  for (let i = period + 1; i < closes.length; i++) {
    const gIdx = i - 1;
    avgGain = (avgGain * (period - 1) + gains[gIdx]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[gIdx]) / period;
    rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    result[i] = avgLoss === 0 ? 100 : round(100 - 100 / (1 + rs), 2);
  }
  return result;
}

// ==================== KDJ ====================

function KDJ(highs, lows, closes, n = 9) {
  const K = [], D = [], J = [];
  let prevK = 50, prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) { K.push(null); D.push(null); J.push(null); continue; }
    let highN = -Infinity, lowN = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      highN = Math.max(highN, highs[j]);
      lowN = Math.min(lowN, lows[j]);
    }
    const rsv = highN === lowN ? 50 : ((closes[i] - lowN) / (highN - lowN)) * 100;
    const k = +(2 / 3 * prevK + 1 / 3 * rsv).toFixed(2);
    const d = +(2 / 3 * prevD + 1 / 3 * k).toFixed(2);
    const j = +(3 * k - 2 * d).toFixed(2);
    K.push(k); D.push(d); J.push(j);
    prevK = k; prevD = d;
  }
  return { K, D, J };
}

// ==================== 布林带 ====================

function BOLL(closes, period = 20, multiplier = 2) {
  const mid = SMA(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]) ** 2;
    const std = Math.sqrt(sum / period);
    upper.push(round(mid[i] + multiplier * std));
    lower.push(round(mid[i] - multiplier * std));
  }
  return { upper, mid, lower };
}

// ==================== ATR(Wilder) ====================

function calcTR(highs, lows, closes) {
  const tr = [];
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) { tr.push(highs[i] - lows[i]); continue; }
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(hl, hc, lc));
  }
  return tr;
}

function ATR(highs, lows, closes, period = 14) {
  const tr = calcTR(highs, lows, closes);
  const atr = wilderSmooth(tr, period);
  // 早期 null 用 TR 兜底,避免下游空指针
  return atr.map((v, i) => v === null ? round(tr[i] || 0) : round(v));
}

// ==================== ADX(Wilder) ====================

function ADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const tr = calcTR(highs, lows, closes);
  const plusDM = [0], minusDM = [0];
  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const sTR = wilderSmooth(tr, period);
  const sPDM = wilderSmooth(plusDM, period);
  const sMDM = wilderSmooth(minusDM, period);
  const plusDI = new Array(n).fill(0);
  const minusDI = new Array(n).fill(0);
  const dx = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    if (sTR[i] === null || sTR[i] === 0) continue;
    plusDI[i] = (sPDM[i] / sTR[i]) * 100;
    minusDI[i] = (sMDM[i] / sTR[i]) * 100;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum > 0 ? (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100 : 0;
  }
  // ADX = DX 的 Wilder 平滑;首个 ADX 出现在 2*period-1
  const adx = wilderSmooth(dx, period);
  return {
    plusDI: plusDI.map(v => +v.toFixed(2)),
    minusDI: minusDI.map(v => +v.toFixed(2)),
    adx: adx.map(v => v === null ? 0 : +v.toFixed(2)),
  };
}

// ==================== VWAP ====================

function calcVWAP(closes, volumes, period = 20) {
  const n = closes.length;
  let sumPV = 0, sumV = 0;
  const start = Math.max(0, n - period);
  for (let i = start; i < n; i++) { sumPV += closes[i] * volumes[i]; sumV += volumes[i]; }
  return sumV > 0 ? +(sumPV / sumV).toFixed(3) : closes[n - 1];
}

// ==================== ZigZag + 背离 ====================

/**
 * ZigZag swing 检测
 * 从价格序列中提取局部高/低点,过滤掉小于 threshold 比例的小波动
 *
 * @param {number[]} prices  价格序列(收盘价)
 * @param {number} threshold 反转阈值(默认 3%);从极值反向走超过这个比例才确认为 swing
 * @returns swings 数组,每项:{ idx, price, type: 'high'|'low' }
 *   注意:最后一个 swing 是"未确认的当前进行中极值",可能被后续行情推翻
 */
function zigzag(prices, threshold = 0.03) {
  const n = prices.length;
  if (n < 2) return [];
  const swings = [];
  let dir = null;
  let extremeIdx = 0;
  let extremePrice = prices[0];

  for (let i = 1; i < n; i++) {
    const p = prices[i];
    if (dir === null) {
      if (p > extremePrice * (1 + threshold)) {
        swings.push({ idx: extremeIdx, price: extremePrice, type: 'low' });
        dir = 'up'; extremeIdx = i; extremePrice = p;
      } else if (p < extremePrice * (1 - threshold)) {
        swings.push({ idx: extremeIdx, price: extremePrice, type: 'high' });
        dir = 'down'; extremeIdx = i; extremePrice = p;
      } else if (p > extremePrice) {
        extremeIdx = i; extremePrice = p;
      } else if (p < extremePrice) {
        extremeIdx = i; extremePrice = p;
      }
    } else if (dir === 'up') {
      if (p > extremePrice) { extremeIdx = i; extremePrice = p; }
      else if (p < extremePrice * (1 - threshold)) {
        swings.push({ idx: extremeIdx, price: extremePrice, type: 'high' });
        dir = 'down'; extremeIdx = i; extremePrice = p;
      }
    } else { // down
      if (p < extremePrice) { extremeIdx = i; extremePrice = p; }
      else if (p > extremePrice * (1 + threshold)) {
        swings.push({ idx: extremeIdx, price: extremePrice, type: 'low' });
        dir = 'up'; extremeIdx = i; extremePrice = p;
      }
    }
  }
  // 收尾:最后一段的进行中极值(未被反向确认)
  swings.push({
    idx: extremeIdx, price: extremePrice,
    type: dir === 'up' ? 'high' : (dir === 'down' ? 'low' : 'high'),
    unconfirmed: true,
  });
  return swings;
}

/**
 * 价格与指标背离(基于 ZigZag swing)
 *
 * 顶背离:最近两个 swing high 中,price 创新高但 indicator 没创新高 → bearish
 * 底背离:最近两个 swing low 中,price 创新低但 indicator 没创新低 → bullish
 *
 * @param {number[]} closes
 * @param {number[]} indicator   指标序列(同长度,允许 null)
 * @param {number} lookback      仅在最近 lookback 个 K 线内寻找 swing(默认 40,需大于 ZigZag 周期才有意义)
 * @param {number} threshold     ZigZag 反转阈值(默认 3%)
 */
function detectDivergence(closes, indicator, lookback = 40, threshold = 0.03) {
  const result = { bullish: false, bearish: false, description: '' };
  const n = closes.length;
  if (n < 5) return result;

  const start = Math.max(0, n - lookback);
  const slice = closes.slice(start);
  const sliceSwings = zigzag(slice, threshold);
  const swings = sliceSwings
    .map(s => ({ ...s, idx: s.idx + start }))
    .filter(s => indicator[s.idx] !== null && indicator[s.idx] !== undefined);

  const highs = swings.filter(s => s.type === 'high');
  const lows = swings.filter(s => s.type === 'low');

  if (highs.length >= 2) {
    const recent = highs[highs.length - 1];
    const prev = highs[highs.length - 2];
    if (recent.price > prev.price && indicator[recent.idx] < indicator[prev.idx]) {
      result.bearish = true;
      result.description = `顶背离:${prev.idx}日价${prev.price.toFixed(2)}→${recent.idx}日新高${recent.price.toFixed(2)},指标${indicator[prev.idx].toFixed(2)}→${indicator[recent.idx].toFixed(2)}未跟随`;
    }
  }
  if (lows.length >= 2) {
    const recent = lows[lows.length - 1];
    const prev = lows[lows.length - 2];
    if (recent.price < prev.price && indicator[recent.idx] > indicator[prev.idx]) {
      result.bullish = true;
      result.description = `底背离:${prev.idx}日价${prev.price.toFixed(2)}→${recent.idx}日新低${recent.price.toFixed(2)},指标${indicator[prev.idx].toFixed(2)}→${indicator[recent.idx].toFixed(2)}未跟随`;
    }
  }
  return result;
}

// ==================== 形态识别 ====================

function detectPatterns(klines, ma20, boll) {
  const n = klines.length;
  const last = n - 1;
  const patterns = [];

  if (n >= 5 && ma20[last] !== null) {
    const vol5Avg = klines.slice(-5).reduce((s, k) => s + k.volume, 0) / 5;
    const vol20Avg = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
    const nearMA20 = Math.abs(klines[last].close - ma20[last]) / ma20[last] < 0.02;
    const volShrink = vol5Avg < vol20Avg * 0.8;
    const priorUptrend = klines[last].close > klines[Math.max(0, last - 20)].close;
    if (nearMA20 && volShrink && priorUptrend) {
      patterns.push({ type: 'bullish', name: '缩量回踩MA20', description: '上升趋势中缩量回踩均线支撑', weight: 3 });
    }
  }
  if (n >= 20) {
    const prevHigh = Math.max(...klines.slice(-21, -1).map(k => k.high));
    const todayBreak = klines[last].close > prevHigh;
    const vol20Avg = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
    const volExpand = klines[last].volume > vol20Avg * 1.5;
    if (todayBreak && volExpand) {
      patterns.push({ type: 'bullish', name: '放量突破前高', description: `突破近20日高点${prevHigh.toFixed(2)}`, weight: 3 });
    }
  }
  if (n >= 3) {
    const prevHigh = Math.max(...klines.slice(-22, -2).map(k => k.high));
    const dayBefore = klines[last - 1];
    const today = klines[last];
    if (dayBefore.high > prevHigh && today.close < prevHigh * 0.98) {
      patterns.push({ type: 'bearish', name: '假突破回落', description: '突破前高后快速回落,多头陷阱', weight: -3 });
    }
  }
  if (n >= 1) {
    const today = klines[last];
    const body = Math.abs(today.close - today.open);
    const lowerShadow = Math.min(today.open, today.close) - today.low;
    const upperShadow = today.high - Math.max(today.open, today.close);
    if (lowerShadow > body * 2 && upperShadow < body * 0.5 && body > 0) {
      patterns.push({ type: 'bullish', name: '锤子线', description: '长下影线,下方有买盘支撑', weight: 2 });
    }
    if (upperShadow > body * 2 && lowerShadow < body * 0.5 && body > 0) {
      patterns.push({ type: 'bearish', name: '射击之星', description: '长上影线,上方抛压沉重', weight: -2 });
    }
  }
  if (n >= 3) {
    const last3 = klines.slice(-3);
    if (last3.every(k => k.close > k.open) && last3[2].close > last3[1].close && last3[1].close > last3[0].close) {
      patterns.push({ type: 'bullish', name: '三连阳', description: '连续三日收阳逐步走高', weight: 2 });
    }
    if (last3.every(k => k.close < k.open) && last3[2].close < last3[1].close && last3[1].close < last3[0].close) {
      patterns.push({ type: 'bearish', name: '三连阴', description: '连续三日收阴逐步走低', weight: -2 });
    }
  }
  if (boll.upper[last] !== null && last >= 5 && boll.upper[last - 5] !== null) {
    const bw_5ago = (boll.upper[last - 5] - boll.lower[last - 5]) / boll.mid[last - 5];
    if (bw_5ago < 0.08 && klines[last].close > boll.upper[last]) {
      patterns.push({ type: 'bullish', name: '布林收窄后向上突破', description: '波动率收缩后向上选择方向', weight: 3 });
    }
    if (bw_5ago < 0.08 && klines[last].close < boll.lower[last]) {
      patterns.push({ type: 'bearish', name: '布林收窄后向下突破', description: '波动率收缩后向下选择方向', weight: -3 });
    }
  }
  return patterns;
}

// ==================== 动量衰竭 ====================

function detectMomentumExhaustion(klines) {
  const n = klines.length;
  const last = n - 1;
  const result = { bullExhaustion: false, bearExhaustion: false, signals: [], score: 0 };
  if (n < 10) return result;
  const recentUp = [];
  for (let i = last; i >= Math.max(0, last - 9); i--) {
    if (klines[i].close > klines[i].open) recentUp.unshift(i); else break;
  }
  if (recentUp.length >= 3) {
    const changes = recentUp.map(i => (klines[i].close - klines[i].open) / klines[i].open * 100);
    const vols = recentUp.map(i => klines[i].volume);
    const changeDeclining = changes[changes.length - 1] < changes[0] * 0.6;
    const volDeclining = vols[vols.length - 1] < vols[0] * 0.7;
    if (changeDeclining && volDeclining) { result.bullExhaustion = true; result.signals.push(`上涨动量衰竭:连涨${recentUp.length}天但涨幅+量能递减`); result.score -= 3; }
    else if (changeDeclining || volDeclining) { result.signals.push(`上涨动量减弱:${changeDeclining ? '涨幅递减' : '量能递减'}`); result.score -= 1; }
  }
  const recentDown = [];
  for (let i = last; i >= Math.max(0, last - 9); i--) {
    if (klines[i].close < klines[i].open) recentDown.unshift(i); else break;
  }
  if (recentDown.length >= 3) {
    const changes = recentDown.map(i => Math.abs((klines[i].close - klines[i].open) / klines[i].open * 100));
    const vols = recentDown.map(i => klines[i].volume);
    const changeDeclining = changes[changes.length - 1] < changes[0] * 0.6;
    const volDeclining = vols[vols.length - 1] < vols[0] * 0.7;
    if (changeDeclining && volDeclining) { result.bearExhaustion = true; result.signals.push(`下跌动量衰竭:连跌${recentDown.length}天但跌幅+量能递减`); result.score += 3; }
    else if (changeDeclining || volDeclining) { result.signals.push(`下跌动量减弱:${changeDeclining ? '跌幅递减' : '量能递减'}`); result.score += 1; }
  }
  if (result.signals.length === 0) result.signals.push('动量正常');
  return result;
}

// ==================== 斐波那契 ====================

function calcFibonacci(klines, lookback = 60) {
  const n = klines.length;
  const slice = klines.slice(Math.max(0, n - lookback));
  const highs = slice.map(k => k.high);
  const lows = slice.map(k => k.low);
  const highPrice = Math.max(...highs);
  const lowPrice = Math.min(...lows);
  const highIdx = highs.indexOf(highPrice);
  const lowIdx = lows.indexOf(lowPrice);
  const diff = highPrice - lowPrice;
  const isDowntrend = highIdx < lowIdx;
  const currentPrice = klines[n - 1].close;
  const levels = {};
  if (isDowntrend) {
    levels['0%(低点)'] = lowPrice;
    levels['23.6%'] = +(lowPrice + diff * 0.236).toFixed(2);
    levels['38.2%'] = +(lowPrice + diff * 0.382).toFixed(2);
    levels['50%'] = +(lowPrice + diff * 0.5).toFixed(2);
    levels['61.8%'] = +(lowPrice + diff * 0.618).toFixed(2);
    levels['100%(高点)'] = highPrice;
  } else {
    levels['100%(高点)'] = highPrice;
    levels['23.6%'] = +(highPrice - diff * 0.236).toFixed(2);
    levels['38.2%'] = +(highPrice - diff * 0.382).toFixed(2);
    levels['50%'] = +(highPrice - diff * 0.5).toFixed(2);
    levels['61.8%'] = +(highPrice - diff * 0.618).toFixed(2);
    levels['0%(低点)'] = lowPrice;
  }
  const allLevels = Object.entries(levels).map(([name, price]) => ({ name, price, dist: Math.abs(currentPrice - price) }));
  allLevels.sort((a, b) => a.dist - b.dist);
  return { levels, isDowntrend, highPrice, lowPrice, currentPrice, nearest: allLevels[0], trend: isDowntrend ? '下跌回撤' : '上涨回调' };
}

// ==================== 缺口检测 ====================

/**
 * 缺口分析(只保留"有效缺口")
 *
 * 过滤条件(P1 修复):
 *   - 缺口幅度 > MIN_GAP_PCT(默认 0.5%) — 排除普通跳空开盘
 *   - 当日量能 > 1.5 × 20日均量 — 排除无量跳空(可能是除权或异常)
 *
 * 这两个条件大幅减少了"满屏假缺口"的问题。
 */
function detectGaps(klines, lookback = 20, options = {}) {
  const { minGapPct = 0.5, volMultiple = 1.5 } = options;
  const n = klines.length;
  const last = n - 1;
  const vol20 = klines.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;

  const gaps = [];
  for (let i = Math.max(1, n - lookback); i <= last; i++) {
    const prev = klines[i - 1], curr = klines[i];
    const isVolValid = curr.volume > vol20 * volMultiple;
    if (curr.low > prev.high) {
      const sizePct = (curr.low - prev.high) / prev.close * 100;
      if (sizePct >= minGapPct && isVolValid) {
        gaps.push({ type: 'up', date: curr.date, bottom: prev.high, top: curr.low, size: +sizePct.toFixed(2), idx: i });
      }
    }
    if (curr.high < prev.low) {
      const sizePct = (prev.low - curr.high) / prev.close * 100;
      if (sizePct >= minGapPct && isVolValid) {
        gaps.push({ type: 'down', date: curr.date, bottom: curr.high, top: prev.low, size: +sizePct.toFixed(2), idx: i });
      }
    }
  }

  const signals = [];
  let score = 0;
  for (const gap of gaps) {
    let filled = false;
    for (let j = gap.idx + 1; j <= last; j++) {
      if (gap.type === 'up' && klines[j].low <= gap.bottom) { filled = true; break; }
      if (gap.type === 'down' && klines[j].high >= gap.top) { filled = true; break; }
    }
    if (filled) continue;
    const isRecent = (last - gap.idx) <= 3;
    if (gap.type === 'up') {
      signals.push(`上跳缺口(${gap.date}): ${gap.bottom}→${gap.top} (+${gap.size}%) 未回补`);
      // 有效缺口本身已经过量能滤镜,所以最近的直接给满分
      if (isRecent) score += 2;
      else score += 1;
    } else {
      signals.push(`下跳缺口(${gap.date}): ${gap.top}→${gap.bottom} (-${gap.size}%) 未回补`);
      if (isRecent) score -= 2;
      else score -= 1;
    }
  }
  if (signals.length === 0) signals.push('近期无有效缺口');
  return { signals, score };
}

module.exports = {
  SMA, EMA, MACD, RSI, KDJ, BOLL, ATR, ADX,
  calcVWAP,
  zigzag,
  detectDivergence,
  detectPatterns,
  detectMomentumExhaustion,
  calcFibonacci,
  detectGaps,
  // 工具
  wilderSmooth,
};
