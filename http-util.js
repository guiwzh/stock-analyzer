/**
 * 共享的 HTTP JSON 拉取工具(带超时)
 * 估值/基本面模块用它访问东方财富的 datacenter 接口。
 */
const https = require('https');
const http = require('http');

const REQUEST_TIMEOUT = 8000;

/**
 * GET 一个返回 JSON 的 URL,解析后 resolve。失败/超时 reject。
 * 不处理重定向(东方财富 datacenter / push2 不重定向)。
 */
function getJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); }
        catch (e) { reject(new Error('JSON解析失败: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(REQUEST_TIMEOUT, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
  });
}

/** 'sh600027' → '600027.SH';'sz000657' → '000657.SZ';非A股返回 null */
function toSecuCode(code) {
  const m = /^(sh|sz)(\d{6})$/i.exec(code);
  return m ? `${m[2]}.${m[1].toUpperCase()}` : null;
}

module.exports = { getJSON, toSecuCode };
