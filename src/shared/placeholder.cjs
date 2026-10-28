// shared/placeholder.cjs — 新标签页的"占位页"地址与判定。
//
// 为什么单独一个模块：这段逻辑出过一个只在打包后暴露的事故（2026-10-28）。
// 占位页 URL 用字符串拼 `'file://' + path`，而打包后的路径是
// `/Applications/AI Browser.app/...`（有空格）—— 拼出来的 URL 带一个字面空格，
// Chromium 报回来的是 `%20`。判据写成 `getURL() === placeholderUrl` 就永远不成立，
// 于是"垫片装好后去加载真正目标"的那一步被当成"这一页已经被导航走了"而跳过，
// 新标签页永久停在占位页。开发树上跑得通（路径没空格），打包后必然挂。
//
// 两条教训固化成代码：
//   1. **不要手拼 file:// URL**，用 pathToFileURL（它会正确转义）。
//   2. **不要用 URL 字符串相等判断"是不是同一页"**，按文件名判据。
'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

/** 占位页文件名。改文件名时这里和 renderer/ 目录要一起改。 */
const PLACEHOLDER_FILE = 'loading.html';

/**
 * 把本地页面 + query 拼成合法的 file:// URL。
 *
 * 全项目**只有这一处**允许拼 file URL：手拼 `'file://' + path` 在打包后必炸
 * （路径含空格 → Chromium 报 %20，任何字符串比较都会失效）。错误页、下载结果页
 * 一度也是手拼的，它们在 /Applications 里同样加载不出来。
 */
function fileUrlWithQuery(pagePath, params) {
  try {
    const q = new URLSearchParams(params || {});
    const base = pathToFileURL(String(pagePath)).href;
    const qs = q.toString();
    return qs ? base + '?' + qs : base;
  } catch (_e) {
    return null;
  }
}

/**
 * 造占位页 URL。`targetUrl` 为空时返回 about:blank（window.open("") 的老站模式
 * 本来就要停在空白页等站点赋 location）。
 */
function placeholderUrlFor(pagePath, targetUrl) {
  if (!targetUrl) return 'about:blank';
  // pathToFileURL 会处理空格、中文、#、? 等一切需要在 URL 里转义的字符。
  return fileUrlWithQuery(pagePath, { url: String(targetUrl) }) || 'about:blank';
}

/**
 * 这个地址还是不是"我的占位页"。
 *
 * 空 / about:blank 也算 —— 占位页刚发起的那一瞬 getURL() 还是空，把它判成
 * "已经导航走了"会让新标签页永远卡住（这条也踩过）。
 */
function isPlaceholderUrl(url) {
  const u = String(url || '');
  if (!u || u === 'about:blank') return true;
  // 网络页面一律不是占位页 —— 否则一个恰好叫 loading.html 的站点页面会被
  // 当成"还没开始导航"，真正的目标就再也加载不出来了。
  if (/^https?:/i.test(u)) return false;
  try {
    // 去掉 query 看文件名，不要拿整串比：编码、尾斜杠、query 顺序都不可控。
    const bare = u.split('?')[0].split('#')[0];
    return path.posix.basename(decodeURIComponent(bare)) === PLACEHOLDER_FILE;
  } catch (_e) {
    return /\/loading\.html(\?|$)/.test(u);
  }
}

module.exports = { PLACEHOLDER_FILE, fileUrlWithQuery, placeholderUrlFor, isPlaceholderUrl };
