/**
 * 板块模块 — 数据来自东方财富 push2 行情接口
 *
 * 提供:
 *  - fetchHotSectors(): 行业+概念板块榜,给出"今日领涨"和"资金潜伏"两个视角
 *  - fetchBoardMembers(boardCode, limit): 某板块的成分股代码(供批量排名)
 *
 * 说明:push2 接口对"短时间高频请求"会返回空,故板块榜做 60 秒缓存、成分股做 3 分钟缓存。
 * 字段含义: f3=涨跌幅% f12=代码 f13=市场(1沪/0深) f14=名称 f62=主力净流入(元)
 *           f104=上涨家数 f105=下跌家数 f128=领涨股名 f140=领涨股代码 f136=领涨股涨幅%
 */
const { getJSON } = require('./http-util');
const { curlText } = require('./analyze');

// push2.eastmoney.com 对 Node 的 TLS 指纹较敏感(国内直连常 socket reset),且国内访问可能需走代理。
// 故优先用系统 curl(指纹能过 + 自动读 https_proxy),失败再回退 Node https。
const REFERER = 'Referer: https://quote.eastmoney.com/';
const BOARD_FIELDS = 'f12,f13,f14,f3,f62,f104,f105,f128,f136,f140,f141';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const isValid = j => j && j.data && j.data.diff && j.data.diff.length;

// 依次尝试多种取数通道,返回首个有效结果(push2 境内源 + 反爬指纹敏感)
async function fetchOnce(url) {
  // 1) curl 直连(不走代理):境内源最稳,且 curl 指纹能过 push2 反爬
  try { const j = JSON.parse(await curlText(url, [REFERER], { noProxy: true })); if (isValid(j)) return j; } catch (e) { /* 下一通道 */ }
  // 2) curl 走代理(若直连不通而代理可达)
  try { const j = JSON.parse(await curlText(url, [REFERER])); if (isValid(j)) return j; } catch (e) { /* 下一通道 */ }
  // 3) Node https 兜底(无 curl 时)
  try { const j = await getJSON(url, { Referer: 'https://quote.eastmoney.com/' }); if (isValid(j)) return j; } catch (e) { /* 失败 */ }
  return null;
}

// 失败/空响应退避重试,最多 2 轮(每轮内部已多通道尝试)
async function getJSONRetry(url, attempts = 2) {
  for (let i = 0; i < attempts; i++) {
    const j = await fetchOnce(url);
    if (j) return j;
    if (i < attempts - 1) await sleep(800 * (i + 1));
  }
  throw new Error('上游连续无响应(可能被限流或网络不通)');
}

// 简单内存缓存
const cache = { boards: { ts: 0, data: null }, members: new Map() };
const BOARDS_TTL = 60 * 1000;
const MEMBERS_TTL = 3 * 60 * 1000;

function marketPrefix(f13) { return f13 === 1 ? 'sh' : 'sz'; }

// 拉一类板块的全部条目(行业 t:2 / 概念 t:3),按涨幅降序
async function fetchBoardList(type) {
  const fs = `m:90+t:${type}`;
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=${BOARD_FIELDS}`;
  const j = await getJSONRetry(url);
  const diff = j && j.data && j.data.diff;
  if (!diff || !diff.length) return [];
  return diff.map(d => ({
    code: d.f12,
    name: d.f14,
    changePct: typeof d.f3 === 'number' ? d.f3 : null,
    netInflow: typeof d.f62 === 'number' ? d.f62 : null, // 元
    upCount: d.f104, downCount: d.f105,
    leadName: d.f128,
    leadCode: d.f128 && d.f140 ? marketPrefix(d.f141) + d.f140 : null,
    leadChangePct: typeof d.f136 === 'number' ? d.f136 : null,
  }));
}

/**
 * 今日热门板块:行业 + 概念,各给"领涨榜"和"资金净流入榜"。
 * 资金榜里把"净流入大但涨幅还不大"的标为"潜伏吸筹"(lurking)。
 */
async function fetchHotSectors() {
  if (cache.boards.data && Date.now() - cache.boards.ts < BOARDS_TTL) return cache.boards.data;

  const [industry, concept] = await Promise.all([fetchBoardList(2), fetchBoardList(3)]);

  const yi = 1e8; // 转成"亿元"
  const annotate = list => list.map(b => ({
    ...b,
    netInflowYi: b.netInflow != null ? +(b.netInflow / yi).toFixed(2) : null,
    // 潜伏吸筹:主力明显净流入(≥0.5亿) 但涨幅还温和(<2.5%) —— 资金先于价格进场
    lurking: b.netInflow != null && b.changePct != null && b.netInflow >= 0.5 * yi && b.changePct < 2.5,
  }));

  const byChange = list => [...list].sort((a, b) => (b.changePct ?? -99) - (a.changePct ?? -99));
  const byInflow = list => [...list].sort((a, b) => (b.netInflow ?? -9e18) - (a.netInflow ?? -9e18));

  const ind = annotate(industry), con = annotate(concept);
  const data = {
    updatedAt: new Date().toISOString(),
    industry: { hot: byChange(ind).slice(0, 12), inflow: byInflow(ind).slice(0, 12) },
    concept: { hot: byChange(con).slice(0, 12), inflow: byInflow(con).slice(0, 12) },
  };
  cache.boards = { ts: Date.now(), data };
  return data;
}

/** 某板块成分股(默认按涨幅),返回 [{code,name,changePct}],code 形如 sh600000 */
async function fetchBoardMembers(boardCode, limit = 40) {
  if (!/^BK\d{4,}$/i.test(boardCode)) throw new Error('板块代码非法');
  const hit = cache.members.get(boardCode);
  if (hit && Date.now() - hit.ts < MEMBERS_TTL) return hit.data.slice(0, limit);

  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=1&pz=200&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${boardCode}&fields=f12,f13,f14,f3`;
  const j = await getJSONRetry(url);
  const diff = j && j.data && j.data.diff;
  if (!diff || !diff.length) return [];
  const data = diff.map(d => ({ code: marketPrefix(d.f13) + d.f12, name: d.f14, changePct: d.f3 }));
  cache.members.set(boardCode, { ts: Date.now(), data });
  return data.slice(0, limit);
}

module.exports = { fetchHotSectors, fetchBoardMembers };
