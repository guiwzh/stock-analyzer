/**
 * 消息面模块 — 数据来自东方财富公告接口(np-anotice-stock)
 *
 * 用关键词对最近的公告标题做利好/利空初筛(减持/问询=利空,预增/回购/中标=利好),
 * 按时间衰减加权,聚合成 0~100 分(50=中性)。利空权重高于利好(风险更重要)。
 *
 * 特点:
 *   - 关键词法,免费、快(每只 1 次 HTTP,可并发);带 20 分钟内存缓存
 *   - 仅"当前快照",不参与回测(免费源无历史时点情绪)
 *   - LLM 精判留给单股详情页按需触发,不在批量里跑
 *
 * 注:公告比新闻更干净——高信号事件(减持/问询/预增/中标)都在公告里。
 */
const { getJSON, toSecuCode } = require('./http-util');

// 利好 / 利空关键词(命中即计分;中性/行政事项不匹配)
const POSITIVE = ['预增', '预盈', '扭亏', '增持', '回购', '中标', '订单', '合同', '战略合作',
  '收购', '获批', '分红', '派息', '业绩快报', '量产'];
const NEGATIVE = ['减持', '问询函', '关注函', '立案', '处罚', '违规', '诉讼', '仲裁', '商誉减值',
  '计提', '预减', '预亏', '亏损', '退市', '风险警示', '*ST', 'ST', '质押', '冻结', '终止',
  '下修', '监管', '警示函', '更正', '延期'];

/**
 * 上下文护栏:命中的关键词在某些语境下不算利好/利空,返回 true 表示应忽略。
 * 例:"回购"出现在股权激励/限制性股票/期权语境里,是行政事项而非真实回购利好。
 */
function isFalsePositive(kw, title) {
  if (kw === '回购' && /激励|限制性|期权/.test(title)) return true;
  if (kw === '增持' && /激励|限制性|期权/.test(title)) return true;
  return false;
}

/** 'sz001309' → '001309';非 A 股返回 null */
function toNum(code) {
  return toSecuCode(code) ? code.replace(/^(sh|sz)/i, '') : null;
}

async function fetchNews(code) {
  const num = toNum(code);
  if (!num) return null; // 非 A 股
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
    + `?sr=-1&page_size=30&page_index=1&ann_type=A&client_source=web&stock_list=${num}`;
  const j = await getJSON(url, { Referer: 'https://data.eastmoney.com/' });
  const list = j && j.data && j.data.list;
  if (!list) return null;
  return list
    .map(a => ({ date: (a.notice_date || '').slice(0, 10), title: a.title || '' }))
    .filter(a => a.title);
}

// ===== 20 分钟内存缓存(公告不会分秒变,排名常重跑) =====
const _cache = new Map();
const TTL = 20 * 60 * 1000;
async function fetchNewsCached(code) {
  const hit = _cache.get(code);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;
  // 批量排名时多接口并发,公告接口偶发失败 → 失败后短暂等待重试一次
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 350));
    try { data = await fetchNews(code); } catch (e) { data = null; }
  }
  if (data) _cache.set(code, { ts: Date.now(), data }); // 只缓存成功结果
  return data;
}

/** 距今天数(粗略,按日期字符串) */
function daysAgo(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function recencyWeight(days) {
  if (days <= 7) return 1.0;
  if (days <= 30) return 0.6;
  if (days <= 90) return 0.3;
  return 0; // 超过 90 天不计入
}

/** 消息面打分,返回 0~100 + 命中的利好/利空信号 */
function scoreNews(items) {
  if (!items) return { score: null, signals: ['无消息数据(非A股或接口失败)'] };
  if (!items.length) return { score: 50, signals: ['近期无公告'] };

  let score = 50;
  const hits = [];
  for (const it of items) {
    const w = recencyWeight(daysAgo(it.date));
    if (w === 0) continue;
    const neg = NEGATIVE.find(k => it.title.includes(k));
    const pos = POSITIVE.find(k => it.title.includes(k) && !isFalsePositive(k, it.title));
    if (neg) { score -= 12 * w; hits.push({ date: it.date, title: it.title, tag: '利空', kw: neg }); }
    else if (pos) { score += 7 * w; hits.push({ date: it.date, title: it.title, tag: '利好', kw: pos }); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const signals = [];
  if (!hits.length) {
    signals.push('近期公告以常规事项为主,无明显利好/利空');
  } else {
    // 利空优先展示
    hits.sort((a, b) => (a.tag === '利空' ? -1 : 1) - (b.tag === '利空' ? -1 : 1));
    for (const h of hits.slice(0, 6)) signals.push(`[${h.tag}] ${h.date} ${h.title}`);
  }
  const label = score >= 60 ? '偏多' : score >= 40 ? '中性' : '偏空';
  return { score, signals, label, hitCount: hits.length };
}

module.exports = { fetchNews, fetchNewsCached, scoreNews };
