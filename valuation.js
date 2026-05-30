/**
 * 估值模块 — 数据来自东方财富 F10 估值分析(RPT_VALUEANALYSIS_DET)
 *
 * 拉近一年(约250个交易日)的 PE_TTM / PB 序列,既取当前值,也算历史分位。
 * 打分思路:越便宜(分位越低)分越高;亏损(PE<=0)直接判为高估区。
 *
 * 注意:仅 A 股可用;估值/基本面均为"当前值",不参与回测(免费源无历史时点快照)。
 */
const { getJSON, toSecuCode } = require('./http-util');

async function fetchValuation(code) {
  const secu = toSecuCode(code);
  if (!secu) return null; // 非 A 股(台股等)
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_VALUEANALYSIS_DET'
    + '&columns=TRADE_DATE,PE_TTM,PB_MRQ,PS_TTM,PEG_CAR,BOARD_NAME'
    + `&filter=(SECUCODE%3D%22${secu}%22)`
    + '&pageSize=250&sortColumns=TRADE_DATE&sortTypes=-1&source=HSF10&client=PC';
  const j = await getJSON(url, { Referer: 'https://emweb.securities.eastmoney.com/' });
  const rows = j && j.result && j.result.data;
  if (!rows || !rows.length) return null;
  const cur = rows[0];

  // 当前值在历史序列中的分位(0=最便宜,100=最贵);只用正值样本
  const pct = (series, val) => {
    if (val == null) return null;
    const s = series.filter(x => x != null && x > 0);
    if (!s.length) return null;
    const below = s.filter(x => x <= val).length;
    return Math.round(below / s.length * 100);
  };
  const peSeries = rows.map(r => r.PE_TTM);
  const pbSeries = rows.map(r => r.PB_MRQ);

  return {
    peTTM: cur.PE_TTM, pb: cur.PB_MRQ, ps: cur.PS_TTM, peg: cur.PEG_CAR, board: cur.BOARD_NAME,
    pePercentile: cur.PE_TTM > 0 ? pct(peSeries, cur.PE_TTM) : null,
    pbPercentile: cur.PB_MRQ > 0 ? pct(pbSeries, cur.PB_MRQ) : null,
    historyDays: rows.length,
  };
}

/** 估值打分,返回 0~100(越高=越便宜) + 文字信号 */
function scoreValuation(v) {
  if (!v) return { score: null, signals: ['无估值数据(非A股或接口失败)'] };
  const signals = [];
  let score = 50;

  if (v.peTTM == null || v.peTTM <= 0) {
    signals.push('PE(TTM)为负/缺失 → 当前处于亏损,估值参考意义有限');
    score = 25;
  } else if (v.pePercentile != null) {
    score = 100 - v.pePercentile; // 越便宜分越高
    const tag = v.pePercentile <= 30 ? '偏低(便宜)' : v.pePercentile >= 70 ? '偏高(贵)' : '中性';
    signals.push(`PE(TTM)=${v.peTTM.toFixed(1)},近一年 ${v.pePercentile}% 分位(${tag})`);
  } else {
    signals.push(`PE(TTM)=${v.peTTM.toFixed(1)}(无历史分位)`);
  }

  if (v.pb != null && v.pb > 0) {
    if (v.pbPercentile != null) {
      score = score * 0.7 + (100 - v.pbPercentile) * 0.3; // PB 分位做次要修正
      signals.push(`PB=${v.pb.toFixed(2)},近一年 ${v.pbPercentile}% 分位`);
    } else {
      signals.push(`PB=${v.pb.toFixed(2)}`);
    }
  }

  if (v.peg != null && v.peg > 0) {
    signals.push(`PEG=${v.peg.toFixed(2)}${v.peg < 1 ? '(<1,成长已覆盖估值)' : ''}`);
    if (v.peg < 1) score = Math.min(100, score + 5);
  }
  if (v.board) signals.push(`行业:${v.board}`);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score, signals,
    label: score >= 65 ? '低估' : score >= 40 ? '合理' : '高估',
    peTTM: v.peTTM, pb: v.pb, pePercentile: v.pePercentile, board: v.board,
  };
}

module.exports = { fetchValuation, scoreValuation };
