/**
 * 形态筛选 — "潜伏启动"检测
 *
 * 目标:识别"长期横盘缩量蓄势、近期刚放量突破平台"的个股(即将/刚启动)。
 * 思路(基台突破法):
 *   1) 基台:取最近 55~5 天为横盘观察窗(排除最近5天的启动段)
 *   2) 横盘特征:基台振幅窄 + 走势平缓(无单边趋势)
 *   3) 启动迹象:现价突破/逼近基台上沿 + 近端放量 + 均线转多
 * 返回 0~100 的"启动分"与可读信号;isLaunching=典型"启动在即"。
 *
 * 纯计算,输入为已拉取的 K 线(复用排名/分析已有数据,零额外请求)。
 */
const { SMA } = require('./indicators');

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }

function detectLaunch(klines) {
  const empty = { score: 0, isLaunching: false, stage: null, signals: ['数据不足'] };
  if (!klines || klines.length < 70) return empty;

  const closes = klines.map(k => k.close);
  const highs = klines.map(k => k.high);
  const lows = klines.map(k => k.low);
  const vols = klines.map(k => k.volume);
  const last = closes.length - 1;
  const price = closes[last];

  // 基台窗口:最近 55~5 天(排除最近 5 天,那是"启动段")
  const BASE_START = last - 55, BASE_END = last - 5;
  if (BASE_START < 0) return empty;
  const baseHighs = highs.slice(BASE_START, BASE_END + 1);
  const baseLows = lows.slice(BASE_START, BASE_END + 1);
  const baseHigh = Math.max(...baseHighs);
  const baseLow = Math.min(...baseLows);
  const baseVolAvg = sum(vols.slice(BASE_START, BASE_END + 1)) / (BASE_END - BASE_START + 1);
  if (!baseLow || !baseVolAvg) return empty;

  const rangePct = (baseHigh - baseLow) / baseLow * 100;         // 基台振幅
  const drift = (closes[BASE_END] - closes[BASE_START]) / closes[BASE_START] * 100; // 基台漂移
  const vol5 = sum(vols.slice(-5)) / 5;
  const volIgnite = vol5 / baseVolAvg;                            // 近5日量能 / 基台均量
  const breakoutPct = (price - baseHigh) / baseHigh * 100;        // 现价相对基台上沿
  const ma5 = SMA(closes, 5), ma20 = SMA(closes, 20);

  const signals = [];
  let score = 0;

  // 1) 横盘够窄(蓄势充分)
  const tightBase = rangePct <= 28;
  if (tightBase) { score += 30; signals.push(`基台横盘约${BASE_END - BASE_START + 1}天,振幅仅${rangePct.toFixed(0)}%(蓄势充分)`); }
  else if (rangePct <= 40) { score += 15; signals.push(`基台振幅${rangePct.toFixed(0)}%(偏宽)`); }
  else signals.push(`基台振幅${rangePct.toFixed(0)}%(过宽,非典型横盘)`);

  // 2) 基台平缓(无单边趋势)
  if (Math.abs(drift) <= 12) { score += 15; signals.push('基台走势平缓,无单边趋势'); }
  else signals.push(`基台已有${drift > 0 ? '上行' : '下行'}倾向(${drift.toFixed(0)}%)`);

  // 3) 突破/逼近基台上沿
  let stage = null;
  if (breakoutPct >= 0 && breakoutPct <= 12) { score += 25; stage = '突破启动'; signals.push(`已突破基台上沿(+${breakoutPct.toFixed(1)}%),处启动初段`); }
  else if (breakoutPct > -3 && breakoutPct < 0) { score += 18; stage = '临界待发'; signals.push(`逼近基台上沿(距突破${(-breakoutPct).toFixed(1)}%)`); }
  else if (breakoutPct > 12) { score += 5; stage = '启动偏后'; signals.push(`已突破+${breakoutPct.toFixed(1)}%,启动偏后,追高谨慎`); }
  else { stage = '基台内'; signals.push('仍在基台内运行,未见突破'); }

  // 4) 放量启动
  if (volIgnite >= 2) { score += 20; signals.push(`放量明显(近5日量能为基台均量${volIgnite.toFixed(1)}倍),资金进场`); }
  else if (volIgnite >= 1.5) { score += 12; signals.push(`温和放量(${volIgnite.toFixed(1)}倍)`); }
  else if (volIgnite < 0.9) signals.push(`近端缩量(${volIgnite.toFixed(1)}倍),动能不足`);

  // 5) 均线转多
  if (ma5[last] > ma20[last] && price > ma20[last]) { score += 10; signals.push('短均线上穿中均线且站上MA20(多头转向)'); }

  score = Math.max(0, Math.min(100, score));
  // 典型"启动在即":横盘够窄 + 总分够高 + 处突破/临界 + 确有放量
  const isLaunching = tightBase && score >= 65 && (stage === '突破启动' || stage === '临界待发') && volIgnite >= 1.5;

  return {
    score, isLaunching, stage,
    rangePct: +rangePct.toFixed(1),
    breakoutPct: +breakoutPct.toFixed(1),
    volIgnite: +volIgnite.toFixed(2),
    signals,
  };
}

module.exports = { detectLaunch };
