// shared/accept_ch.cjs — UA-CH 的**服务端授权**记录：哪个 origin 被允许收高熵头。
//
// 为什么要自己记（2026-11-05 实测）：UA-CH 规范里高熵头不是想发就发 —— 服务端先用
// `Accept-CH`（或 `Link: rel="accept-ch"`）授权，浏览器之后的同 origin 请求才带上。
// 真 Chrome 有 `components/embedder_support` 的 UA-CH 管理器 + Accept-CH 缓存干这件事，
// **Electron 不带这一层**：实测同一台机器、同一个 Chromium 156，服务端授权之后
// 真 Chrome 带 11 个 sec-ch-ua* 头，Electron 只带 3 个，且 CDP 下发多完整的
// userAgentMetadata 都改不动这一点。授权语义只能在请求出口自己实现。
//
// 三条不变量：
//   1. **只对授权过的 origin 发**：没被授权的 origin 一个高熵头都不许多带 ——
//      多带和少带一样是指纹，而且把身份泄露给了没要求的站点。
//   2. 记的是 origin（scheme+host+port），不是域名：443 与 :8443 是两个桶。
//   3. 只在内存里，跟着 session 走。真 Chrome 把它持久化到磁盘，所以冷启动第一发
//      不带、授权之后才带；我们不持久化，差的只是"重启后第一发"，方向一致。
'use strict';

const GRANTABLE_PROTOCOLS = { 'https:': 1, 'wss:': 1 };

/**
 * 从一份响应头里读出被授权的客户头名。
 * 头名大小写不定（HTTP/2 里全是小写，CDP/webRequest 又给原样），一律归成小写。
 *
 * @param {Object<string,string|string[]>} headers 响应头（键名任意大小写）
 * @returns {string[]} 小写、去重后的头名；没有授权就返回空数组
 */
function parseGrant(headers) {
  const out = [];
  if (!headers || typeof headers !== 'object') return out;
  const get = (name) => {
    const hit = Object.keys(headers).find((k) => String(k).toLowerCase() === name);
    if (!hit) return '';
    const v = headers[hit];
    return Array.isArray(v) ? v.join(',') : String(v || '');
  };

  // Accept-CH: Sec-CH-UA-Arch, Sec-CH-UA-Bitness, ...
  for (const raw of get('accept-ch').split(',')) {
    const name = raw.trim().toLowerCase();
    if (name) out.push(name);
  }

  // Link: </>; rel="accept-ch"; ch="Sec-CH-UA-Arch, Sec-CH-UA-Model"
  const link = get('link');
  for (const entry of link.split(/,(?![^;]*")/)) {
    if (!/rel\s*=\s*"?accept-ch"?/i.test(entry)) continue;
    const m = /ch\s*=\s*"([^"]*)"/i.exec(entry);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim().toLowerCase();
      if (name) out.push(name);
    }
  }

  const seen = new Set();
  return out.filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
}

/**
 * origin 键：`https://host:port`。默认端口归一化（443 / wss 的 443 不重复记）。
 * 非 https/wss 返回 ''（明文连接不补高熵头，与内核既有约定一致）。
 */
function originKeyOf(url) {
  let u = null;
  try { u = new URL(String(url || '')); } catch (_) { return ''; }
  if (!GRANTABLE_PROTOCOLS[u.protocol]) return '';
  const defaultPort = u.protocol === 'https:' ? '443' : '443';
  const port = u.port && u.port !== defaultPort ? ':' + u.port : '';
  return u.protocol + '//' + u.hostname + port;
}

/**
 * origin → 已授权头名 的有界存储。
 * @param {number} limit 最多记多少个 origin（超出按最早写入淘汰）
 */
function createGrantStore(limit = 512) {
  const map = new Map();
  return {
    /** 记录一次授权（累积：第二次只授权两个头，不抹掉先前授权的）。 */
    add(urlOrKey, names) {
      const key = map.has(urlOrKey) ? urlOrKey : originKeyOf(urlOrKey);
      if (!key) return false;
      const list = Array.isArray(names) ? names : [names];
      const bucket = map.get(key) || new Set();
      let changed = false;
      for (const n of list) {
        const name = String(n || '').toLowerCase();
        if (name && !bucket.has(name)) { bucket.add(name); changed = true; }
      }
      if (!changed && map.has(key)) return false;
      map.set(key, bucket);
      while (map.size > limit) map.delete(map.keys().next().value);
      return true;
    },
    /** 这个请求的 origin 被授权了哪些头名（小写集合，只读语义：返回副本不安全，调用方只读）。 */
    grantedFor(url) {
      const key = originKeyOf(url);
      return key && map.get(key) ? map.get(key) : null;
    },
    size() { return map.size; },
    clear() { map.clear(); },
    keys() { return Array.from(map.keys()); },
  };
}

module.exports = { parseGrant, originKeyOf, createGrantStore };
