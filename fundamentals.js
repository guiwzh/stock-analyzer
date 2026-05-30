/**
 * 基本面模块 — 数据来自东方财富 F10 主要财务指标(RPT_F10_FINANCE_MAINFINADATA)
 *
 * 取最近一期报告:ROE、营收同比、扣非净利润同比、毛利率、资产负债率。
 * 打分思路:成长性(营收/利润增速) + 盈利质量(ROE/毛利) + 财务健康(负债率)。
 *
 * 注意:季度更新;为"当前值",不参与回测。
 */
const { getJSON, toSecuCode } = require('./http-util');

async function fetchFundamentals(code) {
  const secu = toSecuCode(code);
  if (!secu) return null; // 非 A 股
  const url = 'https://datacenter.eastmoney.com/securities/api/data/v1/get'
    + '?reportName=RPT_F10_FINANCE_MAINFINADATA'
    + '&columns=SECUCODE,REPORT_DATE,ROEJQ,YYZSRGDHBZC,KCFJCXSYJLRTZ,XSMLL,ZCFZL'
    + `&filter=(SECUCODE%3D%22${secu}%22)`
    + '&pageSize=1&sortColumns=REPORT_DATE&sortTypes=-1&source=HSF10&client=PC';
  const j = await getJSON(url, { Referer: 'https://emweb.securities.eastmoney.com/' });
  const rows = j && j.result && j.result.data;
  if (!rows || !rows.length) return null;
  const r = rows[0];
  return {
    reportDate: (r.REPORT_DATE || '').slice(0, 10),
    roe: r.ROEJQ,              // ROE(加权)
    revenueYoY: r.YYZSRGDHBZC, // 营业总收入同比增长
    profitYoY: r.KCFJCXSYJLRTZ,// 扣非净利润同比增长
    grossMargin: r.XSMLL,      // 销售毛利率
    debtRatio: r.ZCFZL,        // 资产负债率
  };
}

/** 基本面打分,返回 0~100 + 文字信号 */
function scoreFundamentals(f) {
  if (!f) return { score: null, signals: ['无财务数据(非A股或接口失败)'] };
  const signals = [];
  let score = 50;

  if (f.roe != null) {
    if (f.roe >= 15) { score += 20; signals.push(`ROE=${f.roe.toFixed(1)}%(优秀)`); }
    else if (f.roe >= 8) { score += 10; signals.push(`ROE=${f.roe.toFixed(1)}%(良好)`); }
    else if (f.roe >= 3) { score += 2; signals.push(`ROE=${f.roe.toFixed(1)}%(一般)`); }
    else if (f.roe < 0) { score -= 20; signals.push(`ROE=${f.roe.toFixed(1)}%(亏损)`); }
    else { signals.push(`ROE=${f.roe.toFixed(1)}%(偏低)`); }
  }

  if (f.revenueYoY != null) {
    if (f.revenueYoY >= 20) { score += 12; signals.push(`营收同比+${f.revenueYoY.toFixed(1)}%(高增长)`); }
    else if (f.revenueYoY >= 0) { score += 4; signals.push(`营收同比+${f.revenueYoY.toFixed(1)}%`); }
    else if (f.revenueYoY <= -20) { score -= 15; signals.push(`营收同比${f.revenueYoY.toFixed(1)}%(大幅下滑)`); }
    else { score -= 6; signals.push(`营收同比${f.revenueYoY.toFixed(1)}%(下滑)`); }
  }

  if (f.profitYoY != null) {
    if (f.profitYoY >= 30) { score += 15; signals.push(`扣非净利同比+${f.profitYoY.toFixed(1)}%(高增长)`); }
    else if (f.profitYoY >= 0) { score += 5; signals.push(`扣非净利同比+${f.profitYoY.toFixed(1)}%`); }
    else if (f.profitYoY <= -30) { score -= 18; signals.push(`扣非净利同比${f.profitYoY.toFixed(1)}%(大幅下滑)`); }
    else { score -= 8; signals.push(`扣非净利同比${f.profitYoY.toFixed(1)}%(下滑)`); }
  }

  if (f.debtRatio != null) {
    if (f.debtRatio <= 40) { score += 6; signals.push(`资产负债率${f.debtRatio.toFixed(1)}%(健康)`); }
    else if (f.debtRatio <= 65) { signals.push(`资产负债率${f.debtRatio.toFixed(1)}%`); }
    else if (f.debtRatio <= 80) { score -= 8; signals.push(`资产负债率${f.debtRatio.toFixed(1)}%(偏高)`); }
    else { score -= 15; signals.push(`资产负债率${f.debtRatio.toFixed(1)}%(高风险)`); }
  }

  if (f.grossMargin != null) signals.push(`毛利率${f.grossMargin.toFixed(1)}%`);
  if (f.reportDate) signals.push(`报告期:${f.reportDate}`);

  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score, signals,
    label: score >= 65 ? '优质' : score >= 45 ? '中等' : '偏弱',
    roe: f.roe, revenueYoY: f.revenueYoY, profitYoY: f.profitYoY, reportDate: f.reportDate,
  };
}

module.exports = { fetchFundamentals, scoreFundamentals };
