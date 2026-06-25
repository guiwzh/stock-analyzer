/**
 * 消息面模块 — 数据来自东方财富公告接口(np-anotice-stock)
 *
 * 用「带上下文护栏的分类器」对最近公告标题做利好/利空判定,按时间衰减加权,
 * 聚合成 0~100 分(50=中性)。利空权重高于利好(风险更重要)。
 * 护栏修正了简单关键词法的典型误判:解除质押/募资监管协议/再融资审核问询 不再被误判为利空。
 *
 * 特点:
 *   - 关键词法,免费、快(每只 1 次 HTTP,可并发);带 20 分钟内存缓存
 *   - 仅"当前快照",不参与回测(免费源无历史时点情绪)
 *   - LLM 精判留给单股详情页按需触发,不在批量里跑
 *
 * 注:公告比新闻更干净——高信号事件(减持/问询/预增/中标)都在公告里。
 */
const { getJSON, toSecuCode } = require('./http-util');

/**
 * 公告标题分类器 —— 带上下文护栏,返回 { tag:'pos'|'neg', weight, reason } 或 null(中性/忽略)。
 * weight 为相对强度(再乘以基础分与时间衰减)。
 *
 * 重点解决简单关键词法的三类误判:
 *   1) "解除质押" 含"质押" 却被判利空 → 解押其实是风险解除,弱利好
 *   2) "募集资金三方监管协议" 含"监管" 却被判利空 → 常规事项,忽略
 *   3) "向特定对象发行…审核问询函回复" 含"问询函" 却被判利空 → 定增/再融资审核流程,中性偏正;
 *      只有"交易异常波动问询/关注"才是真利空
 * 同时区分 增持↔减持、扩产型定增↔普通融资。
 */
function classifyAnnouncement(title) {
  const t = title;

  // ===== 护栏:看似利空、实为中性/利好的语境(优先判定) =====
  if (/解除质押|解押/.test(t)) return { tag: 'pos', weight: 0.4, reason: '解除质押(风险解除)' };
  if (/募集资金.*(监管|专户|存放|三方)|三方监管协议|监管协议/.test(t)) return null; // 募资监管=常规,忽略
  // 再融资/重组的审核问询、回复、募集说明书更新等 = 推进流程,中性偏正(非利空)
  if (/(向特定对象发行|非公开发行|定向增发|定增|可转债|配股|发行股票|发行A股|资产重组|重大资产)/.test(t)
      && /(问询|审核|回复|反馈|募集说明书|更新|受理|批复|注册|核准|申请文件|预案|问询函)/.test(t)) {
    return { tag: 'pos', weight: 0.3, reason: '再融资/重组推进' };
  }

  // ===== 强利空:真实风险事件 =====
  if (/(交易|股票|股价).*(异常波动|异动).*(问询|关注)|(异常波动|异动).*问询/.test(t)) return { tag: 'neg', weight: 1.2, reason: '交易异动问询' };
  if (/立案|行政处罚|被处罚|涉嫌|稽查|警示函|监管措施|责令改正|纪律处分/.test(t)) return { tag: 'neg', weight: 1.4, reason: '监管处罚/立案' };
  if (/退市|风险警示|\*ST|实施其他风险警示/.test(t)) return { tag: 'neg', weight: 1.5, reason: '退市/ST风险' };
  if (/减持/.test(t) && !/增持/.test(t)) return { tag: 'neg', weight: 1.0, reason: '股东减持' };
  if (/预减|预亏|由盈转亏|业绩.*(下滑|下降|亏损)|商誉减值|计提.*减值|资产减值/.test(t)) return { tag: 'neg', weight: 1.2, reason: '业绩下滑/减值' };
  if (/诉讼|仲裁|被起诉/.test(t)) return { tag: 'neg', weight: 0.7, reason: '诉讼仲裁' };
  if (/冻结|平仓|司法拍卖/.test(t)) return { tag: 'neg', weight: 0.8, reason: '股份冻结/平仓' };
  if (/质押/.test(t)) return { tag: 'neg', weight: 0.4, reason: '股权质押' };          // 弱(解押已在护栏排除)
  if (/下修|终止(?!上市辅导)|延期/.test(t)) return { tag: 'neg', weight: 0.4, reason: '下修/终止/延期' };

  // ===== 利好 =====
  if (/(定增|向特定对象发行|非公开发行|可转债|投资|拟投资|新建|开工|募投).*(项目|产能|扩产|生产线|基地|建设)/.test(t)) return { tag: 'pos', weight: 1.0, reason: '扩产/投资项目' };
  if (/扩产|投产|达产|量产|产能.*释放|满产/.test(t)) return { tag: 'pos', weight: 1.0, reason: '产能释放' };
  if (/预增|预盈|扭亏|业绩快报|净利.*增长|业绩.*大增/.test(t)) return { tag: 'pos', weight: 1.2, reason: '业绩预增' };
  if (/增持/.test(t) && !/激励|限制性|期权/.test(t)) return { tag: 'pos', weight: 1.1, reason: '股东增持' };
  if (/回购/.test(t) && !/激励|限制性|期权|注销.*回购/.test(t)) return { tag: 'pos', weight: 0.9, reason: '股份回购' };
  if (/中标|中选|大额订单|重大合同|重大订单|签约|战略合作|框架协议/.test(t)) return { tag: 'pos', weight: 0.9, reason: '订单/合作' };
  if (/收购|并购|获批|核准.*(项目|生产)|认证|入选|获得.*(资质|认定)|通过.*认证/.test(t)) return { tag: 'pos', weight: 0.7, reason: '收购/获批/认证' };
  if (/分红|派息|利润分配/.test(t)) return { tag: 'pos', weight: 0.5, reason: '分红派息' };

  return null; // 常规/中性事项
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
    const c = classifyAnnouncement(it.title);
    if (!c) continue;
    // 利空基础分(12)高于利好(7):风险比利好更重要;再乘以事件强度与时间衰减
    const delta = (c.tag === 'neg' ? -12 : 7) * c.weight * w;
    score += delta;
    hits.push({ date: it.date, title: it.title, tag: c.tag === 'neg' ? '利空' : '利好', reason: c.reason });
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  const signals = [];
  if (!hits.length) {
    signals.push('近期公告以常规事项为主,无明显利好/利空');
  } else {
    // 利空优先展示
    hits.sort((a, b) => (a.tag === '利空' ? -1 : 1) - (b.tag === '利空' ? -1 : 1));
    for (const h of hits.slice(0, 6)) signals.push(`[${h.tag}·${h.reason}] ${h.date} ${h.title}`);
  }
  const label = score >= 60 ? '偏多' : score >= 40 ? '中性' : '偏空';
  return { score, signals, label, hitCount: hits.length };
}

module.exports = { fetchNews, fetchNewsCached, scoreNews };
